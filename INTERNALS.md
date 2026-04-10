# Feature Dashboard — Internals

Implementation details and design decisions. Read [HANDOFF.md](HANDOFF.md) first.

---

## Three Limit Concepts

The word "session" appears in two unrelated contexts:

| Concept | What it means | Retryable | Detection |
|---------|--------------|-----------|-----------|
| **Conversation context** exhaustion | Single `-p` session's token window is full | Yes (3x, fresh session) | `error_max_turns`, `max_tokens`, `promptTooLong`, `exitCode≠0 && subtype=success && !accountLimitHit`, `exitCode===3 && !subtype` |
| **CCS session** rate limit | Profile's per-session API quota (hours) | Yes (all executions) | `accountLimitHit` flag (429 `rate_limit_error`) |
| **CCS weekly** rate limit | Profile's weekly API quota | Yes (all executions) | Same `accountLimitHit` flag |

---

## Rate Limit Cache Details

Tracks CCS **profile-level** usage (weekly/session/sonnet — API quota limits, NOT conversation context).

- **expiresAt**: `min(weekly reset, session reset, sonnet reset, 1 week)`
- **refreshAt**: Adaptive 5min–6h based on **per-profile** activity and max percent
  - Profile idle (no running/queued executions using this profile): 6h
  - Profile active ≥90%: 5min
  - Profile active 80–89%: 10min
  - Profile active <80%: 30min
- **Session burn rate prediction**: When session elapsed ≥30min, percent ≥5%, and <100%, projects usage to end of 5h window
  - Projected >150%: 5min refresh
  - Projected >100%: 10min refresh (weekly unchanged)
- **Triggers**: Startup `capture({ forceRefresh: true })`, 5min periodic polling (stale filter), FE-refresh (`/api/health?refresh=1`), 429 path (per-profile), expiry timer
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
1. First entry: try per-execution profile switch (Strategy 1) → immediate retry after 5s. If no safe profile → timed retry at earliest `resetsAt` + 1min buffer
2. Subsequent entries: queued behind first entry (no duplicate timers/switches)
3. After each retry completes (non-429), next queue entry starts after 5s delay
4. If retry itself hits 429: re-queued at **front** of queue (unshift via `_rateLimitQueueContinue`), strategy restarted if no active timer
5. `_rateLimitPaused` is a getter (`queue.length > 0`) that blocks `_dequeueNext()`

**Session resume**: When failed execution has `sessionId`, retry uses `claude -p "continue" --resume <sessionId>` (preserves context); falls back to fresh `executeCommand()` when no sessionId

**Events**:
- WS: `account-limit` → `rate-limit-waiting` → `rate-limit-retry` or `rate-limit-exhausted`. `rate-limit-retry` includes `resumed: true/false`. `rate-limit-exhausted` includes `queueSize`
- Email: `account-limit` (with retry schedule) → `rate-limit-recovered` or `rate-limit-exhausted`

**Retry guards**:
- `needsContextRetry` and `flWantsRetry` block all retries when `accountLimitHit` is true
- `exitCode≠0 && subtype=success` context heuristic guarded by `!accountLimitHit` — debug log scan promoting 429 prevents false context retry

#### Dashboard-Managed Process Guard

Dashboard-spawned processes receive `CLAUDE_DASHBOARD_MANAGED=1` env var via `_buildClaudeEnv`.
The CLI stop hook (`stop-ratelimit-resume.ps1`) checks this variable and exits immediately,
deferring 429 recovery to dashboard's `_scheduleRateLimitRetry` (Strategy 1: profile switch,
Strategy 2: timed retry until reset). Terminal-mode processes (user-initiated via "Terminal" button)
do NOT receive this variable, preserving the hook's CLI-direct functionality.

Without this guard, the stop hook competes with dashboard retry, and when all profiles are
exhausted, loops indefinitely (~5s intervals, observed 37 iterations in F886 FL 2026-03-13).

**CLI 429 not in streams**: Claude CLI writes `rate_limit_error` to `--debug-file` only, not to stdout/stderr stream-json. CLI emits `result { subtype: 'success', is_error: true }` for 429, same pattern as context exhaustion. Dashboard uses **two-pass debug log scan**: (1) immediate `readFileSync` at process `close` event, (2) deferred 500ms re-scan if immediate scan fails (Windows file lock / flush timing). Deferred detection cancels any in-flight context retry timer and routes to rate limit retry instead. If CLI changes to emit 429 in streams, the stderr/non-JSON detection will catch it first and the debug scan becomes redundant (harmless).

## Auto-Switch Details (Removed)

Global auto-switch (`_checkAutoSwitch` + `onAutoSwitch`) was removed after round-robin profile allocation made the global default profile meaningless. Replacement:

- **Allocation filter**: `_allocateProfile()` in claudeService.js skips profiles ≥80% (`getSafeProfile`)
- **429 recovery**: Per-execution Strategy 1 switches to a safe profile on rate limit hit
- **Retry queue**: `_processRateLimitQueue` evaluates per-entry profile usage, discarding exhausted entries

---

## Browser-First Input Handling

Both y/n patterns and AskUserQuestion are handled browser-first. When detected, `pendingHandoff` is set with a timeout, and WS events notify FE. Source: `streamParser.js` + `claudeService.js`.

### y/n Flow Detail

CLI emits `result` event (session saved) → streamParser cancels pendingHandoff timeout → **kills process** → `_handleCompletion` Fix B guard catches `waitingForInput` → execution stays `running` (slot held) → FE shows Yes/No buttons → user clicks → `answerInBrowser` resumes session. Safety timeout (30min) force-completes if user never answers.

- `result` event arrives → `pendingHandoff` **cancelled** → process **killed** → Fix B holds slot as `running`
- `_handleCompletion` safety timeout: `INPUT_WAIT_CLEANUP_MS` (30min)

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

### Remote Control Auto-Answer (PTY Mode)

When `HANDOFF_MODE=remote`, the PTY worker (`remoteCapture.js`) continues monitoring after URL capture (Phase 3). Detects y/n and AskUserQuestion prompts via `INPUT_WAIT_PATTERNS` + TUI selector pattern matching on `stripAnsi(rawBuffer)`.

**Flow**: URL captured → Phase 3 active → input detected → 2s delay → re-check buffer → auto-type if prompt still present.

- **y/n**: `pty.write("y\r")` after 2s re-check
- **AskUserQuestion**: Two-stage detection (`?` question line + `>` / `❯` selector within 5 lines) → `pty.write("1\r")` (first option)
- **Human coexistence**: Remote URL and auto-answer share the same PTY stdin. Human answers first → prompt disappears → re-check skips auto-type. No mutex needed.
- **Disable**: Parent sends `{ type: 'disable-auto-answer' }` IPC to stop Phase 3.

**Chain continuation after PTY exit**:
- IPC `exit` (normal): chain-enabled execs keep `terminalActive=true` → fileWatcher detects `[DONE]` → `_resolveTerminalActive` → `registerWaiter` → chain continues to `/imp`
- `worker.on('exit')` (crash fallback): immediate cleanup (`terminalActive=false`, `releaseChainSlot`)
- `exitHandled` flag prevents double-fire between IPC exit and worker process exit

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

**Triggers**: Startup (background) + 5min periodic polling (stale filter) + 429 path (per-profile) + expiry timer. Command start calls `recomputeRefreshTimes()` only (no capture).

**FE display**: Header shows `{profile} W:XX% S:XX%` with reset times (`↻W:` / `↻S:`) when percent > 75% (yellow ≥70%, red pulse ≥90%). Sonnet data captured but not displayed (used for auto-switch and rate limit retry).

**Helpers**: `getEarliestResetTime()` — earliest reset across all profiles (for timed retry). `getSafeProfile(excludeProfile)` — profile below 90% (for switch retry). `getWeeklyResetTime(profile)` — weekly reset for specific profile. `getEarliestWeeklyResetIfAllExhausted()` — earliest weekly reset when ALL profiles weekly >= `RATE_LIMIT_SAFE_THRESHOLD` (95%) (for weekly-wait strategy). Capture time: ~7-10s per profile.

**Auto-switch (removed)**: Global `_checkAutoSwitch` + `onAutoSwitch` removed — see [Auto-Switch Details (Removed)](#auto-switch-details-removed). Profile filtering now handled by `_allocateProfile()` and per-execution 429 Strategy 1.

## Rate Limit Retry (`claudeService.js`)

When an execution hits 429, `_scheduleRateLimitRetry()` attempts recovery:

**Strategy 1 (immediate — profile switch)**:
- `rateLimitService.getSafeProfile(currentProfile)` finds alternative profile below 90%
- If found: `_switchProfile(safeProfile)` (`ccs auth default` with validation) → retry after 5s

**Strategy 2 (weekly-exhausted — wait for weekly reset)**:
- `rateLimitService.getEarliestWeeklyResetIfAllExhausted()` checks if ALL profiles have weekly >= 100%
- If all weekly-exhausted: schedule timer at earliest weekly reset + 1min buffer (skips pointless session-reset wait)
- On timer: `_processRateLimitQueue()` re-captures, re-evaluates

**Strategy 3 (timed — wait for session/other reset)**:
- `rateLimitService.getEarliestResetTime()` → schedule timer at `resetTime + RATE_LIMIT_RETRY_BUFFER_MS` (1min)
- Queue blocks `_dequeueNext()` via `_rateLimitPaused` getter (`queue.length > 0`)
- On timer: `_processRateLimitQueue()` re-captures all profiles, evaluates per-entry by `execution.ccsProfile` (< `RATE_LIMIT_SAFE_THRESHOLD` 95%). If still exhausted and all weekly >= 100%, re-schedules to weekly reset. Otherwise discards exhausted entries and drains safe entries sequentially

**Queue-based retry**: Multiple concurrent 429s are queued in `_rateLimitRetryQueue`. First entry triggers Strategy 1/2. Subsequent entries queue behind. After each retry completes, `_processNextInQueue()` starts next entry with 5s delay. Killed/cancelled entries are skipped.

**Session resume**: `_startRateLimitRetry()` checks for `sessionId`:
- With sessionId: `claude -p "continue" --resume <sessionId>` (preserves context — avoids re-reading files)
- Without sessionId: falls back to fresh `executeCommand()`
- Resume creates new execution with original command name (not `resume:` prefix) for chain compatibility

**Cleanup**: `killExecution()` removes specific entry from `_rateLimitRetryQueue` (clears timer if queue empties). `killAllRunning()` clears entire queue. `getQueueStatus()` exposes `rateLimitQueue` array and `rateLimitRetryAt`.

**Events**: WS `rate-limit-retry` includes `resumed: true/false`. Email: `account-limit` → `rate-limit-recovered` or `rate-limit-exhausted`.

**Email subjects**: `account-limit` (429), `rate-limit-recovered`, `rate-limit-exhausted`, `context-limit N/3`, `fl-retry N/3`. Result derived from chain history's last entry (single source from claudeService).

---

## Incomplete Termination Detection (`claudeService.js`)

Detects when fc/fl/run exits with success but status didn't advance to expected state.
- **Condition**: Exit 0 + `resultSubtype === 'success'` but status doesn't match `EXPECTED_STATUS_AFTER_COMMAND` (fc→`[PROPOSED]`, fl→`[REVIEWED]`, run→`[DONE]`), via `fileWatcher.statusCache`
- **Action**: Terminal handoff (`_handoffToTerminal`) for `--resume` continuation. No fresh retry — with 1M context, resuming the existing session is more effective than restarting from Phase 1
- **Run-lock**: For `/run`, sets `terminalActive = true` to hold run-lock + chain-slot until `[DONE]`/`[CANCELLED]`
- **Skipped**: `[BLOCKED]` (legitimate), `[DRAFT]` after FL (fc_rerun decision), status beyond expected (`isStatusBeyond`), or `fileWatcher` null (fallback: register waiter normally)
- **User action detected**: `_detectUserActionRequired` checks `lastAssistantText` for file deletion / y/n patterns — also hands off to terminal (separate upstream check)

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
claude -p "hello" --verbose --output-format stream-json  # → obtain session_id
claude --resume {session_id} -p "write file" ...         # → Write tool succeeds
```

Root cause: v2.1.0 fixed "files and skills not being properly discovered when resuming sessions with `-c` or `--resume`". Enables orchestrator patterns (Claude spawning Claude via `-p --resume`).

---

## Execution Behavior Details

Detailed retry logic, detection mechanisms, and slot management.

### Key Timeouts & Behaviors

| Setting | Value | Purpose |
|---------|------:|---------|
| Rate limit cache | dynamic | Profile-level usage cache (weekly/session/sonnet) |
| Rate limit polling | 5min | Background capture interval |
| Rate limit capture | 20s | node-pty capture timeout (typical: 7-10s) |
| Stall check interval | 30s | Stall polling (worst-case ≤90s) |
| Stall detection | 60s | Mark execution as stalled |
| Execution TTL | 24h | In-memory execution retention |
| Stuck cleanup | 2h | Force-terminate unresponsive executions |
| Pending handoff (y/n) | 10s | Fallback if result event never arrives |
| Input email delay | 2min | Email delay; cancelled on browser answer |
| AskUserQuestion | kill+resume | Kill on detection, resume via `--resume` |
| Account limit (429) | queue-based | Profile switch or timed retry |
| Server error (500/529) | 5x exp backoff | 1m→5m→30m→1h→2h retry |
| Safe profile filter | allocation | Skip profiles ≥80% usage |
| Context retry | 3x (5s) | Retry on context exhaustion |
| FL auto-retry | 3x (5s) | Retry FL on non-context failure |
| Incomplete termination | terminal handoff | Status didn't advance → `--resume` |
| Run-lock | acquire/release | Single `/run` exclusion |
| Terminal-active (run) | lock-hold | Hold run-lock until resolution |
| Chain slot | per-chain | Slot reserved for chain lifecycle |
| Dep-aware dequeue | event-driven | Skip features with pending deps |
| Stale waiter → Auto-DR | 5min+10min | Clean chain waiters, trigger DR |
| Tmp cleanup | 6h | Purge old debug/daily logs |
| Insights capture | ~2min | `/insights` ConPTY + email |
| Dependency updater | daily/weekly/monthly | Auto-update CLI tools and packages |
| Update analysis | execution | Claude Code release impact analysis |

Full config: `backend/src/config.js`

### Server Error Retry (500/529)

Retries on `overloaded_error`, `api_error`, or `internal_server_error` detected from the debug log via `_scanDebugLogForServerError`.

- **Detection**: Scans last 16KB of `--debug-file` for server error patterns
- **Backoff**: Exponential — 1m→5m→30m→1h→2h (`SERVER_ERROR_BACKOFF_MS`), 5 retries max
- **Counter**: `serverErrorRetryCount` (independent from context/FL retry counters)
- **Profile switch**: Skipped (server errors are not profile-specific)
- **Blocked by**: `accountLimitHit` (429 takes priority)
- **On exhaustion**: `server-error-exhausted` WS event + email notification

### Context Retry

Retries on **conversation context** exhaustion (single `-p` session's token window full).

- **Detection**: `error_max_turns`, `max_tokens`, `promptTooLong`, `exitCode≠0 && subtype=success` (**only when `!accountLimitHit`**), `exitCode===3 && !subtype`
- **Retry**: 3x with 5s delay, fresh session (no `--resume`)
- **Counter**: `contextRetryCount` (independent from FL retry)
- **Blocked by**: `accountLimitHit` or `[BLOCKED]` status
- **On exhaustion**: Email subject `context-limit 3/3`

### FL Auto-Retry

Retries FL on non-context failure (non-zero exit) or re-run request (text pattern match).

- **Retry**: 3x with 5s delay
- **Counter**: `retryCount` (independent from context retry)
- **Blocked by**: `accountLimitHit`, `isContextExhausted`, or `[BLOCKED]` status
- **On exhaustion**: `fl-retry-exhausted` WS event + email subject `fl-retry 3/3`

### Run-Lock (`/run` Exclusion)

Only one `/run` executes at a time.

- **Acquire**: At `_startExecution` (`runLockFeatureId`)
- **Release**: **Only** on `[DONE]`/`[CANCELLED]` status change (`handleFeatureStatusChanged` → `_releaseRunLock`)
- **NOT released** on retry/kill/completion — retries bypass via same-feature check (`_isRunBlocked`)
- Kill without status change keeps lock until manual `[CANCELLED]` or DR
- `_resolveTerminalActive` releases after terminal-active resolution

### Terminal-Active (Run)

Terminal handoff for `/run` holds run-lock + chain-slot until `[DONE]`/`[CANCELLED]`/stale(2h). On `[DONE]`, imp auto-enqueue. See `claudeService.js` `_resolveTerminalActive`.

### Chain Slot Reservation

Reserves execution slot for entire chain lifecycle (fc→fl→run→imp).

- **Tracking**: `chainSlots` Set with root execution IDs
- **Non-chain limit**: `maxConcurrent - idleChainSlots`
- **Released on**: Chain completion, cancel, handoff, stale cleanup, rate limit exhaustion, or dep-blocked at bulk queue time (re-reserved at dequeue)
- **Config**: `MAX_CONCURRENT_EXECUTIONS` (env: `MAX_CONCURRENT`, default 4)
- **Exempt**: Slash commands (`commit`, `sync-deps`) bypass queue limit (`SLOT_EXEMPT_COMMANDS`)

### Chain Execution Flow

```
[DRAFT] → fc → [PROPOSED] → fl → [REVIEWED] → run → [DONE] → imp → [DONE]
```

**Stop conditions**: Error, Handoff, [BLOCKED], [DRAFT] after FL (fc_rerun), User kill, Chain-cut

### Dep-Aware Dequeue

Features with unresolved dependencies (`pendingDeps`) or dependencies with active `/imp` executions stay in queue but are skipped by `_dequeueNext()` and `_canStartNow()`.

- **Trigger**: `status-change` + `features-updated` events
- **Cache invalidation**: When a dep reaches `[DONE]`/`[CANCELLED]`, featureService cache is invalidated and queue re-evaluated
- **Fail-closed**: `_getPendingDeps()` returns `null` on error → treated as blocked
- **Priority**: Features with more dependants dequeue first (computed per-dequeue from cachedFeatures)
- **FE**: "Queue All" button queues all tree features including dep-blocked ones
- **WS**: `queue-updated` event includes `depBlocked` and `pendingDeps` fields

### DepViolation (Running Dep Kill)

Kills running executions that gained unresolved dependencies after they started.

- **Method**: `_checkRunningDepViolations()` (`claudeService.js`)
- **Trigger**: `features-updated` event (`server.js:186`)
- **Logic**: For each running execution (excluding `SLOT_EXEMPT_COMMANDS`), calls `_getPendingDeps(featureId, null, { skipImpBlocking: true })`. If pending deps exist → kill
- **WS**: `dep-violation` with `{ executionId, featureId, command, pendingDeps, timestamp }`
- **After kill**: Process terminated (non-zero exit), chain slot released. Feature must be re-queued manually or via auto-queue

### Auto-Queue on Dep Addition

Auto-queues `[DRAFT]` features when their dependency set grows.

- **Method**: `_autoQueueDraftsWithDeps()` (`claudeService.js`)
- **Init**: `initializeDepsMap()` seeds `_previousDepsMap` from current features at startup (`server.js:182`)
- **Trigger**: `features-updated` event (`server.js:187`)
- **Logic**: Compares current dep IDs (bold stripped) against `_previousDepsMap`. If IDs grew OR Depends On changed from empty to `-` (explicit no-deps marker) + `[DRAFT]` + not running/queued → `executeCommand(featureId, 'fc', { chain: true })`
- **Reasons**: `deps-added` (empty→FIDs), `deps-changed` (FIDs grew), `deps-cleared` (empty→`-`)
- **WS**: `auto-queued` with `{ featureId, executionId, reason, dependsOn, timestamp }`
- **Deferred detection**: `_previousDepsMap` is NOT updated when feature is `alreadyActive` — preserves dep change for re-detection after DepViolation kill. `_handleCompletion()` and `killExecution()` (dead-process path) call `_autoQueueDraftsWithDeps()` for re-evaluation

### Call Chain (`fileWatcher.onFeaturesUpdated`)

```
feature file change → chokidar → onFeaturesUpdated()
  → _checkRunningDepViolations()  // kill running with new unresolved deps
  → _autoQueueDraftsWithDeps()    // auto-queue DRAFTs with new deps
  → _dequeueNext()                // start next eligible
```

Ref: `server.js:185-189`

### Safe Profile Filter

`_allocateProfile` filters profiles ≥80% usage. Per-execution 429 Strategy 1 switches profile on rate limit hit. Global auto-switch removed (round-robin makes global default meaningless).

### Insights Capture

`/insights` via node-pty ConPTY (~2min).

- **Completion detection**: Dual — `report.html` mtime change + PTY `"report is ready"` pattern
- **Email**: HTML report via `emailService.sendHtml()`
- **Scheduler**: Cron-style `setTimeout` (Monday 07:00 JST)
- **API**: `POST /api/insights/capture` (409 if running), `GET /api/insights/status`

### Dependency Updater

Scheduled auto-update of development tools and packages.

- **Schedule**: CCS (daily), CodeRabbit/PM2 (weekly), NuGet-check/Go/pip/Docker-CE/SonarQube/npm (monthly)
- **Type A** (global CLI): Version check → update → version diff → email
- **Type B** (repo): Update → git diff → test → commit or revert
- **Type docker**: `wsl -- sudo service docker start` → `apt-get upgrade docker-ce` → version diff
- **Type docker-image**: `docker pull` → recreate container if updated → health check (start → poll UP → stop; 120s timeout, 5s poll) → `service docker stop`
- **pip tier**: `pytest pyyaml ruff yamllint`
- **PM2 reload**: Deferred to next clean exit via detached spawn (3s delay, `exitHelpers.js`)
- **npm-dashboard**: Requires idle check (5 conditions)
- **Weekly summary**: `[Dep-Summary]` email aggregates all tiers; per-tier `[Dep-Update]` suppressed for weekly
- **Master switch**: `UPDATE_ENABLED` env var
- **API**: `POST /api/deps/trigger` (per-tier, 409 if running), `GET /api/deps/status`

### Update Analysis

Claude Code release detection and impact analysis.

- **Trigger**: IMAP listener detects GitHub notification email
- **Execution**: `claudeService.executeUpdateAnalysis()` runs as `update-analysis` execution (tile, log, terminal resume)
- **Analysis**: 3 dimensions — Dashboard impact, Project impact (workflow/settings/env), new feature adoption opportunities
- **Completion**: `_onComplete` callback → HTML email with dual impact badges (D:/P:) + changelog
- **API**: `GET /api/update/status`

---

## Testing Requirements

After code changes:

```bash
# Run tests (from dashboard root)
npm test                                                  # both via workspaces
npx vitest run                                            # both (via vitest.config.js projects)
npm test --workspace=backend                              # backend only
npm test --workspace=frontend                             # frontend only

# Check coverage (output: _out/coverage/)
npx vitest run --coverage

# Mutation testing (after adding new tests)
npm run test:mutation
```

**Test levels** (prefer higher levels when feasible):

| Level | What | Pattern | Example |
|-------|------|---------|---------|
| **Route/Behavior** | HTTP request→response through Express | `execution.test.js` — `request(app, method, url, body)` | `GET /history` returns entries, `DELETE /history` then `GET` returns empty |
| **Service unit** | Single method with mocked deps | `cleanupService.test.js` — `svc._pruneHistoryJsonl(path, days)` | History pruning removes old entries |
| **Component** | React component rendering | `ExecutionPanel.test.jsx` — `render(<Component {...props} />)` | History button renders in tab bar |

**Prefer behavior tests over unit tests**: When adding a new API endpoint, always write route-level tests in `execution.test.js` (or the relevant route test file) that exercise the full request→service→response path. Unit tests on the service alone are insufficient — they miss routing bugs, param validation, error handling at the HTTP layer, and UUID validator interference.

**Test support APIs**: Endpoints for test setup/teardown (e.g., `DELETE /api/execution/history` for clearing state). These enable multi-step behavior tests that verify state transitions across API calls.

**Mutation testing interpretation**:
- **Killed**: Mutant detected by tests → good test
- **Survived**: Mutant escaped tests → test gap
- Target: 60%+ mutation score (covered scope)

---

## Diagnostics

Use **`ddiag`** (devkit alias for `dashboard_diag.py`) for dashboard troubleshooting. Manual `grep`/`tail`/`cat` is forbidden — ddiag reduces grep usage by 87% (backtest proven).

```bash
ddiag
```

### Scenario-Based Quick Reference

| Scenario | Run first | If more detail needed |
|----------|-----------|----------------------|
| **Execution failed** | `--exec {ID}` (auto VERDICT) | `--exec {ID} --verbose` for all events |
| **Execution timeline** | `--exec-timeline {ID}` | Shows key events chronologically |
| **Feature full history** | `--feature {ID} --after DATE` | — (single command) |
| **429/Rate Limit investigation** | `--exec {ID}` (auto 429 detection) | `--debug-grep {ID} "rate_limit"` |
| **Queue status** | `--queue` (live) | `--queue --after DATE` with log history |
| **Queue state timeline** | `--queue-state --after DATE` | Periodic `[Queue] STATE` log snapshots |
| **Queue/Slot contention** | `--search "." --type queue --after DATE` | `--feature {ID}` for specific feature tracking |
| **Chain retry trends** | `--events context-retry,handoff --after DATE` | `--events ... --by-feature` |
| **Unknown Exec ID** | `--resolve {ID}` | `--list-debug` for debug log list |
| **PM2 crash** | `--pm2 --pm2-type crash` | `--pm2 "ACCESS_VIOLATION"` |
| **Search debug log** | `--debug-grep {ID} "pattern"` | `-i -C 3` for context |
| **Cross-log search** | `--search "pattern" -i -C 3` | Searches all 4 log sources. `--after DATE` to narrow |
| **Multi-pattern search** | `--search "F932" --or "F935"` | OR-join for multi-feature search |
| **Category filter** | `--search "." --type claude` | claude/server/watcher/websocket/queue/chain |

### Log Sources (4 types, all auto-detected)

| Log | Path | Content |
|-----|------|---------|
| App log | `~/.pm2/logs/dashboard-backend-out.log` | spawn, broadcast, chain, status changes |
| Error log | `~/.pm2/logs/dashboard-backend-error.log` | stderr (uncaught exceptions) |
| PM2 system log | `~/.pm2/pm2.log` | Process restart/crash/exit code |
| Debug log | `C:\Era\devkit\_out\tmp\dashboard\debug-{execId}.log` | 429 detection, CLI internal errors |

### Tips

- **`--resolve {ID}`**: Exec ID → Feature/Command resolution. Still searchable from app log after API evict (TTL 1h)
- **`--list-debug --after DATE`**: Debug log list (size, timestamp, auto-resolved feature)
- **`--verbose`**: Combined with `--exec` shows all log events. With `--search` removes max_matches=20 limit
- **`--width 0`**: Disable output truncation
- **`-C N`**: Show context lines with `--search` / `--debug-grep`
- **`--raw-log`**: Disable VT escape / `[assistant]` changelog line auto-exclusion
- **`--type TYPE`**: Log category filter (claude/server/watcher/websocket/queue/chain)
- **`--or PATTERN`**: OR-join for `--search`. Multiple allowed
- **VERDICT**: `--exec` auto-classifies as RATE_LIMITED / CONTEXT_LIMIT / USER_KILLED / NORMAL / INCOMPLETE / ERROR / UNKNOWN
- **Queue logging**: `claudeLog.info('[Queue] Queued/Dequeued ...')` outputs to app log. Filter with `--type queue`
- **Queue STATE**: `[Queue] STATE {...}` outputs every 10min (`_cleanupOldExecutions`). Records running/queued/chainSlots/waitingInput/inputIds. View as table with `--queue-state`
- **Queue COMPLETION**: `[Queue] COMPLETION {...}` outputs on execution completion in waitingForInput/inputRequired/chain state
- **History JSONL fields**: ccsProfile, resultSubtype, killedByUser, tokenUsage recorded (backward compatible)

---

## Future Work

### Repository Separation

The dashboard has grown into a standalone web application (12+ service modules, see [OPS.md](OPS.md) for current test counts) and should eventually be extracted into its own repository. The main coupling points are:

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
