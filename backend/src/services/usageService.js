/**
 * Usage Service - CCS Profile Usage Tracking
 *
 * STATUS: Implemented but not exposed via API.
 *
 * This service reads CCS profile stats and JSONL session files to calculate
 * estimated token usage for weekly/session limits. It was developed for usage
 * monitoring but is not currently integrated into the dashboard UI.
 *
 * To enable: Create routes in features.js or a new usage.js route file.
 *
 * Key features:
 * - Read stats-cache.json per CCS profile
 * - Calculate weekly token usage from JSONL session files
 * - Estimate percentage of weekly/session rate limits consumed
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { createReadStream } from 'fs';
import readline from 'readline';
import { serverLog } from '../utils/logger.js';

// CCS configuration (same constants as claudeService.js)
const CCS_DIR =
  process.env.CCS_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', '.ccs');
const CCS_INSTANCES_DIR = process.env.CCS_INSTANCES_DIR || path.join(CCS_DIR, 'instances');

// Claude Max limits (calibrated from /usage vs JSONL token counts on 2026-01-31)
// rateLimitTier: default_claude_max_20x
// Calibration: 2.824B tokens = 33% week-all → 8.56B, 1.364B = 12% sonnet → 11.4B
// Session: 430M = 25% → 1.72B (note: running session JSONL incomplete → underestimates)
const WEEKLY_LIMITS = {
  allModels: 8_600_000_000, // ~8.6B tokens/week (all token types combined)
  sonnetOnly: 11_400_000_000, // ~11.4B tokens/week (Sonnet separate limit)
};
const SESSION_LIMIT = 1_700_000_000; // ~1.7B tokens per session window
const SESSION_WINDOW_HOURS = 5; // Session window is ~5 hours
// Known weekly reset anchor: Feb 6, 2026 8am JST (2026-02-05T23:00:00Z)
const WEEKLY_RESET_ANCHOR = new Date('2026-02-05T23:00:00Z');

export class UsageService {
  constructor() {
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = 30000; // 30 seconds cache
    this._estimatedCache = null;
    this._estimatedCacheTime = 0;
    this._estimatedCacheTTL = 60000; // 60 seconds cache for estimated usage
  }

  /**
   * Get the stats-cache.json path for a given CCS profile
   */
  _getStatsPath(profile) {
    return path.join(CCS_INSTANCES_DIR, profile, 'stats-cache.json');
  }

  /**
   * List available CCS profiles that have stats-cache.json
   */
  getProfiles() {
    const profiles = [];
    try {
      if (!existsSync(CCS_INSTANCES_DIR)) return profiles;
      const entries = readdirSync(CCS_INSTANCES_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const statsPath = this._getStatsPath(entry.name);
          if (existsSync(statsPath)) {
            profiles.push(entry.name);
          }
        }
      }
    } catch (err) {
      serverLog.debug(`Failed to list profiles: ${err.message}`);
    }
    return profiles;
  }

  /**
   * Read and parse stats-cache.json for a profile
   */
  _readStats(profile) {
    const statsPath = this._getStatsPath(profile);
    if (!existsSync(statsPath)) {
      return null;
    }
    try {
      const raw = readFileSync(statsPath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      serverLog.error(`Failed to read stats for profile ${profile}: ${err.message}`);
      return null;
    }
  }

  /**
   * Get usage data for a specific profile
   * Returns weekly summary + totals
   */
  getUsage(profile) {
    const stats = this._readStats(profile);
    if (!stats) {
      return null;
    }

    // Calculate weekly totals from dailyActivity (last 7 days)
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().slice(0, 10);

    const weeklyActivity = (stats.dailyActivity || []).filter((d) => d.date >= weekAgoStr);
    const weeklyTokens = (stats.dailyModelTokens || []).filter((d) => d.date >= weekAgoStr);

    const weekly = {
      messages: weeklyActivity.reduce((sum, d) => sum + (d.messageCount || 0), 0),
      sessions: weeklyActivity.reduce((sum, d) => sum + (d.sessionCount || 0), 0),
      toolCalls: weeklyActivity.reduce((sum, d) => sum + (d.toolCallCount || 0), 0),
      tokensByModel: {},
      dailyActivity: weeklyActivity,
    };

    // Aggregate tokens by model for the week
    for (const day of weeklyTokens) {
      for (const [model, tokens] of Object.entries(day.tokensByModel || {})) {
        weekly.tokensByModel[model] = (weekly.tokensByModel[model] || 0) + tokens;
      }
    }

    return {
      profile,
      lastComputedDate: stats.lastComputedDate,
      weekly,
      totals: {
        sessions: stats.totalSessions || 0,
        messages: stats.totalMessages || 0,
        firstSessionDate: stats.firstSessionDate || null,
      },
      modelUsage: stats.modelUsage || {},
    };
  }

  /**
   * Get usage for the current CCS profile (from environment)
   */
  getCurrentUsage() {
    const profile = process.env.CCS_PROFILE || 'goog';
    return this.getUsage(profile);
  }

  /**
   * Get usage for all available profiles
   */
  getAllUsage() {
    const profiles = this.getProfiles();
    const result = {};
    for (const profile of profiles) {
      const usage = this.getUsage(profile);
      if (usage) {
        result[profile] = usage;
      }
    }
    return result;
  }

  /**
   * Get current week boundaries based on weekly reset anchor
   */
  _getWeekBoundaries() {
    const now = new Date();
    const anchorTime = WEEKLY_RESET_ANCHOR.getTime();
    const nowTime = now.getTime();
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    // Calculate how many complete weeks since anchor
    const weeksSinceAnchor = Math.floor((nowTime - anchorTime) / weekMs);

    // Current week start is anchor + (complete weeks * week duration)
    const weekStart = new Date(anchorTime + weeksSinceAnchor * weekMs);
    const weekEnd = new Date(weekStart.getTime() + weekMs);

    return { weekStart, weekEnd };
  }

  /**
   * Find all JSONL session files modified since a given date
   */
  _getSessionFiles(profile, since) {
    const files = [];
    const profileDir = path.join(CCS_INSTANCES_DIR, profile);
    const projectsDir = path.join(profileDir, 'projects');

    if (!existsSync(projectsDir)) {
      return files;
    }

    try {
      const projects = readdirSync(projectsDir, { withFileTypes: true });
      for (const project of projects) {
        if (!project.isDirectory()) continue;

        const projectPath = path.join(projectsDir, project.name);
        const entries = readdirSync(projectPath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const filePath = path.join(projectPath, entry.name);
            const stats = statSync(filePath);

            // Only include files modified within the time window
            if (stats.mtime >= since) {
              files.push(filePath);
            }
          }
        }
      }
    } catch (err) {
      serverLog.error(`Error scanning session files for ${profile}: ${err.message}`);
    }

    return files;
  }

  /**
   * Parse a JSONL file and sum tokens per model for entries after a given timestamp
   */
  async _parseSessionTokens(jsonlPath, since) {
    const modelTokens = {};
    let sessionStart = null;
    let sessionEnd = null;

    const fileStream = createReadStream(jsonlPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);

          // Only count assistant messages with usage data
          if (entry.type !== 'assistant' || !entry.message?.usage) continue;

          const timestamp = entry.message.created_at
            ? new Date(entry.message.created_at * 1000)
            : null;

          // Skip entries before the time window
          if (timestamp && timestamp < since) continue;

          // Track session time range
          if (timestamp) {
            if (!sessionStart || timestamp < sessionStart) {
              sessionStart = timestamp;
            }
            if (!sessionEnd || timestamp > sessionEnd) {
              sessionEnd = timestamp;
            }
          }

          const usage = entry.message.usage;
          const model = entry.message.model || 'unknown';

          if (!modelTokens[model]) {
            modelTokens[model] = {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheCreation: 0,
              total: 0,
            };
          }

          const input = usage.input_tokens || 0;
          const output = usage.output_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheCreation = usage.cache_creation_input_tokens || 0;

          modelTokens[model].input += input;
          modelTokens[model].output += output;
          modelTokens[model].cacheRead += cacheRead;
          modelTokens[model].cacheCreation += cacheCreation;
          modelTokens[model].total += input + output + cacheRead + cacheCreation;
        } catch (_parseErr) {
          // Skip malformed lines
          continue;
        }
      }
    } catch (err) {
      serverLog.error(`Error parsing JSONL ${jsonlPath}: ${err.message}`);
    }

    return { modelTokens, sessionStart, sessionEnd };
  }

  /**
   * Get weekly usage estimation based on JSONL session files
   */
  async getWeeklyUsage(profile) {
    const { weekStart, weekEnd } = this._getWeekBoundaries();
    const files = this._getSessionFiles(profile, weekStart);

    const tokensByModel = {};
    let totalTokens = 0;

    for (const file of files) {
      const { modelTokens } = await this._parseSessionTokens(file, weekStart);

      // Aggregate tokens by model
      for (const [model, tokens] of Object.entries(modelTokens)) {
        if (!tokensByModel[model]) {
          tokensByModel[model] = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheCreation: 0,
            total: 0,
          };
        }

        tokensByModel[model].input += tokens.input;
        tokensByModel[model].output += tokens.output;
        tokensByModel[model].cacheRead += tokens.cacheRead;
        tokensByModel[model].cacheCreation += tokens.cacheCreation;
        tokensByModel[model].total += tokens.total;

        totalTokens += tokens.total;
      }
    }

    const estimatedPercent = (totalTokens / WEEKLY_LIMITS.allModels) * 100;

    return {
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      tokensByModel,
      totalTokens,
      estimatedPercent: Math.min(estimatedPercent, 100),
    };
  }

  /**
   * Get session window usage (last 5 hours)
   */
  async getSessionUsage(profile) {
    const now = new Date();
    const windowStart = new Date(now.getTime() - SESSION_WINDOW_HOURS * 60 * 60 * 1000);

    const files = this._getSessionFiles(profile, windowStart);
    let totalTokens = 0;

    for (const file of files) {
      const { modelTokens } = await this._parseSessionTokens(file, windowStart);

      for (const tokens of Object.values(modelTokens)) {
        totalTokens += tokens.total;
      }
    }

    const estimatedPercent = (totalTokens / SESSION_LIMIT) * 100;

    return {
      windowStart: windowStart.toISOString(),
      totalTokens,
      estimatedPercent: Math.min(estimatedPercent, 100),
    };
  }

  /**
   * Get estimated usage combining weekly + session
   */
  async getEstimatedUsage(profile = null) {
    profile = profile || process.env.CCS_PROFILE || 'goog';

    // Check cache
    const now = Date.now();
    if (
      this._estimatedCache &&
      this._estimatedCache.profile === profile &&
      now - this._estimatedCacheTime < this._estimatedCacheTTL
    ) {
      return this._estimatedCache.data;
    }

    try {
      const weeklyAll = await this.getWeeklyUsage(profile);
      const session = await this.getSessionUsage(profile);
      const { weekStart: _weekStart, weekEnd } = this._getWeekBoundaries();

      // Calculate Sonnet-only usage
      let sonnetTokens = 0;
      for (const [model, tokens] of Object.entries(weeklyAll.tokensByModel)) {
        if (model.includes('sonnet')) {
          sonnetTokens += tokens.total;
        }
      }

      const sonnetPercent = (sonnetTokens / WEEKLY_LIMITS.sonnetOnly) * 100;

      const result = {
        session: {
          percent: session.estimatedPercent,
          resetsAt: new Date(Date.now() + SESSION_WINDOW_HOURS * 60 * 60 * 1000).toISOString(),
          totalTokens: session.totalTokens,
        },
        weekAll: {
          percent: weeklyAll.estimatedPercent,
          resetsAt: weekEnd,
          totalTokens: weeklyAll.totalTokens,
          tokensByModel: weeklyAll.tokensByModel,
        },
        weekSonnet: {
          percent: Math.min(sonnetPercent, 100),
          resetsAt: weekEnd,
          totalTokens: sonnetTokens,
        },
        lastUpdated: new Date().toISOString(),
        isEstimate: true,
      };

      // Cache the result
      this._estimatedCache = {
        profile,
        data: result,
      };
      this._estimatedCacheTime = now;

      return result;
    } catch (err) {
      serverLog.error(`Error calculating estimated usage for ${profile}: ${err.message}`);
      return {
        error: err.message,
        isEstimate: true,
      };
    }
  }
}
