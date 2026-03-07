import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { claudeLog } from '../utils/logger.js';
import { CCS_INSTANCES_DIR } from '../config.js';

const INSIGHTS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MTIME_POLL_INTERVAL_MS = 5000; // Check report.html every 5 seconds
const REPORT_READY_PATTERN = /report is ready/i;

/**
 * Service for running /insights in Claude Code via PTY and emailing the report.
 * Spawns a headless PTY, sends /insights, detects completion via dual signals
 * (report.html mtime change + PTY output pattern), then emails the HTML report.
 *
 * TODO: Isolate PTY capture into a forked worker (same pattern as ratelimitService)
 * to prevent node-pty ACCESS_VIOLATION crashes from killing the main process.
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

  async _getPtySpawn() {
    if (this._ptySpawn) return this._ptySpawn;
    const nodePty = await import('node-pty');
    return nodePty.default?.spawn || nodePty.spawn;
  }

  _killPty(ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {
      try {
        if (ptyProcess.pid) {
          execSync(`taskkill /F /T /PID ${ptyProcess.pid}`, { windowsHide: true });
        }
      } catch (killErr) {
        claudeLog.debug(`[Insights] taskkill fallback failed: ${killErr.message}`);
      }
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
      const date = new Date().toISOString().slice(0, 10);
      const subject = `[Insights] ${profile} ${date}`;
      await this._emailService.sendHtml(subject, html);
      claudeLog.info(`[Insights] Report emailed: ${subject}`);
    } catch (err) {
      claudeLog.error(`[Insights] Email failed: ${err.message}`);
    }
  }

  async _runCapture(profile, reportPath, beforeMtime) {
    const spawn = await this._getPtySpawn();

    return new Promise((resolve) => {
      let resolved = false;
      let tuiDetected = false;
      let insightsSent = false;
      let rawChunks = [];
      let chunkCount = 0;

      const env = {
        ...process.env,
        FORCE_COLOR: '0',
        CLAUDE_CONFIG_DIR: path.join(CCS_INSTANCES_DIR, profile),
        WT_SESSION: '00000000-0000-0000-0000-000000000000',
      };
      delete env.CLAUDECODE;

      const ptyProcess = spawn('cmd.exe', ['/c', 'claude'], {
        cols: 120,
        rows: 30,
        env,
        useConptyDll: true,
      });

      claudeLog.info(`[Insights] Spawned pty PID=${ptyProcess.pid}`);

      let mtimePoll = null;

      const finish = (success, reason) => {
        if (resolved) return;
        resolved = true;
        if (mtimePoll) clearInterval(mtimePoll);
        clearTimeout(overallTimeout);
        claudeLog.info(
          `[Insights] Finishing: success=${success}, reason=${reason}, chunks=${chunkCount}`,
        );
        // Log last chunks at debug for diagnostics
        const lastChunks = rawChunks.slice(-10);
        for (let i = 0; i < lastChunks.length; i++) {
          claudeLog.debug(
            `[Insights] Chunk[-${lastChunks.length - i}]: ${lastChunks[i].substring(0, 300).replace(/\n/g, '\\n')}`,
          );
        }
        this._killPty(ptyProcess);
        resolve({ success, reason });
      };

      ptyProcess.onData((data) => {
        chunkCount++;
        const truncated = data.length > 2000 ? data.substring(0, 2000) + '...' : data;
        rawChunks.push(truncated);
        if (rawChunks.length > 50) rawChunks.shift();

        if (resolved) return;

        // Dual detection signal 2: PTY output pattern
        if (insightsSent && REPORT_READY_PATTERN.test(data)) {
          claudeLog.info(
            `[Insights] PTY output: "report is ready" detected at chunk ${chunkCount}`,
          );
          setTimeout(() => finish(true, 'pty_pattern'), 2000);
          return;
        }

        // Phase 1: Detect TUI loaded
        if (!tuiDetected) {
          if (/Context:\d+%/.test(data) || rawChunks.some((c) => /Context:\d+%/.test(c))) {
            tuiDetected = true;
            claudeLog.info(`[Insights] TUI detected at chunk ${chunkCount}, waiting 2s`);

            setTimeout(() => {
              if (!resolved && !insightsSent) {
                insightsSent = true;
                claudeLog.info(`[Insights] Sending /insights`);
                ptyProcess.write('/insights');
                setTimeout(() => {
                  if (!resolved) {
                    ptyProcess.write('\r');
                    claudeLog.info(`[Insights] Enter sent, waiting for completion...`);

                    // Dual detection signal 1: mtime polling
                    mtimePoll = setInterval(() => {
                      const currentMtime = this._getReportMtime(reportPath);
                      if (currentMtime > beforeMtime) {
                        claudeLog.info(`[Insights] report.html mtime changed`);
                        setTimeout(() => finish(true, 'mtime_changed'), 2000);
                      }
                    }, MTIME_POLL_INTERVAL_MS);
                  }
                }, 800);
              }
            }, 2000);
          }
        }
      });

      const overallTimeout = setTimeout(() => {
        finish(false, 'timeout');
      }, INSIGHTS_TIMEOUT_MS);

      ptyProcess.onExit(({ exitCode }) => {
        claudeLog.info(`[Insights] Pty exited code=${exitCode}`);
        finish(exitCode === 0, `exit_${exitCode}`);
      });
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
      `[Insights] Next scheduled capture: ${nextDate.toISOString()} (in ${Math.round(ms / 3600000)}h)`,
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
