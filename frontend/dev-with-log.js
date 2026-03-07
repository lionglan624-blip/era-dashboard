/**
 * Vite dev server wrapper with file logging
 * Captures stdout/stderr and writes to log file
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Go up 4 levels: frontend -> feature-dashboard -> node -> tools -> src -> devkit
const LOG_DIR = path.resolve(__dirname, '..', '..', '..', '_out', 'tmp', 'dashboard', 'logs');
const date = new Date().toISOString().slice(0, 10);
const LOG_PATH = path.join(LOG_DIR, `frontend-${date}.log`);

// Ensure log directory exists
fs.mkdirSync(LOG_DIR, { recursive: true });

// Open log file in append mode
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] [frontend] ${message}\n`;
  logStream.write(line);
  process.stdout.write(line);
}

log('INFO', '=== Vite Dev Server Starting ===');
log('INFO', `Log file: ${LOG_PATH}`);
log('INFO', `PID: ${process.pid}`);

// Spawn vite
const vite = spawn('npx', ['vite'], {
  cwd: __dirname,
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: true,
});

vite.stdout.on('data', (data) => {
  const text = data.toString();
  process.stdout.write(text);
  logStream.write(`[${new Date().toISOString()}] [STDOUT] ${text}`);
});

vite.stderr.on('data', (data) => {
  const text = data.toString();
  process.stderr.write(text);
  logStream.write(`[${new Date().toISOString()}] [STDERR] ${text}`);
});

vite.on('error', (err) => {
  log('ERROR', `Vite process error: ${err.message}`);
});

vite.on('close', (code) => {
  log('INFO', `Vite process exited with code ${code}`);
  logStream.end();
  process.exit(code || 0);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('INFO', 'Received SIGINT, shutting down...');
  vite.kill('SIGINT');
});

process.on('SIGTERM', () => {
  log('INFO', 'Received SIGTERM, shutting down...');
  vite.kill('SIGTERM');
});
