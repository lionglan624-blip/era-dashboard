import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { createExecutionRouter } from './execution.js';

// Lightweight supertest alternative: use node http for route testing
async function request(app, method, url, body = null) {
  const http = await import('http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const options = {
        hostname: '127.0.0.1',
        port,
        path: url,
        method: method.toUpperCase(),
        headers: body ? { 'Content-Type': 'application/json' } : {},
      };

      const req = http.default.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          server.close();
          resolve({
            status: res.statusCode,
            body: data ? JSON.parse(data) : null,
          });
        });
      });

      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function createMockClaudeService() {
  return {
    executeCommand: vi.fn(() => 'test-uuid'),
    getExecution: vi.fn(() => ({
      id: 'test-uuid',
      featureId: '100',
      command: 'fl',
      status: 'running',
    })),
    getExecutionLogs: vi.fn(() => []),
    removeExecution: vi.fn(() => false),
    killExecution: vi.fn(() => true),
    openTerminal: vi.fn(() => ({ tabTitle: 'FL F100', command: '/fl 100' })),
    resumeInBrowser: vi.fn(() => ({ executionId: 'new-uuid', sessionId: 'session-1' })),
    resumeInTerminal: vi.fn(() => ({ tabTitle: 'RESUME F100', sessionId: 'session-1' })),
    listExecutions: vi.fn(() => []),
    runShellCommand: vi.fn(() => ({ command: 'cs', status: 'launched' })),
    executeSlashCommand: vi.fn(() => 'slash-uuid'),
    getHistory: vi.fn(() => []),
    clearHistory: vi.fn(),
    getDiagnostics: vi.fn(() => ({
      execution: { id: 'test-uuid', status: 'running' },
      subscribers: { count: 1, clients: [{ clientId: 1, readyState: 1 }] },
      chain: { parentId: null, retryCount: 0, contextRetryCount: 0, history: [] },
      queuePosition: -1,
    })),
    getQueueStatus: vi.fn(() => ({
      maxConcurrent: 4,
      runningCount: 0,
      queuedCount: 0,
      chainSlotCount: 0,
      rateLimitRetryAt: null,
      serverErrorRetryAt: null,
      queued: [],
      running: [],
    })),
    runLockFeatureId: null,
    acquireRunLock: vi.fn(),
  };
}

function createMockFeatureService() {
  return {
    getAllFeatures: vi.fn(() => ({
      features: [],
      index: { phases: [], recentlyCompleted: [] },
    })),
  };
}

function createApp(claudeService, featureService) {
  const app = express();
  app.use(express.json());
  app.use('/api/execution', createExecutionRouter(claudeService, featureService));
  return app;
}

describe('Execution Routes', () => {
  describe('UUID param validation', () => {
    it('rejects invalid UUID format', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'GET', '/api/execution/not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid execution ID');
    });

    it('accepts valid UUID format', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'GET', '/api/execution/12345678-1234-1234-1234-123456789abc');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /fl', () => {
    it('requires featureId', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/fl', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('featureId is required');
    });

    it('starts FL execution', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/fl', { featureId: '100' });
      expect(res.status).toBe(200);
      expect(mock.executeCommand).toHaveBeenCalledWith('100', 'fl', { chain: false });
    });

    it('passes chain flag', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      await request(app, 'POST', '/api/execution/fl', { featureId: '100', chain: true });
      expect(mock.executeCommand).toHaveBeenCalledWith('100', 'fl', { chain: true });
    });
  });

  describe('POST /fc', () => {
    it('starts FC execution', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/fc', { featureId: '200' });
      expect(res.status).toBe(200);
      expect(mock.executeCommand).toHaveBeenCalledWith('200', 'fc', { chain: false });
    });
  });

  describe('POST /run', () => {
    it('starts run execution', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/run', { featureId: '300' });
      expect(res.status).toBe(200);
      expect(mock.executeCommand).toHaveBeenCalledWith('300', 'run', { chain: false });
    });
  });

  describe('POST /shell', () => {
    it('rejects invalid shell commands', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/shell', { command: 'rm' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid shell command');
    });

    it('accepts cs command', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/shell', { command: 'cs' });
      expect(res.status).toBe(200);
      expect(mock.runShellCommand).toHaveBeenCalledWith('cs');
    });

    it('accepts dr command', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/shell', { command: 'dr' });
      expect(res.status).toBe(200);
    });

    it('requires command field', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/shell', {});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /slash', () => {
    it('rejects invalid slash commands', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/slash', { command: 'run' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid slash command');
    });

    it('accepts commit command', async () => {
      const mock = createMockClaudeService();
      mock.getExecution.mockReturnValue({
        id: 'slash-uuid',
        command: 'commit',
        status: 'running',
      });
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/slash', { command: 'commit' });
      expect(res.status).toBe(200);
      expect(mock.executeSlashCommand).toHaveBeenCalledWith('commit');
    });

    it('accepts sync-deps command', async () => {
      const mock = createMockClaudeService();
      mock.getExecution.mockReturnValue({
        id: 'slash-uuid',
        command: 'sync-deps',
        status: 'running',
      });
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/slash', {
        command: 'sync-deps',
      });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /terminal', () => {
    it('requires both featureId and command', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/terminal', { featureId: '100' });
      expect(res.status).toBe(400);
    });

    it('opens terminal', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/terminal', {
        featureId: '100',
        command: 'fl',
      });
      expect(res.status).toBe(200);
      expect(mock.openTerminal).toHaveBeenCalledWith('100', 'fl');
    });
  });

  describe('GET /history', () => {
    it('returns empty array when no history', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'GET', '/api/execution/history');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(mock.getHistory).toHaveBeenCalled();
    });

    it('returns history entries from service', async () => {
      const mock = createMockClaudeService();
      const entries = [
        {
          executionId: 'exec-1',
          featureId: '100',
          command: 'fl',
          status: 'completed',
          exitCode: 0,
          sessionId: 'session-1',
          startedAt: '2026-03-04T10:00:00.000Z',
          completedAt: '2026-03-04T10:05:00.000Z',
          contextPercent: 42,
        },
        {
          executionId: 'exec-2',
          featureId: '200',
          command: 'run',
          status: 'failed',
          exitCode: 1,
          sessionId: null,
          startedAt: '2026-03-04T09:00:00.000Z',
          completedAt: '2026-03-04T09:30:00.000Z',
          contextPercent: 85,
        },
      ];
      mock.getHistory.mockReturnValue(entries);
      const app = createApp(mock);
      const res = await request(app, 'GET', '/api/execution/history');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].executionId).toBe('exec-1');
      expect(res.body[1].command).toBe('run');
    });

    it('is not intercepted by UUID param validator', async () => {
      // "history" is not a UUID, ensure it routes to GET /history not GET /:id
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'GET', '/api/execution/history');
      expect(res.status).toBe(200);
      expect(mock.getExecution).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /history', () => {
    it('clears history', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'DELETE', '/api/execution/history');
      expect(res.status).toBe(200);
      expect(res.body.cleared).toBe(true);
      expect(mock.clearHistory).toHaveBeenCalled();
    });

    it('behavior: clear then get returns empty', async () => {
      const mock = createMockClaudeService();
      // Simulate: getHistory returns data before clear, empty after
      mock.getHistory
        .mockReturnValueOnce([{ executionId: 'e1', status: 'completed' }])
        .mockReturnValueOnce([]);
      const app = createApp(mock);

      // Step 1: History has entries
      const before = await request(app, 'GET', '/api/execution/history');
      expect(before.body).toHaveLength(1);

      // Step 2: Clear
      const del = await request(app, 'DELETE', '/api/execution/history');
      expect(del.status).toBe(200);

      // Step 3: History is empty
      const after = await request(app, 'GET', '/api/execution/history');
      expect(after.body).toHaveLength(0);
    });
  });

  describe('DELETE /:id', () => {
    it('removes finished execution via removeExecution', async () => {
      const mock = createMockClaudeService();
      mock.removeExecution.mockReturnValue(true);
      const app = createApp(mock);
      const res = await request(
        app,
        'DELETE',
        '/api/execution/12345678-1234-1234-1234-123456789abc',
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('removed');
      expect(mock.removeExecution).toHaveBeenCalledWith('12345678-1234-1234-1234-123456789abc');
      expect(mock.killExecution).not.toHaveBeenCalled();
    });

    it('falls back to killExecution for running execution', async () => {
      const mock = createMockClaudeService();
      // removeExecution returns false (not finished), killExecution returns true
      mock.removeExecution.mockReturnValue(false);
      mock.killExecution.mockReturnValue(true);
      const app = createApp(mock);
      const res = await request(
        app,
        'DELETE',
        '/api/execution/12345678-1234-1234-1234-123456789abc',
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('killed');
      expect(mock.killExecution).toHaveBeenCalledWith('12345678-1234-1234-1234-123456789abc');
    });

    it('returns 404 when neither remove nor kill succeeds', async () => {
      const mock = createMockClaudeService();
      mock.removeExecution.mockReturnValue(false);
      mock.killExecution.mockReturnValue(false);
      const app = createApp(mock);
      const res = await request(
        app,
        'DELETE',
        '/api/execution/12345678-1234-1234-1234-123456789abc',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /:id/resume/browser', () => {
    it('sanitizes prompt input', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      await request(
        app,
        'POST',
        '/api/execution/12345678-1234-1234-1234-123456789abc/resume/browser',
        {
          prompt: 'continue\x00\x01with\x0Bcontrol',
        },
      );
      // Control chars should be stripped (except \n, \r, \t which are allowed)
      expect(mock.resumeInBrowser).toHaveBeenCalledWith(
        '12345678-1234-1234-1234-123456789abc',
        expect.not.stringContaining('\x00'),
      );
    });

    it('truncates overly long prompts', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const longPrompt = 'x'.repeat(20000);
      await request(
        app,
        'POST',
        '/api/execution/12345678-1234-1234-1234-123456789abc/resume/browser',
        {
          prompt: longPrompt,
        },
      );
      const calledPrompt = mock.resumeInBrowser.mock.calls[0][1];
      expect(calledPrompt.length).toBeLessThanOrEqual(10000);
    });

    it('defaults to "continue" when no prompt', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      await request(
        app,
        'POST',
        '/api/execution/12345678-1234-1234-1234-123456789abc/resume/browser',
        {},
      );
      expect(mock.resumeInBrowser).toHaveBeenCalledWith(
        '12345678-1234-1234-1234-123456789abc',
        'continue',
      );
    });
  });

  describe('GET /:id/logs', () => {
    it('returns logs with offset', async () => {
      const mock = createMockClaudeService();
      mock.getExecutionLogs.mockReturnValue([
        { line: 'test', timestamp: new Date().toISOString() },
      ]);
      const app = createApp(mock);
      const res = await request(
        app,
        'GET',
        '/api/execution/12345678-1234-1234-1234-123456789abc/logs?offset=5',
      );
      expect(res.status).toBe(200);
      expect(mock.getExecutionLogs).toHaveBeenCalledWith('12345678-1234-1234-1234-123456789abc', 5);
    });

    it('returns 404 for non-existent execution', async () => {
      const mock = createMockClaudeService();
      mock.getExecutionLogs.mockReturnValue(null);
      const app = createApp(mock);
      const res = await request(
        app,
        'GET',
        '/api/execution/12345678-1234-1234-1234-123456789abc/logs',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /queue/bulk', () => {
    it('queues multiple features and returns full execution objects', async () => {
      const mock = createMockClaudeService();
      mock.bulkQueue = vi.fn(() => ({
        queued: [
          { id: 'exec-100', featureId: '100', command: 'run' },
          { id: 'exec-200', featureId: '200', command: 'run' },
        ],
        skipped: [],
      }));
      mock.getExecution
        .mockReturnValueOnce({ id: 'exec-100', featureId: '100', command: 'run', status: 'queued' })
        .mockReturnValueOnce({
          id: 'exec-200',
          featureId: '200',
          command: 'run',
          status: 'queued',
        });
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/queue/bulk', {
        featureIds: ['100', '200'],
      });
      expect(res.status).toBe(200);
      expect(res.body.queued).toHaveLength(2);
      expect(res.body.queued[0].id).toBe('exec-100');
      expect(res.body.queued[1].id).toBe('exec-200');
      expect(res.body.skipped).toHaveLength(0);
      expect(mock.bulkQueue).toHaveBeenCalledWith(['100', '200']);
    });

    it('returns empty result for empty array', async () => {
      const mock = createMockClaudeService();
      mock.bulkQueue = vi.fn(() => ({ queued: [], skipped: [] }));
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/queue/bulk', { featureIds: [] });
      expect(res.status).toBe(200);
      expect(res.body.queued).toHaveLength(0);
      expect(res.body.skipped).toHaveLength(0);
    });

    it('returns 400 for non-array featureIds', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/queue/bulk', {
        featureIds: '100',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('featureIds must be an array');
    });

    it('returns 400 for missing featureIds', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/queue/bulk', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('featureIds must be an array');
    });

    it('returns 400 when exceeding 30 items', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const featureIds = Array.from({ length: 31 }, (_, i) => String(i + 1));
      const res = await request(app, 'POST', '/api/execution/queue/bulk', { featureIds });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Maximum 30 features');
    });

    it('returns 400 for invalid feature ID in array', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/queue/bulk', {
        featureIds: ['100', 'abc'],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid feature ID');
    });

    it('deduplicates feature IDs', async () => {
      const mock = createMockClaudeService();
      mock.bulkQueue = vi.fn(() => ({
        queued: [{ id: 'exec-100', featureId: '100', command: 'run' }],
        skipped: [],
      }));
      mock.getExecution.mockReturnValueOnce({
        id: 'exec-100',
        featureId: '100',
        command: 'run',
        status: 'queued',
      });
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/queue/bulk', {
        featureIds: ['100', '100', '100'],
      });
      expect(res.status).toBe(200);
      expect(mock.bulkQueue).toHaveBeenCalledWith(['100']);
    });

    it('returns mixed result with queued and skipped items', async () => {
      const mock = createMockClaudeService();
      mock.bulkQueue = vi.fn(() => ({
        queued: [{ id: 'exec-100', featureId: '100', command: 'run' }],
        skipped: [{ featureId: '200', reason: 'already running' }],
      }));
      mock.getExecution.mockReturnValueOnce({
        id: 'exec-100',
        featureId: '100',
        command: 'run',
        status: 'queued',
      });
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/queue/bulk', {
        featureIds: ['100', '200'],
      });
      expect(res.status).toBe(200);
      expect(res.body.queued).toHaveLength(1);
      expect(res.body.skipped).toHaveLength(1);
      expect(res.body.skipped[0].featureId).toBe('200');
      expect(res.body.skipped[0].reason).toBe('already running');
    });

    it('handles service error gracefully', async () => {
      const mock = createMockClaudeService();
      mock.bulkQueue = vi.fn(() => {
        throw new Error('Queue unavailable');
      });
      const app = createApp(mock);
      const res = await request(app, 'POST', '/api/execution/queue/bulk', {
        featureIds: ['100'],
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Queue unavailable');
    });
  });

  describe('GET /:id/diag', () => {
    it('returns diagnostics for existing execution', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(
        app,
        'GET',
        '/api/execution/12345678-1234-1234-1234-123456789abc/diag',
      );
      expect(res.status).toBe(200);
      expect(res.body.execution).toBeDefined();
      expect(res.body.subscribers).toBeDefined();
      expect(res.body.chain).toBeDefined();
      expect(res.body.queuePosition).toBe(-1);
    });

    it('returns 404 for non-existent execution', async () => {
      const mock = createMockClaudeService();
      mock.getDiagnostics.mockReturnValue(null);
      const app = createApp(mock);
      const res = await request(
        app,
        'GET',
        '/api/execution/12345678-1234-1234-1234-123456789abc/diag',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /status', () => {
    it('returns 200 with expected shape', async () => {
      const mock = createMockClaudeService();
      const featureMock = createMockFeatureService();
      const app = createApp(mock, featureMock);
      const res = await request(app, 'GET', '/api/execution/status');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.executions)).toBe(true);
      expect(Array.isArray(res.body.features)).toBe(true);
      expect(res.body.queue).toBeDefined();
      expect(res.body.queue.maxConcurrent).toBe(4);
      expect(res.body.queue.runningCount).toBe(0);
      expect(res.body.queue.queuedCount).toBe(0);
      expect(res.body.queue.chainSlotCount).toBe(0);
      expect(res.body.queue.rateLimitRetryAt).toBeNull();
      expect(res.body.queue.serverErrorRetryAt).toBeNull();
      expect(res.body.runLockFeatureId).toBeNull();
    });

    it('excludes completed and failed executions', async () => {
      const mock = createMockClaudeService();
      mock.listExecutions.mockReturnValue([
        {
          id: 'exec-running',
          featureId: '100',
          command: 'run',
          status: 'running',
          phase: 3,
          phaseName: 'Implementation',
          startedAt: '2026-03-20T10:00:00.000Z',
          contextPercent: 42,
          ccsProfile: 'apple',
        },
        {
          id: 'exec-completed',
          featureId: '200',
          command: 'fl',
          status: 'completed',
          phase: null,
          phaseName: null,
          startedAt: '2026-03-20T09:00:00.000Z',
          contextPercent: 80,
          ccsProfile: 'apple',
        },
        {
          id: 'exec-failed',
          featureId: '300',
          command: 'fc',
          status: 'failed',
          phase: null,
          phaseName: null,
          startedAt: '2026-03-20T08:00:00.000Z',
          contextPercent: 20,
          ccsProfile: 'apple',
        },
      ]);
      const featureMock = createMockFeatureService();
      const app = createApp(mock, featureMock);
      const res = await request(app, 'GET', '/api/execution/status');
      expect(res.status).toBe(200);
      expect(res.body.executions).toHaveLength(1);
      expect(res.body.executions[0].id).toBe('exec-running');
    });

    it('excludes [DONE] and [CANCELLED] features', async () => {
      const mock = createMockClaudeService();
      const featureMock = createMockFeatureService();
      featureMock.getAllFeatures.mockReturnValue({
        features: [
          {
            id: '978',
            status: '[PROPOSED]',
            name: 'Active feature',
            phase: 'Phase 26',
            pendingDeps: '',
          },
          {
            id: '979',
            status: '[DONE]',
            name: 'Done feature',
            phase: 'Phase 26',
            pendingDeps: '',
          },
          {
            id: '980',
            status: '[CANCELLED]',
            name: 'Cancelled feature',
            phase: 'Phase 26',
            pendingDeps: '',
          },
          {
            id: '981',
            status: '[DONE]',
            name: 'Recently completed',
            phase: 'Recently Completed',
            pendingDeps: '',
          },
        ],
        index: { phases: [], recentlyCompleted: [] },
      });
      const app = createApp(mock, featureMock);
      const res = await request(app, 'GET', '/api/execution/status');
      expect(res.status).toBe(200);
      expect(res.body.features).toHaveLength(1);
      expect(res.body.features[0].id).toBe('978');
      expect(res.body.features[0].status).toBe('[PROPOSED]');
    });

    it('merges depBlocked from queue status into queued executions', async () => {
      const mock = createMockClaudeService();
      mock.listExecutions.mockReturnValue([
        {
          id: 'exec-queued',
          featureId: '978',
          command: 'run',
          status: 'queued',
          phase: null,
          phaseName: null,
          startedAt: '2026-03-20T10:00:00.000Z',
          contextPercent: 0,
          ccsProfile: 'apple',
        },
      ]);
      mock.getQueueStatus.mockReturnValue({
        maxConcurrent: 4,
        runningCount: 0,
        queuedCount: 1,
        chainSlotCount: 0,
        rateLimitRetryAt: null,
        serverErrorRetryAt: null,
        queued: [
          {
            id: 'exec-queued',
            featureId: '978',
            command: 'run',
            depBlocked: true,
            pendingDeps: ['F977'],
          },
        ],
        running: [],
      });
      const featureMock = createMockFeatureService();
      const app = createApp(mock, featureMock);
      const res = await request(app, 'GET', '/api/execution/status');
      expect(res.status).toBe(200);
      expect(res.body.executions).toHaveLength(1);
      expect(res.body.executions[0].depBlocked).toBe(true);
      expect(res.body.executions[0].pendingDeps).toEqual(['F977']);
    });

    it('exposes runLockFeatureId when run lock is held', async () => {
      const mock = createMockClaudeService();
      mock.runLockFeatureId = '978';
      const featureMock = createMockFeatureService();
      const app = createApp(mock, featureMock);
      const res = await request(app, 'GET', '/api/execution/status');
      expect(res.status).toBe(200);
      expect(res.body.runLockFeatureId).toBe('978');
    });

    it('works without featureService (returns empty features array)', async () => {
      const mock = createMockClaudeService();
      // No featureService passed
      const app = createApp(mock, null);
      const res = await request(app, 'GET', '/api/execution/status');
      expect(res.status).toBe(200);
      expect(res.body.features).toEqual([]);
    });
  });

  describe('POST /run-lock', () => {
    it('acquires run-lock for valid featureId', async () => {
      const mock = createMockClaudeService();
      const featureMock = createMockFeatureService();
      const app = createApp(mock, featureMock);
      const res = await request(app, 'POST', '/api/execution/run-lock', { featureId: '100' });
      expect(res.status).toBe(200);
      expect(res.body.acquired).toBe(true);
      expect(res.body.featureId).toBe('100');
      expect(mock.acquireRunLock).toHaveBeenCalledWith('100');
    });

    it('returns 400 when featureId is missing', async () => {
      const mock = createMockClaudeService();
      const featureMock = createMockFeatureService();
      const app = createApp(mock, featureMock);
      const res = await request(app, 'POST', '/api/execution/run-lock', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('featureId is required');
    });

    it('returns 409 when lock already held', async () => {
      const mock = createMockClaudeService();
      const err = new Error('Run-lock already held by F200');
      err.status = 409;
      mock.acquireRunLock.mockImplementation(() => {
        throw err;
      });
      const featureMock = createMockFeatureService();
      const app = createApp(mock, featureMock);
      const res = await request(app, 'POST', '/api/execution/run-lock', { featureId: '100' });
      expect(res.status).toBe(409);
      expect(res.body.acquired).toBe(false);
      expect(res.body.message).toContain('Run-lock already held');
    });
  });
});
