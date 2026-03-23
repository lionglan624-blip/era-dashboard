/**
 * Forked worker for /insights PTY capture.
 * Runs in isolated process to prevent node-pty ACCESS_VIOLATION from killing main process.
 *
 * IPC Protocol:
 *   Receive: { type: 'start', env, reportPath, beforeMtime }
 *   Send:    { type: 'result', success, reason } or { type: 'error', message }
 */
import fs from 'fs';
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const INSIGHTS_TIMEOUT_MS = 5 * 60 * 1000;
const MTIME_POLL_INTERVAL_MS = 5000;
const REPORT_READY_PATTERN = /report is ready/i;

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

function run(env, reportPath, beforeMtime) {
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

  return new Promise((resolve) => {
    let resolved = false;
    let tuiDetected = false;
    let insightsSent = false;
    let rawChunks = [];
    let trustAccepted = false;

    const ptyProcess = spawn('cmd.exe', ['/c', 'claude'], {
      cols: 120,
      rows: 30,
      env,
      useConptyDll: true,
    });

    let mtimePoll = null;

    const finish = (success, reason) => {
      if (resolved) return;
      resolved = true;
      if (mtimePoll) clearInterval(mtimePoll);
      clearTimeout(overallTimeout);
      killPty(ptyProcess);
      resolve({ success, reason });
    };

    ptyProcess.onData((data) => {
      const truncated = data.length > 2000 ? data.substring(0, 2000) + '...' : data;
      rawChunks.push(truncated);
      if (rawChunks.length > 50) rawChunks.shift();

      if (resolved) return;

      // Phase 0: Trust prompt detection
      if (!trustAccepted && !tuiDetected) {
        if (
          /safety check/i.test(data) ||
          /trust.*files/i.test(data) ||
          /Yes,\s*proceed/i.test(data)
        ) {
          trustAccepted = true;
          setTimeout(() => {
            if (!resolved) ptyProcess.write('\r');
          }, 500);
        }
      }

      // Dual detection signal 2: PTY output pattern
      if (insightsSent && REPORT_READY_PATTERN.test(data)) {
        setTimeout(() => finish(true, 'pty_pattern'), 2000);
        return;
      }

      // Phase 1: Detect TUI loaded
      if (!tuiDetected) {
        if (/Context:\d+%/.test(data) || rawChunks.some((c) => /Context:\d+%/.test(c))) {
          tuiDetected = true;

          setTimeout(() => {
            if (!resolved && !insightsSent) {
              insightsSent = true;
              ptyProcess.write('/insights');
              setTimeout(() => {
                if (!resolved) {
                  ptyProcess.write('\r');

                  // Dual detection signal 1: mtime polling
                  mtimePoll = setInterval(() => {
                    try {
                      const currentMtime = fs.statSync(reportPath).mtimeMs;
                      if (currentMtime > beforeMtime) {
                        setTimeout(() => finish(true, 'mtime_changed'), 2000);
                      }
                    } catch {
                      // file not found yet — continue polling
                    }
                  }, MTIME_POLL_INTERVAL_MS);
                }
              }, 800);
            }
          }, 2000);
        }
      }
    });

    const overallTimeout = setTimeout(() => {
      finish(false, 'timeout');
    }, INSIGHTS_TIMEOUT_MS);

    ptyProcess.onExit(({ exitCode }) => {
      finish(exitCode === 0, `exit_${exitCode}`);
    });
  });
}

// Worker entry point
process.on('message', async (msg) => {
  if (msg.type !== 'start') return;

  try {
    const result = await run(msg.env, msg.reportPath, msg.beforeMtime);
    process.send({ type: 'result', ...result });
  } catch (err) {
    process.send({ type: 'error', message: err.message });
  }

  // Give parent time to receive message before exiting
  setTimeout(() => process.exit(0), 500);
});
