/**
 * RetryManager — Extracted retry logic from ClaudeService.
 *
 * Handles rate limit (429) retries with profile switching and timed backoff,
 * and server error (500/529) retries with exponential backoff.
 *
 * Uses DI pattern (same as ChainExecutor): constructor receives deps object
 * with callbacks to ClaudeService methods.
 */

import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { claudeLog } from '../utils/logger.js';
import { nowJSTISO, toJSTISO, msToJSTISO } from '../utils/timeUtils.js';
import {
  RETRY_DELAY_MS,
  STALL_CHECK_INTERVAL_MS,
  RATE_LIMIT_RETRY_BUFFER_MS,
  RATE_LIMIT_SAFE_THRESHOLD,
  MAX_PROFILE_SWITCHES,
  MAX_SERVER_ERROR_RETRIES,
  SERVER_ERROR_BACKOFF_MS,
} from '../config.js';
import { getCcsProfiles } from './ccsUtils.js';

export class RetryManager {
  /**
   * @param {Object} deps - Dependency injection
   * @param {Function} deps.executeCommand - (featureId, command, opts) => executionId
   * @param {Function} deps.getExecution - (id) => execution object
   * @param {Function} deps.releaseChainSlot - (execution) => void
   * @param {Function} deps.dequeueNext - () => void
   * @param {Function} deps.broadcastAll - (msg) => void
   * @param {Function} deps.broadcastState - (exec) => void
   * @param {Function} deps.pushLog - (exec, entry) => void
   * @param {Function} deps.broadcastQueueUpdate - () => void
   * @param {Function} deps.saveHistoryEntry - (exec) => void
   * @param {Function} deps.getCcsProfile - () => string
   * @param {Function} deps.buildClaudeEnv - (exec) => env object
   * @param {Function} deps.checkStall - (exec) => void
   * @param {Function} deps.attachStdoutHandler - (exec, proc) => void
   * @param {Function} deps.attachStderrHandler - (exec, proc) => void
   * @param {Function} deps.handleCompletion - (exec, exitCode, error?) => void
   * @param {Function} deps.setShellState - (command, success) => void
   * @param {Function} [deps.processNextInQueue] - Override for _processNextInQueue (test mocking)
   * @param {Function} [deps.startRateLimitRetry] - Override for _startRateLimitRetry (test mocking)
   * @param {Object} deps.streamParser - StreamParser instance
   * @param {string} deps.tmpDir - Temp directory path
   * @param {string} deps.projectRoot - Project root path
   */
  constructor(deps) {
    this.deps = deps;

    // Rate limit retry state
    this._rateLimitRetryQueue = [];
    this._rateLimitRetryTimer = null;
    this._rateLimitRetryAt = null;
    this._rateLimitPaused = false; // computed getter below

    // Server error retry state
    this._serverErrorRetryQueue = [];
    this._serverErrorRetryTimer = null;
    this._serverErrorRetryAt = null;
    this._serverErrorPaused = false; // computed getter below

    // Lazily-set services
    this.rateLimitService = null;
    this.featureService = null;
    this.emailService = null;
  }

  /** Route through deps for test mockability */
  _callProcessNextInQueue() {
    if (this.deps.processNextInQueue) {
      this.deps.processNextInQueue();
    } else {
      this._processNextInQueue();
    }
  }

  /** Route through deps for test mockability */
  _callStartRateLimitRetry(execution) {
    if (this.deps.startRateLimitRetry) {
      this.deps.startRateLimitRetry(execution);
    } else {
      this._startRateLimitRetry(execution);
    }
  }

  /** @returns {boolean} True if rate limit retry queue is non-empty (blocks dequeue) */
  get isRateLimitPaused() {
    return this._rateLimitRetryQueue.length > 0;
  }

  /** @returns {boolean} True if server error retry is pending (blocks dequeue) */
  get isServerErrorPaused() {
    return this._serverErrorRetryQueue.length > 0;
  }

  // ===========================================================================
  // Debug Log Scanning
  // ===========================================================================

  /**
   * Scan debug log file for rate limit errors (429).
   * Returns true if rate limit was detected and execution.accountLimitHit was set.
   */
  scanDebugLogForRateLimit(execution) {
    try {
      if (existsSync(execution.debugLogPath)) {
        // 16KB tail: CLI writes hooks/telemetry/session-save after 429, which can
        // push the rate_limit_error line >4KB from the end in long-running sessions
        const tail = readFileSync(execution.debugLogPath, 'utf8').slice(-16384);

        // rate_limit_error is always a conversation API error (SDK error type)
        if (/rate_limit_error/i.test(tail)) {
          execution.accountLimitHit = true;
          claudeLog.info(
            `[ClaudeService] Rate limit detected from debug log for F${execution.featureId} ${execution.command}`,
          );
          return true;
        }

        // 429.*rate.?limit needs line-level filtering to exclude telemetry endpoints
        const TELEMETRY_PATTERN =
          /client_data|event.?logging|events? failed to export|datadoghq|OTEL|telemetry/i;
        const lines = tail.split('\n');
        for (const line of lines) {
          if (/429.*rate.?limit/i.test(line) && !TELEMETRY_PATTERN.test(line)) {
            execution.accountLimitHit = true;
            claudeLog.info(
              `[ClaudeService] Rate limit detected from debug log for F${execution.featureId} ${execution.command}`,
            );
            return true;
          }
        }
      }
    } catch (err) {
      claudeLog.debug(
        `[ClaudeService] Debug log scan failed for ${execution.id}: ${err.code || err.message}`,
      );
    }
    return false;
  }

  /**
   * Scan debug log file for OAuth permission errors (403 permission_error).
   * Returns true if auth error was detected and execution.authError was set.
   */
  scanDebugLogForAuthError(execution) {
    try {
      if (existsSync(execution.debugLogPath)) {
        const tail = readFileSync(execution.debugLogPath, 'utf8').slice(-16384);
        if (/permission_error/i.test(tail)) {
          execution.authError = true;
          claudeLog.info(
            `[ClaudeService] Auth error (permission_error) detected from debug log for F${execution.featureId} ${execution.command}`,
          );
          return true;
        }
      }
    } catch (err) {
      claudeLog.debug(
        `[ClaudeService] Auth error debug log scan failed for ${execution.id}: ${err.code || err.message}`,
      );
    }
    return false;
  }

  /**
   * Scan debug log file for server errors (500/529 overloaded_error, api_error).
   * Returns true if detected and execution.serverErrorHit was set.
   */
  scanDebugLogForServerError(execution) {
    try {
      if (existsSync(execution.debugLogPath)) {
        const tail = readFileSync(execution.debugLogPath, 'utf8').slice(-16384);
        if (/overloaded_error|api_error|internal_server_error/i.test(tail)) {
          const TELEMETRY_PATTERN =
            /client_data|event.?logging|events? failed to export|datadoghq|OTEL|telemetry/i;
          const lines = tail.split('\n');
          for (const line of lines) {
            if (
              /overloaded_error|api_error|internal_server_error/i.test(line) &&
              !TELEMETRY_PATTERN.test(line)
            ) {
              execution.serverErrorHit = true;
              claudeLog.info(
                `[ServerError] Detected from debug log for F${execution.featureId} ${execution.command}`,
              );
              return true;
            }
          }
        }
      }
    } catch (err) {
      claudeLog.debug(
        `[ServerError] Debug log scan failed for ${execution.id}: ${err.code || err.message}`,
      );
    }
    return false;
  }

  // ===========================================================================
  // Rate Limit (429) Retry — Profile Switch + Timed Backoff
  // ===========================================================================

  /**
   * Schedule a rate limit retry for the failed execution.
   * Queue-based: multiple executions can be queued for retry.
   * First entry triggers Strategy 1 (profile switch) or Strategy 2 (timed retry).
   * Subsequent entries queue behind and drain sequentially after recovery.
   * @param {Object} execution - The failed execution
   * @returns {{ message: string }|null} Retry info, or null if no retry possible
   */
  scheduleRateLimitRetry(execution) {
    const isFirstEntry = this._rateLimitRetryQueue.length === 0;

    // Re-retry (was draining queue): put at front to maintain retry continuity
    if (execution._rateLimitQueueContinue) {
      this._rateLimitRetryQueue.unshift({ execution, queuedAt: Date.now() });
    } else {
      this._rateLimitRetryQueue.push({ execution, queuedAt: Date.now() });
    }
    const queuePosition = this._rateLimitRetryQueue.findIndex((e) => e.execution === execution) + 1;

    if (!isFirstEntry && this._rateLimitRetryTimer) {
      // Queue behind existing retry — Strategy 2 timer still active
      claudeLog.info(
        `[RateLimit] Queued F${execution.featureId} ${execution.command} for retry (position ${queuePosition})`,
      );
      return { message: `Queued for rate limit retry (position ${queuePosition}).` };
    }

    if (!isFirstEntry) {
      // No active timer — previous drain completed. Restart strategy.
      claudeLog.info(
        `[RateLimit] Re-queued F${execution.featureId} ${execution.command} (position ${queuePosition}) — restarting strategy`,
      );
    }

    // First entry or no active timer: try Strategy 1 (profile switch) or Strategy 2 (timed)
    const currentProfile = execution.ccsProfile || this.deps.getCcsProfile();

    // Strategy 1: Find a safe profile and switch immediately (per-execution, no global switch)
    const switchCount = execution._profileSwitchCount || 0;
    const safeProfile = this.rateLimitService?.getSafeProfile(currentProfile);
    if (safeProfile) {
      if (switchCount >= MAX_PROFILE_SWITCHES) {
        claudeLog.warn(
          `[RateLimit] Profile switch limit reached (${switchCount}/${MAX_PROFILE_SWITCHES}). Falling through to timed retry.`,
        );
        // Fall through to Strategy 2
      } else {
        execution.ccsProfile = safeProfile; // Per-execution profile switch (no global default change)
        execution.rateLimitSwitchedTo = safeProfile;
        execution._profileSwitchCount = switchCount + 1;

        claudeLog.info(
          `[RateLimit] Switched to ${safeProfile}, retrying F${execution.featureId} ${execution.command} immediately`,
        );

        setTimeout(() => {
          this._callProcessNextInQueue();
        }, RETRY_DELAY_MS);

        return {
          message: `Switching to profile ${safeProfile}, retrying in ${RETRY_DELAY_MS / 1000}s.`,
        };
      }
    }

    // Check if all profiles have weekly >= 100% — skip session reset wait, go straight to weekly reset
    const weeklyResetTime = this.rateLimitService?.getEarliestWeeklyResetIfAllExhausted?.();
    if (weeklyResetTime) {
      const retryAt = Math.max(weeklyResetTime + RATE_LIMIT_RETRY_BUFFER_MS, Date.now() + 60000);
      const delayMs = retryAt - Date.now();

      execution.rateLimitRetryAt = retryAt;
      this._rateLimitRetryAt = toJSTISO(new Date(retryAt));

      this._rateLimitRetryTimer = setTimeout(() => {
        this._rateLimitRetryTimer = null;
        this._processRateLimitQueue();
      }, delayMs);

      const retryAtStr = new Date(retryAt).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      claudeLog.info(
        `[RateLimit] All profiles weekly-exhausted — waiting until ${retryAtStr} (weekly reset + 1min buffer) for F${execution.featureId} ${execution.command}`,
      );

      this.deps.broadcastAll({
        type: 'rate-limit-waiting',
        featureId: execution.featureId,
        command: execution.command,
        retryAt: toJSTISO(new Date(retryAt)),
        delayMs,
        weeklyReset: msToJSTISO(weeklyResetTime),
        timestamp: nowJSTISO(),
      });

      return { message: `All profiles weekly-exhausted. Retry at ${retryAtStr} (weekly reset).` };
    }

    // Strategy 2: Schedule timed retry based on earliest reset time (session/weekly/sonnet)
    const resetTime = this.rateLimitService?.getEarliestResetTime();
    if (!resetTime) {
      claudeLog.warn(`[RateLimit] No safe profile and no reset time known. Cannot retry.`);
      // Remove from queue since we can't retry
      this.deps.releaseChainSlot(execution);
      this._rateLimitRetryQueue.length = 0;
      return null;
    }

    const retryAt = resetTime + RATE_LIMIT_RETRY_BUFFER_MS;
    const delayMs = Math.max(retryAt - Date.now(), RETRY_DELAY_MS); // At least RETRY_DELAY_MS

    execution.rateLimitRetryAt = retryAt;
    this._rateLimitRetryAt = toJSTISO(new Date(retryAt));

    this._rateLimitRetryTimer = setTimeout(() => {
      this._rateLimitRetryTimer = null;
      this._processRateLimitQueue();
    }, delayMs);

    const retryAtStr = new Date(retryAt).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit',
    });
    claudeLog.info(
      `[RateLimit] Retry scheduled at ${retryAtStr} (${Math.round(delayMs / 60000)}min) for F${execution.featureId} ${execution.command}`,
    );

    this.deps.broadcastAll({
      type: 'rate-limit-waiting',
      featureId: execution.featureId,
      command: execution.command,
      retryAt: toJSTISO(new Date(retryAt)),
      delayMs,
      timestamp: nowJSTISO(),
    });

    return { message: `Retry scheduled at ${retryAtStr} (${Math.round(delayMs / 60000)}min).` };
  }

  /**
   * Process the rate limit retry queue after timer fires.
   * Re-captures rate limits, checks if safe, then drains queue sequentially.
   */
  async _processRateLimitQueue() {
    const queueSize = this._rateLimitRetryQueue.length;
    claudeLog.info(`[RateLimit] Processing retry queue (${queueSize} entries)`);

    if (queueSize === 0) return;

    // Re-capture all profiles (queue entries may be on different profiles)
    try {
      await this.rateLimitService?.capture({ forceRefresh: true });
    } catch (err) {
      claudeLog.error(`[RateLimit] Re-capture failed: ${err.message}`);
    }

    // Per-entry evaluation: partition into safe vs exhausted by execution.ccsProfile
    const cached = this.rateLimitService?.getCached();
    const safeEntries = [];
    const exhaustedEntries = [];
    for (const entry of this._rateLimitRetryQueue) {
      const p = entry.execution.ccsProfile;
      const data = cached?.[p];
      const maxPct = data
        ? Math.max(data.weekly?.percent || 0, data.session?.percent || 0, data.sonnet?.percent || 0)
        : 100;
      if (maxPct < RATE_LIMIT_SAFE_THRESHOLD) {
        safeEntries.push(entry);
      } else {
        exhaustedEntries.push(entry);
      }
    }

    // Exhausted entries: check if all profiles weekly-exhausted → wait for weekly reset
    const weeklyResetTime = this.rateLimitService?.getEarliestWeeklyResetIfAllExhausted?.();
    if (exhaustedEntries.length > 0 && weeklyResetTime) {
      // All profiles weekly >= 100% — re-queue all exhausted entries until weekly reset
      const retryAt = Math.max(weeklyResetTime + RATE_LIMIT_RETRY_BUFFER_MS, Date.now() + 60000);

      this._rateLimitRetryQueue = [...safeEntries, ...exhaustedEntries];
      this._rateLimitRetryAt = toJSTISO(new Date(retryAt));

      this._rateLimitRetryTimer = setTimeout(() => {
        this._rateLimitRetryTimer = null;
        this._processRateLimitQueue();
      }, retryAt - Date.now());

      const retryAtStr = new Date(retryAt).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const firstExec = exhaustedEntries[0].execution;
      claudeLog.info(
        `[RateLimit] All profiles weekly-exhausted — waiting until ${retryAtStr} for ${exhaustedEntries.length} entries.`,
      );

      this.deps.broadcastAll({
        type: 'rate-limit-waiting',
        featureId: firstExec.featureId,
        command: firstExec.command,
        retryAt: toJSTISO(new Date(retryAt)),
        delayMs: retryAt - Date.now(),
        weeklyReset: msToJSTISO(weeklyResetTime),
        timestamp: nowJSTISO(),
      });
      // Process safe entries now if any, exhausted will retry at weekly reset
      if (safeEntries.length > 0) {
        this._rateLimitRetryQueue = safeEntries;
        this._callProcessNextInQueue();
      }
      return;
    }

    // Truly exhausted (weekly not the bottleneck or no reset info) — discard
    for (const entry of exhaustedEntries) {
      this.deps.releaseChainSlot(entry.execution);
      this.deps.pushLog(entry.execution, {
        line: `[Chain] Rate limit retry failed — profile ${entry.execution.ccsProfile} still exhausted. Manual re-run needed.`,
        timestamp: nowJSTISO(),
        level: 'error',
      });
    }
    if (exhaustedEntries.length > 0) {
      const firstExec = exhaustedEntries[0].execution;
      this.deps.broadcastAll({
        type: 'rate-limit-exhausted',
        featureId: firstExec.featureId,
        command: firstExec.command,
        profile: firstExec.ccsProfile,
        queueSize: exhaustedEntries.length,
        timestamp: nowJSTISO(),
      });
      const featureInfo =
        firstExec.featureId && this.featureService
          ? this.featureService.getFeature(firstExec.featureId)
          : null;
      this.emailService
        ?.sendRateLimitExhaustedNotification(
          firstExec,
          `Profile ${firstExec.ccsProfile} still exhausted after scheduled retry (${exhaustedEntries.length} discarded)`,
          featureInfo,
        )
        .catch(() => {});
    }

    // Recovery email for safe entries
    if (safeEntries.length > 0) {
      const recoveryExec = safeEntries[0].execution;
      const recoveryFeatureInfo =
        recoveryExec.featureId && this.featureService
          ? this.featureService.getFeature(recoveryExec.featureId)
          : null;
      this.emailService
        ?.sendRateLimitRecoveredNotification(recoveryExec, recoveryFeatureInfo)
        .catch(() => {});
    }

    // Replace queue with safe entries, then process
    this._rateLimitRetryQueue = safeEntries;
    if (safeEntries.length > 0) {
      this._callProcessNextInQueue();
    } else {
      this._rateLimitRetryAt = null;
      this.deps.dequeueNext();
    }
    return;
  }

  /**
   * Process the next entry in the rate limit retry queue.
   * Skips killed/cancelled executions. Calls dequeueNext when queue is empty.
   */
  _processNextInQueue() {
    if (this._rateLimitRetryQueue.length === 0) {
      this._rateLimitRetryAt = null;
      this.deps.dequeueNext();
      return;
    }

    const { execution } = this._rateLimitRetryQueue.shift();

    // Skip killed/cancelled executions
    if (execution.killedByUser || execution.status === 'cancelled') {
      claudeLog.info(
        `[RateLimit] Skipping killed/cancelled execution ${execution.id} in retry queue`,
      );
      this._callProcessNextInQueue();
      return;
    }

    claudeLog.info(
      `[RateLimit] Retrying F${execution.featureId} ${execution.command} (${this._rateLimitRetryQueue.length} remaining in queue)`,
    );

    this._callStartRateLimitRetry(execution);
  }

  /**
   * Start a new execution as a rate limit retry.
   * @param {Object} execution - The original failed execution
   */
  _startRateLimitRetry(execution) {
    // Queue state is managed by _processNextInQueue — no clearing here

    const updatedHistory = [
      ...(execution.chain?.history || []),
      { command: execution.command, result: 'rate-limit-retry' },
    ];

    let newExecId;
    let resumed = false;

    if (execution.sessionId) {
      // Resume the existing session to preserve conversation context
      const newExec = this.deps.createExecution({
        featureId: execution.featureId,
        command: execution.command,
        chain: true,
        chainParentId: execution.chainParentId || execution.id,
        retryCount: execution.chain?.retryCount || 0,
        contextRetryCount: execution.chain?.contextRetryCount || 0,
        incompleteRetryCount: execution.chain?.incompleteRetryCount || 0,
        serverErrorRetryCount: execution.chain?.serverErrorRetryCount || 0,
        chainHistory: updatedHistory,
      });

      // Override defaults for active resume
      newExec.status = 'running';
      newExec.startedAt = nowJSTISO();
      newExec.lastOutputTime = Date.now();
      newExec.sessionId = execution.sessionId;
      newExec._profileSwitchCount = execution._profileSwitchCount || 0;
      newExec.ccsProfile = execution.rateLimitSwitchedTo || execution.ccsProfile; // Use switched profile or inherit
      newExec._rateLimitQueueContinue = this._rateLimitRetryQueue.length > 0;
      newExec.debugLogPath = path.join(this.deps.tmpDir, `debug-${newExec.id}.log`);
      newExec.logs = [
        {
          line: `Resuming session ${execution.sessionId} after rate limit...`,
          timestamp: nowJSTISO(),
          level: 'info',
        },
      ];

      this.deps.setExecution(newExec.id, newExec);

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
        cwd: this.deps.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        env: this.deps.buildClaudeEnv(newExec),
      });

      newExec.process = proc;
      newExec.stdin = proc.stdin;
      proc.stdin.on('error', () => {}); // Suppress EPIPE on kill
      proc.stdin.end(); // Close stdin immediately — -p provides prompt, open pipe causes CLI hang

      this.deps.attachStdoutHandler(newExec, proc);
      this.deps.attachStderrHandler(newExec, proc);

      proc.on('error', (err) => {
        this.deps.handleCompletion(newExec, 1, err.message);
      });

      proc.on('close', (code) => {
        if (newExec.status === 'running') {
          this.deps.handleCompletion(newExec, code ?? 1);
        } else if (newExec.status === 'handed-off') {
          if (newExec.stallCheckInterval) {
            clearInterval(newExec.stallCheckInterval);
            newExec.stallCheckInterval = null;
          }
          newExec.process = null;
          this.deps.dequeueNext();
        }
      });

      newExec.stallCheckInterval = setInterval(() => {
        this.deps.checkStall(newExec);
      }, STALL_CHECK_INTERVAL_MS);

      this.deps.broadcastState(newExec);

      if (this.rateLimitService) {
        this.rateLimitService.recomputeRefreshTimes();
      }

      newExecId = newExec.id;
      resumed = true;

      claudeLog.info(
        `[RateLimit] Retry started (resumed session): ${newExec.id} (replacing ${execution.id})`,
      );
    } else {
      newExecId = this.deps.executeCommand(execution.featureId, execution.command, {
        chain: true,
        chainParentId: execution.chainParentId || execution.id,
        retryCount: execution.chain?.retryCount || 0,
        contextRetryCount: execution.chain?.contextRetryCount || 0,
        incompleteRetryCount: execution.chain?.incompleteRetryCount || 0,
        serverErrorRetryCount: execution.chain?.serverErrorRetryCount || 0,
        chainHistory: updatedHistory,
        avoidProfile: execution.ccsProfile,
      });

      // Set queue continuation flag on the new execution
      const newExec2 = this.deps.getExecution(newExecId);
      if (newExec2) {
        newExec2._rateLimitQueueContinue = this._rateLimitRetryQueue.length > 0;
      }

      claudeLog.info(`[RateLimit] Retry started: ${newExecId} (replacing ${execution.id})`);
    }

    this.deps.broadcastAll({
      type: 'rate-limit-retry',
      featureId: execution.featureId,
      command: execution.command,
      oldExecutionId: execution.id,
      newExecutionId: newExecId,
      resumed,
      timestamp: nowJSTISO(),
    });

    // rate-limit-recovered: auto-recovery is normal operation, no email needed
  }

  // ===========================================================================
  // Server Error (500/529) Retry — Exponential Backoff
  // ===========================================================================

  /**
   * Schedule a server error retry with exponential backoff.
   * @param {Object} execution - The failed execution
   * @param {number} retryCount - Current retry attempt (0-indexed)
   * @returns {{ message: string }|null}
   */
  scheduleServerErrorRetry(execution, retryCount) {
    const delayMs =
      SERVER_ERROR_BACKOFF_MS[retryCount] ||
      SERVER_ERROR_BACKOFF_MS[SERVER_ERROR_BACKOFF_MS.length - 1];
    const retryAt = msToJSTISO(Date.now() + delayMs);

    this._serverErrorRetryQueue.push({ execution, retryCount, queuedAt: Date.now() });
    this._serverErrorRetryAt = retryAt;

    if (this._serverErrorRetryTimer) {
      clearTimeout(this._serverErrorRetryTimer);
    }

    this._serverErrorRetryTimer = setTimeout(() => {
      this._serverErrorRetryTimer = null;
      this._processServerErrorQueue();
    }, delayMs);

    const delayMin = Math.round(delayMs / 60000);
    const retryAtStr = new Date(retryAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });

    claudeLog.info(
      `[ServerError] Retry ${retryCount + 1}/${MAX_SERVER_ERROR_RETRIES} scheduled at ${retryAtStr} (${delayMin}min) for F${execution.featureId} ${execution.command}`,
    );

    this.deps.broadcastAll({
      type: 'server-error-waiting',
      featureId: execution.featureId,
      command: execution.command,
      executionId: execution.id,
      retryCount,
      maxRetries: MAX_SERVER_ERROR_RETRIES,
      retryAt,
      delayMs,
      timestamp: nowJSTISO(),
    });

    return {
      message: `Server error retry ${retryCount + 1}/${MAX_SERVER_ERROR_RETRIES} at ${retryAtStr} (${delayMin}min).`,
    };
  }

  /**
   * Process server error retry queue after timer fires.
   */
  _processServerErrorQueue() {
    while (this._serverErrorRetryQueue.length > 0) {
      const { execution, retryCount } = this._serverErrorRetryQueue.shift();

      if (execution.killedByUser || execution.status === 'cancelled') {
        claudeLog.info(`[ServerError] Skipping killed/cancelled execution ${execution.id}`);
        continue;
      }

      this._startServerErrorRetry(execution, retryCount + 1);
    }

    this._serverErrorRetryAt = null;
    this.deps.dequeueNext();
  }

  /**
   * Start a new execution as a server error retry.
   * @param {Object} execution - Original failed execution
   * @param {number} newRetryCount - New retry count (incremented)
   */
  _startServerErrorRetry(execution, newRetryCount) {
    const updatedHistory = [
      ...(execution.chain?.history || []),
      { command: execution.command, result: 'server-error-retry' },
    ];

    const newExecId = this.deps.executeCommand(execution.featureId, execution.command, {
      chain: true,
      chainParentId: execution.chainParentId || execution.id,
      retryCount: execution.chain?.retryCount || 0,
      contextRetryCount: execution.chain?.contextRetryCount || 0,
      incompleteRetryCount: execution.chain?.incompleteRetryCount || 0,
      serverErrorRetryCount: newRetryCount,
      chainHistory: updatedHistory,
      avoidProfile: execution.ccsProfile,
    });

    claudeLog.info(
      `[ServerError] Retry started: ${newExecId} (replacing ${execution.id}, attempt ${newRetryCount}/${MAX_SERVER_ERROR_RETRIES})`,
    );

    this.deps.broadcastAll({
      type: 'server-error-retry',
      featureId: execution.featureId,
      command: execution.command,
      oldExecutionId: execution.id,
      newExecutionId: newExecId,
      retryCount: newRetryCount,
      maxRetries: MAX_SERVER_ERROR_RETRIES,
      timestamp: nowJSTISO(),
    });
  }

  // ===========================================================================
  // Profile Switching
  // ===========================================================================

  /**
   * Switch CCS profile to the specified target (internal).
   * @param {string} targetProfile - Profile name to switch to
   */
  _switchProfile(targetProfile) {
    const profiles = getCcsProfiles();
    if (!profiles.includes(targetProfile)) {
      claudeLog.error(`[RateLimit] Unknown profile: ${targetProfile}`);
      return;
    }

    // Check lock file to avoid conflict with terminal Stop hook
    const lockFile = path.join(this.deps.projectRoot, '_out', 'tmp', 'dashboard', 'cs-switch.lock');
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
    this.deps.broadcastAll({
      type: 'shell-complete',
      command: 'cs',
      success: true,
      timestamp: nowJSTISO(),
    });
    this.deps.setShellState('cs', true);
    return { command: 'cs', profile: targetProfile, status: 'ok' };
  }

  // ===========================================================================
  // Kill / Shutdown helpers
  // ===========================================================================

  /**
   * Remove an execution from retry queues (called by killExecution).
   * @param {string} executionId
   */
  removeFromRetryQueues(executionId) {
    // Remove from rate limit retry queue if queued
    const rlIdx = this._rateLimitRetryQueue.findIndex(
      (entry) => entry.execution.id === executionId,
    );
    if (rlIdx !== -1) {
      this._rateLimitRetryQueue.splice(rlIdx, 1);
      claudeLog.info(
        `[RateLimit] Removed execution ${executionId} from retry queue (${this._rateLimitRetryQueue.length} remaining)`,
      );
      // If queue is now empty, clear the timer
      if (this._rateLimitRetryQueue.length === 0) {
        if (this._rateLimitRetryTimer) {
          clearTimeout(this._rateLimitRetryTimer);
          this._rateLimitRetryTimer = null;
        }
        this._rateLimitRetryAt = null;
      }
    }

    // Remove from server error retry queue if queued
    const seIdx = this._serverErrorRetryQueue.findIndex(
      (entry) => entry.execution.id === executionId,
    );
    if (seIdx !== -1) {
      this._serverErrorRetryQueue.splice(seIdx, 1);
      claudeLog.info(
        `[ServerError] Removed execution ${executionId} from retry queue (${this._serverErrorRetryQueue.length} remaining)`,
      );
      if (this._serverErrorRetryQueue.length === 0) {
        if (this._serverErrorRetryTimer) {
          clearTimeout(this._serverErrorRetryTimer);
          this._serverErrorRetryTimer = null;
        }
        this._serverErrorRetryAt = null;
      }
    }
  }

  /**
   * Clear all retry state (called by killAllRunning/shutdown).
   */
  clearAll() {
    if (this._rateLimitRetryTimer) {
      clearTimeout(this._rateLimitRetryTimer);
      this._rateLimitRetryTimer = null;
    }
    this._rateLimitRetryQueue.length = 0;
    this._rateLimitRetryAt = null;

    if (this._serverErrorRetryTimer) {
      clearTimeout(this._serverErrorRetryTimer);
      this._serverErrorRetryTimer = null;
    }
    this._serverErrorRetryQueue.length = 0;
    this._serverErrorRetryAt = null;
  }

  /**
   * Continue draining rate limit retry queue (called from _handleCompletion).
   * @param {Object} execution
   */
  continueQueueDrain(execution) {
    if (execution._rateLimitQueueContinue && !execution.accountLimitHit) {
      setTimeout(() => this._callProcessNextInQueue(), RETRY_DELAY_MS);
    }
  }
}
