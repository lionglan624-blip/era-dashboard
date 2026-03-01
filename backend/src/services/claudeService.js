import { spawn, spawnSync, execSync } from 'child_process';
import { mkdir } from 'fs/promises';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import crypto from 'crypto';
import path from 'path';
import net from 'net';
import { claudeLog } from '../utils/logger.js';
import {
  STALL_TIMEOUT_MS,
  STALL_CHECK_INTERVAL_MS,
  PROXY_TIMEOUT_MS,
  EXECUTION_TTL_MS,
  MAX_LOG_ENTRIES,
  MAX_RETRIES,
  MAX_FL_RETRIES,
  RETRY_DELAY_MS,
  CHAIN_WAITER_TIMEOUT_MS,
  STUCK_RUNNING_TIMEOUT_MS,
  CLEANUP_INTERVAL_MS,
  HANDOFF_DELAY_MS,
  LOG_TRIM_MARGIN,
  PROXY_HOST,
  PROXY_PORT,
  PROXY_URL,
  PROXY_ENABLED,
  CCS_INSTANCES_DIR,
  SHELL_STATE_TTL_MS,
  RATE_LIMIT_RETRY_BUFFER_MS,
  RATE_LIMIT_SAFE_THRESHOLD,
} from '../config.js';

// Import extracted modules
import { validateFeatureId, validateCommand } from './validation.js';
import { INPUT_WAIT_PATTERNS } from './inputPatterns.js';
import { getCcsDefaultProfile, getCcsProfiles } from './ccsUtils.js';
import { getTotalPhases } from './phaseUtils.js';
import {
  ChainExecutor,
  getNextChainCommand,
  isExpectedStatusAfterCommand,
} from './chainExecutor.js';
import { EmailService } from './emailService.js';
import { StreamParser, extractStreamText, endsWithQuestion } from './streamParser.js';

// Verbose debug logging (enable with DASHBOARD_DEBUG=1)
const DEBUG = process.env.DASHBOARD_DEBUG === '1';
const debugLog = DEBUG ? claudeLog.info.bind(claudeLog) : () => {};

// Re-export for backward compatibility
export { validateFeatureId, validateCommand, INPUT_WAIT_PATTERNS };
export { getNextChainCommand, isExpectedStatusAfterCommand };

/**
 * @typedef {Object} Execution
 * @property {string} id - Unique execution ID (UUID)
 * @property {string|null} featureId - Feature ID being executed
 * @property {string} command - Command being executed (fc, fl, run)
 * @property {import('child_process').ChildProcess|null} process - Child process
 * @property {'queued'|'running'|'completed'|'failed'|'cancelled'|'handed-off'} status
 * @property {string|null} startedAt - ISO timestamp
 * @property {string|null} completedAt - ISO timestamp
 * @property {number|null} exitCode
 * @property {Array<{line: string, timestamp: string, level: string}>} logs
 * @property {number|null} currentPhase
 * @property {string|null} sessionId - Claude session ID for resume
 * @property {number|null} contextPercent - Context window usage percentage
 * @property {boolean} isStalled - Whether execution has stalled
 */

/**
 * Service for managing Claude CLI executions
 */
export class ClaudeService {
  /**
   * @param {string} projectRoot - Project root directory
   * @param {import('../websocket/logStreamer.js').LogStreamer} logStreamer - WebSocket broadcaster
   * @param {Object} [options]
   * @param {number} [options.maxConcurrent=99] - Maximum concurrent executions
   */
  constructor(projectRoot, logStreamer, { maxConcurrent = 99 } = {}) {
    this.projectRoot = projectRoot;
    this.logStreamer = logStreamer;
    this.maxConcurrent = maxConcurrent;
    this.executions = new Map();
    this.queue = [];
    this._shellStatesPath = path.join(projectRoot, '_out', 'tmp', 'dashboard', 'shell-states.json');
    this.shellStates = this._loadShellStates();
    this.fileWatcher = null; // Set by server.js after construction for chain race condition fix
    this.tmpDir = path.join(projectRoot, '_out', 'tmp', 'dashboard');
    mkdir(this.tmpDir, { recursive: true }).catch((err) =>
      claudeLog.debug(`Failed to create tmp dir: ${err.message}`),
    );

    // Persistent session ID map (survives execution TTL eviction)
    this._sessionMapPath = path.join(this.tmpDir, 'sessions.json');
    this._sessionMap = this._loadSessionMap();

    // Initialize ChainExecutor with dependencies
    this.chainExecutor = new ChainExecutor({
      getExecution: (id) => this.executions.get(id),
      executeCommand: (fid, cmd, opts) => this.executeCommand(fid, cmd, opts),
      pushLog: (exec, entry) => this._pushLog(exec, entry),
      broadcastAll: (msg) => this.logStreamer?.broadcastAll(msg),
      getStatusFromCache: (fid) => this.fileWatcher?.statusCache.get(fid),
    });

    // Initialize StreamParser with callbacks
    this.streamParser = new StreamParser({
      pushLog: (exec, entry) => this._pushLog(exec, entry),
      broadcast: (execId, msg) => this.logStreamer?.broadcast(execId, msg),
      broadcastState: (exec) => this._broadcastState(exec),
      broadcastInputWait: (exec, text, desc) => this._broadcastInputWait(exec, text, desc),
      broadcastInputRequired: (exec) => this._broadcastInputRequired(exec),
      handoffToTerminal: (exec, reason) => this._handoffToTerminal(exec, reason),
      handleCompletion: (exec, exitCode) => this._handleCompletion(exec, exitCode),
      debugLog: debugLog,
    });

    // CCS profile is managed via CLAUDE_CONFIG_DIR environment variable

    this.emailService = new EmailService();

    this._cleanupInterval = setInterval(() => this._cleanupOldExecutions(), CLEANUP_INTERVAL_MS);

    // Rate limit retry state
    this._rateLimitPaused = false;
    this._rateLimitRetryTimer = null;
    this._rateLimitRetryInfo = null; // { execution, retryAt }
  }

  /**
   * Scan debug log file for rate limit errors (429).
   * Returns true if rate limit was detected and execution.accountLimitHit was set.
   */
  _scanDebugLogForRateLimit(execution) {
    try {
      if (existsSync(execution.debugLogPath)) {
        // 16KB tail: CLI writes hooks/telemetry/session-save after 429, which can
        // push the rate_limit_error line >4KB from the end in long-running sessions
        const tail = readFileSync(execution.debugLogPath, 'utf8').slice(-16384);
        if (/rate_limit_error|429.*rate.?limit/i.test(tail)) {
          execution.accountLimitHit = true;
          claudeLog.info(
            `[ClaudeService] Rate limit detected from debug log for F${execution.featureId} ${execution.command}`,
          );
          return true;
        }
      }
    } catch (err) {
      claudeLog.debug(
        `[ClaudeService] Debug log scan failed for ${execution.id}: ${err.code || err.message}`,
      );
    }
    return false;
  }

  /** Load shell states from disk (survives restart) */
  _loadShellStates() {
    try {
      if (existsSync(this._shellStatesPath)) {
        const data = JSON.parse(readFileSync(this._shellStatesPath, 'utf8'));
        const map = new Map();
        const now = Date.now();
        for (const [cmd, state] of Object.entries(data)) {
          // Only load entries within TTL
          if (now - new Date(state.timestamp).getTime() < SHELL_STATE_TTL_MS) {
            map.set(cmd, state);
          }
        }
        return map;
      }
    } catch (err) {
      claudeLog.debug(`[ClaudeService] Failed to load shell-states.json: ${err.message}`);
    }
    return new Map();
  }

  /** Set a shell command state and persist to disk */
  _setShellState(command, success) {
    this.shellStates.set(command, { success, timestamp: new Date().toISOString() });
    this._persistShellStates();
  }

  /** Persist shell states to disk */
  _persistShellStates() {
    try {
      const obj = Object.fromEntries(this.shellStates);
      writeFileSync(this._shellStatesPath, JSON.stringify(obj, null, 2));
    } catch (err) {
      claudeLog.debug(`[ClaudeService] Failed to save shell-states.json: ${err.message}`);
    }
  }

  /** Load persistent session ID map from disk */
  _loadSessionMap() {
    try {
      if (existsSync(this._sessionMapPath)) {
        return JSON.parse(readFileSync(this._sessionMapPath, 'utf8'));
      }
    } catch (err) {
      claudeLog.debug(`[ClaudeService] Failed to load sessions.json: ${err.message}`);
    }
    return {};
  }

  /** Persist a session ID to disk (keyed by execution ID) */
  _saveSessionId(executionId, sessionId, featureId, command) {
    this._sessionMap[executionId] = {
      sessionId,
      featureId,
      command,
      savedAt: new Date().toISOString(),
    };
    // Prune entries older than 7 days
    const cutoff = Date.now() - 7 * 24 * 3600000;
    for (const [id, entry] of Object.entries(this._sessionMap)) {
      if (new Date(entry.savedAt).getTime() < cutoff) delete this._sessionMap[id];
    }
    try {
      writeFileSync(this._sessionMapPath, JSON.stringify(this._sessionMap, null, 2));
    } catch (err) {
      claudeLog.debug(`[ClaudeService] Failed to save sessions.json: ${err.message}`);
    }
  }

  /** Look up session info from persistent map (fallback when execution evicted from memory) */
  _lookupSessionId(executionId) {
    return this._sessionMap[executionId] || null;
  }

  /** Get current CCS profile (reads from config.yaml each time to track changes) */
  getCcsProfile() {
    // Priority: CCS_PROFILE env var > config.yaml default
    return process.env.CCS_PROFILE || getCcsDefaultProfile();
  }

  /** Get current CCS version */
  _getCcsVersion() {
    try {
      const result = spawnSync('ccs', ['--version'], {
        timeout: 5000,
        encoding: 'utf8',
        windowsHide: true,
        shell: true,
      });
      const firstLine = result.stdout?.split('\n')[0]?.trim();
      if (!firstLine) return null;
      // Extract version from "CCS (Claude Code Switch) v7.37.1"
      const match = firstLine.match(/v([\d.]+)/);
      return match ? match[1] : firstLine;
    } catch {
      return null;
    }
  }

  /** Push a log entry, trimming old entries if over MAX_LOG_ENTRIES + LOG_TRIM_MARGIN */
  _pushLog(execution, entry) {
    execution.logs.push(entry);
    if (execution.logs.length > MAX_LOG_ENTRIES + LOG_TRIM_MARGIN) {
      execution.logs = execution.logs.slice(-MAX_LOG_ENTRIES);
    }
  }

  /** Create a new execution object with default values */
  _createExecution({
    featureId = null,
    command,
    chain = false,
    chainParentId = null,
    retryCount = 0,
    contextRetryCount = 0,
    chainHistory = [],
  } = {}) {
    return {
      id: crypto.randomUUID(),
      featureId,
      command,
      process: null,
      stdin: null,
      status: 'queued',
      startedAt: null,
      completedAt: null,
      exitCode: null,
      logs: [],
      currentPhase: null,
      currentPhaseName: null,
      currentIteration: null,
      pendingToolUse: null,
      inputRequired: null,
      inputContext: null,
      waitingForInput: false,
      waitingInputPattern: null,
      lastOutputTime: null,
      stallCheckInterval: null,
      activityCheckInterval: null,
      lastAssistantText: '',
      sessionId: null,
      lastActivityTime: null,
      contextPercent: null,
      tokenUsage: null,
      taskDepth: 0,
      taskToolIds: new Set(),
      taskStartTimes: new Map(),
      isStalled: false,
      resultSubtype: null,
      chain: chain ? { enabled: true, retryCount, contextRetryCount, history: chainHistory } : null,
      chainParentId,
      debugLogPath: null,
      killedByUser: false,
      promptTooLong: false,
      accountLimitHit: false,
    };
  }

  /** Clean up old completed executions and stale chain waiters to prevent memory leak */
  _cleanupOldExecutions() {
    const now = Date.now();
    // Collect IDs to delete to avoid modifying Map during iteration
    const idsToDelete = [];
    for (const [id, exec] of this.executions) {
      if (exec.completedAt) {
        const completedTime = new Date(exec.completedAt).getTime();
        if (now - completedTime > EXECUTION_TTL_MS) {
          idsToDelete.push(id);
        }
      }
    }
    // Delete collected IDs
    for (const id of idsToDelete) {
      this.streamParser.clearRingBuffer(id);
      this.executions.delete(id);
    }
    // Detect stuck running executions (process likely dead, no output for extended period)
    for (const [id, exec] of this.executions) {
      if (
        exec.status === 'running' &&
        exec.lastOutputTime &&
        now - exec.lastOutputTime > STUCK_RUNNING_TIMEOUT_MS
      ) {
        claudeLog.warn(
          `[ClaudeService] Cleaning up stuck execution ${id} (no output for ${Math.round((now - exec.lastOutputTime) / 60000)}min)`,
        );
        if (exec.process) this._killProcess(exec.process);
        if (exec.stallCheckInterval) {
          clearInterval(exec.stallCheckInterval);
          exec.stallCheckInterval = null;
        }
        if (exec.activityCheckInterval) {
          clearInterval(exec.activityCheckInterval);
          exec.activityCheckInterval = null;
        }
        exec.status = 'failed';
        exec.completedAt = new Date().toISOString();
        exec.process = null;
      }
    }
    // Clean stale chain waiters (feature status change never arrived)
    const staleFeatureIds = [];
    for (const [featureId, waiter] of this.chainExecutor.getAllWaiters()) {
      if (now - waiter.registeredAt > CHAIN_WAITER_TIMEOUT_MS) {
        staleFeatureIds.push(featureId);
      }
    }
    // Delete stale waiters
    for (const featureId of staleFeatureIds) {
      const waiter = this.chainExecutor.getWaiter(featureId);
      claudeLog.info(`[Chain] Stale waiter removed for F${featureId} (timeout)`);
      this.chainExecutor.deleteWaiter(featureId);
      // Safety net: send email so user knows the chain stalled
      const stalledExec = this.executions.get(waiter.executionId);
      if (stalledExec) {
        const chainHistory = stalledExec.chain?.history || [];
        const finalHistory = [...chainHistory, { command: stalledExec.command, result: 'ok' }];
        const featureInfo =
          stalledExec.featureId && this.featureService
            ? this.featureService.getFeature(stalledExec.featureId)
            : null;
        this.emailService
          ?.sendCompletionNotification(
            stalledExec,
            stalledExec.status,
            stalledExec.exitCode ?? 0,
            finalHistory,
            featureInfo,
          )
          .catch(() => {});
      }
    }
    // Trigger Auto-DR re-check if any stale waiters were removed
    if (staleFeatureIds.length > 0) {
      this.onExecutionComplete?.();
    }
  }

  /** Build environment variables for claude child processes */
  _buildClaudeEnv(execution) {
    const env = { ...process.env };
    delete env.CLAUDECODE; // Prevent nested session detection
    // Only set FORCE_COLOR=0 for non-terminal mode
    if (!execution?.terminal) {
      env.FORCE_COLOR = '0';
    } else {
      // For terminal mode, let terminal handle colors naturally
      delete env.FORCE_COLOR;
    }
    if (PROXY_ENABLED) {
      env.HTTPS_PROXY = PROXY_URL;
      env.HTTP_PROXY = PROXY_URL;
    }
    // CCS profile integration: point to CCS instance directory
    const profile = this.getCcsProfile();
    if (profile) {
      env.CLAUDE_CONFIG_DIR = path.join(CCS_INSTANCES_DIR, profile);
    }
    return env;
  }

  /** Check if proxy is reachable */
  async checkProxy() {
    if (!PROXY_ENABLED) {
      return { enabled: false, status: 'disabled' };
    }
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: PROXY_HOST, port: PROXY_PORT }, () => {
        socket.destroy();
        resolve({
          enabled: true,
          status: 'online',
          host: PROXY_HOST,
          port: PROXY_PORT,
          url: PROXY_URL,
        });
      });
      socket.setTimeout(PROXY_TIMEOUT_MS);
      socket.on('timeout', () => {
        socket.destroy();
        resolve({
          enabled: true,
          status: 'timeout',
          host: PROXY_HOST,
          port: PROXY_PORT,
          url: PROXY_URL,
        });
      });
      socket.on('error', () => {
        socket.destroy();
        resolve({
          enabled: true,
          status: 'offline',
          host: PROXY_HOST,
          port: PROXY_PORT,
          url: PROXY_URL,
        });
      });
    });
  }

  get runningCount() {
    let count = 0;
    for (const exec of this.executions.values()) {
      if (exec.status === 'running') count++;
    }
    return count;
  }

  executeFL(featureId) {
    return this.executeCommand(featureId, 'fl');
  }

  executeRun(featureId) {
    return this.executeCommand(featureId, 'run');
  }

  /**
   * Execute a Claude command for a feature
   * @param {string|number} featureId - Feature ID to execute
   * @param {'fc'|'fl'|'run'} command - Command to execute
   * @param {Object} [options]
   * @param {boolean} [options.chain=false] - Enable chain execution (fc→fl→run)
   * @param {string|null} [options.chainParentId=null] - Parent execution ID for chain
   * @param {number} [options.retryCount=0] - Current retry count for FL auto-retry
   * @param {Array<{command: string, result: string, reason?: string}>} [options.chainHistory=[]] - Chain execution history
   * @returns {string} Execution ID
   */
  executeCommand(
    featureId,
    command,
    {
      chain = false,
      chainParentId = null,
      retryCount = 0,
      contextRetryCount = 0,
      chainHistory = [],
    } = {},
  ) {
    // Validate inputs to prevent command injection
    const validatedFeatureId = validateFeatureId(featureId);
    const validatedCommand = validateCommand(command);

    const execution = this._createExecution({
      featureId: validatedFeatureId,
      command: validatedCommand,
      chain,
      chainParentId,
      retryCount,
      contextRetryCount,
      chainHistory,
    });
    const executionId = execution.id;

    this.executions.set(executionId, execution);

    // Shorten idle refresh intervals now that an execution is starting,
    // then trigger capture (uses cache if fresh after recompute)
    if (this.rateLimitService) {
      this.rateLimitService.recomputeRefreshTimes();
      this.rateLimitService.capture().catch(() => {});
    }

    if (this.runningCount < this.maxConcurrent) {
      this._startExecution(execution);
    } else {
      this.queue.push(executionId);
      this._pushLog(execution, {
        line: `Queued (position ${this.queue.length}). Waiting for slot...`,
        timestamp: new Date().toISOString(),
        level: 'info',
      });
      this._broadcastQueueUpdate();
    }

    return executionId;
  }

  _startExecution(execution) {
    const { id: executionId, featureId, command } = execution;
    const cliPrompt = featureId ? `/${command} ${featureId}` : `/${command}`;

    execution.status = 'running';
    execution.startedAt = new Date().toISOString();
    execution.lastOutputTime = Date.now();
    this._pushLog(execution, {
      line: `Starting: claude -p "${cliPrompt}" --output-format stream-json`,
      timestamp: execution.startedAt,
      level: 'info',
    });

    const claudePath = process.env.CLAUDE_PATH || 'claude';

    // Debug log file for post-mortem analysis
    const debugLogPath = path.join(this.tmpDir, `debug-${executionId}.log`);
    execution.debugLogPath = debugLogPath;

    const ccsProfile = this.getCcsProfile();
    claudeLog.info(
      `[ClaudeService] Launching: ${claudePath} -p "${cliPrompt}" (CCS profile: ${ccsProfile || 'default'})`,
    );
    debugLog(`[ClaudeService] Debug log: ${debugLogPath}`);

    // Launch claude directly with stdin/stdout pipes
    // Note: --verbose must come before --output-format stream-json
    // --debug-file enables debug logging to file for troubleshooting
    const args = [
      '-p',
      cliPrompt,
      '--verbose',
      '--debug-file',
      debugLogPath,
      '--output-format',
      'stream-json',
    ];
    debugLog(`[ClaudeService] spawn args:`, [claudePath, ...args].join(' '));

    const proc = spawn(claudePath, args, {
      cwd: this.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: this._buildClaudeEnv(execution),
    });

    execution.process = proc;
    execution.stdin = null; // stdin disabled for now

    claudeLog.info(`[ClaudeService] Spawned claude PID=${proc.pid}`);

    this._attachStdoutHandler(execution, proc);
    this._attachStderrHandler(execution, proc);

    proc.on('error', (err) => {
      claudeLog.error(`[ClaudeService] Process error: ${err.message}`);
      this._handleCompletion(execution, 1, err.message);
    });

    proc.on('close', (code) => {
      claudeLog.info(`[ClaudeService] Process exited with code ${code}`);
      if (execution.status === 'running') {
        // Prefer resultExitCode from stream-json 'result' event (more accurate than process exit code)
        // The 'close' event fires after ALL stdio streams are drained, ensuring
        // stderr-based detection (accountLimitHit, promptTooLong) is complete
        const exitCode = execution.resultExitCode ?? code ?? 1;
        this._handleCompletion(execution, exitCode);
      } else if (execution.status === 'handed-off') {
        if (execution.stallCheckInterval) {
          clearInterval(execution.stallCheckInterval);
          execution.stallCheckInterval = null;
        }
        execution.process = null;
        this._dequeueNext();
      }
    });

    // Start stall detection
    execution.stallCheckInterval = setInterval(() => {
      this._checkStall(execution);
    }, STALL_CHECK_INTERVAL_MS);

    this._broadcastQueueUpdate();
    this._broadcastState(execution);
  }

  /**
   * Attach a stream handler with buffered line processing
   * @param {NodeJS.ReadableStream} stream - The stream to attach to
   * @param {function(string): void} onLine - Callback for each complete line
   * @param {function(string): void} onEnd - Callback for remaining buffer on stream end
   */
  _attachStreamHandler(stream, onLine, onEnd) {
    let buffer = '';

    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.trim()) {
          onLine(line);
        }
      }
    });

    stream.on('end', () => {
      if (buffer.trim()) {
        onEnd(buffer);
      }
    });
  }

  /** Attach stdout handler for stream-json output */
  _attachStdoutHandler(execution, proc) {
    this._attachStreamHandler(
      proc.stdout,
      (line) => {
        execution.lastOutputTime = Date.now();
        if (execution.isStalled) {
          execution.isStalled = false;
          this._broadcastState(execution);
        }
        this._processStreamLine(execution, line);
      },
      (remaining) => {
        this._processStreamLine(execution, remaining);
      },
    );
  }

  /** Process stream line - delegate to streamParser which calls _handleStreamEvent */
  _processStreamLine(execution, raw) {
    this.streamParser.processStreamLine(execution, raw);
  }

  /** Wrapper: delegate to streamParser */
  _handleStreamEvent(execution, event) {
    return this.streamParser.handleStreamEvent(execution, event);
  }

  /** Wrapper: delegate to streamParser */
  _extractStreamText(event) {
    return extractStreamText(event);
  }

  /** Wrapper: delegate to streamParser */
  _checkInputWaitPatterns(execution, text) {
    return this.streamParser.checkInputWaitPatterns(execution, text);
  }

  /** Wrapper: delegate to imported function */
  _endsWithQuestion(text) {
    return endsWithQuestion(text);
  }

  /** Wrapper: delegate to streamParser */
  _updateTokenUsage(execution, usage, contextWindow) {
    return this.streamParser.updateTokenUsage(execution, usage, contextWindow);
  }

  /** Attach stderr handler for debug/error output */
  _attachStderrHandler(execution, proc) {
    const executionId = execution.id;

    const processStderrLine = (line) => {
      execution.lastOutputTime = Date.now();
      // Detect context window exhaustion
      if (/Prompt is too long|Context limit reached/i.test(line)) {
        execution.promptTooLong = true;
      }
      if (
        /hit your limit|rate_limit_error|exceed your (?:organization|account)(?:'s|s)? rate limit/i.test(
          line,
        )
      ) {
        execution.accountLimitHit = true;
      }
      const entry = {
        line: `[stderr] ${line}`,
        timestamp: new Date().toISOString(),
        level: line.includes('ERROR') ? 'error' : 'debug',
      };
      this._pushLog(execution, entry);
      this.logStreamer?.broadcast(executionId, { type: 'log', executionId, ...entry });
    };

    this._attachStreamHandler(proc.stderr, processStderrLine, processStderrLine);
  }

  /** Broadcast input wait event */
  _broadcastInputWait(execution, text, description) {
    this.logStreamer?.broadcast(execution.id, {
      type: 'input-wait',
      executionId: execution.id,
      pattern: description,
      text: text,
      timestamp: new Date().toISOString(),
    });
  }

  /** Handoff execution to terminal when user input is required */
  _handoffToTerminal(execution, reason) {
    if (execution.status === 'handed-off' || !execution.sessionId) {
      return;
    }

    // Persist sessionId to disk for resume after TTL eviction
    this._saveSessionId(execution.id, execution.sessionId, execution.featureId, execution.command);

    // Clean up deferred handoff state
    if (execution.pendingHandoffTimeout) {
      clearTimeout(execution.pendingHandoffTimeout);
      execution.pendingHandoffTimeout = null;
    }
    execution.pendingHandoff = null;

    claudeLog.info(
      `[ClaudeService] Handing off to terminal: ${reason} (session: ${execution.sessionId})`,
    );

    // Dump ring buffer for post-mortem analysis
    const recentOutput = this.streamParser.getRingBufferSnapshot(execution.id);
    if (recentOutput.length > 0) {
      claudeLog.info(
        `[ClaudeService] === Handoff context dump (last ${recentOutput.length} lines) ===`,
      );
      for (const entry of recentOutput) {
        const preview = entry.text.length > 200 ? entry.text.substring(0, 200) + '...' : entry.text;
        claudeLog.info(`[ClaudeService]   [${entry.source}] ${preview}`);
      }
      claudeLog.info(`[ClaudeService] === End handoff context dump ===`);
    }

    execution.status = 'handed-off';

    const entry = {
      line: `[Handoff] ${reason} - Opening terminal for user input...`,
      timestamp: new Date().toISOString(),
      level: 'info',
    };
    this._pushLog(execution, entry);
    this.logStreamer?.broadcast(execution.id, { type: 'log', executionId: execution.id, ...entry });

    this.logStreamer?.broadcast(execution.id, {
      type: 'handoff',
      executionId: execution.id,
      reason: reason,
      sessionId: execution.sessionId,
      timestamp: new Date().toISOString(),
    });

    const chainHistory = execution.chain?.history || [];
    const finalHistory = [...chainHistory, { command: execution.command, result: 'handoff' }];
    const featureInfo =
      execution.featureId && this.featureService
        ? this.featureService.getFeature(execution.featureId)
        : null;
    this.emailService
      ?.sendHandoffNotification(
        execution,
        reason,
        execution.chain?.enabled ? finalHistory : undefined,
        featureInfo,
      )
      .catch(() => {});

    if (execution.process) {
      this._killProcess(execution.process);
    }

    if (execution.stallCheckInterval) {
      clearInterval(execution.stallCheckInterval);
      execution.stallCheckInterval = null;
    }

    setTimeout(() => {
      this.resumeInTerminal(execution.id);
    }, HANDOFF_DELAY_MS);

    this._broadcastState(execution);
    this._dequeueNext();
    this.onExecutionComplete?.(execution);
  }

  /** Detect if FL workflow requested a re-run (Forward-Only Mode completion) */
  _detectFlRerunRequest(execution) {
    if (!execution.lastAssistantText) return false;

    // Patterns indicating FL workflow wants to be re-run
    const rerunPatterns = [
      /再実行してください/, // "please re-run"
      /\/fl\s+\d+.*を再実行/, // "/fl {ID} を再実行"
      /`\/fl\s+\d+`/, // "`/fl {ID}`" (markdown code)
      /Forward-Only.*再検証/, // "Forward-Only... re-verify"
    ];

    for (const pattern of rerunPatterns) {
      if (pattern.test(execution.lastAssistantText)) {
        return true;
      }
    }

    return false;
  }

  /** Check if execution has stalled */
  _checkStall(execution) {
    if (execution.status !== 'running') return;

    const elapsed = Date.now() - execution.lastOutputTime;
    if (elapsed > STALL_TIMEOUT_MS) {
      // Don't report stall if waiting for user input
      if (execution.inputRequired) return;
      if (execution.taskDepth > 0) return; // Subagent running, not stalled

      if (!execution.isStalled) {
        execution.isStalled = true;
        this._broadcastState(execution);
        this.logStreamer?.broadcast(execution.id, {
          type: 'stalled',
          executionId: execution.id,
          elapsed,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /** Broadcast current execution state */
  _broadcastState(execution) {
    this.logStreamer?.broadcast(execution.id, {
      type: 'state',
      executionId: execution.id,
      status: execution.status,
      phase: execution.currentPhase,
      phaseName: execution.currentPhaseName,
      totalPhases: getTotalPhases(execution.command),
      iteration: execution.currentIteration, // FL workflow iteration (e.g., 1, 2, 3)
      sessionId: execution.sessionId, // Added: needed for Resume button
      inputRequired: !!execution.inputRequired,
      waitingForInput: execution.waitingForInput,
      waitingInputPattern: execution.waitingInputPattern,
      pendingTool: execution.pendingToolUse?.name || null,
      isStalled: execution.isStalled || false,
      taskDepth: execution.taskDepth || 0,
      contextPercent: execution.contextPercent, // Context window usage percentage
      tokenUsage: execution.tokenUsage, // Full token usage details
      timestamp: new Date().toISOString(),
    });

    // Write context % to file for FL Context Pressure Gate (statusline doesn't run in -p mode)
    if (execution.featureId && execution.contextPercent != null) {
      const ctxFile = path.join(this.projectRoot, '_out', 'tmp', `claude-ctx-f${execution.featureId}.txt`);
      try {
        writeFileSync(ctxFile, String(execution.contextPercent));
      } catch {}
    }
  }

  /** Broadcast input required event with full context */
  _broadcastInputRequired(execution) {
    this.logStreamer?.broadcast(execution.id, {
      type: 'input-required',
      executionId: execution.id,
      context: execution.inputContext,
      questions: execution.inputRequired?.questions || [],
      toolUseId: execution.inputRequired?.toolUseId,
      timestamp: new Date().toISOString(),
    });
  }

  /** Handle execution completion */
  _handleCompletion(execution, exitCode, error = null) {
    // Guard against double completion
    if (execution.status !== 'running') {
      return;
    }

    const executionId = execution.id;
    claudeLog.info(
      `[ClaudeService] Execution ${executionId} completed with code ${exitCode}, subtype=${execution.resultSubtype}`,
    );

    if (execution.stallCheckInterval) {
      clearInterval(execution.stallCheckInterval);
      execution.stallCheckInterval = null;
    }

    // Persist sessionId to disk for resume after TTL eviction
    if (execution.sessionId) {
      this._saveSessionId(
        execution.id,
        execution.sessionId,
        execution.featureId,
        execution.command,
      );
    }

    // Check if normal completion ended with a question → handoff to terminal directly
    // Must check before setting status to avoid completed→handed-off flicker on frontend
    if (
      !error &&
      exitCode === 0 &&
      execution.sessionId &&
      endsWithQuestion(execution.lastAssistantText)
    ) {
      claudeLog.info(`[ClaudeService] Completed with pending question - handing off to terminal`);
      execution.process = null;
      execution.stdin = null;
      this._handoffToTerminal(execution, 'Completed with unanswered question');
      return;
    }

    // Late-stage rate limit detection: scan debug log for 429 errors that
    // weren't caught by stderr/stdout (CLI writes to debug file but not to streams)
    if (!execution.accountLimitHit && exitCode !== 0 && execution.debugLogPath) {
      const detected = this._scanDebugLogForRateLimit(execution);
      if (!detected) {
        // Schedule a deferred re-scan: on Windows, the CLI process may still hold
        // a file lock on the debug log at the moment 'close' fires, causing
        // readFileSync to throw EBUSY/EPERM. A 500ms delay allows the file handle
        // to be released.
        setTimeout(() => {
          if (this._scanDebugLogForRateLimit(execution)) {
            // Late detection: cancel any in-flight context retry timer
            if (execution._contextRetryTimer) {
              clearTimeout(execution._contextRetryTimer);
              execution._contextRetryTimer = null;
              claudeLog.info(
                `[ClaudeService] Deferred rate limit detection for F${execution.featureId} ${execution.command} — cancelled pending context retry`,
              );
            }
            this.streamParser.clearRingBuffer(execution.id);
            const scheduled = this._scheduleRateLimitRetry(execution);
            this._pushLog(execution, {
              line: scheduled
                ? `[Chain] Account rate limit (429) detected (deferred). ${scheduled.message}`
                : `[Chain] Account rate limit (429) detected (deferred). No retry possible.`,
              timestamp: new Date().toISOString(),
              level: 'warning',
            });
            this._broadcastState(execution);
            this.logStreamer?.broadcastAll({
              type: 'account-limit',
              featureId: execution.featureId,
              command: execution.command,
              executionId: execution.id,
              deferred: true,
              timestamp: new Date().toISOString(),
            });
          }
        }, 500);
      }
    }

    // Context exhaustion retry for all commands (fc, fl, run)
    // subtype=success with non-zero exit (is_error=true) indicates context limit
    // reached during a successful operation — CLI couldn't continue but last response was ok
    const isContextExhausted =
      ['error_max_turns', 'max_tokens'].includes(execution.resultSubtype) ||
      execution.promptTooLong ||
      (exitCode !== 0 && execution.resultSubtype === 'success' && !execution.accountLimitHit) ||
      (exitCode === 3 && !execution.resultSubtype);

    const needsContextRetry =
      execution.chain?.enabled &&
      execution.chain.contextRetryCount < MAX_RETRIES &&
      !execution.killedByUser &&
      !execution.accountLimitHit &&
      isContextExhausted;

    if (needsContextRetry) {
      const contextRetryCount = execution.chain.contextRetryCount + 1;
      const reason = execution.promptTooLong
        ? 'Prompt too long (context exhausted)'
        : exitCode === 3 && !execution.resultSubtype
          ? 'Max turns reached (exit code 3)'
          : execution.resultSubtype === 'success'
            ? 'Context limit (success with is_error)'
            : `Context limit (${execution.resultSubtype})`;
      claudeLog.info(
        `[Chain] Context retry ${contextRetryCount}/${MAX_RETRIES} for F${execution.featureId} ${execution.command}: ${reason}`,
      );

      execution.status = 'failed';
      execution.completedAt = new Date().toISOString();
      execution.exitCode = exitCode;
      execution.process = null;
      execution.stdin = null;

      this._pushLog(execution, {
        line: `[Chain] ${reason}. Auto-retrying ${execution.command.toUpperCase()} (context ${contextRetryCount}/${MAX_RETRIES}) in ${RETRY_DELAY_MS / 1000}s...`,
        timestamp: execution.completedAt,
        level: 'warning',
      });

      const updatedHistory = [
        ...(execution.chain?.history || []),
        { command: execution.command, result: 'retry', reason },
      ];

      execution._contextRetryTimer = setTimeout(() => {
        execution._contextRetryTimer = null;
        const newExecId = this.executeCommand(execution.featureId, execution.command, {
          chain: true,
          chainParentId: execution.chainParentId || execution.id,
          retryCount: execution.chain.retryCount, // preserve FL counter
          contextRetryCount,
          chainHistory: updatedHistory,
        });

        this.logStreamer?.broadcastAll({
          type: 'chain-retry',
          featureId: execution.featureId,
          command: execution.command,
          retryType: 'context',
          retryCount: contextRetryCount,
          maxRetries: MAX_RETRIES,
          oldExecutionId: execution.id,
          newExecutionId: newExecId,
          timestamp: new Date().toISOString(),
        });
      }, RETRY_DELAY_MS);

      this._broadcastState(execution);
      this._dequeueNext();
      return;
    }

    // Chain: FL auto-retry on any failure (non-zero exit) or re-run request
    const flWantsRetry =
      execution.chain?.enabled &&
      execution.command === 'fl' &&
      !execution.killedByUser &&
      !execution.accountLimitHit &&
      !isContextExhausted &&
      (exitCode !== 0 || this._detectFlRerunRequest(execution));

    const flNeedsRetry = flWantsRetry && execution.chain.retryCount < MAX_FL_RETRIES;

    if (flNeedsRetry) {
      const retryCount = execution.chain.retryCount + 1;
      const reason =
        exitCode !== 0
          ? `FL failed (exit=${exitCode}, subtype=${execution.resultSubtype})`
          : 'Re-run requested by FL workflow';
      claudeLog.info(
        `[Chain] FL auto-retry ${retryCount}/${MAX_FL_RETRIES} for F${execution.featureId}: ${reason}`,
      );

      // Mark current as completed-with-retry (for history)
      execution.status = 'failed';
      execution.completedAt = new Date().toISOString();
      execution.exitCode = exitCode;
      execution.process = null;
      execution.stdin = null;

      this._pushLog(execution, {
        line: `[Chain] ${reason}. Auto-retrying FL (${retryCount}/${MAX_FL_RETRIES}) in ${RETRY_DELAY_MS / 1000}s...`,
        timestamp: execution.completedAt,
        level: 'warning',
      });

      const updatedHistory = [
        ...(execution.chain?.history || []),
        { command: execution.command, result: 'retry', reason },
      ];

      setTimeout(() => {
        // Start new FL with incremented retry count
        const newExecId = this.executeCommand(execution.featureId, 'fl', {
          chain: true,
          chainParentId: execution.chainParentId || execution.id,
          retryCount,
          contextRetryCount: execution.chain.contextRetryCount, // preserve context counter
          chainHistory: updatedHistory,
        });

        this.logStreamer?.broadcastAll({
          type: 'chain-retry',
          featureId: execution.featureId,
          command: 'fl',
          retryType: 'fl',
          retryCount,
          maxRetries: MAX_FL_RETRIES,
          oldExecutionId: execution.id,
          newExecutionId: newExecId,
          timestamp: new Date().toISOString(),
        });
      }, RETRY_DELAY_MS);

      this._broadcastState(execution);
      this._dequeueNext();
      return;
    }

    // FL retry exhausted: wanted to retry but counter maxed out
    if (flWantsRetry && !flNeedsRetry) {
      const reason =
        exitCode !== 0
          ? `FL failed (exit=${exitCode})`
          : 'Re-run requested but FL retries exhausted';
      claudeLog.warn(
        `[Chain] FL retry exhausted (${execution.chain.retryCount}/${MAX_FL_RETRIES}) for F${execution.featureId}: ${reason}`,
      );

      this._pushLog(execution, {
        line: `[Chain] FL retries exhausted (${execution.chain.retryCount}/${MAX_FL_RETRIES}). ${reason}`,
        timestamp: new Date().toISOString(),
        level: 'warning',
      });

      this.logStreamer?.broadcastAll({
        type: 'fl-retry-exhausted',
        featureId: execution.featureId,
        retryCount: execution.chain.retryCount,
        maxRetries: MAX_FL_RETRIES,
        timestamp: new Date().toISOString(),
      });
    }

    // Notify frontend of account limit (not retryable)
    if (execution.accountLimitHit) {
      this.logStreamer?.broadcastAll({
        type: 'account-limit',
        featureId: execution.featureId,
        command: execution.command,
        executionId: execution.id,
        timestamp: new Date().toISOString(),
      });
    }

    // Rate limit retry: schedule retry for chain executions AND non-chain executions
    // (non-chain also benefit from profile switch / timed retry to avoid wasting context retries)
    if (execution.accountLimitHit && !execution.killedByUser) {
      execution.status = 'failed';
      execution.completedAt = new Date().toISOString();
      execution.exitCode = exitCode;
      execution.process = null;
      execution.stdin = null;
      this.streamParser.clearRingBuffer(execution.id);

      const scheduled = this._scheduleRateLimitRetry(execution);

      this._pushLog(execution, {
        line: scheduled
          ? `[Chain] Account rate limit (429) hit. ${scheduled.message}`
          : `[Chain] Account rate limit (429) hit. No retry possible.`,
        timestamp: execution.completedAt,
        level: 'warning',
      });

      this.logStreamer?.broadcast(executionId, {
        type: 'status',
        executionId,
        status: execution.status,
        exitCode,
      });

      this._broadcastState(execution);

      // Send email with retry info
      const chainHistory = execution.chain?.history || [];
      const finalHistory = [
        ...chainHistory,
        { command: execution.command, result: 'account-limit' },
      ];
      const featureInfo =
        execution.featureId && this.featureService
          ? this.featureService.getFeature(execution.featureId)
          : null;
      this.emailService
        ?.sendCompletionNotification(
          execution,
          execution.status,
          exitCode,
          finalHistory,
          featureInfo,
        )
        .catch(() => {});

      // Refresh rate limit after command completion
      if (this.rateLimitService) {
        this.rateLimitService.capture({ forceRefresh: true }).catch(() => {});
      }

      // Don't dequeue (paused or immediate retry pending)
      this.onExecutionComplete?.(execution);
      return;
    }

    // FL retry exhaustion: mark as failed so tree/email show it clearly
    const isFlRetryExhausted = flWantsRetry && !flNeedsRetry;
    execution.status = isFlRetryExhausted ? 'failed' : exitCode === 0 ? 'completed' : 'failed';
    execution.completedAt = new Date().toISOString();
    execution.exitCode = exitCode;
    execution.process = null;
    execution.stdin = null;
    this.streamParser.clearRingBuffer(execution.id);

    const completionMessage = isFlRetryExhausted
      ? `[FL retries exhausted (${execution.chain.retryCount}/${MAX_FL_RETRIES}) — manual re-run needed]`
      : error
        ? `[Error] ${error}`
        : `[Completed with exit code ${exitCode}]`;
    const entry = {
      line: completionMessage,
      timestamp: execution.completedAt,
      level: exitCode === 0 && !isFlRetryExhausted ? 'info' : 'error',
    };
    this._pushLog(execution, entry);

    this.logStreamer?.broadcast(executionId, {
      type: 'status',
      executionId,
      status: execution.status,
      exitCode,
      error,
    });

    this._broadcastState(execution);

    // Chain: Register waiter for next step if chain-eligible (success + no handoff + not FL retry exhausted)
    // /run is the last chain step — no next command exists, so send email directly
    const chainContinues =
      execution.chain?.enabled &&
      exitCode === 0 &&
      execution.resultSubtype === 'success' &&
      !execution.promptTooLong &&
      !isFlRetryExhausted;
    const isLastChainStep = execution.command === 'run';

    // Detect FL incomplete termination: exit 0 + success subtype, but status didn't advance.
    // This happens when context/max_turns is exhausted mid-work (CLI reports success but FL didn't finish).
    if (chainContinues && !isLastChainStep && execution.command === 'fl') {
      const currentStatus = this.fileWatcher?.statusCache.get(execution.featureId);
      const expectedStatus = '[REVIEWED]';
      if (currentStatus && currentStatus !== expectedStatus && currentStatus !== '[BLOCKED]') {
        // FL completed but didn't change status — incomplete termination
        // Auto-retry FL as a new chain execution instead of registering a dead waiter
        const retryCount = (execution.chain.retryCount || 0) + 1;
        if (retryCount <= MAX_FL_RETRIES) {
          claudeLog.info(
            `[Chain] FL incomplete termination detected for F${execution.featureId}: status still ${currentStatus} (expected ${expectedStatus}). Auto-retrying FL (${retryCount}/${MAX_FL_RETRIES})`,
          );
          this._pushLog(execution, {
            line: `[Chain] FL completed without status change (${currentStatus}). Auto-retrying FL (${retryCount}/${MAX_FL_RETRIES})...`,
            timestamp: new Date().toISOString(),
            level: 'warning',
          });

          const updatedHistory = [
            ...(execution.chain?.history || []),
            { command: execution.command, result: 'incomplete' },
          ];

          setTimeout(() => {
            this.executeCommand(execution.featureId, 'fl', {
              chain: true,
              chainParentId: execution.chainParentId || execution.id,
              chainHistory: updatedHistory,
              retryCount,
            });
          }, RETRY_DELAY_MS);

          // Send chain-retry WS event
          this.logStreamer?.broadcastAll({
            type: 'chain-retry',
            featureId: execution.featureId,
            command: 'fl',
            retryType: 'incomplete',
            retryCount,
            maxRetries: MAX_FL_RETRIES,
            reason: `FL completed without status change (still ${currentStatus})`,
            timestamp: new Date().toISOString(),
          });

          // Skip waiter registration and email — retry will handle it
          this._dequeueNext();
          this.onExecutionComplete?.(execution);
          return;
        } else {
          claudeLog.warn(
            `[Chain] FL incomplete termination: retries exhausted (${retryCount}/${MAX_FL_RETRIES}) for F${execution.featureId}`,
          );
          this._pushLog(execution, {
            line: `[Chain] FL incomplete termination: retries exhausted — manual re-run needed`,
            timestamp: new Date().toISOString(),
            level: 'error',
          });
          // Fall through to email notification
        }
      }
    }

    if (chainContinues && !isLastChainStep) {
      this.chainExecutor.registerWaiter(execution);
    }

    if (!chainContinues || isLastChainStep) {
      // Chain complete (last step), chain stopped, or non-chain execution - send email
      const chainHistory = execution.chain?.history || [];
      const isContextRetryExhausted =
        execution.chain?.contextRetryCount >= MAX_RETRIES && isContextExhausted;
      const currentResult = execution.accountLimitHit
        ? 'account-limit'
        : isFlRetryExhausted
          ? 'retry-exhausted'
          : isContextRetryExhausted
            ? 'context-retry-exhausted'
            : exitCode === 0
              ? 'ok'
              : 'fail';
      const finalHistory = [...chainHistory, { command: execution.command, result: currentResult }];
      const featureInfo =
        execution.featureId && this.featureService
          ? this.featureService.getFeature(execution.featureId)
          : null;
      this.emailService
        ?.sendCompletionNotification(
          execution,
          execution.status,
          exitCode,
          execution.chain?.enabled ? finalHistory : undefined,
          featureInfo,
        )
        .catch(() => {});
    }

    // Refresh rate limit after command completion (fire-and-forget)
    if (this.rateLimitService) {
      this.rateLimitService.capture({ forceRefresh: true }).catch(() => {});
    }

    this._dequeueNext();

    // Notify listeners (e.g., auto-DR) that an execution finished
    this.onExecutionComplete?.(execution);
  }

  /**
   * Schedule a rate limit retry for the failed execution.
   * Strategy: (1) try immediate profile switch, (2) schedule timed retry.
   * @param {Object} execution - The failed execution
   * @returns {{ message: string }|null} Retry info, or null if no retry possible
   */
  _scheduleRateLimitRetry(execution) {
    if (this._rateLimitPaused) {
      // Another retry is already scheduled (concurrent execution hit 429)
      claudeLog.info(`[RateLimit] Retry already pending, skipping for ${execution.id}`);
      return { message: 'Another retry already pending.' };
    }

    const currentProfile = this.getCcsProfile();

    // Strategy 1: Find a safe profile and switch immediately
    const safeProfile = this.rateLimitService?.getSafeProfile(currentProfile);
    if (safeProfile) {
      this._switchProfile(safeProfile);
      execution.rateLimitSwitchedTo = safeProfile;

      claudeLog.info(
        `[RateLimit] Switched to ${safeProfile}, retrying F${execution.featureId} ${execution.command} immediately`,
      );

      setTimeout(() => {
        this._startRateLimitRetry(execution);
      }, RETRY_DELAY_MS);

      return {
        message: `Switching to profile ${safeProfile}, retrying in ${RETRY_DELAY_MS / 1000}s.`,
      };
    }

    // Strategy 2: Schedule timed retry based on earliest reset time
    const resetTime = this.rateLimitService?.getEarliestResetTime();
    if (!resetTime) {
      claudeLog.warn(`[RateLimit] No safe profile and no reset time known. Cannot retry.`);
      return null;
    }

    const retryAt = resetTime + RATE_LIMIT_RETRY_BUFFER_MS;
    const delayMs = Math.max(retryAt - Date.now(), RETRY_DELAY_MS); // At least RETRY_DELAY_MS

    this._rateLimitPaused = true;
    this._rateLimitRetryInfo = { execution, retryAt };
    execution.rateLimitRetryAt = retryAt;

    this._rateLimitRetryTimer = setTimeout(() => {
      this._rateLimitRetryTimer = null;
      this._executeRateLimitRetry(execution);
    }, delayMs);

    const retryAtStr = new Date(retryAt).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit',
    });
    claudeLog.info(
      `[RateLimit] Retry scheduled at ${retryAtStr} (${Math.round(delayMs / 60000)}min) for F${execution.featureId} ${execution.command}`,
    );

    this.logStreamer?.broadcastAll({
      type: 'rate-limit-waiting',
      featureId: execution.featureId,
      command: execution.command,
      retryAt: new Date(retryAt).toISOString(),
      delayMs,
      timestamp: new Date().toISOString(),
    });

    return { message: `Retry scheduled at ${retryAtStr} (${Math.round(delayMs / 60000)}min).` };
  }

  /**
   * Execute the scheduled rate limit retry.
   * Re-captures rate limits, checks if safe, retries or gives up.
   * @param {Object} execution - The original failed execution
   */
  async _executeRateLimitRetry(execution) {
    claudeLog.info(
      `[RateLimit] Executing scheduled retry for F${execution.featureId} ${execution.command}`,
    );

    // Re-capture to get fresh data
    try {
      await this.rateLimitService?.capture({ forceRefresh: true });
    } catch (err) {
      claudeLog.error(`[RateLimit] Re-capture failed: ${err.message}`);
    }

    // Check if any profile is safe
    const currentProfile = this.getCcsProfile();
    const safeProfile = this.rateLimitService?.getSafeProfile(null); // Don't exclude any

    if (safeProfile && safeProfile !== currentProfile) {
      this._switchProfile(safeProfile);
      claudeLog.info(`[RateLimit] Switched to ${safeProfile} for retry`);
    }

    // Verify the active profile is below threshold
    const cached = this.rateLimitService?.getCached();
    const activeProfile = this.getCcsProfile();
    const activeData = cached?.[activeProfile];
    const maxPercent = activeData
      ? Math.max(activeData.weekly?.percent || 0, activeData.session?.percent || 0)
      : 100; // Assume worst case if no data

    if (maxPercent >= RATE_LIMIT_SAFE_THRESHOLD) {
      // Still limited, give up
      claudeLog.warn(`[RateLimit] Still at ${maxPercent}% after scheduled retry. Giving up.`);
      this._rateLimitPaused = false;
      this._rateLimitRetryInfo = null;

      this._pushLog(execution, {
        line: `[Chain] Rate limit retry failed — still at ${maxPercent}%. Manual re-run needed.`,
        timestamp: new Date().toISOString(),
        level: 'error',
      });

      this.logStreamer?.broadcastAll({
        type: 'rate-limit-exhausted',
        featureId: execution.featureId,
        command: execution.command,
        percent: maxPercent,
        timestamp: new Date().toISOString(),
      });

      const featureInfo =
        execution.featureId && this.featureService
          ? this.featureService.getFeature(execution.featureId)
          : null;
      this.emailService
        ?.sendRateLimitExhaustedNotification(
          execution,
          `Still at ${maxPercent}% after scheduled retry`,
          featureInfo,
        )
        .catch(() => {});

      this._dequeueNext();
      return;
    }

    // Safe to retry
    this._startRateLimitRetry(execution);
  }

  /**
   * Start a new execution as a rate limit retry.
   * @param {Object} execution - The original failed execution
   */
  _startRateLimitRetry(execution) {
    this._rateLimitPaused = false;
    this._rateLimitRetryInfo = null;

    const updatedHistory = [
      ...(execution.chain?.history || []),
      { command: execution.command, result: 'rate-limit-retry' },
    ];

    let newExecId;
    let resumed = false;

    if (execution.sessionId) {
      // Resume the existing session to preserve conversation context
      const newExec = this._createExecution({
        featureId: execution.featureId,
        command: execution.command,
        chain: true,
        chainParentId: execution.chainParentId || execution.id,
        retryCount: execution.chain?.retryCount || 0,
        contextRetryCount: execution.chain?.contextRetryCount || 0,
        chainHistory: updatedHistory,
      });

      // Override defaults for active resume
      newExec.status = 'running';
      newExec.startedAt = new Date().toISOString();
      newExec.lastOutputTime = Date.now();
      newExec.sessionId = execution.sessionId;
      newExec.debugLogPath = path.join(this.tmpDir, `debug-${newExec.id}.log`);
      newExec.logs = [
        {
          line: `Resuming session ${execution.sessionId} after rate limit...`,
          timestamp: new Date().toISOString(),
          level: 'info',
        },
      ];

      this.executions.set(newExec.id, newExec);

      const claudePath = process.env.CLAUDE_PATH || 'claude';
      const args = [
        '-p',
        'continue',
        '--resume',
        execution.sessionId,
        '--verbose',
        '--debug-file',
        newExec.debugLogPath,
        '--output-format',
        'stream-json',
      ];

      const proc = spawn(claudePath, args, {
        cwd: this.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        env: this._buildClaudeEnv(newExec),
      });

      newExec.process = proc;

      this._attachStdoutHandler(newExec, proc);
      this._attachStderrHandler(newExec, proc);

      proc.on('error', (err) => {
        this._handleCompletion(newExec, 1, err.message);
      });

      proc.on('close', (code) => {
        if (newExec.status === 'running') {
          this._handleCompletion(newExec, code ?? 1);
        } else if (newExec.status === 'handed-off') {
          if (newExec.stallCheckInterval) {
            clearInterval(newExec.stallCheckInterval);
            newExec.stallCheckInterval = null;
          }
          newExec.process = null;
          this._dequeueNext();
        }
      });

      newExec.stallCheckInterval = setInterval(() => {
        this._checkStall(newExec);
      }, STALL_CHECK_INTERVAL_MS);

      this._broadcastState(newExec);

      if (this.rateLimitService) {
        this.rateLimitService.recomputeRefreshTimes();
        this.rateLimitService.capture().catch(() => {});
      }

      newExecId = newExec.id;
      resumed = true;

      claudeLog.info(
        `[RateLimit] Retry started (resumed session): ${newExec.id} (replacing ${execution.id})`,
      );
    } else {
      newExecId = this.executeCommand(execution.featureId, execution.command, {
        chain: true,
        chainParentId: execution.chainParentId || execution.id,
        retryCount: execution.chain?.retryCount || 0,
        contextRetryCount: execution.chain?.contextRetryCount || 0,
        chainHistory: updatedHistory,
      });

      claudeLog.info(`[RateLimit] Retry started: ${newExecId} (replacing ${execution.id})`);
    }

    this.logStreamer?.broadcastAll({
      type: 'rate-limit-retry',
      featureId: execution.featureId,
      command: execution.command,
      oldExecutionId: execution.id,
      newExecutionId: newExecId,
      resumed,
      timestamp: new Date().toISOString(),
    });

    const featureInfo =
      execution.featureId && this.featureService
        ? this.featureService.getFeature(execution.featureId)
        : null;
    this.emailService?.sendRateLimitRecoveredNotification(execution, featureInfo).catch(() => {});
  }

  /**
   * Switch CCS profile to the specified target.
   * @param {string} targetProfile - Profile name to switch to
   */
  _switchProfile(targetProfile) {
    const profiles = getCcsProfiles();
    if (!profiles.includes(targetProfile)) {
      claudeLog.error(`[RateLimit] Unknown profile: ${targetProfile}`);
      return;
    }

    // Check lock file to avoid conflict with terminal Stop hook
    const lockFile = path.join(this.projectRoot, '_out', 'tmp', 'dashboard', 'cs-switch.lock');
    try {
      if (existsSync(lockFile)) {
        const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
        if (lock.expiresAt > Date.now() && lock.lockedBy !== 'dashboard') {
          claudeLog.info(
            `[RateLimit] Switch locked by ${lock.lockedBy} (profile: ${lock.profile}), backing off`,
          );
          return;
        }
      }
    } catch {
      // Lock file unreadable, proceed with switch
    }

    // Write dashboard lock
    try {
      writeFileSync(
        lockFile,
        JSON.stringify({
          lockedBy: 'dashboard',
          profile: targetProfile,
          sessionId: null,
          timestamp: Date.now(),
          expiresAt: Date.now() + 60000,
        }),
      );
    } catch {
      // Non-critical: lock write failure doesn't block switch
    }

    try {
      execSync(`ccs auth default "${targetProfile}"`, {
        timeout: 5000,
        encoding: 'utf8',
        windowsHide: true,
        shell: true,
      });
      claudeLog.info(`[RateLimit] Profile switched to ${targetProfile}`);
    } catch (err) {
      claudeLog.error(`[RateLimit] Failed to switch profile: ${err.message}`);
    }
  }

  /**
   * Public method to switch CCS profile to the specified target.
   * Validates the profile, calls ccs auth default, broadcasts shell-complete, and sets shell state.
   * @param {string} targetProfile - Profile name to switch to
   * @returns {{ command: string, profile: string, status: string }}
   */
  switchProfile(targetProfile) {
    const profiles = getCcsProfiles();
    if (!profiles.includes(targetProfile)) {
      throw new Error(`Unknown profile: ${targetProfile}. Available: ${profiles.join(', ')}`);
    }
    this._switchProfile(targetProfile);
    this.logStreamer?.broadcastAll({
      type: 'shell-complete',
      command: 'cs',
      success: true,
      timestamp: new Date().toISOString(),
    });
    this._setShellState('cs', true);
    return { command: 'cs', profile: targetProfile, status: 'ok' };
  }

  // =============================================================================
  // Chain Execution (fc → fl → run auto-progression)
  // Delegated to ChainExecutor module - see chainExecutor.js for implementation
  // =============================================================================

  /**
   * Called by FileWatcher when a feature's status changes
   * Delegates to ChainExecutor for chain progression handling
   * @param {string} featureId - Feature that changed
   * @param {string} oldStatus - Previous status
   * @param {string} newStatus - New status
   */
  handleFeatureStatusChanged(featureId, oldStatus, newStatus) {
    this.chainExecutor.handleStatusChanged(featureId, oldStatus, newStatus);
  }

  _dequeueNext() {
    if (this._rateLimitPaused) {
      claudeLog.info('[Queue] Dequeue blocked — rate limit retry pending');
      return;
    }
    while (this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
      const nextId = this.queue.shift();
      const nextExec = this.executions.get(nextId);
      if (nextExec && nextExec.status === 'queued') {
        this._pushLog(nextExec, {
          line: 'Dequeued. Starting execution...',
          timestamp: new Date().toISOString(),
          level: 'info',
        });
        this._startExecution(nextExec);
      }
    }
    this._broadcastQueueUpdate();
  }

  _broadcastQueueUpdate() {
    this.logStreamer?.broadcastAll({
      type: 'queue-updated',
      ...this.getQueueStatus(),
      timestamp: new Date().toISOString(),
    });
  }

  getQueueStatus() {
    const running = [];
    const queued = [];
    for (const exec of this.executions.values()) {
      if (exec.status === 'running') {
        running.push({
          id: exec.id,
          featureId: exec.featureId,
          command: exec.command,
          phase: exec.currentPhase,
          phaseName: exec.currentPhaseName,
        });
      }
    }
    for (const qId of this.queue) {
      const exec = this.executions.get(qId);
      if (exec) {
        queued.push({ id: exec.id, featureId: exec.featureId, command: exec.command });
      }
    }
    return {
      maxConcurrent: this.maxConcurrent,
      runningCount: running.length,
      queuedCount: queued.length,
      chainWaiterCount: this.chainExecutor.chainWaiters.size,
      running,
      queued,
      rateLimitWaiting: this._rateLimitRetryInfo
        ? {
            featureId: this._rateLimitRetryInfo.execution.featureId,
            command: this._rateLimitRetryInfo.execution.command,
            retryAt: this._rateLimitRetryInfo.retryAt
              ? new Date(this._rateLimitRetryInfo.retryAt).toISOString()
              : null,
          }
        : null,
    };
  }

  clearQueue() {
    const cleared = [];
    while (this.queue.length > 0) {
      const id = this.queue.shift();
      const exec = this.executions.get(id);
      if (exec) {
        exec.status = 'cancelled';
        exec.completedAt = new Date().toISOString();
        cleared.push(id);
        this.logStreamer?.broadcast(id, {
          type: 'status',
          executionId: id,
          status: 'cancelled',
        });
      }
    }
    this._broadcastQueueUpdate();
    return cleared;
  }

  getExecution(executionId) {
    const exec = this.executions.get(executionId);
    if (!exec) return null;
    const canResume = exec.sessionId && ['failed', 'completed', 'handed-off'].includes(exec.status);
    return {
      id: exec.id,
      featureId: exec.featureId,
      command: exec.command,
      status: exec.status,
      startedAt: exec.startedAt,
      completedAt: exec.completedAt,
      exitCode: exec.exitCode,
      logCount: exec.logs.length,
      phase: exec.currentPhase,
      phaseName: exec.currentPhaseName,
      totalPhases: getTotalPhases(exec.command),
      debugLogPath: exec.debugLogPath,
      sessionId: exec.sessionId,
      canResume,
      lastOutputTime: exec.lastOutputTime,
      waitingForInput: exec.waitingForInput,
      waitingInputPattern: exec.waitingInputPattern,
      isStalled: exec.isStalled || false,
      taskDepth: exec.taskDepth || 0,
      resultSubtype: exec.resultSubtype,
      promptTooLong: exec.promptTooLong || false,
      accountLimitHit: exec.accountLimitHit || false,
      rateLimitRetryAt: exec.rateLimitRetryAt || null,
      rateLimitSwitchedTo: exec.rateLimitSwitchedTo || null,
      contextPercent: exec.contextPercent,
      tokenUsage: exec.tokenUsage,
      chain: exec.chain
        ? {
            enabled: exec.chain.enabled,
            retryCount: exec.chain.retryCount,
            contextRetryCount: exec.chain.contextRetryCount,
            history: exec.chain.history,
          }
        : null,
      chainParentId: exec.chainParentId,
      inputRequired: exec.inputRequired
        ? {
            questions: exec.inputRequired.questions,
            context: exec.inputContext,
          }
        : null,
    };
  }

  getExecutionLogs(executionId, offset = 0) {
    const exec = this.executions.get(executionId);
    if (!exec) return null;
    return exec.logs.slice(offset);
  }

  killExecution(executionId) {
    const exec = this.executions.get(executionId);
    if (!exec) return false;

    // Remove chain waiter if this execution was waiting for status change
    if (exec.featureId) {
      const waiter = this.chainExecutor.getWaiter(exec.featureId);
      if (waiter?.executionId === executionId) {
        this.chainExecutor.deleteWaiter(exec.featureId);
        claudeLog.info(`[Chain] Removed chain waiter for F${exec.featureId} (killed)`);
      }
    }

    // Clear rate limit retry if this execution was waiting for retry
    if (this._rateLimitRetryInfo?.execution?.id === executionId) {
      if (this._rateLimitRetryTimer) {
        clearTimeout(this._rateLimitRetryTimer);
        this._rateLimitRetryTimer = null;
      }
      this._rateLimitPaused = false;
      this._rateLimitRetryInfo = null;
      claudeLog.info(`[RateLimit] Cleared rate limit retry for killed execution ${executionId}`);
    }

    if (exec.status === 'queued') {
      this.queue = this.queue.filter((id) => id !== executionId);
      exec.status = 'cancelled';
      exec.completedAt = new Date().toISOString();
      this.logStreamer?.broadcast(executionId, {
        type: 'status',
        executionId,
        status: 'cancelled',
      });
      this._broadcastQueueUpdate();
      return true;
    }

    if (exec.status === 'running' && exec.process) {
      exec.killedByUser = true;
      this._killProcess(exec.process);
      return true;
    }

    return false;
  }

  /** Kill all running executions (for graceful shutdown) */
  killAllRunning() {
    for (const [id, exec] of this.executions) {
      if (exec.status === 'running' && exec.process) {
        claudeLog.info(`[ClaudeService] Killing execution ${id} (shutdown)`);
        // Mark as cancelled before kill to prevent _handleCompletion from
        // triggering chain retries or terminal handoffs during shutdown
        exec.killedByUser = true;
        exec.status = 'cancelled';
        if (exec.stallCheckInterval) {
          clearInterval(exec.stallCheckInterval);
          exec.stallCheckInterval = null;
        }
        this._killProcess(exec.process);
      }
    }
    // Clean up rate limit retry state
    if (this._rateLimitRetryTimer) {
      clearTimeout(this._rateLimitRetryTimer);
      this._rateLimitRetryTimer = null;
    }
    this._rateLimitPaused = false;
    this._rateLimitRetryInfo = null;

    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
  }

  /** Kill a child process (Windows-compatible)
   * @param {import('child_process').ChildProcess|null} proc - The process to kill
   */
  _killProcess(proc) {
    if (!proc || !proc.pid) {
      claudeLog.warn('[ClaudeService] _killProcess called with invalid process or missing PID');
      return;
    }
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        proc.kill('SIGTERM');
      }
    } catch (err) {
      claudeLog.error(`[ClaudeService] Failed to kill process PID=${proc.pid}: ${err.message}`);
    }
  }

  /** Build environment prefix for terminal commands (cmd /k) */
  _buildTerminalEnvPrefix() {
    const parts = [];
    if (PROXY_ENABLED) {
      parts.push(`set "HTTPS_PROXY=${PROXY_URL}"`);
      parts.push(`set "HTTP_PROXY=${PROXY_URL}"`);
    }
    // CCS profile integration
    const profile = this.getCcsProfile();
    if (profile) {
      parts.push(`set "CLAUDE_CONFIG_DIR=${path.join(CCS_INSTANCES_DIR, profile)}"`);
    }
    return parts.length > 0 ? parts.join(' && ') + ' && ' : '';
  }

  /** Open an interactive claude terminal tab (no -p, no log capture) */
  openTerminal(featureId, command) {
    // Validate inputs
    const validatedFeatureId = validateFeatureId(featureId);
    const validatedCommand = validateCommand(command);
    const tabTitle = `${validatedCommand.toUpperCase()} F${validatedFeatureId}`;
    const cliPrompt = `/${validatedCommand} ${validatedFeatureId}`;

    claudeLog.info(
      `[ClaudeService] Opening terminal: ${tabTitle} (CCS profile: ${this.getCcsProfile() || 'default'})`,
    );

    // Use WT profile with proxy/CCS env for consistent look & config
    const envPrefix = this._buildTerminalEnvPrefix();
    const wtArgs = ['-w', '0', 'new-tab'];
    if (PROXY_ENABLED) {
      wtArgs.push('-p', 'Claude Code era');
    }
    wtArgs.push(
      '--title',
      tabTitle,
      '-d',
      this.projectRoot,
      '--',
      'cmd',
      '/k',
      `${envPrefix}claude "${cliPrompt}"`,
    );

    const proc = spawn('wt.exe', wtArgs, {
      cwd: this.projectRoot,
      stdio: 'ignore',
      detached: true,
      env: this._buildClaudeEnv({ terminal: true }),
    });
    proc.unref();

    return { tabTitle, command: cliPrompt };
  }

  /** Resume a stopped/failed execution in browser (with log capture) */
  resumeInBrowser(executionId, prompt = 'continue') {
    const oldExec = this.executions.get(executionId);
    // Fallback to persistent session map when execution evicted from memory (TTL)
    if (!oldExec || !oldExec.sessionId) {
      const persisted = this._lookupSessionId(executionId);
      if (!persisted) {
        return { error: 'No session ID available for resume' };
      }
      // Reconstruct minimal exec info from persisted data
      const sessionId = persisted.sessionId;
      const featureId = persisted.featureId;
      const command = persisted.command;
      claudeLog.info(
        `[ClaudeService] Resuming from persisted session map: ${sessionId} (exec ${executionId} was evicted)`,
      );
      return this._resumeInBrowserWithSession(sessionId, featureId, command, prompt);
    }

    return this._resumeInBrowserWithSession(
      oldExec.sessionId,
      oldExec.featureId,
      oldExec.command,
      prompt,
      oldExec,
    );
  }

  /** Internal: spawn a resume session in browser mode */
  _resumeInBrowserWithSession(sessionId, featureId, command, prompt, oldExec = null) {
    const execution = this._createExecution({
      featureId,
      command: `resume:${command}`,
    });
    // Override defaults for active resume
    execution.status = 'running';
    execution.startedAt = new Date().toISOString();
    execution.lastOutputTime = Date.now();
    execution.sessionId = sessionId;
    execution.currentPhase = oldExec?.currentPhase || null;
    execution.currentPhaseName = oldExec?.currentPhaseName || null;
    execution.logs = [
      {
        line: `Resuming session ${sessionId}...`,
        timestamp: new Date().toISOString(),
        level: 'info',
      },
    ];
    execution.debugLogPath = path.join(this.tmpDir, `debug-${execution.id}.log`);

    this.executions.set(execution.id, execution);

    const claudePath = process.env.CLAUDE_PATH || 'claude';
    const args = [
      '-p',
      prompt,
      '--resume',
      sessionId,
      '--verbose',
      '--debug-file',
      execution.debugLogPath,
      '--output-format',
      'stream-json',
    ];

    claudeLog.info(
      `[ClaudeService] Resuming session: ${sessionId} (CCS profile: ${this.getCcsProfile() || 'default'})`,
    );
    debugLog(`[ClaudeService] spawn args:`, [claudePath, ...args].join(' '));

    const proc = spawn(claudePath, args, {
      cwd: this.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: this._buildClaudeEnv(execution),
    });

    execution.process = proc;

    this._attachStdoutHandler(execution, proc);
    this._attachStderrHandler(execution, proc);

    proc.on('error', (err) => {
      this._handleCompletion(execution, 1, err.message);
    });

    proc.on('close', (code) => {
      if (execution.status === 'running') {
        this._handleCompletion(execution, code ?? 1);
      } else if (execution.status === 'handed-off') {
        if (execution.stallCheckInterval) {
          clearInterval(execution.stallCheckInterval);
          execution.stallCheckInterval = null;
        }
        execution.process = null;
        this._dequeueNext();
      }
    });

    execution.stallCheckInterval = setInterval(() => {
      this._checkStall(execution);
    }, STALL_CHECK_INTERVAL_MS);

    this._broadcastState(execution);

    return { executionId: execution.id, sessionId };
  }

  /** Resume a stopped/failed execution in terminal (interactive) */
  resumeInTerminal(executionId) {
    const exec = this.executions.get(executionId);
    // Fallback to persistent session map when execution evicted from memory (TTL)
    if (!exec || !exec.sessionId) {
      const persisted = this._lookupSessionId(executionId);
      if (!persisted) {
        return { error: 'No session ID available for resume' };
      }
      claudeLog.info(
        `[ClaudeService] Terminal resume from persisted session map: ${persisted.sessionId}`,
      );
      return this._resumeInTerminalWithSession(persisted.sessionId, persisted.featureId);
    }

    return this._resumeInTerminalWithSession(exec.sessionId, exec.featureId, exec);
  }

  /** Internal: open terminal for resume */
  _resumeInTerminalWithSession(sessionId, featureId, exec = null) {
    const tabTitle = `RESUME F${featureId}`;

    claudeLog.info(
      `[ClaudeService] Opening terminal for resume: ${sessionId} (CCS profile: ${this.getCcsProfile() || 'default'})`,
    );

    // Write AskUserQuestion context to temp file for terminal display
    const contextPrefix = exec ? this._writeResumeContext(exec) : '';

    const envPrefix = this._buildTerminalEnvPrefix();
    const wtArgs = ['-w', '0', 'new-tab'];
    if (PROXY_ENABLED) {
      wtArgs.push('-p', 'Claude Code era');
    }
    wtArgs.push(
      '--title',
      tabTitle,
      '-d',
      this.projectRoot,
      '--',
      'cmd',
      '/k',
      `${contextPrefix}${envPrefix}claude --resume ${sessionId}`,
    );

    const proc = spawn('wt.exe', wtArgs, {
      cwd: this.projectRoot,
      stdio: 'ignore',
      detached: true,
      env: this._buildClaudeEnv({ terminal: true }),
    });
    proc.unref();

    return { tabTitle, sessionId };
  }

  /**
   * Write resume context file for AskUserQuestion handoffs.
   * Returns cmd prefix string to display context before claude --resume.
   * @param {Object} exec - Execution object
   * @returns {string} cmd prefix (empty string if no context)
   */
  _writeResumeContext(exec) {
    const questions = exec.inputRequired?.questions;
    if (!questions || questions.length === 0) return '';

    const lines = ['=== Previous session asked ===', ''];
    for (const q of questions) {
      lines.push(`Q: ${q.question}`);
      if (q.options) {
        q.options.forEach((opt, i) => {
          lines.push(`  ${i + 1}) ${opt.label}${opt.description ? ` - ${opt.description}` : ''}`);
        });
      }
      lines.push('');
    }
    lines.push('==============================', '');

    try {
      const contextDir = path.join(this.projectRoot, '_out', 'tmp');
      mkdirSync(contextDir, { recursive: true });
      const contextFile = path.join(contextDir, 'resume-context.txt');
      writeFileSync(contextFile, lines.join('\r\n'));
      claudeLog.info(`[ClaudeService] Resume context written to ${contextFile}`);
      return `type "${contextFile}" && echo. && `;
    } catch (err) {
      claudeLog.error(`[ClaudeService] Failed to write resume context: ${err.message}`);
      return '';
    }
  }

  listExecutions() {
    return Array.from(this.executions.values()).map((e) => ({
      id: e.id,
      featureId: e.featureId,
      command: e.command,
      status: e.status,
      startedAt: e.startedAt,
      completedAt: e.completedAt,
      phase: e.currentPhase,
      phaseName: e.currentPhaseName,
      totalPhases: getTotalPhases(e.command),
      iteration: e.currentIteration,
      sessionId: e.sessionId, // Needed for Resume button
      resultSubtype: e.resultSubtype,
      contextPercent: e.contextPercent, // Context window usage
      tokenUsage: e.tokenUsage,
      taskDepth: e.taskDepth || 0,
    }));
  }

  /** Run a shell command (cs, dr, upd) */
  runShellCommand(command) {
    // Validate: only allow 'cs', 'dr', and 'upd'
    const allowed = ['cs', 'dr', 'upd'];
    if (!allowed.includes(command)) {
      throw new Error(`Invalid shell command: ${command}`);
    }

    claudeLog.info(`[ClaudeService] Running shell command: ${command}`);

    if (command === 'dr') {
      // Special handling: 'dr' restarts the dashboard via pm2.
      // Broadcast shell-complete and persist state BEFORE restart,
      // because pm2 restart all kills this process — the close callback never fires.
      this.logStreamer?.broadcastAll({
        type: 'shell-complete',
        command,
        success: true,
        timestamp: new Date().toISOString(),
      });
      this._setShellState(command, true);
      // Small delay to let WS message reach clients before we die
      setTimeout(() => {
        spawn('pm2', ['restart', 'all'], {
          cwd: this.projectRoot,
          stdio: 'ignore',
          shell: true,
          windowsHide: true,
        }).unref();
      }, 500);
    } else if (command === 'upd') {
      // Special handling: 'upd' updates CCS itself with version tracking
      const oldVersion = this._getCcsVersion();
      const proc = spawn('npm', ['update', '-g', '@kaitranntt/ccs'], {
        cwd: this.projectRoot,
        stdio: 'ignore',
        shell: true,
        windowsHide: true,
      });
      proc.on('close', (code) => {
        const newVersion = this._getCcsVersion();
        claudeLog.info(`[ClaudeService] Update complete: ${oldVersion} → ${newVersion}`);
        this.logStreamer?.broadcastAll({
          type: 'upd-complete',
          oldVersion,
          newVersion,
          timestamp: new Date().toISOString(),
        });
        this.logStreamer?.broadcastAll({
          type: 'shell-complete',
          command,
          success: code === 0,
          timestamp: new Date().toISOString(),
        });
        this._setShellState(command, code === 0);
      });
    } else {
      const proc = spawn('cmd', ['/c', command], {
        cwd: this.projectRoot,
        stdio: 'ignore',
        windowsHide: true,
      });
      proc.on('close', (code) => {
        this.logStreamer?.broadcastAll({
          type: 'shell-complete',
          command,
          success: code === 0,
          timestamp: new Date().toISOString(),
        });
        this._setShellState(command, code === 0);
      });
      proc.unref();
    }

    return { command, status: 'launched' };
  }

  getShellStates() {
    const now = Date.now();
    const result = {};
    for (const [cmd, state] of this.shellStates) {
      if (now - new Date(state.timestamp).getTime() < SHELL_STATE_TTL_MS) {
        result[cmd] = state;
      }
    }
    return result;
  }

  /** Execute slash command via -p mode (no featureId) */
  executeSlashCommand(slashCommand) {
    // Validate: only allow specific slash commands
    const allowed = ['commit', 'sync-deps'];
    if (!allowed.includes(slashCommand)) {
      throw new Error(
        `Invalid slash command: ${slashCommand}. Must be one of: ${allowed.join(', ')}`,
      );
    }

    const execution = this._createExecution({ command: slashCommand });
    const executionId = execution.id;

    this.executions.set(executionId, execution);

    // Refresh rate limit on command start (fire-and-forget)
    if (this.rateLimitService) {
      this.rateLimitService.capture().catch(() => {});
    }

    if (this.runningCount < this.maxConcurrent) {
      this._startExecution(execution);
    } else {
      this.queue.push(executionId);
      this._pushLog(execution, {
        line: `Queued (position ${this.queue.length}). Waiting for slot...`,
        timestamp: new Date().toISOString(),
        level: 'info',
      });
      this._broadcastQueueUpdate();
    }

    return executionId;
  }

  /** Clean up resources (clear intervals) */
  dispose() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }
}
