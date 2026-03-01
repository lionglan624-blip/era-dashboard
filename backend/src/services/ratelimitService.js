import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { claudeLog } from '../utils/logger.js';
import {
  RATE_LIMIT_CACHE_MS,
  RATE_LIMIT_CAPTURE_TIMEOUT_MS,
  RATE_LIMIT_IDLE_REFRESH_MS,
  CCS_INSTANCES_DIR,
  SESSION_WINDOW_MS,
  SESSION_BURN_RATE_MIN_ELAPSED_MS,
  SESSION_BURN_RATE_MIN_PERCENT,
  AUTO_SWITCH_THRESHOLD,
} from '../config.js';

/**
 * Minimal VT terminal emulator - reconstructs screen buffer from VT escape sequences.
 * Equivalent to ReadConsoleOutputCharacterW: produces a character grid with proper spacing.
 *
 * @param {number} cols - Terminal width
 * @param {number} rows - Terminal height
 */
class VtScreenBuffer {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.buffer = [];
    this.cx = 0;
    this.cy = 0;
    for (let i = 0; i < rows; i++) {
      this.buffer.push(new Array(cols).fill(' '));
    }
  }

  /**
   * Feed VT data into the buffer, processing escape sequences and characters.
   * @param {string} data - Raw VT output from node-pty
   */
  feed(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        i = this._parseEscape(data, i + 1);
      } else if (ch === '\r') {
        this.cx = 0;
        i++;
      } else if (ch === '\n') {
        this.cy = Math.min(this.cy + 1, this.rows - 1);
        i++;
      } else if (ch === '\t') {
        this.cx = Math.min(this.cx + (8 - (this.cx % 8)), this.cols - 1);
        i++;
      } else if (ch === '\x07' || ch === '\x08') {
        // BEL: ignore, BS: move back
        if (ch === '\x08') this.cx = Math.max(0, this.cx - 1);
        i++;
      } else if (ch.charCodeAt(0) < 32) {
        i++; // skip other control chars
      } else {
        // Printable character
        if (this.cx < this.cols && this.cy < this.rows) {
          this.buffer[this.cy][this.cx] = ch;
          this.cx++;
        }
        i++;
      }
    }
  }

  _parseEscape(data, i) {
    if (i >= data.length) return i;
    if (data[i] === '[') {
      return this._parseCSI(data, i + 1);
    } else if (data[i] === ']') {
      return this._skipOSC(data, i + 1);
    }
    return i + 1; // skip single-char escape (e.g., \x1b7, \x1bM)
  }

  _parseCSI(data, i) {
    let params = '';
    while (i < data.length && data[i] >= '\x20' && data[i] <= '\x3f') {
      params += data[i];
      i++;
    }
    if (i < data.length) {
      this._handleCSI(params, data[i]);
      i++;
    }
    return i;
  }

  _skipOSC(data, i) {
    // Skip until BEL (\x07) or ST (\x1b\\)
    while (i < data.length) {
      if (data[i] === '\x07') return i + 1;
      if (data[i] === '\x1b' && i + 1 < data.length && data[i + 1] === '\\') return i + 2;
      i++;
    }
    return i;
  }

  _handleCSI(params, cmd) {
    // Parse semicolon-separated numeric params (e.g., "10;20" → [10, 20])
    const parts = params
      .replace(/\?/g, '')
      .split(';')
      .map((s) => parseInt(s) || 0);
    switch (cmd) {
      case 'A': // cursor up
        this.cy = Math.max(0, this.cy - (parts[0] || 1));
        break;
      case 'B': // cursor down
        this.cy = Math.min(this.rows - 1, this.cy + (parts[0] || 1));
        break;
      case 'C': // cursor forward
        this.cx = Math.min(this.cols - 1, this.cx + (parts[0] || 1));
        break;
      case 'D': // cursor back
        this.cx = Math.max(0, this.cx - (parts[0] || 1));
        break;
      case 'H':
      case 'f': // cursor position (row;col, 1-based)
        this.cy = Math.max(0, Math.min(this.rows - 1, (parts[0] || 1) - 1));
        this.cx = Math.max(0, Math.min(this.cols - 1, (parts[1] || 1) - 1));
        break;
      case 'G': // cursor to column (1-based)
        this.cx = Math.max(0, Math.min(this.cols - 1, (parts[0] || 1) - 1));
        break;
      case 'J': // erase display
        if (parts[0] === 2 || parts[0] === 3) {
          for (let r = 0; r < this.rows; r++) this.buffer[r].fill(' ');
        } else if (parts[0] === 0 || params === '') {
          // Erase from cursor to end
          for (let c = this.cx; c < this.cols; c++) this.buffer[this.cy][c] = ' ';
          for (let r = this.cy + 1; r < this.rows; r++) this.buffer[r].fill(' ');
        }
        break;
      case 'K': // erase line
        if ((parts[0] || 0) === 0) {
          for (let c = this.cx; c < this.cols; c++) this.buffer[this.cy][c] = ' ';
        } else if (parts[0] === 1) {
          for (let c = 0; c <= this.cx; c++) this.buffer[this.cy][c] = ' ';
        } else if (parts[0] === 2) {
          this.buffer[this.cy].fill(' ');
        }
        break;
      // m (SGR/style), h/l (mode set/reset), etc. — ignore
    }
  }

  /**
   * Get the screen content as text lines (trimmed end whitespace).
   * @returns {string} Screen text with newlines
   */
  getText() {
    return this.buffer
      .map((row) => row.join('').trimEnd())
      .filter((line) => line.length > 0)
      .join('\n');
  }
}

/**
 * Service for capturing rate limit information from Claude Code's console output.
 * Uses node-pty with ConPTY to capture output headlessly without visible windows.
 */
export class RateLimitService {
  /**
   * @param {string} projectRoot - Project root directory
   * @param {Object} [options]
   * @param {function(): string[]} [options.getProfiles] - Function to get list of profiles
   * @param {function} [options.ptySpawn] - Optional pty.spawn function for testing
   * @param {function} [options.isIdle] - Function returning true when no executions running/queued
   */
  constructor(projectRoot, { getProfiles, ptySpawn, getActiveProfile, onAutoSwitch, isIdle } = {}) {
    this.projectRoot = projectRoot;
    this.getProfiles = getProfiles || (() => []);
    this._ptySpawn = ptySpawn || null;
    this._getActiveProfile = getActiveProfile || (() => null);
    this._onAutoSwitch = onAutoSwitch || null;
    this._isIdle = isIdle || (() => false);
    this._cache = new Map(); // Map<profileName, { data, timestamp, expiresAt, refreshAt }>
    this._capturing = false; // Prevent concurrent captures
    this._cacheFile = path.join(projectRoot, '_out', 'tmp', 'dashboard', 'ratelimit-cache.json');
    this._loadCache();
  }

  /**
   * Load cache from disk, filtering out expired entries.
   */
  _loadCache() {
    try {
      if (!fs.existsSync(this._cacheFile)) return;
      const raw = JSON.parse(fs.readFileSync(this._cacheFile, 'utf8'));
      const now = Date.now();
      for (const [profile, entry] of Object.entries(raw)) {
        if (entry.expiresAt > now) {
          this._cache.set(profile, entry);
          claudeLog.info(
            `[RateLimit] Loaded cache for ${profile}: ${entry.data?.weekly?.percent ?? '-'}% weekly, ${entry.data?.session?.percent ?? '-'}% session, expires ${new Date(entry.expiresAt).toISOString()}`,
          );
        }
      }
    } catch (err) {
      claudeLog.error(`[RateLimit] Failed to load cache: ${err.message}`);
    }
  }

  /**
   * Save cache to disk.
   */
  _saveCache() {
    try {
      const dir = path.dirname(this._cacheFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = Object.fromEntries(this._cache);
      fs.writeFileSync(this._cacheFile, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      claudeLog.error(`[RateLimit] Failed to save cache: ${err.message}`);
    }
  }

  /**
   * Capture rate limit info (with caching) for all profiles.
   * @param {Object} [options]
   * @param {boolean} [options.forceRefresh=false] - Skip cache check
   * @returns {Promise<Object|null>} Rate limit data by profile or null
   */
  async capture({ forceRefresh = false } = {}) {
    // Prevent concurrent captures
    if (this._capturing) {
      return this.getCached();
    }

    const profiles = this.getProfiles();
    claudeLog.info(`[RateLimit] Profiles: [${profiles.join(', ')}]`);
    if (profiles.length === 0) return null;

    this._capturing = true;
    try {
      // Filter to profiles needing refresh
      // Check both refreshAt (normal polling cycle) and expiresAt (data no longer valid)
      // to prevent a gap where expired data isn't refreshed until the next polling cycle
      const staleProfiles = profiles.filter((profile) => {
        const cached = this._cache.get(profile);
        return (
          forceRefresh ||
          !cached ||
          Date.now() >= cached.refreshAt ||
          Date.now() >= cached.expiresAt
        );
      });

      // Capture all stale profiles in parallel
      if (staleProfiles.length > 0) {
        const results = await Promise.allSettled(
          staleProfiles.map(async (profile) => {
            const env = { ...process.env, FORCE_COLOR: '0' };
            env.CLAUDE_CONFIG_DIR = path.join(CCS_INSTANCES_DIR, profile);
            claudeLog.info(`[RateLimit] Starting capture for ${profile}`);
            const captureText = await this._runCapture(env);
            const rawData = this._parseUsageOutput(captureText);
            const mergedData = this._mergeWithCached(profile, rawData);
            const refreshAt = this._computeRefreshAt(mergedData);
            const expiresAt = mergedData ? this._computeExpiresAt(mergedData) : refreshAt;
            this._cache.set(profile, {
              data: mergedData,
              timestamp: Date.now(),
              expiresAt,
              refreshAt,
            });
            this._saveCache();
          }),
        );

        // Log failures (cache preserved for failed profiles)
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === 'rejected') {
            claudeLog.error(
              `[RateLimit] Capture failed for ${staleProfiles[i]}: ${results[i].reason?.message}`,
            );
          }
        }
      }

      const cached = this.getCached();
      this._checkAutoSwitch(cached);
      return cached;
    } finally {
      this._capturing = false;
    }
  }

  /**
   * Get the pty.spawn function (lazy load node-pty).
   * @returns {Promise<function>} pty.spawn function
   */
  async _getPtySpawn() {
    if (this._ptySpawn) return this._ptySpawn;
    const nodePty = await import('node-pty');
    return nodePty.default?.spawn || nodePty.spawn;
  }

  /**
   * Run the capture using node-pty with ConPTY.
   * @param {Object} env - Environment variables
   * @returns {Promise<string>} Captured output
   */
  async _runCapture(env) {
    const spawn = await this._getPtySpawn();

    return new Promise((resolve) => {
      let resolved = false;
      const screen = new VtScreenBuffer(120, 30);

      // cmd.exe /c claude is required: cmd.exe reconnects standard handles to CONOUT$/CONIN$,
      // so claude's isatty(stdout) returns true and TUI renders in the ConPTY.
      // Direct claude.exe spawn fails because ConPTY pipes are inherited as standard handles,
      // making isatty(stdout) return false → no TUI rendering → no rate limit text to capture.
      //
      // WT_SESSION prevents Windows Terminal from intercepting the ConPTY cmd.exe spawn
      // and opening a visible tab. WT checks this env var to detect nested sessions.
      const captureEnv = { ...env, WT_SESSION: '00000000-0000-0000-0000-000000000000' };
      delete captureEnv.CLAUDECODE; // Prevent nested session detection
      const ptyProcess = spawn('cmd.exe', ['/c', 'claude'], {
        cols: 120,
        rows: 30,
        env: captureEnv,
        useConptyDll: true,
      });

      claudeLog.info(`[RateLimit] Spawned pty process PID=${ptyProcess.pid}`);

      let tuiDetected = false;
      let usageSent = false;
      let usageDetected = false;
      let usageScreen = null; // Clean buffer for /usage output (no retainText artifacts)

      ptyProcess.onData((data) => {
        screen.feed(data);
        if (usageScreen) usageScreen.feed(data);
        if (resolved) return;

        const text = screen.getText();

        // Phase 3: After /usage sent, check for output completion
        // /usage renders multi-line sections: session → week (all models) → week (Sonnet only) → Extra usage → Esc to cancel
        // Detect completion by "Esc to cancel" (final line) or "Sonnet" section appearing
        if (usageSent && !usageDetected) {
          const hasEsc = /Esc to cancel/i.test(text);
          const hasSonnet = /Sonnet\s+only/i.test(text) && /\d+%[^\d%]{0,15}used/i.test(text);
          if (hasEsc || hasSonnet) {
            usageDetected = true;
            claudeLog.info(
              `[RateLimit] Usage output detected (${hasEsc ? 'Esc' : 'Sonnet'}), waiting 500ms for complete render PID=${ptyProcess.pid}`,
            );
            // Wait 500ms for remaining lines to render
            setTimeout(() => {
              if (!resolved) {
                resolved = true;
                claudeLog.info(
                  `[RateLimit] Usage capture complete, killing pty PID=${ptyProcess.pid}`,
                );
                this._killPty(ptyProcess);
                resolve(usageScreen?.getText() || screen.getText());
              }
            }, 500);
          }
        }

        // Phase 1: Detect TUI loaded (status bar)
        if (!tuiDetected) {
          const hasStatusBar = /Context:\d+%/.test(text);
          if (hasStatusBar) {
            tuiDetected = true;
            claudeLog.info(
              `[RateLimit] TUI detected (status bar), waiting 1.5s to stabilize PID=${ptyProcess.pid}`,
            );
            // Phase 2: Wait 1.5s for TUI stabilization, then send /usage
            setTimeout(() => {
              if (!resolved && !usageSent) {
                usageSent = true;
                claudeLog.info(`[RateLimit] Sending /usage command PID=${ptyProcess.pid}`);
                ptyProcess.write('/usage');
                // Delay Enter to let autocomplete menu settle before submission
                setTimeout(() => {
                  // Create clean buffer BEFORE Enter: captures /usage output without autocomplete artifacts
                  usageScreen = new VtScreenBuffer(120, 30);
                  ptyProcess.write('\r');
                }, 800);
                // Fallback: resolve after 6s even if /usage output not detected
                setTimeout(() => {
                  if (!resolved) {
                    resolved = true;
                    claudeLog.info(
                      `[RateLimit] Usage response timeout, resolving with current buffer PID=${ptyProcess.pid}`,
                    );
                    this._killPty(ptyProcess);
                    resolve(usageScreen?.getText() || screen.getText());
                  }
                }, 5000);
              }
            }, 1500);
          }
        }
      });

      // Overall timeout
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          claudeLog.info(`[RateLimit] Capture timeout reached, killing pty PID=${ptyProcess.pid}`);
          this._killPty(ptyProcess);
          resolve(usageScreen?.getText() || screen.getText());
        }
      }, RATE_LIMIT_CAPTURE_TIMEOUT_MS);

      ptyProcess.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          const exitText = usageScreen?.getText() || screen.getText();
          claudeLog.info(
            `[RateLimit] Pty exited with code ${exitCode}, buffer(${exitText.length}): ${exitText.substring(0, 300).replace(/\n/g, '\\n')}`,
          );
          resolve(exitText);
        }
      });
    });
  }

  /**
   * Kill a pty process with fallback to taskkill.
   * @param {Object} ptyProcess - The pty process to kill
   */
  _killPty(ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {
      try {
        if (ptyProcess.pid) {
          execSync(`taskkill /F /T /PID ${ptyProcess.pid}`, { windowsHide: true });
        }
      } catch (killErr) {
        claudeLog.debug(`[RateLimit] taskkill fallback failed: ${killErr.message}`);
      }
    }
  }

  /**
   * Parse /usage command output for exact usage percentages.
   * Captures all usage levels for all three types (session, weekly, sonnet).
   *
   * /usage renders multi-line sections in the TUI:
   *   Current session
   *   ██████████████           28% used
   *   Resets 11am (Asia/Tokyo)
   *   Current week (all models)
   *   ██                       4% used
   *   Resets Feb 21, 6am (Asia/Tokyo)
   *   Current week (Sonnet only)
   *                            0% used
   *   Resets Feb 21, 6am (Asia/Tokyo)
   *
   * Uses positional matching: find section headers, then map subsequent
   * "XX% used" and "Resets ..." lines to the nearest preceding section.
   *
   * @param {string} text - Screen buffer text
   * @returns {Object|null} Parsed usage data or null if not found
   */
  _parseUsageOutput(text) {
    if (!text) return null;

    text = text.replace(/\0/g, '');

    // Find section header positions
    const sections = [];
    const sessionIdx = text.search(/Current\s*t?session/i);
    if (sessionIdx >= 0) sections.push({ type: 'session', index: sessionIdx });

    const weekAllIdx = text.search(/Current\s+week\s*\(all/i);
    if (weekAllIdx >= 0) sections.push({ type: 'weekly', index: weekAllIdx });

    const sonnetIdx = text.search(/Sonnet\s+only/i);
    if (sonnetIdx >= 0) sections.push({ type: 'sonnet', index: sonnetIdx });

    if (sections.length === 0) return null;

    // Sort sections by position
    sections.sort((a, b) => a.index - b.index);

    // Find all "XX% used" occurrences (tolerant of retainText artifacts between % and "used")
    const percentPattern = /(\d+)%[^\d%]{0,15}used/gi;
    const percentMatches = [];
    let match;
    while ((match = percentPattern.exec(text)) !== null) {
      percentMatches.push({ percent: parseInt(match[1], 10), index: match.index });
    }

    // Find all "Resets ..." lines (extract text before timezone parenthesis)
    const resetsPattern = /Resets\s+(.+?)(?:\s*\(|$)/gim;
    const resetsMatches = [];
    while ((match = resetsPattern.exec(text)) !== null) {
      resetsMatches.push({ resetsAt: match[1].trim(), index: match.index });
    }

    // Map each percentage and reset to its nearest preceding section
    const result = {};
    for (const section of sections) {
      // Find next percentage AFTER this section header
      const pct = percentMatches.find(
        (p) =>
          p.index > section.index &&
          !sections.some((s) => s !== section && s.index > section.index && s.index < p.index),
      );
      // Find next reset AFTER this section header
      const rst = resetsMatches.find(
        (r) =>
          r.index > section.index &&
          !sections.some((s) => s !== section && s.index > section.index && s.index < r.index),
      );

      if (pct) {
        result[section.type] = {
          percent: pct.percent,
          resetsAt: rst?.resetsAt || null,
        };
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * Parse resetsAt string to Date object.
   * @param {string} resetsAtStr - Reset time string (e.g., "Feb 9, 9pm", "12pm", "Feb 9")
   * @returns {Date|null} Parsed date or null if parsing fails
   */
  _parseResetsAt(resetsAtStr) {
    if (!resetsAtStr || typeof resetsAtStr !== 'string') return null;

    const monthNames = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const now = new Date();
    const currentYear = now.getFullYear();

    // Pattern 1: "Feb 9, 9pm" or "Feb 10, 2am" or "Feb 21, 5:59am"
    const monthDayTimeMatch = resetsAtStr.match(
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?(am|pm)$/i,
    );
    if (monthDayTimeMatch) {
      const month = monthNames.indexOf(monthDayTimeMatch[1]);
      const day = parseInt(monthDayTimeMatch[2], 10);
      let hour = parseInt(monthDayTimeMatch[3], 10);
      const minutes = monthDayTimeMatch[4] ? parseInt(monthDayTimeMatch[4], 10) : 0;
      const meridiem = monthDayTimeMatch[5].toLowerCase();

      if (meridiem === 'pm' && hour !== 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;

      const date = new Date(currentYear, month, day, hour, minutes, 0, 0);

      // If date is in the past, assume next year
      if (date < now) {
        date.setFullYear(currentYear + 1);
      }

      return date;
    }

    // Pattern 2: "12pm" or "3pm" or "5:59am" (time only)
    const timeOnlyMatch = resetsAtStr.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
    if (timeOnlyMatch) {
      let hour = parseInt(timeOnlyMatch[1], 10);
      const minutes = timeOnlyMatch[2] ? parseInt(timeOnlyMatch[2], 10) : 0;
      const meridiem = timeOnlyMatch[3].toLowerCase();

      if (meridiem === 'pm' && hour !== 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;

      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minutes, 0, 0);

      // If time is in the past today, assume tomorrow
      if (date < now) {
        date.setDate(date.getDate() + 1);
      }

      return date;
    }

    // Pattern 3: "Feb 9" (month and day only)
    const monthDayMatch = resetsAtStr.match(
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/i,
    );
    if (monthDayMatch) {
      const month = monthNames.indexOf(monthDayMatch[1]);
      const day = parseInt(monthDayMatch[2], 10);
      const date = new Date(currentYear, month, day, 0, 0, 0, 0);

      // If date is in the past, assume next year
      if (date < now) {
        date.setFullYear(currentYear + 1);
      }

      return date;
    }

    return null;
  }

  /**
   * Compute cache expiration time from rate limit data.
   * @param {Object} data - Parsed rate limit data with resetsAt strings
   * @returns {number} Expiration timestamp (ms)
   */
  _computeExpiresAt(data) {
    if (!data) return Date.now() + RATE_LIMIT_CACHE_MS;

    const resetDates = [];

    if (data.weekly?.resetsAt) {
      const parsed = this._parseResetsAt(data.weekly.resetsAt);
      if (parsed) resetDates.push(parsed);
    }

    if (data.session?.resetsAt) {
      const parsed = this._parseResetsAt(data.session.resetsAt);
      if (parsed) resetDates.push(parsed);
    }

    if (data.sonnet?.resetsAt) {
      const parsed = this._parseResetsAt(data.sonnet.resetsAt);
      if (parsed) resetDates.push(parsed);
    }

    // Use minimum of parsed dates, capped at 1 week
    const oneWeekFromNow = Date.now() + 7 * 24 * 60 * 60 * 1000;

    if (resetDates.length === 0) {
      return oneWeekFromNow;
    }

    const earliestReset = Math.min(...resetDates.map((d) => d.getTime()));
    return Math.min(earliestReset, oneWeekFromNow);
  }

  /**
   * Compute refresh time based on max percent across weekly/session limits.
   * Higher percent = more frequent refresh.
   * Also applies session burn rate prediction: if session usage projects to exceed
   * 100% before reset (based on elapsed time in the 5h window), boosts effective
   * session percent to increase polling frequency proactively.
   * @param {Object|null} data - Parsed rate limit data
   * @returns {number} Refresh timestamp (ms)
   */
  _computeRefreshAt(data) {
    const REFRESH_30MIN = 30 * 60 * 1000;
    const REFRESH_10MIN = 10 * 60 * 1000;
    const REFRESH_5MIN = 5 * 60 * 1000;

    // When idle (no running/queued executions), use 2-hour interval
    if (this._isIdle()) {
      return Date.now() + RATE_LIMIT_IDLE_REFRESH_MS;
    }

    // No data (capture failed) → 30 min
    if (!data) {
      return Date.now() + REFRESH_30MIN;
    }

    // Find max percent across weekly, session, and sonnet
    const weeklyPercent = data.weekly?.percent || 0;
    const sessionPercent = data.session?.percent || 0;
    const sonnetPercent = data.sonnet?.percent || 0;

    // Predictive: if session burn rate projects to exceed limit, boost effective percent
    let effectiveSessionPercent = sessionPercent;
    if (
      sessionPercent >= SESSION_BURN_RATE_MIN_PERCENT &&
      sessionPercent < 100 &&
      data.session?.resetsAt
    ) {
      const resetDate = this._parseResetsAt(data.session.resetsAt);
      if (resetDate) {
        const timeUntilReset = resetDate.getTime() - Date.now();
        const elapsed = SESSION_WINDOW_MS - timeUntilReset;
        if (elapsed >= SESSION_BURN_RATE_MIN_ELAPSED_MS) {
          const projectedPercent = sessionPercent * (SESSION_WINDOW_MS / elapsed);
          if (projectedPercent > 150) {
            effectiveSessionPercent = Math.max(sessionPercent, 90); // → 5min
          } else if (projectedPercent > 100) {
            effectiveSessionPercent = Math.max(sessionPercent, 80); // → 10min
          }
        }
      }
    }

    const maxPercent = Math.max(weeklyPercent, effectiveSessionPercent, sonnetPercent);

    // Urgency-based refresh: higher percent = more frequent refresh
    if (maxPercent >= 90) {
      return Date.now() + REFRESH_5MIN; // 90%+ → 5 min (critical)
    } else if (maxPercent >= 80) {
      return Date.now() + REFRESH_10MIN; // 80-89% → 10 min (warning)
    } else {
      return Date.now() + REFRESH_30MIN; // <80% → 30 min (normal)
    }
  }

  /**
   * Merge new capture data with existing cache.
   * /usage always returns all 3 types, so no need to preserve disappeared types.
   * When capture fails entirely, keep existing cache if not expired.
   * @param {string} profile - Profile name
   * @param {Object|null} newData - Newly captured data
   * @returns {Object|null} Merged data
   */
  _mergeWithCached(profile, newData) {
    const cached = this._cache.get(profile);
    if (!newData) {
      // Capture failed entirely → keep existing cache if not expired
      if (cached?.data && Date.now() < cached.expiresAt) return cached.data;
      return null;
    }
    return newData;
  }

  /**
   * Get cached rate limit data (non-blocking).
   * @returns {Object|null} Cached data by profile or null
   */
  getCached() {
    const result = {};
    for (const [profile, entry] of this._cache) {
      if (Date.now() < entry.expiresAt) {
        result[profile] = entry.data; // null = no rate limit warning (below threshold)
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * Manually inject rate limit data into cache.
   * Used when capture can't detect the actual value (e.g., 100% = no TUI banner).
   * @param {string} profile - Profile name
   * @param {Object} data - Rate limit data (e.g., { weekly: { percent: 100, resetsAt: 'Feb 14, 6am' } })
   */
  setManualCache(profile, data) {
    const expiresAt = data ? this._computeExpiresAt(data) : Date.now() + RATE_LIMIT_CACHE_MS;
    const refreshAt = this._computeRefreshAt(data);
    this._cache.set(profile, { data, timestamp: Date.now(), expiresAt, refreshAt });
    this._saveCache();
    claudeLog.info(
      `[RateLimit] Manual cache set for ${profile}: ${JSON.stringify(data)}, expiresAt: ${new Date(expiresAt).toISOString()}`,
    );
  }

  /**
   * Get the earliest rate limit reset time across all cached profiles.
   * Considers weekly, session, and sonnet reset times.
   * @returns {number|null} Earliest reset timestamp (ms since epoch), or null if no reset times available
   */
  getEarliestResetTime() {
    const resetTimes = [];
    for (const [, entry] of this._cache) {
      if (!entry.data) continue;
      for (const type of ['weekly', 'session', 'sonnet']) {
        if (entry.data[type]?.resetsAt) {
          const parsed = this._parseResetsAt(entry.data[type].resetsAt);
          if (parsed) resetTimes.push(parsed.getTime());
        }
      }
    }
    if (resetTimes.length === 0) return null;
    return Math.min(...resetTimes);
  }

  /**
   * Find a profile with rate limits below AUTO_SWITCH_THRESHOLD (safe for execution).
   * @param {string|null} [excludeProfile=null] - Profile to exclude (typically the one that hit 429)
   * @returns {string|null} Safe profile name, or null if none available
   */
  getSafeProfile(excludeProfile = null) {
    const profiles = this.getProfiles();
    const cached = this.getCached();
    if (!cached) return null;

    return (
      profiles.find((p) => {
        if (p === excludeProfile) return false;
        const data = cached[p];
        if (!data) return true; // No data = below capture threshold = safe
        const maxPercent = Math.max(
          data.weekly?.percent || 0,
          data.session?.percent || 0,
          data.sonnet?.percent || 0,
        );
        return maxPercent < AUTO_SWITCH_THRESHOLD;
      }) || null
    );
  }

  /**
   * Recompute refreshAt for all cached profiles based on current conditions.
   * Call when idle/busy state changes (e.g., execution starts or queue empties)
   * so that idle-computed 2h intervals shorten to 5-30min when busy.
   */
  recomputeRefreshTimes() {
    let changed = false;
    for (const [profile, entry] of this._cache) {
      const newRefreshAt = this._computeRefreshAt(entry.data);
      if (newRefreshAt < entry.refreshAt) {
        entry.refreshAt = newRefreshAt;
        changed = true;
        claudeLog.info(
          `[RateLimit] Shortened refreshAt for ${profile} to ${new Date(newRefreshAt).toISOString()}`,
        );
      }
    }
    if (changed) this._saveCache();
  }

  /**
   * Check if active profile should auto-switch due to rate limit.
   * Triggers onAutoSwitch callback when:
   * - Active profile has weekly or session >= AUTO_SWITCH_THRESHOLD
   * - At least one other profile is below AUTO_SWITCH_THRESHOLD on both weekly and session
   * @param {Object|null} cached - Cached rate limit data by profile
   */
  _checkAutoSwitch(cached) {
    if (!this._onAutoSwitch || !cached) return;

    const activeProfile = this._getActiveProfile();
    if (!activeProfile) return;

    const activeData = cached[activeProfile];
    if (!activeData) return;

    const activeMax = Math.max(
      activeData.weekly?.percent || 0,
      activeData.session?.percent || 0,
      activeData.sonnet?.percent || 0,
    );
    if (activeMax < AUTO_SWITCH_THRESHOLD) return;

    // Find any profile below AUTO_SWITCH_THRESHOLD
    const profiles = this.getProfiles();
    const safeProfile = profiles.find((p) => {
      if (p === activeProfile) return false;
      const data = cached[p];
      if (!data) return true; // No data = below 75% capture threshold = safe
      const pMax = Math.max(
        data.weekly?.percent || 0,
        data.session?.percent || 0,
        data.sonnet?.percent || 0,
      );
      return pMax < AUTO_SWITCH_THRESHOLD;
    });

    if (safeProfile) {
      claudeLog.info(
        `[RateLimit] Auto-switch: ${activeProfile} at ${activeMax}%, safe profile: ${safeProfile}`,
      );
      this._onAutoSwitch(safeProfile);
    }
  }
}

export { VtScreenBuffer };
