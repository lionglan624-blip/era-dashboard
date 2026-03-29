/**
 * ResumeManager — Extracted resume/session logic from ClaudeService.
 *
 * Handles session persistence (load/save/lookup), browser resume,
 * terminal resume, remote control resume, and promo auto-answer scheduling.
 *
 * Uses DI pattern (same as RetryManager): constructor receives deps object
 * with callbacks to ClaudeService methods.
 */

import { spawn, fork } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { claudeLog } from '../utils/logger.js';
import { nowJSTISO } from '../utils/timeUtils.js';
import {
  STALL_CHECK_INTERVAL_MS,
  PROXY_ENABLED,
  CCS_INSTANCES_DIR,
  REMOTE_CONTROL_PROFILE,
  REMOTE_URL_TIMEOUT_MS,
  REMOTE_CONTROL_TIMEOUT_MS,
} from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Verbose debug logging (enable with DASHBOARD_DEBUG=1)
const DEBUG = process.env.DASHBOARD_DEBUG === '1';
const debugLog = DEBUG ? claudeLog.info.bind(claudeLog) : () => {};

export class ResumeManager {
  /**
   * @param {Object} deps - Dependency injection
   * @param {string} deps.tmpDir - Temp directory path
   * @param {string} deps.projectRoot - Project root path
   * @param {Function} deps.createExecution - (opts) => execution object
   * @param {Map} deps.executions - Shared executions Map reference
   * @param {Function} deps.buildClaudeEnv - (exec) => env object
   * @param {Function} deps.buildTerminalEnvPrefix - () => string
   * @param {Function} deps.attachStdoutHandler - (exec, proc) => void
   * @param {Function} deps.attachStderrHandler - (exec, proc) => void
   * @param {Function} deps.handleCompletion - (exec, exitCode, error?) => void
   * @param {Function} deps.checkStall - (exec) => void
   * @param {Function} deps.pushLog - (exec, entry) => void
   * @param {Function} deps.broadcastState - (exec) => void
   * @param {Function} deps.broadcastAll - (msg) => void
   * @param {Function} deps.broadcast - (execId, msg) => void
   * @param {Function} deps.dequeueNext - () => void
   * @param {Function} deps.killProcess - (proc) => void
   * @param {Function} deps.getCcsProfile - () => string
   * @param {Object} deps.streamParser - StreamParser instance
   * @param {Function} deps.getStallCheckIntervalMs - () => number
   * @param {Function} deps.releaseChainSlot - (exec) => void
   */
  constructor(deps) {
    this.deps = deps;
    this._sessionMapPath = path.join(deps.tmpDir, 'sessions.json');
    this._sessionMap = this._loadSessionMap();

    // Lazily-set services
    this.emailService = null;
  }

  // --- Session persistence ---

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
  saveSessionId(executionId, sessionId, featureId, command) {
    this._sessionMap[executionId] = {
      sessionId,
      featureId,
      command,
      savedAt: nowJSTISO(),
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
  lookupSessionId(executionId) {
    return this._sessionMap[executionId] || null;
  }

  // --- Resume operations ---

  /** Resume a stopped/failed execution in browser (with log capture) */
  resumeInBrowser(executionId, prompt = 'continue') {
    const oldExec = this.deps.executions.get(executionId);
    // Fallback to persistent session map when execution evicted from memory (TTL)
    if (!oldExec || !oldExec.sessionId) {
      const persisted = this.lookupSessionId(executionId);
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

  /**
   * Answer a pending input prompt in browser mode (instead of terminal handoff).
   * Schedule auto-answer during promo (temporary — remove after 2026-03-28).
   * @param {Object} execution - Execution object
   * @param {string} answer - Answer to send
   * @param {string} reason - Reason for logging
   * @param {number} [delayMs=2000] - Delay before auto-answering
   */
  schedulePromoAutoAnswer(execution, answer, reason, delayMs = 2000, { isRetry = false } = {}) {
    if (execution._promoAutoAnswerTimeout) clearTimeout(execution._promoAutoAnswerTimeout);
    execution._promoAutoAnswerTimeout = setTimeout(() => {
      execution._promoAutoAnswerTimeout = null;
      if (execution.waitingForInput || execution.inputRequired) {
        claudeLog.info(
          `[ClaudeService] Promo auto-answer: ${reason}, answer="${answer}" (exec ${execution.id})`,
        );
        this.answerInBrowser(execution.id, answer, { isRetry });
      }
    }, delayMs);
  }

  /**
   * Cancels any pending handoff, kills current process, and resumes with user's answer.
   * @param {string} executionId - Execution waiting for input
   * @param {string} answer - User's answer (e.g., 'y', 'n', or selected option text)
   * @returns {{ executionId: string, sessionId: string } | { error: string }}
   */
  answerInBrowser(executionId, answer, { isRetry = false } = {}) {
    const execution = this.deps.executions.get(executionId);
    if (!execution) {
      return { error: 'Execution not found' };
    }
    if (!execution.sessionId) {
      return { error: 'No session ID available' };
    }
    // Allow answering if execution was waiting for input (even if process already completed)
    if (!execution.waitingForInput && !execution.inputRequired) {
      return { error: 'Execution is not waiting for input' };
    }

    claudeLog.info(
      `[ClaudeService] Answering in browser: exec=${executionId}, status=${execution.status}, answer="${answer.substring(0, 100)}"`,
    );

    // Cancel pending handoff if still active
    if (execution.pendingHandoffTimeout) {
      clearTimeout(execution.pendingHandoffTimeout);
      execution.pendingHandoffTimeout = null;
    }
    // Cancel promo auto-answer if user answered manually
    if (execution._promoAutoAnswerTimeout) {
      clearTimeout(execution._promoAutoAnswerTimeout);
      execution._promoAutoAnswerTimeout = null;
    }
    execution.pendingHandoff = null;

    // Cancel pending input email (user answered in time)
    if (execution._pendingInputEmailTimeout) {
      clearTimeout(execution._pendingInputEmailTimeout);
      execution._pendingInputEmailTimeout = null;
    }

    // Persist sessionId
    this.saveSessionId(execution.id, execution.sessionId, execution.featureId, execution.command);

    // Save input state for potential retry BEFORE clearing
    execution._lastInputRequired = execution.inputRequired
      ? structuredClone(execution.inputRequired)
      : null;
    execution._lastWaitingForInput = execution.waitingForInput;
    execution._lastWaitingInputPattern = execution.waitingInputPattern;
    execution._lastWaitingAnswer = answer;
    if (!isRetry) {
      execution._resumeFailCount = 0;
    }

    // Clear input state
    execution.waitingForInput = false;
    execution.waitingInputPattern = null;
    execution.inputRequired = null;
    execution.inputContext = null;
    execution._killedForAskUser = false;

    // Notify FE to clear input panels (especially for auto-answer where FE didn't initiate)
    this.deps.broadcastState(execution);

    // Kill the current process if still running
    if (execution.process && execution.status === 'running') {
      this.deps.killProcess(execution.process);
    }
    if (execution.stallCheckInterval) {
      clearInterval(execution.stallCheckInterval);
      execution.stallCheckInterval = null;
    }

    const entry = {
      line: `[Answer] User answered in browser: "${answer.substring(0, 100)}" — resuming session...`,
      timestamp: nowJSTISO(),
      level: 'info',
    };
    this.deps.pushLog(execution, entry);
    this.deps.broadcast(execution.id, {
      type: 'log',
      executionId: execution.id,
      ...entry,
    });

    // Resume within the same execution (reuse tab, preserve log history)
    const sessionId = execution.sessionId;
    execution.status = 'running';
    execution.completedAt = null;
    execution.resultSubtype = null;
    execution.resultExitCode = null;
    execution.lastAssistantText = null;
    execution.lastOutputTime = Date.now();
    // Input state already saved and cleared above (before the clear block).
    // Mark as resumed-answer: allows chain waiter registration on completion
    // (input-wait exit skips registration; _resumedAnswer re-enables it).
    execution._resumedAnswer = true;
    execution.debugLogPath = path.join(this.deps.tmpDir, `debug-${execution.id}-resume.log`);

    const claudePath = process.env.CLAUDE_PATH || 'claude';
    const args = [
      '-p',
      '--resume',
      sessionId,
      '--verbose',
      '--debug-file',
      execution.debugLogPath,
      '--output-format',
      'stream-json',
      '--',
      answer,
    ];

    claudeLog.info(
      `[ClaudeService] Resuming in same execution: ${executionId}, session: ${sessionId}`,
    );
    debugLog(`[ClaudeService] spawn args:`, [claudePath, ...args].join(' '));

    const proc = spawn(claudePath, args, {
      cwd: this.deps.projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: this.deps.buildClaudeEnv(execution),
    });

    execution.process = proc;
    execution.stdin = proc.stdin;
    proc.stdin.on('error', () => {}); // Suppress EPIPE on kill
    proc.stdin.end(); // Close stdin immediately

    this.deps.attachStdoutHandler(execution, proc);
    this.deps.attachStderrHandler(execution, proc);

    proc.on('error', (err) => {
      this.deps.handleCompletion(execution, 1, err.message);
    });

    proc.on('close', (code) => {
      // Fix A: Ignore stale close events from previous (killed) process
      if (execution.process !== proc) {
        claudeLog.info(`[ClaudeService] Ignoring stale close event from resumed session`);
        return;
      }
      if (execution.status === 'running') {
        this.deps.handleCompletion(execution, code ?? 1);
      } else if (execution.status === 'handed-off') {
        if (execution.stallCheckInterval) {
          clearInterval(execution.stallCheckInterval);
          execution.stallCheckInterval = null;
        }
        execution.process = null;
        this.deps.dequeueNext();
      }
    });

    execution.stallCheckInterval = setInterval(() => {
      this.deps.checkStall(execution);
    }, STALL_CHECK_INTERVAL_MS);

    this.deps.broadcastState(execution);

    return { executionId: execution.id, sessionId };
  }

  /** Internal: spawn a resume session in browser mode */
  _resumeInBrowserWithSession(sessionId, featureId, command, prompt, oldExec = null) {
    const execution = this.deps.createExecution({
      featureId,
      command: `resume:${command.replace(/^resume:/, '')}`,
    });
    // Override defaults for active resume
    execution.status = 'running';
    execution.startedAt = nowJSTISO();
    execution.lastOutputTime = Date.now();
    execution.sessionId = sessionId;
    execution.ccsProfile = this.deps.getCcsProfile();
    execution.currentPhase = oldExec?.currentPhase || null;
    execution.currentPhaseName = oldExec?.currentPhaseName || null;
    execution.logs = [
      {
        line: `Resuming session ${sessionId}...`,
        timestamp: nowJSTISO(),
        level: 'info',
      },
    ];
    execution.debugLogPath = path.join(this.deps.tmpDir, `debug-${execution.id}.log`);

    this.deps.executions.set(execution.id, execution);

    const claudePath = process.env.CLAUDE_PATH || 'claude';
    // Note: no '--' separator needed — prompt is 'continue' or internally generated, never user-controlled
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
      `[ClaudeService] Resuming session: ${sessionId} (CCS profile: ${execution.ccsProfile || 'default'})`,
    );
    debugLog(`[ClaudeService] spawn args:`, [claudePath, ...args].join(' '));

    const proc = spawn(claudePath, args, {
      cwd: this.deps.projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: this.deps.buildClaudeEnv(execution),
    });

    execution.process = proc;
    execution.stdin = proc.stdin;
    proc.stdin.on('error', () => {}); // Suppress EPIPE on kill
    proc.stdin.end(); // Close stdin immediately — -p provides prompt, open pipe causes CLI hang

    this.deps.attachStdoutHandler(execution, proc);
    this.deps.attachStderrHandler(execution, proc);

    proc.on('error', (err) => {
      this.deps.handleCompletion(execution, 1, err.message);
    });

    proc.on('close', (code) => {
      if (execution.status === 'running') {
        this.deps.handleCompletion(execution, code ?? 1);
      } else if (execution.status === 'handed-off') {
        if (execution.stallCheckInterval) {
          clearInterval(execution.stallCheckInterval);
          execution.stallCheckInterval = null;
        }
        execution.process = null;
        this.deps.dequeueNext();
      }
    });

    execution.stallCheckInterval = setInterval(() => {
      this.deps.checkStall(execution);
    }, STALL_CHECK_INTERVAL_MS);

    this.deps.broadcastState(execution);

    // Notify frontend so it auto-subscribes to the new resume execution
    this.deps.broadcastAll({
      type: 'execution-started',
      executionId: execution.id,
      command: execution.command,
    });

    return { executionId: execution.id, sessionId };
  }

  /** Resume a stopped/failed execution in terminal (interactive) */
  resumeInTerminal(executionId) {
    const exec = this.deps.executions.get(executionId);
    // Fallback to persistent session map when execution evicted from memory (TTL)
    if (!exec || !exec.sessionId) {
      const persisted = this.lookupSessionId(executionId);
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
      `[ClaudeService] Opening terminal for resume: ${sessionId} (CCS profile: ${this.deps.getCcsProfile() || 'default'})`,
    );

    // Write AskUserQuestion context to temp file for terminal display
    const contextPrefix = exec ? this._writeResumeContext(exec) : '';

    const envPrefix = this.deps.buildTerminalEnvPrefix();
    const wtArgs = ['-w', '0', 'new-tab'];
    if (PROXY_ENABLED) {
      wtArgs.push('-p', 'Claude Code era');
    }
    wtArgs.push(
      '--title',
      tabTitle,
      '-d',
      this.deps.projectRoot,
      '--',
      'cmd',
      '/k',
      `${contextPrefix}${envPrefix}claude --resume ${sessionId}`,
    );

    const proc = spawn('wt.exe', wtArgs, {
      cwd: this.deps.projectRoot,
      stdio: 'ignore',
      detached: true,
      env: this.deps.buildClaudeEnv({ terminal: true }),
    });
    proc.unref();

    return { tabTitle, sessionId };
  }

  /**
   * Resume execution via Remote Control (node-pty worker).
   * Spawns claude --resume --remote-control in a crash-isolated worker,
   * captures the Remote Control URL from PTY output, and emails it.
   * Falls back to resumeInTerminal on failure.
   */
  resumeRemote(executionId, reason = '') {
    const exec = this.deps.executions.get(executionId);
    const persisted = !exec?.sessionId ? this.lookupSessionId(executionId) : null;
    const sessionId = exec?.sessionId || persisted?.sessionId;
    const featureId = exec?.featureId || persisted?.featureId;

    if (!sessionId) {
      claudeLog.warn(`[RemoteControl] No session ID for ${executionId}, falling back to terminal`);
      return this.resumeInTerminal(executionId);
    }

    // Use fixed Apple profile for Remote Control (matches phone browser login)
    const profile = REMOTE_CONTROL_PROFILE;
    const profileDir = path.join(CCS_INSTANCES_DIR, profile);
    if (!existsSync(profileDir)) {
      claudeLog.warn(
        `[RemoteControl] Profile '${profile}' not found at ${profileDir}, falling back to terminal`,
      );
      return this.resumeInTerminal(executionId);
    }

    claudeLog.info(
      `[RemoteControl] Starting remote-control for F${featureId} session ${sessionId} (profile: ${profile})`,
    );

    // Build env with fixed Apple profile
    const env = this.deps.buildClaudeEnv({ terminal: true, ccsProfile: profile });

    // Fork crash-isolated worker
    const workerPath = path.join(__dirname, 'workers', 'remoteCapture.js');
    const worker = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    let urlCaptured = false;
    let urlTimeout = null;
    let sessionTimeout = null;
    let exitHandled = false;

    // Mark execution as remote-control active
    if (exec) {
      exec.remoteControlActive = true;
      exec.remoteControlActiveAt = Date.now();
    }

    // URL capture timeout: fall back to terminal if URL not captured in time
    urlTimeout = setTimeout(() => {
      if (!urlCaptured) {
        claudeLog.warn(
          `[RemoteControl] URL capture timeout for F${featureId}, killing worker and falling back to terminal`,
        );
        worker.send({ type: 'kill' });
        if (exec) {
          exec.remoteControlActive = false;
        }
        // Wait for worker to exit before opening terminal
        setTimeout(() => this.resumeInTerminal(executionId), 1000);
      }
    }, REMOTE_URL_TIMEOUT_MS);

    // IPC handler
    worker.on('message', (msg) => {
      if (msg.type === 'url') {
        urlCaptured = true;
        clearTimeout(urlTimeout);
        claudeLog.info(`[RemoteControl] URL captured for F${featureId}: ${msg.url}`);

        // Send email with URL
        this.emailService
          ?.sendRemoteUrlNotification(
            exec || { featureId, command: 'resume', sessionId },
            msg.url,
            reason,
          )
          .catch((err) => {
            claudeLog.error(`[RemoteControl] Email failed for F${featureId}: ${err.message}`);
          });

        // Start session timeout (4h)
        sessionTimeout = setTimeout(() => {
          claudeLog.warn(
            `[RemoteControl] Session timeout (${REMOTE_CONTROL_TIMEOUT_MS / 3600000}h) for F${featureId}, killing worker`,
          );
          worker.send({ type: 'kill' });
        }, REMOTE_CONTROL_TIMEOUT_MS);
      } else if (msg.type === 'auto-answer') {
        claudeLog.info(
          `[RemoteControl] Auto-answered ${msg.pattern} for F${featureId}: ${msg.text?.substring(0, 100)}`,
        );
      } else if (msg.type === 'exit') {
        if (exitHandled) return;
        exitHandled = true;
        claudeLog.info(
          `[RemoteControl] Worker exited for F${featureId} (exitCode: ${msg.exitCode})`,
        );
        clearTimeout(urlTimeout);
        clearTimeout(sessionTimeout);
        if (exec) {
          exec.remoteControlActive = false;
          // Chain-enabled: keep terminalActive=true so fileWatcher resolves via _resolveTerminalActive
          // Non-chain: immediate cleanup
          if (!exec.chain?.enabled) {
            exec.terminalActive = false;
            this.deps.releaseChainSlot(exec);
          }
        }
      } else if (msg.type === 'error') {
        claudeLog.error(`[RemoteControl] Worker error for F${featureId}: ${msg.message}`);
        clearTimeout(urlTimeout);
        if (exec) {
          exec.remoteControlActive = false;
        }
        this.resumeInTerminal(executionId);
      }
    });

    worker.on('error', (err) => {
      claudeLog.error(`[RemoteControl] Worker process error for F${featureId}: ${err.message}`);
      clearTimeout(urlTimeout);
      clearTimeout(sessionTimeout);
      if (!exitHandled && exec) {
        exec.remoteControlActive = false;
      }
      this.resumeInTerminal(executionId);
    });

    worker.on('exit', (code) => {
      if (exitHandled) return;
      exitHandled = true;
      clearTimeout(urlTimeout);
      clearTimeout(sessionTimeout);
      if (exec) {
        exec.remoteControlActive = false;
        // Crash fallback: [DONE] unlikely written, immediate cleanup
        exec.terminalActive = false;
        this.deps.releaseChainSlot(exec);
      }
      claudeLog.info(`[RemoteControl] Worker process exited for F${featureId} (code: ${code})`);
    });

    // Start the capture
    worker.send({ type: 'start', sessionId, env, cols: 120, rows: 30, cwd: this.deps.projectRoot });

    return { sessionId, featureId, mode: 'remote' };
  }

  // --- Related helpers ---

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
      const contextDir = path.join(this.deps.projectRoot, '_out', 'tmp');
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
}
