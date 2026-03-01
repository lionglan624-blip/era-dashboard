import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before importing
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => ({
      write: vi.fn(),
    })),
  };
});

// Mock Date for consistent timestamps
const mockDate = new Date('2026-02-04T21:34:56.789+09:00');
vi.useFakeTimers();
vi.setSystemTime(mockDate);

// Import mocked fs
import { mkdirSync, createWriteStream } from 'fs';

// Import after mocking
import { createLogger, LOG_DIR, serverLog, wsLog, claudeLog, watcherLog } from './logger.js';

describe('logger', () => {
  let originalStdout;
  let originalStderr;
  let stdoutWrite;
  let stderrWrite;

  beforeEach(() => {
    // Mock stdout/stderr
    stdoutWrite = vi.fn();
    stderrWrite = vi.fn();
    originalStdout = process.stdout.write;
    originalStderr = process.stderr.write;
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  });

  afterEach(() => {
    // Restore stdout/stderr
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  });

  describe('LOG_DIR constant', () => {
    it('points to _out/tmp/dashboard/logs', () => {
      expect(LOG_DIR).toMatch(/_out[/\\]tmp[/\\]dashboard[/\\]logs$/);
    });
  });

  describe('createLogger', () => {
    it('returns logger with required methods', () => {
      const logger = createLogger('test');

      expect(logger).toHaveProperty('info');
      expect(logger).toHaveProperty('warn');
      expect(logger).toHaveProperty('error');
      expect(logger).toHaveProperty('debug');
      expect(logger).toHaveProperty('getLogPath');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.getLogPath).toBe('function');
    });
  });

  describe('getLogPath', () => {
    it('returns correct path with date-based filename', () => {
      const logger = createLogger('test');
      const logPath = logger.getLogPath();

      expect(logPath).toMatch(/_out[/\\]tmp[/\\]dashboard[/\\]logs[/\\]test-2026-02-04\.log$/);
    });

    it('returns path with logger name', () => {
      const logger = createLogger('custom-name');
      const logPath = logger.getLogPath();

      expect(logPath).toContain('custom-name-2026-02-04.log');
    });
  });

  describe('log methods - formatting', () => {
    it('formats timestamp in ISO format', () => {
      const logger = createLogger('test');
      logger.info('message');

      expect(stdoutWrite).toHaveBeenCalledWith(
        expect.stringContaining('[2026-02-04T21:34:56.789+09:00]'),
      );
    });

    it('formats log level correctly (info)', () => {
      const logger = createLogger('test');
      logger.info('message');

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('[INFO]'));
    });

    it('formats log level correctly (warn)', () => {
      const logger = createLogger('test');
      logger.warn('message');

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('[WARN]'));
    });

    it('formats log level correctly (error)', () => {
      const logger = createLogger('test');
      logger.error('message');

      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'));
    });

    it('formats log level correctly (debug)', () => {
      const logger = createLogger('test');
      logger.debug('message');

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'));
    });

    it('includes logger name in output', () => {
      const logger = createLogger('mylogger');
      logger.info('test message');

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('[mylogger]'));
    });

    it('formats complete log line correctly', () => {
      const logger = createLogger('test');
      logger.info('hello world');

      expect(stdoutWrite).toHaveBeenCalledWith(
        '[2026-02-04T21:34:56.789+09:00] [INFO] [test] hello world\n',
      );
    });
  });

  describe('log methods - argument handling', () => {
    it('handles single string argument', () => {
      const logger = createLogger('test');
      logger.info('single message');

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('single message'));
    });

    it('handles multiple string arguments', () => {
      const logger = createLogger('test');
      logger.info('part1', 'part2', 'part3');

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('part1 part2 part3'));
    });

    it('handles object serialization', () => {
      const logger = createLogger('test');
      logger.info({ key: 'value', num: 42 });

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('{"key":"value","num":42}'));
    });

    it('handles mixed string and object arguments', () => {
      const logger = createLogger('test');
      logger.info('Message:', { data: 'value' });

      expect(stdoutWrite).toHaveBeenCalledWith(
        expect.stringContaining('Message: {"data":"value"}'),
      );
    });

    it('handles number arguments', () => {
      const logger = createLogger('test');
      logger.info(42, 3.14);

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('42 3.14'));
    });

    it('handles boolean arguments', () => {
      const logger = createLogger('test');
      logger.info(true, false);

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('true false'));
    });

    it('handles null and undefined', () => {
      const logger = createLogger('test');
      logger.info(null, undefined);

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('null undefined'));
    });

    it('handles nested objects', () => {
      const logger = createLogger('test');
      logger.info({ outer: { inner: 'value' } });

      expect(stdoutWrite).toHaveBeenCalledWith(
        expect.stringContaining('{"outer":{"inner":"value"}}'),
      );
    });

    it('handles arrays', () => {
      const logger = createLogger('test');
      logger.info([1, 2, 3]);

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('[1,2,3]'));
    });
  });

  describe('log methods - output streams', () => {
    it('info writes to stdout', () => {
      const logger = createLogger('test');
      logger.info('info message');

      expect(stdoutWrite).toHaveBeenCalledWith(
        '[2026-02-04T21:34:56.789+09:00] [INFO] [test] info message\n',
      );
      expect(stderrWrite).not.toHaveBeenCalled();
    });

    it('warn writes to stdout', () => {
      const logger = createLogger('test');
      logger.warn('warn message');

      expect(stdoutWrite).toHaveBeenCalledWith(
        '[2026-02-04T21:34:56.789+09:00] [WARN] [test] warn message\n',
      );
      expect(stderrWrite).not.toHaveBeenCalled();
    });

    it('debug writes to stdout', () => {
      const logger = createLogger('test');
      logger.debug('debug message');

      expect(stdoutWrite).toHaveBeenCalledWith(
        '[2026-02-04T21:34:56.789+09:00] [DEBUG] [test] debug message\n',
      );
      expect(stderrWrite).not.toHaveBeenCalled();
    });

    it('error writes to stderr', () => {
      const logger = createLogger('test');
      logger.error('error message');

      expect(stderrWrite).toHaveBeenCalledWith(
        '[2026-02-04T21:34:56.789+09:00] [ERROR] [test] error message\n',
      );
      expect(stdoutWrite).not.toHaveBeenCalled();
    });
  });

  describe('pre-created loggers', () => {
    it('serverLog exists and has correct name', () => {
      expect(serverLog).toBeDefined();
      expect(serverLog.getLogPath()).toContain('server-2026-02-04.log');
    });

    it('wsLog exists and has correct name', () => {
      expect(wsLog).toBeDefined();
      expect(wsLog.getLogPath()).toContain('websocket-2026-02-04.log');
    });

    it('claudeLog exists and has correct name', () => {
      expect(claudeLog).toBeDefined();
      expect(claudeLog.getLogPath()).toContain('claude-2026-02-04.log');
    });

    it('watcherLog exists and has correct name', () => {
      expect(watcherLog).toBeDefined();
      expect(watcherLog.getLogPath()).toContain('watcher-2026-02-04.log');
    });

    it('all pre-created loggers have required methods', () => {
      [serverLog, wsLog, claudeLog, watcherLog].forEach((logger) => {
        expect(logger).toHaveProperty('info');
        expect(logger).toHaveProperty('warn');
        expect(logger).toHaveProperty('error');
        expect(logger).toHaveProperty('debug');
        expect(logger).toHaveProperty('getLogPath');
      });
    });
  });

  describe('edge cases', () => {
    it('handles empty message', () => {
      const logger = createLogger('test');
      logger.info('');

      expect(stdoutWrite).toHaveBeenCalledWith('[2026-02-04T21:34:56.789+09:00] [INFO] [test] \n');
    });

    it('handles no arguments', () => {
      const logger = createLogger('test');
      logger.info();

      expect(stdoutWrite).toHaveBeenCalledWith('[2026-02-04T21:34:56.789+09:00] [INFO] [test] \n');
    });

    it('handles special characters in message', () => {
      const logger = createLogger('test');
      logger.info('Special: \n\t\r');

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Special: \n\t\r'));
    });

    it('handles Unicode characters', () => {
      const logger = createLogger('test');
      logger.info('日本語テスト');

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('日本語テスト'));
    });

    it('handles very long messages', () => {
      const logger = createLogger('test');
      const longMessage = 'a'.repeat(10000);
      logger.info(longMessage);

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining(longMessage));
    });

    it('handles circular object references', () => {
      const logger = createLogger('test');
      const circular = { prop: 'value' };
      circular.self = circular;

      // JSON.stringify throws on circular references
      expect(() => {
        logger.info(circular);
      }).toThrow(TypeError);
    });
  });

  describe('multiple logger instances', () => {
    it('different loggers maintain independent names', () => {
      const logger1 = createLogger('logger1');
      const logger2 = createLogger('logger2');

      logger1.info('message1');
      logger2.info('message2');

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('[logger1] message1'));
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('[logger2] message2'));
    });

    it('loggers with same name are independent', () => {
      const logger1 = createLogger('samename');
      const logger2 = createLogger('samename');

      // Both are valid loggers
      expect(logger1.getLogPath()).toContain('samename-2026-02-04.log');
      expect(logger2.getLogPath()).toContain('samename-2026-02-04.log');

      // Both can log independently
      logger1.info('from logger1');
      logger2.info('from logger2');

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('from logger1'));
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('from logger2'));
    });
  });
});
