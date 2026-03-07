import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test _parseUsageOutput and getCached by accessing them through the class
// For _runCapture we mock ptySpawn
import { RateLimitService } from './ratelimitService.js';

// Mock child_process for _killPty and fork tests
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  fork: vi.fn(),
}));

vi.mock('fs', () => {
  const fns = {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
  return { ...fns, default: fns };
});

// Helper to create mock pty for dependency injection
function createMockPty(outputData = '', exitCode = 0) {
  const handlers = { data: [], exit: [] };
  const mockPty = {
    pid: 12345,
    onData: (cb) => {
      handlers.data.push(cb);
    },
    onExit: (cb) => {
      handlers.exit.push(cb);
    },
    kill: vi.fn(),
    write: vi.fn(),
  };
  const mockSpawn = vi.fn(() => {
    // Emit data asynchronously
    if (outputData) {
      setTimeout(() => handlers.data.forEach((cb) => cb(outputData)), 10);
    }
    // Emit exit asynchronously
    setTimeout(() => handlers.exit.forEach((cb) => cb({ exitCode })), 50);
    return mockPty;
  });
  return { mockSpawn, mockPty, handlers };
}

describe('RateLimitService', () => {
  let service;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('_parseUsageOutput', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
      });
    });

    it('returns null for empty text', () => {
      expect(service._parseUsageOutput('')).toBeNull();
      expect(service._parseUsageOutput(null)).toBeNull();
    });

    it('returns null when no usage patterns found', () => {
      expect(service._parseUsageOutput('Hello World\nSome text')).toBeNull();
    });

    it('parses all three usage types (multi-line format)', () => {
      const text = [
        'Current session',
        '██████████████           37% used',
        'Resets 4pm (Asia/Tokyo)',
        'Current week (all models)',
        '██                       54% used',
        'Resets Feb 26, 6am (Asia/Tokyo)',
        'Current week (Sonnet only)',
        '                         0% used',
        'Resets Feb 26, 6am (Asia/Tokyo)',
      ].join('\n');
      const result = service._parseUsageOutput(text);
      expect(result).toEqual({
        session: { percent: 37, resetsAt: '4pm' },
        weekly: { percent: 54, resetsAt: 'Feb 26, 6am' },
        sonnet: { percent: 0, resetsAt: 'Feb 26, 6am' },
      });
    });

    it('parses session only', () => {
      const text = [
        'Current session',
        '██████████████████       90% used',
        'Resets 3pm (Asia/Tokyo)',
      ].join('\n');
      const result = service._parseUsageOutput(text);
      expect(result).toEqual({
        session: { percent: 90, resetsAt: '3pm' },
      });
    });

    it('parses 0% with no reset time', () => {
      const text = ['Current week (all models)', '                         0% used'].join('\n');
      const result = service._parseUsageOutput(text);
      expect(result).toEqual({
        weekly: { percent: 0, resetsAt: null },
      });
    });

    it('parses 100% used', () => {
      const text = [
        'Current session',
        '████████████████████████ 100% used',
        'Resets 6am (Asia/Tokyo)',
      ].join('\n');
      const result = service._parseUsageOutput(text);
      expect(result).toEqual({
        session: { percent: 100, resetsAt: '6am' },
      });
    });

    it('ignores duplicate percent matches outside sections', () => {
      const text = [
        'Something 50% used elsewhere',
        'Current session',
        '██████████████           37% used',
        'Resets 4pm (Asia/Tokyo)',
      ].join('\n');
      const result = service._parseUsageOutput(text);
      expect(result.session.percent).toBe(37);
    });

    it('handles retainText artifacts (garbled text)', () => {
      // Simulates actual ConPTY output with retainText mixing
      const text = [
        'Some TUI header text',
        'Currenttsessionata…      Visualize current context usage',
        '██████████████           Show your Claude Code usag45%tusedtics and activity',
        'Resets 5pme(Asia/Tokyo)',
        'Current week (all models)',
        '██                       30% used',
        'Current week (Sonnet only)',
        '                         10% used',
        'Resets Feb 20, 6am (Asia/Tokyo)',
        'Status bar Context:50%',
      ].join('\n');
      const result = service._parseUsageOutput(text);
      expect(result).toEqual({
        session: { percent: 45, resetsAt: '5pme' },
        weekly: { percent: 30, resetsAt: null },
        sonnet: { percent: 10, resetsAt: 'Feb 20, 6am' },
      });
    });
  });

  describe('_parseResetsAt', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
      });
    });

    it('returns null for null or undefined input', () => {
      expect(service._parseResetsAt(null)).toBeNull();
      expect(service._parseResetsAt(undefined)).toBeNull();
    });

    it('returns null for invalid string', () => {
      expect(service._parseResetsAt('invalid')).toBeNull();
      expect(service._parseResetsAt('not a date')).toBeNull();
    });

    it('parses "Feb 9, 9pm" correctly', () => {
      const result = service._parseResetsAt('Feb 9, 9pm');
      expect(result).toBeInstanceOf(Date);
      expect(result.getMonth()).toBe(1); // Feb = 1
      expect(result.getDate()).toBe(9);
      expect(result.getHours()).toBe(21);
    });

    it('parses "Feb 10, 2am" correctly', () => {
      const result = service._parseResetsAt('Feb 10, 2am');
      expect(result).toBeInstanceOf(Date);
      expect(result.getMonth()).toBe(1); // Feb = 1
      expect(result.getDate()).toBe(10);
      expect(result.getHours()).toBe(2);
    });

    it('parses "12pm" to today at noon or tomorrow if past', () => {
      const result = service._parseResetsAt('12pm');
      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(12);
      // Should be today or tomorrow (handles month rollover)
      const now = new Date();
      const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
      if (todayNoon < now) {
        const tomorrow = new Date(todayNoon);
        tomorrow.setDate(tomorrow.getDate() + 1);
        expect(result.getDate()).toBe(tomorrow.getDate());
        expect(result.getMonth()).toBe(tomorrow.getMonth());
      } else {
        expect(result.getDate()).toBe(todayNoon.getDate());
      }
    });

    it('parses "3pm" to today at 3pm or tomorrow if past', () => {
      const result = service._parseResetsAt('3pm');
      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(15);
    });

    it('parses "Feb 9" to Feb 9 current year at midnight', () => {
      const result = service._parseResetsAt('Feb 9');
      expect(result).toBeInstanceOf(Date);
      expect(result.getMonth()).toBe(1);
      expect(result.getDate()).toBe(9);
      expect(result.getHours()).toBe(0);
    });

    it('adjusts year to next year if date is in the past', () => {
      const now = new Date();
      const currentYear = now.getFullYear();
      const pastMonth = now.getMonth() > 0 ? 0 : 11; // Jan or Dec of last year
      const pastDay = 1;
      const monthName = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ][pastMonth];

      const result = service._parseResetsAt(`${monthName} ${pastDay}, 9pm`);
      expect(result).toBeInstanceOf(Date);
      // Should be next year if the date is before now
      const testDate = new Date(currentYear, pastMonth, pastDay, 21, 0, 0);
      if (testDate < now) {
        expect(result.getFullYear()).toBe(currentYear + 1);
      }
    });
  });

  describe('_computeRefreshAt', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
      });
    });

    it('returns 30 min for null data (below 70%)', () => {
      const before = Date.now();
      const result = service._computeRefreshAt(null);
      const expectedMin = before + 30 * 60 * 1000 - 1000; // -1s tolerance
      const expectedMax = Date.now() + 30 * 60 * 1000 + 1000; // +1s tolerance
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('returns 30 min for 75% weekly (70-79%)', () => {
      const data = { weekly: { percent: 75, resetsAt: 'Feb 9' } };
      const before = Date.now();
      const result = service._computeRefreshAt(data);
      const expectedMin = before + 30 * 60 * 1000 - 1000;
      const expectedMax = Date.now() + 30 * 60 * 1000 + 1000;
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('returns 10 min for 85% weekly (80-89%)', () => {
      const data = { weekly: { percent: 85, resetsAt: 'Feb 9' } };
      const before = Date.now();
      const result = service._computeRefreshAt(data);
      const expectedMin = before + 10 * 60 * 1000 - 1000;
      const expectedMax = Date.now() + 10 * 60 * 1000 + 1000;
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('returns 5 min for 95% weekly (90%+)', () => {
      const data = { weekly: { percent: 95, resetsAt: 'Feb 9' } };
      const before = Date.now();
      const result = service._computeRefreshAt(data);
      const expectedMin = before + 5 * 60 * 1000 - 1000;
      const expectedMax = Date.now() + 5 * 60 * 1000 + 1000;
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('returns 5 min when session is 90% and weekly is 80% (uses max)', () => {
      const data = {
        weekly: { percent: 80, resetsAt: 'Feb 9' },
        session: { percent: 90, resetsAt: '12pm' },
      };
      const before = Date.now();
      const result = service._computeRefreshAt(data);
      const expectedMin = before + 5 * 60 * 1000 - 1000;
      const expectedMax = Date.now() + 5 * 60 * 1000 + 1000;
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('returns 5 min when sonnet is 92% (sonnet drives max)', () => {
      const data = {
        weekly: { percent: 50, resetsAt: 'Feb 9' },
        session: { percent: 40, resetsAt: '12pm' },
        sonnet: { percent: 92, resetsAt: 'Feb 9' },
      };
      const before = Date.now();
      const result = service._computeRefreshAt(data);
      const expectedMin = before + 5 * 60 * 1000 - 1000;
      const expectedMax = Date.now() + 5 * 60 * 1000 + 1000;
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('returns 2 hours when idle regardless of data', () => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        isIdle: () => true,
      });
      const data = { weekly: { percent: 95, resetsAt: 'Feb 9' } };
      const before = Date.now();
      const result = service._computeRefreshAt(data);
      const expectedMin = before + 2 * 60 * 60 * 1000 - 1000;
      const expectedMax = Date.now() + 2 * 60 * 60 * 1000 + 1000;
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('returns 2 hours when idle even with null data', () => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        isIdle: () => true,
      });
      const before = Date.now();
      const result = service._computeRefreshAt(null);
      const expectedMin = before + 2 * 60 * 60 * 1000 - 1000;
      const expectedMax = Date.now() + 2 * 60 * 60 * 1000 + 1000;
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('uses adaptive interval when not idle', () => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        isIdle: () => false,
      });
      const data = { weekly: { percent: 95, resetsAt: 'Feb 9' } };
      const before = Date.now();
      const result = service._computeRefreshAt(data);
      const expectedMin = before + 5 * 60 * 1000 - 1000;
      const expectedMax = Date.now() + 5 * 60 * 1000 + 1000;
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    describe('session burn rate prediction', () => {
      beforeEach(() => {
        vi.useFakeTimers();
        // Set to Feb 21, 2026, 10:00:00 AM local time
        vi.setSystemTime(new Date(2026, 1, 21, 10, 0, 0, 0));
        service = new RateLimitService('/fake/root', {
          getProfiles: () => ['test-profile'],
          isIdle: () => false,
        });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('boosts to 10min when session projected >100% (1h elapsed, 25%)', () => {
        // 1h elapsed → reset at 2pm (4h remaining). 25% * (5/1) = 125% projected
        const data = { session: { percent: 25, resetsAt: '2pm' } };
        const result = service._computeRefreshAt(data);
        // effectiveSessionPercent = 80 → 10min
        expect(result).toBeGreaterThanOrEqual(Date.now() + 10 * 60 * 1000 - 1000);
        expect(result).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000 + 1000);
      });

      it('boosts to 5min when session projected >150% (1h elapsed, 40%)', () => {
        // 1h elapsed → reset at 2pm. 40% * (5/1) = 200% projected
        const data = { session: { percent: 40, resetsAt: '2pm' } };
        const result = service._computeRefreshAt(data);
        // effectiveSessionPercent = 90 → 5min
        expect(result).toBeGreaterThanOrEqual(Date.now() + 5 * 60 * 1000 - 1000);
        expect(result).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);
      });

      it('skips prediction when session is at 100%', () => {
        // 100% should use normal path (90%+ → 5min) but NOT trigger burn rate logic
        const data = { session: { percent: 100, resetsAt: '2pm' } };
        const result = service._computeRefreshAt(data);
        // 100 >= 90 → 5min (normal threshold, not burn rate)
        expect(result).toBeGreaterThanOrEqual(Date.now() + 5 * 60 * 1000 - 1000);
        expect(result).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);
      });

      it('skips prediction when elapsed < 30min', () => {
        // 20min elapsed → reset at 2:40pm (4h40m remaining). 15% * (5/0.33) = 225% but too early
        const data = { session: { percent: 15, resetsAt: '2:40pm' } };
        const result = service._computeRefreshAt(data);
        // 15% < 80 → 30min (normal, no boost)
        expect(result).toBeGreaterThanOrEqual(Date.now() + 30 * 60 * 1000 - 1000);
        expect(result).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000 + 1000);
      });

      it('skips prediction when session percent < 5%', () => {
        // 1h elapsed, 3% → projected 15% but below minimum percent threshold
        const data = { session: { percent: 3, resetsAt: '2pm' } };
        const result = service._computeRefreshAt(data);
        // 3% < 80 → 30min
        expect(result).toBeGreaterThanOrEqual(Date.now() + 30 * 60 * 1000 - 1000);
        expect(result).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000 + 1000);
      });

      it('skips prediction when resetsAt is missing', () => {
        const data = { session: { percent: 40 } };
        const result = service._computeRefreshAt(data);
        // 40% < 80 → 30min
        expect(result).toBeGreaterThanOrEqual(Date.now() + 30 * 60 * 1000 - 1000);
        expect(result).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000 + 1000);
      });

      it('weekly high percent takes priority over session burn rate', () => {
        // weekly 95% (→5min) should override session burn rate (→10min)
        const data = {
          weekly: { percent: 95, resetsAt: 'Feb 22' },
          session: { percent: 25, resetsAt: '2pm' },
        };
        const result = service._computeRefreshAt(data);
        // weekly 95% → 5min
        expect(result).toBeGreaterThanOrEqual(Date.now() + 5 * 60 * 1000 - 1000);
        expect(result).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);
      });

      it('does not boost when projected <= 100% (normal pace)', () => {
        // 2.5h elapsed → reset at 12:30pm. 40% * (5/2.5) = 80% → no boost
        const data = { session: { percent: 40, resetsAt: '12:30pm' } };
        const result = service._computeRefreshAt(data);
        // 40% < 80 → 30min (no boost)
        expect(result).toBeGreaterThanOrEqual(Date.now() + 30 * 60 * 1000 - 1000);
        expect(result).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000 + 1000);
      });
    });
  });

  describe('_computeExpiresAt', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
      });
    });

    it('returns RATE_LIMIT_CACHE_MS for null data (fallback for re-checking)', async () => {
      const { RATE_LIMIT_CACHE_MS } = await import('../config.js');
      const before = Date.now();
      const result = service._computeExpiresAt(null);
      const expectedMin = before + RATE_LIMIT_CACHE_MS - 1000; // -1s tolerance
      const expectedMax = Date.now() + RATE_LIMIT_CACHE_MS + 1000; // +1s tolerance
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('returns 1 week from now when no resetsAt is parseable', () => {
      const data = { weekly: { percent: 95, resetsAt: null } };
      const before = Date.now();
      const result = service._computeExpiresAt(data);
      const oneWeek = 7 * 24 * 60 * 60 * 1000;
      const expectedMin = before + oneWeek - 1000; // -1s tolerance
      const expectedMax = Date.now() + oneWeek + 1000; // +1s tolerance
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('uses weekly resetsAt when only weekly is present', () => {
      const data = { weekly: { percent: 95, resetsAt: 'Feb 9, 9pm' } };
      const oneWeek = 7 * 24 * 60 * 60 * 1000;
      const before = Date.now();
      const result = service._computeExpiresAt(data);
      const after = Date.now();
      const parsed = service._parseResetsAt('Feb 9, 9pm');
      const expectedMin = Math.min(parsed.getTime(), before + oneWeek);
      const expectedMax = Math.min(parsed.getTime(), after + oneWeek);
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('uses session resetsAt when only session is present', () => {
      const data = { session: { percent: 90, resetsAt: '12pm' } };
      const oneWeek = 7 * 24 * 60 * 60 * 1000;
      const before = Date.now();
      const result = service._computeExpiresAt(data);
      const after = Date.now();
      const parsed = service._parseResetsAt('12pm');
      const expectedMin = Math.min(parsed.getTime(), before + oneWeek);
      const expectedMax = Math.min(parsed.getTime(), after + oneWeek);
      expect(result).toBeGreaterThanOrEqual(expectedMin);
      expect(result).toBeLessThanOrEqual(expectedMax);
    });

    it('uses minimum of weekly and session resetsAt', () => {
      // Create dates where we know session is earlier
      const now = new Date();
      const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
      const nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const hour12pm = nextHour.getHours() === 12 ? `${nextHour.getHours()}pm` : '12pm';
      const febNext = `Feb ${nextDay.getDate()}`;

      const data = {
        weekly: { percent: 95, resetsAt: febNext },
        session: { percent: 90, resetsAt: hour12pm },
      };

      const result = service._computeExpiresAt(data);
      const weeklyParsed = service._parseResetsAt(febNext);
      const sessionParsed = service._parseResetsAt(hour12pm);

      if (weeklyParsed && sessionParsed) {
        const expected = Math.min(
          weeklyParsed.getTime(),
          sessionParsed.getTime(),
          Date.now() + 7 * 24 * 60 * 60 * 1000,
        );
        expect(result).toBe(expected);
      }
    });

    it('caps expiration at 1 week from now', () => {
      // Far future date (but parseable as "next year")
      const data = { weekly: { percent: 95, resetsAt: 'Jan 1, 12am' } };
      const result = service._computeExpiresAt(data);
      const oneWeek = Date.now() + 7 * 24 * 60 * 60 * 1000;
      expect(result).toBeLessThanOrEqual(oneWeek + 1000); // +1s tolerance
    });
  });

  describe('getCached', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
      });
    });

    it('returns null when no cache exists', () => {
      expect(service.getCached()).toBeNull();
    });

    it('returns cached data when not expired', () => {
      const data = { weekly: { percent: 95, resetsAt: 'Feb 9' } };
      service._cache.set('test-profile', {
        data,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });
      expect(service.getCached()).toEqual({ 'test-profile': data });
    });

    it('returns null when cache is expired', () => {
      const data = { weekly: { percent: 95, resetsAt: 'Feb 9' } };
      service._cache.set('test-profile', {
        data,
        timestamp: Date.now(),
        expiresAt: Date.now() - 1000,
        refreshAt: Date.now() - 2000,
      });
      expect(service.getCached()).toBeNull();
    });

    it('returns profile with null data when not expired (no rate limit warning)', () => {
      service._cache.set('test-profile', {
        data: null,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 10000,
      });
      expect(service.getCached()).toEqual({ 'test-profile': null });
    });

    it('returns only fresh profiles when multiple profiles exist', () => {
      const data1 = { weekly: { percent: 95, resetsAt: 'Feb 9' } };
      const data2 = { weekly: { percent: 80, resetsAt: 'Feb 10' } };
      service._cache.set('profile1', {
        data: data1,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });
      service._cache.set('profile2', {
        data: data2,
        timestamp: Date.now(),
        expiresAt: Date.now() - 1000,
        refreshAt: Date.now() - 2000,
      });
      expect(service.getCached()).toEqual({ profile1: data1 });
    });
  });

  describe('capture with node-pty integration', () => {
    it('returns cached data when not expired and not forced', async () => {
      const { mockSpawn } = createMockPty();
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        ptySpawn: mockSpawn,
      });
      const data = { weekly: { percent: 95, resetsAt: 'Feb 9' } };
      service._cache.set('test-profile', {
        data,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 60000,
      });
      const result = await service.capture();
      expect(result).toEqual({ 'test-profile': data });
    });

    it('returns cached data when concurrent capture is in progress', async () => {
      const { mockSpawn } = createMockPty();
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        ptySpawn: mockSpawn,
      });
      const data = { weekly: { percent: 90, resetsAt: 'Feb 10' } };
      service._cache.set('test-profile', {
        data,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 60000,
      }); // fresh cache
      service._capturing = true;
      const result = await service.capture();
      expect(result).toEqual({ 'test-profile': data });
    });

    it('returns null when concurrent capture in progress and no cache', async () => {
      const { mockSpawn } = createMockPty();
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        ptySpawn: mockSpawn,
      });
      service._capturing = true;
      const result = await service.capture();
      expect(result).toBeNull();
    });

    it('captures data from pty and parses rate limit', async () => {
      const outputData = [
        'Context:50%\r\n',
        'Current session\r\n',
        '██████████████           95% used\r\n',
        'Resets 3pm (Asia/Tokyo)\r\n',
        'Current week (all models)\r\n',
        '██████████████           95% used\r\n',
        'Resets Feb 9, 9pm (Asia/Tokyo)\r\n',
        'Current week (Sonnet only)\r\n',
        '                         5% used\r\n',
        'Resets Feb 9, 9pm (Asia/Tokyo)\r\n',
      ].join('');
      const { mockSpawn } = createMockPty(outputData, 0);
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        ptySpawn: mockSpawn,
      });

      const result = await service.capture({ forceRefresh: true });

      expect(mockSpawn).toHaveBeenCalledWith(
        'cmd.exe',
        ['/c', 'claude'],
        expect.objectContaining({
          cols: 120,
          rows: 30,
        }),
      );
      expect(result).toEqual({
        'test-profile': {
          session: { percent: 95, resetsAt: '3pm' },
          weekly: { percent: 95, resetsAt: 'Feb 9, 9pm' },
          sonnet: { percent: 5, resetsAt: 'Feb 9, 9pm' },
        },
      });
    });

    it('resolves on pty exit even without rate limit data', async () => {
      const outputData = 'Some other output without rate limit info\n';
      const { mockSpawn } = createMockPty(outputData, 0);
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        ptySpawn: mockSpawn,
      });

      const result = await service.capture({ forceRefresh: true });

      expect(mockSpawn).toHaveBeenCalled();
      // _parseUsageOutput returns null for non-usage text, getCached includes profile with null data
      expect(result).toEqual({ 'test-profile': null });
    });

    it('keeps existing cache on capture exception', async () => {
      // Simulate ptySpawn throwing an error
      const mockSpawn = vi.fn(() => {
        throw new Error('pty spawn failed');
      });
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        ptySpawn: mockSpawn,
      });

      // Set up existing cache
      const existingData = { weekly: { percent: 80, resetsAt: 'Feb 8' } };
      service._cache.set('test-profile', {
        data: existingData,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 60000,
      });

      const result = await service.capture({ forceRefresh: true });

      expect(mockSpawn).toHaveBeenCalled();
      // Existing cache preserved when capture throws
      expect(result).toEqual({ 'test-profile': existingData });
    });

    it('captures usage data via /usage', async () => {
      // Use \r\n: VtScreenBuffer \n only moves cursor down, \r resets column to 0
      const outputData = [
        'Context:50%\r\n',
        'Current session\r\n',
        '██                       10% used\r\n',
        'Current week (all models)\r\n',
        '██                       20% used\r\n',
        'Current week (Sonnet only)\r\n',
        '                         5% used\r\n',
      ].join('');
      const { mockSpawn } = createMockPty(outputData, 0);
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        ptySpawn: mockSpawn,
      });

      const result = await service.capture({ forceRefresh: true });

      // /usage data at low percentages (below 70% banner threshold)
      expect(result['test-profile']).toEqual({
        session: { percent: 10, resetsAt: null },
        weekly: { percent: 20, resetsAt: null },
        sonnet: { percent: 5, resetsAt: null },
      });
    });
  });

  describe('_killPty', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
      });
    });

    it('calls ptyProcess.kill()', () => {
      const mockPty = { kill: vi.fn(), pid: 12345 };
      service._killPty(mockPty);
      expect(mockPty.kill).toHaveBeenCalled();
    });

    it('falls back to taskkill if kill() throws', async () => {
      const { execSync } = await import('child_process');
      const mockPty = {
        kill: vi.fn(() => {
          throw new Error('kill failed');
        }),
        pid: 12345,
      };

      service._killPty(mockPty);

      expect(mockPty.kill).toHaveBeenCalled();
      expect(execSync).toHaveBeenCalledWith('taskkill /F /T /PID 12345', {
        windowsHide: true,
      });
    });
  });

  describe('_mergeWithCached', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
      });
    });

    it('returns new data when newData is provided', () => {
      const newData = { weekly: { percent: 75, resetsAt: 'Feb 9' } };
      const result = service._mergeWithCached('test-profile', newData);
      expect(result).toBe(newData);
    });

    it('returns cached data when newData is null and cache not expired', () => {
      const existingData = { weekly: { percent: 80, resetsAt: 'Feb 8' } };
      service._cache.set('test-profile', {
        data: existingData,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });

      const result = service._mergeWithCached('test-profile', null);
      expect(result).toBe(existingData);
    });

    it('returns null when newData is null and cache is expired', () => {
      const existingData = { weekly: { percent: 80, resetsAt: 'Feb 8' } };
      service._cache.set('test-profile', {
        data: existingData,
        timestamp: Date.now(),
        expiresAt: Date.now() - 1000,
        refreshAt: Date.now() - 2000,
      });

      const result = service._mergeWithCached('test-profile', null);
      expect(result).toBeNull();
    });

    it('returns null when newData is null and no cache exists', () => {
      const result = service._mergeWithCached('unknown-profile', null);
      expect(result).toBeNull();
    });
  });

  describe('setManualCache', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
      });
    });

    it('stores data in cache with expiry and refresh times', async () => {
      const data = { weekly: { percent: 100, resetsAt: 'Feb 14, 6am' } };
      service.setManualCache('test-profile', data);

      const cached = service.getCached();
      expect(cached).not.toBeNull();
      expect(cached['test-profile']).toBe(data);
    });

    it('sets expiresAt based on reset time', async () => {
      const { RATE_LIMIT_CACHE_MS } = await import('../config.js');
      const data = { weekly: { percent: 100, resetsAt: 'Feb 14, 6am' } };
      service.setManualCache('test-profile', data);

      const entry = service._cache.get('test-profile');
      expect(entry.expiresAt).toBeGreaterThan(Date.now());
      expect(entry.refreshAt).toBeGreaterThan(Date.now());
    });

    it('stores null data with default expiry', async () => {
      const { RATE_LIMIT_CACHE_MS } = await import('../config.js');
      const before = Date.now();
      service.setManualCache('test-profile', null);

      const entry = service._cache.get('test-profile');
      expect(entry.data).toBeNull();
      expect(entry.expiresAt).toBeGreaterThanOrEqual(before + RATE_LIMIT_CACHE_MS - 1000);
    });

    it('stores timestamp on set', () => {
      const before = Date.now();
      service.setManualCache('test-profile', null);
      const entry = service._cache.get('test-profile');
      expect(entry.timestamp).toBeGreaterThanOrEqual(before);
      expect(entry.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('saves cache to disk after setting', async () => {
      const fs = await import('fs');
      service.setManualCache('test-profile', { weekly: { percent: 50, resetsAt: 'Feb 9' } });
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('getSafeProfile', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['profile-a', 'profile-b', 'profile-c'],
      });
    });

    it('returns null when no cached data exists', () => {
      expect(service.getSafeProfile()).toBeNull();
    });

    it('returns profile with no data (below capture threshold = safe)', () => {
      // profile-a has data above threshold, profile-b has no data (safe)
      service._cache.set('profile-a', {
        data: { weekly: { percent: 95, resetsAt: 'Feb 9' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });
      service._cache.set('profile-b', {
        data: null,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });

      const result = service.getSafeProfile('profile-a');
      expect(result).toBe('profile-b');
    });

    it('returns profile below AUTO_SWITCH_THRESHOLD', async () => {
      const { AUTO_SWITCH_THRESHOLD } = await import('../config.js');
      service._cache.set('profile-a', {
        data: { weekly: { percent: 95, resetsAt: 'Feb 9' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });
      service._cache.set('profile-b', {
        data: { weekly: { percent: AUTO_SWITCH_THRESHOLD - 1, resetsAt: 'Feb 9' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });

      const result = service.getSafeProfile('profile-a');
      expect(result).toBe('profile-b');
    });

    it('excludes the specified profile', () => {
      service._cache.set('profile-a', {
        data: null,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });
      service._cache.set('profile-b', {
        data: null,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });

      const result = service.getSafeProfile('profile-a');
      expect(result).toBe('profile-b');
      expect(result).not.toBe('profile-a');
    });

    it('returns null when all cached profiles are at threshold or above and no uncached profiles', async () => {
      // Service with only 2 profiles, both above threshold
      const serviceTwo = new RateLimitService('/fake/root', {
        getProfiles: () => ['profile-a', 'profile-b'],
      });
      const { AUTO_SWITCH_THRESHOLD } = await import('../config.js');
      serviceTwo._cache.set('profile-a', {
        data: { weekly: { percent: AUTO_SWITCH_THRESHOLD, resetsAt: 'Feb 9' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });
      serviceTwo._cache.set('profile-b', {
        data: { weekly: { percent: AUTO_SWITCH_THRESHOLD + 5, resetsAt: 'Feb 9' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });

      expect(serviceTwo.getSafeProfile('profile-a')).toBeNull();
    });

    it('uses max of weekly/session/sonnet for threshold comparison', async () => {
      const { AUTO_SWITCH_THRESHOLD } = await import('../config.js');
      // Service with only profile-a and profile-b (no profile-c)
      const serviceTwo = new RateLimitService('/fake/root', {
        getProfiles: () => ['profile-a', 'profile-b'],
      });
      // profile-b: weekly low but session high - should NOT be safe
      serviceTwo._cache.set('profile-b', {
        data: {
          weekly: { percent: 10, resetsAt: 'Feb 9' },
          session: { percent: AUTO_SWITCH_THRESHOLD, resetsAt: '3pm' },
        },
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });

      expect(serviceTwo.getSafeProfile('profile-a')).toBeNull();
    });
  });

  describe('getEarliestResetTime', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['profile-a', 'profile-b'],
      });
    });

    it('returns null when no cache entries exist', () => {
      expect(service.getEarliestResetTime()).toBeNull();
    });

    it('returns null when no reset times are parseable', () => {
      service._cache.set('profile-a', {
        data: null,
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });
      expect(service.getEarliestResetTime()).toBeNull();
    });

    it('returns earliest reset time across all profiles and types', () => {
      service._cache.set('profile-a', {
        data: {
          weekly: { percent: 90, resetsAt: 'Feb 21, 6am' },
          session: { percent: 80, resetsAt: '3pm' },
        },
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });

      const result = service.getEarliestResetTime();
      expect(result).toBeTypeOf('number');
      expect(result).toBeGreaterThan(Date.now());
    });

    it('returns minimum of multiple reset dates', () => {
      service._cache.set('profile-a', {
        data: { weekly: { percent: 90, resetsAt: 'Feb 21, 6am' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });
      service._cache.set('profile-b', {
        data: { session: { percent: 50, resetsAt: '3pm' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 10000,
        refreshAt: Date.now() + 5000,
      });

      const result = service.getEarliestResetTime();
      const sessionParsed = service._parseResetsAt('3pm');
      const weeklyParsed = service._parseResetsAt('Feb 21, 6am');
      const expected = Math.min(sessionParsed.getTime(), weeklyParsed.getTime());
      expect(result).toBe(expected);
    });
  });

  describe('recomputeRefreshTimes', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 1, 21, 10, 0, 0, 0));
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['profile-a'],
        isIdle: () => true, // starts idle (long refresh)
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shortens refreshAt when new value is earlier', () => {
      // Idle service: refreshAt set to 2h from now
      const idleRefreshAt = Date.now() + 2 * 60 * 60 * 1000;
      service._cache.set('profile-a', {
        data: { weekly: { percent: 95, resetsAt: 'Feb 22' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        refreshAt: idleRefreshAt,
      });

      // Now service becomes busy
      service._isIdle = () => false;
      service.recomputeRefreshTimes();

      const entry = service._cache.get('profile-a');
      // Busy + 95% → 5min refresh, much less than 2h idle
      expect(entry.refreshAt).toBeLessThan(idleRefreshAt);
    });

    it('does not update refreshAt when new value is not earlier', () => {
      // Already has 5min refresh (busy, high percent)
      const busyRefreshAt = Date.now() + 5 * 60 * 1000;
      service._cache.set('profile-a', {
        data: { weekly: { percent: 95, resetsAt: 'Feb 22' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        refreshAt: busyRefreshAt,
      });

      service.recomputeRefreshTimes();

      const entry = service._cache.get('profile-a');
      // Should remain unchanged since new value (2h idle) > existing (5min)
      expect(entry.refreshAt).toBe(busyRefreshAt);
    });

    it('saves cache to disk when any refreshAt changes', async () => {
      const fs = await import('fs');
      vi.clearAllMocks();

      const idleRefreshAt = Date.now() + 2 * 60 * 60 * 1000;
      service._cache.set('profile-a', {
        data: { weekly: { percent: 95, resetsAt: 'Feb 22' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        refreshAt: idleRefreshAt,
      });

      service._isIdle = () => false;
      service.recomputeRefreshTimes();

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('does not save when no refreshAt values changed', async () => {
      const fs = await import('fs');
      vi.clearAllMocks();

      // Already at 5min refresh (lower than idle 2h), so no change
      const busyRefreshAt = Date.now() + 5 * 60 * 1000;
      service._cache.set('profile-a', {
        data: { weekly: { percent: 95, resetsAt: 'Feb 22' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        refreshAt: busyRefreshAt,
      });

      // Stays idle → would produce 2h refresh, but existing is 5min → no change
      service.recomputeRefreshTimes();

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('_checkAutoSwitch', () => {
    let onAutoSwitch;

    beforeEach(() => {
      onAutoSwitch = vi.fn();
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['profile-a', 'profile-b'],
        getActiveProfile: () => 'profile-a',
        onAutoSwitch,
      });
    });

    it('does nothing when no callback provided', () => {
      const serviceNoCallback = new RateLimitService('/fake/root', {
        getProfiles: () => ['profile-a'],
        getActiveProfile: () => 'profile-a',
      });
      // Should not throw
      serviceNoCallback._checkAutoSwitch({
        'profile-a': { weekly: { percent: 95, resetsAt: 'Feb 9' } },
      });
    });

    it('does nothing when cached data is null', () => {
      service._checkAutoSwitch(null);
      expect(onAutoSwitch).not.toHaveBeenCalled();
    });

    it('does nothing when active profile has no data', () => {
      const cached = { 'profile-a': null, 'profile-b': null };
      service._checkAutoSwitch(cached);
      expect(onAutoSwitch).not.toHaveBeenCalled();
    });

    it('does nothing when active profile is below threshold', async () => {
      const { AUTO_SWITCH_THRESHOLD } = await import('../config.js');
      const cached = {
        'profile-a': { weekly: { percent: AUTO_SWITCH_THRESHOLD - 1, resetsAt: 'Feb 9' } },
        'profile-b': null,
      };
      service._checkAutoSwitch(cached);
      expect(onAutoSwitch).not.toHaveBeenCalled();
    });

    it('triggers auto-switch when active profile at threshold and safe profile exists', async () => {
      const { AUTO_SWITCH_THRESHOLD } = await import('../config.js');
      const cached = {
        'profile-a': { weekly: { percent: AUTO_SWITCH_THRESHOLD, resetsAt: 'Feb 9' } },
        'profile-b': null, // no data = below threshold = safe
      };
      service._checkAutoSwitch(cached);
      expect(onAutoSwitch).toHaveBeenCalledWith('profile-b');
    });

    it('does not trigger auto-switch when no safe profile exists', async () => {
      const { AUTO_SWITCH_THRESHOLD } = await import('../config.js');
      const cached = {
        'profile-a': { weekly: { percent: AUTO_SWITCH_THRESHOLD, resetsAt: 'Feb 9' } },
        'profile-b': { weekly: { percent: AUTO_SWITCH_THRESHOLD, resetsAt: 'Feb 9' } },
      };
      service._checkAutoSwitch(cached);
      expect(onAutoSwitch).not.toHaveBeenCalled();
    });

    it('does not switch when only the active profile exists in cache (no other safe profile)', async () => {
      const { AUTO_SWITCH_THRESHOLD } = await import('../config.js');
      // Service with only profile-a registered
      const serviceOneProfile = new RateLimitService('/fake/root', {
        getProfiles: () => ['profile-a'],
        getActiveProfile: () => 'profile-a',
        onAutoSwitch,
      });
      const cached = {
        'profile-a': { weekly: { percent: AUTO_SWITCH_THRESHOLD, resetsAt: 'Feb 9' } },
      };
      serviceOneProfile._checkAutoSwitch(cached);
      expect(onAutoSwitch).not.toHaveBeenCalled();
    });

    it('uses max of weekly/session/sonnet for threshold comparison', async () => {
      const { AUTO_SWITCH_THRESHOLD } = await import('../config.js');
      const cached = {
        // profile-a: weekly low, session at threshold → should trigger
        'profile-a': {
          weekly: { percent: 10, resetsAt: 'Feb 9' },
          session: { percent: AUTO_SWITCH_THRESHOLD, resetsAt: '3pm' },
        },
        'profile-b': null,
      };
      service._checkAutoSwitch(cached);
      expect(onAutoSwitch).toHaveBeenCalledWith('profile-b');
    });
  });

  describe('_parseUsageOutput - edge cases', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
      });
    });

    it('strips null bytes from input text', () => {
      const text = 'Current session\n\x00██ 50% used\nResets 3pm (Asia/Tokyo)';
      const result = service._parseUsageOutput(text);
      expect(result).not.toBeNull();
      expect(result.session.percent).toBe(50);
    });

    it('parses session with minutes in time (5:59am)', () => {
      const text = [
        'Current session',
        '████████ 28% used',
        'Resets 11am (Asia/Tokyo)',
        'Current week (all models)',
        '██ 4% used',
        'Resets Feb 21, 5:59am (Asia/Tokyo)',
      ].join('\n');
      const result = service._parseUsageOutput(text);
      expect(result.weekly.percent).toBe(4);
      expect(result.weekly.resetsAt).toBe('Feb 21, 5:59am');
    });

    it('returns null when sections found but no percent matches', () => {
      const text = 'Current session\nNo percentage here\nCurrent week (all models)\nAlso nothing';
      const result = service._parseUsageOutput(text);
      expect(result).toBeNull();
    });

    it('handles Sonnet only section with correct type key', () => {
      const text = [
        'Current week (Sonnet only)',
        '                         15% used',
        'Resets Feb 21, 6am (Asia/Tokyo)',
      ].join('\n');
      const result = service._parseUsageOutput(text);
      expect(result).not.toBeNull();
      expect(result.sonnet).toBeDefined();
      expect(result.sonnet.percent).toBe(15);
      expect(result.sonnet.resetsAt).toBe('Feb 21, 6am');
    });
  });

  describe('_parseResetsAt - additional patterns', () => {
    beforeEach(() => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
      });
    });

    it('parses "Feb 21, 5:59am" with minutes correctly', () => {
      const result = service._parseResetsAt('Feb 21, 5:59am');
      expect(result).toBeInstanceOf(Date);
      expect(result.getMonth()).toBe(1); // Feb
      expect(result.getDate()).toBe(21);
      expect(result.getHours()).toBe(5);
      expect(result.getMinutes()).toBe(59);
    });

    it('parses "12am" as midnight (hour=0)', () => {
      const result = service._parseResetsAt('12am');
      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(0);
    });

    it('parses "12pm" as noon (hour=12)', () => {
      const result = service._parseResetsAt('12pm');
      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(12);
    });

    it('parses "11pm" as hour 23', () => {
      const result = service._parseResetsAt('11pm');
      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(23);
    });

    it('parses "Jan 1" with year rollover logic', () => {
      const result = service._parseResetsAt('Jan 1');
      expect(result).toBeInstanceOf(Date);
      expect(result.getMonth()).toBe(0); // Jan
      expect(result.getDate()).toBe(1);
    });

    it('returns null for non-string input (number)', () => {
      expect(service._parseResetsAt(123)).toBeNull();
    });
  });

  describe('capture - forceRefresh', () => {
    it('refreshes all profiles when forceRefresh is true', async () => {
      const { mockSpawn } = createMockPty('Context:50%\r\nCurrent session\r\n80% used\r\n', 0);
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        ptySpawn: mockSpawn,
      });

      // Pre-populate cache with fresh data (would normally skip refresh)
      service._cache.set('test-profile', {
        data: { weekly: { percent: 50, resetsAt: 'Feb 9' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 100000,
        refreshAt: Date.now() + 100000,
      });

      // With forceRefresh: should still call pty
      await service.capture({ forceRefresh: true });
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('does not call pty when cache is fresh and forceRefresh is false', async () => {
      const { mockSpawn } = createMockPty();
      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        ptySpawn: mockSpawn,
      });

      // Pre-populate fresh cache
      service._cache.set('test-profile', {
        data: { weekly: { percent: 50, resetsAt: 'Feb 9' } },
        timestamp: Date.now(),
        expiresAt: Date.now() + 100000,
        refreshAt: Date.now() + 100000,
      });

      await service.capture({ forceRefresh: false });
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('returns null when no profiles are configured', async () => {
      service = new RateLimitService('/fake/root', {
        getProfiles: () => [],
      });
      const result = await service.capture();
      expect(result).toBeNull();
    });
  });

  describe('_runCaptureForked', () => {
    let mockChild;
    let forkMock;

    beforeEach(async () => {
      const cp = await import('child_process');
      forkMock = cp.fork;

      const handlers = {};
      mockChild = {
        on: vi.fn((event, cb) => {
          handlers[event] = handlers[event] || [];
          handlers[event].push(cb);
        }),
        send: vi.fn(),
        kill: vi.fn(),
        _handlers: handlers,
        _emit(event, ...args) {
          (handlers[event] || []).forEach((cb) => cb(...args));
        },
      };
      forkMock.mockReturnValue(mockChild);

      service = new RateLimitService('/fake/root', {
        getProfiles: () => ['test-profile'],
        // No ptySpawn → triggers fork path
      });
    });

    it('resolves with text on successful IPC result', async () => {
      const promise = service._runCaptureForked({ FORCE_COLOR: '0' });
      // Worker sends result
      mockChild._emit('message', { type: 'result', text: 'usage output text' });
      const result = await promise;
      expect(result).toBe('usage output text');
    });

    it('resolves with empty string on worker error message', async () => {
      const promise = service._runCaptureForked({ FORCE_COLOR: '0' });
      mockChild._emit('message', { type: 'error', message: 'node-pty crash' });
      const result = await promise;
      expect(result).toBe('');
    });

    it('resolves with empty string on worker crash (exit)', async () => {
      const promise = service._runCaptureForked({ FORCE_COLOR: '0' });
      mockChild._emit('exit', 1, 'SIGSEGV');
      const result = await promise;
      expect(result).toBe('');
    });

    it('resolves with empty string on worker spawn error', async () => {
      const promise = service._runCaptureForked({ FORCE_COLOR: '0' });
      mockChild._emit('error', new Error('spawn ENOENT'));
      const result = await promise;
      expect(result).toBe('');
    });

    it('sends start message to worker with correct params', async () => {
      const promise = service._runCaptureForked({ FORCE_COLOR: '0' });
      mockChild._emit('message', { type: 'result', text: '' });
      await promise;

      expect(mockChild.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'start',
          cols: 120,
          rows: 30,
          env: { FORCE_COLOR: '0' },
        }),
      );
    });

    it('resolves with empty string on parent-side timeout', async () => {
      vi.useFakeTimers();
      try {
        const promise = service._runCaptureForked({ FORCE_COLOR: '0' });
        // Advance past parent timeout (RATE_LIMIT_CAPTURE_TIMEOUT_MS + 5000)
        vi.advanceTimersByTime(25001);
        const result = await promise;
        expect(result).toBe('');
        expect(mockChild.kill).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
