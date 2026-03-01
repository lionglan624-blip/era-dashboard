import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CleanupService } from './cleanupService.js';

// Mock fs/promises
vi.mock('fs/promises', () => {
  const fns = {
    readdir: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
  };
  return { ...fns, default: fns };
});

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { readdir, stat, unlink } from 'fs/promises';

function createService() {
  return new CleanupService('C:\\test\\project');
}

// Helper: create stat result with mtime N days ago
function statDaysAgo(days, size = 1000) {
  return { mtimeMs: Date.now() - days * 86400000, size };
}

describe('CleanupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readdir.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('sets paths from projectRoot', () => {
      const svc = createService();
      expect(svc.dashboardTmpDir).toContain('_out');
      expect(svc.dashboardTmpDir).toContain('dashboard');
      expect(svc.logsDir).toContain('logs');
    });
  });

  describe('start/stop', () => {
    it('start sets interval and runs initial purge', () => {
      vi.useFakeTimers();
      const svc = createService();
      svc.start();
      expect(svc._interval).not.toBeNull();
      svc.stop();
      vi.useRealTimers();
    });

    it('stop clears interval', () => {
      vi.useFakeTimers();
      const svc = createService();
      svc.start();
      svc.stop();
      expect(svc._interval).toBeNull();
      vi.useRealTimers();
    });

    it('stop is safe to call when not started', () => {
      const svc = createService();
      expect(() => svc.stop()).not.toThrow();
    });
  });

  describe('purge', () => {
    it('deletes debug logs older than retention period', async () => {
      const svc = createService();
      readdir.mockImplementation((dir) => {
        if (dir === svc.dashboardTmpDir) {
          return Promise.resolve(['debug-abc123.log', 'debug-def456.log', 'ratelimit-cache.json']);
        }
        return Promise.resolve([]);
      });
      stat.mockResolvedValue(statDaysAgo(5, 500000)); // 5 days old
      unlink.mockResolvedValue(undefined);

      const result = await svc.purge();
      // Should delete both debug logs but NOT ratelimit-cache.json (doesn't match pattern)
      expect(unlink).toHaveBeenCalledTimes(2);
      expect(result.count).toBe(2);
      expect(result.bytes).toBe(1000000);
    });

    it('keeps files newer than retention period', async () => {
      const svc = createService();
      readdir.mockImplementation((dir) => {
        if (dir === svc.dashboardTmpDir) {
          return Promise.resolve(['debug-new.log']);
        }
        return Promise.resolve([]);
      });
      stat.mockResolvedValue(statDaysAgo(1, 500000)); // 1 day old, under 3 day retention

      const result = await svc.purge();
      expect(unlink).not.toHaveBeenCalled();
      expect(result.count).toBe(0);
    });

    it('does not delete protected files', async () => {
      const svc = createService();
      readdir.mockImplementation((dir) => {
        if (dir === svc.dashboardTmpDir) {
          return Promise.resolve(['ratelimit-cache.json', 'latest', 'capture-apple.txt']);
        }
        return Promise.resolve([]);
      });

      await svc.purge();
      expect(stat).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    });

    it('purges daily rotated logs older than 7 days', async () => {
      const svc = createService();
      readdir.mockImplementation((dir) => {
        if (dir === svc.logsDir) {
          return Promise.resolve([
            'claude-2026-02-01.log', // old
            'claude-2026-02-14.log', // recent
            'server-2026-01-25.log', // old
          ]);
        }
        return Promise.resolve([]);
      });
      stat.mockImplementation((filePath) => {
        if (filePath.includes('02-01') || filePath.includes('01-25')) {
          return Promise.resolve(statDaysAgo(14, 200000));
        }
        return Promise.resolve(statDaysAgo(1, 200000));
      });
      unlink.mockResolvedValue(undefined);

      const result = await svc.purge();
      expect(unlink).toHaveBeenCalledTimes(2);
    });

    it('purges term debug logs older than 7 days', async () => {
      const svc = createService();
      readdir.mockImplementation((dir) => {
        if (dir === svc.dashboardTmpDir) {
          return Promise.resolve(['term-675-123456.debug.log']);
        }
        return Promise.resolve([]);
      });
      stat.mockResolvedValue(statDaysAgo(10, 100000));
      unlink.mockResolvedValue(undefined);

      const result = await svc.purge();
      expect(unlink).toHaveBeenCalledTimes(1);
    });

    it('purges exec artifacts older than 7 days', async () => {
      const svc = createService();
      readdir.mockImplementation((dir) => {
        if (dir === svc.dashboardTmpDir) {
          return Promise.resolve(['exec-abc123.jsonl', 'exec-abc123.sh']);
        }
        return Promise.resolve([]);
      });
      stat.mockResolvedValue(statDaysAgo(10, 50000));
      unlink.mockResolvedValue(undefined);

      const result = await svc.purge();
      expect(unlink).toHaveBeenCalledTimes(2);
    });

    it('handles empty directories gracefully', async () => {
      const svc = createService();
      readdir.mockResolvedValue([]);

      const result = await svc.purge();
      expect(result.count).toBe(0);
      expect(result.bytes).toBe(0);
    });

    it('handles ENOENT (directory does not exist) gracefully', async () => {
      const svc = createService();
      const enoent = new Error('ENOENT');
      enoent.code = 'ENOENT';
      readdir.mockRejectedValue(enoent);

      const result = await svc.purge();
      expect(result.count).toBe(0);
      expect(svc.logger.warn).not.toHaveBeenCalled();
    });

    it('logs warning on non-ENOENT read errors', async () => {
      const svc = createService();
      readdir.mockRejectedValueOnce(new Error('EACCES'));
      readdir.mockResolvedValue([]); // subsequent calls OK

      await svc.purge();
      expect(svc.logger.warn).toHaveBeenCalled();
    });

    it('logs warning but continues on individual file errors', async () => {
      const svc = createService();
      readdir.mockImplementation((dir) => {
        if (dir === svc.dashboardTmpDir) {
          return Promise.resolve(['debug-fail.log', 'debug-ok.log']);
        }
        return Promise.resolve([]);
      });
      stat.mockImplementation((filePath) => {
        if (filePath.includes('fail')) {
          return Promise.reject(new Error('EPERM'));
        }
        return Promise.resolve(statDaysAgo(5, 100000));
      });
      unlink.mockResolvedValue(undefined);

      const result = await svc.purge();
      // One failed, one succeeded
      expect(result.count).toBe(1);
      expect(svc.logger.warn).toHaveBeenCalled();
    });
  });

  describe('_purgeByAge', () => {
    it('filters files by regex pattern', async () => {
      const svc = createService();
      readdir.mockResolvedValue(['debug-a.log', 'ratelimit-cache.json', 'debug-b.log']);
      stat.mockResolvedValue(statDaysAgo(5, 1000));
      unlink.mockResolvedValue(undefined);

      const result = await svc._purgeByAge(svc.dashboardTmpDir, /^debug-.+\.log$/, 3);
      expect(unlink).toHaveBeenCalledTimes(2);
      expect(result.count).toBe(2);
    });
  });
});
