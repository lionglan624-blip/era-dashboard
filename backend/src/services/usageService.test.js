import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

// Mock fs module
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    createReadStream: vi.fn(),
  };
});

// Mock readline module
vi.mock('readline', () => ({
  default: {
    createInterface: vi.fn(),
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  serverLog: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Import mocked modules
import { existsSync, readFileSync, readdirSync, statSync, createReadStream } from 'fs';
import readline from 'readline';
import { serverLog } from '../utils/logger.js';

// Import after mocking
import { UsageService } from './usageService.js';

function createMockReadStream(lines) {
  const stream = new Readable({
    read() {
      for (const line of lines) {
        this.push(line + '\n');
      }
      this.push(null);
    },
  });
  return stream;
}

function createMockAsyncIterator(lines) {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= lines.length) {
            return { done: true };
          }
          return { done: false, value: lines[index++] };
        },
      };
    },
  };
}

describe('UsageService', () => {
  let service;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new UsageService();
    // Reset env
    process.env.CCS_PROFILE = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getProfiles', () => {
    it('returns profiles with stats-cache.json', () => {
      existsSync.mockImplementation((path) => {
        if (path.includes('instances')) return true;
        if (path.includes('stats-cache.json')) return true;
        return false;
      });
      readdirSync.mockReturnValue([
        { name: 'goog', isDirectory: () => true },
        { name: 'dev', isDirectory: () => true },
      ]);

      const profiles = service.getProfiles();

      expect(profiles).toEqual(['goog', 'dev']);
    });

    it('returns empty array when CCS_INSTANCES_DIR does not exist', () => {
      existsSync.mockReturnValue(false);

      const profiles = service.getProfiles();

      expect(profiles).toEqual([]);
    });

    it('excludes profiles without stats-cache.json', () => {
      existsSync.mockImplementation((path) => {
        // CCS_INSTANCES_DIR exists
        if (path.endsWith('instances')) return true;
        // Only goog has stats-cache.json
        if (path.includes('goog') && path.includes('stats-cache.json')) return true;
        // dev does NOT have stats-cache.json
        if (path.includes('dev') && path.includes('stats-cache.json')) return false;
        return false;
      });
      readdirSync.mockReturnValue([
        { name: 'goog', isDirectory: () => true },
        { name: 'dev', isDirectory: () => true },
      ]);

      const profiles = service.getProfiles();

      expect(profiles).toEqual(['goog']);
    });

    it('handles readdirSync error gracefully', () => {
      existsSync.mockReturnValue(true);
      readdirSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      const profiles = service.getProfiles();

      expect(profiles).toEqual([]);
      expect(serverLog.debug).toHaveBeenCalledWith(
        expect.stringContaining('Failed to list profiles'),
      );
    });

    it('excludes non-directory entries', () => {
      existsSync.mockImplementation((path) => {
        // CCS_INSTANCES_DIR exists
        if (path.endsWith('instances')) return true;
        // goog has stats-cache.json
        if (path.includes('goog') && path.includes('stats-cache.json')) return true;
        return false;
      });
      readdirSync.mockReturnValue([
        { name: 'goog', isDirectory: () => true },
        { name: 'config.json', isDirectory: () => false },
      ]);

      const profiles = service.getProfiles();

      expect(profiles).toEqual(['goog']);
    });
  });

  describe('getUsage', () => {
    it('returns usage data for valid profile', () => {
      // Mock current date calculation
      const now = new Date();
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const withinWeek = weekAgo.toISOString().slice(0, 10);
      const beforeWeek = new Date(weekAgo);
      beforeWeek.setDate(beforeWeek.getDate() - 1);
      const beforeWeekStr = beforeWeek.toISOString().slice(0, 10);

      const mockStats = {
        lastComputedDate: '2026-02-04',
        dailyActivity: [
          { date: withinWeek, messageCount: 10, sessionCount: 2, toolCallCount: 5 },
          {
            date: now.toISOString().slice(0, 10),
            messageCount: 8,
            sessionCount: 1,
            toolCallCount: 3,
          },
          { date: beforeWeekStr, messageCount: 5, sessionCount: 1, toolCallCount: 2 },
        ],
        dailyModelTokens: [
          { date: withinWeek, tokensByModel: { 'claude-sonnet': 1000, 'claude-opus': 500 } },
          { date: now.toISOString().slice(0, 10), tokensByModel: { 'claude-sonnet': 800 } },
        ],
        totalSessions: 10,
        totalMessages: 100,
        firstSessionDate: '2026-01-01',
        modelUsage: { 'claude-sonnet': 5000 },
      };

      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify(mockStats));

      const usage = service.getUsage('goog');

      expect(usage).not.toBeNull();
      expect(usage.profile).toBe('goog');
      expect(usage.lastComputedDate).toBe('2026-02-04');
      expect(usage.weekly.messages).toBe(18);
      expect(usage.weekly.sessions).toBe(3);
      expect(usage.weekly.toolCalls).toBe(8);
      expect(usage.weekly.tokensByModel['claude-sonnet']).toBe(1800);
      expect(usage.weekly.tokensByModel['claude-opus']).toBe(500);
      expect(usage.totals.sessions).toBe(10);
      expect(usage.totals.messages).toBe(100);
    });

    it('returns null for missing stats-cache.json', () => {
      existsSync.mockReturnValue(false);

      const usage = service.getUsage('goog');

      expect(usage).toBeNull();
    });

    it('handles malformed JSON', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('invalid json');

      const usage = service.getUsage('goog');

      expect(usage).toBeNull();
      expect(serverLog.error).toHaveBeenCalledWith(expect.stringContaining('Failed to read stats'));
    });

    it('handles readFileSync error', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const usage = service.getUsage('goog');

      expect(usage).toBeNull();
      expect(serverLog.error).toHaveBeenCalled();
    });

    it('filters daily activity to last 7 days only', () => {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const eightDaysAgo = new Date(now);
      eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);

      const mockStats = {
        dailyActivity: [
          { date: today, messageCount: 10 },
          { date: sevenDaysAgo.toISOString().slice(0, 10), messageCount: 5 },
          { date: eightDaysAgo.toISOString().slice(0, 10), messageCount: 99 },
        ],
        dailyModelTokens: [],
      };

      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify(mockStats));

      const usage = service.getUsage('goog');

      expect(usage.weekly.messages).toBe(15); // Only last 7 days
    });

    it('handles missing optional fields gracefully', () => {
      const mockStats = {
        lastComputedDate: '2026-02-04',
        dailyActivity: [],
        dailyModelTokens: [],
      };

      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify(mockStats));

      const usage = service.getUsage('goog');

      expect(usage.totals.sessions).toBe(0);
      expect(usage.totals.messages).toBe(0);
      expect(usage.totals.firstSessionDate).toBeNull();
      expect(usage.modelUsage).toEqual({});
    });
  });

  describe('getCurrentUsage', () => {
    it('uses CCS_PROFILE env variable', () => {
      process.env.CCS_PROFILE = 'dev';
      vi.clearAllMocks();
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ dailyActivity: [], dailyModelTokens: [] }));

      service.getCurrentUsage();

      expect(readFileSync).toHaveBeenCalledWith(expect.stringContaining('dev'), 'utf-8');
    });

    it('falls back to goog default', () => {
      delete process.env.CCS_PROFILE;
      vi.clearAllMocks();
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ dailyActivity: [], dailyModelTokens: [] }));

      service.getCurrentUsage();

      expect(readFileSync).toHaveBeenCalledWith(expect.stringContaining('goog'), 'utf-8');
    });
  });

  describe('getAllUsage', () => {
    it('aggregates all profiles', () => {
      existsSync.mockImplementation((path) => {
        if (path.includes('instances')) return true;
        if (path.includes('stats-cache.json')) return true;
        return false;
      });
      readdirSync.mockReturnValue([
        { name: 'goog', isDirectory: () => true },
        { name: 'dev', isDirectory: () => true },
      ]);
      readFileSync.mockReturnValue(JSON.stringify({ dailyActivity: [], dailyModelTokens: [] }));

      const allUsage = service.getAllUsage();

      expect(Object.keys(allUsage)).toEqual(['goog', 'dev']);
      expect(allUsage.goog.profile).toBe('goog');
      expect(allUsage.dev.profile).toBe('dev');
    });

    it('excludes profiles with missing stats', () => {
      vi.clearAllMocks();
      existsSync.mockImplementation((path) => {
        // CCS_INSTANCES_DIR exists
        if (path.endsWith('instances')) return true;
        // Only goog has stats-cache.json
        if (path.includes('goog') && path.includes('stats-cache.json')) return true;
        // dev does NOT have stats-cache.json
        if (path.includes('dev') && path.includes('stats-cache.json')) return false;
        return false;
      });
      readdirSync.mockReturnValue([
        { name: 'goog', isDirectory: () => true },
        { name: 'dev', isDirectory: () => true },
      ]);
      readFileSync.mockReturnValue(JSON.stringify({ dailyActivity: [], dailyModelTokens: [] }));

      const allUsage = service.getAllUsage();

      expect(Object.keys(allUsage)).toEqual(['goog']);
    });
  });

  describe('_getWeekBoundaries', () => {
    it('calculates current week boundaries', () => {
      const { weekStart, weekEnd } = service._getWeekBoundaries();

      expect(weekStart).toBeInstanceOf(Date);
      expect(weekEnd).toBeInstanceOf(Date);
      expect(weekEnd.getTime() - weekStart.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('week boundaries align with anchor', () => {
      const { weekStart } = service._getWeekBoundaries();
      const anchor = new Date('2026-02-05T23:00:00Z');

      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const diff = weekStart.getTime() - anchor.getTime();

      // Use Math.abs to handle -0 vs +0 issue
      expect(Math.abs(diff % weekMs)).toBe(0);
    });
  });

  describe('_getSessionFiles', () => {
    it('finds JSONL files modified since date', () => {
      const since = new Date('2026-02-01');
      const recentDate = new Date('2026-02-03');
      const oldDate = new Date('2026-01-15');

      existsSync.mockReturnValue(true);
      readdirSync
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([
          { name: 'session1.jsonl', isFile: () => true },
          { name: 'session2.jsonl', isFile: () => true },
          { name: 'config.json', isFile: () => true },
        ]);

      statSync.mockReturnValueOnce({ mtime: recentDate }).mockReturnValueOnce({ mtime: oldDate });

      const files = service._getSessionFiles('goog', since);

      expect(files).toHaveLength(1);
      expect(files[0]).toContain('session1.jsonl');
    });

    it('returns empty array when projects directory does not exist', () => {
      existsSync.mockReturnValue(false);

      const files = service._getSessionFiles('goog', new Date());

      expect(files).toEqual([]);
    });

    it('handles readdirSync error gracefully', () => {
      existsSync.mockReturnValue(true);
      readdirSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      const files = service._getSessionFiles('goog', new Date());

      expect(files).toEqual([]);
      expect(serverLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Error scanning session files'),
      );
    });

    it('excludes non-jsonl files', () => {
      const since = new Date('2026-01-01');
      const recentDate = new Date('2026-02-01');

      existsSync.mockReturnValue(true);
      readdirSync
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([
          { name: 'session.jsonl', isFile: () => true },
          { name: 'session.json', isFile: () => true },
          { name: 'readme.txt', isFile: () => true },
        ]);

      statSync.mockReturnValue({ mtime: recentDate });

      const files = service._getSessionFiles('goog', since);

      expect(files).toHaveLength(1);
      expect(files[0]).toContain('session.jsonl');
    });

    it('excludes non-file entries', () => {
      const since = new Date('2026-01-01');

      existsSync.mockReturnValue(true);
      readdirSync
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([
          { name: 'session.jsonl', isFile: () => true, isDirectory: () => false },
          { name: 'subdir', isFile: () => false, isDirectory: () => true },
        ]);

      statSync.mockReturnValue({ mtime: new Date('2026-02-01') });

      const files = service._getSessionFiles('goog', since);

      expect(files).toHaveLength(1);
    });
  });

  describe('_parseSessionTokens', () => {
    it('parses JSONL file and sums tokens', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            model: 'claude-sonnet',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 10,
            },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            model: 'claude-sonnet',
            usage: {
              input_tokens: 200,
              output_tokens: 100,
            },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service._parseSessionTokens('test.jsonl', new Date('2026-02-01'));

      expect(result.modelTokens['claude-sonnet'].input).toBe(300);
      expect(result.modelTokens['claude-sonnet'].output).toBe(150);
      expect(result.modelTokens['claude-sonnet'].cacheRead).toBe(20);
      expect(result.modelTokens['claude-sonnet'].cacheCreation).toBe(10);
      expect(result.modelTokens['claude-sonnet'].total).toBe(480);
    });

    it('filters entries before timestamp', async () => {
      const since = new Date('2026-02-03');
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-02').getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 999, output_tokens: 999 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service._parseSessionTokens('test.jsonl', since);

      expect(result.modelTokens['claude-sonnet'].total).toBe(150); // Only first entry
    });

    it('handles malformed JSONL lines', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
        'invalid json line',
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 200, output_tokens: 100 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service._parseSessionTokens('test.jsonl', new Date('2026-02-01'));

      expect(result.modelTokens['claude-sonnet'].total).toBe(450); // Skips malformed line
    });

    it('skips non-assistant messages', async () => {
      const lines = [
        JSON.stringify({
          type: 'user',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            usage: { input_tokens: 999, output_tokens: 999 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service._parseSessionTokens('test.jsonl', new Date('2026-02-01'));

      expect(result.modelTokens['claude-sonnet'].total).toBe(150); // Only assistant message
    });

    it('skips messages without usage data', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            model: 'claude-sonnet',
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service._parseSessionTokens('test.jsonl', new Date('2026-02-01'));

      expect(result.modelTokens['claude-sonnet'].total).toBe(150);
    });

    it('tracks session time range', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04T10:00:00Z').getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04T14:30:00Z').getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 200, output_tokens: 100 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service._parseSessionTokens('test.jsonl', new Date('2026-02-01'));

      expect(result.sessionStart).toEqual(new Date('2026-02-04T10:00:00Z'));
      expect(result.sessionEnd).toEqual(new Date('2026-02-04T14:30:00Z'));
    });

    it('handles empty lines', async () => {
      const lines = [
        '',
        '   ',
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service._parseSessionTokens('test.jsonl', new Date('2026-02-01'));

      expect(result.modelTokens['claude-sonnet'].total).toBe(150);
    });

    it('handles missing timestamp gracefully', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-sonnet',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service._parseSessionTokens('test.jsonl', new Date('2026-02-01'));

      expect(result.modelTokens['claude-sonnet'].total).toBe(150);
      expect(result.sessionStart).toBeNull();
      expect(result.sessionEnd).toBeNull();
    });

    it('aggregates multiple models', async () => {
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date('2026-02-04').getTime() / 1000),
            model: 'claude-opus',
            usage: { input_tokens: 200, output_tokens: 100 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service._parseSessionTokens('test.jsonl', new Date('2026-02-01'));

      expect(result.modelTokens['claude-sonnet'].total).toBe(150);
      expect(result.modelTokens['claude-opus'].total).toBe(300);
    });

    it('handles readline error gracefully', async () => {
      const mockRL = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new Error('Read error');
            },
          };
        },
      };

      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service._parseSessionTokens('test.jsonl', new Date('2026-02-01'));

      expect(result.modelTokens).toEqual({});
      expect(serverLog.error).toHaveBeenCalledWith(expect.stringContaining('Error parsing JSONL'));
    });
  });

  describe('getWeeklyUsage', () => {
    it('returns weekly usage estimation', async () => {
      const { weekStart } = service._getWeekBoundaries();

      existsSync.mockReturnValue(true);
      readdirSync
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([{ name: 'session.jsonl', isFile: () => true }]);
      statSync.mockReturnValue({ mtime: new Date() });

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date().getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 1000, output_tokens: 500 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service.getWeeklyUsage('goog');

      expect(result.totalTokens).toBe(1500);
      expect(result.tokensByModel['claude-sonnet'].total).toBe(1500);
      expect(result.weekStart).toBeDefined();
      expect(result.weekEnd).toBeDefined();
      expect(result.estimatedPercent).toBeGreaterThan(0);
    });

    it('caps estimated percentage at 100', async () => {
      existsSync.mockReturnValue(true);
      readdirSync
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([{ name: 'session.jsonl', isFile: () => true }]);
      statSync.mockReturnValue({ mtime: new Date() });

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date().getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 10_000_000_000, output_tokens: 5_000_000_000 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service.getWeeklyUsage('goog');

      expect(result.estimatedPercent).toBe(100);
    });

    it('aggregates multiple JSONL files', async () => {
      existsSync.mockReturnValue(true);
      readdirSync
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([
          { name: 'session1.jsonl', isFile: () => true },
          { name: 'session2.jsonl', isFile: () => true },
        ]);
      statSync.mockReturnValue({ mtime: new Date() });

      const lines1 = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date().getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 1000, output_tokens: 500 },
          },
        }),
      ];

      const lines2 = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date().getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 2000, output_tokens: 1000 },
          },
        }),
      ];

      readline.createInterface
        .mockReturnValueOnce(createMockAsyncIterator(lines1))
        .mockReturnValueOnce(createMockAsyncIterator(lines2));
      createReadStream.mockReturnValue({});

      const result = await service.getWeeklyUsage('goog');

      expect(result.totalTokens).toBe(4500);
    });
  });

  describe('getSessionUsage', () => {
    it('returns session window usage (last 5 hours)', async () => {
      const now = new Date();
      const windowStart = new Date(now.getTime() - 5 * 60 * 60 * 1000);

      existsSync.mockReturnValue(true);
      readdirSync
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([{ name: 'session.jsonl', isFile: () => true }]);
      statSync.mockReturnValue({ mtime: now });

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(now.getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 500, output_tokens: 250 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service.getSessionUsage('goog');

      expect(result.totalTokens).toBe(750);
      expect(result.windowStart).toBeDefined();
      expect(result.estimatedPercent).toBeGreaterThan(0);
    });

    it('caps estimated percentage at 100', async () => {
      existsSync.mockReturnValue(true);
      readdirSync
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([{ name: 'session.jsonl', isFile: () => true }]);
      statSync.mockReturnValue({ mtime: new Date() });

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date().getTime() / 1000),
            model: 'claude-sonnet',
            usage: { input_tokens: 5_000_000_000, output_tokens: 5_000_000_000 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});

      const result = await service.getSessionUsage('goog');

      expect(result.estimatedPercent).toBe(100);
    });
  });

  describe('getEstimatedUsage', () => {
    beforeEach(() => {
      // Mock file system for _getSessionFiles
      existsSync.mockReturnValue(true);
      readdirSync
        .mockReturnValue([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValue([{ name: 'session.jsonl', isFile: () => true }]);
      statSync.mockReturnValue({ mtime: new Date() });

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date().getTime() / 1000),
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 1000, output_tokens: 500 },
          },
        }),
      ];

      const mockRL = createMockAsyncIterator(lines);
      readline.createInterface.mockReturnValue(mockRL);
      createReadStream.mockReturnValue({});
    });

    it('returns estimated usage combining weekly and session data', async () => {
      const result = await service.getEstimatedUsage('goog');

      expect(result.session).toBeDefined();
      expect(result.session.percent).toBeDefined();
      expect(result.session.totalTokens).toBeDefined();
      expect(result.weekAll).toBeDefined();
      expect(result.weekAll.percent).toBeDefined();
      expect(result.weekAll.totalTokens).toBeDefined();
      expect(result.weekSonnet).toBeDefined();
      expect(result.weekSonnet.percent).toBeDefined();
      expect(result.weekSonnet.totalTokens).toBeDefined();
      expect(result.isEstimate).toBe(true);
    });

    it('uses cache on repeated calls within TTL', async () => {
      vi.spyOn(service, 'getWeeklyUsage');
      vi.spyOn(service, 'getSessionUsage');

      await service.getEstimatedUsage('goog');
      await service.getEstimatedUsage('goog');

      expect(service.getWeeklyUsage).toHaveBeenCalledTimes(1);
      expect(service.getSessionUsage).toHaveBeenCalledTimes(1);
    });

    it('invalidates cache after TTL (60s)', async () => {
      vi.useFakeTimers();
      vi.spyOn(service, 'getWeeklyUsage');

      await service.getEstimatedUsage('goog');
      vi.advanceTimersByTime(61000); // 61 seconds
      await service.getEstimatedUsage('goog');

      expect(service.getWeeklyUsage).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('falls back to goog profile when profile is null', async () => {
      process.env.CCS_PROFILE = undefined;

      const result = await service.getEstimatedUsage(null);

      expect(result).toBeDefined();
    });

    it('uses CCS_PROFILE env when profile is null', async () => {
      process.env.CCS_PROFILE = 'dev';

      await service.getEstimatedUsage(null);

      expect(service._estimatedCache.profile).toBe('dev');
    });

    it('returns error object on failure', async () => {
      // Clear cache to force fresh execution
      service._estimatedCache = null;
      service._estimatedCacheTime = 0;

      // Mock getWeeklyUsage to throw error
      vi.spyOn(service, 'getWeeklyUsage').mockRejectedValue(new Error('File system error'));

      const result = await service.getEstimatedUsage('goog');

      expect(result.error).toBeDefined();
      expect(result.isEstimate).toBe(true);
      expect(serverLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Error calculating estimated usage'),
      );
    });

    it('calculates Sonnet-only usage correctly', async () => {
      vi.clearAllMocks();
      existsSync.mockReturnValue(true);
      readdirSync
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([{ name: 'session.jsonl', isFile: () => true }])
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([{ name: 'session.jsonl', isFile: () => true }]);
      statSync.mockReturnValue({ mtime: new Date() });

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date().getTime() / 1000),
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 1000, output_tokens: 500 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date().getTime() / 1000),
            model: 'claude-opus-4',
            usage: { input_tokens: 2000, output_tokens: 1000 },
          },
        }),
      ];

      readline.createInterface
        .mockReturnValueOnce(createMockAsyncIterator(lines))
        .mockReturnValueOnce(createMockAsyncIterator(lines));
      createReadStream.mockReturnValue({});

      const result = await service.getEstimatedUsage('goog');

      expect(result.weekSonnet.totalTokens).toBe(1500); // Only sonnet tokens
      expect(result.weekAll.totalTokens).toBe(4500); // All tokens
    });

    it('caps weekSonnet percent at 100', async () => {
      vi.clearAllMocks();
      existsSync.mockReturnValue(true);
      readdirSync
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([{ name: 'session.jsonl', isFile: () => true }])
        .mockReturnValueOnce([{ name: 'project1', isDirectory: () => true }])
        .mockReturnValueOnce([{ name: 'session.jsonl', isFile: () => true }]);
      statSync.mockReturnValue({ mtime: new Date() });

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            created_at: Math.floor(new Date().getTime() / 1000),
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 20_000_000_000, output_tokens: 10_000_000_000 },
          },
        }),
      ];

      readline.createInterface
        .mockReturnValueOnce(createMockAsyncIterator(lines))
        .mockReturnValueOnce(createMockAsyncIterator(lines));
      createReadStream.mockReturnValue({});

      const result = await service.getEstimatedUsage('goog');

      expect(result.weekSonnet.percent).toBe(100);
    });
  });
});
