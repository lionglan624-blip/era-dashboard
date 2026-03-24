/**
 * Remote Control Capture Worker - runs node-pty in an isolated child process.
 *
 * Isolates ConPTY native operations (spawn, kill) so that ACCESS_VIOLATION
 * crashes only kill this worker, not the main dashboard process.
 *
 * IPC Protocol:
 *   Receive: { type: 'start', sessionId, env, cols, rows }
 *            { type: 'kill' }
 *   Send:    { type: 'url', url }
 *            { type: 'exit', exitCode }
 *            { type: 'started' }
 *            { type: 'error', message }
 */
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Strip ANSI escape sequences from raw PTY data
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function killPty(ptyProcess) {
  try {
    ptyProcess.kill();
  } catch {
    try {
      if (ptyProcess.pid) {
        execSync(`taskkill /F /T /PID ${ptyProcess.pid}`, { windowsHide: true });
      }
    } catch {
      // ignore
    }
  }
}

let ptyProcess = null;
let urlFound = false;
// Accumulate raw data for URL detection (ANSI may split URL across chunks)
let rawBuffer = '';

function startCapture({ sessionId, env, cols, rows, cwd }) {
  let nodePty;
  try {
    nodePty = require('node-pty');
  } catch (err) {
    process.send({ type: 'error', message: `Failed to load node-pty: ${err.message}` });
    process.exit(1);
  }

  const spawn = nodePty.spawn || nodePty.default?.spawn;
  if (!spawn) {
    process.send({ type: 'error', message: 'node-pty spawn function not found' });
    process.exit(1);
  }

  const captureEnv = { ...env, WT_SESSION: '00000000-0000-0000-0000-000000000000' };
  delete captureEnv.CLAUDECODE;

  ptyProcess = spawn('cmd.exe', ['/c', `claude --resume ${sessionId}`], {
    cols: cols || 120,
    rows: rows || 30,
    cwd: cwd || process.cwd(),
    env: captureEnv,
    useConptyDll: true,
  });

  process.send({ type: 'started', pid: ptyProcess.pid });

  let tuiDetected = false;
  let remoteCommandSent = false;
  let trustAccepted = false;
  let menuAnswered = false;

  ptyProcess.onData((data) => {
    rawBuffer += data;

    // Phase 0: Handle workspace trust prompt (same as ptyCapture.js)
    if (!trustAccepted && !tuiDetected) {
      const stripped = stripAnsi(rawBuffer);
      if (
        /safety check/i.test(stripped) ||
        /trust.*files/i.test(stripped) ||
        /Yes,\s*proceed/i.test(stripped)
      ) {
        trustAccepted = true;
        setTimeout(() => {
          ptyProcess.write('\r');
        }, 500);
      }
    }

    // Phase 1: Detect TUI loaded (status bar with Context:N%)
    if (!tuiDetected) {
      const stripped = stripAnsi(rawBuffer);
      if (/Context:\d+%/.test(stripped) || /\d+%\s*\|\s*[0-9a-f]{8}/.test(stripped)) {
        tuiDetected = true;
        // Wait for TUI stabilization, then send /remote-control
        setTimeout(() => {
          if (!remoteCommandSent) {
            remoteCommandSent = true;
            ptyProcess.write('/remote-control');
            setTimeout(() => {
              ptyProcess.write('\r');
              // Reset buffer for URL capture after command sent
              rawBuffer = '';
            }, 800);
          }
        }, 1500);
      }
    }

    // Phase 2: Handle /remote-control menu and capture URL
    if (remoteCommandSent && !urlFound) {
      const stripped = stripAnsi(rawBuffer);

      // Select "1. Enable Remote Control" if menu is shown
      if (!menuAnswered && /Enable Remote Control/i.test(stripped)) {
        menuAnswered = true;
        setTimeout(() => {
          ptyProcess.write('1');
          setTimeout(() => ptyProcess.write('\r'), 300);
        }, 500);
      }

      // Capture URL
      const match = stripped.match(/https:\/\/claude\.ai\/code\/[^\s]+/);
      if (match) {
        urlFound = true;
        process.send({ type: 'url', url: match[0] });
        rawBuffer = '';
      }
    }

    // Prevent unbounded growth: keep last 4KB only
    if (rawBuffer.length > 4096) {
      rawBuffer = rawBuffer.slice(-2048);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    process.send({ type: 'exit', exitCode: exitCode ?? -1 });
    setTimeout(() => process.exit(0), 100);
  });
}

process.on('message', (msg) => {
  if (msg.type === 'start') {
    startCapture(msg);
  } else if (msg.type === 'kill') {
    if (ptyProcess) {
      killPty(ptyProcess);
    } else {
      process.exit(0);
    }
  }
});
