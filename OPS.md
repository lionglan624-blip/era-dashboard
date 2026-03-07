# Feature Dashboard — Operations

Platform setup, infrastructure, and maintenance. Read [HANDOFF.md](HANDOFF.md) first.

---

## Platform Requirements

**Windows + Windows Terminal required**

| Requirement | Reason |
|-------------|--------|
| Windows 10/11 | `taskkill` command, path separators |
| Windows Terminal (`wt.exe`) | Auto Handoff, Resume features |
| Node.js 18+ | ES Modules, fs/promises |

Linux/macOS: Limited support. Process termination (`SIGTERM`) works, but Terminal integration (`wt.exe`) does not.

## Infrastructure

**pm2**:
```bash
cd src/tools/node/feature-dashboard && pm2 start ecosystem.config.cjs    # proxy(8888) + backend(3001) + frontend(5173)
pm2 save                          # Persist
```

> **Caution**: `pm2 restart` kills all child processes including active Claude sessions.
> Always verify no executions are running: `curl --noproxy localhost http://localhost:3001/api/health | jq '.claude.runningCount'`
>
> **CRITICAL: NEVER `pm2 delete` or restart the proxy process.** The proxy (port 8888) handles the
> active Claude Code session's API connection. Killing it severs the current conversation immediately
> with no recovery. Use `pm2 restart dashboard-backend` (NOT `pm2 restart all` or `pm2 delete all`)
> when only the backend needs restarting. If a full restart is truly needed, warn the user first.

## CCS Profile

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

**`/resume` behavior**: Lists sessions from `projects/{slug}/` JSONL scan (filtered by current working directory). Shared projects means sessions created in any profile are visible from all profiles in the same context group — confirmed working for apple <-> google <-> proton (2026-02-28). **Important**: `{slug}` is derived from the CWD (`slugify(cwd)`), so sessions created from a different CWD (e.g., `C:\Users\siihe` → `C--Users-siihe`) appear only in "show all projects" view, not in the default `/resume` list. This is Claude Code behavior, not a CCS limitation.

**Cross-profile session resume**: Rate limit retry (`_startRateLimitRetry`) switches profile via `ccs auth default`, then spawns `claude --resume <sessionId>`. Since all profiles' `projects/` JUNCTIONs resolve to the same shared directory, the sessionId is accessible regardless of which profile resumes it. Verified via code path: `_switchProfile()` → `_buildClaudeEnv()` reads new default → `CLAUDE_CONFIG_DIR` points to new profile → JUNCTION → same shared JSONL.

**Do NOT manually symlink `projects/`** — use CCS `--share-context` instead. Manual symlinks bypass the security check and break session loading.

**Diagnostic tool**: `~/.local/bin/ccs-symlink-test.bat` — dead man's switch for testing projects/ symlink changes. Auto-reverts after timeout. See script for usage.

## Proxy

`127.0.0.1:8888` - Auto-injected via `_buildClaudeEnv()` as `HTTPS_PROXY`/`HTTP_PROXY`.

## Debugging

```bash
DASHBOARD_DEBUG=1 npm start    # Verbose logging (spawn args, non-JSON stream lines, Task tool depth)
```

**Debug endpoint activation** (separate from verbose logging):
```bash
# Claude: Write(_out/tmp/dashboard/.debug-enabled) with any content
# Manual: echo 1 > _out/tmp/dashboard/.debug-enabled
# TTL: 30 minutes from file mtime. Expired files auto-deleted on next request.
```

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
| `execution-history.jsonl` | `_out/tmp/dashboard/` | Persistent execution history (append-only JSONL, 7-day retention, pruned by cleanupService) |
| Session JSONL | `~/.ccs/instances/{profile}/projects/{project}/` | Claude conversation history (token usage, messages) |

Backend logs rotate automatically at midnight (UTC). Session JSONL files are managed by CCS.

## Restart Matrix

| Change | Backend restart | Frontend restart |
|--------|:---------------:|:----------------:|
| backend/*.js | Auto-DR | Not required |
| frontend/*.jsx | Not required | Auto (HMR) |
| HANDOFF.md only | Not required | Not required |

**Auto-DR (Auto Dashboard Restart)**: Watches backend source files (`src/**/*.js`, `server.js`, excludes `*.test.js`, `node_modules/`) via chokidar with 2s debounce.
- On change: checks `claudeService.getQueueStatus()` → if idle, `pm2 restart dashboard-backend`
- If executions/chain waiters active: sets `pendingRestart` flag, deferred until all complete
- `onExecutionComplete` callback (after `_handleCompletion` **and** stale chain waiter cleanup) triggers deferred restart when queue becomes idle
- Broadcasts `auto-dr` WS event 500ms before restart; `auto-dr-pending` when deferred (FE shows DR button pulse)
- Graceful shutdown: `server.closeAllConnections()` → `server.close()` → 1500ms forced exit fallback
- Startup: `cleanupPort(PORT)` + EADDRINUSE retry safety net
- Config: `AUTO_DR_DEBOUNCE_MS` in `config.js`

**Manual restart methods**:
- Dashboard UI `dr` button (pm2 restart all)
- `pm2 restart dashboard-backend` / `pm2 restart dashboard-frontend`

**CAUTION**: Manual `dr` does NOT check for running executions. Before manual restart, confirm no Claude child processes are running (`tasklist | findstr claude`). Backend restart kills the Express server but orphans spawned `claude.exe` processes — they lose their parent and completion/handoff/email callbacks never fire. Auto-DR handles this automatically.

## pm2 ForkMode `detached: true` Console Flash (KB5077181)

**Symptom**: `pm2 start/restart` briefly flashes a `C:\Windows\system32` console window.

**Root cause**: Windows 11 KB5077181 (2026-02-11, build 26200.7840) changed how `CREATE_NEW_PROCESS_GROUP` interacts with console-less processes. pm2's God daemon (itself detached, no console) spawns child processes with `detached: true`, which now triggers visible console allocation despite `windowsHide: true` (`CREATE_NO_WINDOW`).

**Fix**: Patch `node_modules/pm2/lib/God/ForkMode.js` line 98: `detached: true` → `detached: false`.

**Tradeoff**: Children share the daemon's process group. If the daemon crashes, children may terminate too. pm2 manages lifecycle individually, so practical impact is minimal.

**Re-apply after**: `npm update -g pm2` (overwrites the patch). Run:
```bash
node src/tools/node/feature-dashboard/patch-pm2.js && pm2 kill && cd src/tools/node/feature-dashboard && pm2 start ecosystem.config.cjs
```

## pm2 Restart Port Retention (`detached: false`)

**Symptom**: After Auto-DR or manual `pm2 restart`, old process retains port 3001. New process fails with `EADDRINUSE`. DR button does not light up (browser connects to stale process).

**Root cause**: `pm2 restart` sends SIGTERM to the old process and starts a new one **simultaneously**. On Windows, port release lags process death. The new process hits EADDRINUSE because the old one hasn't released port 3001 yet. See `docs/architecture/infrastructure/dr-restart-investigation.md` for the full investigation log.

**Fix (2026-03-03 VBScript delegation → 2026-03-07 pm2 restart直接化)**:

Auto-DR and DR button use `pm2 restart` directly. EADDRINUSE is handled by server.js polling retry with adaptive delay (500ms → 2s) and last-resort `cleanupPort()` after 10s.

**Defense layers in `server.js`**:
1. **Graceful shutdown**: `server.closeAllConnections()` + 1500ms forced exit timeout in SIGINT/SIGTERM handlers
2. **EADDRINUSE polling**: On port conflict, poll with adaptive delay (500ms → 2s) without crashing. Never `process.exit(1)` on EADDRINUSE.
3. **Last-resort cleanup**: `cleanupPort(PORT)` after 10s of polling, kills whatever holds the port

`ecosystem.config.cjs`: `kill_timeout: 3000` + `exp_backoff_restart_delay: 200`.

---

## Test Coverage (2026-03-04)

| Target | Stmts | Branch | Funcs | Lines | Tests | Goal |
|--------|------:|-------:|------:|------:|------:|:----:|
| Backend | 79.4% | 75.8% | 76.9% | 79.4% | 894 | 80%+ |
| Frontend | - | - | - | - | 231 | 75%+ |

> Backend coverage dropped from 84→79% due to new code (F813 phases); test count grew 654→894.
> Frontend coverage unavailable due to 2 pre-existing test failures in ExecutionPanel.test.jsx.

**Backend module coverage**:

| Module | Lines | Tests | Notes |
|--------|------:|------:|-------|
| validation.js | 100% | - | Input validation |
| inputPatterns.js | 100% | - | Input wait patterns |
| phaseUtils.js | 100% | - | Phase detection |
| config.js | 100% | - | Configuration constants |
| timeUtils.js | 100% | 26 | Shared time utilities |
| logStreamer.js | 100% | - | WebSocket broadcast |
| chainExecutor.js | 100% | 35 | Chain execution |
| ccsUtils.js | 100% | 29 | CCS profile (execSync) |
| featureService.js | 100% | 30 | Feature aggregation |
| usageService.js | 100% | 45 | Usage tracking |
| streamParser.js | 98.7% | - | Stream-json parsing (tested via claudeService) |
| cleanupService.js | 94.7% | - | Tmp file cleanup |
| statusMailService.js | 94.9% | 57 | IMAP IDLE status mail |
| parsers/ | 94.0% | 64 | Markdown parsing |
| ratelimitService.js | 90.7% | - | Rate limit capture |
| emailService.js | 81.3% | 13 | Email notification |
| logger.js | 80.5% | 37 | Logging |
| fileWatcher.js | 75.0% | 32 | File watching |
| execution.js | 62.5% | - | Routes (many paths untested) |
| claudeService.js | 57.8% | 180 | Main logic (grew significantly) |

## Mutation Score (Backend)

| Metric | Value | Notes |
|--------|------:|-------|
| Overall | 57.7% | killed / total |
| Covered scope | 70.0% | killed / covered |
| Killed | 2,452 | Detected mutants |
| Survived | 1,059 | Escaped mutants |
