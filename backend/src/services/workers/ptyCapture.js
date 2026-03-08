/**
 * PTY Capture Worker - runs node-pty in an isolated child process.
 *
 * Isolates ConPTY native operations (spawn, kill) so that ACCESS_VIOLATION
 * crashes only kill this worker, not the main dashboard process.
 *
 * IPC Protocol:
 *   Receive: { type: 'start', env, cols, rows, timeoutMs }
 *   Send:    { type: 'result', text } or { type: 'error', message }
 */
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { VtScreenBuffer } from '../vtScreenBuffer.js';

const require = createRequire(import.meta.url);

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

function runCapture({ env, cols, rows, timeoutMs }) {
  let nodePty;
  try {
    // Dynamic require: node-pty is a native module
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

  let resolved = false;
  const screen = new VtScreenBuffer(cols, rows);

  const captureEnv = { ...env, WT_SESSION: '00000000-0000-0000-0000-000000000000' };
  delete captureEnv.CLAUDECODE;

  const ptyProcess = spawn('cmd.exe', ['/c', 'claude'], {
    cols,
    rows,
    env: captureEnv,
    useConptyDll: true,
  });

  let trustAccepted = false;
  let tuiDetected = false;
  let usageSent = false;
  let usageDetected = false;
  let usageScreen = null;

  const finish = (text) => {
    if (resolved) return;
    resolved = true;
    clearTimeout(overallTimeout);
    killPty(ptyProcess);
    process.send({ type: 'result', text });
    // Give IPC time to flush before exit
    setTimeout(() => process.exit(0), 100);
  };

  ptyProcess.onData((data) => {
    screen.feed(data);
    if (usageScreen) usageScreen.feed(data);
    if (resolved) return;

    const text = screen.getText();

    // Phase 0: Detect workspace trust prompt and accept it
    // Claude Code v2.1.71+ shows "Quick safety check" before TUI loads
    if (!trustAccepted && !tuiDetected) {
      if (
        /safety check/i.test(text) ||
        /trust.*files/i.test(text) ||
        /Yes,\s*proceed/i.test(text)
      ) {
        trustAccepted = true;
        // Send Enter to accept the default (Yes, proceed) option
        setTimeout(() => {
          if (!resolved) ptyProcess.write('\r');
        }, 500);
      }
    }

    // Phase 3: After /usage sent, check for output completion
    if (usageSent && !usageDetected) {
      const hasEsc = /Esc to cancel/i.test(text);
      const hasSonnet = /Sonnet\s+only/i.test(text) && /\d+%[^\d%]{0,15}used/i.test(text);
      if (hasEsc || hasSonnet) {
        usageDetected = true;
        setTimeout(() => {
          finish(usageScreen?.getText() || screen.getText());
        }, 500);
      }
    }

    // Phase 1: Detect TUI loaded (status bar)
    if (!tuiDetected) {
      const hasStatusBar = /Context:\d+%/.test(text);
      if (hasStatusBar) {
        tuiDetected = true;
        // Phase 2: Wait 1.5s for TUI stabilization, then send /usage
        setTimeout(() => {
          if (!resolved && !usageSent) {
            usageSent = true;
            ptyProcess.write('/usage');
            // Delay Enter to let autocomplete menu settle
            setTimeout(() => {
              usageScreen = new VtScreenBuffer(cols, rows);
              ptyProcess.write('\r');
            }, 800);
            // Fallback: resolve after 6s even if /usage output not detected
            setTimeout(() => {
              finish(usageScreen?.getText() || screen.getText());
            }, 5000);
          }
        }, 1500);
      }
    }
  });

  // Overall timeout
  const overallTimeout = setTimeout(() => {
    finish(usageScreen?.getText() || screen.getText());
  }, timeoutMs);

  ptyProcess.onExit(({ exitCode: _exitCode }) => {
    clearTimeout(overallTimeout);
    const exitText = usageScreen?.getText() || screen.getText();
    finish(exitText);
  });
}

// Listen for start command from parent
process.on('message', (msg) => {
  if (msg.type === 'start') {
    runCapture(msg);
  }
});
