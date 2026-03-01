import { claudeLog } from '../utils/logger.js';
import { DEFAULT_CONTEXT_WINDOW, PENDING_HANDOFF_TIMEOUT_MS } from '../config.js';
import { INPUT_WAIT_PATTERNS } from './inputPatterns.js';
import { detectPhase, detectIteration, getTotalPhases } from './phaseUtils.js';

// Verbose debug logging (enable with DASHBOARD_DEBUG=1)
const _DEBUG = process.env.DASHBOARD_DEBUG === '1';

/**
 * StreamParser handles stream-json output parsing and state detection
 */
export class StreamParser {
  /**
   * @param {Object} callbacks - Callback functions
   * @param {function} callbacks.pushLog - Push log entry to execution
   * @param {function} callbacks.broadcast - Broadcast message to execution
   * @param {function} callbacks.broadcastState - Broadcast state update
   * @param {function} callbacks.broadcastInputWait - Broadcast input wait event
   * @param {function} callbacks.broadcastInputRequired - Broadcast input required event
   * @param {function} callbacks.handoffToTerminal - Handoff execution to terminal
   * @param {function} callbacks.handleCompletion - Handle completion event
   * @param {function} callbacks.debugLog - Debug logging function
   */
  constructor({
    pushLog,
    broadcast,
    broadcastState,
    broadcastInputWait,
    broadcastInputRequired,
    handoffToTerminal,
    handleCompletion,
    debugLog,
  }) {
    this.pushLog = pushLog;
    this.broadcast = broadcast;
    this.broadcastState = broadcastState;
    this.broadcastInputWait = broadcastInputWait;
    this.broadcastInputRequired = broadcastInputRequired;
    this.handoffToTerminal = handoffToTerminal;
    this.handleCompletion = handleCompletion;
    this.debugLog = debugLog || (() => {});
    this.outputRingBuffers = new Map();
    this.RING_BUFFER_SIZE = 20;
  }

  _getRingBuffer(executionId) {
    if (!this.outputRingBuffers.has(executionId)) {
      this.outputRingBuffers.set(executionId, []);
    }
    return this.outputRingBuffers.get(executionId);
  }

  _pushToRingBuffer(executionId, text, source) {
    const buf = this._getRingBuffer(executionId);
    buf.push({ text: text.substring(0, 500), source, timestamp: new Date().toISOString() });
    if (buf.length > this.RING_BUFFER_SIZE) {
      buf.shift();
    }
  }

  getRingBufferSnapshot(executionId) {
    return this.outputRingBuffers.get(executionId) || [];
  }

  clearRingBuffer(executionId) {
    this.outputRingBuffers.delete(executionId);
  }

  /**
   * Process a single line of stream-json output
   * @param {Object} execution - Execution object
   * @param {string} raw - Raw stream line
   */
  processStreamLine(execution, raw) {
    const { id: executionId } = execution;
    const trimmed = raw.trim();
    if (!trimmed) return;

    try {
      const event = JSON.parse(trimmed);
      const displayLine = extractStreamText(event);

      if (displayLine !== null) {
        this._pushToRingBuffer(executionId, displayLine, event.type || 'unknown');
        const entry = {
          line: displayLine,
          timestamp: new Date().toISOString(),
          level: 'info',
          event: event.type,
        };
        this.pushLog(execution, entry);
        this.broadcast(executionId, { type: 'log', executionId, ...entry });

        // Check for y/n input wait patterns
        this.checkInputWaitPatterns(execution, displayLine, event.type || 'unknown');
      }

      // Detect iteration from TaskCreate/TaskUpdate/TodoWrite tool_use
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          // Log ALL tool_use events to diagnose which tools stream-json emits
          if (block.type === 'tool_use') {
            claudeLog.info(
              `[ClaudeService] tool_use seen: name=${block.name}, input_keys=${Object.keys(block.input || {}).join(',')}`,
            );
          }
          if (
            block.type === 'tool_use' &&
            (block.name === 'TaskCreate' ||
              block.name === 'TaskUpdate' ||
              block.name === 'TodoWrite')
          ) {
            // Debug: log tool_use input to diagnose iteration detection
            claudeLog.info(
              `[ClaudeService] Iteration candidate: tool=${block.name}, input=${JSON.stringify(block.input).substring(0, 300)}`,
            );

            // Find the active todo (in_progress first, then first item as fallback)
            const todos = block.input?.todos;
            const activeTodo = todos?.find((t) => t.status === 'in_progress') || todos?.[0];

            // Try ALL input fields - TodoWrite puts iteration in activeForm, not content
            const candidates = [
              block.input?.subject, // TaskCreate/TaskUpdate
              activeTodo?.activeForm, // TodoWrite activeForm (iteration lives here)
              activeTodo?.content, // TodoWrite content
              activeTodo?.subject, // TodoWrite subject (rare)
              block.input?.activeForm, // Direct activeForm
            ].filter(Boolean);

            // Try each candidate, fall back to full JSON stringify
            let iteration = null;
            for (const candidate of candidates) {
              iteration = detectIteration(candidate);
              if (iteration !== null) break;
            }
            if (iteration === null) {
              iteration = detectIteration(JSON.stringify(block.input || ''));
            }

            if (iteration !== null && iteration > 0 && iteration !== execution.currentIteration) {
              claudeLog.info(`[ClaudeService] Iteration detected: ${iteration} from ${block.name}`);
              execution.currentIteration = iteration;
              this.broadcastState(execution);
            }
          }
        }
      }

      // Process different event types
      this.handleStreamEvent(execution, event);
    } catch (_parseError) {
      // Non-JSON line - log as plain text (stream-json sometimes emits non-JSON debug output)
      this.debugLog(
        `[ClaudeService] Non-JSON stream line: ${trimmed.substring(0, 100)}${trimmed.length > 100 ? '...' : ''}`,
      );
      this._pushToRingBuffer(executionId, trimmed, 'non-json');
      if (/Prompt is too long|Context limit reached/i.test(trimmed)) {
        execution.promptTooLong = true;
      }
      if (
        /hit your limit|rate_limit_error|exceed your (?:organization|account)(?:'s|s)? rate limit/i.test(
          trimmed,
        )
      ) {
        execution.accountLimitHit = true;
      }
      const entry = {
        line: trimmed,
        timestamp: new Date().toISOString(),
        level: 'info',
      };
      this.pushLog(execution, entry);
      this.broadcast(executionId, { type: 'log', executionId, ...entry });

      // Check for y/n input wait patterns in non-JSON output too
      this.checkInputWaitPatterns(execution, trimmed, 'non-json');
    }
  }

  /**
   * Handle stream-json events for state detection
   * @param {Object} execution - Execution object
   * @param {Object} event - Stream-json event
   */
  handleStreamEvent(execution, event) {
    const t = event.type;

    // Detect phase from assistant text
    if (t === 'assistant' && event.message?.content) {
      let textContent = '';
      let askUserQuestion = null;

      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          textContent += block.text + '\n';

          // Check for phase pattern (clamp to valid range to avoid false positives from architecture phase references)
          const phaseInfo = detectPhase(block.text);
          if (phaseInfo && phaseInfo.phase !== execution.currentPhase) {
            const totalPhases = getTotalPhases(execution.command);
            if (totalPhases && phaseInfo.phase > totalPhases) {
              // Skip: detected phase exceeds command's max (e.g., "phase-20-27-game-systems.md" in FL text)
            } else {
              claudeLog.info(
                `[ClaudeService] Phase detected: ${phaseInfo.phase} "${phaseInfo.name}" (was: ${execution.currentPhase})`,
              );
              execution.currentPhase = phaseInfo.phase;
              execution.currentPhaseName = phaseInfo.name;
              this.broadcastState(execution);
            }
          }

          // Check for iteration pattern (FL workflow: "Iteration N/10")
          const iteration = detectIteration(block.text);
          if (iteration !== null && iteration > 0 && iteration !== execution.currentIteration) {
            claudeLog.info(
              `[ClaudeService] Iteration detected from text: ${iteration} (was: ${execution.currentIteration})`,
            );
            execution.currentIteration = iteration;
            this.broadcastState(execution);
          }
        }

        if (block.type === 'tool_use') {
          execution.pendingToolUse = {
            id: block.id,
            name: block.name,
            input: block.input,
          };

          // Track Task tool nesting depth for subagent filtering
          if (block.name === 'Agent') {
            execution.taskToolIds.add(block.id);
            execution.taskDepth++;

            if (!execution.taskStartTimes) execution.taskStartTimes = new Map();
            execution.taskStartTimes.set(block.id, Date.now());

            const desc = block.input?.description || 'subagent';
            const agentType = block.input?.subagent_type || '';
            const label = agentType ? `${agentType}: ${desc}` : desc;

            const entry = {
              line: `[Subagent] Started (depth=${execution.taskDepth}): ${label}`,
              timestamp: new Date().toISOString(),
              level: 'info',
            };
            this.pushLog(execution, entry);
            this.broadcast(execution.id, { type: 'log', executionId: execution.id, ...entry });
            this.broadcastState(execution);
          }

          if (block.name === 'AskUserQuestion') {
            askUserQuestion = block;
          }
        }
      }

      // Track last assistant text for question detection on completion
      if (textContent) {
        execution.lastAssistantText = textContent.trim();
      }

      // If AskUserQuestion found, store context, notify, and handoff to terminal
      if (askUserQuestion) {
        execution.inputRequired = {
          toolUseId: askUserQuestion.id,
          questions: askUserQuestion.input?.questions || [],
        };
        execution.inputContext = textContent.trim();
        this.broadcastState(execution);
        this.broadcastInputRequired(execution);

        // Auto-handoff to terminal for user input
        this.handoffToTerminal(execution, 'AskUserQuestion requires user input');
      }
    }

    // Detect tool_result (means tool_use was handled)
    if (t === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          // Tool was handled, clear pending
          if (execution.pendingToolUse?.id === block.tool_use_id) {
            execution.pendingToolUse = null;
          }
          // Track Task tool completion (reduce nesting depth)
          if (execution.taskToolIds.has(block.tool_use_id)) {
            execution.taskToolIds.delete(block.tool_use_id);
            execution.taskDepth = Math.max(0, execution.taskDepth - 1);

            const startTime = execution.taskStartTimes?.get(block.tool_use_id);
            execution.taskStartTimes?.delete(block.tool_use_id);
            const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : null;
            const durStr =
              elapsed != null
                ? ` (${elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`})`
                : '';

            const entry = {
              line: `[Subagent] Completed${durStr}`,
              timestamp: new Date().toISOString(),
              level: 'info',
            };
            this.pushLog(execution, entry);
            this.broadcast(execution.id, { type: 'log', executionId: execution.id, ...entry });
            this.broadcastState(execution);

            this.debugLog(
              `[ClaudeService] Task tool_result, depth=${execution.taskDepth}, id=${block.tool_use_id}`,
            );
          }
          // Clear input required if this was a response to AskUserQuestion
          if (execution.inputRequired?.toolUseId === block.tool_use_id) {
            execution.inputRequired = null;
            execution.inputContext = null;
            this.broadcastState(execution);
          }
        }
      }
    }

    // Detect completion and trigger completion handler
    if (t === 'result') {
      execution.resultSubtype = event.subtype || null;
      // Save result exit code — completion is deferred to process 'close' event
      // to ensure stderr (rate limit detection) is fully drained first
      execution.resultExitCode = event.is_error ? 1 : 0;
      if (execution.pendingHandoff) {
        // y/n detected earlier — result event confirms session is saved, now handoff
        claudeLog.info(
          `[ClaudeService] Result event received with pending handoff — session saved, proceeding with handoff`,
        );
        this.handoffToTerminal(execution, execution.pendingHandoff.reason);
      }
      // Do NOT call handleCompletion here — let process 'close' event drive it
      // This prevents a race where stdout result fires before stderr rate-limit detection
    }

    // Capture session ID from init event
    if (t === 'system') {
      this.debugLog(`[ClaudeService] System event:`, JSON.stringify(event));
      if (event.subtype === 'init' && event.session_id) {
        execution.sessionId = event.session_id;
        claudeLog.info(`[ClaudeService] Session ID captured: ${event.session_id}`);
      }
    }

    // Extract token usage from assistant events (streaming updates)
    // Only update from main process events (taskDepth === 0), skip subagent usage
    if (t === 'assistant' && event.message?.usage && execution.taskDepth === 0) {
      this.updateTokenUsage(execution, event.message.usage, null);
    }

    // Extract final token usage from result event (always top-level)
    if (t === 'result' && event.modelUsage) {
      // modelUsage contains per-model stats including contextWindow
      const modelKey = Object.keys(event.modelUsage)[0];
      if (modelKey) {
        const modelStats = event.modelUsage[modelKey];
        this.updateTokenUsage(execution, event.usage, modelStats.contextWindow);
      }
    }

    // Detect errors in system messages
    if (t === 'system' && event.error) {
      // Defense-in-depth: detect rate limit in JSON system error events
      if (
        /hit your limit|rate_limit_error|exceed your (?:organization|account)(?:'s|s)? rate limit/i.test(
          event.error,
        )
      ) {
        execution.accountLimitHit = true;
      }
      const entry = {
        line: `[System Error] ${event.error}`,
        timestamp: new Date().toISOString(),
        level: 'error',
      };
      this.pushLog(execution, entry);
      this.broadcast(execution.id, { type: 'log', executionId: execution.id, ...entry });
    }
  }

  /**
   * Check if output contains patterns that indicate waiting for user input
   * @param {Object} execution - Execution object
   * @param {string} text - Text to check
   * @param {string} source - Source of the text (event type or 'unknown')
   */
  checkInputWaitPatterns(execution, text, source = 'unknown') {
    // Skip if already waiting for AskUserQuestion input or already handed off
    if (execution.inputRequired || execution.status === 'handed-off') return;

    // tool_result content (source: 'user') can contain document text that
    // false-matches input patterns (e.g. "proceed?" in FAQ). Skip.
    if (source === 'user') return;

    for (const { pattern, description } of INPUT_WAIT_PATTERNS) {
      if (pattern.test(text)) {
        if (!execution.waitingForInput) {
          execution.waitingForInput = true;
          execution.waitingInputPattern = description;
          const textSnippet = text.length > 200 ? text.substring(0, 200) + '...' : text;
          claudeLog.info(
            `[ClaudeService] Input wait detected: ${description} | source: ${source} | matched: "${textSnippet}"`,
          );
          this.broadcastState(execution);
          this.broadcastInputWait(execution, text, description);

          // Defer handoff until result event so session JSONL is saved
          const reason = `Input required: ${description}`;
          execution.pendingHandoff = { reason, timestamp: Date.now() };
          execution.pendingHandoffTimeout = setTimeout(() => {
            if (execution.pendingHandoff && execution.status === 'running') {
              claudeLog.warn(
                `[ClaudeService] Pending handoff timeout (${PENDING_HANDOFF_TIMEOUT_MS}ms) - forcing handoff`,
              );
              this.handoffToTerminal(execution, execution.pendingHandoff.reason);
            }
          }, PENDING_HANDOFF_TIMEOUT_MS);
        }
        return;
      }
    }
  }

  /**
   * Update token usage and calculate context percentage
   * @param {Object} execution - Execution object
   * @param {Object} usage - Token usage object
   * @param {number|null} contextWindow - Context window size
   */
  updateTokenUsage(execution, usage, contextWindow) {
    if (!usage) return;

    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;

    // Use provided contextWindow or fall back to previous value or default
    const ctxWindow =
      contextWindow || execution.tokenUsage?.contextWindow || DEFAULT_CONTEXT_WINDOW;

    // Use latest values (each assistant event reports complete turn usage)
    execution.tokenUsage = {
      input,
      output,
      cacheCreation,
      cacheRead,
      contextWindow: ctxWindow,
    };

    // Context window usage = all prompt tokens (uncached + cache write + cache read)
    // cache_read_input_tokens occupy context window space (served from cache but still counted).
    // Cap at 100% — subagent/Task tool executions can report cumulative cache_read that
    // exceeds the single-session context window, producing misleading >100% values.
    const totalContext = input + cacheCreation + cacheRead;
    execution.contextPercent = Math.min(100, Math.floor((totalContext / ctxWindow) * 100));

    this.broadcastState(execution);
  }
}

/**
 * Extract displayable text from a stream-json event
 * @param {Object} event - Stream-json event
 * @returns {string|null} Display text or null
 */
export function extractStreamText(event) {
  const t = event.type;

  if (t === 'assistant' && event.message) {
    const parts = [];
    for (const block of event.message?.content || []) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else if (block.type === 'tool_use') {
        parts.push(`[Tool: ${block.name}]`);
      }
    }
    return parts.join('\n') || null;
  }

  // Claude API version compatibility: older versions use 'content_block_delta',
  // newer versions may use 'content_delta'. Check both for forward/backward compat.
  if (t === 'content_block_delta' || t === 'content_delta') {
    return event.delta?.text || null;
  }

  if (t === 'result') {
    const cost = event.total_cost_usd ? ` ($${event.total_cost_usd.toFixed(4)})` : '';
    const duration = event.duration_ms ? ` [${(event.duration_ms / 1000).toFixed(1)}s]` : '';
    return `[Result: ${event.subtype || 'done'}${duration}${cost}]`;
  }

  if (t === 'user' && event.message) {
    for (const block of event.message?.content || []) {
      if (block.type === 'tool_result') {
        const content = block.content || '';
        const preview =
          typeof content === 'string'
            ? content.substring(0, 200)
            : JSON.stringify(content).substring(0, 200);
        // Only append ... if we actually truncated
        const suffix =
          preview.length <
          (typeof content === 'string' ? content.length : JSON.stringify(content).length)
            ? '...'
            : '';
        return `[Tool result: ${preview}${suffix}]`;
      }
    }
    return null;
  }

  if (t === 'system') {
    return event.subtype === 'init' ? '[Claude initialized]' : event.message || event.text || null;
  }

  return null;
}

/**
 * Check if text ends with a question or prompts user for input
 * @param {string} text - Text to check
 * @returns {boolean} True if ends with question
 */
export function endsWithQuestion(text) {
  if (!text) return false;
  // Get last non-empty line
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return false;
  const lastLine = lines[lines.length - 1].trim();

  // Check both ASCII ? and full-width ？ (Japanese)
  if (lastLine.endsWith('?') || lastLine.endsWith('？')) {
    return true;
  }

  // Japanese request patterns that prompt for user input (end with 。but are questions)
  const japanesePromptPatterns = [
    /選択してください[。]?$/, // "please select"
    /どちらにしますか[。]?$/, // "which one"
    /教えてください[。]?$/, // "please tell"
    /お願いします[。]?$/, // "please" (request)
    /指定してください[。]?$/, // "please specify"
    /決めてください[。]?$/, // "please decide"
    /確認してください[。]?$/, // "please confirm"
  ];

  for (const pattern of japanesePromptPatterns) {
    if (pattern.test(lastLine)) {
      return true;
    }
  }

  return false;
}
