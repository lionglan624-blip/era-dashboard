import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatusMailService } from './statusMailService.js';

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    user: 'test@gmail.com',
    pass: 'secret',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    statusMail: {
      enabled: true,
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      reconnectDelayMs: 10000,
    },
    ...overrides,
  };
}

function makeAsyncIterable(items) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function makeMockImapClient() {
  const handlers = {};
  const mockLock = { release: vi.fn() };
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    getMailboxLock: vi.fn().mockResolvedValue(mockLock),
    fetch: vi.fn().mockReturnValue(makeAsyncIterable([])),
    search: vi.fn().mockResolvedValue([]),
    messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event, handler) => {
      handlers[event] = handler;
    }),
    close: vi.fn(),
    _handlers: handlers,
    _mockLock: mockLock,
  };
}

function makeMockServices() {
  return {
    featureService: {
      getAllFeatures: vi.fn().mockReturnValue({
        features: [
          {
            id: '100',
            status: '[WIP]',
            name: 'Test Feature',
            type: 'engine',
            progress: { acs: { total: 3, completed: 1 }, tasks: { total: 5, completed: 2 } },
          },
          {
            id: '200',
            status: '[DONE]',
            name: 'Done Feature',
            type: 'erb',
            progress: { acs: { total: 2, completed: 2 }, tasks: { total: 3, completed: 3 } },
          },
          { id: '300', status: '[REVIEWED]', name: 'Reviewed Feature', type: 'kojo' },
        ],
      }),
    },
    claudeService: {
      getQueueStatus: vi.fn().mockReturnValue({
        runningCount: 1,
        queuedCount: 1,
        running: [{ id: 'x', featureId: '100', command: 'fl', phase: 2, phaseName: 'FL Review' }],
        queued: [{ id: 'y', featureId: '200', command: 'run' }],
      }),
      listExecutions: vi
        .fn()
        .mockReturnValue([
          {
            id: 'x',
            featureId: '100',
            command: 'fl',
            status: 'running',
            phase: 2,
            phaseName: 'FL Review',
            contextPercent: 45,
          },
        ]),
    },
    rateLimitService: {
      getCached: vi.fn().mockReturnValue({
        google: {
          weekly: { percent: 85, resetsAt: 'Feb 13, 8am' },
          session: { percent: 42, resetsAt: '3pm' },
        },
      }),
    },
  };
}

describe('StatusMailService', () => {
  describe('disabled states', () => {
    it('disabled when config.enabled=false', () => {
      const service = new StatusMailService({
        configLoader: () => ({ enabled: false, statusMail: { enabled: true } }),
      });
      expect(service.enabled).toBe(false);
      expect(service.transporter).toBeNull();
    });

    it('disabled when statusMail.enabled=false', () => {
      const service = new StatusMailService({
        configLoader: () => ({
          enabled: true,
          user: 'test@gmail.com',
          statusMail: { enabled: false },
        }),
      });
      expect(service.enabled).toBe(false);
    });

    it('disabled when user empty (enabled but no transporter)', () => {
      const service = new StatusMailService({
        configLoader: () => ({ enabled: true, user: '', statusMail: { enabled: true } }),
      });
      expect(service.enabled).toBe(false);
      expect(service.transporter).toBeNull();
    });

    it('disabled when statusMail missing from config', () => {
      const service = new StatusMailService({
        configLoader: () => ({ enabled: true, user: 'test@gmail.com' }),
      });
      expect(service.enabled).toBe(false);
    });
  });

  describe('_isStatusRequest', () => {
    let service;

    beforeEach(() => {
      service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...makeMockServices(),
      });
    });

    it('accepts empty subject and empty body from self', () => {
      const envelope = {
        from: [{ address: 'test@gmail.com' }],
        subject: '',
      };
      const rawSource = Buffer.from('From: test@gmail.com\r\nSubject: \r\n\r\n');
      expect(service._isStatusRequest(envelope, rawSource)).toBe(true);
    });

    it('rejects Re: subject', () => {
      const envelope = {
        from: [{ address: 'test@gmail.com' }],
        subject: 'Re: Status',
      };
      const rawSource = Buffer.from('From: test@gmail.com\r\nSubject: Re: Status\r\n\r\n');
      expect(service._isStatusRequest(envelope, rawSource)).toBe(false);
    });

    it('rejects non-whitelisted sender', () => {
      const envelope = {
        from: [{ address: 'stranger@gmail.com' }],
        subject: '',
      };
      const rawSource = Buffer.from('From: stranger@gmail.com\r\nSubject: \r\n\r\n');
      expect(service._isStatusRequest(envelope, rawSource)).toBe(false);
    });

    it('accepts whitelisted sender from allowedSenders', () => {
      const svc = new StatusMailService({
        configLoader: () =>
          makeConfig({ statusMail: { enabled: true, allowedSenders: ['friend@icloud.com'] } }),
        ...makeMockServices(),
      });
      const envelope = {
        from: [{ address: 'friend@icloud.com' }],
        subject: '',
      };
      const rawSource = Buffer.from('From: friend@icloud.com\r\nSubject: \r\n\r\n');
      expect(svc._isStatusRequest(envelope, rawSource)).toBe(true);
    });

    it('rejects non-empty subject', () => {
      const envelope = {
        from: [{ address: 'test@gmail.com' }],
        subject: 'Status Request',
      };
      const rawSource = Buffer.from('From: test@gmail.com\r\nSubject: Status Request\r\n\r\n');
      expect(service._isStatusRequest(envelope, rawSource)).toBe(false);
    });

    it('rejects body with content', () => {
      const envelope = {
        from: [{ address: 'test@gmail.com' }],
        subject: '',
      };
      const rawSource = Buffer.from(
        'From: test@gmail.com\r\nSubject: \r\n\r\nPlease send me the full dashboard status report with details',
      );
      expect(service._isStatusRequest(envelope, rawSource)).toBe(false);
    });

    it('accepts truly empty email with no body separator', () => {
      const envelope = {
        from: [{ address: 'test@gmail.com' }],
        subject: '',
      };
      const rawSource = Buffer.from('From: test@gmail.com\r\nSubject: \r\n');
      expect(service._isStatusRequest(envelope, rawSource)).toBe(true);
    });

    it('accepts email with very short body', () => {
      const envelope = {
        from: [{ address: 'test@gmail.com' }],
        subject: '',
      };
      const rawSource = Buffer.from('From: test@gmail.com\r\nSubject: \r\n\r\n\r\n');
      expect(service._isStatusRequest(envelope, rawSource)).toBe(true);
    });

    it('case-insensitive email comparison', () => {
      const envelope = {
        from: [{ address: 'TEST@GMAIL.COM' }],
        subject: '',
      };
      const rawSource = Buffer.from('From: TEST@GMAIL.COM\r\nSubject: \r\n\r\n');
      expect(service._isStatusRequest(envelope, rawSource)).toBe(true);
    });
  });

  describe('_buildStatusReport', () => {
    it('includes all sections with data', () => {
      const mockServices = makeMockServices();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const report = service._buildStatusReport();

      expect(report).toContain('Dashboard Status Report');
      expect(report).toContain('--- Executions ---');
      expect(report).toContain('--- Rate Limits ---');
      expect(report).toContain('--- Features Summary ---');
    });

    it('shows running and queued executions', () => {
      const mockServices = makeMockServices();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const report = service._buildStatusReport();

      expect(report).toContain('Running: 1 | Queued: 1');
      expect(report).toContain('[Running] F100 fl');
      expect(report).toContain('[Queued]  F200 run');
    });

    it('shows rate limit data', () => {
      const mockServices = makeMockServices();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const report = service._buildStatusReport();

      expect(report).toContain('Profile: google');
      expect(report).toContain('85%');
    });

    it('shows feature summary with counts', () => {
      const mockServices = makeMockServices();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const report = service._buildStatusReport();

      expect(report).toContain('[DONE]: 1');
      expect(report).toContain('[WIP]: 1');
    });

    it('shows WIP feature details', () => {
      const mockServices = makeMockServices();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const report = service._buildStatusReport();

      expect(report).toContain('F100 engine');
      expect(report).toContain('AC: 1/3');
      expect(report).toContain('Tasks: 2/5');
    });

    it('handles idle state', () => {
      const mockServices = makeMockServices();
      mockServices.claudeService.getQueueStatus.mockReturnValue({
        runningCount: 0,
        queuedCount: 0,
        running: [],
        queued: [],
      });
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const report = service._buildStatusReport();

      expect(report).toContain('Running: 0 | Queued: 0');
      expect(report).toContain('(idle)');
    });

    it('handles null rate limit', () => {
      const mockServices = makeMockServices();
      mockServices.rateLimitService.getCached.mockReturnValue(null);
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const report = service._buildStatusReport();

      expect(report).toContain('(no data)');
    });

    it('handles missing services', () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        featureService: null,
        claudeService: null,
        rateLimitService: null,
      });

      const report = service._buildStatusReport();

      expect(report).toContain('(service unavailable)');
    });
  });

  describe('_formatExecutions', () => {
    it('formats running with phase and context', () => {
      const mockServices = makeMockServices();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const lines = service._formatExecutions();
      const joined = lines.join('\n');

      expect(joined).toContain('[Running] F100 fl Phase 2 "FL Review" (Context: 45%)');
    });

    it('formats queued', () => {
      const mockServices = makeMockServices();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const lines = service._formatExecutions();
      const joined = lines.join('\n');

      expect(joined).toContain('[Queued]  F200 run');
    });

    it('shows idle', () => {
      const mockServices = makeMockServices();
      mockServices.claudeService.getQueueStatus.mockReturnValue({
        runningCount: 0,
        queuedCount: 0,
        running: [],
        queued: [],
      });
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const lines = service._formatExecutions();
      const joined = lines.join('\n');

      expect(joined).toContain('(idle)');
    });

    it('handles execution without featureId', () => {
      const mockServices = makeMockServices();
      mockServices.claudeService.getQueueStatus.mockReturnValue({
        runningCount: 1,
        queuedCount: 0,
        running: [{ id: 'x', featureId: null, command: 'commit', phase: 1, phaseName: 'Commit' }],
        queued: [],
      });
      mockServices.claudeService.listExecutions.mockReturnValue([
        {
          id: 'x',
          featureId: null,
          command: 'commit',
          status: 'running',
          phase: 1,
          phaseName: 'Commit',
          contextPercent: 10,
        },
      ]);
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const lines = service._formatExecutions();
      const joined = lines.join('\n');

      expect(joined).toContain('[Running] commit commit');
    });
  });

  describe('_formatRateLimits', () => {
    it('formats weekly and session for profile', () => {
      const mockServices = makeMockServices();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const lines = service._formatRateLimits();
      const joined = lines.join('\n');

      expect(joined).toContain('Profile: google');
      expect(joined).toContain('Weekly: 85%');
      expect(joined).toContain('Session: 42%');
    });

    it('handles profile with only weekly data', () => {
      const mockServices = makeMockServices();
      mockServices.rateLimitService.getCached.mockReturnValue({
        google: { weekly: { percent: 60, resetsAt: 'Feb 14' } },
      });
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const lines = service._formatRateLimits();
      const joined = lines.join('\n');

      expect(joined).toContain('Weekly: 60%');
      expect(joined).not.toContain('Session:');
    });

    it('handles null cached data', () => {
      const mockServices = makeMockServices();
      mockServices.rateLimitService.getCached.mockReturnValue(null);
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const lines = service._formatRateLimits();
      const joined = lines.join('\n');

      expect(joined).toContain('(no data)');
    });
  });

  describe('_formatFeatureSummary', () => {
    it('counts by status', () => {
      const mockServices = makeMockServices();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const lines = service._formatFeatureSummary();
      const joined = lines.join('\n');

      expect(joined).toContain('[DONE]: 1 | [WIP]: 1 | [REVIEWED]: 1');
    });

    it('lists WIP features', () => {
      const mockServices = makeMockServices();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const lines = service._formatFeatureSummary();
      const joined = lines.join('\n');

      expect(joined).toContain('F100 engine - Test Feature (AC: 1/3, Tasks: 2/5)');
    });

    it('handles features without progress data', () => {
      const mockServices = makeMockServices();
      mockServices.featureService.getAllFeatures.mockReturnValue({
        features: [{ id: '400', status: '[WIP]', name: 'No Progress', type: 'infra' }],
      });
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const lines = service._formatFeatureSummary();
      const joined = lines.join('\n');

      expect(joined).toContain('F400 infra - No Progress');
      expect(joined).not.toContain('AC:');
    });

    it('handles empty feature list', () => {
      const mockServices = makeMockServices();
      mockServices.featureService.getAllFeatures.mockReturnValue({ features: [] });
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...mockServices,
      });

      const lines = service._formatFeatureSummary();
      const joined = lines.join('\n');

      expect(joined).toContain('(no features)');
    });
  });

  describe('_connect', () => {
    it('registers exists and close event handlers', async () => {
      const mockClient = makeMockImapClient();
      const factory = vi.fn().mockReturnValue(mockClient);
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        imapClientFactory: factory,
        ...makeMockServices(),
      });

      vi.spyOn(service, '_checkMessages').mockResolvedValue();

      await service._connect();

      expect(mockClient.on).toHaveBeenCalledWith('exists', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('connects and opens INBOX lock', async () => {
      const mockClient = makeMockImapClient();
      const factory = vi.fn().mockReturnValue(mockClient);
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        imapClientFactory: factory,
        ...makeMockServices(),
      });

      vi.spyOn(service, '_checkMessages').mockResolvedValue();

      await service._connect();

      expect(mockClient.connect).toHaveBeenCalled();
      expect(mockClient.getMailboxLock).toHaveBeenCalledWith('INBOX');
    });

    it('calls _checkMessages after connection', async () => {
      const mockClient = makeMockImapClient();
      const factory = vi.fn().mockReturnValue(mockClient);
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        imapClientFactory: factory,
        ...makeMockServices(),
      });

      const checkSpy = vi.spyOn(service, '_checkMessages').mockResolvedValue();

      await service._connect();

      expect(checkSpy).toHaveBeenCalled();
    });

    it('handles connect failure gracefully (no crash)', async () => {
      const mockClient = makeMockImapClient();
      mockClient.connect.mockRejectedValue(new Error('Connection failed'));
      const factory = vi.fn().mockReturnValue(mockClient);
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        imapClientFactory: factory,
        ...makeMockServices(),
      });

      await expect(service._connect()).resolves.toBeUndefined();
    });

    it('does not connect when _stopping is true', async () => {
      const mockClient = makeMockImapClient();
      const factory = vi.fn().mockReturnValue(mockClient);
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        imapClientFactory: factory,
        ...makeMockServices(),
      });

      service._stopping = true;

      await service._connect();

      expect(mockClient.connect).not.toHaveBeenCalled();
    });
  });

  describe('_checkMessages', () => {
    it('processes status request, sends reply, deletes message (happy path)', async () => {
      const mockClient = makeMockImapClient();
      const mockMessage = {
        uid: 1,
        flags: [],
        envelope: {
          from: [{ address: 'test@gmail.com' }],
          subject: '',
          messageId: 'msg-123',
        },
        source: Buffer.from('From: test@gmail.com\r\nSubject: \r\n\r\n'),
      };
      mockClient.search.mockResolvedValue([1]);
      mockClient.fetch.mockReturnValue(makeAsyncIterable([mockMessage]));

      const sendMail = vi.fn().mockResolvedValue({ messageId: 'reply-123' });
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        imapClientFactory: () => mockClient,
        transportFactory: () => ({ sendMail }),
        ...makeMockServices(),
      });

      service._client = mockClient;
      service._lock = mockClient._mockLock;

      await service._checkMessages();

      expect(sendMail).toHaveBeenCalled();
      expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith(1, ['\\Seen'], { uid: true });
    });

    it('skips non-status-request messages', async () => {
      const mockClient = makeMockImapClient();
      const mockMessage = {
        uid: 2,
        flags: [],
        envelope: {
          from: [{ address: 'other@gmail.com' }],
          subject: 'Regular Email',
          messageId: 'msg-456',
        },
        source: Buffer.from('From: other@gmail.com\r\nSubject: Regular Email\r\n\r\nBody'),
      };
      mockClient.search.mockResolvedValue([2]);
      mockClient.fetch.mockReturnValue(makeAsyncIterable([mockMessage]));

      const sendMail = vi.fn();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        imapClientFactory: () => mockClient,
        transportFactory: () => ({ sendMail }),
        ...makeMockServices(),
      });

      service._client = mockClient;
      service._lock = mockClient._mockLock;

      await service._checkMessages();

      expect(sendMail).not.toHaveBeenCalled();
      expect(mockClient.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it('handles no unseen messages (empty fetch)', async () => {
      const mockClient = makeMockImapClient();
      mockClient.fetch.mockReturnValue(makeAsyncIterable([]));

      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        imapClientFactory: () => mockClient,
        ...makeMockServices(),
      });

      service._client = mockClient;
      service._lock = mockClient._mockLock;

      await expect(service._checkMessages()).resolves.toBeUndefined();
    });

    it('handles fetch error gracefully', async () => {
      const mockClient = makeMockImapClient();
      mockClient.search.mockResolvedValue([1]);
      mockClient.fetch.mockImplementation(() => {
        throw new Error('Fetch failed');
      });

      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        imapClientFactory: () => mockClient,
        ...makeMockServices(),
      });

      service._client = mockClient;
      service._lock = mockClient._mockLock;

      await expect(service._checkMessages()).resolves.toBeUndefined();
    });

    it('returns early when no client', async () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...makeMockServices(),
      });

      service._client = null;

      await expect(service._checkMessages()).resolves.toBeUndefined();
    });

    it('returns early when no lock', async () => {
      const mockClient = makeMockImapClient();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        imapClientFactory: () => mockClient,
        ...makeMockServices(),
      });

      service._client = mockClient;
      service._lock = null;

      await expect(service._checkMessages()).resolves.toBeUndefined();
    });
  });

  describe('_onNewMail', () => {
    it('calls _checkMessages', async () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...makeMockServices(),
      });

      const checkSpy = vi.spyOn(service, '_checkMessages').mockResolvedValue();

      service._onNewMail({ count: 1 });

      await new Promise((resolve) => setImmediate(resolve));

      expect(checkSpy).toHaveBeenCalled();
    });

    it('does not throw on _checkMessages error', async () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...makeMockServices(),
      });

      vi.spyOn(service, '_checkMessages').mockRejectedValue(new Error('Check failed'));

      expect(() => service._onNewMail({ count: 1 })).not.toThrow();
    });
  });

  describe('_onDisconnect', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('schedules reconnect when not stopping', () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...makeMockServices(),
      });

      const connectSpy = vi.spyOn(service, '_connect').mockResolvedValue();
      service._stopping = false;

      service._onDisconnect();

      expect(connectSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10000);

      expect(connectSpy).toHaveBeenCalled();
    });

    it('does not reconnect when stopping', () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...makeMockServices(),
      });

      const connectSpy = vi.spyOn(service, '_connect').mockResolvedValue();
      service._stopping = true;

      service._onDisconnect();

      vi.advanceTimersByTime(10000);

      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('clears previous reconnect timer before scheduling new one', () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...makeMockServices(),
      });

      const connectSpy = vi.spyOn(service, '_connect').mockResolvedValue();
      service._stopping = false;

      service._onDisconnect();
      service._onDisconnect();

      vi.advanceTimersByTime(10000);

      expect(connectSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('_sendReply', () => {
    it('sends reply with correct headers', async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: 'reply-123' });
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        transportFactory: () => ({ sendMail }),
        ...makeMockServices(),
      });

      const envelope = {
        messageId: 'msg-123',
      };

      await service._sendReply(envelope, 'Test Report');

      expect(sendMail).toHaveBeenCalledOnce();
      const call = sendMail.mock.calls[0][0];
      expect(call.from).toBe('test@gmail.com');
      expect(call.to).toBe('test@gmail.com');
      expect(call.subject).toBe('Re: (Dashboard Status)');
      expect(call.inReplyTo).toBe('msg-123');
      expect(call.references).toBe('msg-123');
    });

    it('includes report text as body', async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: 'reply-123' });
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        transportFactory: () => ({ sendMail }),
        ...makeMockServices(),
      });

      const envelope = { messageId: 'msg-123' };
      const reportText = 'Dashboard Status\n---\nRunning: 1';

      await service._sendReply(envelope, reportText);

      const call = sendMail.mock.calls[0][0];
      expect(call.text).toBe(reportText);
    });

    it('does not throw on send failure', async () => {
      const sendMail = vi.fn().mockRejectedValue(new Error('SMTP failed'));
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        transportFactory: () => ({ sendMail }),
        ...makeMockServices(),
      });

      const envelope = { messageId: 'msg-123' };

      await expect(service._sendReply(envelope, 'Test Report')).resolves.toBeUndefined();
    });

    it('does nothing without transporter', async () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig({ user: '' }),
        ...makeMockServices(),
      });

      const envelope = { messageId: 'msg-123' };

      await expect(service._sendReply(envelope, 'Test Report')).resolves.toBeUndefined();
    });
  });

  describe('start/stop lifecycle', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('start calls _connect', () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...makeMockServices(),
      });

      const connectSpy = vi.spyOn(service, '_connect').mockResolvedValue();

      service.start();

      expect(connectSpy).toHaveBeenCalled();
    });

    it('start does nothing when disabled', () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig({ enabled: false }),
        ...makeMockServices(),
      });

      const connectSpy = vi.spyOn(service, '_connect').mockResolvedValue();

      service.start();

      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('stop sets _stopping flag', async () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...makeMockServices(),
      });

      service._stopping = false;

      await service.stop();

      expect(service._stopping).toBe(true);
    });

    it('stop releases lock and logs out client', async () => {
      const mockClient = makeMockImapClient();
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        imapClientFactory: () => mockClient,
        ...makeMockServices(),
      });

      service._client = mockClient;
      service._lock = mockClient._mockLock;

      await service.stop();

      expect(mockClient._mockLock.release).toHaveBeenCalled();
      expect(mockClient.logout).toHaveBeenCalled();
    });

    it('stop clears reconnect timer', async () => {
      const service = new StatusMailService({
        configLoader: () => makeConfig(),
        ...makeMockServices(),
      });

      const connectSpy = vi.spyOn(service, '_connect').mockResolvedValue();
      service._stopping = false;

      service._onDisconnect();

      await service.stop();

      vi.advanceTimersByTime(10000);

      expect(connectSpy).not.toHaveBeenCalled();
    });
  });
});
