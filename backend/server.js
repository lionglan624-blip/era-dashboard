import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import chokidar from 'chokidar';

import { FeatureService } from './src/services/featureService.js';
import { ClaudeService } from './src/services/claudeService.js';
import { FileWatcher } from './src/services/fileWatcher.js';
import { LogStreamer } from './src/websocket/logStreamer.js';
import { RateLimitService } from './src/services/ratelimitService.js';
import { StatusMailService } from './src/services/statusMailService.js';
import { CleanupService } from './src/services/cleanupService.js';
import { getCcsProfiles } from './src/services/ccsUtils.js';
import { createFeaturesRouter } from './src/routes/features.js';
import { createExecutionRouter } from './src/routes/execution.js';
import { serverLog, LOG_DIR } from './src/utils/logger.js';
import { RATE_LIMIT_POLL_INTERVAL_MS, AUTO_DR_DEBOUNCE_MS } from './src/config.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..');
const PORT = parseInt(process.env.PORT || '3001');

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


// Services
const logStreamer = new LogStreamer();
const featureService = new FeatureService(PROJECT_ROOT);
const claudeService = new ClaudeService(PROJECT_ROOT, logStreamer);
const fileWatcher = new FileWatcher(PROJECT_ROOT, featureService, logStreamer);
const rateLimitService = new RateLimitService(PROJECT_ROOT, {
  getProfiles: getCcsProfiles,
  getActiveProfile: () => claudeService.getCcsProfile(),
  isIdle: () => {
    const { runningCount, queuedCount, chainWaiterCount } = claudeService.getQueueStatus();
    return runningCount === 0 && queuedCount === 0 && chainWaiterCount === 0;
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
  },
});

// Wire fileWatcher status changes to claudeService for chain execution (fc→fl→run)
fileWatcher.onStatusChanged = (featureId, oldStatus, newStatus) => {
  claudeService.handleFeatureStatusChanged(featureId, oldStatus, newStatus);
};

// Provide fileWatcher reference to claudeService for chain race condition fix
// (allows checking current status when registering chain waiter)
claudeService.fileWatcher = fileWatcher;

// Provide rateLimitService to claudeService for post-completion capture
claudeService.rateLimitService = rateLimitService;

// Provide featureService to claudeService for email notifications
claudeService.featureService = featureService;

// Status mail service (IMAP IDLE - replies to empty self-sent emails with dashboard status)
const statusMailService = new StatusMailService({
  featureService,
  claudeService,
  rateLimitService,
});

// Tmp file cleanup (debug logs, old daily logs, term artifacts)
const cleanupService = new CleanupService(PROJECT_ROOT);

// =============================================================================
// Auto-DR: Watch backend source files, restart when idle
// =============================================================================
let pendingRestart = false;
let debounceTimer = null;

function triggerAutoDR() {
  const { runningCount, queuedCount, chainWaiterCount } = claudeService.getQueueStatus();
  if (runningCount === 0 && queuedCount === 0 && chainWaiterCount === 0) {
    pendingRestart = false;
    serverLog.info('[Auto-DR] No running executions, restarting backend...');
    logStreamer.broadcastAll({
      type: 'auto-dr',
      message: 'Backend restarting (file change detected)',
      timestamp: new Date().toISOString(),
    });
    // Persist DR success to shell states so green button survives restart
    claudeService._setShellState('dr', true);
    // Small delay to let WS message reach clients
    setTimeout(() => {
      spawn('pm2', ['restart', 'dashboard-backend'], {
        stdio: 'ignore',
        shell: true,
        windowsHide: true,
      });
    }, 500);
  } else {
    if (!pendingRestart) {
      pendingRestart = true;
      logStreamer.broadcastAll({
        type: 'auto-dr-pending',
        message: 'Dashboard restart deferred (executions active)',
        timestamp: new Date().toISOString(),
      });
    }
    serverLog.info(`[Auto-DR] Deferred: ${runningCount} running, ${queuedCount} queued, ${chainWaiterCount} chain-waiting`);
  }
}

// Watch backend source files for changes
// NOTE: chokidar 4.x glob expansion is broken on Windows + Node 24 (0 watched dirs).
// Use directory watching instead, with file extension filter in the handler.
const autoDRWatcher = chokidar.watch([
  path.join(__dirname, 'src'),
  path.join(__dirname, 'server.js'),
], {
  ignoreInitial: true,
  ignored: ['**/node_modules/**', '**/*.test.js'],
  awaitWriteFinish: { stabilityThreshold: 500 },
});

autoDRWatcher.on('change', (filePath) => {
  if (!filePath.endsWith('.js')) return;
  const relative = path.relative(__dirname, filePath);
  serverLog.info(`[Auto-DR] File changed: ${relative}`);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(triggerAutoDR, AUTO_DR_DEBOUNCE_MS);
});

// When an execution completes, check if restart was deferred
claudeService.onExecutionComplete = () => {
  if (!pendingRestart) return;
  const { runningCount, queuedCount, chainWaiterCount } = claudeService.getQueueStatus();
  if (runningCount === 0 && queuedCount === 0 && chainWaiterCount === 0) {
    serverLog.info('[Auto-DR] All executions complete, executing deferred restart');
    triggerAutoDR();
  }
};

// Express app
const app = express();
app.use(cors());
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
app.use('/api/execution', createExecutionRouter(claudeService));

// Health check
app.get('/api/health', async (req, res) => {
  const queueStatus = claudeService.getQueueStatus();
  const proxy = await claudeService.checkProxy();

  // Git dirty check (main repo + engine/)
  const gitStatusOpts = { timeout: 5000, encoding: 'utf8', windowsHide: true };
  const countDirty = (cwd) => {
    try {
      const output = execSync('git status --porcelain', { ...gitStatusOpts, cwd });
      const lines = output.trim().split('\n').filter(l => l.length > 0);
      return lines.length;
    } catch { return 0; }
  };
  const mainCount = countDirty(PROJECT_ROOT);
  const engineCount = countDirty(path.join(PROJECT_ROOT, 'engine'));
  const totalCount = mainCount + engineCount;

  // Trigger fresh rate limit capture if requested (e.g., on browser refresh)
  if (req.query.refresh) {
    rateLimitService.capture({ forceRefresh: true }).catch(() => {});
  }

  res.json({
    status: 'ok',
    projectRoot: PROJECT_ROOT,
    claude: {
      runningCount: queueStatus.runningCount,
      queuedCount: queueStatus.queuedCount,
      running: queueStatus.running,
    },
    proxy,
    ccsProfile: claudeService.getCcsProfile(),  // Current CCS profile name
    ccsProfiles: getCcsProfiles(),
    uptime: process.uptime(),
    logDir: LOG_DIR,
    rateLimit: rateLimitService.getCached(),
    git: { dirty: totalCount > 0, changedCount: totalCount, main: mainCount, engine: engineCount },
    pendingRestart,
    shellStates: claudeService.getShellStates(),
  });
});

// Manual rate limit cache injection (for profiles where 100% = no TUI banner)
app.post('/api/ratelimit/:profile', (req, res) => {
  const profile = req.params.profile;
  const profiles = getCcsProfiles();
  if (!profiles.includes(profile)) {
    return res.status(400).json({ error: `Unknown profile: ${profile}. Available: ${profiles.join(', ')}` });
  }
  const { weekly, session } = req.body || {};
  if (!weekly && !session) {
    return res.status(400).json({ error: 'Request body must include weekly and/or session: { weekly: { percent, resetsAt }, session: { percent, resetsAt } }' });
  }
  const data = {};
  if (weekly) data.weekly = { percent: weekly.percent, resetsAt: weekly.resetsAt || null };
  if (session) data.session = { percent: session.percent, resetsAt: session.resetsAt || null };
  rateLimitService.setManualCache(profile, data);
  const cached = rateLimitService.getCached();
  res.json({ ok: true, profile, data, cached });
});

// HTTP + WebSocket server
const server = http.createServer(app);
logStreamer.attach(server);

// Layer 2: Startup port cleanup — kill any stale process holding PORT before listen
function cleanupPort(port) {
  let killed = 0;
  try {
    const output = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${port} "`, {
      encoding: 'utf8', windowsHide: true, shell: true, timeout: 5000
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
      } catch { /* process already dead */ }
    }
  } catch { /* no process on port */ }
  return killed;
}

// Layer 3: EADDRINUSE handler — retry with increasing delay after cleanup
let eaddrinuseRetries = 0;
const MAX_EADDRINUSE_RETRIES = 3;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && eaddrinuseRetries < MAX_EADDRINUSE_RETRIES) {
    eaddrinuseRetries++;
    const delay = eaddrinuseRetries * 1000; // 1s, 2s, 3s
    serverLog.error(`Port ${PORT} already in use (attempt ${eaddrinuseRetries}/${MAX_EADDRINUSE_RETRIES}), retrying in ${delay}ms...`);
    cleanupPort(PORT);
    setTimeout(() => server.listen(PORT), delay);
  } else {
    serverLog.error(`Server error: ${err.message}`);
    process.exit(1);
  }
});

// Start — kill stale processes, wait for port release, then listen
const killed = cleanupPort(PORT);
const startDelay = killed > 0 ? 1500 : 0; // Wait for Windows socket cleanup
if (startDelay > 0) {
  serverLog.info(`[Port Cleanup] Killed ${killed} stale process(es), waiting ${startDelay}ms for port release...`);
}
setTimeout(() => server.listen(PORT, () => {
  serverLog.info(`Backend running on http://localhost:${PORT}`);
  serverLog.info(`WebSocket on ws://localhost:${PORT}/ws`);
  fileWatcher.start();
  // Background rate limit capture on startup + periodic polling
  rateLimitService.capture({ forceRefresh: true }).catch(() => {});
  setInterval(() => rateLimitService.capture().catch(() => {}), RATE_LIMIT_POLL_INTERVAL_MS);
  statusMailService.start();
  cleanupService.start();
}), startDelay);

// Error handling
process.on('uncaughtException', (err) => {
  serverLog.error(`Uncaught Exception: ${err.message}`);
  serverLog.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  serverLog.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  serverLog.info('Shutting down (SIGINT)...');
  setTimeout(() => { serverLog.warn('Shutdown timeout, forcing exit'); process.exit(1); }, 1500).unref();
  await statusMailService.stop();
  cleanupService.stop();
  claudeService.killAllRunning();
  fileWatcher.stop();
  autoDRWatcher.close();
  server.closeAllConnections();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', async () => {
  serverLog.info('Shutting down (SIGTERM)...');
  setTimeout(() => { serverLog.warn('Shutdown timeout, forcing exit'); process.exit(1); }, 1500).unref();
  await statusMailService.stop();
  cleanupService.stop();
  claudeService.killAllRunning();
  fileWatcher.stop();
  autoDRWatcher.close();
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
