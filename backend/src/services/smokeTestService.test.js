import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmokeTestService } from './smokeTestService.js';

function makeMockEmailService() {
  return { sendHtml: vi.fn().mockResolvedValue(undefined) };
}

function makeMockLogStreamer() {
  return { broadcastAll: vi.fn() };
}

function makeMockRateLimitService(captureResult = null, cachedResult = null) {
  return {
    capture: vi.fn().mockResolvedValue(captureResult),
    getCached: vi.fn().mockReturnValue(cachedResult),
  };
}

function makeMockClaudeService(profile = 'google') {
  return {
    getCcsProfile: vi.fn().mockReturnValue(profile),
    executeUpdateAnalysis: vi.fn((prompt, onComplete) => {
      process.nextTick(() => {
        onComplete({ lastAssistantText: 'ROOT_CAUSE: test\nAFFECTED_FILES: none' }, 0);
      });
      return 'exec-smoke-123';
    }),
  };
}

const VALID_VERSION_OUTPUT = '1.2.3\n';

const VALID_STREAM_OUTPUT = [
  JSON.stringify({ type: 'system', session_id: 'sess-123' }),
  JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'ok' }] }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
].join('\n');

const VALID_PTY_CAPTURE = {
  google: { data: { session: { percent: 50 }, weekly: { percent: 30 } } },
};

describe('SmokeTestService', () => {
  let emailService;
  let logStreamer;
  let rateLimitService;
  let claudeService;

  beforeEach(() => {
    emailService = makeMockEmailService();
    logStreamer = makeMockLogStreamer();
    rateLimitService = makeMockRateLimitService();
    claudeService = makeMockClaudeService();
    vi.clearAllMocks();
  });

  describe('result aggregation', () => {
    it('all pass — reports 3 passed and 0 failed', async () => {
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      service._spawnWithTimeout = vi
        .fn()
        .mockResolvedValueOnce({ stdout: VALID_VERSION_OUTPUT, exitCode: 0, duration: 100 })
        .mockResolvedValueOnce({ stdout: VALID_STREAM_OUTPUT, exitCode: 0, duration: 200 });

      rateLimitService.capture = vi.fn().mockResolvedValue(VALID_PTY_CAPTURE);
      rateLimitService.getCached = vi.fn().mockReturnValue(null);

      const result = await service.runAll();

      expect(result.passed.length).toBe(3);
      expect(result.failed.length).toBe(0);
    });

    it('some fail — stream-json fails, others pass', async () => {
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      service._spawnWithTimeout = vi
        .fn()
        .mockResolvedValueOnce({ stdout: VALID_VERSION_OUTPUT, exitCode: 0, duration: 100 })
        .mockResolvedValueOnce({ stdout: '', exitCode: 1, duration: 200 });

      rateLimitService.capture = vi.fn().mockResolvedValue(VALID_PTY_CAPTURE);
      rateLimitService.getCached = vi.fn().mockReturnValue(null);

      const result = await service.runAll();

      expect(result.passed.length).toBe(2);
      expect(result.failed.length).toBe(1);
      expect(result.failed[0].name).toBe('stream-json');
    });

    it('all fail — reports 0 passed and 3 failed', async () => {
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      service._spawnWithTimeout = vi
        .fn()
        .mockResolvedValue({ stdout: '', exitCode: 1, duration: 100 });

      rateLimitService.capture = vi.fn().mockResolvedValue(null);
      rateLimitService.getCached = vi.fn().mockReturnValue(null);

      const result = await service.runAll();

      expect(result.passed.length).toBe(0);
      expect(result.failed.length).toBe(3);
    });
  });

  describe('email alert', () => {
    it('sends email with [SMOKE FAIL] subject and HTML table on failure', async () => {
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      service._spawnWithTimeout = vi
        .fn()
        .mockResolvedValue({ stdout: '', exitCode: 1, duration: 100 });

      rateLimitService.capture = vi.fn().mockResolvedValue(null);
      rateLimitService.getCached = vi.fn().mockReturnValue(null);

      await service.runAll();

      expect(emailService.sendHtml).toHaveBeenCalledTimes(1);
      const [subject, html] = emailService.sendHtml.mock.calls[0];
      expect(subject).toContain('[SMOKE FAIL]');
      expect(html).toContain('<table');
    });

    it('triggers Claude analysis execution on failure', async () => {
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      service._spawnWithTimeout = vi
        .fn()
        .mockResolvedValue({ stdout: '', exitCode: 1, duration: 100 });

      rateLimitService.capture = vi.fn().mockResolvedValue(null);
      rateLimitService.getCached = vi.fn().mockReturnValue(null);

      await service.runAll();

      expect(claudeService.executeUpdateAnalysis).toHaveBeenCalledTimes(1);
      const [prompt] = claudeService.executeUpdateAnalysis.mock.calls[0];
      expect(prompt).toContain('スモークテスト');
      expect(prompt).toContain('cli-binary');
    });

    it('does not trigger analysis when all tests pass', async () => {
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      service._spawnWithTimeout = vi
        .fn()
        .mockResolvedValueOnce({ stdout: VALID_VERSION_OUTPUT, exitCode: 0, duration: 100 })
        .mockResolvedValueOnce({ stdout: VALID_STREAM_OUTPUT, exitCode: 0, duration: 200 });

      rateLimitService.capture = vi.fn().mockResolvedValue(VALID_PTY_CAPTURE);
      rateLimitService.getCached = vi.fn().mockReturnValue(null);

      await service.runAll();

      expect(claudeService.executeUpdateAnalysis).not.toHaveBeenCalled();
    });

    it('does not send email when all tests pass', async () => {
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      service._spawnWithTimeout = vi
        .fn()
        .mockResolvedValueOnce({ stdout: VALID_VERSION_OUTPUT, exitCode: 0, duration: 100 })
        .mockResolvedValueOnce({ stdout: VALID_STREAM_OUTPUT, exitCode: 0, duration: 200 });

      rateLimitService.capture = vi.fn().mockResolvedValue(VALID_PTY_CAPTURE);
      rateLimitService.getCached = vi.fn().mockReturnValue(null);

      await service.runAll();

      expect(emailService.sendHtml).not.toHaveBeenCalled();
    });
  });

  describe('rate limit pre-check skip', () => {
    it('skips stream-json when weekly rate > 95%', async () => {
      const highRateCache = {
        google: { data: { weekly: { percent: 96 } } },
      };
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      service._spawnWithTimeout = vi
        .fn()
        .mockResolvedValue({ stdout: VALID_VERSION_OUTPUT, exitCode: 0, duration: 100 });

      rateLimitService.getCached = vi.fn().mockReturnValue(highRateCache);
      rateLimitService.capture = vi.fn().mockResolvedValue(VALID_PTY_CAPTURE);

      const result = await service.runAll();

      const streamResult = result.results.find((r) => r.name === 'stream-json');
      expect(streamResult).toBeDefined();
      expect(streamResult.status).toBe('skipped');
    });

    it('skips pty-usage when weekly rate > 80%', async () => {
      const highRateCache = {
        google: { data: { weekly: { percent: 85 } } },
      };
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      service._spawnWithTimeout = vi
        .fn()
        .mockResolvedValueOnce({ stdout: VALID_VERSION_OUTPUT, exitCode: 0, duration: 100 })
        .mockResolvedValueOnce({ stdout: VALID_STREAM_OUTPUT, exitCode: 0, duration: 200 });

      rateLimitService.getCached = vi.fn().mockReturnValue(highRateCache);

      const result = await service.runAll();

      const ptyResult = result.results.find((r) => r.name === 'pty-usage');
      expect(ptyResult).toBeDefined();
      expect(ptyResult.status).toBe('skipped');
    });

    it('cli-binary always runs regardless of rate limit', async () => {
      const maxRateCache = {
        google: { data: { weekly: { percent: 100 } } },
      };
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      const spawnMock = vi
        .fn()
        .mockResolvedValue({ stdout: VALID_VERSION_OUTPUT, exitCode: 0, duration: 100 });
      service._spawnWithTimeout = spawnMock;

      rateLimitService.getCached = vi.fn().mockReturnValue(maxRateCache);

      await service.runAll();

      // cli-binary should have been called (at least one spawn call)
      expect(spawnMock).toHaveBeenCalled();
      const firstCallArgs = spawnMock.mock.calls[0];
      // First call should be cli-binary check (claude --version or similar)
      expect(firstCallArgs).toBeDefined();
    });
  });

  describe('timeout handling', () => {
    it('per-test timeout — marks result as fail with timeout error', async () => {
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      service._spawnWithTimeout = vi.fn().mockRejectedValue(new Error('timeout'));
      rateLimitService.getCached = vi.fn().mockReturnValue(null);
      rateLimitService.capture = vi.fn().mockRejectedValue(new Error('timeout'));

      const result = await service.runAll();

      expect(result.failed.length).toBeGreaterThan(0);
      const failedTest = result.failed[0];
      expect(failedTest.status).toBe('fail');
      expect(failedTest.error).toMatch(/timeout/i);
    });
  });

  describe('stop() cleanup', () => {
    it('kills all active processes when stop() is called', () => {
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      const mockProcess1 = { kill: vi.fn() };
      const mockProcess2 = { kill: vi.fn() };
      service._activeProcesses = [mockProcess1, mockProcess2];

      service.stop();

      expect(mockProcess1.kill).toHaveBeenCalledTimes(1);
      expect(mockProcess2.kill).toHaveBeenCalledTimes(1);
    });
  });

  describe('CLAUDE_CONFIG_DIR', () => {
    it('stream-json sets CLAUDE_CONFIG_DIR env based on CCS profile', async () => {
      const profile = 'google';
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService: makeMockClaudeService(profile),
      });

      const spawnMock = vi
        .fn()
        .mockResolvedValueOnce({ stdout: VALID_VERSION_OUTPUT, exitCode: 0, duration: 100 })
        .mockResolvedValueOnce({ stdout: VALID_STREAM_OUTPUT, exitCode: 0, duration: 200 });
      service._spawnWithTimeout = spawnMock;

      rateLimitService.getCached = vi.fn().mockReturnValue(null);
      rateLimitService.capture = vi.fn().mockResolvedValue(VALID_PTY_CAPTURE);

      await service.runAll();

      // Find the stream-json spawn call (second call, index 1)
      expect(spawnMock).toHaveBeenCalledTimes(2);
      const streamJsonCall = spawnMock.mock.calls[1];
      // Fourth argument (index 3) is the env object
      const env = streamJsonCall[3];
      expect(env).toBeDefined();
      expect(env.CLAUDE_CONFIG_DIR).toBeDefined();
      expect(env.CLAUDE_CONFIG_DIR).toContain(profile);
    });
  });

  describe('isRunning / getLastResult', () => {
    it('isRunning returns false initially and getLastResult returns null', () => {
      const service = new SmokeTestService({
        emailService,
        logStreamer,
        rateLimitService,
        claudeService,
      });

      expect(service.isRunning()).toBe(false);
      expect(service.getLastResult()).toBeNull();
    });
  });
});
