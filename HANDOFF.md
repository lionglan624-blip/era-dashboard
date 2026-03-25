# Feature Dashboard

A browser-based dashboard for managing Claude Code feature workflows with automatic chain execution.

> **For Claude (orchestrator)**: This file is both documentation and a change checklist.
> When modifying dashboard code, follow the **Orchestrator Workflow** below.
>
> **Source of truth**: `C:\Era\dashboard\` (independent git repo).
> All file creation and edits MUST target `C:\Era\dashboard\`.

### Orchestrator Workflow

1. **Identify affected files**: Use the Adding Features table to determine which files to modify
2. **Implement**
3. **Verify**: Start with `npm start` and confirm behavior in browser
4. **Test**: Run `npm test` (backend + frontend)
5. **Update coverage & mutation scores**: Update figures in [OPS.md](OPS.md) Test Coverage section
6. **Update docs**: Update affected sections in HANDOFF.md, [INTERNALS.md](INTERNALS.md), or [OPS.md](OPS.md)
7. **Commit**

> **WARNING: Before `pm2 restart` or `dr`**: Check for running Claude executions via
> `GET /api/health` → `claude.runningCount`. Restarting kills all child PTY processes
> (active `/run`, `/fl`, `/fc` sessions). If executions are running, either wait for
> completion or warn the user before restarting.
>
> **NEVER use `pm2 delete all` or restart the proxy.** The proxy carries the active Claude Code
> session — killing it severs the conversation with no recovery. DR button and auto-DR use
> `process.exit(0)` + PM2 `autorestart` (with `restart_delay: 5s`) — NOT `pm2 restart`, which
> causes port cleanup cascades on Windows.

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
npm start                                   # backend:3001 + frontend:5173

# Test (run from dashboard root)
npm test                                    # both backend & frontend
npx vitest run                              # both (via vitest.workspace.js)
npm run test:mutation --workspace=backend    # backend mutation testing (incremental: changed files only)

# Restart (from dashboard UI)
dr button                                   # process.exit(0) → PM2 autorestart (5s delay)
```

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

See [INTERNALS.md — Execution Behavior Details](INTERNALS.md#execution-behavior-details) for detailed retry logic, detection mechanisms, and slot management.

Full config: `backend/src/config.js`

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/execution/{fc,fl,run,imp}` | POST | Execute command |
| `/api/execution/terminal` | POST | Open terminal |
| `/api/execution/shell` | POST | Run cs, dr, upd |
| `/api/execution/slash` | POST | Run /commit, /sync-deps |
| `/api/execution/debug` | POST | Run arbitrary prompt (requires `.debug-enabled` file gate, 30-min TTL). Body: `{ "prompt": "..." }` |
| `/api/execution/:id/resume/{browser,terminal}` | POST | Resume session |
| `/api/execution/:id/answer` | POST | Answer input prompt in browser (y/n or AskUserQuestion option) |
| `/api/execution/:id/chain-cut` | POST | Stop chain progression after current command finishes. 409 if already requested, 400 if not chain |
| `/api/execution/:id` | GET | Execution status |
| `/api/execution/:id/logs` | GET | Execution logs (with offset) |
| `/api/execution/:id` | DELETE | Stop execution |
| `/api/execution/history` | GET | Persistent execution history (JSONL, 30-day, survives DR/reload). Fields: executionId, featureId, command, status, exitCode, sessionId, startedAt, completedAt, contextPercent, ccsProfile, resultSubtype, killedByUser, tokenUsage |
| `/api/execution/history` | DELETE | Clear execution history (test support) |
| `/api/execution/status` | GET | Consolidated dashboard state: active executions (running+queued), active features (not [DONE]/[CANCELLED]/RC), queue summary, runLockFeatureId. Designed for single-curl Claude Code queries |
| `/api/execution` | GET | List all executions |
| `/api/ratelimit/:profile` | POST | Manual rate limit cache injection |
| `/api/execution/queue` | GET | Queue status (includes `chainSlotHolders` with execution details, `runLockFeatureId`) |
| `/api/execution/run-lock` | POST | Manually acquire run-lock (DR recovery) |
| `/api/execution/queue/clear` | POST | Clear queued items |
| `/api/execution/queue/bulk` | POST | Bulk queue features |
| `/api/features` | GET | List features |
| `/api/features/:id` | GET | Feature detail |
| `/api/health` | GET | Health check |
| `/api/insights/capture` | POST | Trigger `/insights` capture (fire-and-forget). Body: `{ sendEmail: bool }` (default true). Returns 409 if already running |
| `/api/insights/status` | GET | Check capture status: `{ running, lastResult }` |
| `/api/update/status` | GET | Claude Code update watcher status: `{ version, analyzing }` |
| `/api/deps/trigger` | POST | Trigger dependency update tier. Body: `{ tier: 'daily'\|'weekly'\|'monthly'\|'all' }`. Returns 409 if tier already running |
| `/api/deps/status` | GET | Dependency updater status: per-tier `{ running, scheduled, lastRun }` |

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
| `account-limit` | S→C (all) | Anthropic account rate limit hit (429 detected) |
| `chain-cut` | S→C (all) | Chain-cut requested (featureId, command, executionId) |
| `chain-blocked` | S→C (all) | Chain blocked by pending deps (emitted from `bulkQueue()` for dep-blocked items) |
| `features-updated` | S→C (all) | Feature file changed |
| `status-changed` | S→C (all) | Feature status changed (e.g., [DRAFT]→[PROPOSED]) |
| `queue-updated` | S→C (all) | Queue state changed. Queued items include `depBlocked` and `pendingDeps` fields. FE also fetches `GET /api/execution/queue` on connect to restore state after F5 |
| `execution-started` | S→C (all) | New execution started (API-spawned slash/debug). FE auto-subscribes |
| `upd-complete` | S→C (all) | CCS update completed |
| `shell-complete` | S→C (all) | Shell command (cs/dr/upd) completed |
| `auto-dr` | S→C (all) | Backend auto-restarting (file change detected) |
| `auto-dr-pending` | S→C (all) | Backend restart deferred (executions/chain active) |
| `claude-code-update` | S→C (all) | Claude Code release detected (version, impact, summary) |
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
  + Input answer buttons         + answerInBrowser()

                                      ↓ (Browser Answer)
                                 claude -p "answer" --resume <sessionId>
                                 (or: wt.exe --resume via Terminal fallback)
```

### Chain Execution Flow

```
[DRAFT] → fc → [PROPOSED] → fl → [REVIEWED] → run → [DONE] → imp → [DONE]
```

**Stop conditions**: Error, Handoff, [BLOCKED], [DRAFT] after FL (fc_rerun), User kill, Chain-cut

### Input Handling (Browser-First)

Since `stdin: 'ignore'` prevents user input, the dashboard detects input prompts and shows interactive UI in the browser ExecutionPanel. Terminal handoff is a user-initiated fallback.

**Detection triggers**:
- **y/n patterns**: `(y/n)`, `[Y/n]`, `Continue?`, `Proceed?` → Yes/No buttons in ExecutionPanel
- **AskUserQuestion** tool_use → Clickable option buttons in ExecutionPanel
- Normal completion with output ending in `?` → Terminal handoff (only when not already waiting for input)

**Browser answer flow**:

```
1. Pattern/AskUserQuestion detected → broadcast input-wait / input-required WS event
2. FE shows answer buttons (Yes/No or option list) + "Terminal" fallback button
3a. User clicks answer → POST /api/execution/:id/answer { answer }
    → answerInBrowser() kills process, resumes with -p "answer" --resume <sessionId>
3b. User clicks "Terminal" → POST /api/execution/:id/resume/terminal
    → Opens wt.exe --resume (old behavior)
```

> See [INTERNALS.md](INTERNALS.md) "Browser-First Input Handling" for detailed y/n and AskUserQuestion flows, session preservation, and revert instructions.

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
vitest.config.js                 # Root Vitest config (references backend + frontend configs)

backend/
├── vitest.config.js             # Backend Vitest config (node environment)
├── server.js                    # Express setup, service wiring
├── send-email.mjs               # CLI email sender (used by Claude Code)
├── email.config.example.json    # Email config template
├── src/
│   ├── config.js                # Constants (timeouts, proxy, CCS)
│   ├── routes/
│   │   ├── execution.js         # /api/execution/* endpoints
│   │   └── features.js          # /api/features/*
│   ├── services/
│   │   ├── claudeService.js     # claude.exe spawn, Auto Handoff, completion logic, execution history (JSONL)
│   │   ├── streamParser.js      # stream-json parsing, state detection (extracted from claudeService)
│   │   ├── chainExecutor.js     # Chain execution (fc→fl→run)
│   │   ├── ccsUtils.js          # CCS profile reading (config.yaml, auth list)
│   │   ├── ratelimitService.js  # Rate limit capture (fork worker for production, in-process DI for tests)
│   │   ├── vtScreenBuffer.js   # VT terminal emulator (screen buffer from escape sequences)
│   │   ├── featureService.js    # feature-{ID}.md reading, pendingDeps
│   │   ├── fileWatcher.js       # chokidar watch, status change detection
│   │   ├── statusMailService.js # IMAP IDLE status mail (auto-reply to empty emails)
│   │   ├── updateWatcherService.js # Claude Code release detection + impact analysis
│   │   ├── emailService.js      # Email notification (handoff/completion)
│   │   ├── cleanupService.js     # Tmp file cleanup (debug logs, daily logs, artifacts, history JSONL pruning)
│   │   ├── insightsService.js   # /insights PTY capture + email report (weekly scheduler)
│   │   ├── usageService.js      # CCS usage tracking (not exposed via API)
│   │   ├── inputPatterns.js     # Input wait patterns
│   │   ├── phaseUtils.js        # Phase detection utilities
│   │   ├── validation.js        # Input validation
│   │   └── workers/
│   │       └── ptyCapture.js   # Forked worker: node-pty ConPTY capture (crash-isolated from main process)
│   ├── parsers/
│   │   ├── featureParser.js     # Feature markdown parsing
│   │   └── indexParser.js       # index-features.md parsing
│   ├── websocket/
│   │   └── logStreamer.js       # WebSocket broadcast (sub/all)
│   └── utils/
│       ├── exitCodes.js         # Windows NTSTATUS exit code decoder
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
│   │   ├── ExecutionPanel.jsx   # Log display, Resume/Stop buttons, tabs, History toggle
│   │   ├── HistoryView.jsx     # Persistent execution history list (Copy ID, Resume)
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

### Security

All user input is whitelist-validated before passing to spawn:

| Function | Validation |
|----------|------------|
| `validateFeatureId()` | Numeric only (`/^\d+$/`) |
| `validateCommand()` | `fc`, `fl`, `run`, `imp` only |
| `runShellCommand()` | `cs`, `dr`, `upd` only |
| `executeSlashCommand()` | `commit`, `sync-deps` only. Queue bypass (slot-exempt) |
| `answerInBrowser()` | `sanitizeInput(answer, 1000)` — control chars stripped, 1000 char limit |
| `bulkQueue()` | Array of numeric IDs, max 30, deduplicated |

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

## Known Issues

### Claude Code proxy bypass required

Claude Code's Bash environment has `HTTP_PROXY=http://127.0.0.1:8888` set (CCS proxy). `curl` to Dashboard API (`localhost:3001`) routes through the proxy, which rejects HTTP GET (CONNECT-only proxy).

```bash
# NG — routed through proxy, fails
curl http://localhost:3001/api/health

# OK — bypass proxy
curl --noproxy localhost http://localhost:3001/api/health
```

**Background**: On 2026-03-17, the dashboard was running but reported as "not reachable". The proxy responded with `"This proxy only supports CONNECT method for HTTPS"`, which caused JSON parse failure and a misleading fallback message.

### Chain slot re-reservation ordering bug in `_dequeueNext()` — FIXED

In `_dequeueNext()` (`claudeService.js`), executions whose chain slot was released due to dep-blocking were treated as non-chain after deps resolved, making them unable to start under the reduced `maxConcurrent - idleChainSlots` limit.

**Cause**: `_belongsToActiveChain()` returned false for chain roots without an active chain slot.
**Fix**: `_belongsToActiveChain()` now always returns true for chain roots (`!exec.chainParentId`). Chain children still check parent slot status as before.

---

## See Also

- [INTERNALS.md](INTERNALS.md) — Design decisions, detailed flows (rate limit, input handling, retry logic)
- [OPS.md](OPS.md) — Platform requirements, pm2, CCS profile setup, debugging, coverage stats
