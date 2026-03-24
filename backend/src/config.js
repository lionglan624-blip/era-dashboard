/**
 * Feature Dashboard Configuration
 *
 * Centralized configuration constants for the dashboard backend.
 * Environment variables can override defaults where noted.
 */

// =============================================================================
// Execution Timeouts and Limits
// =============================================================================

/** Seconds without output before marking execution as stalled */
export const STALL_TIMEOUT_MS = 60000; // 60 seconds

/** Interval for checking stall status (half of STALL_TIMEOUT_MS for ≤90s worst-case detection) */
export const STALL_CHECK_INTERVAL_MS = 30000;

/** Default context window size for token calculation when not provided by API.
 * Opus 4.6 / Sonnet 4.6 default to 1M context (no premium pricing above 200K). */
export const DEFAULT_CONTEXT_WINDOW = 1000000;

/** Timeout for proxy health check */
export const PROXY_TIMEOUT_MS = 2000;

/** Time to keep completed executions in memory before cleanup */
export const EXECUTION_TTL_MS = 86400000; // 24 hours

/** Maximum log entries per execution (prevents unbounded memory growth) */
export const MAX_LOG_ENTRIES = 5000;

/** Maximum auto-retries on context limit (error_max_turns, max_tokens, prompt too long) for all commands (fc, fl, run) */
export const MAX_RETRIES = 3;

/** Maximum auto-retries for FL workflow re-run requests (text pattern detection, separate from context retries) */
export const MAX_FL_RETRIES = 3;

/** Maximum auto-retries for incomplete termination (exit 0 + success but status didn't advance) — applies to fc, fl, run */
export const MAX_INCOMPLETE_RETRIES = 3;

/** Delay before retry on context exhaustion or FL re-run (milliseconds) */
export const RETRY_DELAY_MS = 5000;

/** Time before stale chain waiters are cleaned up */
export const CHAIN_WAITER_TIMEOUT_MS = 300000; // 5 minutes

/** Time before stuck running executions are force-terminated */
export const STUCK_RUNNING_TIMEOUT_MS = 7200000; // 2 hours

/** Interval for cleaning up old executions */
export const CLEANUP_INTERVAL_MS = 600000; // 10 minutes

/** Maximum concurrent executions (chain slots reserved within this limit) */
const _BASE_MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2');
export const MAX_CONCURRENT_EXECUTIONS = _BASE_MAX_CONCURRENT;
export function getMaxConcurrentExecutions(nowMs = Date.now()) {
  return _BASE_MAX_CONCURRENT * getPromoMultiplier(nowMs);
}

/** TTL for shell command button states (cs/dr/upd) */
export const SHELL_STATE_TTL_MS = 300000; // 5 minutes

/** Delay before auto-handoff to terminal */
export const HANDOFF_DELAY_MS = 300;

/** Delay before sending email for browser-answerable input prompts (2 minutes) */
export const INPUT_EMAIL_DELAY_MS = 120000;

/** Timeout for deferred y/n handoff — fallback if result event never arrives (ms) */
export const PENDING_HANDOFF_TIMEOUT_MS = 10000;

/** Margin for log trimming (trim when exceeds MAX_LOG_ENTRIES + margin) */
export const LOG_TRIM_MARGIN = 100;

// =============================================================================
// FileWatcher Configuration
// =============================================================================

/** Debounce delay for status change notifications */
export const STATUS_DEBOUNCE_MS = 300;

/** Debounce delay for feature update notifications */
export const FEATURE_UPDATE_DEBOUNCE_MS = 500;

// =============================================================================
// FeatureService Configuration
// =============================================================================

/** Cache TTL for feature data */
export const FEATURE_CACHE_MS = 2000;

// =============================================================================
// Proxy Configuration
// =============================================================================

export const PROXY_HOST = process.env.PROXY_HOST || '127.0.0.1';
export const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8888');
export const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;
export const PROXY_ENABLED = process.env.PROXY_ENABLED !== 'false'; // enabled by default

// =============================================================================
// CCS (Claude Code Switch) Profile Integration
// =============================================================================

import path from 'path';

export const CCS_DIR =
  process.env.CCS_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', '.ccs');
export const CCS_CONFIG_PATH = path.join(CCS_DIR, 'config.yaml');
export const CCS_INSTANCES_DIR = process.env.CCS_INSTANCES_DIR || path.join(CCS_DIR, 'instances');

// =============================================================================
// Rate Limit Capture Configuration
// =============================================================================

/** Cache TTL for rate limit data (6 minutes - intentionally longer than poll interval to prevent cache gap blanking) */
export const RATE_LIMIT_CACHE_MS = 360000;

/** Polling interval for periodic rate limit capture (5 minutes) */
export const RATE_LIMIT_POLL_INTERVAL_MS = 300000;

/** Timeout for rate limit capture process (20 seconds) */
export const RATE_LIMIT_CAPTURE_TIMEOUT_MS = 20000;

/** Refresh interval when idle (no running/queued executions) */
export const RATE_LIMIT_IDLE_REFRESH_MS = 21600000; // 6 hours

/** Session rate limit window (5 hours) — used for burn rate projection */
export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

/** Minimum elapsed time before session burn rate prediction is meaningful (30 min) */
export const SESSION_BURN_RATE_MIN_ELAPSED_MS = 30 * 60 * 1000;

/** Minimum session percent before prediction activates */
export const SESSION_BURN_RATE_MIN_PERCENT = 5;

// =============================================================================
// Rate Limit Retry Configuration
// =============================================================================

/** Buffer time after rate limit reset before retrying (milliseconds) */
export const RATE_LIMIT_RETRY_BUFFER_MS = 60000; // 1 minute

/** Threshold below which rate limit is considered safe for retry (percent) */
export const RATE_LIMIT_SAFE_THRESHOLD = 95;

/** Threshold (percent) for safe profile filter (allocation and retry evaluation) */
export const AUTO_SWITCH_THRESHOLD = 80;
export function getAutoSwitchThreshold(nowMs = Date.now()) {
  return isPromoActive(nowMs) ? 95 : AUTO_SWITCH_THRESHOLD;
}

/** Maximum number of profile switches allowed per execution chain (prevents ping-pong loops) */
export const MAX_PROFILE_SWITCHES = 2;

/** Maximum server error (500/529) retries with exponential backoff */
export const MAX_SERVER_ERROR_RETRIES = 5;

/** Backoff delays for server error retries (milliseconds): 1m, 5m, 30m, 1h, 2h */
export const SERVER_ERROR_BACKOFF_MS = [60_000, 300_000, 1_800_000, 3_600_000, 7_200_000];

// =============================================================================
// Auto-DR (Auto Dashboard Restart) Configuration
// =============================================================================
// Auto-DR uses pm2 restart directly — EADDRINUSE handled by server.js polling retry

/** Debounce delay for auto-DR file change detection (ms) */
export const AUTO_DR_DEBOUNCE_MS = 2000;

/** Cooldown after startup before auto-DR activates (ms) — prevents restart cascades */
export const AUTO_DR_STARTUP_COOLDOWN_MS = 10000;

// =============================================================================
// Remote Control (Handoff Mode) Configuration
// =============================================================================

/** Handoff mode: 'terminal' (wt.exe, default) or 'remote' (node-pty + Remote Control URL email) */
export const HANDOFF_MODE = process.env.HANDOFF_MODE || 'terminal';

/** CCS profile for Remote Control sessions (must match phone browser's claude.ai account) */
export const REMOTE_CONTROL_PROFILE = process.env.REMOTE_CONTROL_PROFILE || 'apple';

/** Timeout for capturing Remote Control URL from PTY output (ms) */
export const REMOTE_URL_TIMEOUT_MS = 30000;

/** Maximum remote control session duration before force-kill (ms) */
export const REMOTE_CONTROL_TIMEOUT_MS = 14400000; // 4 hours

// =============================================================================
// Tmp Cleanup Configuration
// =============================================================================

/** Interval for periodic tmp file cleanup */
export const TMP_CLEANUP_INTERVAL_MS = 21600000; // 6 hours

/** Retention period for per-execution debug logs (dashboard/debug-*.log) */
export const DEBUG_LOG_RETENTION_DAYS = 30;

/** Retention period for daily rotated logs and other artifacts */
export const DAILY_LOG_RETENTION_DAYS = 30;

// =============================================================================
// Smoke Test Configuration
// =============================================================================

/** Overall timeout for smoke test suite (all 3 tests + margin) */
export const SMOKE_TEST_OVERALL_TIMEOUT_MS = 45000;

/** Timeout for cli-binary test (claude --version) */
export const SMOKE_CLI_TIMEOUT_MS = 5000;

/** Timeout for stream-json test (claude -p with stream-json output) */
export const SMOKE_STREAM_TIMEOUT_MS = 20000;

/** Timeout for pty-usage test (rateLimitService.capture) */
export const SMOKE_PTY_TIMEOUT_MS = 25000;

/** Rate limit threshold (%) above which stream-json test is skipped (API consuming) */
export const SMOKE_RATE_LIMIT_SKIP_STREAM = 95;

/** Rate limit threshold (%) above which pty-usage test is skipped (mutex collision risk) */
export const SMOKE_RATE_LIMIT_SKIP_PTY = 80;

// =============================================================================
// Health Metrics Configuration
// =============================================================================

/** Interval for periodic health metrics + exit marker update */
export const HEALTH_METRICS_INTERVAL_MS = 300000;

// =============================================================================
// Claude Status Monitoring Configuration
// =============================================================================

/** Polling interval for Claude platform status (5 minutes) */
export const CLAUDE_STATUS_POLL_INTERVAL_MS = 300000;

/** Atlassian Statuspage API URL for Claude */
export const CLAUDE_STATUS_URL = 'https://status.claude.com/api/v2/components.json';

/** Timeout for status API fetch (10 seconds) */
export const CLAUDE_STATUS_TIMEOUT_MS = 10000;

/** Component IDs to monitor: Claude Code, Claude API */
export const CLAUDE_STATUS_COMPONENT_IDS = ['yyzkbfz2thpt', 'k8w3r06qmzrp'];

// =============================================================================
// Dependency Updater Configuration
// =============================================================================

/** Master switch — set false to disable all scheduled dependency updates */
export const UPDATE_ENABLED = process.env.UPDATE_ENABLED !== 'false'; // enabled by default

/** Timeout per update command (npm update, go get, pip install, etc.) */
export const UPDATE_COMMAND_TIMEOUT_MS = 300000; // 5 min

/** Timeout per test suite (dotnet test, go test, npm test, pytest) */
export const UPDATE_TEST_TIMEOUT_MS = 600000; // 10 min

/** Interval between idle retries when dashboard is busy */
export const UPDATE_IDLE_RETRY_MS = 1800000; // 30 min

/** Maximum idle retry attempts before skipping (30min × 6 = 3 hours) */
export const UPDATE_IDLE_MAX_RETRIES = 6;

/** Timeout for SonarQube health check after container recreation */
export const SONAR_HEALTH_CHECK_TIMEOUT_MS = 120000; // 2 min

/** Polling interval for SonarQube readiness check */
export const SONAR_HEALTH_CHECK_POLL_MS = 5000; // 5 sec

/** Daily schedule: hour in JST */
export const UPDATE_DAILY_HOUR_JST = 6;

/** Weekly schedule: day of week (1 = Monday) */
export const UPDATE_WEEKLY_DAY = 1;

/** Weekly schedule: hour in JST */
export const UPDATE_WEEKLY_HOUR_JST = 6;

/** Weekly schedule: minute in JST */
export const UPDATE_WEEKLY_MINUTE_JST = 30;

/** Monthly schedule: day of month */
export const UPDATE_MONTHLY_DAY = 1;

/** Monthly schedule: hour in JST */
export const UPDATE_MONTHLY_HOUR_JST = 6;

// =============================================================================
// March 2026 Usage Promotion (temporary — remove after 2026-03-28)
// =============================================================================
const PROMO_START = new Date('2026-03-13T00:00:00-07:00').getTime();
const PROMO_END = new Date('2026-03-28T07:00:00Z').getTime(); // Mar 27 11:59PM PT

/**
 * Returns 2 during 2x promo periods, 1 otherwise.
 * - Weekdays outside 4AM-11AM PT: 2x (4AM not 5AM = 1h buffer before actual peak)
 * - Weekends (Sat/Sun in PT): 2x all day
 * - Outside promo window: always 1x
 * @param {number} [nowMs=Date.now()] - Current time for testing
 */
export function getPromoMultiplier(nowMs = Date.now()) {
  if (nowMs < PROMO_START || nowMs >= PROMO_END) return 1;

  // March 2026 is in PDT (UTC-7, DST started Mar 8)
  const ptMs = nowMs - 7 * 60 * 60 * 1000;
  const ptDate = new Date(ptMs);
  const dayOfWeek = ptDate.getUTCDay(); // 0=Sun, 6=Sat

  // Weekends: always 2x
  if (dayOfWeek === 0 || dayOfWeek === 6) return 2;

  // Weekday: peak = 4AM-11AM PT (4AM = 1h buffer before actual 5AM peak)
  const ptHour = ptDate.getUTCHours();
  if (ptHour >= 4 && ptHour < 11) return 1;
  return 2;
}

export function isPromoActive(nowMs = Date.now()) {
  return getPromoMultiplier(nowMs) === 2;
}
