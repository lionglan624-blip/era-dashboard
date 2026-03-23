import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import {
  TMP_CLEANUP_INTERVAL_MS,
  DEBUG_LOG_RETENTION_DAYS,
  DAILY_LOG_RETENTION_DAYS,
} from '../config.js';

/** Maximum size for individual debug log files (50 MB) */
const DEBUG_LOG_MAX_SIZE_BYTES = 50 * 1024 * 1024;

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

    // 1b. Oversized debug logs — regardless of age
    const debugSizeResult = await this._purgeBySize(
      this.dashboardTmpDir,
      /^debug-.+\.log$/,
      DEBUG_LOG_MAX_SIZE_BYTES,
    );
    totalDeleted += debugSizeResult.count;
    totalBytes += debugSizeResult.bytes;

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

    // 5. Execution history JSONL — prune entries older than 7 days
    const historyPath = path.join(this.dashboardTmpDir, 'execution-history.jsonl');
    const historyPruned = await this._pruneHistoryJsonl(historyPath, DAILY_LOG_RETENTION_DAYS);
    if (historyPruned > 0) {
      this.logger.info(`Pruned ${historyPruned} old history entries`);
    }

    if (totalDeleted > 0) {
      const mb = (totalBytes / 1048576).toFixed(1);
      this.logger.info(`Purged ${totalDeleted} files (${mb} MB freed)`);
    }

    return { count: totalDeleted, bytes: totalBytes };
  }

  async _pruneHistoryJsonl(filePath, maxAgeDays) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      if (!raw.trim()) return 0;
      const cutoff = Date.now() - maxAgeDays * 86400000;
      const lines = raw.trim().split('\n');
      const kept = [];
      let pruned = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const ts = entry.completedAt || entry.startedAt;
          if (ts && new Date(ts).getTime() >= cutoff) {
            kept.push(line);
          } else {
            pruned++;
          }
        } catch {
          pruned++;
        }
      }
      if (pruned > 0) {
        await fs.writeFile(filePath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
      }
      return pruned;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.warn(`Failed to prune history JSONL: ${err.message}`);
      }
      return 0;
    }
  }

  /**
   * Remove files matching a pattern that exceed a size limit.
   * @param {string} dir - Directory to scan
   * @param {RegExp} pattern - Filename pattern
   * @param {number} maxBytes - Maximum file size in bytes
   * @returns {Promise<{count: number, bytes: number}>}
   */
  async _purgeBySize(dir, pattern, maxBytes) {
    let count = 0;
    let bytes = 0;

    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
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
        if (stat.size > maxBytes) {
          await fs.unlink(filePath);
          count++;
          bytes += stat.size;
          this.logger.info(
            `Purged oversized file ${entry} (${(stat.size / 1048576).toFixed(1)} MB)`,
          );
        }
      } catch (err) {
        this.logger.warn(`Failed to check size of ${entry}:`, err.message);
      }
    }

    return { count, bytes };
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
