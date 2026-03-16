import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DependencyUpdaterService } from './dependencyUpdaterService.js';

// Mock child_process.exec
vi.mock('child_process', () => ({
  exec: vi.fn((cmd, opts, cb) => {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    cb(null, { stdout: '', stderr: '' });
  }),
}));

// Mock exitHelpers
vi.mock('../utils/exitHelpers.js', () => ({
  exitWithPm2Update: vi.fn(),
  setPm2UpdatePending: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock fs for persistence tests
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => {
        throw new Error('ENOENT');
      }),
    },
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => {
      throw new Error('ENOENT');
    }),
  };
});

function makeMockEmailService() {
  return { sendHtml: vi.fn().mockResolvedValue(undefined) };
}

function makeMockLogStreamer() {
  return { broadcastAll: vi.fn() };
}

function makeMockClaudeService(idle = true) {
  return {
    getQueueStatus: vi.fn(() => ({
      runningCount: idle ? 0 : 1,
      queuedCount: 0,
      chainWaiterCount: 0,
      waitingForInputCount: 0,
      rateLimitQueue: [],
    })),
  };
}

function createService(overrides = {}) {
  return new DependencyUpdaterService({
    emailService: makeMockEmailService(),
    logStreamer: makeMockLogStreamer(),
    claudeService: makeMockClaudeService(true),
    ...overrides,
  });
}

describe('DependencyUpdaterService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Schedule calculation
  // =========================================================================

  describe('_msUntilNext0600JST', () => {
    it('returns ~1h when now is 05:00 JST (20:00 UTC)', () => {
      const service = createService();
      // 05:00 JST = 20:00 UTC
      const now = new Date('2026-03-14T20:00:00Z');
      const ms = service._msUntilNext0600JST(now);
      expect(ms).toBe(3600000); // 1 hour
    });

    it('returns ~23h when now is 07:00 JST (22:00 UTC)', () => {
      const service = createService();
      // 07:00 JST = 22:00 UTC previous day
      const now = new Date('2026-03-13T22:00:00Z');
      const ms = service._msUntilNext0600JST(now);
      // Next 21:00 UTC = next day
      expect(ms).toBe(23 * 3600000); // 23 hours
    });
  });

  describe('_msUntilNextMonday0630JST', () => {
    it('returns 1.5h when now is Mon 05:00 JST', () => {
      const service = createService();
      // Mon 05:00 JST = Sun 20:00 UTC
      const now = new Date('2026-03-15T20:00:00Z'); // Sunday
      const ms = service._msUntilNextMonday0630JST(now);
      expect(ms).toBe(1.5 * 3600000);
    });

    it('returns ~7 days when now is Mon 07:00 JST (past schedule)', () => {
      const service = createService();
      // Mon 07:00 JST = Sun 22:00 UTC
      const now = new Date('2026-03-15T22:00:00Z'); // Sunday 22:00 UTC = Mon 07:00 JST
      const ms = service._msUntilNextMonday0630JST(now);
      // Next Sunday 21:30 UTC is 6 days 23.5 hours away
      expect(ms).toBeCloseTo(6 * 24 * 3600000 + 23.5 * 3600000, -3);
    });
  });

  describe('_msUntilNextFirst0600JST', () => {
    it('targets next month when past the 1st', () => {
      const service = createService();
      // March 14, 2026 12:00 JST = March 14 03:00 UTC
      const now = new Date('2026-03-14T03:00:00Z');
      const ms = service._msUntilNextFirst0600JST(now);
      // April 1st 06:00 JST = March 31st 21:00 UTC
      const target = new Date('2026-03-31T21:00:00Z');
      expect(ms).toBe(target.getTime() - now.getTime());
    });

    it('targets current month 1st when before 06:00 JST on 1st', () => {
      const service = createService();
      // March 1, 05:00 JST = Feb 28, 20:00 UTC
      const now = new Date('2026-02-28T20:00:00Z');
      const ms = service._msUntilNextFirst0600JST(now);
      // March 1st 06:00 JST = Feb 28th 21:00 UTC
      expect(ms).toBe(3600000); // 1 hour
    });
  });

  // =========================================================================
  // start / stop
  // =========================================================================

  describe('start / stop', () => {
    it('registers 3 timeouts on start', () => {
      const service = createService();
      service.start();
      expect(service._dailyTimeout).not.toBeNull();
      expect(service._weeklyTimeout).not.toBeNull();
      expect(service._monthlyTimeout).not.toBeNull();
      service.stop();
    });

    it('clears all timeouts on stop', () => {
      const service = createService();
      service.start();
      service.stop();
      expect(service._dailyTimeout).toBeNull();
      expect(service._weeklyTimeout).toBeNull();
      expect(service._monthlyTimeout).toBeNull();
    });

    it('ignores duplicate start', () => {
      const service = createService();
      service.start();
      const t1 = service._dailyTimeout;
      service.start(); // should be no-op
      expect(service._dailyTimeout).toBe(t1);
      service.stop();
    });
  });

  // =========================================================================
  // _isIdle / _waitForIdle
  // =========================================================================

  describe('_isIdle', () => {
    it('returns true when all counts are zero', () => {
      const service = createService();
      expect(service._isIdle()).toBe(true);
    });

    it('returns false when running count > 0', () => {
      const service = createService({ claudeService: makeMockClaudeService(false) });
      expect(service._isIdle()).toBe(false);
    });

    it('returns true when claudeService is null', () => {
      const service = createService({ claudeService: null });
      expect(service._isIdle()).toBe(true);
    });
  });

  describe('_waitForIdle', () => {
    it('returns immediately when idle', async () => {
      const service = createService();
      const result = await service._waitForIdle(3);
      expect(result).toBe(true);
    });

    it('retries and succeeds when becomes idle', async () => {
      const claudeService = makeMockClaudeService(false);
      let callCount = 0;
      claudeService.getQueueStatus = vi.fn(() => {
        callCount++;
        return {
          runningCount: callCount < 3 ? 1 : 0,
          queuedCount: 0,
          chainWaiterCount: 0,
          waitingForInputCount: 0,
          rateLimitQueue: [],
        };
      });
      const service = createService({ claudeService });

      const promise = service._waitForIdle(5);
      // Advance timers to trigger retries
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(1800000);
      }
      const result = await promise;
      expect(result).toBe(true);
    });

    it('returns false after max retries', async () => {
      const service = createService({ claudeService: makeMockClaudeService(false) });

      const promise = service._waitForIdle(2);
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(1800000);
      }
      const result = await promise;
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // _runGlobal (Type A)
  // =========================================================================

  describe('_runGlobal', () => {
    it('reports version change', async () => {
      vi.useRealTimers();
      const service = createService();
      let callNum = 0;
      service._exec = vi.fn(async (cmd) => {
        if (cmd.includes('--version')) {
          callNum++;
          return { success: true, stdout: callNum <= 1 ? '1.0.0' : '1.1.0' };
        }
        return { success: true, stdout: '' };
      });

      const result = await service._runGlobal({
        name: 'Test',
        cmd: 'npm update -g test',
        versionCmd: 'test --version',
      });

      expect(result.success).toBe(true);
      expect(result.versionBefore).toBe('1.0.0');
      expect(result.versionAfter).toBe('1.1.0');
      expect(result.skipped).toBeUndefined();
    });

    it('skips when version unchanged', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async () => ({ success: true, stdout: '1.0.0' }));

      const result = await service._runGlobal({
        name: 'Test',
        cmd: 'npm update',
        versionCmd: 'test --version',
      });

      expect(result.skipped).toBe('already latest');
    });

    it('returns error on update failure', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async (cmd) => {
        if (cmd === 'npm update') return { success: false, error: 'network error' };
        return { success: true, stdout: '1.0.0' };
      });

      const result = await service._runGlobal({
        name: 'Test',
        cmd: 'npm update',
        versionCmd: 'test --version',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('network error');
    });

    it('runs postCmd when version changes', async () => {
      vi.useRealTimers();
      const service = createService();
      let callNum = 0;
      service._exec = vi.fn(async (cmd) => {
        if (cmd.includes('--version')) {
          callNum++;
          return { success: true, stdout: callNum <= 1 ? '1.0.0' : '1.1.0' };
        }
        return { success: true, stdout: '' };
      });

      await service._runGlobal({
        name: 'Test',
        cmd: 'npm update -g test',
        versionCmd: 'test --version',
        postCmd: 'test reload',
      });

      expect(service._exec).toHaveBeenCalledWith('test reload', { timeout: 5000 });
    });

    it('sets pendingReload flag for PM2 when version changes', async () => {
      vi.useRealTimers();
      const service = createService();
      let callNum = 0;
      service._exec = vi.fn(async (cmd) => {
        if (cmd.includes('--version')) {
          callNum++;
          return { success: true, stdout: callNum <= 1 ? '5.3.0' : '5.4.0' };
        }
        return { success: true, stdout: '' };
      });

      const result = await service._runGlobal({
        name: 'PM2',
        cmd: 'npm update -g pm2',
        versionCmd: 'pm2 --version',
      });

      expect(result.pendingReload).toBe(true);
      expect(result.versionBefore).toBe('5.3.0');
      expect(result.versionAfter).toBe('5.4.0');
    });

    it('does not set pendingReload for PM2 when version unchanged', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async () => ({ success: true, stdout: '5.3.0' }));

      const result = await service._runGlobal({
        name: 'PM2',
        cmd: 'npm update -g pm2',
        versionCmd: 'pm2 --version',
      });

      expect(result.pendingReload).toBeUndefined();
      expect(result.skipped).toBe('already latest');
    });
  });

  // =========================================================================
  // _runCheckOnly (NuGet)
  // =========================================================================

  describe('_runCheckOnly', () => {
    it('parses outdated packages', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async () => ({
        success: true,
        stdout: [
          'Project `devkit` has the following updates:',
          '   [net10.0]:',
          '   Top-level Package      Requested   Resolved   Latest',
          '   > Moq                  4.18.0      4.18.0     4.20.0',
          '   > xunit                2.5.0       2.5.0      2.6.0',
        ].join('\n'),
      }));

      const result = await service._runCheckOnly({
        name: 'NuGet',
        cmd: 'dotnet list package --outdated',
      });

      expect(result.success).toBe(true);
      expect(result.outdated).toHaveLength(2);
      expect(result.outdated[0].package).toBe('Moq');
      expect(result.outdated[0].latest).toBe('4.20.0');
    });

    it('returns empty outdated when all current', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async () => ({
        success: true,
        stdout: 'All packages are up to date.',
      }));

      const result = await service._runCheckOnly({ name: 'NuGet', cmd: 'check' });
      expect(result.outdated).toHaveLength(0);
    });

    it('returns error on command failure', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async () => ({ success: false, error: 'wsl not found' }));

      const result = await service._runCheckOnly({ name: 'NuGet', cmd: 'check' });
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // _runRepoPipeline (Type B)
  // =========================================================================

  describe('_runRepoPipeline', () => {
    it('commits when update + test pass', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async () => ({ success: true, stdout: '' }));
      service._gitDiff = vi.fn(async () => ['go.mod', 'go.sum']);
      service._gitCommit = vi.fn(async () => {});

      const result = await service._runRepoPipeline({
        name: 'Go',
        repoDir: 'C:\\Era\\devkit',
        cmd: 'go get -u ./...',
        testCmd: 'go test ./...',
        commitFiles: ['go.mod', 'go.sum'],
        commitMsg: 'chore(deps): update Go',
      });

      expect(result.committed).toBe(true);
      expect(service._gitCommit).toHaveBeenCalled();
    });

    it('skips when no changes', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async () => ({ success: true, stdout: '' }));
      service._gitDiff = vi.fn(async () => []);

      const result = await service._runRepoPipeline({
        name: 'Go',
        repoDir: 'C:\\Era\\devkit',
        cmd: 'go get -u',
        testCmd: 'go test',
        commitFiles: [],
        commitMsg: 'chore',
      });

      expect(result.skipped).toBe('no changes');
    });

    it('reverts when test fails', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async (cmd) => {
        if (cmd.includes('test')) return { success: false, error: 'test failed' };
        return { success: true, stdout: '' };
      });
      service._gitDiff = vi.fn(async () => ['go.mod']);
      service._gitStashRevert = vi.fn(async () => {});

      const result = await service._runRepoPipeline({
        name: 'Go',
        repoDir: 'C:\\Era\\devkit',
        cmd: 'go get -u',
        testCmd: 'go test',
        commitFiles: ['go.mod'],
        commitMsg: 'chore',
      });

      expect(result.success).toBe(false);
      expect(result.reverted).toBe(true);
      expect(service._gitStashRevert).toHaveBeenCalled();
    });

    it('returns error when update fails', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async () => ({ success: false, error: 'network' }));

      const result = await service._runRepoPipeline({
        name: 'Go',
        repoDir: 'C:\\',
        cmd: 'go get',
        testCmd: 'go test',
        commitFiles: [],
        commitMsg: 'chore',
      });

      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // _runPipPipeline
  // =========================================================================

  describe('_runPipPipeline', () => {
    it('succeeds when version changes and tests pass', async () => {
      vi.useRealTimers();
      const service = createService();
      let callNum = 0;
      service._exec = vi.fn(async (cmd) => {
        if (cmd.includes('pip show')) {
          callNum++;
          return {
            success: true,
            stdout:
              callNum <= 1
                ? 'Name: pytest\nVersion: 7.0.0\n---\nName: pyyaml\nVersion: 6.0'
                : 'Name: pytest\nVersion: 7.1.0\n---\nName: pyyaml\nVersion: 6.0',
          };
        }
        return { success: true, stdout: '' };
      });

      const result = await service._runPipPipeline({
        name: 'pip',
        cmd: 'pip install --upgrade pytest pyyaml',
        versionCmd: 'pip show pytest pyyaml',
        testCmd: 'pytest',
        testCwd: 'C:\\Era\\devkit',
      });

      expect(result.success).toBe(true);
    });

    it('skips when no version change', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async () => ({
        success: true,
        stdout: 'Name: pytest\nVersion: 7.0.0\n---\nName: pyyaml\nVersion: 6.0',
      }));

      const result = await service._runPipPipeline({
        name: 'pip',
        cmd: 'pip install --upgrade',
        versionCmd: 'pip show pytest pyyaml',
        testCmd: 'pytest',
        testCwd: 'C:\\Era\\devkit',
      });

      expect(result.skipped).toBe('already latest');
    });

    it('rolls back when test fails', async () => {
      vi.useRealTimers();
      const service = createService();
      let callNum = 0;
      service._exec = vi.fn(async (cmd) => {
        if (cmd.includes('pip show')) {
          callNum++;
          return {
            success: true,
            stdout: callNum <= 1 ? 'Name: pytest\nVersion: 7.0.0' : 'Name: pytest\nVersion: 7.1.0',
          };
        }
        if (cmd.includes('pytest')) return { success: false, error: 'test failed' };
        return { success: true, stdout: '' };
      });

      const result = await service._runPipPipeline({
        name: 'pip',
        cmd: 'pip upgrade',
        versionCmd: 'pip show pytest pyyaml',
        testCmd: 'pytest',
        testCwd: 'C:\\Era\\devkit',
      });

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      // Should have called pip install with pinned version
      expect(service._exec).toHaveBeenCalledWith(expect.stringContaining('pytest==7.0.0'));
    });
  });

  // =========================================================================
  // needsIdle behavior
  // =========================================================================

  describe('needsIdle', () => {
    it('skips item when not idle and needsIdle is true', async () => {
      vi.useRealTimers();
      const claudeService = makeMockClaudeService(false);
      const service = createService({ claudeService });
      // Override _waitForIdle to fail immediately
      service._waitForIdle = vi.fn(async () => false);

      const results = await service._runTier('daily', [
        {
          name: 'PM2',
          type: 'global',
          cmd: 'npm update -g pm2',
          versionCmd: 'pm2 --version',
          needsIdle: true,
        },
      ]);

      expect(results[0].skipped).toBe('not idle');
    });

    it('runs item without idle check when needsIdle is false', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async () => ({ success: true, stdout: '1.0.0' }));

      const results = await service._runTier('daily', [
        {
          name: 'CCS',
          type: 'global',
          cmd: 'npm update -g ccs',
          versionCmd: 'ccs --version',
          needsIdle: false,
        },
      ]);

      expect(results[0].success).toBe(true);
    });
  });

  // =========================================================================
  // _runTier batch
  // =========================================================================

  describe('_runTier', () => {
    it('continues after one item fails', async () => {
      vi.useRealTimers();
      const service = createService();
      let callIdx = 0;
      service._exec = vi.fn(async () => {
        callIdx++;
        if (callIdx <= 2) return { success: false, error: 'fail' }; // First item version + update
        return { success: true, stdout: '1.0.0' };
      });

      const results = await service._runTier('daily', [
        { name: 'A', type: 'global', cmd: 'a', versionCmd: 'a --v', needsIdle: false },
        { name: 'B', type: 'global', cmd: 'b', versionCmd: 'b --v', needsIdle: false },
      ]);

      expect(results).toHaveLength(2);
    });

    it('rejects concurrent run of same tier', async () => {
      vi.useRealTimers();
      const service = createService();
      // Make _exec hang
      service._exec = vi.fn(() => new Promise(() => {}));

      // Start first run (will hang)
      const p1 = service._runTier('daily', [
        { name: 'A', type: 'global', cmd: 'a', versionCmd: 'a --v', needsIdle: false },
      ]);

      // Second run should see running flag
      const results = await service._runTier('daily', [
        { name: 'B', type: 'global', cmd: 'b', versionCmd: 'b --v', needsIdle: false },
      ]);

      expect(results).toEqual([]);
    });
  });

  // =========================================================================
  // Email
  // =========================================================================

  describe('_sendSummaryEmail', () => {
    it('sends email when changes exist', async () => {
      vi.useRealTimers();
      const emailService = makeMockEmailService();
      const service = createService({ emailService });

      await service._sendSummaryEmail('daily', [
        { name: 'CCS', success: true, versionBefore: '1.0', versionAfter: '1.1' },
      ]);

      expect(emailService.sendHtml).toHaveBeenCalledWith(
        expect.stringContaining('[Dep-Update] daily'),
        expect.stringContaining('1.0'),
      );
    });

    it('does not send email when all skipped', async () => {
      vi.useRealTimers();
      const emailService = makeMockEmailService();
      const service = createService({ emailService });

      await service._sendSummaryEmail('daily', [
        { name: 'CCS', success: true, skipped: 'already latest' },
      ]);

      expect(emailService.sendHtml).not.toHaveBeenCalled();
    });

    it('sends email for NuGet outdated packages', async () => {
      vi.useRealTimers();
      const emailService = makeMockEmailService();
      const service = createService({ emailService });

      await service._sendSummaryEmail('monthly', [
        {
          name: 'NuGet',
          success: true,
          outdated: [{ package: 'Moq', current: '4.18', latest: '4.20' }],
        },
      ]);

      expect(emailService.sendHtml).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Weekly summary
  // =========================================================================

  describe('_sendWeeklySummary', () => {
    it('sends summary email with all tiers', async () => {
      vi.useRealTimers();
      const emailService = makeMockEmailService();
      const service = createService({ emailService });

      // Populate results
      service._lastResults.set('daily', {
        timestamp: new Date().toISOString(),
        results: [{ name: 'CCS', success: true, skipped: 'already latest' }],
      });
      service._lastResults.set('weekly', {
        timestamp: new Date().toISOString(),
        results: [{ name: 'CodeRabbit', success: true, versionBefore: '2.0', versionAfter: '2.1' }],
      });

      await service._sendWeeklySummary();

      expect(emailService.sendHtml).toHaveBeenCalledWith(
        expect.stringContaining('[Dep-Summary] Weekly'),
        expect.stringContaining('CCS'),
      );
    });

    it('shows "No recent results" for tiers without data', async () => {
      vi.useRealTimers();
      const emailService = makeMockEmailService();
      const service = createService({ emailService });

      await service._sendWeeklySummary();

      expect(emailService.sendHtml).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('No recent results'),
      );
    });

    it('shows pendingReload for PM2', async () => {
      vi.useRealTimers();
      const emailService = makeMockEmailService();
      const service = createService({ emailService });

      service._lastResults.set('weekly', {
        timestamp: new Date().toISOString(),
        results: [
          {
            name: 'PM2',
            success: true,
            versionBefore: '5.3.0',
            versionAfter: '5.4.0',
            pendingReload: true,
          },
        ],
      });

      await service._sendWeeklySummary();

      expect(emailService.sendHtml).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('daemon reload pending'),
      );
    });

    it('does not send when emailService is null', async () => {
      vi.useRealTimers();
      const service = createService({ emailService: null });
      // Should not throw
      await service._sendWeeklySummary();
    });
  });

  describe('weekly email suppression', () => {
    it('does not send per-tier email for weekly tier', async () => {
      vi.useRealTimers();
      const emailService = makeMockEmailService();
      const service = createService({ emailService });
      service._exec = vi.fn(async () => ({ success: true, stdout: '1.0.0' }));

      await service._runTier('weekly', [
        { name: 'Test', type: 'global', cmd: 'a', versionCmd: 'a --v', needsIdle: false },
      ]);

      // Should not have sent [Dep-Update] weekly email
      const calls = emailService.sendHtml.mock.calls;
      const hasDepUpdate = calls.some(([subject]) => subject.includes('[Dep-Update]'));
      expect(hasDepUpdate).toBe(false);
    });

    it('still sends per-tier email for daily tier', async () => {
      vi.useRealTimers();
      const emailService = makeMockEmailService();
      const service = createService({ emailService });
      let callNum = 0;
      service._exec = vi.fn(async (cmd) => {
        if (cmd.includes('--v')) {
          callNum++;
          return { success: true, stdout: callNum <= 1 ? '1.0.0' : '1.1.0' };
        }
        return { success: true, stdout: '' };
      });

      await service._runTier('daily', [
        { name: 'CCS', type: 'global', cmd: 'a', versionCmd: 'a --v', needsIdle: false },
      ]);

      expect(emailService.sendHtml).toHaveBeenCalledWith(
        expect.stringContaining('[Dep-Update] daily'),
        expect.any(String),
      );
    });
  });

  // =========================================================================
  // Persistence
  // =========================================================================

  describe('persistence', () => {
    it('_loadResults handles missing file gracefully', () => {
      const service = createService();
      // readFileSync is mocked to throw ENOENT
      expect(() => service._loadResults()).not.toThrow();
      expect(service._lastResults.size).toBe(0);
    });

    it('getStatus returns lastRun after _runTier', async () => {
      vi.useRealTimers();
      const service = createService();
      service._exec = vi.fn(async () => ({ success: true, stdout: '1.0.0' }));

      await service._runTier('daily', [
        { name: 'CCS', type: 'global', cmd: 'a', versionCmd: 'a --v', needsIdle: false },
      ]);

      const status = service.getStatus();
      expect(status.daily.lastRun).not.toBeNull();
      expect(status.daily.lastRun.results).toHaveLength(1);
    });
  });

  // =========================================================================
  // triggerTier
  // =========================================================================

  describe('triggerTier', () => {
    it('throws on unknown tier', async () => {
      vi.useRealTimers();
      const service = createService();
      await expect(service.triggerTier('invalid')).rejects.toThrow('Unknown tier');
    });

    it('throws when tier already running', async () => {
      vi.useRealTimers();
      const service = createService();
      service._running.set('daily', true);
      await expect(service.triggerTier('daily')).rejects.toThrow('already running');
    });
  });

  // =========================================================================
  // getStatus
  // =========================================================================

  describe('getStatus', () => {
    it('returns initial state', () => {
      const service = createService();
      const status = service.getStatus();
      expect(status.daily.running).toBe(false);
      expect(status.daily.lastRun).toBeNull();
      expect(status.weekly.running).toBe(false);
      expect(status.monthly.running).toBe(false);
    });
  });
});
