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

/** Default context window size for token calculation when not provided by API */
export const DEFAULT_CONTEXT_WINDOW = 200000;

/** Timeout for proxy health check */
export const PROXY_TIMEOUT_MS = 2000;

/** Time to keep completed executions in memory before cleanup */
export const EXECUTION_TTL_MS = 3600000; // 1 hour

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

/** TTL for shell command button states (cs/dr/upd) */
export const SHELL_STATE_TTL_MS = 300000; // 5 minutes

/** Delay before auto-handoff to terminal */
export const HANDOFF_DELAY_MS = 300;

/** Delay before sending email for browser-answerable input prompts (5 minutes) */
export const INPUT_EMAIL_DELAY_MS = 300000;

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
export const RATE_LIMIT_IDLE_REFRESH_MS = 7200000; // 2 hours

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

/** Threshold (percent) at which auto-switch to a safe profile triggers */
export const AUTO_SWITCH_THRESHOLD = 80;

/** Maximum number of profile switches allowed per execution chain (prevents ping-pong loops) */
export const MAX_PROFILE_SWITCHES = 2;

// =============================================================================
// Auto-DR (Auto Dashboard Restart) Configuration
// =============================================================================
// Auto-DR uses pm2 restart directly — EADDRINUSE handled by server.js polling retry

/** Debounce delay for auto-DR file change detection (ms) */
export const AUTO_DR_DEBOUNCE_MS = 2000;

// =============================================================================
// Tmp Cleanup Configuration
// =============================================================================

/** Interval for periodic tmp file cleanup */
export const TMP_CLEANUP_INTERVAL_MS = 21600000; // 6 hours

/** Retention period for per-execution debug logs (dashboard/debug-*.log) */
export const DEBUG_LOG_RETENTION_DAYS = 3;

/** Retention period for daily rotated logs and other artifacts */
export const DAILY_LOG_RETENTION_DAYS = 7;

// =============================================================================
// Smoke Test Configuration
// =============================================================================

/** Overall timeout for smoke test suite (all 3 tests + margin) */
export const SMOKE_TEST_OVERALL_TIMEOUT_MS = 45000;

/** Timeout for cli-binary test (claude --version) */
export const SMOKE_CLI_TIMEOUT_MS = 5000;

/** Timeout for stream-json test (claude -p with stream-json output) */
export const SMOKE_STREAM_TIMEOUT_MS = 15000;

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
