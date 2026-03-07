# Feature Dashboard — Internals

Implementation details and design decisions. Read [HANDOFF.md](HANDOFF.md) first.

---

## Rate Limit Cache Details

Tracks CCS **profile-level** usage (weekly/session/sonnet — API quota limits, NOT conversation context).

- **expiresAt**: `min(weekly reset, session reset, sonnet reset, 1 week)`
- **refreshAt**: Adaptive 5min–2h based on activity and max percent
  - Idle (no running/queued executions): 2h
  - Active ≥90%: 5min
  - Active 80–89%: 10min
  - Active <80%: 30min
- **Session burn rate prediction**: When session elapsed ≥30min, percent ≥5%, and <100%, projects usage to end of 5h window
  - Projected >150%: 5min refresh
  - Projected >100%: 10min refresh (weekly unchanged)
- **Triggers**: On-start `capture()`, on-completion `capture({ forceRefresh: true })`, on-FE-refresh (`/api/health?refresh=1`)
- **Persistence**: `/usage` data preserves all types; capture failure preserves cache. Persisted to `_out/tmp/dashboard/ratelimit-cache.json`

## Account Limit (429) Details

**Detection** (3 layers — canonical reference):
1. stderr regex: `/hit your limit|rate_limit_error|exceed your (organization|account)('s|s)? rate limit/i`
2. Non-JSON stdout regex (same patterns)
3. Two-pass debug log tail scan — last 16KB of `--debug-file` for `rate_limit_error` or `429.*rate.?limit`
   - 16KB needed: CLI writes hooks/telemetry/session-save after 429, pushing error >4KB from EOF
   - Pass 1: immediate scan at process `close` event
   - Pass 2: deferred 500ms re-scan if Pass 1 missed (Windows file lock/flush timing)

**Deferred detection behavior**:
- Cancels in-flight `_contextRetryTimer` (RETRY_DELAY_MS=5s > 500ms, timer hasn't fired yet) → routes to `_scheduleRateLimitRetry()`
- Errors logged to `claudeLog.debug` (previously silent `catch{}`)

**Behavior**: Sets `accountLimitHit` → blocks context retry and FL retry

**Recovery** (queue-based: all executions, chain and non-chain):
Multiple concurrent 429 failures are queued in `_rateLimitRetryQueue` and drained sequentially:
1. First entry: try auto-switch to safe profile → immediate retry after 5s. If no safe profile → timed retry at earliest `resetsAt` + 1min buffer
2. Subsequent entries: queued behind first entry (no duplicate timers/switches)
3. After each retry completes (non-429), next queue entry starts after 5s delay
4. If retry itself hits 429: re-queued, existing timer handles re-retry
5. `_rateLimitPaused` is a getter (`queue.length > 0`) that blocks `_dequeueNext()`

**Session resume**: When failed execution has `sessionId`, retry uses `claude -p "continue" --resume <sessionId>` (preserves context); falls back to fresh `executeCommand()` when no sessionId

**Events**:
- WS: `account-limit` → `rate-limit-waiting` → `rate-limit-retry` or `rate-limit-exhausted`. `rate-limit-retry` includes `resumed: true/false`. `rate-limit-exhausted` includes `queueSize`
- Email: `account-limit` (with retry schedule) → `rate-limit-recovered` or `rate-limit-exhausted`

**Retry guards**:
- `needsContextRetry` and `flWantsRetry` block all retries when `accountLimitHit` is true
- `exitCode≠0 && subtype=success` context heuristic guarded by `!accountLimitHit` — debug log scan promoting 429 prevents false context retry

**CLI 429 not in streams**: Claude CLI writes `rate_limit_error` to `--debug-file` only, not to stdout/stderr stream-json. CLI emits `result { subtype: 'success', is_error: true }` for 429, same pattern as context exhaustion. Dashboard uses **two-pass debug log scan**: (1) immediate `readFileSync` at process `close` event, (2) deferred 500ms re-scan if immediate scan fails (Windows file lock / flush timing). Deferred detection cancels any in-flight context retry timer and routes to rate limit retry instead. If CLI changes to emit 429 in streams, the stderr/non-JSON detection will catch it first and the debug scan becomes redundant (harmless).

## Auto-Switch Details

When active profile reaches ≥80% on any rate limit type (weekly/session/sonnet):

- `_checkAutoSwitch` fires `onAutoSwitch(safeProfile)` → runs `ccs auth default "<safeProfile>"`
- **Trigger**: Every `capture()` completion
- **Purpose**: Prevent 429 before it happens
- **Config**: `AUTO_SWITCH_THRESHOLD` in `config.js`
- **WS event**: `auto-switch`

---

## Browser-First Input Handling

Both y/n patterns and AskUserQuestion are handled browser-first. When detected, `pendingHandoff` is set with a timeout, and WS events notify FE. Source: `streamParser.js` + `claudeService.js`.

### y/n Flow Detail

CLI emits `result` event (session saved) → streamParser cancels pendingHandoff timeout → process exits naturally via `_handleCompletion` → execution status = `completed` but `waitingForInput` remains `true` → FE shows Yes/No buttons on the completed execution → user clicks → `answerInBrowser` resumes session.

- `result` event arrives → `pendingHandoff` **cancelled** (not triggered) → process exits naturally
- `_handleCompletion` completes with `waitingForInput: true` → FE shows Yes/No buttons on completed execution
- Timeout: `PENDING_HANDOFF_TIMEOUT_MS` (10s)

### AskUserQuestion Flow Detail

StreamParser detects `AskUserQuestion` tool_use in assistant message → sets `execution._killedForAskUser = true` → kills process immediately (before CLI auto-responds with empty answer) → `_handleCompletion` guard preserves `inputRequired` and keeps status `running` → FE shows option buttons → user clicks → `answerInBrowser` resumes with `-p "selected option" --resume sessionId` → CLI receives answer as new user message in context. Guard also ignores buffered tool_result that arrives after kill. "Terminal" button is the manual fallback.

- StreamParser detects tool_use → kills process (`_killedForAskUser` guard) → FE shows option buttons while `running`
- User answer → kill + `--resume` with answer as `-p` prompt
- No auto-timeout; "Terminal" button is the manual fallback

### Common

- "Terminal" fallback button always available
- `answerInBrowser(executionId, answer)` kills stuck process, resumes with `-p "answer" --resume <sessionId>`, transfers chain/phase state
- `_handleCompletion` skips `endsWithQuestion` handoff when `waitingForInput` or `inputRequired` is set

### Session Preservation

y/n text is saved to session JSONL (`result` event confirms this). AskUserQuestion tool_use is NOT saved — the process is killed immediately on detection (before CLI emits `result` and saves session). The answer is sent as a `-p` prompt on `--resume`, relying on Claude to infer context from conversation history. Terminal "Resume" button still writes `resume-context.txt` for AskUserQuestion context display.

### Revert to Terminal-First

To restore the old immediate-handoff behavior, add `this.handoffToTerminal(execution, 'AskUserQuestion requires user input')` in the AskUserQuestion handler in `streamParser.js` (after `broadcastInputRequired`).

---

## Design Decisions

**Context splitting (TreeView.jsx)**: Split into `TreeCallbacksContext` (stable callbacks) and `TreeDataContext` (dynamic data). Callbacks rarely change, so TreeNode memo can skip re-renders when only data changes.

**Dynamic project path**: ExecutionPanel "Copy ID" button fetches `projectRoot` from `/api/health` to generate paths dynamically. Eliminates hardcoded path issues.

**Process termination safety**: `_killProcess()` checks for null pid to prevent taskkill execution with undefined pid.

**stdin handling (`proc.stdin.end()`)**: Claude CLI in `-p` mode hangs if stdin is an open pipe (waits for EOF before processing the prompt). Solution: `stdio: ['pipe', 'pipe', 'pipe']` with immediate `proc.stdin.end()` after spawn. This closes stdin, letting the CLI process the `-p` prompt immediately. AskUserQuestion uses kill+resume (not stdin), so closing stdin has no side effects.

**AskUserQuestion kill-on-detect**: StreamParser kills the process immediately on detecting `AskUserQuestion` tool_use to prevent the CLI from auto-responding with an empty answer. Guard `_killedForAskUser` ensures: (1) buffered tool_result doesn't clear `inputRequired`, (2) `_handleCompletion` preserves `running` status for browser UI. The session is NOT saved (kill happens before CLI emits `result` and saves JSONL) — the answer is sent as a `-p` prompt on `--resume`, relying on Claude to infer context from conversation history. See [Browser-First Input Handling](#browser-first-input-handling) for the full flow.

**Debug endpoint**: `POST /api/execution/debug` accepts arbitrary prompts. Gated by file-based activation: `_out/tmp/dashboard/.debug-enabled` must exist and be less than 30 minutes old. Claude activates by writing this file (`Write(_out/tmp/dashboard/.debug-enabled)` with any content); expired files are auto-deleted on next request. `DASHBOARD_DEBUG=1` env var now controls only verbose logging, not endpoint access. Essential for testing AskUserQuestion flow, stream parsing, and other behaviors without running real feature commands. Sends `execution-started` WebSocket event so the FE auto-subscribes and shows the execution tab.

**Security hardening**: Backend binds to `127.0.0.1` only (not `0.0.0.0`). CORS restricted to `localhost:5173` and `localhost:3001`. Debug endpoint defaults to closed; requires explicit file-based activation with 30-min TTL.

**Module extraction (claudeService.js)**: Extracted utilities and constants into separate modules:
- `streamParser.js`: Stream-json parsing, event handling, state detection (StreamParser class)
- `chainExecutor.js`: Chain execution logic (ChainExecutor class)
- `validation.js`: Input validation
- `inputPatterns.js`: Input wait patterns
- `phaseUtils.js`: Phase detection
- `ccsUtils.js`: CCS profile reading
- `config.js`: Configuration constants
- `timeUtils.js`: Shared time utilities (nowJST, format: `YYYY/MM/DD HH:mm:ss JST`)

Benefits: Single responsibility, clearer test targets, improved maintainability (1,600 → ~1,300 lines).

**Tile height consistency (TreeView.jsx)**: Placeholder design to unify tile heights:

| Element | Root tile (depth=0) | Child tile (depth>0) |
|---------|:-------------------:|:--------------------:|
| Left (RUN label) | 48px placeholder | None (left-aligned) |
| row2 (phase/context/elapsed) | Placeholder shown | None (left-aligned) |

Root tiles reserve space to prevent layout shift when execution starts. Child tiles prioritize compact display. Placeholders use `visibility: hidden` (hidden but space preserved).

**Email notification (emailService.js)**: Sends Gmail SMTP notifications on terminal handoff, execution completion, and browser input wait (y/n and AskUserQuestion). Config stored in `email.config.json` (gitignored) with `email.config.example.json` as template. DI: constructor accepts `configLoader` and `transportFactory` for testing. Fire-and-forget: errors logged but never block execution. Triggers: `_handoffToTerminal()`, `_handleCompletion()`, `_broadcastInputWait()`, and `_broadcastInputRequired()` in claudeService.js. Setup: copy `email.config.example.json` to `email.config.json`, set `enabled: true`, `user` (Gmail address), `pass` (Gmail app password).

**Status mail service (statusMailService.js)**: IMAP IDLE listener that monitors Gmail inbox for status requests. Trigger: self-sent empty email (no subject, no body). Response: auto-reply with dashboard status report (executions, rate limits, feature summary). IMAP config via `email.config.json` key `statusMail: { enabled, imapHost, imapPort, allowedSenders, reconnectDelayMs }`. Sender whitelist: self + configured `allowedSenders` (case-insensitive). Loop prevention: ignores `Re:` subjects. Reconnects on disconnect with configurable delay. DI: constructor accepts `imapClientFactory` and `transportFactory` for testing.

**Stream parser (streamParser.js)**: Extracted from claudeService.js for separation of concerns. Handles all stream-json output parsing: JSON line parsing, event type dispatch, phase/iteration detection, input wait pattern matching, AskUserQuestion detection, token usage calculation, and context percentage. Uses constructor DI for all callbacks (pushLog, broadcast, broadcastState, handoffToTerminal, handleCompletion). claudeService.js retains wrapper methods for backward compatibility.

---

## Rate Limit Capture (`ratelimitService.js`)

Captures Claude Code's exact usage percentages via `/usage` slash command through `node-pty` (ConPTY) + `VtScreenBuffer` (minimal VT terminal emulator).

**Profile enumeration**: `ccs auth list` via `getCcsProfiles()` in `ccsUtils.js` — only `[OK]` profiles.

**Capture flow per profile**:
1. Spawn `claude` via `pty.spawn('cmd.exe', ['/c', 'claude'], { cols: 120, rows: 30, useConptyDll: true })` in headless ConPTY
2. Feed VT output into `VtScreenBuffer` for TUI detection
3. Detect TUI loaded (status bar `Context:N%`)
4. Wait 1.5s for TUI stabilization
5. Type `/usage`, wait 800ms (autocomplete menu settle), create clean `VtScreenBuffer`, send Enter
6. Detect `/usage` output completion (`Esc to cancel` or `Sonnet only` + `%used` pattern), wait 500ms for full render
7. Resolve with captured text (clean buffer preferred, fallback to main buffer)

**Parsing** (`_parseUsageOutput()`): Positional — finds section headers (`Current session`, `Current week (all models)`, `Sonnet only`), maps subsequent `(\d+)%[^\d%]{0,15}used` and `Resets (.+?)(\(|$)` to nearest preceding section.

**Infrastructure**:
- `useConptyDll: true` — bundled `conpty.dll` + `OpenConsole.exe` bypasses Windows Terminal's default terminal interception
- Kill: `pty.kill()` with `taskkill /F /T` fallback
- DI: constructor accepts `ptySpawn` for testing

**Cache**: Per-profile `Map<profileName, {data, timestamp, expiresAt}>`, dynamic TTL (see [Rate Limit Cache Details](#rate-limit-cache-details)). On `/usage` success: all three types stored. On failure: existing cache preserved if not expired. Persisted to `_out/tmp/dashboard/ratelimit-cache.json` (loaded on startup, saved on every update). Manual injection via `POST /api/ratelimit/:profile`.

**Triggers**: Startup (background) + 5min periodic polling + after each command completion (fire-and-forget).

**FE display**: Header shows `{profile} W:XX% S:XX%` with reset times (`↻W:` / `↻S:`) when percent > 75% (yellow ≥70%, red pulse ≥90%). Sonnet data captured but not displayed (used for auto-switch and rate limit retry).

**Helpers**: `getEarliestResetTime()` — earliest reset across all profiles (for timed retry). `getSafeProfile(excludeProfile)` — profile below 90% (for switch retry). Capture time: ~7-10s per profile.

**Auto-switch (`ratelimitService.js` + `server.js`)**: Proactive profile switching to prevent 429.
- `_checkAutoSwitch()` runs after every `capture()` completion
- When active profile reaches ≥`AUTO_SWITCH_THRESHOLD` (80%, in `config.js`) on any rate limit type and another profile is below threshold → fires `onAutoSwitch(safeProfile)`
- server.js callback validates `safeProfile` against `getCcsProfiles()` (command injection prevention) → `ccs auth default "<safeProfile>"`
- Next spawned claude.exe picks up new profile via `getCcsProfile()` → `CLAUDE_CONFIG_DIR`
- WS event: `auto-switch` with `safeProfile` field

## Rate Limit Retry (`claudeService.js`)

When an execution hits 429, `_scheduleRateLimitRetry()` attempts recovery:

**Strategy 1 (immediate — profile switch)**:
- `rateLimitService.getSafeProfile(currentProfile)` finds alternative profile below 90%
- If found: `_switchProfile(safeProfile)` (`ccs auth default` with validation) → retry after 5s

**Strategy 2 (timed — wait for reset)**:
- `rateLimitService.getEarliestResetTime()` → schedule timer at `resetTime + RATE_LIMIT_RETRY_BUFFER_MS` (1min)
- Queue blocks `_dequeueNext()` via `_rateLimitPaused` getter (`queue.length > 0`)
- On timer: `_processRateLimitQueue()` re-captures rate limits, checks safe (< `RATE_LIMIT_SAFE_THRESHOLD` 95%), drains queue sequentially or gives up on all entries

**Queue-based retry**: Multiple concurrent 429s are queued in `_rateLimitRetryQueue`. First entry triggers Strategy 1/2. Subsequent entries queue behind. After each retry completes, `_processNextInQueue()` starts next entry with 5s delay. Killed/cancelled entries are skipped.

**Session resume**: `_startRateLimitRetry()` checks for `sessionId`:
- With sessionId: `claude -p "continue" --resume <sessionId>` (preserves context — avoids re-reading files)
- Without sessionId: falls back to fresh `executeCommand()`
- Resume creates new execution with original command name (not `resume:` prefix) for chain compatibility

**Cleanup**: `killExecution()` removes specific entry from `_rateLimitRetryQueue` (clears timer if queue empties). `killAllRunning()` clears entire queue. `getQueueStatus()` exposes `rateLimitQueue` array and `rateLimitRetryAt`.

**Events**: WS `rate-limit-retry` includes `resumed: true/false`. Email: `account-limit` → `rate-limit-recovered` or `rate-limit-exhausted`.

**Email subjects**: `account-limit` (429), `rate-limit-recovered`, `rate-limit-exhausted`, `context-limit N/3`, `fl-retry N/3`. Result derived from chain history's last entry (single source from claudeService).

---

## Three Limit Concepts

The word "session" appears in two unrelated contexts:

| Concept | What it means | Retryable | Detection |
|---------|--------------|-----------|-----------|
| **Conversation context** exhaustion | Single `-p` session's token window is full | Yes (3x, fresh session) | `error_max_turns`, `max_tokens`, `promptTooLong`, `exitCode≠0 && subtype=success && !accountLimitHit`, `exitCode===3 && !subtype` |
| **CCS session** rate limit | Profile's per-session API quota (hours) | Yes (all executions) | `accountLimitHit` flag (429 `rate_limit_error`) |
| **CCS weekly** rate limit | Profile's weekly API quota | Yes (all executions) | Same `accountLimitHit` flag |

**Rate limit retry** (all executions — queue-based):
- `_scheduleRateLimitRetry()`: queues execution; first entry triggers (1) profile switch or (2) timed retry
- `_rateLimitPaused` getter (`queue.length > 0`) blocks dequeue
- `_processRateLimitQueue()` re-captures before retry; gives up on all entries if still ≥95%
- Sequential drain: `_processNextInQueue()` pops entries with 5s delay between retries

---

## FL Incomplete Termination Detection (`claudeService.js`)

Detects context/max_turns exhaustion mid-work where CLI reports success but FL didn't finish.
- **Condition**: Exit 0 + `resultSubtype === 'success'` but status still `[PROPOSED]` (not `[REVIEWED]`, via `fileWatcher.statusCache`)
- **Action**: Auto-retries FL as new execution (up to `MAX_FL_RETRIES`, shared counter with FL auto-retry)
- **Skipped**: `[BLOCKED]` (legitimate) or `fileWatcher` null (fallback: register waiter normally)
- **WS**: `chain-retry` with `retryType: 'incomplete'`. On exhaustion: falls through to email notification

## Tmp Cleanup (`cleanupService.js`)

Purges old files from `_out/tmp/dashboard/` to prevent unbounded disk growth.
- **Targets**: `debug-*.log` (3d), `*-YYYY-MM-DD.log` (7d), `term-*.debug.log` (7d), `exec-*.jsonl/sh` (7d), `execution-history.jsonl` entries (7d)
- **Schedule**: Initial purge on startup + every 6h (`TMP_CLEANUP_INTERVAL_MS`)
- **Protected** (never deleted): `ratelimit-cache.json`, `sessions.json`, `latest` symlink, `logs/` dir
- Regex pattern matching + `fs.stat` mtime. Errors logged, never crash. Logs summary (count + MB freed)

## Browser Refresh Resilience

State is split into backend-authoritative and frontend-only.
- **Backend stores**: Execution objects (process, logs, phase, context%, tokenUsage — in-memory Map, 1h TTL), shell command results (`shellStates` Map, exposed via `/api/health`), rate limit cache (persisted to disk)
- **Frontend stores**: UI interaction state (selected tab, panel visibility, notifications)
- **On F5**:
  1. `fetchExecutions()` rehydrates `executions` + `executionStates` + `featurePhases` from `GET /api/execution` + logs API
  2. `checkHealth(true)` restores `shellStates` button colors + triggers `capture({ forceRefresh: true })` via `?refresh=1`
  3. Health poll at 8s/30s picks up fresh rate limit data
- WS `shell-complete` and `state` events continue real-time updates after rehydration

## Context Percent Cap (`streamParser.js`)

`contextPercent` is capped at 100%. Subagent-heavy executions (`/run` with many Task tool invocations) can report cumulative `cache_read_input_tokens` that exceed the single-session context window, producing misleading values like 1015% or 4383%. The cap prevents UI confusion while preserving the raw token counts in `tokenUsage` for debugging.

---

## Session ID Persistence (`claudeService.js`)

Session IDs persisted to `_out/tmp/dashboard/sessions.json` on completion and handoff.
- Loaded on startup, pruned (entries >7 days removed on each save)
- `resumeInBrowser()`/`resumeInTerminal()` falls back to `_lookupSessionId()` when execution evicted from in-memory Map (1h TTL)
- Enables resume hours/days after execution without increasing `EXECUTION_TTL_MS`
- Protected from cleanup (excluded by pattern — only `debug-*.log` and `*-YYYY-MM-DD.log` targeted)

## Execution History (`claudeService.js`)

Completed/failed/handed-off executions appended to `_out/tmp/dashboard/execution-history.jsonl`.
- JSONL format: `{ executionId, featureId, command, status, exitCode, sessionId, startedAt, completedAt, contextPercent }`
- Written from `_handleCompletion` (2 paths: normal + rate-limit) and `_handoffToTerminal`
- Read by `GET /api/execution/history` (7-day filter, newest-first)
- Pruned by `cleanupService._pruneHistoryJsonl()` (entries >7 days removed)
- Frontend: History button in ExecutionPanel tab bar → HistoryView component with Copy ID + Resume per entry

---

## Known Limitations

| Issue | Notes |
|-------|-------|
| Stale data on WS disconnect | `executionsRef` is frontend state; may be stale during disconnect. On reconnect, `fetchExecutions()` rehydrates executions + executionStates + featurePhases from backend API. Resume button still uses frontend ref (acceptable for personal tool). |
| fileWatcher depth:0 | Intentional (watch agents/ directory only) |
| Diamond dependencies | In TreeView, A→C, B→C shows C only under first-visited parent. Intentional: shows execution order (depth-first), not full DAG. Actual deps visible via pendingDeps. |
| CCS YAML parsing | Simple regex parsing of config.yaml. Assumes `default:` is top-level key. No anchor/multiline support. Sufficient for current use. |
| engine/ git monitoring | `/api/health` monitors both main repo and `engine/` for git dirty indicator. Removal tracked in `full-csharp-architecture.md` Phase 30 Task 7. |
| Context % with subagents | `cache_read_input_tokens` from Agent tool can exceed `contextWindow`, producing >100%. Capped at 100% in UI; raw values preserved in `tokenUsage`. Subagent assistant events are filtered by `taskDepth > 0` (incremented on `block.name === 'Agent'` tool_use, decremented on matching tool_result). |

### Windows-Specific Constraints

- `shell: false` required (shell:true breaks piping)
- `windowsHide: true` hides console window
- `stdio: ['pipe', 'pipe', 'pipe']` with immediate `proc.stdin.end()` — stdin must be closed to prevent CLI hang in `-p` mode
- `--verbose` must precede `--output-format stream-json`
- `taskkill /F /T /PID` kills entire process tree

### `-p --resume` File Writing (Resolved)

Previously assumed broken, but **works correctly in 2.1.0+**. Tested (2026-02-04):

```bash
claude -p "hello" --verbose --output-format stream-json  # → session_id取得
claude --resume {session_id} -p "write file" ...         # → Write tool成功
```

Root cause: v2.1.0 fixed "files and skills not being properly discovered when resuming sessions with `-c` or `--resume`". Enables orchestrator patterns (Claude spawning Claude via `-p --resume`).

---

## Future Work

### Repository Separation

The dashboard has grown into a standalone web application (650+ backend tests, 230+ frontend tests, 12+ service modules) and should eventually be extracted into its own repository. The main coupling points are:

- **`projectRoot` hardcoding**: `featureParser`, `fileWatcher`, and `logger.js` resolve paths relative to the parent project. Replace with a `PROJECT_ROOT` environment variable in `config.js`.
- **`_out/tmp/dashboard/` log output**: `logger.js` resolves the project root by traversing 5 directory levels. Should use `PROJECT_ROOT` instead.
- **`patch-pm2.js` location**: Currently at `src/tools/node/feature-dashboard/`. Move into the dashboard repo.

**Preparation steps** (can be done incrementally before separation):
1. Add `PROJECT_ROOT` env var to `config.js`, default to current path resolution for backward compatibility
2. Replace all hardcoded path traversals with the config value
3. Verify all tests pass with an explicit `PROJECT_ROOT` setting

**Trigger**: Extract when a second project needs the dashboard, or when the dashboard's commit volume justifies independent history.

### Terminal Handoff Reduction

Since `-p --resume` works in v2.1.0+, many terminal handoff scenarios can be handled in-browser via `resumeInBrowser()`. This eliminates the need for `wt.exe` in most cases.

**Completed**:
- [x] Rate limit (429): `_startRateLimitRetry()` uses `--resume` when sessionId available, preserving conversation context
- [x] y/n prompts: Yes/No buttons in ExecutionPanel → `answerInBrowser(id, 'y'|'n')` → `-p --resume`
- [x] AskUserQuestion: Clickable option buttons in ExecutionPanel → `answerInBrowser(id, selectedOption)` → `-p --resume`
- [x] Terminal handoff is opt-in only ("Terminal" fallback button in input panels)

**Known limitation**: AskUserQuestion incomplete tool_use turn is NOT saved to session JSONL. The browser answer is sent as a `-p` prompt on `--resume`, relying on Claude to infer context from conversation history. If this proves unreliable, revert AskUserQuestion to immediate terminal handoff (see [revert instructions](#revert-to-terminal-first)).

**Remaining**:
- [ ] Verify AskUserQuestion browser-answer reliability across multi-option and multiSelect scenarios
