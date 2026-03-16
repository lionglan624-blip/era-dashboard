import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { serverLog } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// From utils/ -> src/ -> backend/ -> dashboard/
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
export const PM2_UPDATE_PENDING_PATH = path.join(
  PROJECT_ROOT,
  '_out',
  'tmp',
  'dashboard',
  'pm2-update-pending.json',
);

/**
 * Exit process, spawning a detached `pm2 update` beforehand if a pending flag exists.
 * The detached child waits 3s for the parent to fully exit before running `pm2 update`.
 */
export function exitWithPm2Update(exitCode = 0) {
  try {
    if (fs.existsSync(PM2_UPDATE_PENDING_PATH)) {
      serverLog.info('[PM2-Update] Pending flag found, spawning detached pm2 update');
      spawn('cmd', ['/c', 'timeout /t 3 /nobreak >nul && pm2 update'], {
        detached: true,
        stdio: 'ignore',
        shell: true,
        windowsHide: true,
      }).unref();
      fs.unlinkSync(PM2_UPDATE_PENDING_PATH);
      serverLog.info('[PM2-Update] Detached spawn queued, flag deleted');
    }
  } catch (err) {
    serverLog.error(`[PM2-Update] Error: ${err.message}`);
  }
  process.exit(exitCode);
}

/**
 * Write a pending PM2 update flag to disk.
 * The flag is consumed by `exitWithPm2Update` on the next clean exit.
 */
export function setPm2UpdatePending(expectedVersion) {
  const dir = path.dirname(PM2_UPDATE_PENDING_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    PM2_UPDATE_PENDING_PATH,
    JSON.stringify({
      expectedVersion,
      timestamp: new Date().toISOString(),
    }),
  );
}
