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
    killExecution: vi.fn(() => true),
    openTerminal: vi.fn(() => ({ tabTitle: 'FL F100', command: '/fl 100' })),
    resumeInBrowser: vi.fn(() => ({ executionId: 'new-uuid', sessionId: 'session-1' })),
    resumeInTerminal: vi.fn(() => ({ tabTitle: 'RESUME F100', sessionId: 'session-1' })),
    listExecutions: vi.fn(() => []),
    runShellCommand: vi.fn(() => ({ command: 'cs', status: 'launched' })),
    executeSlashCommand: vi.fn(() => 'slash-uuid'),
  };
}

function createApp(claudeService) {
  const app = express();
  app.use(express.json());
  app.use('/api/execution', createExecutionRouter(claudeService));
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
      mock.getExecution.mockReturnValue({ id: 'slash-uuid', command: 'commit', status: 'running' });
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
      const res = await request(app, 'POST', '/api/execution/slash', { command: 'sync-deps' });
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

  describe('DELETE /:id', () => {
    it('kills running execution', async () => {
      const mock = createMockClaudeService();
      const app = createApp(mock);
      const res = await request(
        app,
        'DELETE',
        '/api/execution/12345678-1234-1234-1234-123456789abc',
      );
      expect(res.status).toBe(200);
      expect(mock.killExecution).toHaveBeenCalledWith('12345678-1234-1234-1234-123456789abc');
    });

    it('returns 404 for non-existent execution', async () => {
      const mock = createMockClaudeService();
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
});
