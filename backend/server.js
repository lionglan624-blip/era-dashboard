import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { execSync, spawn } from 'child_process';
import chokidar from 'chokidar';

import { FeatureService } from './src/services/featureService.js';
import { ClaudeService } from './src/services/claudeService.js';
import { FileWatcher } from './src/services/fileWatcher.js';
import { LogStreamer } from './src/websocket/logStreamer.js';
import { RateLimitService } from './src/services/ratelimitService.js';
import { StatusMailService } from './src/services/statusMailService.js';
import { UpdateWatcherService } from './src/services/updateWatcherService.js';
import { SmokeTestService } from './src/services/smokeTestService.js';
import { InsightsService } from './src/services/insightsService.js';
import { CleanupService } from './src/services/cleanupService.js';
import { ClaudeStatusService } from './src/services/claudeStatusService.js';
import { DependencyUpdaterService } from './src/services/dependencyUpdaterService.js';
import { EmailService } from './src/services/emailService.js';
import { getCcsProfiles } from './src/services/ccsUtils.js';
import { createFeaturesRouter } from './src/routes/features.js';
import { createExecutionRouter } from './src/routes/execution.js';
import { createDepsRouter } from './src/routes/deps.js';
import { serverLog, LOG_DIR, flushAll } from './src/utils/logger.js';
import { decodeExitCode } from './src/utils/exitCodes.js';
import { exitWithPm2Update } from './src/utils/exitHelpers.js';
import {
  RATE_LIMIT_POLL_INTERVAL_MS,
  AUTO_DR_DEBOUNCE_MS,
  AUTO_DR_STARTUP_COOLDOWN_MS,
  HEALTH_METRICS_INTERVAL_MS,
  UPDATE_ENABLED,
} from './src/config.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..');
const PORT = parseInt(process.env.PORT || '3001');
const EXIT_MARKER_PATH = path.join(LOG_DIR, '..', 'last-exit.json');

function writeExitMarker(reason, extra = {}) {
  try {
    const mem = process.memoryUsage();
    let handles = null;
    let requests = null;
    try {
      handles = process._getActiveHandles?.()?.length ?? null;
      requests = process._getActiveRequests?.()?.length ?? null;
    } catch {
      /* undocumented API */
    }
    const data = {
      reason,
      pid: process.pid,
      timestamp: new Date().toISOString(),
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
        heapTotalMB: Math.round(mem.heapTotal / 1048576),
        rssMB: Math.round(mem.rss / 1048576),
      },
      handles,
      requests,
      uptimeSeconds: Math.round(process.uptime()),
      ...extra,
    };
    fs.writeFileSync(EXIT_MARKER_PATH, JSON.stringify(data, null, 2));
  } catch {
    /* best-effort */
  }
}

function readExitMarker() {
  try {
    const raw = fs.readFileSync(EXIT_MARKER_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (data.reason === 'running') {
      // Previous process was hard-killed (TerminateProcess — no exit handler ran)
      serverLog.info(
        `Previous exit (hard-kill): pid=${data.pid}, started=${data.timestamp}, heap=${data.memory?.heapUsedMB}/${data.memory?.heapTotalMB}MB, handles=${data.handles}, uptime=${data.uptimeSeconds}s`,
      );
    } else {
      serverLog.info(
        `Previous exit (self-reported): reason=${data.reason}, pid=${data.pid}, at=${data.timestamp}, heap=${data.memory?.heapUsedMB}/${data.memory?.heapTotalMB}MB, handles=${data.handles}, uptime=${data.uptimeSeconds}s`,
      );
    }
  } catch {
    /* no marker or corrupt */
  }
}

// Resolve claude CLI path
if (!process.env.CLAUDE_PATH) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  process.env.CLAUDE_PATH = path.join(home, '.local', 'bin', 'claude.exe');
}

serverLog.info(`=== Dashboard Backend Starting ===`);
serverLog.info(`Project root: ${PROJECT_ROOT}`);
serverLog.info(`Log directory: ${LOG_DIR}`);
serverLog.info(`Node version: ${process.version}`);
serverLog.info(`PID: ${process.pid}`);

try {
  const pm2Log = path.join(process.env.USERPROFILE || process.env.HOME || '', '.pm2', 'pm2.log');
  const tail = fs.readFileSync(pm2Log, 'utf8').split('\n').slice(-200);
  const exitLine = tail
    .reverse()
    .find((l) => l.includes('dashboard-backend') && l.includes('exited with code'));
  if (exitLine) {
    const codeMatch = exitLine.match(/exited with code \[(\d+)\]/);
    const sigMatch = exitLine.match(/via signal \[(\w+)\]/);
    const tsMatch = exitLine.match(/^([\d\-T:.]+):/);
    const code = codeMatch ? parseInt(codeMatch[1]) : null;
    const decoded = code !== null ? decodeExitCode(code) : 'unknown';
    serverLog.info(
      `Previous exit: code=${code} (${decoded}), signal=${sigMatch?.[1] || 'none'}, at=${tsMatch?.[1] || '?'}`,
    );
  }
} catch {
  /* PM2 log not available */
}

readExitMarker();
writeExitMarker('running'); // Sentinel: overwritten at exit if handler fires; stays 'running' on hard kill

// Services
const logStreamer = new LogStreamer();
const featureService = new FeatureService(PROJECT_ROOT);
const claudeService = new ClaudeService(PROJECT_ROOT, logStreamer);
const fileWatcher = new FileWatcher(PROJECT_ROOT, featureService, logStreamer);
const rateLimitService = new RateLimitService(PROJECT_ROOT, {
  getProfiles: getCcsProfiles,
  getActiveProfile: () => claudeService.getCcsProfile(),
  isProfileActive: (profile) => {
    const executions = claudeService.executions;
    for (const exec of executions.values()) {
      if (exec.status === 'running' && exec.ccsProfile === profile) return true;
    }
    for (const qId of claudeService.queue) {
      const exec = executions.get(qId);
      if (exec && exec.ccsProfile === profile) return true;
    }
    for (const [, waiter] of claudeService.chainExecutor.chainWaiters) {
      const exec = executions.get(waiter.executionId);
      if (exec && exec.ccsProfile === profile) return true;
    }
    return false;
  },
  onAutoSwitch: (safeProfile) => {
    // Validate profile name against known profiles to prevent command injection
    const profiles = getCcsProfiles();
    if (!profiles.includes(safeProfile)) {
      serverLog.error(`[Auto-Switch] Unknown profile: ${safeProfile}`);
      return;
    }
    try {
      execSync(`ccs auth default "${safeProfile}"`, {
        timeout: 5000,
        encoding: 'utf8',
        windowsHide: true,
        shell: true,
      });
      serverLog.info(`[Auto-Switch] Switched to ${safeProfile}`);
    } catch (err) {
      serverLog.error(`[Auto-Switch] Failed to switch to ${safeProfile}: ${err.message}`);
    }
    logStreamer.broadcastAll({
      type: 'auto-switch',
      safeProfile,
      line: `[Auto-Switch] Rate limit ≥90% on active profile, switched to ${safeProfile}`,
      level: 'info',
      timestamp: new Date().toISOString(),
    });
    // Shorten refresh intervals after profile switch (new profile may need sooner refresh)
    rateLimitService.recomputeRefreshTimes();
  },
});

const emailService = claudeService.emailService || new EmailService();
const insightsService = new InsightsService(PROJECT_ROOT, {
  getActiveProfile: () => claudeService.getCcsProfile(),
  emailService,
});

// Wire fileWatcher status changes to claudeService for chain execution (fc→fl→run)
fileWatcher.onStatusChanged = (featureId, oldStatus, newStatus) => {
  claudeService.handleFeatureStatusChanged(featureId, oldStatus, newStatus);
};

// Provide fileWatcher reference to claudeService for chain race condition fix
// (allows checking current status when registering chain waiter)
claudeService.fileWatcher = fileWatcher;

// Provide rateLimitService to claudeService for 429 per-profile capture and refresh time recompute
claudeService.rateLimitService = rateLimitService;

// Provide featureService to claudeService for email notifications
claudeService.featureService = featureService;

// Wire fileWatcher features-updated to claudeService for dep-aware dequeue
fileWatcher.onFeaturesUpdated = () => {
  claudeService._dequeueNext();
};

// Status mail service (IMAP IDLE - replies to empty self-sent emails with dashboard status)
const statusMailService = new StatusMailService({
  featureService,
  claudeService,
  rateLimitService,
});

// Update watcher (Claude Code release detection + impact analysis via claudeService execution)
const smokeTestService = new SmokeTestService({
  emailService,
  logStreamer,
  rateLimitService,
  claudeService,
});
const updateWatcherService = new UpdateWatcherService({
  emailService,
  logStreamer,
  claudeService,
  smokeTestService,
});
statusMailService.onReleaseEmail = (version, subject, rawSource) =>
  updateWatcherService.handleRelease(version, subject, rawSource);

// Tmp file cleanup (debug logs, old daily logs, term artifacts)
const cleanupService = new CleanupService(PROJECT_ROOT);
const claudeStatusService = new ClaudeStatusService({ emailService });

// Dependency updater (scheduled CCS/CodeRabbit/PM2/NuGet/Go/pip/npm updates)
const depUpdaterService = new DependencyUpdaterService({
  emailService,
  logStreamer,
  claudeService,
});

// =============================================================================
// Auto-DR: Watch backend source files, restart when idle
// =============================================================================
let pendingRestart = false;
let debounceTimer = null;
let rateLimitInterval = null;
let healthInterval = null;

function triggerAutoDR() {
  const { runningCount, queuedCount, chainWaiterCount, waitingForInputCount, rateLimitQueue } =
    claudeService.getQueueStatus();
  if (
    runningCount === 0 &&
    queuedCount === 0 &&
    chainWaiterCount === 0 &&
    waitingForInputCount === 0 &&
    rateLimitQueue.length === 0
  ) {
    pendingRestart = false;
    serverLog.info('[Auto-DR] No running executions, restarting backend...');
    logStreamer.broadcastAll({
      type: 'auto-dr',
      message: 'Backend restarting (file change detected)',
      timestamp: new Date().toISOString(),
    });
    // Persist DR success to shell states so green button survives restart
    claudeService._setShellState('dr', true);
    // Let PM2 handle restart via autorestart + restart_delay (5s).
    // Detached spawn approaches (pm2 restart / pm2 stop+start) all cause cascade issues:
    // orphan detached processes survive parent death and keep issuing restart commands.
    // process.exit() is clean — PM2 waits restart_delay, port releases, no race conditions.
    serverLog.info('[Auto-DR] Exiting for PM2 autorestart (restart_delay: 5s)');
    exitWithPm2Update(0);
  } else {
    if (!pendingRestart) {
      pendingRestart = true;
      logStreamer.broadcastAll({
        type: 'auto-dr-pending',
        message: 'Dashboard restart deferred (executions active)',
        timestamp: new Date().toISOString(),
      });
    }
    serverLog.info(
      `[Auto-DR] Deferred: ${runningCount} running, ${queuedCount} queued, ${chainWaiterCount} chain-waiting, ${waitingForInputCount} input-waiting, ${rateLimitQueue.length} rate-limit-queued`,
    );
  }
}

// Watch backend source files for changes
// NOTE: chokidar 4.x glob expansion is broken on Windows + Node 24 (0 watched dirs).
// Use directory watching instead, with file extension filter in the handler.
const autoDRWatcher = chokidar.watch(
  [path.join(__dirname, 'src'), path.join(__dirname, 'server.js')],
  {
    ignoreInitial: true,
    ignored: ['**/node_modules/**', '**/*.test.js'],
    awaitWriteFinish: { stabilityThreshold: 500 },
  },
);

const startupTime = Date.now();

autoDRWatcher.on('change', (filePath) => {
  if (!filePath.endsWith('.js')) return;
  if (Date.now() - startupTime < AUTO_DR_STARTUP_COOLDOWN_MS) {
    serverLog.info(
      `[Auto-DR] File changed during cooldown, ignoring: ${path.relative(__dirname, filePath)}`,
    );
    return;
  }
  const relative = path.relative(__dirname, filePath);
  serverLog.info(`[Auto-DR] File changed: ${relative}`);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(triggerAutoDR, AUTO_DR_DEBOUNCE_MS);
});

// When an execution completes, check if restart was deferred
claudeService.onExecutionComplete = () => {
  if (!pendingRestart) return;
  const { runningCount, queuedCount, chainWaiterCount, waitingForInputCount, rateLimitQueue } =
    claudeService.getQueueStatus();
  if (
    runningCount === 0 &&
    queuedCount === 0 &&
    chainWaiterCount === 0 &&
    waitingForInputCount === 0 &&
    rateLimitQueue.length === 0
  ) {
    serverLog.info('[Auto-DR] All executions complete, executing deferred restart');
    triggerAutoDR();
  }
};

// Express app
const app = express();
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : [
      'http://localhost:5173',
      'http://localhost:3001',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:3001',
    ];
app.use(
  cors({
    origin: corsOrigins,
  }),
);
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    serverLog.info(`${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// API routes
app.use('/api/features', createFeaturesRouter(featureService));
app.use('/api/execution', createExecutionRouter(claudeService, featureService));
app.use('/api/deps', createDepsRouter(depUpdaterService));

// Health check
app.get('/api/health', async (req, res) => {
  const queueStatus = claudeService.getQueueStatus();
  const proxy = await claudeService.checkProxy();

  // Git dirty check (5-repo split)
  const gitStatusOpts = { timeout: 5000, encoding: 'utf8', windowsHide: true };
  const countDirty = (cwd) => {
    try {
      const output = execSync('git status --porcelain', { ...gitStatusOpts, cwd });
      const lines = output
        .trim()
        .split('\n')
        .filter((l) => l.length > 0);
      return lines.length;
    } catch {
      return 0;
    }
  };
  const repoPaths = JSON.parse(process.env.REPO_PATHS || '{}');
  const defaultPaths = {
    game: 'C:\\Era\\game',
    core: 'C:\\Era\\core',
    engine: 'C:\\Era\\engine',
    devkit: 'C:\\Era\\devkit',
    dashboard: 'C:\\Era\\dashboard',
  };
  const paths = { ...defaultPaths, ...repoPaths };
  const counts = {};
  let totalCount = 0;
  for (const [name, dir] of Object.entries(paths)) {
    counts[name] = countDirty(dir);
    totalCount += counts[name];
  }

  // Trigger fresh rate limit capture if requested (e.g., on browser refresh)
  if (req.query.refresh) {
    rateLimitService.capture({ forceRefresh: true }).catch(() => {});
    claudeStatusService.refresh();
  }

  res.json({
    status: 'ok',
    projectRoot: PROJECT_ROOT,
    claude: {
      runningCount: queueStatus.runningCount,
      queuedCount: queueStatus.queuedCount,
      running: queueStatus.running,
      runLockFeatureId: claudeService.runLockFeatureId || null, // ADD THIS
    },
    proxy,
    ccsProfile: claudeService.getCcsProfile(), // Current CCS profile name
    ccsProfiles: getCcsProfiles(),
    uptime: process.uptime(),
    logDir: LOG_DIR,
    rateLimit: rateLimitService.getCached(),
    git: { dirty: totalCount > 0, changedCount: totalCount, ...counts },
    pendingRestart,
    shellStates: claudeService.getShellStates(),
    claudeStatus: claudeStatusService.getCached(),
  });
});

// Manual rate limit cache injection (for profiles where 100% = no TUI banner)
app.post('/api/ratelimit/:profile', (req, res) => {
  const profile = req.params.profile;
  const profiles = getCcsProfiles();
  if (!profiles.includes(profile)) {
    return res
      .status(400)
      .json({ error: `Unknown profile: ${profile}. Available: ${profiles.join(', ')}` });
  }
  const { weekly, session } = req.body || {};
  if (!weekly && !session) {
    return res.status(400).json({
      error:
        'Request body must include weekly and/or session: { weekly: { percent, resetsAt }, session: { percent, resetsAt } }',
    });
  }
  const data = {};
  if (weekly) data.weekly = { percent: weekly.percent, resetsAt: weekly.resetsAt || null };
  if (session) data.session = { percent: session.percent, resetsAt: session.resetsAt || null };
  rateLimitService.setManualCache(profile, data);
  const cached = rateLimitService.getCached();
  res.json({ ok: true, profile, data, cached });
});

// Insights: trigger /insights capture (fire-and-forget, client can poll status)
app.post('/api/insights/capture', async (req, res) => {
  if (insightsService.isRunning()) {
    return res.status(409).json({ error: 'Insights capture already running' });
  }
  const sendEmail = req.body?.sendEmail !== false; // default true
  insightsService.capture({ sendEmail }).catch((err) => {
    serverLog.error(`[Insights] Unhandled: ${err.message}`);
  });
  res.json({ ok: true, message: 'Insights capture started', sendEmail });
});

// Update watcher: check last update status
app.get('/api/update/status', (req, res) => {
  res.json(updateWatcherService.getLastUpdate());
});

// Insights: check running status and last result
app.get('/api/insights/status', (req, res) => {
  res.json({
    running: insightsService.isRunning(),
    lastResult: insightsService.getLastResult(),
  });
});

// Smoke test: trigger manual run
app.post('/api/smoke-test/run', (req, res) => {
  if (smokeTestService.isRunning()) {
    return res.status(409).json({ error: 'Smoke test already running' });
  }
  const { trigger = 'manual', version } = req.body || {};
  smokeTestService.runAll({ trigger, version }).catch((err) => {
    serverLog.error(`[SmokeTest] Unhandled: ${err.message}`);
  });
  res.json({ ok: true, message: 'Smoke test started' });
});

// Smoke test: check status
app.get('/api/smoke-test/status', (req, res) => {
  res.json({
    running: smokeTestService.isRunning(),
    lastResult: smokeTestService.getLastResult(),
  });
});

// HTTP + WebSocket server
const server = http.createServer(app);
logStreamer.attach(server);

// Layer 2: Startup port cleanup — kill any stale process holding PORT before listen
function cleanupPort(port) {
  let killed = 0;
  try {
    const output = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${port} "`, {
      encoding: 'utf8',
      windowsHide: true,
      shell: true,
      timeout: 5000,
    });
    const pids = new Set();
    for (const line of output.trim().split('\n')) {
      const match = line.match(/\s(\d+)\s*$/);
      if (match) pids.add(parseInt(match[1]));
    }
    pids.delete(process.pid);
    for (const pid of pids) {
      serverLog.warn(`[Port Cleanup] Killing stale process PID:${pid} on port ${port}`);
      try {
        execSync(`taskkill /F /PID ${pid}`, { windowsHide: true, shell: true, timeout: 5000 });
        killed++;
      } catch {
        /* process already dead */
      }
    }
  } catch {
    /* no process on port */
  }
  return killed;
}

// EADDRINUSE handler — poll until port is free, cleanup after 10s, never exit
// pm2 restart starts new process while old is still dying (kill_timeout: 3s).
// On Windows, port release lags process death. We wait patiently instead of crashing.
let eaddrinuseStart = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (!eaddrinuseStart) eaddrinuseStart = Date.now();
    const elapsed = Date.now() - eaddrinuseStart;
    if (elapsed > 10000) {
      // After 10s, force-kill whatever holds the port
      serverLog.warn(
        `Port ${PORT} still in use after ${Math.round(elapsed / 1000)}s, forcing cleanup...`,
      );
      cleanupPort(PORT);
    }
    const delay = Math.min(2000, 500 + elapsed / 5); // 500ms → 2s adaptive
    serverLog.info(
      `Port ${PORT} in use, retrying in ${Math.round(delay)}ms (${Math.round(elapsed / 1000)}s elapsed)...`,
    );
    // NOTE: Host MUST match initial listen (127.0.0.1). Omitting host binds to :::3001 which conflicts.
    // onListening already bound on first listen — omit callback to avoid re-registration.
    setTimeout(() => server.listen(PORT, '127.0.0.1'), delay);
  } else {
    serverLog.error(`Server error: ${err.message}`);
    process.exit(1);
  }
});

// Start — listen immediately, EADDRINUSE handler polls until port is free
const onListening = () => {
  serverLog.info(`Backend running on http://localhost:${PORT}`);
  serverLog.info(`WebSocket on ws://localhost:${PORT}/ws`);
  fileWatcher.start();
  rateLimitService.capture({ forceRefresh: true }).catch(() => {});
  rateLimitInterval = setInterval(
    () => rateLimitService.capture().catch(() => {}),
    RATE_LIMIT_POLL_INTERVAL_MS,
  );
  statusMailService.start();
  cleanupService.start();
  insightsService.startScheduler();
  claudeStatusService.start();
  if (UPDATE_ENABLED) {
    depUpdaterService.start();
  } else {
    serverLog.info('[DepUpdater] Disabled via UPDATE_ENABLED=false');
  }

  // Periodic health metrics + exit marker refresh (sentinel keeps latest snapshot for hard-kill diagnosis)
  healthInterval = setInterval(() => {
    const mem = process.memoryUsage();
    let handles = null;
    let requests = null;
    try {
      handles = process._getActiveHandles?.()?.length ?? null;
      requests = process._getActiveRequests?.()?.length ?? null;
    } catch {
      /* undocumented API */
    }
    serverLog.info(
      `[Health] heap=${Math.round(mem.heapUsed / 1048576)}/${Math.round(mem.heapTotal / 1048576)}MB, rss=${Math.round(mem.rss / 1048576)}MB, handles=${handles}, requests=${requests}, uptime=${Math.round(process.uptime())}s`,
    );
    writeExitMarker('running'); // Refresh sentinel with current metrics
  }, HEALTH_METRICS_INTERVAL_MS);
  healthInterval.unref();
};
server.listen(PORT, '127.0.0.1', onListening);

// Shutdown state (declared early — referenced by exit/error/signal handlers below)
let lastExitReason = 'unknown';
let shutdownInProgress = false;

// Exit marker fallback: process.on('exit') always fires (even hard kill on Windows)
// SIGINT/SIGTERM are NOT delivered by PM2 on Windows (TerminateProcess = hard kill)
process.on('exit', (code) => {
  if (!shutdownInProgress) {
    // Hard kill (no graceful shutdown ran) — write marker with whatever info we have
    writeExitMarker(lastExitReason, { exitCode: code });
  }
});

// Error handling
process.on('uncaughtException', (err) => {
  lastExitReason = 'uncaughtException-survived';
  writeExitMarker('uncaughtException-survived', { stack: err.stack });
  serverLog.error(`Uncaught Exception: ${err.message}`);
  serverLog.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  lastExitReason = 'unhandledRejection-survived';
  writeExitMarker('unhandledRejection-survived', { stack: String(reason) });
  serverLog.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

// Graceful shutdown (shared by SIGINT, SIGTERM, and PM2 IPC)
async function shutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  lastExitReason = signal;

  writeExitMarker(signal);
  serverLog.info(`Shutting down (${signal})...`);

  setTimeout(() => {
    serverLog.warn('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 2500).unref();

  clearInterval(healthInterval);
  clearInterval(rateLimitInterval);
  clearTimeout(debounceTimer);

  statusMailService.stop().catch(() => {});
  cleanupService.stop();
  claudeStatusService.stop();
  depUpdaterService.stop();
  smokeTestService.stop();
  insightsService.stopScheduler();
  claudeService.killAllRunning();
  fileWatcher.stop();
  autoDRWatcher.close();

  server.closeAllConnections();
  server.close(async () => {
    await flushAll().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// PM2 graceful shutdown via IPC (Windows: PM2 uses this instead of signals)
process.on('message', (msg) => {
  if (msg === 'shutdown') shutdown('pm2-shutdown');
});
