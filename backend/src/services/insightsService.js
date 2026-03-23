import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { claudeLog } from '../utils/logger.js';
import { nowJSTISO, toJSTISO } from '../utils/timeUtils.js';
import { CCS_INSTANCES_DIR } from '../config.js';

const INSIGHTS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Service for running /insights in Claude Code via PTY and emailing the report.
 * Spawns a headless PTY in a forked worker process (isolated from main process) to
 * prevent node-pty ACCESS_VIOLATION crashes from killing the dashboard.
 * Detects completion via dual signals (report.html mtime change + PTY output pattern),
 * then emails the HTML report.
 */
export class InsightsService {
  /**
   * @param {string} projectRoot - Project root directory
   * @param {Object} [options]
   * @param {function(): string|null} [options.getActiveProfile] - Returns active CCS profile name
   * @param {function} [options.ptySpawn] - Optional pty.spawn for testing
   * @param {Object} [options.emailService] - EmailService instance for sending reports
   */
  constructor(projectRoot, { getActiveProfile, ptySpawn, emailService } = {}) {
    this.projectRoot = projectRoot;
    this._getActiveProfile = getActiveProfile || (() => null);
    this._ptySpawn = ptySpawn || null;
    this._emailService = emailService || null;
    this._running = false;
    this._lastResult = null;
    this._schedulerTimeout = null;
  }

  _getReportPath(profile) {
    return path.join(CCS_INSTANCES_DIR, profile, 'usage-data', 'report.html');
  }

  _getReportMtime(reportPath) {
    try {
      return fs.statSync(reportPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Run /insights capture and optionally email the report.
   * @param {Object} [options]
   * @param {boolean} [options.sendEmail=true] - Send email after successful capture
   * @returns {Promise<Object>} Result
   */
  async capture({ sendEmail = true } = {}) {
    if (this._running) {
      claudeLog.warn('[Insights] Already running, skipping');
      return { error: 'already_running' };
    }

    const profile = this._getActiveProfile();
    if (!profile) {
      claudeLog.error('[Insights] No active profile');
      return { error: 'no_profile' };
    }

    const reportPath = this._getReportPath(profile);
    const beforeMtime = this._getReportMtime(reportPath);
    claudeLog.info(`[Insights] Starting capture for profile=${profile}`);

    this._running = true;
    const startTime = Date.now();

    try {
      const result = await this._runCapture(profile, reportPath, beforeMtime);
      const duration = Date.now() - startTime;
      this._lastResult = { ...result, profile, reportPath, duration, timestamp: Date.now() };
      claudeLog.info(
        `[Insights] Capture complete: duration=${Math.round(duration / 1000)}s, success=${result.success}, reason=${result.reason}`,
      );

      // Send email if successful
      if (result.success && sendEmail) {
        await this._sendReport(reportPath, profile);
      }

      return this._lastResult;
    } catch (err) {
      claudeLog.error(`[Insights] Capture error: ${err.message}`);
      return { error: err.message, profile, duration: Date.now() - startTime };
    } finally {
      this._running = false;
    }
  }

  /**
   * Read report.html and send via EmailService.
   */
  async _sendReport(reportPath, profile) {
    if (!this._emailService) {
      claudeLog.warn('[Insights] No emailService configured, skipping email');
      return;
    }
    try {
      const html = fs.readFileSync(reportPath, 'utf8');
      const date = nowJSTISO().slice(0, 10);
      const subject = `[Insights] ${profile} ${date}`;
      await this._emailService.sendHtml(subject, html);
      claudeLog.info(`[Insights] Report emailed: ${subject}`);
    } catch (err) {
      claudeLog.error(`[Insights] Email failed: ${err.message}`);
    }
  }

  async _runCapture(profile, reportPath, beforeMtime) {
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'workers',
      'insightsCapture.js',
    );

    const WORKER_TIMEOUT_MS = INSIGHTS_TIMEOUT_MS + 10000; // Worker timeout + buffer

    return new Promise((resolve) => {
      let resolved = false;

      const child = fork(workerPath, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });

      const finish = (success, reason) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        child.removeAllListeners('message');
        child.removeAllListeners('error');
        child.removeAllListeners('exit');
        resolve({ success, reason });
      };

      child.on('message', (msg) => {
        if (msg.type === 'result') {
          claudeLog.info(`[Insights] Worker result: success=${msg.success}, reason=${msg.reason}`);
          finish(msg.success, msg.reason);
        } else if (msg.type === 'error') {
          claudeLog.error(`[Insights] Worker error: ${msg.message}`);
          finish(false, `worker_error: ${msg.message}`);
        }
      });

      child.on('error', (err) => {
        claudeLog.error(`[Insights] Worker spawn error: ${err.message}`);
        finish(false, `spawn_error: ${err.message}`);
      });

      child.on('exit', (code, signal) => {
        claudeLog.info(`[Insights] Worker exited code=${code} signal=${signal}`);
        if (!resolved) {
          finish(code === 0, `worker_exit_${code}`);
        }
      });

      const timeout = setTimeout(() => {
        claudeLog.warn(`[Insights] Worker parent timeout (${WORKER_TIMEOUT_MS}ms), killing child`);
        try {
          child.kill();
        } catch {
          // ignore
        }
        finish(false, 'parent_timeout');
      }, WORKER_TIMEOUT_MS);

      // Build env for worker
      const env = {
        ...process.env,
        FORCE_COLOR: '0',
        CLAUDE_CONFIG_DIR: path.join(CCS_INSTANCES_DIR, profile),
        WT_SESSION: '00000000-0000-0000-0000-000000000000',
      };
      delete env.CLAUDECODE;

      child.send({ type: 'start', env, reportPath, beforeMtime });
      claudeLog.info(`[Insights] Worker spawned PID=${child.pid}`);
    });
  }

  /**
   * Calculate ms until next Monday 07:00 JST (= Sunday 22:00 UTC).
   * @param {Date} [now] - Current time (for testing)
   * @returns {number}
   */
  _msUntilNextMonday7JST(now = new Date()) {
    // Monday 07:00 JST = Sunday 22:00 UTC
    const target = new Date(now);
    const daysUntilSunday = (7 - target.getUTCDay()) % 7;
    target.setUTCDate(target.getUTCDate() + daysUntilSunday);
    target.setUTCHours(22, 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setUTCDate(target.getUTCDate() + 7);
    }
    return target.getTime() - now.getTime();
  }

  _scheduleNext() {
    const ms = this._msUntilNextMonday7JST();
    const nextDate = new Date(Date.now() + ms);
    claudeLog.info(
      `[Insights] Next scheduled capture: ${toJSTISO(nextDate)} (in ${Math.round(ms / 3600000)}h)`,
    );
    this._schedulerTimeout = setTimeout(() => {
      claudeLog.info('[Insights] Scheduled capture triggered (Monday 07:00 JST)');
      this.capture().catch((err) => {
        claudeLog.error(`[Insights] Scheduled capture failed: ${err.message}`);
      });
      this._schedulerTimeout = null;
      this._scheduleNext();
    }, ms);
  }

  /** Start weekly scheduler (Monday 07:00 JST). */
  startScheduler() {
    if (this._schedulerTimeout) return;
    this._scheduleNext();
  }

  /** Stop the scheduler. */
  stopScheduler() {
    if (this._schedulerTimeout) {
      clearTimeout(this._schedulerTimeout);
      this._schedulerTimeout = null;
      claudeLog.info('[Insights] Scheduler stopped');
    }
  }

  getLastResult() {
    return this._lastResult;
  }

  isRunning() {
    return this._running;
  }
}
