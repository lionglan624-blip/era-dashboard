import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// From utils/ -> src/ -> backend/ -> feature-dashboard/ -> tools/ -> erakoumakanNTR/
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const LOG_DIR = path.join(PROJECT_ROOT, '_out', 'tmp', 'dashboard', 'logs');

// Detect test environment
const IS_TEST = !!process.env.VITEST;

// Only create real log directory in production
if (!IS_TEST) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    console.warn('Failed to create log directory:', err.message);
  }
}

function toJST(date) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000);
}

function getDateString() {
  return toJST(new Date()).toISOString().slice(0, 10); // YYYY-MM-DD (JST)
}

function getLogPath(name, date) {
  return path.join(LOG_DIR, `${name}-${date}.log`);
}

function formatTimestamp() {
  const jst = toJST(new Date());
  return jst.toISOString().replace('Z', '+09:00');
}

function createLogger(name) {
  let currentDate = getDateString();

  // In test mode, use no-op stream to prevent file creation
  const noopStream = { write: () => {}, end: () => {} };
  let stream = IS_TEST
    ? noopStream
    : fs.createWriteStream(getLogPath(name, currentDate), { flags: 'a' });

  const writeLog = (level, ...args) => {
    // Check if date changed - rotate log file if needed (production only)
    if (!IS_TEST) {
      const today = getDateString();
      if (today !== currentDate) {
        stream.end();
        currentDate = today;
        stream = fs.createWriteStream(getLogPath(name, currentDate), { flags: 'a' });
      }
    }

    const timestamp = formatTimestamp();
    const message = args
      .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
      .join(' ');
    const line = `[${timestamp}] [${level.toUpperCase()}] [${name}] ${message}\n`;

    // Write to file (no-op in test)
    stream.write(line);

    // Also write to console
    if (level === 'error') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  };

  return {
    info: (...args) => writeLog('info', ...args),
    warn: (...args) => writeLog('warn', ...args),
    error: (...args) => writeLog('error', ...args),
    debug: (...args) => writeLog('debug', ...args),

    // Get current log file path (dynamic - returns today's path)
    getLogPath: () => getLogPath(name, getDateString()),
  };
}

// Pre-created loggers
export const serverLog = createLogger('server');
export const wsLog = createLogger('websocket');
export const claudeLog = createLogger('claude');
export const watcherLog = createLogger('watcher');

export { createLogger, LOG_DIR };
