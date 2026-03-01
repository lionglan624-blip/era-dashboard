import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import {
  TMP_CLEANUP_INTERVAL_MS,
  DEBUG_LOG_RETENTION_DAYS,
  DAILY_LOG_RETENTION_DAYS,
} from '../config.js';

export class CleanupService {
  constructor(projectRoot) {
    this.dashboardTmpDir = path.join(projectRoot, '_out', 'tmp', 'dashboard');
    this.logsDir = path.join(this.dashboardTmpDir, 'logs');
    this.logger = createLogger('cleanup');
    this._interval = null;
  }

  start() {
    this.purge().catch((err) => this.logger.error('Initial purge failed:', err.message));
    this._interval = setInterval(() => {
      this.purge().catch((err) => this.logger.error('Periodic purge failed:', err.message));
    }, TMP_CLEANUP_INTERVAL_MS);
    this.logger.info('Cleanup service started', {
      intervalHours: TMP_CLEANUP_INTERVAL_MS / 3600000,
      debugRetentionDays: DEBUG_LOG_RETENTION_DAYS,
      dailyLogRetentionDays: DAILY_LOG_RETENTION_DAYS,
    });
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
      this.logger.info('Cleanup service stopped');
    }
  }

  async purge() {
    let totalDeleted = 0;
    let totalBytes = 0;

    // 1. Per-execution debug logs (debug-*.log) — 3 day retention
    const debugResult = await this._purgeByAge(
      this.dashboardTmpDir,
      /^debug-.+\.log$/,
      DEBUG_LOG_RETENTION_DAYS,
    );
    totalDeleted += debugResult.count;
    totalBytes += debugResult.bytes;

    // 2. Daily rotated logs (*-YYYY-MM-DD.log) — 7 day retention
    const dailyResult = await this._purgeByAge(
      this.logsDir,
      /^.+-\d{4}-\d{2}-\d{2}\.log$/,
      DAILY_LOG_RETENTION_DAYS,
    );
    totalDeleted += dailyResult.count;
    totalBytes += dailyResult.bytes;

    // 3. Term debug logs (term-*.debug.log) — 7 day retention
    const termResult = await this._purgeByAge(
      this.dashboardTmpDir,
      /^term-.+\.debug\.log$/,
      DAILY_LOG_RETENTION_DAYS,
    );
    totalDeleted += termResult.count;
    totalBytes += termResult.bytes;

    // 4. Exec artifacts (exec-*.jsonl, exec-*.sh) — 7 day retention
    const execResult = await this._purgeByAge(
      this.dashboardTmpDir,
      /^exec-.+\.(jsonl|sh)$/,
      DAILY_LOG_RETENTION_DAYS,
    );
    totalDeleted += execResult.count;
    totalBytes += execResult.bytes;

    if (totalDeleted > 0) {
      const mb = (totalBytes / 1048576).toFixed(1);
      this.logger.info(`Purged ${totalDeleted} files (${mb} MB freed)`);
    }

    return { count: totalDeleted, bytes: totalBytes };
  }

  async _purgeByAge(dir, pattern, maxAgeDays) {
    let count = 0;
    let bytes = 0;
    const cutoff = Date.now() - maxAgeDays * 86400000;

    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      // Directory doesn't exist or isn't readable — not an error
      if (err.code !== 'ENOENT') {
        this.logger.warn(`Failed to read directory ${dir}:`, err.message);
      }
      return { count, bytes };
    }

    for (const entry of entries) {
      if (!pattern.test(entry)) continue;

      const filePath = path.join(dir, entry);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filePath);
          count++;
          bytes += stat.size;
        }
      } catch (err) {
        this.logger.warn(`Failed to purge ${entry}:`, err.message);
      }
    }

    return { count, bytes };
  }
}
