import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';
import { nowJSTISO, toJSTISO } from '../utils/timeUtils.js';
import {
  UPDATE_COMMAND_TIMEOUT_MS,
  UPDATE_TEST_TIMEOUT_MS,
  UPDATE_IDLE_RETRY_MS,
  UPDATE_IDLE_MAX_RETRIES,
  // Schedule constants exported from config for external use (scheduling uses private methods)
} from '../config.js';
import { exitWithPm2Update, setPm2UpdatePending } from '../utils/exitHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execAsync = promisify(exec);
const log = createLogger('dep-updater');

// Results persistence path
const RESULTS_DIR = path.resolve(__dirname, '..', '..', '..', '_out', 'tmp', 'dashboard');
const RESULTS_PATH = path.join(RESULTS_DIR, 'dep-updater-results.json');

export class DependencyUpdaterService {
  static DAILY = [
    {
      name: 'CCS',
      type: 'global',
      cmd: 'npm update -g @kaitranntt/ccs',
      versionCmd: 'ccs --version',
      needsIdle: false,
    },
  ];

  static WEEKLY = [
    {
      name: 'CodeRabbit',
      type: 'global',
      cmd: "wsl -- bash -c '/home/siihe/.local/bin/coderabbit update'",
      versionCmd: "wsl -- bash -c '/home/siihe/.local/bin/coderabbit --version'",
      needsIdle: false,
    },
    {
      name: 'PM2',
      type: 'global',
      cmd: 'npm update -g pm2',
      versionCmd: 'pm2 --version',
      needsIdle: true,
      // postCmd removed: daemon reload deferred to next clean exit via exitHelpers.js
    },
  ];

  static MONTHLY = [
    {
      name: 'NuGet',
      type: 'check-only',
      cmd: "wsl -- bash -c 'cd /mnt/c/Era/devkit && /home/siihe/.dotnet/dotnet list package --outdated'",
      needsIdle: false,
    },
    {
      name: 'Go',
      type: 'repo',
      repoDir: 'C:\\Era\\devkit',
      cmd: "wsl -- bash -c 'cd /mnt/c/Era/devkit/src/tools/go/com-validator && go get -u ./... && go mod tidy'",
      testCmd: "wsl -- bash -c 'cd /mnt/c/Era/devkit/src/tools/go/com-validator && go test ./...'",
      commitFiles: ['src/tools/go/com-validator/go.mod', 'src/tools/go/com-validator/go.sum'],
      commitMsg: 'chore(deps): update Go modules',
      needsIdle: false,
    },
    {
      name: 'pip',
      type: 'pip',
      cmd: 'python -m pip install --upgrade pytest pyyaml',
      versionCmd: 'python -m pip show pytest pyyaml',
      testCmd: 'python -m pytest src/tools/python/tests/ -v',
      testCwd: 'C:\\Era\\devkit',
      needsIdle: false,
    },
    // npm-dashboard MUST be last (triggerRestart causes process.exit)
    {
      name: 'npm-dashboard',
      type: 'repo',
      repoDir: 'C:\\Era\\dashboard',
      cmd: 'npm update',
      testCmd: 'npm test',
      commitFiles: ['package.json', 'package-lock.json'],
      commitMsg: 'chore(deps): update npm packages',
      needsIdle: true,
      triggerRestart: true,
    },
  ];

  static TIERS = {
    daily: DependencyUpdaterService.DAILY,
    weekly: DependencyUpdaterService.WEEKLY,
    monthly: DependencyUpdaterService.MONTHLY,
  };

  constructor({ emailService, logStreamer, claudeService }) {
    this._emailService = emailService;
    this._logStreamer = logStreamer;
    this._claudeService = claudeService;

    this._dailyTimeout = null;
    this._weeklyTimeout = null;
    this._monthlyTimeout = null;
    this._running = new Map(); // tier -> boolean
    this._lastResults = new Map(); // tier -> { timestamp, results[] }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  start() {
    if (this._dailyTimeout || this._weeklyTimeout || this._monthlyTimeout) {
      log.info('Already started, ignoring');
      return;
    }
    this._loadResults();
    this._scheduleDailyNext();
    this._scheduleWeeklyNext();
    this._scheduleMonthlyNext();
    log.info('Started');
  }

  stop() {
    clearTimeout(this._dailyTimeout);
    clearTimeout(this._weeklyTimeout);
    clearTimeout(this._monthlyTimeout);
    this._dailyTimeout = null;
    this._weeklyTimeout = null;
    this._monthlyTimeout = null;
    log.info('Stopped');
  }

  async triggerTier(tier, { skipIdleCheck = false } = {}) {
    const commands = DependencyUpdaterService.TIERS[tier];
    if (!commands) throw new Error(`Unknown tier: ${tier}`);
    if (this._running.get(tier)) {
      throw new Error(`Tier ${tier} is already running`);
    }
    return this._runTier(tier, commands, { skipIdleCheck });
  }

  getStatus() {
    const tierStatus = (tier, timeout) => {
      const last = this._lastResults.get(tier);
      return {
        running: this._running.get(tier) || false,
        scheduled: timeout != null,
        lastRun: last ? { timestamp: last.timestamp, results: last.results } : null,
      };
    };
    return {
      daily: tierStatus('daily', this._dailyTimeout),
      weekly: tierStatus('weekly', this._weeklyTimeout),
      monthly: tierStatus('monthly', this._monthlyTimeout),
    };
  }

  // =========================================================================
  // Schedule calculation (JST = UTC+9)
  // =========================================================================

  _msUntilNext0600JST(now = new Date()) {
    // 06:00 JST = 21:00 UTC previous day
    const target = new Date(now);
    target.setUTCHours(21, 0, 0, 0); // 21:00 UTC = 06:00 JST next day
    // If we're past 21:00 UTC today, target tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
    return target.getTime() - now.getTime();
  }

  _msUntilNextMonday0630JST(now = new Date()) {
    // Monday 06:30 JST = Sunday 21:30 UTC
    const target = new Date(now);
    const daysUntilSunday = (7 - target.getUTCDay()) % 7;
    target.setUTCDate(target.getUTCDate() + daysUntilSunday);
    target.setUTCHours(21, 30, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setUTCDate(target.getUTCDate() + 7);
    }
    return target.getTime() - now.getTime();
  }

  _msUntilNextFirst0600JST(now = new Date()) {
    // 1st of next month, 06:00 JST = previous day 21:00 UTC
    // But "1st 06:00 JST" = "last day of prev month 21:00 UTC" or "1st 21:00 UTC - 24h"
    // Actually: 1st of month 06:00 JST = 31st (or 28/29/30) of prev month 21:00 UTC
    // Simpler: compute in JST, then convert
    const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const jstTarget = new Date(jstNow);
    // Set to 1st of next month, 06:00
    jstTarget.setUTCMonth(jstTarget.getUTCMonth() + 1);
    jstTarget.setUTCDate(1);
    jstTarget.setUTCHours(6, 0, 0, 0);
    // If jstNow is already past 1st 06:00 of current month but before end of month,
    // the above +1 month is correct. But if jstNow IS the 1st and before 06:00,
    // we want today, not next month.
    const jstThisMonth1st = new Date(jstNow);
    jstThisMonth1st.setUTCDate(1);
    jstThisMonth1st.setUTCHours(6, 0, 0, 0);
    if (jstThisMonth1st.getTime() > jstNow.getTime()) {
      // Haven't reached this month's 1st 06:00 JST yet
      jstTarget.setTime(jstThisMonth1st.getTime());
    }
    // Convert back from JST to UTC
    const utcTarget = new Date(jstTarget.getTime() - 9 * 60 * 60 * 1000);
    return utcTarget.getTime() - now.getTime();
  }

  // =========================================================================
  // Scheduler loop
  // =========================================================================

  _scheduleDailyNext() {
    const ms = this._msUntilNext0600JST();
    const nextDate = new Date(Date.now() + ms);
    log.info(`[Daily] Next: ${toJSTISO(nextDate)} (in ${Math.round(ms / 3600000)}h)`);
    this._dailyTimeout = setTimeout(() => {
      this._dailyTimeout = null;
      log.info('[Daily] Triggered');
      this._runTier('daily', DependencyUpdaterService.DAILY)
        .catch((err) => log.error(`[Daily] Error: ${err.message}`))
        .finally(() => this._scheduleDailyNext());
    }, ms);
  }

  _scheduleWeeklyNext() {
    const ms = this._msUntilNextMonday0630JST();
    const nextDate = new Date(Date.now() + ms);
    log.info(`[Weekly] Next: ${toJSTISO(nextDate)} (in ${Math.round(ms / 3600000)}h)`);
    this._weeklyTimeout = setTimeout(() => {
      this._weeklyTimeout = null;
      log.info('[Weekly] Triggered');
      this._runTier('weekly', DependencyUpdaterService.WEEKLY)
        .then(() => this._sendWeeklySummary())
        .catch((err) => log.error(`[Weekly] Error: ${err.message}`))
        .finally(() => this._scheduleWeeklyNext());
    }, ms);
  }

  _scheduleMonthlyNext() {
    const ms = this._msUntilNextFirst0600JST();
    const nextDate = new Date(Date.now() + ms);
    log.info(`[Monthly] Next: ${toJSTISO(nextDate)} (in ${Math.round(ms / 3600000)}h)`);
    this._monthlyTimeout = setTimeout(() => {
      this._monthlyTimeout = null;
      log.info('[Monthly] Triggered');
      this._runTier('monthly', DependencyUpdaterService.MONTHLY)
        .catch((err) => log.error(`[Monthly] Error: ${err.message}`))
        .finally(() => this._scheduleMonthlyNext());
    }, ms);
  }

  // =========================================================================
  // Pre-check: idle
  // =========================================================================

  _isIdle() {
    if (!this._claudeService) return true;
    const { runningCount, queuedCount, chainWaiterCount, waitingForInputCount, rateLimitQueue } =
      this._claudeService.getQueueStatus();
    return (
      runningCount === 0 &&
      queuedCount === 0 &&
      chainWaiterCount === 0 &&
      waitingForInputCount === 0 &&
      rateLimitQueue.length === 0
    );
  }

  async _waitForIdle(maxRetries = UPDATE_IDLE_MAX_RETRIES) {
    for (let i = 0; i < maxRetries; i++) {
      if (this._isIdle()) return true;
      log.info(
        `[Idle] Not idle, retry ${i + 1}/${maxRetries} in ${UPDATE_IDLE_RETRY_MS / 60000}min`,
      );
      await new Promise((r) => setTimeout(r, UPDATE_IDLE_RETRY_MS));
    }
    log.warn('[Idle] Max retries reached, skipping');
    return false;
  }

  // =========================================================================
  // Execution core
  // =========================================================================

  async _exec(cmd, { cwd, timeout = UPDATE_COMMAND_TIMEOUT_MS } = {}) {
    log.info(`[Exec] ${cmd}${cwd ? ` (cwd: ${cwd})` : ''}`);
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout,
        encoding: 'utf8',
        windowsHide: true,
        shell: true,
        cwd,
      });
      return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err) {
      // pm2 update causes ETIMEDOUT (expected — process gets killed)
      if (err.killed || err.code === 'ETIMEDOUT') {
        return { success: true, stdout: '', stderr: '', timedOut: true };
      }
      return {
        success: false,
        error: err.message,
        stdout: err.stdout?.trim() || '',
        stderr: err.stderr?.trim() || '',
      };
    }
  }

  async _runTier(tierName, commands, { skipIdleCheck = false } = {}) {
    if (this._running.get(tierName)) {
      log.warn(`[${tierName}] Already running, skipping`);
      return [];
    }
    this._running.set(tierName, true);
    const results = [];
    try {
      for (const item of commands) {
        let result;
        // Idle check for items that need it
        if (item.needsIdle && !skipIdleCheck) {
          const idle = await this._waitForIdle();
          if (!idle) {
            result = { name: item.name, success: false, skipped: 'not idle' };
            results.push(result);
            continue;
          }
        }
        try {
          switch (item.type) {
            case 'global':
              result = await this._runGlobal(item);
              break;
            case 'check-only':
              result = await this._runCheckOnly(item);
              break;
            case 'repo':
              result = await this._runRepoPipeline(item);
              break;
            case 'pip':
              result = await this._runPipPipeline(item);
              break;
            default:
              result = { name: item.name, success: false, error: `Unknown type: ${item.type}` };
          }
        } catch (err) {
          result = { name: item.name, success: false, error: err.message };
        }
        results.push(result);
        log.info(`[${tierName}] ${item.name}: ${JSON.stringify(result)}`);
      }
      // All per-tier emails suppressed — weekly summary only
    } finally {
      this._running.set(tierName, false);
      this._lastResults.set(tierName, { timestamp: nowJSTISO(), results });
      this._saveResults();
    }
    return results;
  }

  // =========================================================================
  // Type A: Global CLI update
  // =========================================================================

  async _runGlobal(item) {
    const result = { name: item.name, success: true };

    // Get version before
    const before = await this._exec(item.versionCmd);
    result.versionBefore = before.success ? this._extractVersion(before.stdout) : 'unknown';

    // Run update
    const update = await this._exec(item.cmd);
    if (!update.success) {
      return { ...result, success: false, error: update.error };
    }

    // Get version after
    const after = await this._exec(item.versionCmd);
    result.versionAfter = after.success ? this._extractVersion(after.stdout) : 'unknown';

    if (result.versionBefore === result.versionAfter) {
      result.skipped = 'already latest';
    }

    // Post-command (e.g., pm2 update)
    if (item.postCmd && result.versionBefore !== result.versionAfter) {
      log.info(`[${item.name}] Running post-command: ${item.postCmd}`);
      await this._exec(item.postCmd, { timeout: 5000 });
    }

    // PM2: defer daemon reload to next clean process exit
    if (item.name === 'PM2' && result.versionBefore !== result.versionAfter) {
      setPm2UpdatePending(result.versionAfter);
      result.pendingReload = true;
      log.info(
        `[PM2] Daemon reload deferred to next exit (${result.versionBefore} → ${result.versionAfter})`,
      );
    }

    return result;
  }

  // =========================================================================
  // NuGet: check-only (no auto-upgrade)
  // =========================================================================

  async _runCheckOnly(item) {
    const result = { name: item.name, success: true, outdated: [] };

    const check = await this._exec(item.cmd);
    if (!check.success) {
      return { ...result, success: false, error: check.error };
    }

    // Parse outdated packages from dotnet output
    // Lines like: > PackageName   1.0.0   1.0.0   1.1.0
    const lines = check.stdout.split('\n');
    for (const line of lines) {
      const match = line.match(/>\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/);
      if (match) {
        result.outdated.push({
          package: match[1],
          current: match[2],
          resolved: match[3],
          latest: match[4],
        });
      }
    }

    return result;
  }

  // =========================================================================
  // Type B: Repo pipeline (update -> diff -> test -> commit/revert)
  // =========================================================================

  async _runRepoPipeline(item) {
    const result = { name: item.name, success: true };

    // Run update
    const update = await this._exec(item.cmd, { cwd: item.repoDir });
    if (!update.success) {
      return { ...result, success: false, error: update.error };
    }

    // Check for changes
    const diff = await this._gitDiff(item.repoDir);
    if (diff.length === 0) {
      return { ...result, skipped: 'no changes' };
    }
    result.changedFiles = diff;

    // Run tests
    const test = await this._exec(item.testCmd, {
      cwd: item.repoDir,
      timeout: UPDATE_TEST_TIMEOUT_MS,
    });
    if (!test.success) {
      // Revert changes
      await this._gitStashRevert(item.repoDir);
      return { ...result, success: false, reverted: true, testError: test.error || test.stderr };
    }

    // Commit
    await this._gitCommit(item.repoDir, item.commitFiles, item.commitMsg);
    result.committed = true;

    // Auto-DR trigger (npm-dashboard)
    if (item.triggerRestart) {
      log.info(`[${item.name}] Triggering restart (process.exit for PM2 autorestart)`);
      // Save results synchronously before exit
      this._lastResults.set('monthly', { timestamp: nowJSTISO(), results: [result] });
      this._saveResultsSync();
      // Small delay to allow email send to complete
      await new Promise((r) => setTimeout(r, 1000));
      exitWithPm2Update(0);
    }

    return result;
  }

  // =========================================================================
  // pip pipeline (update -> test -> rollback on failure)
  // =========================================================================

  async _runPipPipeline(item) {
    const result = { name: item.name, success: true };

    // Record versions before
    const beforeInfo = await this._exec(item.versionCmd);
    const versionsBefore = this._parsePipVersions(beforeInfo.stdout);
    result.versionsBefore = versionsBefore;

    // Run upgrade
    const update = await this._exec(item.cmd);
    if (!update.success) {
      return { ...result, success: false, error: update.error };
    }

    // Record versions after
    const afterInfo = await this._exec(item.versionCmd);
    const versionsAfter = this._parsePipVersions(afterInfo.stdout);
    result.versionsAfter = versionsAfter;

    // Check if anything changed
    const changed = Object.keys(versionsBefore).some(
      (pkg) => versionsBefore[pkg] !== versionsAfter[pkg],
    );
    if (!changed) {
      return { ...result, skipped: 'already latest' };
    }

    // Run tests
    const test = await this._exec(item.testCmd, {
      cwd: item.testCwd,
      timeout: UPDATE_TEST_TIMEOUT_MS,
    });
    if (!test.success) {
      // Rollback to previous versions
      const rollbackParts = Object.entries(versionsBefore).map(([pkg, ver]) => `${pkg}==${ver}`);
      const rollbackCmd = `python -m pip install ${rollbackParts.join(' ')}`;
      await this._exec(rollbackCmd);
      return { ...result, success: false, rolledBack: true, testError: test.error || test.stderr };
    }

    return result;
  }

  _parsePipVersions(output) {
    const versions = {};
    if (!output) return versions;
    const matches = output.matchAll(/Name:\s+(\S+)[\s\S]*?Version:\s+(\S+)/g);
    for (const m of matches) {
      versions[m[1].toLowerCase()] = m[2];
    }
    return versions;
  }

  // =========================================================================
  // Git helpers
  // =========================================================================

  async _gitDiff(repoDir) {
    const { success, stdout } = await this._exec('git diff --name-only', { cwd: repoDir });
    if (!success || !stdout) return [];
    return stdout.split('\n').filter(Boolean);
  }

  async _gitCommit(repoDir, files, msg) {
    for (const f of files) {
      await this._exec(`git add "${f}"`, { cwd: repoDir });
    }
    await this._exec(`git commit -m "${msg}"`, { cwd: repoDir });
  }

  async _gitStashRevert(repoDir) {
    await this._exec('git stash -u', { cwd: repoDir });
  }

  // =========================================================================
  // Version extraction
  // =========================================================================

  _extractVersion(output) {
    if (!output) return 'unknown';
    const match = output.match(/v?\d+\.\d+\.\d+/);
    return match ? match[0] : output.split('\n')[0].trim();
  }

  // =========================================================================
  // Weekly cross-tier summary (sole email mechanism)
  // =========================================================================

  async _sendWeeklySummary() {
    if (!this._emailService) return;

    const TIER_WINDOWS = { daily: 2, weekly: 8, monthly: 32 }; // days
    const now = Date.now();
    const sections = [];

    for (const [tier, windowDays] of Object.entries(TIER_WINDOWS)) {
      const entry = this._lastResults.get(tier);
      if (!entry || now - new Date(entry.timestamp).getTime() > windowDays * 86400000) {
        sections.push(`<b>${tier}</b>\n  No recent results`);
        continue;
      }
      const lines = entry.results.map((r) => {
        if (r.skipped) return `  ✅ ${r.name}: ${r.skipped}`;
        if (!r.success) return `  ❌ ${r.name}: ${r.error || r.testError || 'failed'}`;
        if (r.committed) return `  📦 ${r.name}: committed (${r.changedFiles?.join(', ') || ''})`;
        if (r.versionBefore && r.versionAfter) {
          const suffix = r.pendingReload ? ' (daemon reload pending)' : '';
          return `  🔄 ${r.name}: ${this._extractVersion(r.versionBefore)} → ${this._extractVersion(r.versionAfter)}${suffix}`;
        }
        if (r.outdated?.length > 0) {
          const pkgs = r.outdated.map((p) => `${p.package} ${p.current}→${p.latest}`).join(', ');
          return `  📋 ${r.name}: outdated — ${pkgs}`;
        }
        return `  ✅ ${r.name}: ok`;
      });
      sections.push(`<b>${tier}</b> (${entry.timestamp.slice(0, 10)})\n${lines.join('\n')}`);
    }

    const subject = `[Dep-Summary] Weekly — ${nowJSTISO().slice(0, 10)}`;
    const html = `<pre style="font-family:monospace;font-size:14px">${sections.join('\n\n')}</pre>`;
    try {
      await this._emailService.sendHtml(subject, html);
      log.info(`[Email] Sent: ${subject}`);
    } catch (err) {
      log.error(`[Email] Weekly summary failed: ${err.message}`);
    }
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  _saveResults() {
    try {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const data = {};
      for (const [tier, val] of this._lastResults) {
        data[tier] = val;
      }
      fs.writeFileSync(RESULTS_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error(`[Save] Failed: ${err.message}`);
    }
  }

  _saveResultsSync() {
    // Same as _saveResults but explicit about being sync (for pre-exit use)
    this._saveResults();
  }

  _loadResults() {
    try {
      const raw = fs.readFileSync(RESULTS_PATH, 'utf8');
      const data = JSON.parse(raw);
      for (const [tier, val] of Object.entries(data)) {
        this._lastResults.set(tier, val);
      }
      log.info(`[Load] Restored ${Object.keys(data).length} tier results`);
    } catch {
      // File doesn't exist or corrupt — start fresh
    }
  }
}
