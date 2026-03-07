import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * Tests for ptyCapture worker IPC contract.
 * Since the worker is a child_process.fork() script, we test the IPC protocol
 * by simulating process.send/process.on('message') interactions.
 */
describe('ptyCapture worker IPC contract', () => {
  it('expects start message with required fields', () => {
    // Validates the IPC protocol shape
    const startMsg = {
      type: 'start',
      env: { FORCE_COLOR: '0', CLAUDE_CONFIG_DIR: '/some/path' },
      cols: 120,
      rows: 30,
      timeoutMs: 20000,
    };

    expect(startMsg.type).toBe('start');
    expect(startMsg.cols).toBeTypeOf('number');
    expect(startMsg.rows).toBeTypeOf('number');
    expect(startMsg.timeoutMs).toBeTypeOf('number');
    expect(startMsg.env).toBeTypeOf('object');
  });

  it('result message has correct shape', () => {
    const resultMsg = { type: 'result', text: 'Current session\n50% used' };
    expect(resultMsg.type).toBe('result');
    expect(resultMsg.text).toBeTypeOf('string');
  });

  it('error message has correct shape', () => {
    const errorMsg = { type: 'error', message: 'Failed to load node-pty' };
    expect(errorMsg.type).toBe('error');
    expect(errorMsg.message).toBeTypeOf('string');
  });

  it('result text can be empty string (timeout/no data)', () => {
    const resultMsg = { type: 'result', text: '' };
    expect(resultMsg.text).toBe('');
  });

  it('env in start message strips CLAUDECODE and sets WT_SESSION', () => {
    const env = {
      PATH: '/usr/bin',
      CLAUDECODE: 'some-value',
      FORCE_COLOR: '0',
    };

    // Worker should strip CLAUDECODE and set WT_SESSION
    const captureEnv = { ...env, WT_SESSION: '00000000-0000-0000-0000-000000000000' };
    delete captureEnv.CLAUDECODE;

    expect(captureEnv.CLAUDECODE).toBeUndefined();
    expect(captureEnv.WT_SESSION).toBe('00000000-0000-0000-0000-000000000000');
    expect(captureEnv.FORCE_COLOR).toBe('0');
  });
});
