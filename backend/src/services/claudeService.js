import { spawn } from 'child_process';
import { mkdir } from 'fs/promises';
import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import net from 'net';
import { claudeLog } from '../utils/logger.js';
import { nowJSTISO, toJSTISO } from '../utils/timeUtils.js';
import { exitWithPm2Update } from '../utils/exitHelpers.js';
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
  MAX_SERVER_ERROR_RETRIES,
  INPUT_EMAIL_DELAY_MS,
  HANDOFF_MODE,
  REMOTE_CONTROL_TIMEOUT_MS,
  MAX_CONCURRENT_EXECUTIONS,
  AUTO_SWITCH_THRESHOLD,
} from '../config.js';

// Import extracted modules
import { validateFeatureId, validateCommand, validateSessionId } from './validation.js';
import { INPUT_WAIT_PATTERNS } from './inputPatterns.js';
import { getCcsDefaultProfile, getCcsProfiles } from './ccsUtils.js';
import { getTotalPhases } from './phaseUtils.js';
import {
  ChainExecutor,
  getNextChainCommand,
  isExpectedStatusAfterCommand,
  isStatusBeyond,
  EXPECTED_STATUS_AFTER_COMMAND,
} from './chainExecutor.js';
import { EmailService } from './emailService.js';
import { StreamParser, extractStreamText, endsWithQuestion } from './streamParser.js';
import { RetryManager } from './retryManager.js';
import { ResumeManager } from './resumeManager.js';
import { ShellExecutor } from './shellExecutor.js';

// Verbose debug logging (enable with DASHBOARD_DEBUG=1)
const DEBUG = process.env.DASHBOARD_DEBUG === '1';
const debugLog = DEBUG ? claudeLog.info.bind(claudeLog) : () => {};

// Commands that bypass queue slot limit (lightweight, non-feature operations)
const SLOT_EXEMPT_COMMANDS = new Set(['commit', 'sync-deps', 'update-analysis', 'patch-cc']);

// Maps feature status to the first command to run in the workflow
const STATUS_TO_FIRST_COMMAND = {
  '[DRAFT]': 'fc',
  '[PROPOSED]': 'fl',
  '[REVIEWED]': 'run',
  '[WIP]': 'run',
  '[BLOCKED]': 'fl',
};

// Valid statuses for each command (used by executeCommand validation)
const VALID_STATUSES_FOR_COMMAND = {
  fc: new Set(['[DRAFT]']),
  fl: new Set(['[PROPOSED]', '[BLOCKED]']),
  run: new Set(['[REVIEWED]', '[WIP]', '[BLOCKED]']),
  imp: null, // always allowed
};

// Status-based dequeue priority: lower = higher priority
// Used by both bulkQueue (insertion sort) and _dequeueNext (dequeue sort)
const STATUS_PRIORITY = {
  '[WIP]': 0,
  '[REVIEWED]': 1,
  '[PROPOSED]': 2,
  '[DRAFT]': 3,
  '[BLOCKED]': 4,
};

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
 *
 * Module structure (after Phase A extraction):
 *   retryManager.js   — Rate limit (429) and server error (500/529) retry logic
 *   resumeManager.js  — Session resume, answerInBrowser, terminal handoff
 *   shellExecutor.js  — Shell commands (cs/dr/upd), slash commands, debug prompts
 *   chainExecutor.js  — Chain execution (fc→fl→run→imp)
 *   streamParser.js   — stream-json parsing, state detection
 */
export class ClaudeService {
  /**
   * @param {string} projectRoot - Project root directory
   * @param {import('../websocket/logStreamer.js').LogStreamer} logStreamer - WebSocket broadcaster
   * @param {Object} [options]
   * @param {number} [options.maxConcurrent] - Override max concurrent (test DI)
   */
  constructor(projectRoot, logStreamer, { maxConcurrent } = {}) {
    this.projectRoot = projectRoot;
    this.logStreamer = logStreamer;
    this._maxConcurrentOverride = maxConcurrent; // test DI
    this.executions = new Map();
    this.queue = [];
    this.chainSlots = new Set();
    this._profileRoundRobinIndex = 0; // Round-robin counter for per-session profile allocation
    this.runLockFeatureId = null; // Feature ID holding /run exclusion lock
    this.fileWatcher = null; // Set by server.js after construction for chain race condition fix
    this._previousDepsMap = new Map(); // featureId -> dependsOn string (for auto-queue detection)
    this.tmpDir = path.join(projectRoot, '_out', 'tmp', 'dashboard');
    mkdir(this.tmpDir, { recursive: true }).catch((err) =>
      claudeLog.debug(`Failed to create tmp dir: ${err.message}`),
    );

    // Persistent execution history (survives DR/reload)
    this._historyPath = path.join(this.tmpDir, 'execution-history.jsonl');

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
      killProcess: (exec) => {
        if (exec.process) this._killProcess(exec.process);
      },
      debugLog: debugLog,
    });

    // CCS profile is managed via CLAUDE_CONFIG_DIR environment variable

    this.emailService = new EmailService();

    this._cleanupInterval = setInterval(() => this._cleanupOldExecutions(), CLEANUP_INTERVAL_MS);

    // Initialize RetryManager with dependencies
    this.retryManager = new RetryManager({
      executeCommand: (fid, cmd, opts) => this.executeCommand(fid, cmd, opts),
      getExecution: (id) => this.executions.get(id),
      setExecution: (id, exec) => this.executions.set(id, exec),
      createExecution: (opts) => this._createExecution(opts),
      releaseChainSlot: (exec) => this._releaseChainSlot(exec),
      dequeueNext: () => this._dequeueNext(),
      broadcastAll: (msg) => this.logStreamer?.broadcastAll(msg),
      broadcastState: (exec) => this._broadcastState(exec),
      pushLog: (exec, entry) => this._pushLog(exec, entry),
      broadcastQueueUpdate: () => this._broadcastQueueUpdate(),
      saveHistoryEntry: (exec) => this._saveHistoryEntry(exec),
      getCcsProfile: () => this.getCcsProfile(),
      buildClaudeEnv: (exec) => this._buildClaudeEnv(exec),
      checkStall: (exec) => this._checkStall(exec),
      attachStdoutHandler: (exec, proc) => this._attachStdoutHandler(exec, proc),
      attachStderrHandler: (exec, proc) => this._attachStderrHandler(exec, proc),
      handleCompletion: (exec, exitCode, error) => this._handleCompletion(exec, exitCode, error),
      setShellState: (cmd, success) => this.shellExecutor.setShellState(cmd, success),
      streamParser: this.streamParser,
      tmpDir: this.tmpDir,
      projectRoot: this.projectRoot,
      // Internal cross-method calls routed through service for test mocking
      processNextInQueue: () => this._processNextInQueue(),
      startRateLimitRetry: (exec) => this._startRateLimitRetry(exec),
    });
    // Forward emailService set before retryManager was created
    this.retryManager.emailService = this._emailServiceRef;

    // Initialize ResumeManager with dependencies
    this.resumeManager = new ResumeManager({
      tmpDir: this.tmpDir,
      projectRoot: this.projectRoot,
      createExecution: (opts) => this._createExecution(opts),
      executions: this.executions,
      buildClaudeEnv: (exec) => this._buildClaudeEnv(exec),
      buildTerminalEnvPrefix: () => this._buildTerminalEnvPrefix(),
      attachStdoutHandler: (exec, proc) => this._attachStdoutHandler(exec, proc),
      attachStderrHandler: (exec, proc) => this._attachStderrHandler(exec, proc),
      handleCompletion: (exec, code, err) => this._handleCompletion(exec, code, err),
      checkStall: (exec) => this._checkStall(exec),
      pushLog: (exec, entry) => this._pushLog(exec, entry),
      broadcastState: (exec) => this._broadcastState(exec),
      broadcastAll: (msg) => this.logStreamer?.broadcastAll(msg),
      broadcast: (id, msg) => this.logStreamer?.broadcast(id, msg),
      dequeueNext: () => this._dequeueNext(),
      killProcess: (proc) => this._killProcess(proc),
      getCcsProfile: () => this.getCcsProfile(),
      streamParser: this.streamParser,
      getStallCheckIntervalMs: () => STALL_CHECK_INTERVAL_MS,
      releaseChainSlot: (exec) => this._releaseChainSlot(exec),
    });
    this.resumeManager.emailService = this.emailService;

    // Initialize ShellExecutor with dependencies
    this.shellExecutor = new ShellExecutor({
      tmpDir: this.tmpDir,
      projectRoot: this.projectRoot,
      createExecution: (opts) => this._createExecution(opts),
      executions: this.executions,
      startExecution: (exec) => this._startExecution(exec),
      canStartNow: (exec) => this._canStartNow(exec),
      queue: this.queue,
      broadcastAll: (msg) => this.logStreamer?.broadcastAll(msg),
      broadcastQueueUpdate: () => this._broadcastQueueUpdate(),
      pushLog: (exec, entry) => this._pushLog(exec, entry),
      getCcsProfile: () => this.getCcsProfile(),
      exitForRestart: () => this._exitForRestart(),
    });
    // Expose shellStates on ClaudeService for backward compatibility
    this.shellStates = this.shellExecutor.shellStates;
  }

  // ═══════════════════════════════════════
  // SECTION: Facade — Retry/Resume/Shell
  // ═══════════════════════════════════════

  /** Max concurrent executions (overridable for tests) */
  get maxConcurrent() {
    if (this._maxConcurrentOverride !== undefined) return this._maxConcurrentOverride;
    return MAX_CONCURRENT_EXECUTIONS;
  }

  // Scan/retry methods delegated to RetryManager
  _scanDebugLogForRateLimit(execution) {
    return this.retryManager.scanDebugLogForRateLimit(execution);
  }
  _scanDebugLogForAuthError(execution) {
    return this.retryManager.scanDebugLogForAuthError(execution);
  }
  _scanDebugLogForServerError(execution) {
    return this.retryManager.scanDebugLogForServerError(execution);
  }
  _scheduleRateLimitRetry(execution) {
    return this.retryManager.scheduleRateLimitRetry(execution);
  }
  _scheduleServerErrorRetry(execution, retryCount) {
    return this.retryManager.scheduleServerErrorRetry(execution, retryCount);
  }
  _processRateLimitQueue() {
    return this.retryManager._processRateLimitQueue();
  }
  _processNextInQueue() {
    return this.retryManager._processNextInQueue();
  }
  _startRateLimitRetry(execution) {
    return this.retryManager._startRateLimitRetry(execution);
  }
  switchProfile(targetProfile) {
    return this.retryManager.switchProfile(targetProfile);
  }

  // Proxy properties for test backward compatibility
  get _rateLimitRetryQueue() {
    return this.retryManager._rateLimitRetryQueue;
  }
  set _rateLimitRetryQueue(val) {
    this.retryManager._rateLimitRetryQueue = val;
  }
  get _rateLimitRetryTimer() {
    return this.retryManager._rateLimitRetryTimer;
  }
  set _rateLimitRetryTimer(val) {
    this.retryManager._rateLimitRetryTimer = val;
  }
  get _rateLimitRetryAt() {
    return this.retryManager._rateLimitRetryAt;
  }
  set _rateLimitRetryAt(val) {
    this.retryManager._rateLimitRetryAt = val;
  }
  get _rateLimitPaused() {
    return this.retryManager.isRateLimitPaused;
  }
  get _serverErrorRetryQueue() {
    return this.retryManager._serverErrorRetryQueue;
  }
  set _serverErrorRetryQueue(val) {
    this.retryManager._serverErrorRetryQueue = val;
  }
  get _serverErrorRetryTimer() {
    return this.retryManager._serverErrorRetryTimer;
  }
  set _serverErrorRetryTimer(val) {
    this.retryManager._serverErrorRetryTimer = val;
  }
  get _serverErrorRetryAt() {
    return this.retryManager._serverErrorRetryAt;
  }
  set _serverErrorRetryAt(val) {
    this.retryManager._serverErrorRetryAt = val;
  }
  get _serverErrorPaused() {
    return this.retryManager.isServerErrorPaused;
  }

  // Service setters that forward to retryManager
  get rateLimitService() {
    return this._rateLimitServiceRef;
  }
  set rateLimitService(svc) {
    this._rateLimitServiceRef = svc;
    if (this.retryManager) this.retryManager.rateLimitService = svc;
  }
  get featureService() {
    return this._featureServiceRef;
  }
  set featureService(svc) {
    this._featureServiceRef = svc;
    if (this.retryManager) this.retryManager.featureService = svc;
  }
  get emailService() {
    return this._emailServiceRef;
  }
  set emailService(svc) {
    this._emailServiceRef = svc;
    if (this.retryManager) this.retryManager.emailService = svc;
  }

  /** Exit process for PM2 autorestart — separated for testability (facade for ShellExecutor) */
  _exitForRestart() {
    exitWithPm2Update(0);
  }

  /** Set a shell command state — facade for backward compatibility (server.js Auto-DR) */
  _setShellState(command, success) {
    this.shellExecutor.setShellState(command, success);
  }

  // Session persistence delegated to ResumeManager
  _saveSessionId(executionId, sessionId, featureId, command) {
    return this.resumeManager.saveSessionId(executionId, sessionId, featureId, command);
  }
  _lookupSessionId(executionId) {
    return this.resumeManager.lookupSessionId(executionId);
  }

  // Proxy properties for test backward compatibility
  get _sessionMap() {
    return this.resumeManager._sessionMap;
  }
  set _sessionMap(val) {
    this.resumeManager._sessionMap = val;
  }

  // ═══════════════════════════════════════
  // SECTION: Profile Allocation
  // ═══════════════════════════════════════

  /** Get current CCS profile (reads from config.yaml each time to track changes) */
  getCcsProfile() {
    // Priority: CCS_PROFILE env var > config.yaml default
    return process.env.CCS_PROFILE || getCcsDefaultProfile();
  }

  /**
   * Allocate a CCS profile for a new execution using round-robin.
   * Each execution gets its own profile to distribute session usage evenly.
   * @param {string|null} [avoidProfile=null] - Profile to skip if possible (e.g., the one that just failed)
   * @returns {string|null} Allocated profile name, or null if no profiles available
   */
  _allocateProfile(avoidProfile = null) {
    const profiles = getCcsProfiles();
    if (profiles.length === 0) return this.getCcsProfile(); // fallback to global default

    // Build a safe-profile set from rate-limit cache (excludes profiles at/above threshold)
    const cached = this.rateLimitService?.getCached();
    const threshold = AUTO_SWITCH_THRESHOLD;
    const isSafe = (p) => {
      if (!cached) return true; // No cache yet — treat all as safe
      const data = cached[p];
      if (!data) return true; // No data = below capture threshold
      const maxPercent = Math.max(
        data.weekly?.percent || 0,
        data.session?.percent || 0,
        data.sonnet?.percent || 0,
      );
      return maxPercent < threshold;
    };

    // Round-robin among safe profiles first, then fall back to all profiles
    for (const candidateFilter of [
      (p) => p !== avoidProfile && isSafe(p),
      (p) => p !== avoidProfile,
    ]) {
      for (let i = 0; i < profiles.length; i++) {
        const profile = profiles[this._profileRoundRobinIndex % profiles.length];
        this._profileRoundRobinIndex = (this._profileRoundRobinIndex + 1) % profiles.length;
        if (candidateFilter(profile)) return profile;
      }
    }
    // All profiles exhausted (only 1 profile = avoided), fall back
    return profiles[this._profileRoundRobinIndex % profiles.length];
  }

  // ═══════════════════════════════════════
  // SECTION: Execution Lifecycle
  // ═══════════════════════════════════════

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
    incompleteRetryCount = 0,
    serverErrorRetryCount = 0,
    chainHistory = [],
    avoidProfile = null,
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
      chain: chain
        ? {
            enabled: true,
            retryCount,
            contextRetryCount,
            incompleteRetryCount,
            serverErrorRetryCount,
            history: chainHistory,
          }
        : null,
      chainParentId,
      debugLogPath: null,
      killedByUser: false,
      promptTooLong: false,
      accountLimitHit: false,
      serverErrorHit: false,
      authError: false,
      avoidProfile,
      origin: 'dashboard',
    };
  }

  /** Clean up old completed executions and stale chain waiters to prevent memory leak */
  _cleanupOldExecutions() {
    const now = Date.now();
    // Collect IDs to delete to avoid modifying Map during iteration
    const idsToDelete = [];
    for (const [id, exec] of this.executions) {
      if (exec.completedAt) {
        // Don't clean up executions still waiting for user input (y/n or AskUserQuestion)
        if (exec.waitingForInput || exec.inputRequired || exec.terminalActive) continue;
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
      if (exec.remoteControlActive) {
        const remoteAge = now - exec.remoteControlActiveAt;
        if (remoteAge > REMOTE_CONTROL_TIMEOUT_MS) {
          claudeLog.warn(
            `[Queue] Stale remote-control cleanup: F${exec.featureId} (${Math.round(remoteAge / 60000)}min)`,
          );
          exec.remoteControlActive = false;
          exec.terminalActive = false;
          this._releaseChainSlot(exec);
        }
        continue;
      }
      if (exec.terminalActive) {
        const terminalAge = now - exec.terminalActiveAt;
        if (terminalAge > STUCK_RUNNING_TIMEOUT_MS) {
          claudeLog.warn(
            `[Queue] Stale terminal-active cleanup: F${exec.featureId} (${Math.round(terminalAge / 60000)}min)`,
          );
          exec.terminalActive = false;
          this._releaseChainSlot(exec);
        }
        continue;
      }
      if (
        exec.status === 'running' &&
        !exec.inputRequired &&
        !exec.waitingForInput &&
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
        exec.completedAt = nowJSTISO();
        exec.process = null;
        this._releaseChainSlot(exec);
      }
    }
    // Queue state snapshot (periodic, for diagnostic log analysis)
    const snapshot = {
      running: 0,
      queued: this.queue.length,
      chainWaiters: this.chainExecutor.chainWaiters.size,
      chainSlots: this.chainSlots.size,
      idleChainSlots: this._countIdleChainSlots(),
      waitingInput: 0,
      total: this.executions.size,
    };
    const inputIds = [];
    for (const [id, exec] of this.executions) {
      if (exec.status === 'running') snapshot.running++;
      if (exec.waitingForInput || exec.inputRequired) {
        snapshot.waitingInput++;
        inputIds.push(id.substring(0, 8));
      }
    }
    if (inputIds.length > 0) snapshot.inputIds = inputIds;
    claudeLog.info(`[Queue] STATE ${JSON.stringify(snapshot)}`);
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
      if (stalledExec) this._releaseChainSlot(stalledExec);
      if (stalledExec) {
        const chainHistory = stalledExec.chain?.history || [];
        const currentStatus = this.fileWatcher?.statusCache.get(stalledExec.featureId);
        const expectedSt = EXPECTED_STATUS_AFTER_COMMAND[stalledExec.command];
        const actualResult =
          currentStatus === expectedSt || isStatusBeyond(currentStatus, expectedSt)
            ? 'ok'
            : 'stale-timeout';
        const finalHistory = [
          ...chainHistory,
          { command: stalledExec.command, result: actualResult },
        ];
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
          .catch((err) =>
            claudeLog.warn('[ClaudeService] Email notification failed:', err.message),
          );
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
    // Suppress CLI stop hook's 429 auto-resume — dashboard handles retries via
    // _scheduleRateLimitRetry (Strategy 1: profile switch, Strategy 2: timed retry).
    // Without this, the stop hook spawns competing --resume processes that loop
    // when all profiles are exhausted. See: F886 2026-03-13 37-iteration loop.
    if (!execution?.terminal) {
      env.CLAUDE_DASHBOARD_MANAGED = '1';
    }
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
    // CCS profile integration: use per-execution profile (round-robin allocated),
    // falling back to global default for terminal mode
    const profile = execution?.ccsProfile || this.getCcsProfile();
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
      if (exec.status === 'running' && !SLOT_EXEMPT_COMMANDS.has(exec.command)) count++;
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
   * @param {number} [options.incompleteRetryCount=0] - Current retry count for incomplete termination
   * @param {Array<{command: string, result: string, reason?: string}>} [options.chainHistory=[]] - Chain execution history
   * @param {boolean} [options.priority=false] - Insert at queue front (for incomplete retries)
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
      incompleteRetryCount = 0,
      chainHistory = [],
      priority = false,
      avoidProfile = null,
    } = {},
  ) {
    // Validate inputs to prevent command injection
    const validatedFeatureId = validateFeatureId(featureId);
    const validatedCommand = validateCommand(command);

    // Prevent duplicate execution for same feature+command (race condition guard).
    // Skip for chain continuations/retries (chainParentId set) and imp (always allowed).
    if (!chainParentId && validatedCommand !== 'imp') {
      for (const exec of this.executions.values()) {
        if (
          String(exec.featureId) === String(validatedFeatureId) &&
          exec.command === validatedCommand &&
          (exec.status === 'running' || exec.status === 'queued')
        ) {
          claudeLog.warn(
            `[Queue] Duplicate ${validatedCommand} for F${validatedFeatureId} rejected (existing: ${exec.id})`,
          );
          return exec.id;
        }
      }
    }

    // Validate feature status is appropriate for the requested command
    // Skip for chain continuations (chainParentId set) — chain executor manages status transitions
    if (!chainParentId) {
      const validStatuses = VALID_STATUSES_FOR_COMMAND[validatedCommand];
      if (validStatuses) {
        const currentStatus = this.fileWatcher?.statusCache?.get(String(validatedFeatureId));
        if (currentStatus && !validStatuses.has(currentStatus)) {
          const msg = `F${validatedFeatureId} status is ${currentStatus}, cannot run ${validatedCommand} (valid: ${[...validStatuses].join(', ')})`;
          claudeLog.warn(`[Queue] Status validation failed: ${msg}`);
          throw new Error(msg);
        }
      }
    }

    const execution = this._createExecution({
      featureId: validatedFeatureId,
      command: validatedCommand,
      chain,
      chainParentId,
      retryCount,
      contextRetryCount,
      incompleteRetryCount,
      chainHistory,
      avoidProfile,
    });
    const executionId = execution.id;

    this.executions.set(executionId, execution);

    // Reserve chain slot for chain root (first step in chain)
    if (chain && !chainParentId) {
      this.chainSlots.add(executionId);
      claudeLog.info(`[Queue] Chain slot reserved: ${executionId}`);
    }

    // Shorten idle refresh intervals now that an execution is starting
    if (this.rateLimitService) {
      this.rateLimitService.recomputeRefreshTimes();
    }

    if (this._canStartNow(execution)) {
      this._startExecution(execution);
    } else {
      if (priority) {
        this.queue.unshift(executionId);
      } else {
        this.queue.push(executionId);
      }
      // Release chain slot for dep-blocked items to prevent starvation
      // (re-reserved at dequeue time in _dequeueNext)
      const pendingDeps = this._getPendingDeps(execution.featureId);
      if (pendingDeps === null || pendingDeps.length > 0) {
        this._releaseChainSlot(execution);
      }
      const queuePos = priority ? 1 : this.queue.length;
      const runBlocked = this._isRunBlocked(execution.command, execution.featureId);
      const depBlocked = pendingDeps === null || pendingDeps.length > 0;
      this._pushLog(execution, {
        line: depBlocked
          ? `Queued (position ${queuePos}). Waiting for dependencies...`
          : runBlocked
            ? `Queued (position ${queuePos}). Waiting for running /run to complete...`
            : `Queued (position ${queuePos}). Waiting for slot...`,
        timestamp: nowJSTISO(),
        level: 'info',
      });
      claudeLog.info(
        `[Queue] Queued F${execution.featureId} ${execution.command} ` +
          `(exec: ${executionId}, pos: ${queuePos}${depBlocked ? ', dep-blocked' : ''})`,
      );
      this._broadcastQueueUpdate();
    }

    return executionId;
  }

  /**
   * Adopt an external terminal session into dashboard management.
   * Bypasses executeCommand() entirely — status validation, duplicate guard,
   * and dep-gating are incompatible with mid-flight session adoption.
   * Pattern: modeled after retryManager._startRateLimitRetry().
   */
  adoptSession({ sessionId, featureId, originalCommand }) {
    const validatedFeatureId = validateFeatureId(featureId);
    const validatedCommand = validateCommand(originalCommand);
    const validatedSessionId = validateSessionId(sessionId);

    // Conflict check: reject if feature has any running/queued execution
    for (const exec of this.executions.values()) {
      if (
        String(exec.featureId) === String(validatedFeatureId) &&
        (exec.status === 'running' || exec.status === 'queued')
      ) {
        const err = new Error(
          `F${validatedFeatureId} already has a ${exec.status} execution (${exec.command})`,
        );
        err.status = 409;
        throw err;
      }
    }

    // Run-lock check
    if (
      validatedCommand === 'run' &&
      this.runLockFeatureId &&
      this.runLockFeatureId !== validatedFeatureId
    ) {
      const err = new Error(`Run-lock held by F${this.runLockFeatureId}`);
      err.status = 409;
      throw err;
    }

    // Create execution with origin: 'adopted'
    const execution = this._createExecution({
      featureId: validatedFeatureId,
      command: validatedCommand,
    });
    execution.origin = 'adopted';
    execution.adoptedSessionId = validatedSessionId;

    this.executions.set(execution.id, execution);

    // Slot check (same as executeCommand but without dep-gating)
    const maxConcurrent = MAX_CONCURRENT_EXECUTIONS;
    if (this.runningCount < maxConcurrent) {
      this._startAdoptedExecution(execution);
    } else {
      execution.status = 'queued';
      this.queue.push(execution.id);
      this._pushLog(execution, {
        line: `Queued (position ${this.queue.length}). Waiting for slot...`,
        timestamp: nowJSTISO(),
        level: 'info',
      });
      claudeLog.info(
        `[Adopt] Queued F${execution.featureId} ${execution.command} (exec: ${execution.id})`,
      );
      this._broadcastQueueUpdate();
      return { id: execution.id, status: 'queued', featureId: validatedFeatureId };
    }

    return { id: execution.id, status: execution.status, featureId: validatedFeatureId };
  }

  /**
   * Start an adopted session execution.
   * Spawns claude --resume with attempt-and-retry for session release.
   */
  _startAdoptedExecution(execution, retryAttempt = 0) {
    const MAX_ADOPT_RETRIES = 6;
    const ADOPT_RETRY_DELAY_MS = 5000;

    execution.status = 'running';
    execution.startedAt = nowJSTISO();
    execution.lastOutputTime = Date.now();
    execution.ccsProfile = this._allocateProfile();

    // Acquire run-lock for /run
    if (execution.command === 'run') {
      this.runLockFeatureId = execution.featureId;
      claudeLog.info(`[Adopt] Run-lock acquired: F${execution.featureId}`);
    }

    this._pushLog(execution, {
      line: `Adopting session ${execution.adoptedSessionId} (${execution.command})...`,
      timestamp: execution.startedAt,
      level: 'info',
    });

    const claudePath = process.env.CLAUDE_PATH || 'claude';
    const debugLogPath = path.join(this.tmpDir, `debug-${execution.id}.log`);
    execution.debugLogPath = debugLogPath;

    const args = [
      '-p',
      'continue',
      '--resume',
      execution.adoptedSessionId,
      '--verbose',
      '--debug-file',
      debugLogPath,
      '--output-format',
      'stream-json',
    ];

    claudeLog.info(
      `[Adopt] Spawning: claude --resume ${execution.adoptedSessionId} (profile: ${execution.ccsProfile || 'default'})`,
    );

    const proc = spawn(claudePath, args, {
      cwd: this.projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: this._buildClaudeEnv(execution),
    });

    execution.process = proc;
    execution.stdin = proc.stdin;
    proc.stdin.on('error', () => {}); // Suppress EPIPE
    proc.stdin.end(); // Close stdin — -p provides prompt

    this._attachStdoutHandler(execution, proc);
    this._attachStderrHandler(execution, proc);

    proc.on('error', (err) => {
      claudeLog.error(`[Adopt] Process error: ${err.message}`);
      // If session is still locked, retry
      if (retryAttempt < MAX_ADOPT_RETRIES && err.message.includes('session')) {
        claudeLog.info(
          `[Adopt] Retry ${retryAttempt + 1}/${MAX_ADOPT_RETRIES} in ${ADOPT_RETRY_DELAY_MS}ms...`,
        );
        this._pushLog(execution, {
          line: `Session may still be locked. Retrying (${retryAttempt + 1}/${MAX_ADOPT_RETRIES})...`,
          timestamp: nowJSTISO(),
          level: 'warn',
        });
        setTimeout(
          () => this._startAdoptedExecution(execution, retryAttempt + 1),
          ADOPT_RETRY_DELAY_MS,
        );
        return;
      }
      this._handleAdoptFailure(execution, `Process error: ${err.message}`);
    });

    proc.on('close', (code) => {
      claudeLog.info(`[Adopt] Process exited with code ${code}`);
      if (execution.process !== proc) {
        claudeLog.info(`[Adopt] Ignoring stale close event`);
        return;
      }
      // If exit code indicates session lock failure and we have retries left
      if (code !== 0 && retryAttempt < MAX_ADOPT_RETRIES && !execution.sessionId) {
        claudeLog.info(
          `[Adopt] Session not available, retry ${retryAttempt + 1}/${MAX_ADOPT_RETRIES}`,
        );
        this._pushLog(execution, {
          line: `Session not yet available. Retrying (${retryAttempt + 1}/${MAX_ADOPT_RETRIES})...`,
          timestamp: nowJSTISO(),
          level: 'warn',
        });
        execution.process = null;
        setTimeout(
          () => this._startAdoptedExecution(execution, retryAttempt + 1),
          ADOPT_RETRY_DELAY_MS,
        );
        return;
      }
      if (execution.status === 'running') {
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

    // Stall detection
    execution.stallCheckInterval = setInterval(() => {
      this._checkStall(execution);
    }, STALL_CHECK_INTERVAL_MS);

    // Notify frontend
    this.logStreamer?.broadcastAll({
      type: 'execution-started',
      executionId: execution.id,
      featureId: execution.featureId,
      command: execution.command,
      origin: 'adopted',
      timestamp: nowJSTISO(),
    });

    this._broadcastState(execution);
    this._broadcastQueueUpdate();

    if (this.rateLimitService) {
      this.rateLimitService.recomputeRefreshTimes();
    }
  }

  /** Handle adoption failure — clean up locks and mark failed */
  _handleAdoptFailure(execution, reason) {
    execution.status = 'failed';
    execution.completedAt = nowJSTISO();
    execution.exitCode = 1;
    execution.process = null;

    // Release run-lock if held by this adoption
    if (execution.command === 'run' && this.runLockFeatureId === execution.featureId) {
      this._releaseRunLock(execution.featureId, 'adopt-failure');
    }

    this._pushLog(execution, {
      line: `Adoption failed: ${reason}`,
      timestamp: nowJSTISO(),
      level: 'error',
    });

    this._saveHistoryEntry(execution);
    this._broadcastState(execution);
    this._dequeueNext();
  }

  _startExecution(execution) {
    const { id: executionId, featureId, command } = execution;
    const cliPrompt =
      execution._debugPrompt || (featureId ? `/${command} ${featureId}` : `/${command}`);

    // Defense-in-depth: final dep check before starting
    // (SLOT_EXEMPT commands have no featureId, _getPendingDeps returns [] for them)
    // Bypass dep-gating for adopted sessions (already ran externally)
    if (execution.origin !== 'adopted') {
      const pendingDeps = this._getPendingDeps(featureId);
      if (pendingDeps === null || pendingDeps.length > 0) {
        const depList = pendingDeps ? pendingDeps.map((d) => `F${d}`).join(', ') : 'unknown';
        claudeLog.warn(
          `[DepGuard] F${featureId} ${command} blocked at _startExecution: deps [${depList}]`,
        );
        this._pushLog(execution, {
          line: `Blocked: waiting for dependencies [${depList}]`,
          timestamp: nowJSTISO(),
          level: 'warn',
        });
        // Re-queue — _dequeueNext() uses priority-aware sorting, position doesn't matter
        this.queue.push(executionId);
        this._releaseChainSlot(execution);
        this._broadcastQueueUpdate();
        return;
      }
    }

    execution.status = 'running';
    execution.startedAt = nowJSTISO();
    execution.lastOutputTime = Date.now();
    execution.ccsProfile = this._allocateProfile(execution.avoidProfile);

    // Acquire run-lock when /run starts
    if (command === 'run') {
      this.runLockFeatureId = featureId;
      claudeLog.info(`[Queue] Run-lock acquired: F${featureId}`);
    }

    // Broadcast deferred chain-progress toast now that execution is actually starting
    if (execution._pendingChainProgress) {
      this.logStreamer?.broadcastAll({
        type: 'chain-progress',
        ...execution._pendingChainProgress,
        timestamp: nowJSTISO(),
      });
      delete execution._pendingChainProgress;
    }

    this._pushLog(execution, {
      line: `Starting: claude -p "${cliPrompt}" --output-format stream-json`,
      timestamp: execution.startedAt,
      level: 'info',
    });

    const claudePath = process.env.CLAUDE_PATH || 'claude';

    // Debug log file for post-mortem analysis
    const debugLogPath = path.join(this.tmpDir, `debug-${executionId}.log`);
    execution.debugLogPath = debugLogPath;

    claudeLog.info(
      `[ClaudeService] Launching: ${claudePath} -p "${cliPrompt}" (CCS profile: ${execution.ccsProfile || 'default'})`,
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
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: this._buildClaudeEnv(execution),
    });

    execution.process = proc;
    execution.stdin = proc.stdin;
    proc.stdin.on('error', () => {}); // Suppress EPIPE on kill
    proc.stdin.end(); // Close stdin immediately — -p provides prompt, open pipe causes CLI hang

    claudeLog.info(`[ClaudeService] Spawned claude PID=${proc.pid}`);

    this._attachStdoutHandler(execution, proc);
    this._attachStderrHandler(execution, proc);

    proc.on('error', (err) => {
      claudeLog.error(`[ClaudeService] Process error: ${err.message}`);
      this._handleCompletion(execution, 1, err.message);
    });

    proc.on('close', (code) => {
      claudeLog.info(`[ClaudeService] Process exited with code ${code}`);
      // Fix A: Ignore stale close events from previous processes (kill→resume race).
      // answerInBrowser() replaces execution.process with the new spawn; if this
      // close came from the old (killed) process, skip it entirely.
      if (execution.process !== proc) {
        claudeLog.info(`[ClaudeService] Ignoring stale close event (process replaced by resume)`);
        return;
      }
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

    // Notify frontend so it auto-subscribes to dequeued executions
    // (without this, dequeue→running transitions are invisible until F5)
    this.logStreamer?.broadcastAll({
      type: 'execution-started',
      executionId,
      command: execution.command,
      source: 'dequeue',
    });

    this._broadcastQueueUpdate();
    this._broadcastState(execution);

    // Sync active imp IDs so featureService can promote RC features with active /imp
    this._syncActiveImpIds();
  }

  /**
   * Sync active imp execution IDs to featureService.
   * Called after execution starts or completes so featureService can promote
   * recently-completed features with active /imp back to their phase section.
   */
  _syncActiveImpIds() {
    if (!this.featureService) return;
    const ids = [];
    for (const exec of this.executions.values()) {
      if (
        exec.command === 'imp' &&
        (exec.status === 'running' || exec.status === 'queued') &&
        exec.featureId
      ) {
        ids.push(exec.featureId);
      }
    }
    this.featureService.setActiveImpFeatureIds(ids);
  }

  // ═══════════════════════════════════════
  // SECTION: Stream Handling & Input
  // ═══════════════════════════════════════

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
      if (/overloaded_error|api_error|internal_server_error/i.test(line)) {
        execution.serverErrorHit = true;
      }
      const entry = {
        line: `[stderr] ${line}`,
        timestamp: nowJSTISO(),
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
      timestamp: nowJSTISO(),
    });
    // Email notification: user input required (browser-first — replaces old handoff email)
    const featureInfo =
      execution.featureId && this.featureService
        ? this.featureService.getFeature(execution.featureId)
        : null;
    // Delay email — cancel if user answers in browser within INPUT_EMAIL_DELAY_MS
    if (execution._pendingInputEmailTimeout) clearTimeout(execution._pendingInputEmailTimeout);
    execution._pendingInputEmailTimeout = setTimeout(() => {
      execution._pendingInputEmailTimeout = null;
      this.emailService
        ?.sendHandoffNotification(
          execution,
          `Input required: ${description}`,
          execution.chain?.enabled ? execution.chain.history : undefined,
          featureInfo,
        )
        .catch(() => {});
    }, INPUT_EMAIL_DELAY_MS);

    // Promo auto-answer: y/n → auto-yes for fl/run/imp
    if (['fc', 'fl', 'run', 'imp'].includes(execution.command)) {
      this._schedulePromoAutoAnswer(execution, 'yes', `${execution.command} y/n auto-yes`);
    }
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
    if (!execution.terminalActive) {
      this._releaseChainSlot(execution);
    }

    const entry = {
      line: `[Handoff] ${reason} - Opening terminal for user input...`,
      timestamp: nowJSTISO(),
      level: 'info',
    };
    this._pushLog(execution, entry);
    this.logStreamer?.broadcast(execution.id, {
      type: 'log',
      executionId: execution.id,
      ...entry,
    });

    this.logStreamer?.broadcast(execution.id, {
      type: 'handoff',
      executionId: execution.id,
      reason: reason,
      sessionId: execution.sessionId,
      timestamp: nowJSTISO(),
    });

    const chainHistory = execution.chain?.history || [];
    const finalHistory = [...chainHistory, { command: execution.command, result: 'handoff' }];
    const featureInfo =
      execution.featureId && this.featureService
        ? this.featureService.getFeature(execution.featureId)
        : null;
    // Cancel pending delayed email — terminal handoff email replaces it
    if (execution._pendingInputEmailTimeout) {
      clearTimeout(execution._pendingInputEmailTimeout);
      execution._pendingInputEmailTimeout = null;
    }
    const emailPromise =
      this.emailService
        ?.sendHandoffNotification(
          execution,
          reason,
          execution.chain?.enabled ? finalHistory : undefined,
          featureInfo,
        )
        ?.catch(() => {}) ?? Promise.resolve();

    if (execution.process) {
      this._killProcess(execution.process);
    }

    if (execution.stallCheckInterval) {
      clearInterval(execution.stallCheckInterval);
      execution.stallCheckInterval = null;
    }

    this._saveHistoryEntry(execution);

    setTimeout(async () => {
      if (HANDOFF_MODE === 'remote') {
        this.resumeRemote(execution.id, reason);
      } else {
        this.resumeInTerminal(execution.id);
      }
      // Ensure handoff email is sent before Auto-DR can kill the process.
      // setTimeout does not propagate async errors, but emailPromise already has .catch().
      await emailPromise;
      this.onExecutionComplete?.(execution);
    }, HANDOFF_DELAY_MS);

    this._broadcastState(execution);
    this._dequeueNext();
  }

  /** Append a history entry to the persistent JSONL file */
  _saveHistoryEntry(execution) {
    try {
      const entry = {
        executionId: execution.id,
        featureId: execution.featureId,
        command: execution.command,
        status: execution.status,
        exitCode: execution.exitCode ?? null,
        sessionId: execution.sessionId ?? null,
        startedAt: execution.startedAt ?? null,
        completedAt: execution.completedAt ?? null,
        contextPercent: execution.contextPercent ?? null,
        ccsProfile: execution.ccsProfile ?? null,
        resultSubtype: execution.resultSubtype ?? null,
        killedByUser: execution.killedByUser ?? false,
        origin: execution.origin ?? 'dashboard',
        tokenUsage: execution.tokenUsage
          ? {
              input: execution.tokenUsage.input,
              output: execution.tokenUsage.output,
              cacheRead: execution.tokenUsage.cacheRead,
            }
          : null,
      };
      appendFileSync(this._historyPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      claudeLog.warn(`[ClaudeService] Failed to save history entry: ${err.message}`);
    }
  }

  /** Read execution history from JSONL file, filtered by age */
  getHistory(limitDays = 7) {
    try {
      if (!existsSync(this._historyPath)) return [];
      const raw = readFileSync(this._historyPath, 'utf8').trim();
      if (!raw) return [];
      const cutoff = Date.now() - limitDays * 86400000;
      const entries = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const ts = entry.completedAt || entry.startedAt;
          if (ts && new Date(ts).getTime() >= cutoff) {
            entries.push(entry);
          }
        } catch {
          // Skip malformed lines
        }
      }
      // Newest first
      entries.sort((a, b) => {
        const ta = new Date(b.completedAt || b.startedAt || 0).getTime();
        const tb = new Date(a.completedAt || a.startedAt || 0).getTime();
        return ta - tb;
      });
      return entries;
    } catch (err) {
      claudeLog.warn(`[ClaudeService] Failed to read history: ${err.message}`);
      return [];
    }
  }

  /** Clear execution history (test support / manual reset) */
  clearHistory() {
    try {
      writeFileSync(this._historyPath, '', 'utf8');
    } catch (err) {
      claudeLog.warn(`[ClaudeService] Failed to clear history: ${err.message}`);
    }
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

  /**
   * Detect if assistant's last output requires user action (file deletion, confirmation, etc.)
   * Used to avoid futile incomplete termination retries when user interaction is needed.
   */
  _detectUserActionRequired(execution) {
    if (!execution.lastAssistantText) return null;
    const text = execution.lastAssistantText;

    const patterns = [
      { pattern: /Please delete/i, reason: 'File deletion requested' },
      { pattern: /削除してください/, reason: 'File deletion requested' },
      { pattern: /手動で削除/, reason: 'Manual deletion requested' },
      { pattern: /\(y\/n\)/i, reason: 'User confirmation pending' },
    ];

    for (const { pattern, reason } of patterns) {
      if (pattern.test(text)) {
        return reason;
      }
    }
    return null;
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
          timestamp: nowJSTISO(),
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
      totalIterations: execution.totalIterations || null, // FL total iterations (e.g., 10)
      sessionId: execution.sessionId, // Added: needed for Resume button
      inputRequired: !!execution.inputRequired,
      waitingForInput: execution.waitingForInput,
      waitingInputPattern: execution.waitingInputPattern,
      pendingTool: execution.pendingToolUse?.name || null,
      isStalled: execution.isStalled || false,
      taskDepth: execution.taskDepth || 0,
      contextPercent: execution.contextPercent, // Context window usage percentage
      tokenUsage: execution.tokenUsage, // Full token usage details
      timestamp: nowJSTISO(),
    });

    // Write context % to file for Context Pressure Gate (redundant: statusline.ps1 also writes per-turn)
    if (execution.featureId && execution.contextPercent != null) {
      const ctxFile = path.join(
        this.projectRoot,
        '_out',
        'tmp',
        `claude-ctx-f${execution.featureId}.txt`,
      );
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
      timestamp: nowJSTISO(),
    });
    // Email notification: AskUserQuestion requires user input (browser-first — replaces old handoff email)
    const featureInfo =
      execution.featureId && this.featureService
        ? this.featureService.getFeature(execution.featureId)
        : null;
    const questionSummary = (execution.inputRequired?.questions || [])
      .map((q) => q.question)
      .join('; ');
    if (execution._pendingInputEmailTimeout) clearTimeout(execution._pendingInputEmailTimeout);
    execution._pendingInputEmailTimeout = setTimeout(() => {
      execution._pendingInputEmailTimeout = null;
      this.emailService
        ?.sendHandoffNotification(
          execution,
          `AskUserQuestion: ${questionSummary || 'User input required'}`,
          execution.chain?.enabled ? execution.chain.history : undefined,
          featureInfo,
        )
        .catch(() => {});
    }, INPUT_EMAIL_DELAY_MS);

    // Promo auto-answer: AskUserQuestion → first option for fl/run/imp
    if (['fc', 'fl', 'run', 'imp'].includes(execution.command)) {
      const rawOption = execution.inputRequired?.questions?.[0]?.options?.[0];
      const firstOption =
        typeof rawOption === 'object' ? rawOption?.label || '1' : rawOption || '1';
      this._schedulePromoAutoAnswer(
        execution,
        firstOption,
        `${execution.command} AskUserQuestion auto-first-option`,
      );
    }
  }

  // ═══════════════════════════════════════
  // SECTION: Completion Handling
  // ═══════════════════════════════════════

  /** Handle execution completion */
  _handleCompletion(execution, exitCode, error = null) {
    // Guard against double completion
    if (execution.status !== 'running') {
      return;
    }

    // If killed for AskUserQuestion, don't complete — wait for browser answer → resume
    if (execution._killedForAskUser) {
      claudeLog.info(
        `[ClaudeService] Process killed for AskUserQuestion — waiting for browser answer (exec ${execution.id}, F${execution.featureId}, ${execution.command})`,
      );
      if (execution.stallCheckInterval) {
        clearInterval(execution.stallCheckInterval);
        execution.stallCheckInterval = null;
      }
      execution.process = null;
      execution.stdin = null;
      // Keep status as 'running' and inputRequired intact for browser UI
      return;
    }

    // Fix B: Process exited while waiting for browser input (y/n prompt).
    // Hold the execution slot — browser answer or safety timeout will handle cleanup.
    // Without this guard, _dequeueNext() would open a slot,
    // and a subsequent answerInBrowser() would push runningCount over maxConcurrent.
    if (execution.waitingForInput) {
      claudeLog.info(
        `[ClaudeService] Process exited while waiting for browser input — holding slot (exec ${execution.id}, F${execution.featureId}, ${execution.command})`,
      );
      if (execution.stallCheckInterval) {
        clearInterval(execution.stallCheckInterval);
        execution.stallCheckInterval = null;
      }
      execution.process = null;
      execution.stdin = null;

      // Hold slot indefinitely — user must answer via browser or Stop manually.
      // Releasing the slot would allow other features to start, breaking problem isolation
      // (run lock ensures clean start + pre-commit test integrity).
      return;
    }

    // Resume-answer spawn failed (e.g., CLI arg parsing error).
    // Restore inputRequired so user can retry from browser UI.
    if (execution._resumedAnswer && exitCode !== 0 && !execution.killedByUser) {
      const retryCount = (execution._resumeFailCount || 0) + 1;
      const MAX_RESUME_RETRIES = 3;

      if (retryCount <= MAX_RESUME_RETRIES) {
        claudeLog.warn(
          `[ClaudeService] answerInBrowser resume failed (exit=${exitCode}) — restoring input for retry (${retryCount}/${MAX_RESUME_RETRIES}) (exec ${execution.id}, lastInputRequired=${!!execution._lastInputRequired}, lastWaitingForInput=${!!execution._lastWaitingForInput}, answer="${execution._lastWaitingAnswer}")`,
        );
        execution._resumeFailCount = retryCount;
        execution._resumedAnswer = false;
        execution.process = null;
        execution.stdin = null;

        // Restore input state (AskUserQuestion or y/n)
        if (execution._lastInputRequired) {
          execution.inputRequired = execution._lastInputRequired;
        } else {
          execution.inputRequired = {
            type: 'question',
            question: '(Previous answer failed to send. Please retry or use Terminal.)',
            options: [],
          };
        }
        execution.waitingForInput = execution._lastWaitingForInput || false;
        execution.waitingInputPattern = execution._lastWaitingInputPattern || null;

        if (execution.stallCheckInterval) {
          clearInterval(execution.stallCheckInterval);
          execution.stallCheckInterval = null;
        }

        this._broadcastState(execution);

        // Re-schedule auto-answer with exponential backoff
        const retryDelayMs = 2000 * Math.pow(2, retryCount - 1); // 2s, 4s, 8s
        const savedAnswer = execution._lastWaitingAnswer;
        if (savedAnswer && ['fc', 'fl', 'run', 'imp'].includes(execution.command)) {
          this._schedulePromoAutoAnswer(
            execution,
            savedAnswer,
            `${execution.command} resume-fail auto-retry ${retryCount}/${MAX_RESUME_RETRIES}`,
            retryDelayMs,
            { isRetry: true },
          );
          claudeLog.info(
            `[ClaudeService] Scheduled auto-retry ${retryCount}/${MAX_RESUME_RETRIES} in ${retryDelayMs}ms (exec ${execution.id})`,
          );
        }

        return; // Hold slot, keep status 'running'
      }

      // Exhausted — fall through to normal completion (terminal handoff or failed)
      claudeLog.error(
        `[ClaudeService] answerInBrowser retry exhausted (${MAX_RESUME_RETRIES}) — falling through (exec ${execution.id})`,
      );
    }

    const executionId = execution.id;
    claudeLog.info(
      `[ClaudeService] Execution ${executionId} completed with code ${exitCode}, subtype=${execution.resultSubtype}`,
    );
    if (execution.waitingForInput || execution.inputRequired || execution.chain?.enabled) {
      claudeLog.info(
        `[Queue] COMPLETION ${JSON.stringify({
          id: executionId.substring(0, 8),
          featureId: execution.featureId,
          command: execution.command,
          waitingForInput: !!execution.waitingForInput,
          inputRequired: !!execution.inputRequired,
          chain: !!execution.chain?.enabled,
          status: execution.status,
        })}`,
      );
    }

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
    // Skip if execution was waiting for browser input (y/n or AskUserQuestion) — let browser handle it
    if (
      !error &&
      exitCode === 0 &&
      execution.sessionId &&
      !execution.waitingForInput &&
      !execution.inputRequired &&
      endsWithQuestion(execution.lastAssistantText)
    ) {
      claudeLog.info(`[ClaudeService] Completed with pending question - handing off to terminal`);
      execution.process = null;
      execution.stdin = null;
      if (execution.command === 'run' && this.runLockFeatureId === execution.featureId) {
        execution.terminalActive = true;
        execution.terminalActiveAt = Date.now();
        claudeLog.info(
          `[Queue] Terminal-active: F${execution.featureId} (pending question handoff)`,
        );
      }
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
              timestamp: nowJSTISO(),
              level: 'warning',
            });
            this._broadcastState(execution);
            this.logStreamer?.broadcastAll({
              type: 'account-limit',
              featureId: execution.featureId,
              command: execution.command,
              executionId: execution.id,
              deferred: true,
              timestamp: nowJSTISO(),
            });
          }
        }, 500);
      }
    }

    // Late-stage server error detection: scan debug log for 500/529 (overloaded_error, api_error)
    if (!execution.serverErrorHit && exitCode !== 0 && execution.debugLogPath) {
      this._scanDebugLogForServerError(execution);
    }

    // Late-stage auth error detection: scan debug log for permission_error (e.g. expired subscription).
    // If detected, skip context retry entirely to avoid wasting retries on an unrecoverable error.
    if (!execution.authError && exitCode !== 0 && execution.debugLogPath) {
      this._scanDebugLogForAuthError(execution);
    }

    // Server error (500/529) retry — before context retry to avoid consuming context retries
    // on server-side issues. Profile switch won't help; use exponential backoff.
    if (
      execution.serverErrorHit &&
      !execution.killedByUser &&
      !execution.accountLimitHit &&
      execution.origin !== 'adopted'
    ) {
      const retryCount = execution.chain?.serverErrorRetryCount || 0;
      if (retryCount < MAX_SERVER_ERROR_RETRIES) {
        execution.status = 'failed';
        execution.completedAt = nowJSTISO();
        execution.exitCode = exitCode;
        execution.process = null;
        execution.stdin = null;
        this.streamParser.clearRingBuffer(execution.id);

        const scheduled = this._scheduleServerErrorRetry(execution, retryCount);

        this._pushLog(execution, {
          line: scheduled
            ? `[Chain] Server error (500/529) detected. ${scheduled.message}`
            : `[Chain] Server error (500/529) detected. No retry possible.`,
          timestamp: execution.completedAt,
          level: 'warning',
        });

        this.logStreamer?.broadcastAll({
          type: 'status',
          executionId,
          status: execution.status,
          exitCode,
        });

        this._broadcastState(execution);
        this._saveHistoryEntry(execution);

        this.onExecutionComplete?.(execution);
        return;
      } else {
        claudeLog.warn(
          `[ServerError] Retry exhausted (${retryCount}/${MAX_SERVER_ERROR_RETRIES}) for F${execution.featureId} ${execution.command}`,
        );
        this._pushLog(execution, {
          line: `[Chain] Server error retries exhausted (${retryCount}/${MAX_SERVER_ERROR_RETRIES}). Manual re-run needed.`,
          timestamp: nowJSTISO(),
          level: 'error',
        });

        this.logStreamer?.broadcastAll({
          type: 'server-error-exhausted',
          featureId: execution.featureId,
          command: execution.command,
          retryCount,
          maxRetries: MAX_SERVER_ERROR_RETRIES,
          timestamp: nowJSTISO(),
        });

        const featureInfo =
          execution.featureId && this.featureService
            ? this.featureService.getFeature(execution.featureId)
            : null;
        this.emailService
          ?.sendServerErrorExhaustedNotification(execution, featureInfo)
          .catch((err) =>
            claudeLog.warn('[ClaudeService] Email notification failed:', err.message),
          );
        // Fall through to normal completion
      }
    }

    // Context exhaustion retry for all commands (fc, fl, run)
    // subtype=success with non-zero exit (is_error=true) indicates context limit
    // reached during a successful operation — CLI couldn't continue but last response was ok
    const isContextExhausted =
      ['error_max_turns', 'max_tokens'].includes(execution.resultSubtype) ||
      execution.promptTooLong ||
      (exitCode !== 0 &&
        execution.resultSubtype === 'success' &&
        !execution.accountLimitHit &&
        !execution.serverErrorHit &&
        !execution.authError) ||
      (exitCode === 3 && !execution.resultSubtype);

    // Skip context retry if command already achieved its expected status or feature is blocked
    const contextExpectedStatus = EXPECTED_STATUS_AFTER_COMMAND[execution.command];
    const contextCurrentStatus = this.fileWatcher?.statusCache.get(execution.featureId);
    const alreadyAchieved = contextExpectedStatus && contextCurrentStatus === contextExpectedStatus;
    const isBlockedStatus = contextCurrentStatus === '[BLOCKED]';

    const needsContextRetry =
      execution.chain?.enabled &&
      execution.chain.contextRetryCount < MAX_RETRIES &&
      !execution.killedByUser &&
      !execution.accountLimitHit &&
      !execution.serverErrorHit &&
      !alreadyAchieved &&
      !isBlockedStatus &&
      isContextExhausted;

    if (isContextExhausted && alreadyAchieved) {
      claudeLog.info(
        `[Chain] Context exhausted for F${execution.featureId} ${execution.command}, but status already ${contextCurrentStatus} — skipping retry`,
      );
    }

    if (isContextExhausted && isBlockedStatus) {
      claudeLog.info(
        `[Chain] Context exhausted for F${execution.featureId} ${execution.command}, but feature is [BLOCKED] — skipping retry`,
      );
    }

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
      execution.completedAt = nowJSTISO();
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
          incompleteRetryCount: execution.chain.incompleteRetryCount || 0, // preserve incomplete counter
          serverErrorRetryCount: execution.chain.serverErrorRetryCount || 0, // preserve server error counter
          chainHistory: updatedHistory,
          priority: true,
          avoidProfile: execution.ccsProfile,
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
          timestamp: nowJSTISO(),
        });
      }, RETRY_DELAY_MS);

      this._broadcastState(execution);
      this._dequeueNext();

      // Drain rate limit retry queue even on context retry path
      this.retryManager.continueQueueDrain(execution);
      return;
    }

    // Chain: FL auto-retry on any failure (non-zero exit) or re-run request
    // Skip if feature is [BLOCKED] — retrying FL won't resolve dependency gates
    const flCurrentStatus = this.fileWatcher?.statusCache.get(execution.featureId);
    const flIsBlocked = flCurrentStatus === '[BLOCKED]';
    const flWantsRetry =
      execution.chain?.enabled &&
      execution.command === 'fl' &&
      !execution.killedByUser &&
      !execution.accountLimitHit &&
      !execution.serverErrorHit &&
      !isContextExhausted &&
      !flIsBlocked &&
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
      execution.completedAt = nowJSTISO();
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

      // Synchronous: no delay for FL re-run retry — previous session completed normally,
      // no 429 risk. Sync call ensures the chain slot is used before _dequeueNext() can
      // give it to another execution.
      const newExecId = this.executeCommand(execution.featureId, 'fl', {
        chain: true,
        chainParentId: execution.chainParentId || execution.id,
        retryCount,
        contextRetryCount: execution.chain.contextRetryCount, // preserve context counter
        incompleteRetryCount: execution.chain.incompleteRetryCount || 0, // preserve incomplete counter
        serverErrorRetryCount: execution.chain.serverErrorRetryCount || 0, // preserve server error counter
        chainHistory: updatedHistory,
        priority: true,
        avoidProfile: execution.ccsProfile,
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
        timestamp: nowJSTISO(),
      });

      this._broadcastState(execution);
      this._dequeueNext();

      // Drain rate limit retry queue even on FL retry path
      this.retryManager.continueQueueDrain(execution);
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
        timestamp: nowJSTISO(),
        level: 'warning',
      });

      this.logStreamer?.broadcastAll({
        type: 'fl-retry-exhausted',
        featureId: execution.featureId,
        retryCount: execution.chain.retryCount,
        maxRetries: MAX_FL_RETRIES,
        timestamp: nowJSTISO(),
      });
    }

    // Notify frontend of account limit (not retryable)
    if (execution.accountLimitHit) {
      this.logStreamer?.broadcastAll({
        type: 'account-limit',
        featureId: execution.featureId,
        command: execution.command,
        executionId: execution.id,
        timestamp: nowJSTISO(),
      });
    }

    // Rate limit retry: schedule retry for chain executions AND non-chain executions
    // (non-chain also benefit from profile switch / timed retry to avoid wasting context retries)
    if (execution.accountLimitHit && !execution.killedByUser) {
      execution.status = 'failed';
      execution.completedAt = nowJSTISO();
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

      this.logStreamer?.broadcastAll({
        type: 'status',
        executionId,
        status: execution.status,
        exitCode,
      });

      this._broadcastState(execution);

      this._saveHistoryEntry(execution);

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
      // Always email on 429 — body includes retry info (rateLimitRetryAt / rateLimitSwitchedTo)
      this.emailService
        ?.sendCompletionNotification(
          execution,
          execution.status,
          exitCode,
          finalHistory,
          featureInfo,
        )
        .catch(() => {});

      // Refresh rate limit for the profile that hit 429
      if (this.rateLimitService) {
        const profile = this.getCcsProfile();
        this.rateLimitService
          .capture({ forceRefresh: true, profile })
          .catch((err) =>
            claudeLog.warn('[ClaudeService] Rate limit capture failed:', err.message),
          );
      }

      // Don't dequeue (paused or immediate retry pending)
      this.onExecutionComplete?.(execution);
      return;
    }

    // FL retry exhaustion: mark as failed so tree/email show it clearly
    const isFlRetryExhausted = flWantsRetry && !flNeedsRetry;
    execution.status = isFlRetryExhausted ? 'failed' : exitCode === 0 ? 'completed' : 'failed';
    execution.completedAt = nowJSTISO();
    execution.exitCode = exitCode;
    execution.process = null;
    execution.stdin = null;
    this.streamParser.clearRingBuffer(execution.id);

    // Run-lock release is deferred until after the incomplete termination check below.
    // Early release here caused a race: _dequeueNext() started the next /run before
    // incomplete detection could retry, pushing the retry to the queue tail.

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

    this.logStreamer?.broadcastAll({
      type: 'status',
      executionId,
      status: execution.status,
      exitCode,
      error,
    });

    this._broadcastState(execution);

    this._saveHistoryEntry(execution);

    // Chain: Register waiter for next step if chain-eligible (success + no handoff + not FL retry exhausted)
    // /imp is the last chain step — no next command exists, so send email directly
    const chainContinues =
      execution.chain?.enabled &&
      exitCode === 0 &&
      execution.resultSubtype === 'success' &&
      !execution.promptTooLong &&
      !isFlRetryExhausted;
    const isLastChainStep = execution.command === 'imp';

    // Detect incomplete termination: exit 0 + success subtype, but status didn't advance.
    // This happens when context/max_turns is exhausted mid-work (CLI reports success but command didn't finish).
    // Applies to any command with an expected status mapping (fc, fl, run).
    // incompleteRetryExhausted is always false — incomplete termination now hands off
    // to terminal resume instead of retrying. Kept as const for downstream conditionals.
    const incompleteRetryExhausted = false;
    const expectedStatus = EXPECTED_STATUS_AFTER_COMMAND[execution.command];
    if (
      chainContinues &&
      !isLastChainStep &&
      expectedStatus &&
      (!execution._hadInputWait || execution._resumedAnswer)
    ) {
      const currentStatus = this.fileWatcher?.statusCache.get(execution.featureId);
      if (
        currentStatus &&
        currentStatus !== expectedStatus &&
        !isStatusBeyond(currentStatus, expectedStatus) &&
        currentStatus !== '[BLOCKED]' &&
        !(execution.command === 'fl' && currentStatus === '[DRAFT]')
      ) {
        // Check if user action is required — skip retry, hand off to terminal instead
        const userActionReason = this._detectUserActionRequired(execution);
        if (userActionReason) {
          const cmdUpper = execution.command.toUpperCase();
          claudeLog.info(
            `[Chain] ${cmdUpper} incomplete termination for F${execution.featureId}: ` +
              `user action required (${userActionReason}). Handing off to terminal.`,
          );
          this._pushLog(execution, {
            line: `[Chain] ${cmdUpper} incomplete — ${userActionReason}. Terminal resume recommended.`,
            timestamp: nowJSTISO(),
            level: 'warning',
          });
          if (execution.command === 'run') {
            execution.terminalActive = true;
            execution.terminalActiveAt = Date.now();
            claudeLog.info(
              `[Queue] Terminal-active: F${execution.featureId} (run-lock + chain-slot held)`,
            );
          }
          execution.process = null;
          execution.stdin = null;
          this._handoffToTerminal(execution, `${cmdUpper} incomplete — ${userActionReason}`);
          return;
        }
        // Command completed but didn't change status — incomplete termination
        // Hand off to terminal for resume instead of spawning a fresh session.
        // With 1M context, fresh retries are wasteful: they restart Progressive Disclosure
        // from Phase 1 and hit the same blockers. Terminal resume continues the existing session.
        const cmdUpper = execution.command.toUpperCase();
        claudeLog.info(
          `[Chain] ${cmdUpper} incomplete termination detected for F${execution.featureId}: status still ${currentStatus} (expected ${expectedStatus}). Handing off to terminal for resume.`,
        );
        this._pushLog(execution, {
          line: `[Chain] ${cmdUpper} completed without status change (${currentStatus}). Terminal resume for continuation.`,
          timestamp: nowJSTISO(),
          level: 'warning',
        });
        if (execution.command === 'run') {
          execution.terminalActive = true;
          execution.terminalActiveAt = Date.now();
          claudeLog.info(
            `[Queue] Terminal-active: F${execution.featureId} (run-lock + chain-slot held)`,
          );
        }
        execution.process = null;
        execution.stdin = null;
        this._handoffToTerminal(
          execution,
          `${cmdUpper} incomplete — status still ${currentStatus}`,
        );
        return;
      }
    }

    const currentStatusForWaiter = this.fileWatcher?.statusCache.get(execution.featureId);
    const isBlocked = currentStatusForWaiter === '[BLOCKED]';
    const isDraftAfterFl = execution.command === 'fl' && currentStatusForWaiter === '[DRAFT]';

    if (
      chainContinues &&
      !isLastChainStep &&
      !incompleteRetryExhausted &&
      !isBlocked &&
      !isDraftAfterFl &&
      !execution.chainCutRequested &&
      (!execution._hadInputWait || execution._resumedAnswer)
    ) {
      this.chainExecutor.registerWaiter(execution);
    } else if (execution.chain?.enabled) {
      this._releaseChainSlot(execution);
    }

    if (
      (!chainContinues ||
        isLastChainStep ||
        incompleteRetryExhausted ||
        isBlocked ||
        isDraftAfterFl ||
        execution.chainCutRequested) &&
      !execution.waitingForInput &&
      !execution.inputRequired &&
      (!execution._hadInputWait || execution._resumedAnswer)
    ) {
      // Chain complete (last step), chain stopped, or non-chain execution - send email
      // Skip if waiting for user input or had input-wait — input-wait email already sent
      const chainHistory = execution.chain?.history || [];
      const isContextRetryExhausted =
        execution.chain?.contextRetryCount >= MAX_RETRIES && isContextExhausted;
      const currentResult = execution.chainCutRequested
        ? 'chain-cut'
        : execution.accountLimitHit
          ? 'account-limit'
          : isFlRetryExhausted
            ? 'retry-exhausted'
            : isContextRetryExhausted
              ? 'context-retry-exhausted'
              : incompleteRetryExhausted
                ? 'incomplete-retry-exhausted'
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

    // Release run-lock for adopted session failures (no fileWatcher status-change to trigger release)
    if (
      execution.origin === 'adopted' &&
      execution.command === 'run' &&
      exitCode !== 0 &&
      this.runLockFeatureId === execution.featureId
    ) {
      this._releaseRunLock(execution.featureId, 'adopt-completion-failure');
    }

    // Sync active imp IDs — execution status changed, update featureService promotion state
    this._syncActiveImpIds();

    this._dequeueNext();

    // Continue draining rate limit retry queue after successful retry completion
    if (execution._rateLimitQueueContinue && !execution.accountLimitHit) {
      this.retryManager.continueQueueDrain(execution);
    }

    // Per-execution completion callback (e.g., update analysis)
    if (execution._onComplete) {
      try {
        execution._onComplete(execution, exitCode);
      } catch (err) {
        claudeLog.error(`[ClaudeService] _onComplete callback error: ${err.message}`);
      }
    }

    // Auto-handoff: update-analysis → terminal resume on success
    if (
      execution.command === 'update-analysis' &&
      exitCode === 0 &&
      execution.sessionId &&
      execution.status !== 'handed-off'
    ) {
      this._handoffToTerminal(execution, 'Update analysis complete — auto-resume');
    }

    // Notify listeners (e.g., auto-DR) that an execution finished
    this.onExecutionComplete?.(execution);
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
    // Run-lock released ONLY on terminal statuses ([DONE]/[CANCELLED])
    if (
      (newStatus === '[DONE]' || newStatus === '[CANCELLED]') &&
      !this._hasTerminalActive(featureId)
    ) {
      this._releaseRunLock(featureId, newStatus);
    }
    // Dep resolution: invalidate cache for fresh dep check, then re-evaluate queue
    if (newStatus === '[DONE]' || newStatus === '[CANCELLED]') {
      this._resolveTerminalActive(featureId, newStatus);
      this.featureService?.invalidateCache();
      this._dequeueNext();
    }
  }

  // ═══════════════════════════════════════
  // SECTION: Lock Management
  // ═══════════════════════════════════════

  /**
   * Check if a /run command is blocked by another running /run.
   * Only /run commands are exclusive — fc/fl/imp can run concurrently.
   * Same-feature bypass: retries for the locked feature are allowed through.
   * @param {string} command
   * @param {string} [featureId] - Feature ID to check same-feature bypass
   * @returns {boolean}
   */
  _isRunBlocked(command, featureId) {
    if (command !== 'run') return false;
    if (this.runLockFeatureId) {
      if (featureId && this.runLockFeatureId === featureId) return false;
      return true;
    }
    // Fallback: check for any running /run execution (different feature)
    for (const exec of this.executions.values()) {
      if (exec.command === 'run' && exec.status === 'running' && exec.featureId !== featureId)
        return true;
    }
    return false;
  }

  /**
   * Manually acquire run-lock (DR recovery).
   * Post-DR both runLockFeatureId and executions map are lost,
   * so no running-/run check is needed (unlike DELETE which guards against it).
   */
  acquireRunLock(featureId) {
    const validatedId = validateFeatureId(featureId);
    if (this.runLockFeatureId) {
      const err = new Error(`Run-lock already held by F${this.runLockFeatureId}`);
      err.status = 409;
      throw err;
    }
    this.runLockFeatureId = validatedId;
    claudeLog.info(`[Queue] Run-lock manually acquired: F${validatedId}`);
    this._broadcastQueueUpdate();
  }

  /**
   * Release run-lock on terminal status ([DONE]/[CANCELLED]) only.
   * Called from fileWatcher status-change events.
   * @param {string} featureId
   * @param {string} newStatus - e.g. '[DONE]', '[BLOCKED]', '[REVIEWED]'
   */
  _releaseRunLock(featureId, newStatus) {
    if (this.runLockFeatureId === featureId) {
      claudeLog.info(`[Queue] Run-lock released: F${featureId} → ${newStatus}`);
      this.runLockFeatureId = null;
      this._dequeueNext();
    }
  }

  _releaseChainSlot(execution) {
    if (!execution.chain?.enabled) return false;
    const rootId = execution.chainParentId || execution.id;
    const released = this.chainSlots.delete(rootId);
    if (released) {
      claudeLog.info(`[Queue] Chain slot released: ${rootId}`);
      this._dequeueNext();
    }
    return released;
  }

  /**
   * Check if a feature has a terminal-active execution holding locks.
   */
  _hasTerminalActive(featureId) {
    for (const exec of this.executions.values()) {
      if (exec.featureId === featureId && exec.terminalActive) return true;
    }
    return false;
  }

  /**
   * Resolve terminal-active state when feature status changes to [DONE] or [CANCELLED].
   * Chain slot is kept held for imp inheritance (via chainParentId), or released if no chain.
   * Run-lock is released AFTER registerWaiter to avoid _dequeueNext race.
   */
  _resolveTerminalActive(featureId, newStatus) {
    let terminalExec = null;
    for (const exec of this.executions.values()) {
      if (exec.featureId === featureId && exec.terminalActive) {
        terminalExec = exec;
        break;
      }
    }
    if (!terminalExec) return;

    terminalExec.terminalActive = false;
    claudeLog.info(`[Queue] Terminal-active resolved: F${featureId} → ${newStatus}`);

    if (newStatus === '[DONE]' && terminalExec.chain?.enabled) {
      // Register waiter for chain continuation (imp enqueue).
      // Chain slot stays held — imp inherits it via chainParentId
      this.chainExecutor.registerWaiter(terminalExec);
      // Release run-lock AFTER registerWaiter to prevent _dequeueNext
      // from letting another /run slip in before imp is enqueued.
      this._releaseRunLock(featureId, `terminal-${newStatus}`);
      return;
    }

    // [CANCELLED] or no chain → release both locks
    this._releaseChainSlot(terminalExec);
    this._releaseRunLock(featureId, `terminal-${newStatus}`);
  }

  _belongsToActiveChain(exec) {
    if (!exec.chain?.enabled) return false;
    // Chain roots always "belong to a chain" for slot limit purposes,
    // even if their slot was released (dep-blocked at queue time).
    // Without this, dep-resolved chain roots get reduced limit
    // (maxConcurrent - idleChainSlots) and may never dequeue.
    if (!exec.chainParentId) return true;
    return this.chainSlots.has(exec.chainParentId);
  }

  _countIdleChainSlots() {
    let count = 0;
    for (const rootId of this.chainSlots) {
      let hasRunning = false;
      for (const exec of this.executions.values()) {
        const execRoot = exec.chainParentId || (exec.chain?.enabled ? exec.id : null);
        if (exec.status === 'running' && execRoot === rootId) {
          hasRunning = true;
          break;
        }
      }
      if (!hasRunning) count++;
    }
    return count;
  }

  // ═══════════════════════════════════════
  // SECTION: Queue Management
  // ═══════════════════════════════════════

  /**
   * Get unresolved dependency IDs for a feature.
   * Reuses featureService.getAllFeatures() (2s cache) as single source of truth.
   * Returns null on error (fail-closed: treat as blocked).
   * @param {string} featureId
   * @param {Array} [cachedFeatures] - Optional pre-fetched features array for batch use
   * @returns {string[]|null} Pending dep IDs, empty array if none, null on error
   */
  _getPendingDeps(featureId, cachedFeatures = null, { skipImpBlocking = false } = {}) {
    if (!this.featureService) return [];
    if (!featureId) return [];
    try {
      const features = cachedFeatures || this.featureService.getAllFeatures().features;
      const feature = features.find((f) => f.id === String(featureId));
      if (!feature?.pendingDeps && !feature?.dependsOn) return [];

      // 1. Status-based pending deps (existing logic)
      const pending = feature.pendingDeps
        ? feature.pendingDeps
            .split(',')
            .map((d) => d.trim().replace(/\D/g, ''))
            .filter(Boolean)
        : [];

      // 2. Imp-execution-based blocking: resolved deps with active imp still pending
      // Skipped for retroactive dep-violation checks to avoid race conditions where
      // an /imp starts on a [DONE] dep after downstream was already dequeued.
      if (!skipImpBlocking && feature.dependsOn) {
        const allDepIds = feature.dependsOn
          .split(',')
          .map((d) => d.trim().replace(/\D/g, ''))
          .filter(Boolean);
        const resolvedDepIds = allDepIds.filter((id) => !pending.includes(id));

        for (const [, exec] of this.executions) {
          if (
            exec.command === 'imp' &&
            (exec.status === 'running' || exec.status === 'queued') &&
            resolvedDepIds.includes(String(exec.featureId))
          ) {
            pending.push(String(exec.featureId));
          }
        }
      }

      return pending;
    } catch (err) {
      claudeLog.error(`[DepCheck] Failed for F${featureId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Build a map of featureId -> count of features that depend on it.
   * Uses dependsOn field from all features (direct dependants only).
   * @param {Array|null} cachedFeatures
   * @returns {Map<string, number>} featureId -> dependant count
   */
  _buildDependantCounts(cachedFeatures) {
    const counts = new Map();
    if (!cachedFeatures) return counts;
    for (const f of cachedFeatures) {
      if (!f.dependsOn) continue;
      const depIds = f.dependsOn
        .split(',')
        .map((d) => d.trim().replace(/\D/g, ''))
        .filter(Boolean);
      for (const depId of depIds) {
        counts.set(depId, (counts.get(depId) || 0) + 1);
      }
    }
    return counts;
  }

  _canStartNow(execution) {
    if (this._isRunBlocked(execution.command, execution.featureId)) return false;
    // Block if feature has unresolved dependencies (fail-closed: null = blocked)
    const pendingDeps = this._getPendingDeps(execution.featureId);
    if (pendingDeps === null || pendingDeps.length > 0) return false;
    // If this is a /run and there's already a queued /run with higher priority (e.g. [WIP] retry),
    // defer to queue so priority ordering is respected
    if (execution.command === 'run') {
      const execStatus =
        this.fileWatcher?.statusCache?.get(String(execution.featureId)) || '[DRAFT]';
      const execPriority = STATUS_PRIORITY[execStatus] ?? 99;
      for (const qId of this.queue) {
        const qExec = this.executions.get(qId);
        if (qExec && qExec.command === 'run' && qExec.status === 'queued') {
          const qStatus = this.fileWatcher?.statusCache?.get(String(qExec.featureId)) || '[DRAFT]';
          const qPriority = STATUS_PRIORITY[qStatus] ?? 99;
          if (qPriority < execPriority) return false; // Higher priority /run waiting in queue
        }
      }
    }
    const belongsToChain = this._belongsToActiveChain(execution);
    const idleChainSlots = this._countIdleChainSlots();
    const limit = belongsToChain ? this.maxConcurrent : this.maxConcurrent - idleChainSlots;
    return this.runningCount < limit;
  }

  _dequeueNext() {
    if (this.retryManager.isRateLimitPaused) {
      claudeLog.info('[Queue] Dequeue blocked — rate limit retry pending');
      return;
    }
    if (this.retryManager.isServerErrorPaused) {
      claudeLog.info('[Queue] Dequeue blocked — server error retry pending');
      return;
    }
    // Fetch features once for batch dep-check (avoids N cache lookups per iteration)
    let cachedFeatures = null;
    try {
      cachedFeatures = this.featureService?.getAllFeatures()?.features;
    } catch {
      // featureService unavailable — dep check will fail-closed per item
    }
    const dependantCounts = this._buildDependantCounts(cachedFeatures);

    while (this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
      // Purge non-queued items (cancelled, already started, etc.)
      this.queue = this.queue.filter((id) => {
        const exec = this.executions.get(id);
        return exec && exec.status === 'queued';
      });

      // Recalculate idle chain slots each iteration (may change as items dequeue)
      const idleChainSlots = this._countIdleChainSlots();

      // Find highest-priority item that can start now
      // Sort candidates by status priority (WIP > REVIEWED > PROPOSED > DRAFT)
      // so advanced features dequeue before earlier-stage ones regardless of queue order
      const startableIndices = [];
      for (let i = 0; i < this.queue.length; i++) {
        const exec = this.executions.get(this.queue[i]);
        if (this._isRunBlocked(exec.command, exec.featureId)) continue;

        // Bypass dep-gating for adopted sessions (already ran externally)
        if (exec.origin !== 'adopted') {
          // Skip if dep check fails (null = fail-closed) or has pending deps
          const pendingDeps = this._getPendingDeps(exec.featureId, cachedFeatures);
          if (pendingDeps === null || pendingDeps.length > 0) continue;
        }

        const belongsToChain = this._belongsToActiveChain(exec);
        const limit = belongsToChain ? this.maxConcurrent : this.maxConcurrent - idleChainSlots;
        if (this.runningCount < limit) {
          const status = this.fileWatcher?.statusCache?.get(String(exec.featureId)) || '[DRAFT]';
          const depCount = dependantCounts.get(String(exec.featureId)) || 0;
          startableIndices.push({ idx: i, priority: STATUS_PRIORITY[status] ?? 99, depCount });
        }
      }
      if (startableIndices.length === 0) break;

      // Pick highest priority (lowest number); then most dependants; then FIFO
      startableIndices.sort(
        (a, b) => a.priority - b.priority || b.depCount - a.depCount || a.idx - b.idx,
      );
      const idx = startableIndices[0].idx;

      if (idx === -1) break; // All remaining items are blocked

      const nextId = this.queue.splice(idx, 1)[0];
      const nextExec = this.executions.get(nextId);
      // Re-reserve chain slot for dep-resolved items that had it released
      if (nextExec.chain?.enabled && !nextExec.chainParentId && !this.chainSlots.has(nextExec.id)) {
        this.chainSlots.add(nextExec.id);
      }
      this._pushLog(nextExec, {
        line: 'Dequeued. Starting execution...',
        timestamp: nowJSTISO(),
        level: 'info',
      });
      const depCount = dependantCounts.get(String(nextExec.featureId)) || 0;
      claudeLog.info(
        `[Queue] Dequeued F${nextExec.featureId} ${nextExec.command} (exec: ${nextExec.id}, depCount: ${depCount})`,
      );
      this._startExecution(nextExec);
    }
    this._broadcastQueueUpdate();
  }

  /**
   * Check running executions for retroactive dependency violations.
   * Called on features-updated to catch deps added after execution started.
   * Kills violating executions immediately.
   */
  _checkRunningDepViolations() {
    for (const [executionId, exec] of this.executions) {
      if (exec.status !== 'running') continue;
      // Slash commands and update-analysis are dep-exempt (no featureId)
      if (SLOT_EXEMPT_COMMANDS.has(exec.command)) continue;

      // Skip imp-blocking: retroactive violation check should only catch
      // status-based dep changes (e.g., dep reverted from [DONE]), not /imp
      // executions that started after this execution was already dequeued.
      const pendingDeps = this._getPendingDeps(exec.featureId, null, { skipImpBlocking: true });
      if (pendingDeps && pendingDeps.length > 0) {
        const depList = pendingDeps.map((d) => `F${d}`).join(', ');
        claudeLog.warn(
          `[DepViolation] F${exec.featureId} ${exec.command} has unresolved deps ` +
            `[${depList}] — killing execution ${executionId}`,
        );
        this.logStreamer?.broadcastAll({
          type: 'dep-violation',
          executionId,
          featureId: exec.featureId,
          command: exec.command,
          pendingDeps: pendingDeps.map((d) => `F${d}`),
          timestamp: nowJSTISO(),
        });
        this.killExecution(executionId);
      }
    }
  }

  /**
   * Initialize dependency tracking map from current feature state.
   * Must be called after featureService is wired to prevent false positives on startup.
   */
  initializeDepsMap() {
    try {
      const { features } = this.featureService?.getAllFeatures() || { features: [] };
      for (const f of features) {
        this._previousDepsMap.set(String(f.id), f.dependsOn || '');
      }
      claudeLog.info(
        `[AutoQueue] Initialized deps tracking for ${this._previousDepsMap.size} features`,
      );
    } catch (err) {
      claudeLog.error(`[AutoQueue] Failed to initialize deps map: ${err.message}`);
    }
  }

  /**
   * Auto-queue [DRAFT] features that gained new dependencies.
   * Called on features-updated to detect fdep add → auto-queue pattern.
   * Triggers when dependency ID set grows (compares normalized IDs, ignoring bold markers).
   * @returns {string[]} Array of queued execution IDs
   */
  _autoQueueDraftsWithDeps() {
    if (!this.featureService) return [];
    try {
      const { features } = this.featureService.getAllFeatures();
      const autoQueued = [];
      const extractDepIds = (deps) =>
        (deps || '').replace(/\*\*/g, '').match(/F\d+/g)?.sort().join(',') || '';
      const hasNewDeps = (currentIds, previousIds) => {
        if (!currentIds) return false;
        if (!previousIds) return true;
        const prevSet = new Set(previousIds.split(','));
        return currentIds.split(',').some((id) => !prevSet.has(id));
      };

      for (const f of features) {
        const featureId = String(f.id);
        const currentDeps = f.dependsOn || '';
        const previousDeps = this._previousDepsMap.get(featureId) || '';

        // Always update tracking map
        this._previousDepsMap.set(featureId, currentDeps);

        // Auto-queue [DRAFT] features that gained new dependencies
        if (f.status !== '[DRAFT]') continue;
        if (!currentDeps) continue;
        const currentIds = extractDepIds(currentDeps);
        const previousIds = extractDepIds(previousDeps);
        if (!hasNewDeps(currentIds, previousIds)) continue;

        // Check not already running or queued
        let alreadyActive = false;
        for (const exec of this.executions.values()) {
          if (
            String(exec.featureId) === featureId &&
            (exec.status === 'running' || exec.status === 'queued')
          ) {
            alreadyActive = true;
            break;
          }
        }
        if (alreadyActive) continue;

        try {
          const executionId = this.executeCommand(featureId, 'fc', { chain: true });
          autoQueued.push(executionId);
          const reason = previousIds ? 'deps-changed' : 'deps-added';
          claudeLog.info(`[AutoQueue] F${featureId} auto-queued (${reason}: ${currentDeps})`);
          this.logStreamer?.broadcastAll({
            type: 'auto-queued',
            featureId,
            executionId,
            reason,
            dependsOn: currentDeps,
            timestamp: nowJSTISO(),
          });
        } catch (err) {
          claudeLog.warn(`[AutoQueue] F${featureId} failed to auto-queue: ${err.message}`);
        }
      }

      return autoQueued;
    } catch (err) {
      claudeLog.error(`[AutoQueue] Failed: ${err.message}`);
      return [];
    }
  }

  _broadcastQueueUpdate() {
    this.logStreamer?.broadcastAll({
      type: 'queue-updated',
      ...this.getQueueStatus(),
      timestamp: nowJSTISO(),
    });
  }

  getQueueStatus() {
    const running = [];
    const queued = [];
    let waitingForInputCount = 0;
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
      if (exec.waitingForInput || exec.inputRequired) {
        waitingForInputCount++;
      }
    }
    // Fetch features once for batch dep-check
    let cachedFeatures = null;
    try {
      cachedFeatures = this.featureService?.getAllFeatures()?.features;
    } catch {
      // featureService unavailable — depBlocked will default to false
    }
    const dependantCounts = this._buildDependantCounts(cachedFeatures);
    for (const qId of this.queue) {
      const exec = this.executions.get(qId);
      if (exec) {
        const status = this.fileWatcher?.statusCache?.get(String(exec.featureId)) || '[DRAFT]';
        const pendingDeps = this._getPendingDeps(exec.featureId, cachedFeatures);
        queued.push({
          id: exec.id,
          featureId: exec.featureId,
          command: exec.command,
          priority: STATUS_PRIORITY[status] ?? 99,
          dependantCount: dependantCounts.get(String(exec.featureId)) || 0,
          depBlocked: pendingDeps !== null && pendingDeps.length > 0,
          pendingDeps: pendingDeps ? pendingDeps.map((d) => `F${d}`) : [],
        });
      }
    }
    // Sort by status priority so FE WAIT# reflects actual dequeue order
    queued.sort((a, b) => a.priority - b.priority || b.dependantCount - a.dependantCount);
    return {
      maxConcurrent: this.maxConcurrent,
      runningCount: running.length,
      queuedCount: queued.length,
      chainWaiterCount: this.chainExecutor.chainWaiters.size,
      chainWaiters: Array.from(this.chainExecutor.chainWaiters.entries()).map(
        ([featureId, waiter]) => ({
          featureId,
          executionId: waiter.executionId,
          registeredAt: toJSTISO(new Date(waiter.registeredAt)),
        }),
      ),
      waitingForInputCount,
      running,
      queued,
      rateLimitQueue: this.retryManager._rateLimitRetryQueue.map((entry) => ({
        executionId: entry.execution.id,
        featureId: entry.execution.featureId,
        command: entry.execution.command,
        queuedAt: toJSTISO(new Date(entry.queuedAt)),
      })),
      rateLimitRetryAt: this.retryManager._rateLimitRetryAt,
      serverErrorQueue: this.retryManager._serverErrorRetryQueue.map((entry) => ({
        executionId: entry.execution.id,
        featureId: entry.execution.featureId,
        command: entry.execution.command,
        retryCount: entry.retryCount,
        queuedAt: toJSTISO(new Date(entry.queuedAt)),
      })),
      serverErrorRetryAt: this.retryManager._serverErrorRetryAt,
      chainSlotCount: this.chainSlots.size,
      idleChainSlotCount: this._countIdleChainSlots(),
      chainSlotHolders: Array.from(this.chainSlots).map((rootId) => {
        const exec = this.executions.get(rootId);
        return {
          executionId: rootId,
          featureId: exec?.featureId ?? '?',
          command: exec?.command ?? '?',
          status: exec?.status ?? 'unknown',
        };
      }),
    };
  }

  clearQueue() {
    const cleared = [];
    while (this.queue.length > 0) {
      const id = this.queue.shift();
      const exec = this.executions.get(id);
      if (exec) {
        exec.status = 'cancelled';
        exec.completedAt = nowJSTISO();
        this._releaseChainSlot(exec);
        cleared.push(id);
        this.logStreamer?.broadcastAll({
          type: 'status',
          executionId: id,
          status: 'cancelled',
        });
      }
    }
    this._broadcastQueueUpdate();
    return cleared;
  }

  cancelQueueItem(executionId) {
    const idx = this.queue.indexOf(executionId);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    const exec = this.executions.get(executionId);
    if (exec) {
      exec.status = 'cancelled';
      exec.completedAt = nowJSTISO();
      this._releaseChainSlot(exec);
      this.logStreamer?.broadcastAll({
        type: 'status',
        executionId,
        status: 'cancelled',
      });
    }
    this._broadcastQueueUpdate();
    return true;
  }

  /**
   * Bulk queue features based on their current status.
   * @param {string[]} featureIds - Array of feature IDs (already deduplicated and validated)
   * @returns {{ queued: Array<{id, featureId, command}>, skipped: Array<{featureId, reason}> }}
   */
  bulkQueue(featureIds) {
    // Build a set of featureIds that already have running or queued executions
    const activeFeatureIds = new Set();
    for (const exec of this.executions.values()) {
      if (exec.status === 'running' || exec.status === 'queued') {
        activeFeatureIds.add(String(exec.featureId));
      }
    }

    const queued = [];
    const skipped = [];

    // Build dependant counts for priority sorting
    let cachedFeatures = null;
    try {
      cachedFeatures = this.featureService?.getAllFeatures()?.features;
    } catch {
      /* featureService unavailable — depCount defaults to 0 */
    }
    const dependantCounts = this._buildDependantCounts(cachedFeatures);

    // Sort by status priority, then dependant count (most dependants first)
    const sortedIds = [...featureIds].sort((a, b) => {
      const statusA = this.fileWatcher?.statusCache?.get(String(a)) || '[DRAFT]';
      const statusB = this.fileWatcher?.statusCache?.get(String(b)) || '[DRAFT]';
      const priDiff = (STATUS_PRIORITY[statusA] ?? 99) - (STATUS_PRIORITY[statusB] ?? 99);
      if (priDiff !== 0) return priDiff;
      const depCountA = dependantCounts.get(String(a)) || 0;
      const depCountB = dependantCounts.get(String(b)) || 0;
      return depCountB - depCountA;
    });

    for (const featureId of sortedIds) {
      const featureIdStr = String(featureId);

      // Already running or queued
      if (activeFeatureIds.has(featureIdStr)) {
        skipped.push({ featureId: featureIdStr, reason: 'already running or queued' });
        continue;
      }

      // Skip features with terminal-active session (holding run-lock or chain-slot)
      if (this._hasTerminalActive(featureIdStr)) {
        skipped.push({ featureId: featureIdStr, reason: 'terminal-active session holding lock' });
        continue;
      }

      // Skip the feature holding run-lock (terminal-resumed /run in progress)
      if (this.runLockFeatureId === featureIdStr) {
        skipped.push({ featureId: featureIdStr, reason: 'run-lock held (terminal session)' });
        continue;
      }

      // Look up status from file watcher cache
      const status = this.fileWatcher?.statusCache.get(featureIdStr);
      if (!status) {
        claudeLog.error(
          `[bulkQueue] F${featureIdStr} status unknown — not in fileWatcher.statusCache. Feature file may have malformed Status line`,
        );
        skipped.push({
          featureId: featureIdStr,
          reason: 'status unknown (cache miss — check Status line format)',
        });
        continue;
      }

      // Look up command from status mapping
      const command = STATUS_TO_FIRST_COMMAND[status];
      if (!command) {
        skipped.push({
          featureId: featureIdStr,
          reason: `status is ${status} — queue individually`,
        });
        continue;
      }

      // Attempt to queue the execution
      // (executeCommand handles chain slot release for dep-blocked items)
      try {
        const executionId = this.executeCommand(featureIdStr, command, { chain: true });
        queued.push({ id: executionId, featureId: featureIdStr, command });

        // Emit chain-blocked for FE notification if dep-blocked
        const pendingDeps = this._getPendingDeps(featureIdStr);
        if (pendingDeps && pendingDeps.length > 0) {
          this.logStreamer?.broadcastAll({
            type: 'chain-blocked',
            featureId: featureIdStr,
            pendingDeps: pendingDeps.map((d) => `F${d}`).join(', '),
            timestamp: nowJSTISO(),
          });
        }
      } catch (err) {
        skipped.push({ featureId: featureIdStr, reason: err.message });
      }
    }

    return { queued, skipped };
  }

  // ═══════════════════════════════════════
  // SECTION: Execution CRUD
  // ═══════════════════════════════════════

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
      ccsProfile: exec.ccsProfile || null,
      serverErrorHit: exec.serverErrorHit || false,
      chain: exec.chain
        ? {
            enabled: exec.chain.enabled,
            retryCount: exec.chain.retryCount,
            contextRetryCount: exec.chain.contextRetryCount,
            incompleteRetryCount: exec.chain.incompleteRetryCount,
            serverErrorRetryCount: exec.chain.serverErrorRetryCount,
            history: exec.chain.history,
          }
        : null,
      chainParentId: exec.chainParentId,
      chainCutRequested: exec.chainCutRequested || false,
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

  getDiagnostics(executionId) {
    const exec = this.executions.get(executionId);
    if (!exec) return null;
    return {
      execution: this.getExecution(executionId),
      subscribers: this.logStreamer?.getSubscribers(executionId) || { count: 0, clients: [] },
      chain: {
        parentId: exec.chainParentId || null,
        retryCount: exec.chain?.retryCount || 0,
        contextRetryCount: exec.chain?.contextRetryCount || 0,
        history: exec.chain?.history || [],
      },
      queuePosition: this.queue?.indexOf(executionId) ?? -1,
    };
  }

  /**
   * Remove a completed execution from memory.
   * Only removes if execution has completedAt set (finished).
   * Running executions are protected — use killExecution() instead.
   */
  removeExecution(id) {
    const exec = this.executions.get(id);
    if (!exec) return false;
    if (!exec.completedAt) return false; // Protect running/incomplete executions
    this.streamParser.clearRingBuffer(id);
    this.executions.delete(id);
    return true;
  }

  chainCut(executionId) {
    const exec = this.executions.get(executionId);
    if (!exec) return { success: false, reason: 'not-found' };
    if (!exec.chain?.enabled) return { success: false, reason: 'not-chain' };
    if (exec.chainCutRequested) return { success: false, reason: 'already-requested' };
    if (exec.status !== 'running') return { success: false, reason: 'not-running' };

    exec.chainCutRequested = true;
    // Edge case: waiter already registered (process exited, handleStatusChanged pending)
    this.chainExecutor.deleteWaiter(exec.featureId);

    this._pushLog(exec, {
      line: '[Chain] Chain-cut requested. Current command will finish, chain will not advance.',
      timestamp: nowJSTISO(),
      level: 'warning',
    });

    this.logStreamer?.broadcastAll({
      type: 'chain-cut',
      featureId: exec.featureId,
      executionId,
      command: exec.command,
      timestamp: nowJSTISO(),
    });

    claudeLog.info(
      `[Chain] Chain-cut requested for F${exec.featureId} after ${exec.command} (exec: ${executionId})`,
    );
    return { success: true };
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
    this._releaseChainSlot(exec);

    // Remove from retry queues if queued
    this.retryManager.removeFromRetryQueues(executionId);

    if (exec.status === 'queued') {
      this.queue = this.queue.filter((id) => id !== executionId);
      exec.status = 'cancelled';
      exec.completedAt = nowJSTISO();
      this._releaseChainSlot(exec);
      this.logStreamer?.broadcastAll({
        type: 'status',
        executionId,
        status: 'cancelled',
      });
      this._broadcastQueueUpdate();
      this._dequeueNext();
      return true;
    }

    if (exec.status === 'running' && exec.process) {
      exec.killedByUser = true;
      this._killProcess(exec.process);
      return true;
    }

    // Process already dead but status still 'running' (e.g. killed for AskUserQuestion)
    if (exec.status === 'running' && !exec.process) {
      exec.killedByUser = true;
      exec.status = 'cancelled';
      exec.completedAt = nowJSTISO();
      this._releaseChainSlot(exec);
      exec._killedForAskUser = false;
      exec.inputRequired = null;
      exec.waitingForInput = false;
      if (exec.stallCheckInterval) {
        clearInterval(exec.stallCheckInterval);
        exec.stallCheckInterval = null;
      }
      this.logStreamer?.broadcastAll({
        type: 'status',
        executionId,
        status: 'cancelled',
      });
      this._dequeueNext();
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
    // Clean up retry state
    this.retryManager.clearAll();
    this.chainSlots.clear();

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

  // Resume/session methods delegated to ResumeManager
  resumeInBrowser(executionId, prompt) {
    return this.resumeManager.resumeInBrowser(executionId, prompt);
  }
  answerInBrowser(executionId, answer, options) {
    return this.resumeManager.answerInBrowser(executionId, answer, options);
  }
  resumeInTerminal(executionId) {
    return this.resumeManager.resumeInTerminal(executionId);
  }
  resumeRemote(executionId, reason) {
    return this.resumeManager.resumeRemote(executionId, reason);
  }
  _schedulePromoAutoAnswer(execution, answer, reason, delayMs, options) {
    return this.resumeManager.schedulePromoAutoAnswer(execution, answer, reason, delayMs, options);
  }
  _writeResumeContext(exec) {
    return this.resumeManager._writeResumeContext(exec);
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
      waitingForInput: e.waitingForInput || false,
      waitingInputPattern: e.waitingInputPattern || null,
      inputRequired: e.inputRequired
        ? { questions: e.inputRequired.questions, context: e.inputContext }
        : null,
      isStalled: e.isStalled || false,
      ccsProfile: e.ccsProfile || null,
      chain: e.chain
        ? {
            enabled: e.chain.enabled,
            retryCount: e.chain.retryCount,
            contextRetryCount: e.chain.contextRetryCount,
            incompleteRetryCount: e.chain.incompleteRetryCount,
            serverErrorRetryCount: e.chain.serverErrorRetryCount,
            history: e.chain.history,
          }
        : null,
      chainParentId: e.chainParentId || null,
      chainCutRequested: e.chainCutRequested || false,
    }));
  }

  // Shell/debug command methods delegated to ShellExecutor
  runShellCommand(command) {
    return this.shellExecutor.runShellCommand(command);
  }
  getShellStates() {
    return this.shellExecutor.getShellStates();
  }
  executeSlashCommand(slashCommand, onComplete = null) {
    return this.shellExecutor.executeSlashCommand(slashCommand, onComplete);
  }
  executeDebugPrompt(prompt) {
    return this.shellExecutor.executeDebugPrompt(prompt);
  }
  executeUpdateAnalysis(prompt, onComplete) {
    return this.shellExecutor.executeUpdateAnalysis(prompt, onComplete);
  }

  /** Clean up resources (clear intervals) */
  dispose() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }
}
