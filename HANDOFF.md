# Feature Dashboard

A browser-based dashboard for managing Claude Code feature workflows with automatic chain execution.

> **For Claude (orchestrator)**: This file is both documentation and a change checklist.
> When modifying dashboard code, follow the **Orchestrator Workflow** below.

### Orchestrator Workflow

1. **Identify affected files**: Use the Adding Features table to determine which files to modify
2. **Implement**
3. **Verify**: Start with `npm start` and confirm behavior in browser
4. **Test**: Run `npm test` (backend + frontend)
5. **Update coverage & mutation scores**: Update figures in the Reference section
6. **Update HANDOFF.md**: Update affected sections (API Endpoints, WebSocket Events, File Structure, Design Decisions, etc.)
7. **Commit**

### Report Format

Report to user on completion (in Japanese):

- **Scope**: FE / BE / Both
- **DR (Dashboard Restart)**: Required / Not required
- **New API/WS events**: List if any (recommended)

---

## Quick Reference

### Commands

```bash
# Start
cd tools/feature-dashboard && npm start    # backend:3001 + frontend:5173

# Test
npm test                                    # both backend & frontend
npm run test:mutation                       # backend mutation testing

# Restart (from dashboard UI)
dr button                                   # pm2 restart all
```

### Key Timeouts

| Setting | Value | Purpose |
|---------|------:|---------|
| Rate limit cache | dynamic | Tracks CCS **profile-level** usage (weekly/session/sonnet — these are API quota limits, NOT conversation context). **expiresAt**: min(weekly reset, session reset, sonnet reset, 1 week); **refreshAt**: adaptive 5min-2h based on activity and max percent — idle (no running/queued executions)=2h, active: 90%+=5min, 80-89%=10min, <80%=30min; **session burn rate prediction**: when session elapsed ≥30min, percent ≥5%, and <100%, projects usage to end of 5h window — projected >150%=5min, >100%=10min (weekly unchanged). On-start `capture()`, on-completion `capture({ forceRefresh: true })`, and on-FE-refresh (`/api/health?refresh=1`) ensure fresh data when activity resumes. `/usage` data preserves all types; capture failure preserves cache. Persisted to `_out/tmp/dashboard/ratelimit-cache.json` |
| Rate limit polling | 5min | Periodic background capture interval |
| Rate limit capture | 20s | Overall timeout for node-pty capture (typical: 7-10s via `/usage` command) |
| Stall check interval | 30s | Check for stall (worst-case detection ≤90s) |
| Stall detection | 60s | Mark execution as stalled |
| Execution TTL | 1h | Keep completed executions in memory |
| Stuck cleanup | 2h | Force-terminate unresponsive executions |
| Pending handoff timeout | 10s | Fallback kill for deferred y/n handoff if result event never arrives |
| Account limit (429) | auto-retry | API rate limit (`rate_limit_error` / `hit your limit` / `exceed your account's rate limit`). Detection: (1) stderr regex, (2) non-JSON stdout regex, (3) **two-pass debug log tail scan** at completion (last 16KB of `--debug-file` for `rate_limit_error`/`429`; 16KB needed because CLI writes hooks/telemetry after 429, pushing the error >4KB from EOF in long sessions). Sets `accountLimitHit` flag → blocks context retry and FL retry. For **all executions** (chain and non-chain): (1) tries auto-switch to safe profile (immediate retry after 5s), (2) if no safe profile, schedules timed retry at earliest `resetsAt` + 1min buffer. Sets `_rateLimitPaused` to block queue. **Session resume**: when failed execution has `sessionId`, retry uses `claude -p "continue" --resume <sessionId>` to preserve conversation context (avoids re-reading files and re-establishing state); falls back to fresh `executeCommand()` when no sessionId. WS event: `rate-limit-retry` includes `resumed: true/false` field. Broadcasts `account-limit` → `rate-limit-waiting` → `rate-limit-retry` or `rate-limit-exhausted` WS events. Email: `account-limit` with retry schedule, then `rate-limit-recovered` or `rate-limit-exhausted` |
| Auto-switch (≥80%) | proactive | When active profile reaches ≥80% on any rate limit type (weekly/session/sonnet), `_checkAutoSwitch` fires `onAutoSwitch(safeProfile)` callback → runs `ccs auth default "<safeProfile>"` to switch to a specific safe profile. Triggers on every `capture()` completion. Prevents 429 before it happens. Config: `AUTO_SWITCH_THRESHOLD` in `config.js`. WS event: `auto-switch` |
| Context retry | 3x (5s delay) | Retry on **conversation context** exhaustion (error_max_turns, max_tokens, prompt too long, success+is_error **only when `!accountLimitHit`**, exit code 3 with null subtype). Counter: `contextRetryCount` (independent from FL). Blocked by `accountLimitHit`. On exhaustion: email subject `context-limit 3/3` |
| FL auto-retry | 3x (5s delay) | Retry FL on non-context failure (non-zero exit) or re-run request (text pattern). Counter: `retryCount` (independent from context). Blocked by `accountLimitHit` and `isContextExhausted`. On exhaustion: `fl-retry-exhausted` WS event + email subject `fl-retry 3/3` |
| FL incomplete retry | 3x (5s delay) | Retry FL when exit 0 + `subtype=success` but feature status didn't advance (still `[PROPOSED]`, not `[REVIEWED]`). Detects context/max_turns exhaustion mid-work where CLI reports success but FL didn't finish. Uses `fileWatcher.statusCache` for status check. Shares `retryCount` with FL auto-retry. Skips when status is `[BLOCKED]` (legitimate). WS event: `chain-retry` with `retryType: 'incomplete'`. On exhaustion: falls through to email notification |
| Stale waiter → Auto-DR | 5min + 10min | Chain waiters older than `CHAIN_WAITER_TIMEOUT_MS` (5min) are cleaned by `_cleanupOldExecutions()` (runs every 10min). On cleanup, `onExecutionComplete()` is called to trigger deferred Auto-DR re-check |
| Tmp cleanup interval | 6h | Purge old dashboard debug/daily logs (debug-*.log: 3 days, daily logs: 7 days) |

Full config: `backend/src/config.js`

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/execution/{fc,fl,run}` | POST | Execute command |
| `/api/execution/terminal` | POST | Open terminal |
| `/api/execution/shell` | POST | Run cs, dr, upd |
| `/api/execution/slash` | POST | Run /commit, /sync-deps |
| `/api/execution/:id/resume/{browser,terminal}` | POST | Resume session |
| `/api/execution/:id` | GET | Execution status |
| `/api/execution/:id/logs` | GET | Execution logs (with offset) |
| `/api/execution/:id` | DELETE | Stop execution |
| `/api/execution` | GET | List all executions |
| `/api/ratelimit/:profile` | POST | Manual rate limit cache injection |
| `/api/execution/queue` | GET | Queue status |
| `/api/execution/queue/clear` | POST | Clear queued items |
| `/api/features` | GET | List features |
| `/api/features/:id` | GET | Feature detail |
| `/api/health` | GET | Health check |

### WebSocket Events

| Event | Direction | Content |
|-------|-----------|---------|
| `log` | S→C (sub) | Log entry |
| `state` | S→C (sub) | Execution state (phase, contextPercent, isStalled, tokenUsage) |
| `status` | S→C (sub) | Completion/failure notification |
| `handoff` | S→C (sub) | Terminal handoff notification |
| `input-required` | S→C (sub) | AskUserQuestion detected |
| `input-wait` | S→C (sub) | y/n pattern detected |
| `stalled` | S→C (sub) | No output for >60s |
| `chain-progress` | S→C (all) | Chain next step started |
| `chain-retry` | S→C (all) | Auto-retry triggered (retryType: 'context' or 'fl') |
| `fl-retry-exhausted` | S→C (all) | FL retry counter maxed out, manual re-run needed |
| `rate-limit-waiting` | S→C (all) | Rate limit retry scheduled (retryAt, delayMs) |
| `rate-limit-retry` | S→C (all) | Rate limit retry triggered (oldExecutionId, newExecutionId) |
| `rate-limit-exhausted` | S→C (all) | Rate limit retry failed, manual re-run needed |
| `auto-switch` | S→C (all) | CCS profile auto-switched (safeProfile) |
| `chain-blocked` | S→C (all) | Chain blocked by pending deps |
| `features-updated` | S→C (all) | Feature file changed |
| `status-changed` | S→C (all) | Feature status changed (e.g., [DRAFT]→[PROPOSED]) |
| `queue-updated` | S→C (all) | Queue state changed |
| `upd-complete` | S→C (all) | CCS update completed |
| `shell-complete` | S→C (all) | Shell command (cs/dr/upd) completed |
| `auto-dr` | S→C (all) | Backend auto-restarting (file change detected) |
| `auto-dr-pending` | S→C (all) | Backend restart deferred (executions/chain active) |
| `subscribe` | C→S | Subscribe to execution logs |
| `unsubscribe` | C→S | Unsubscribe from execution logs |

Direction: S→C (sub) = server to subscribed clients, S→C (all) = server to all clients, C→S = client to server.

---

## Architecture

```
Frontend (React+Vite :5173)  →  Backend (Express :3001)  →  claude.exe (spawn)
     ↕ WebSocket /ws                  ↕ spawn + pipe            stdio: ['ignore', 'pipe', 'pipe']
  Tile UI + Log viewer           stream-json parse            --output-format stream-json
  + Toast notifications          + Chain execution            --verbose

                                      ↓ (Auto Handoff)
                                 wt.exe --resume <sessionId>
                                 Interactive session
```

### Chain Execution Flow

```
[DRAFT] → fc → [PROPOSED] → fl → [REVIEWED] → run → [DONE]
```

**Stop conditions**: Error, Handoff, [BLOCKED], User kill

### Auto Handoff

Since `stdin: 'ignore'` prevents user input, the dashboard automatically hands off to Windows Terminal when input is required.

**Triggers**:
- `AskUserQuestion` tool_use detected (immediate kill + context display in terminal)
- y/n patterns: `(y/n)`, `[Y/n]`, `Continue?`, `Proceed?` (deferred kill — waits for `result` event so session saves the text; 10s timeout fallback)
- Normal completion with output ending in `?`

**Session preservation**: y/n text handoffs defer the process kill until the `result` stream event confirms the session JSONL is saved. On `--resume`, the y/n prompt text is visible. AskUserQuestion tool_use cannot be saved (incomplete turn), so the question context is displayed in the terminal via `_out/tmp/resume-context.txt` before `claude --resume`.

### Data Flow

```
User action → App.jsx handler → useExecution API call
                                        ↓
                              execution.js route
                                        ↓
                              claudeService.js spawn
                                        ↓
                              stream-json stdout
                                        ↓
                              streamParser.js (parse + state detection)
                                        ↓
                              logStreamer.broadcast (WS)
                                        ↓
                              App.jsx wsHandlers → useExecution dispatch → UI update
```

---

## Development Guide

### Adding Features

| Goal | Files to modify |
|------|-----------------|
| New command | `execution.js` (route) → `claudeService.js` (logic) |
| New shell command | `execution.js` allowedShell → `claudeService.js` runShellCommand |
| Stream event handling | `streamParser.js` handleStreamEvent → `claudeService.js` callbacks |
| UI component | `frontend/src/components/` → `App.jsx` import |
| WebSocket event | `claudeService.js` broadcast → `App.jsx` wsHandlers |
| Feature parsing | `featureParser.js` → `featureService.js` |
| Input detection pattern | `inputPatterns.js` INPUT_WAIT_PATTERNS |
| Styling | `frontend/src/styles/main.css` |

### File Structure

```
backend/
├── server.js                    # Express setup, service wiring
├── send-email.mjs               # CLI email sender (used by Claude Code)
├── email.config.example.json    # Email config template
├── src/
│   ├── config.js                # Constants (timeouts, proxy, CCS)
│   ├── routes/
│   │   ├── execution.js         # /api/execution/* endpoints
│   │   └── features.js          # /api/features/*
│   ├── services/
│   │   ├── claudeService.js     # claude.exe spawn, Auto Handoff, completion logic
│   │   ├── streamParser.js      # stream-json parsing, state detection (extracted from claudeService)
│   │   ├── chainExecutor.js     # Chain execution (fc→fl→run)
│   │   ├── ccsUtils.js          # CCS profile reading (config.yaml, auth list)
│   │   ├── ratelimitService.js  # Rate limit capture (node-pty + VtScreenBuffer)
│   │   ├── featureService.js    # feature-{ID}.md reading, pendingDeps
│   │   ├── fileWatcher.js       # chokidar watch, status change detection
│   │   ├── statusMailService.js # IMAP IDLE status mail (auto-reply to empty emails)
│   │   ├── emailService.js      # Email notification (handoff/completion)
│   │   ├── cleanupService.js     # Tmp file cleanup (debug logs, daily logs, artifacts)
│   │   ├── usageService.js      # CCS usage tracking (not exposed via API)
│   │   ├── inputPatterns.js     # Input wait patterns
│   │   ├── phaseUtils.js        # Phase detection utilities
│   │   └── validation.js        # Input validation
│   ├── parsers/
│   │   ├── featureParser.js     # Feature markdown parsing
│   │   └── indexParser.js       # index-features.md parsing
│   ├── websocket/
│   │   └── logStreamer.js       # WebSocket broadcast (sub/all)
│   └── utils/
│       ├── logger.js            # Logging (daily rotation, JST)
│       └── timeUtils.js         # Shared time utilities (nowJST)

frontend/
├── src/
│   ├── App.jsx                  # State management, wsHandlers, header UI
│   ├── hooks/
│   │   ├── useExecution.js      # Execution state reducer, API calls
│   │   ├── useFeatures.js       # Feature fetching
│   │   └── useWebSocket.js      # WS connection, reconnection
│   ├── components/
│   │   ├── TreeView.jsx         # Dependency tree, tile tap, phase collapse
│   │   ├── ExecutionPanel.jsx   # Log display, Resume/Stop buttons, tabs
│   │   ├── FeatureDetail.jsx    # Feature detail overlay
│   │   ├── LogViewer.jsx        # Log line display
│   │   ├── StatusBadge.jsx      # Status badge
│   │   ├── FeatureTile.jsx      # Feature tile component
│   │   ├── ProgressBar.jsx      # Progress bar component
│   │   ├── PhaseSection.jsx     # Phase section header
│   │   └── QueueIndicator.jsx   # Queue indicator
│   └── styles/
│       └── main.css             # All styles
```

### Testing Requirements

After code changes:

```bash
# Run tests
cd tools/feature-dashboard/backend && npm test
cd tools/feature-dashboard/frontend && npm test

# Check coverage
npx vitest run --coverage

# Mutation testing (after adding new tests)
npm run test:mutation
```

**Mutation testing interpretation**:
- **Killed**: Mutant detected by tests → good test
- **Survived**: Mutant escaped tests → test gap
- Target: 60%+ mutation score (covered scope)

### Security

All user input is whitelist-validated before passing to spawn:

| Function | Validation |
|----------|------------|
| `validateFeatureId()` | Numeric only (`/^\d+$/`) |
| `validateCommand()` | `fc`, `fl`, `run` only |
| `runShellCommand()` | `cs`, `dr`, `upd` only |
| `executeSlashCommand()` | `commit`, `sync-deps` only |

---

## Operations

### Platform Requirements

**Windows + Windows Terminal required**

| Requirement | Reason |
|-------------|--------|
| Windows 10/11 | `taskkill` command, path separators |
| Windows Terminal (`wt.exe`) | Auto Handoff, Resume features |
| Node.js 18+ | ES Modules, fs/promises |

Linux/macOS: Limited support. Process termination (`SIGTERM`) works, but Terminal integration (`wt.exe`) does not.

### Infrastructure

**pm2**:
```bash
pm2 start ecosystem.config.cjs    # proxy(8888) + backend(3001) + frontend(5173)
pm2 save                          # Persist
```

**CCS Profile**: Set via `CLAUDE_CONFIG_DIR` env var. Points to `~/.ccs/instances/{profile}/`.

**New profile setup**: Two types of shared resources — static config (manual symlinks) and dynamic context (CCS managed).

**(1) Static config symlinks** — `cmd.exe` `mklink /D` (NOT Git Bash `ln -s`, which silently copies on Windows):

```bat
:: Run in cmd.exe (not Git Bash) — replace {profile} with profile name
for %d in (agents commands plugins skills) do mklink /D C:\Users\siihe\.ccs\instances\{profile}\%d C:\Users\siihe\.ccs\shared\%d
mklink C:\Users\siihe\.ccs\instances\{profile}\settings.json C:\Users\siihe\.ccs\shared\settings.json
```

Required symlinks (5): `agents`, `commands`, `plugins`, `skills`, `settings.json` → `~/.ccs/shared/`.

**(2) CCS shared context** — session/continuity sharing across profiles:

```bash
# New profile: create with shared context
ccs auth create {profile} --share-context --deeper-continuity

# Existing profile: add to config.yaml accounts section
#   context_mode: shared
#   context_group: default
#   continuity_mode: deeper
```

CCS sync runs on `claude` launch (NOT on `ccs auth default`). On first launch after enabling shared:
- `projects/` (real dir) → merged into `~/.ccs/shared/context-groups/{group}/projects/` → replaced with symlink
- `session-env`, `file-history`, `shell-snapshots`, `todos` → symlinked to `~/.ccs/shared/context-groups/{group}/continuity/`

**Shared context architecture** (CCS v7.51.0, investigated 2026-02-28):

| Resource | Shared by CCS | Location when shared |
|----------|:---:|---|
| `projects/` (session JSONLs) | Yes | `shared/context-groups/{group}/projects/` |
| `session-env/` | Yes (deeper) | `shared/context-groups/{group}/continuity/session-env/` |
| `file-history/` | Yes (deeper) | `shared/context-groups/{group}/continuity/file-history/` |
| `shell-snapshots/` | Yes (deeper) | `shared/context-groups/{group}/continuity/shell-snapshots/` |
| `todos/` | Yes (deeper) | `shared/context-groups/{group}/continuity/todos/` |
| `history.jsonl` | **No** | Per-profile (prompt input history, NOT session index) |
| `memory/` | **No** | Per-project inside `projects/{slug}/memory/` (shared with projects) |
| `.claude.json` | **No** | Per-profile (numStartups, feature flags) |
| `.credentials.json` | **No** | Per-profile (auth tokens) |
| `sessions-index.json` | **No** | Per-project inside `projects/{slug}/` (shared with projects) |

**Security check** (`shared-manager.js` L701-706): CCS validates project merge sources via `isSafeProjectsMergeSource()`. Only paths within `shared/context-groups/` or `instances/{self}/projects/` are allowed. Manual symlinks to `shared/projects/` trigger: `[!] Skipping unsafe project merge source outside CCS roots`.

**Migration gotchas** (isolated → shared):
- If `projects/` is renamed/absent before first shared launch, CCS creates empty shared dir (no merge). Must manually copy old sessions into `shared/context-groups/{group}/projects/{slug}/`.
- `sessions-index.json` contains `fullPath` with old profile-absolute paths. Delete it to force Claude Code to rebuild from JSONL scan.
- Claude Code may recreate `projects/` as a real dir during session if symlink target doesn't exist yet, blocking revert (`rmdir` fails on non-empty real dir).

**`/resume` behavior**: Lists sessions from `projects/{slug}/` JSONL scan (filtered by current working directory). Shared projects means sessions created in any profile are visible from all profiles in the same context group — confirmed working for apple ↔ google ↔ proton (2026-02-28). **Important**: `{slug}` is derived from the CWD (`slugify(cwd)`), so sessions created from a different CWD (e.g., `C:\Users\siihe` → `C--Users-siihe`) appear only in "show all projects" view, not in the default `/resume` list. This is Claude Code behavior, not a CCS limitation.

**Cross-profile session resume**: Rate limit retry (`_startRateLimitRetry`) switches profile via `ccs auth default`, then spawns `claude --resume <sessionId>`. Since all profiles' `projects/` JUNCTIONs resolve to the same shared directory, the sessionId is accessible regardless of which profile resumes it. Verified via code path: `_switchProfile()` → `_buildClaudeEnv()` reads new default → `CLAUDE_CONFIG_DIR` points to new profile → JUNCTION → same shared JSONL.

**Do NOT manually symlink `projects/`** — use CCS `--share-context` instead. Manual symlinks bypass the security check and break session loading.

**Diagnostic tool**: `~/.local/bin/ccs-symlink-test.bat` — dead man's switch for testing projects/ symlink changes. Auto-reverts after timeout. See script for usage.

**Proxy**: `127.0.0.1:8888` - Auto-injected via `_buildClaudeEnv()` as `HTTPS_PROXY`/`HTTP_PROXY`.

### Debugging

```bash
DASHBOARD_DEBUG=1 npm start
```

Enables `debugLog()` calls (spawn args, non-JSON stream lines, Task tool depth).

**Log and session files**:

All dashboard logs are under **project root** `{projectRoot}/_out/tmp/dashboard/` (NOT `tools/feature-dashboard/_out/tmp/`). Path is resolved by `logger.js` going up 5 levels from `backend/src/utils/`.

| Type | Location (relative to project root) | Description |
|------|--------------------------------------|-------------|
| `server-{date}.log` | `_out/tmp/dashboard/logs/` | Express server startup, routes |
| `websocket-{date}.log` | `_out/tmp/dashboard/logs/` | WebSocket connections, broadcasts |
| `claude-{date}.log` | `_out/tmp/dashboard/logs/` | ClaudeService: spawn, chain, retry, completion |
| `watcher-{date}.log` | `_out/tmp/dashboard/logs/` | FileWatcher: status changes, file updates |
| `debug-{execId}.log` | `_out/tmp/dashboard/` | Per-execution Claude CLI `--debug-file` output |
| `sessions.json` | `_out/tmp/dashboard/` | Persistent session ID map (survives execution TTL eviction, 7-day retention) |
| Session JSONL | `~/.ccs/instances/{profile}/projects/{project}/` | Claude conversation history (token usage, messages) |

Backend logs rotate automatically at midnight (UTC). Session JSONL files are managed by CCS.

### Restart Matrix

| Change | Backend restart | Frontend restart |
|--------|:---------------:|:----------------:|
| backend/*.js | Auto-DR | Not required |
| frontend/*.jsx | Not required | Auto (HMR) |
| HANDOFF.md only | Not required | Not required |

**Auto-DR (Auto Dashboard Restart)**: Backend source files (`src/**/*.js`, `server.js`, excludes `*.test.js`) are watched by chokidar. On change, if no Claude executions are running/queued and no chain waiters are pending, `pm2 restart dashboard-backend` is triggered automatically (2s debounce). If executions or chain waiters are active, restart is deferred until all complete. WS event `auto-dr` is broadcast before restart; `auto-dr-pending` is broadcast when restart is deferred (FE shows DR button pulse). Config: `AUTO_DR_DEBOUNCE_MS` in `config.js`.

**Manual restart methods**:
- Dashboard UI `dr` button (pm2 restart all)
- `pm2 restart dashboard-backend` / `pm2 restart dashboard-frontend`

**CAUTION**: Manual `dr` does NOT check for running executions. Before manual restart, confirm no Claude child processes are running (`tasklist | findstr claude`). Backend restart kills the Express server but orphans spawned `claude.exe` processes — they lose their parent and completion/handoff/email callbacks never fire. Auto-DR handles this automatically.

---

## Known Limitations

| Issue | Notes |
|-------|-------|
| Stale data on WS disconnect | `executionsRef` is frontend state; may be stale during disconnect. On reconnect, `fetchExecutions()` rehydrates executions + executionStates + featurePhases from backend API. Resume button still uses frontend ref (acceptable for personal tool). |
| fileWatcher depth:0 | Intentional (watch agents/ directory only) |
| Diamond dependencies | In TreeView, A→C, B→C shows C only under first-visited parent. Intentional: shows execution order (depth-first), not full DAG. Actual deps visible via pendingDeps. |
| CCS YAML parsing | Simple regex parsing of config.yaml. Assumes `default:` is top-level key. No anchor/multiline support. Sufficient for current use. |
| engine/ git monitoring | `/api/health` monitors both main repo and `engine/` for git dirty indicator. Removal tracked in `full-csharp-architecture.md` Phase 30 Task 7. |
| CLI 429 not in streams | Claude CLI writes `rate_limit_error` to `--debug-file` only, not to stdout/stderr stream-json. CLI emits `result { subtype: 'success', is_error: true }` for 429, same pattern as context exhaustion. Dashboard uses **two-pass debug log scan**: (1) immediate `readFileSync` at process `close` event, (2) deferred 500ms re-scan if immediate scan fails (Windows file lock / flush timing). Deferred detection cancels any in-flight context retry timer and routes to rate limit retry instead. If CLI changes to emit 429 in streams, the stderr/non-JSON detection will catch it first and the debug scan becomes redundant (harmless). |
| Context % with subagents | `cache_read_input_tokens` from Agent tool can exceed `contextWindow`, producing >100%. Capped at 100% in UI; raw values preserved in `tokenUsage`. Subagent assistant events are filtered by `taskDepth > 0` (incremented on `block.name === 'Agent'` tool_use, decremented on matching tool_result). |

### Windows-Specific Constraints

- `shell: false` required (shell:true breaks piping)
- `windowsHide: true` hides console window
- `stdin: 'ignore'` required (pipe causes hang) → solved by Auto Handoff
- `--verbose` must precede `--output-format stream-json`
- `taskkill /F /T /PID` kills entire process tree

### pm2 ForkMode `detached: true` Console Flash (KB5077181)

**Symptom**: `pm2 start/restart` briefly flashes a `C:\Windows\system32` console window.

**Root cause**: Windows 11 KB5077181 (2026-02-11, build 26200.7840) changed how `CREATE_NEW_PROCESS_GROUP` interacts with console-less processes. pm2's God daemon (itself detached, no console) spawns child processes with `detached: true`, which now triggers visible console allocation despite `windowsHide: true` (`CREATE_NO_WINDOW`).

**Fix**: Patch `node_modules/pm2/lib/God/ForkMode.js` line 98: `detached: true` → `detached: false`.

**Tradeoff**: Children share the daemon's process group. If the daemon crashes, children may terminate too. pm2 manages lifecycle individually, so practical impact is minimal.

**Re-apply after**: `npm update -g pm2` (overwrites the patch). Run:
```bash
node tools/feature-dashboard/patch-pm2.js && pm2 kill && pm2 start tools/feature-dashboard/ecosystem.config.cjs
```

### pm2 Restart Port Retention (`detached: false`)

**Symptom**: After Auto-DR or manual `pm2 restart`, old process retains port 3001. New process fails with `EADDRINUSE`. DR button does not light up (browser connects to stale process).

**Root cause**: `server.close()` in SIGINT handler blocks indefinitely when WebSocket clients are connected (no `closeAllConnections()`). pm2's `kill_timeout` (default 1600ms) sends SIGKILL, but on Windows the port isn't released immediately.

**Fix (3-layer defense in `server.js`)**:
1. **Graceful shutdown**: `server.closeAllConnections()` + 1500ms forced exit timeout in SIGINT/SIGTERM handlers
2. **Startup port cleanup**: `cleanupPort(PORT)` kills stale processes on the port before `server.listen()`
3. **EADDRINUSE retry**: `server.on('error')` handler retries once after cleanup

`ecosystem.config.cjs`: `kill_timeout: 3000` (accommodates 1500ms graceful timeout + margin).

### `-p --resume` File Writing (Resolved)

Previously assumed broken, but **works correctly in 2.1.0+**. Tested (2026-02-04):

```bash
claude -p "hello" --verbose --output-format stream-json  # → session_id取得
claude --resume {session_id} -p "write file" ...         # → Write tool成功
```

Root cause: v2.1.0 fixed "files and skills not being properly discovered when resuming sessions with `-c` or `--resume`". Enables orchestrator patterns (Claude spawning Claude via `-p --resume`).

---

## Reference

### Test Coverage (2026-02-14)

| Target | Stmts | Branch | Funcs | Lines | Tests | Goal |
|--------|------:|-------:|------:|------:|------:|:----:|
| Backend | 84.3% | 77.5% | 82.8% | 85.5% | 654 | 80%+ ✓ |
| Frontend | 73.7% | 68.8% | 72.5% | 76.6% | 231 | 75%+ ✓ |

**Backend module coverage**:

| Module | Lines | Tests | Notes |
|--------|------:|------:|-------|
| validation.js | 100% | - | Input validation |
| inputPatterns.js | 100% | - | Input wait patterns |
| phaseUtils.js | 100% | - | Phase detection |
| config.js | 100% | - | Configuration constants |
| timeUtils.js | 100% | 26 | Shared time utilities |
| chainExecutor.js | 100% | 35 | Chain execution |
| ccsUtils.js | 100% | 29 | CCS profile (execSync) |
| featureService.js | 100% | 30 | Feature aggregation |
| usageService.js | 100% | 45 | Usage tracking |
| streamParser.js | 99.4% | - | Stream-json parsing (tested via claudeService) |
| emailService.js | 98.1% | 13 | Email notification |
| statusMailService.js | 94.9% | 57 | IMAP IDLE status mail |
| parsers/ | 93.8% | 64 | Markdown parsing |
| logger.js | 80.5% | 37 | Logging |
| fileWatcher.js | 75.0% | 32 | File watching |
| claudeService.js | 74.3% | 180 | Main logic (delegates to streamParser) |

**Mutation score (Backend)**:

| Metric | Value | Notes |
|--------|------:|-------|
| Overall | 57.7% | killed / total |
| Covered scope | 70.0% | killed / covered |
| Killed | 2,452 | Detected mutants |
| Survived | 1,059 | Escaped mutants |

### Design Decisions

**Context splitting (TreeView.jsx)**: Split into `TreeCallbacksContext` (stable callbacks) and `TreeDataContext` (dynamic data). Callbacks rarely change, so TreeNode memo can skip re-renders when only data changes.

**Dynamic project path**: ExecutionPanel "Copy ID" button fetches `projectRoot` from `/api/health` to generate paths dynamically. Eliminates hardcoded path issues.

**Process termination safety**: `_killProcess()` checks for null pid to prevent taskkill execution with undefined pid.

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

**Email notification (emailService.js)**: Sends Gmail SMTP notifications on terminal handoff and execution completion. Config stored in `email.config.json` (gitignored) with `email.config.example.json` as template. DI: constructor accepts `configLoader` and `transportFactory` for testing. Fire-and-forget: errors logged but never block execution. Triggers: `_handoffToTerminal()` and `_handleCompletion()` in claudeService.js. Setup: copy `email.config.example.json` to `email.config.json`, set `enabled: true`, `user` (Gmail address), `pass` (Gmail app password).

**Status mail service (statusMailService.js)**: IMAP IDLE listener that monitors Gmail inbox for status requests. Trigger: self-sent empty email (no subject, no body). Response: auto-reply with dashboard status report (executions, rate limits, feature summary). IMAP config via `email.config.json` key `statusMail: { enabled, imapHost, imapPort, allowedSenders, reconnectDelayMs }`. Sender whitelist: self + configured `allowedSenders` (case-insensitive). Loop prevention: ignores `Re:` subjects. Reconnects on disconnect with configurable delay. DI: constructor accepts `imapClientFactory` and `transportFactory` for testing.

**Stream parser (streamParser.js)**: Extracted from claudeService.js for separation of concerns. Handles all stream-json output parsing: JSON line parsing, event type dispatch, phase/iteration detection, input wait pattern matching, AskUserQuestion detection, token usage calculation, and context percentage. Uses constructor DI for all callbacks (pushLog, broadcast, broadcastState, handoffToTerminal, handleCompletion). claudeService.js retains wrapper methods for backward compatibility.

**Rate limit capture (ratelimitService.js)**: Captures Claude Code's exact usage percentages by sending the `/usage` slash command via `node-pty` (ConPTY wrapper) + `VtScreenBuffer` (minimal VT terminal emulator). Profile enumeration: runs `ccs auth list` (via `getCcsProfiles()` in `ccsUtils.js`) to get only `[OK]` profiles. **Capture flow per profile**: (1) spawns `claude` via `pty.spawn('cmd.exe', ['/c', 'claude'], { cols: 120, rows: 30, useConptyDll: true })` in headless ConPTY, (2) feeds VT output into `VtScreenBuffer` for TUI detection, (3) detects TUI loaded (status bar `Context:N%`), (4) waits 1.5s for TUI stabilization, (5) types `/usage` then 800ms later creates a clean `VtScreenBuffer` and sends Enter (autocomplete menu settle delay), (6) detects `/usage` output completion (`Esc to cancel` or `Sonnet only` + `%used` pattern), waits 500ms for full render, (7) resolves with captured text (clean buffer preferred, fallback to main buffer). `_parseUsageOutput()` parses positionally: finds section headers (`Current session`, `Current week (all models)`, `Sonnet only`), then maps subsequent `(\d+)%[^\d%]{0,15}used` and `Resets (.+?)(\(|$)` to nearest preceding section. `useConptyDll: true` uses bundled `conpty.dll` + `OpenConsole.exe` to bypass Windows Terminal's default terminal interception. Kills via `pty.kill()` with `taskkill /F /T` fallback. DI: constructor accepts `ptySpawn` for testing. Per-profile cache (`Map<profileName, {data, timestamp, expiresAt}>`), dynamic TTL: `expiresAt` = `min(weekly resetsAt, session resetsAt, sonnet resetsAt, 1 week)`. Triggers: startup (background) + 5min periodic polling + after each command completion (fire-and-forget). FE header shows `{profile} W:XX% S:XX%` with reset times (`↻W:` / `↻S:`) when percent > 75% (yellow >=70%, red pulse >=90%). Sonnet data captured but not displayed in FE (used for auto-switch and rate limit retry logic). Public helpers: `getEarliestResetTime()` returns earliest reset across all profiles (used for timed retry scheduling), `getSafeProfile(excludeProfile)` finds a profile below 90% (used for profile switch retry). Capture time: ~7-10s per profile (TUI startup + autocomplete wait + /usage response). **Cache behavior**: When `/usage` returns data, all three types (session/weekly/sonnet) are stored directly. When capture fails, existing cache is preserved if not expired. Cache persisted to `_out/tmp/dashboard/ratelimit-cache.json` (loaded on startup, saved on every update). Manual injection via `POST /api/ratelimit/:profile` with body `{ weekly: { percent, resetsAt }, session: { percent, resetsAt } }`.

**Auto-switch (ratelimitService.js + server.js)**: Proactive profile switching to prevent 429. `_checkAutoSwitch()` runs after every `capture()` completion. When active profile reaches ≥`AUTO_SWITCH_THRESHOLD` (80%, configurable in `config.js`) on any rate limit type (weekly/session/sonnet) and another profile is below the threshold, fires `onAutoSwitch(safeProfile)` callback. server.js callback validates `safeProfile` against `getCcsProfiles()` (command injection prevention) and runs `ccs auth default "<safeProfile>"` to switch the CCS default. Next spawned claude.exe picks up the new profile via `getCcsProfile()` → `CLAUDE_CONFIG_DIR`. WS event: `auto-switch` with `safeProfile` field.

**Rate limit retry (claudeService.js)**: When an execution hits 429, `_scheduleRateLimitRetry()` attempts recovery before giving up. **Strategy 1 (immediate)**: calls `rateLimitService.getSafeProfile(currentProfile)` to find an alternative profile below 90%. If found, runs `_switchProfile(safeProfile)` (`ccs auth default` with validation) and retries after 5s. **Strategy 2 (timed)**: calls `rateLimitService.getEarliestResetTime()` and schedules a timer at `resetTime + RATE_LIMIT_RETRY_BUFFER_MS` (1min). Sets `_rateLimitPaused = true` (service-level flag) which blocks `_dequeueNext()` to prevent cascading 429 failures. When the timer fires, `_executeRateLimitRetry()` re-captures rate limits, checks if safe (< `RATE_LIMIT_SAFE_THRESHOLD` 95%), and either retries via `_startRateLimitRetry()` or gives up. **Session resume**: `_startRateLimitRetry()` checks if the failed execution has a `sessionId`. If yes, spawns `claude -p "continue" --resume <sessionId>` to preserve conversation context (files already read, patterns already understood — avoids re-reading and re-establishing state). If no sessionId (e.g., 429 hit before session was established), falls back to fresh `executeCommand()`. The resume path creates a new execution with the original command name (not `resume:` prefix) to maintain chain progression compatibility. WS `rate-limit-retry` event includes `resumed: true/false`. Cleanup: `killExecution()` and `killAllRunning()` clear the retry timer and pause flag. `getQueueStatus()` exposes `rateLimitWaiting` state. Email: `account-limit` (with retry schedule), `rate-limit-recovered` (retry succeeded), `rate-limit-exhausted` (retry failed, manual re-run needed).

**Auto-DR (server.js)**: Watches backend source files (`src/**/*.js`, `server.js`) via chokidar with 2s debounce. On file change, checks `claudeService.getQueueStatus()` — if no running/queued executions, triggers `pm2 restart dashboard-backend`. If executions are active, sets `pendingRestart` flag. `claudeService.onExecutionComplete` callback fires after each `_handleCompletion` **and after stale chain waiter cleanup** — triggers deferred restart when queue becomes idle. Broadcasts `auto-dr` WS event 500ms before restart to allow FE notification. Watcher excludes `*.test.js` and `node_modules/`. Graceful shutdown ensures port release: SIGINT/SIGTERM handlers call `server.closeAllConnections()` before `server.close()`, with a 1500ms forced exit fallback. Startup runs `cleanupPort(PORT)` to kill stale processes, with EADDRINUSE retry as final safety net.

**FL incomplete termination detection (claudeService.js)**: When FL exits with code 0 and `resultSubtype === 'success'` but the feature status (from `fileWatcher.statusCache`) is still `[PROPOSED]` instead of `[REVIEWED]`, the chain system detects this as an incomplete termination (context/max_turns exhausted mid-work). Instead of registering a dead chain waiter, it auto-retries FL as a new execution (up to `MAX_FL_RETRIES`, shared counter with FL auto-retry). Skipped when status is `[BLOCKED]` (legitimate FL outcome) or when `fileWatcher` is null (fallback: register waiter normally). WS event: `chain-retry` with `retryType: 'incomplete'`. When retries exhausted: falls through to normal email notification path.

**Deferred y/n handoff (streamParser.js)**: When `checkInputWaitPatterns()` detects a y/n pattern during streaming, it does NOT immediately call `handoffToTerminal()`. Instead, it sets `execution.pendingHandoff = { reason, timestamp }` and starts a 10s fallback timeout (`PENDING_HANDOFF_TIMEOUT_MS`). When the `result` stream event arrives (meaning the CLI has finished and saved the session JSONL), `handleStreamEvent()` checks for `pendingHandoff` and triggers the actual handoff. This ensures the final assistant message (containing the y/n prompt text) is preserved in the session file and visible on `--resume`. If the `result` event never arrives (e.g., CLI blocks), the timeout forces the handoff as a fallback. AskUserQuestion handoffs remain immediate (the incomplete tool_use turn cannot be saved regardless), but the question context is displayed in the terminal via `_writeResumeContext()` which writes `_out/tmp/resume-context.txt` and prefixes the `cmd /k` command with `type`.

**Tmp cleanup (cleanupService.js)**: Purges old files from `_out/tmp/dashboard/` to prevent unbounded disk growth. Targets: per-execution debug logs (`debug-*.log`, 3-day retention), daily rotated logs (`*-YYYY-MM-DD.log`, 7-day retention), term debug logs (`term-*.debug.log`, 7 days), exec artifacts (`exec-*.jsonl/sh`, 7 days). Runs initial purge on startup + every 6 hours (`TMP_CLEANUP_INTERVAL_MS`). Protected files (never deleted): `ratelimit-cache.json`, `sessions.json`, `latest` symlink, `logs/` directory. Uses regex pattern matching + `fs.stat` mtime comparison. Errors on individual files are logged but never crash the service. Logs summary with file count and MB freed.

**Browser refresh resilience**: State is split into backend-authoritative and frontend-only. Backend stores: execution objects (process, logs, phase, context%, tokenUsage — in-memory Map, 1h TTL), shell command results (`shellStates` Map — persisted in memory, exposed via `/api/health`), rate limit cache (persisted to disk). Frontend stores: UI interaction state (selected tab, panel visibility, notifications). On browser F5: (1) `fetchExecutions()` rehydrates `executions` + `executionStates` + `featurePhases` from `GET /api/execution` + logs API, (2) `checkHealth(true)` restores `shellStates` button colors and triggers background rate limit `capture({ forceRefresh: true })` via `?refresh=1` query param, (3) health poll at 8s/30s picks up fresh rate limit data. WS `shell-complete` and `state` events continue to provide real-time updates after rehydration.

**Three distinct "limit" concepts** — the word "session" appears in two unrelated contexts:

| Concept | What it means | Retryable | Detection |
|---------|--------------|-----------|-----------|
| **Conversation context** exhaustion | Single `-p` session's token window is full | Yes (3x, fresh session) | `error_max_turns`, `max_tokens`, `promptTooLong`, `exitCode≠0 && subtype=success && !accountLimitHit`, `exitCode===3 && !subtype` (max turns) |
| **CCS session** rate limit | Profile's per-session API quota (hours) | **Yes** (all executions) | `accountLimitHit` flag (429 `rate_limit_error`) |
| **CCS weekly** rate limit | Profile's weekly API quota | **Yes** (all executions) | Same `accountLimitHit` flag |

Detection: (1) stderr regex `/hit your limit|rate_limit_error|exceed your (organization|account)('s|s)? rate limit/i`, (2) non-JSON stdout regex (same), (3) **two-pass debug log tail scan** — reads last 16KB of `--debug-file` for `rate_limit_error` or `429.*rate.?limit` (16KB because CLI writes hooks/telemetry/session-save after 429, pushing the error >4KB from EOF in long sessions). Pass 1: immediate scan at process `close` event. Pass 2: deferred 500ms re-scan if Pass 1 missed (Windows file lock/flush timing — CLI may still hold the debug file handle when Node.js `close` fires). Deferred detection cancels in-flight `_contextRetryTimer` (RETRY_DELAY_MS=5s > 500ms, so timer hasn't fired yet) and routes to `_scheduleRateLimitRetry()` instead. Errors in scan are logged to `claudeLog.debug` (previously silent `catch{}`). Guards in `needsContextRetry` and `flWantsRetry` block all retries when `accountLimitHit` is true. The `exitCode≠0 && subtype=success` context heuristic is guarded by `!accountLimitHit` — if the debug log scan promotes a short-lived 429 to `accountLimitHit`, it no longer triggers context retry. **Rate limit retry** (all executions — chain gate removed): `_scheduleRateLimitRetry()` attempts (1) profile switch to safe profile (immediate retry), or (2) timed retry at earliest `resetsAt` + 1min buffer. Sets `_rateLimitPaused` to block queue dequeue. Re-captures rate limits before retry; gives up if still ≥95%. Email subjects: `account-limit` (429, with retry schedule), `rate-limit-recovered` (retry succeeded), `rate-limit-exhausted` (retry failed), `context-limit N/3` (context exhausted), `fl-retry N/3` (FL retries exhausted). Email result is derived from chain history's last entry (single source from claudeService), not re-computed in emailService.

**Session ID persistence (claudeService.js)**: Session IDs are persisted to `_out/tmp/dashboard/sessions.json` on completion and handoff. The in-memory `sessions.json` map is loaded on startup and pruned (entries older than 7 days are removed on each save). When `resumeInBrowser()` or `resumeInTerminal()` cannot find the execution in the in-memory Map (evicted by 1h TTL), it falls back to `_lookupSessionId()` which reads from the persistent map. This enables resume hours or days after execution without increasing `EXECUTION_TTL_MS`. Cleanup service should add `sessions.json` to the protected files list (already excluded by pattern — only `debug-*.log` and `*-YYYY-MM-DD.log` are targeted).

**Context percent cap (streamParser.js)**: `contextPercent` is capped at 100%. Subagent-heavy executions (`/run` with many Task tool invocations) can report cumulative `cache_read_input_tokens` that exceed the single-session context window, producing misleading values like 1015% or 4383%. The cap prevents UI confusion while preserving the raw token counts in `tokenUsage` for debugging.

---

## Future Work

### Repository Separation

The dashboard has grown into a standalone web application (650+ backend tests, 230+ frontend tests, 12+ service modules) and should eventually be extracted into its own repository. The main coupling points are:

- **`projectRoot` hardcoding**: `featureParser`, `fileWatcher`, and `logger.js` resolve paths relative to the parent project. Replace with a `PROJECT_ROOT` environment variable in `config.js`.
- **`_out/tmp/dashboard/` log output**: `logger.js` resolves the project root by traversing 5 directory levels. Should use `PROJECT_ROOT` instead.
- **`patch-pm2.js` location**: Currently at project root `tools/feature-dashboard/`. Move into the dashboard repo.

**Preparation steps** (can be done incrementally before separation):
1. Add `PROJECT_ROOT` env var to `config.js`, default to current path resolution for backward compatibility
2. Replace all hardcoded path traversals with the config value
3. Verify all tests pass with an explicit `PROJECT_ROOT` setting

**Trigger**: Extract when a second project needs the dashboard, or when the dashboard's commit volume justifies independent history.

### Terminal Handoff Reduction

Since `-p --resume` works in v2.1.0+, many terminal handoff scenarios can be handled in-browser via `resumeInBrowser()`. This eliminates the need for `wt.exe` in most cases.

**Completed**:
- [x] Rate limit (429): `_startRateLimitRetry()` uses `--resume` when sessionId available, preserving conversation context

**TODO**:
- [ ] y/n prompts: Show Y/N buttons in ExecutionPanel on `input-wait` WS event → `resumeInBrowser(id, 'y'|'n')`
- [ ] AskUserQuestion: Show options in ExecutionPanel on `input-required` WS event → `resumeInBrowser(id, selectedOption)`
- [ ] Terminal handoff becomes opt-in only (user explicitly wants interactive shell)
