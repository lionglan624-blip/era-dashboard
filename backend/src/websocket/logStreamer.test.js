import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger module
vi.mock('../utils/logger.js', () => ({
  wsLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock ws module - WebSocketServer is used as `new WebSocketServer(...)` so mock must be a constructor
vi.mock('ws', () => ({
  WebSocketServer: vi.fn(),
}));

import { LogStreamer } from './logStreamer.js';
import { WebSocketServer } from 'ws';
import { wsLog } from '../utils/logger.js';

// WebSocket readyState constants
const WS_OPEN = 1;
const WS_CLOSED = 3;

function createMockWs() {
  const ws = {
    send: vi.fn(),
    readyState: WS_OPEN,
    OPEN: WS_OPEN,
    _handlers: {},
  };
  ws.on = vi.fn().mockImplementation((event, handler) => {
    ws._handlers[event] = handler;
  });
  return ws;
}

function createMockReq(ip = '127.0.0.1') {
  return { socket: { remoteAddress: ip } };
}

function createMockWss() {
  const wss = {
    _handlers: {},
  };
  wss.on = vi.fn().mockImplementation((event, handler) => {
    wss._handlers[event] = handler;
  });
  return wss;
}

describe('LogStreamer', () => {
  let streamer;
  let mockWss;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWss = createMockWss();
    // Use a proper constructor function so `new WebSocketServer(...)` returns mockWss
    vi.mocked(WebSocketServer).mockImplementation(function () {
      return mockWss;
    });

    streamer = new LogStreamer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('initializes with null wss', () => {
      expect(streamer.wss).toBeNull();
    });

    it('initializes with empty clients map', () => {
      expect(streamer.clients).toBeInstanceOf(Map);
      expect(streamer.clients.size).toBe(0);
    });

    it('initializes clientIdCounter at 0', () => {
      expect(streamer.clientIdCounter).toBe(0);
    });
  });

  describe('attach', () => {
    it('creates WebSocketServer with correct options', () => {
      const mockHttpServer = {};
      streamer.attach(mockHttpServer);

      expect(WebSocketServer).toHaveBeenCalledWith({ server: mockHttpServer, path: '/ws' });
    });

    it('assigns wss after attach', () => {
      streamer.attach({});
      expect(streamer.wss).toBe(mockWss);
    });

    it('registers connection and error handlers on wss', () => {
      streamer.attach({});
      expect(mockWss.on).toHaveBeenCalledWith('connection', expect.any(Function));
      expect(mockWss.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('logs info message after attach', () => {
      streamer.attach({});
      expect(wsLog.info).toHaveBeenCalledWith('WebSocket server attached');
    });

    describe('connection handler', () => {
      let mockWs;
      let mockReq;

      beforeEach(() => {
        streamer.attach({});
        mockWs = createMockWs();
        mockReq = createMockReq('10.0.0.1');
        // Trigger connection event
        mockWss._handlers['connection'](mockWs, mockReq);
      });

      it('increments clientIdCounter on connection', () => {
        expect(streamer.clientIdCounter).toBe(1);
      });

      it('adds client to clients map', () => {
        expect(streamer.clients.has(mockWs)).toBe(true);
      });

      it('stores clientId and empty subscriptions set', () => {
        const client = streamer.clients.get(mockWs);
        expect(client.id).toBe(1);
        expect(client.subscriptions).toBeInstanceOf(Set);
        expect(client.subscriptions.size).toBe(0);
      });

      it('logs connection info with clientId and ip', () => {
        expect(wsLog.info).toHaveBeenCalledWith(expect.stringContaining('Client 1'));
        expect(wsLog.info).toHaveBeenCalledWith(expect.stringContaining('10.0.0.1'));
      });

      it('sends welcome message to new client', () => {
        expect(mockWs.send).toHaveBeenCalledTimes(1);
        const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
        expect(sentData.type).toBe('connected');
        expect(sentData.clientId).toBe(1);
        expect(sentData.timestamp).toBeDefined();
      });

      it('registers message, close, and error handlers on ws', () => {
        expect(mockWs.on).toHaveBeenCalledWith('message', expect.any(Function));
        expect(mockWs.on).toHaveBeenCalledWith('close', expect.any(Function));
        expect(mockWs.on).toHaveBeenCalledWith('error', expect.any(Function));
      });

      it('assigns incrementing IDs for multiple connections', () => {
        const mockWs2 = createMockWs();
        mockWss._handlers['connection'](mockWs2, createMockReq());
        expect(streamer.clientIdCounter).toBe(2);
        expect(streamer.clients.get(mockWs2).id).toBe(2);
      });

      it('handles send failure gracefully on welcome message', () => {
        const failingWs = createMockWs();
        failingWs.send.mockImplementation(() => {
          throw new Error('send failed');
        });

        expect(() => {
          mockWss._handlers['connection'](failingWs, createMockReq());
        }).not.toThrow();

        expect(wsLog.debug).toHaveBeenCalledWith(expect.stringContaining('Failed to send welcome'));
      });

      describe('message handler', () => {
        it('subscribes client to executionId on subscribe message', () => {
          const msg = JSON.stringify({ type: 'subscribe', executionId: 'exec-123' });
          mockWs._handlers['message'](msg);

          const client = streamer.clients.get(mockWs);
          expect(client.subscriptions.has('exec-123')).toBe(true);
        });

        it('unsubscribes client from executionId on unsubscribe message', () => {
          const client = streamer.clients.get(mockWs);
          client.subscriptions.add('exec-123');

          const msg = JSON.stringify({ type: 'unsubscribe', executionId: 'exec-123' });
          mockWs._handlers['message'](msg);

          expect(client.subscriptions.has('exec-123')).toBe(false);
        });

        it('ignores subscribe message without executionId', () => {
          const msg = JSON.stringify({ type: 'subscribe' });
          mockWs._handlers['message'](msg);

          const client = streamer.clients.get(mockWs);
          expect(client.subscriptions.size).toBe(0);
        });

        it('ignores unsubscribe message without executionId', () => {
          const client = streamer.clients.get(mockWs);
          client.subscriptions.add('exec-abc');

          const msg = JSON.stringify({ type: 'unsubscribe' });
          mockWs._handlers['message'](msg);

          // Subscription should remain unchanged
          expect(client.subscriptions.has('exec-abc')).toBe(true);
        });

        it('ignores unknown message types without error', () => {
          const msg = JSON.stringify({ type: 'unknown', executionId: 'exec-123' });
          expect(() => mockWs._handlers['message'](msg)).not.toThrow();
        });

        it('logs warn on malformed (non-JSON) message', () => {
          mockWs._handlers['message']('not-json{{{');

          expect(wsLog.warn).toHaveBeenCalledWith(expect.stringContaining('malformed message'));
        });

        it('handles message for already-removed client gracefully', () => {
          streamer.clients.delete(mockWs);
          const msg = JSON.stringify({ type: 'subscribe', executionId: 'exec-xyz' });

          expect(() => mockWs._handlers['message'](msg)).not.toThrow();
        });

        it('logs debug on subscribe', () => {
          vi.clearAllMocks();
          const msg = JSON.stringify({ type: 'subscribe', executionId: 'exec-dbg' });
          mockWs._handlers['message'](msg);

          expect(wsLog.debug).toHaveBeenCalledWith(expect.stringContaining('subscribed'));
        });

        it('logs debug on unsubscribe', () => {
          const client = streamer.clients.get(mockWs);
          client.subscriptions.add('exec-dbg2');
          vi.clearAllMocks();

          const msg = JSON.stringify({ type: 'unsubscribe', executionId: 'exec-dbg2' });
          mockWs._handlers['message'](msg);

          expect(wsLog.debug).toHaveBeenCalledWith(expect.stringContaining('unsubscribed'));
        });
      });

      describe('close handler', () => {
        it('removes client from map on close', () => {
          mockWs._handlers['close'](1000, 'normal');
          expect(streamer.clients.has(mockWs)).toBe(false);
        });

        it('logs disconnect info with close code', () => {
          vi.clearAllMocks();
          mockWs._handlers['close'](1001, 'going away');

          expect(wsLog.info).toHaveBeenCalledWith(expect.stringContaining('disconnected'));
          expect(wsLog.info).toHaveBeenCalledWith(expect.stringContaining('1001'));
        });

        it('handles close for already-removed client gracefully', () => {
          streamer.clients.delete(mockWs);
          vi.clearAllMocks();
          expect(() => mockWs._handlers['close'](1000, '')).not.toThrow();
          expect(wsLog.info).toHaveBeenCalledWith(expect.stringContaining('?'));
        });
      });

      describe('error handler', () => {
        it('removes client from map on error', () => {
          const err = new Error('connection reset');
          mockWs._handlers['error'](err);

          expect(streamer.clients.has(mockWs)).toBe(false);
        });

        it('logs error message', () => {
          vi.clearAllMocks();
          const err = new Error('socket error');
          mockWs._handlers['error'](err);

          expect(wsLog.error).toHaveBeenCalledWith(expect.stringContaining('socket error'));
        });

        it('handles error for already-removed client gracefully', () => {
          streamer.clients.delete(mockWs);
          vi.clearAllMocks();
          const err = new Error('late error');

          expect(() => mockWs._handlers['error'](err)).not.toThrow();
          expect(wsLog.error).toHaveBeenCalledWith(expect.stringContaining('?'));
        });
      });
    });

    describe('wss error handler', () => {
      it('logs server-level error', () => {
        streamer.attach({});
        vi.clearAllMocks();
        const err = new Error('bind EADDRINUSE');
        mockWss._handlers['error'](err);

        expect(wsLog.error).toHaveBeenCalledWith(expect.stringContaining('bind EADDRINUSE'));
      });
    });
  });

  describe('broadcast', () => {
    it('sends message to subscribed open client', () => {
      const ws = createMockWs();
      streamer.clients.set(ws, { id: 1, subscriptions: new Set(['exec-1']) });

      streamer.broadcast('exec-1', { type: 'log', data: 'hello' });

      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('log');
      expect(sent.data).toBe('hello');
    });

    it('does not send to client not subscribed to executionId', () => {
      const ws = createMockWs();
      streamer.clients.set(ws, { id: 1, subscriptions: new Set(['exec-other']) });

      streamer.broadcast('exec-1', { type: 'log', data: 'hello' });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('does not send to closed client even if subscribed', () => {
      const ws = createMockWs();
      ws.readyState = WS_CLOSED;
      streamer.clients.set(ws, { id: 1, subscriptions: new Set(['exec-1']) });

      streamer.broadcast('exec-1', { type: 'log', data: 'hello' });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('sends to multiple subscribed open clients', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      streamer.clients.set(ws1, { id: 1, subscriptions: new Set(['exec-1']) });
      streamer.clients.set(ws2, { id: 2, subscriptions: new Set(['exec-1']) });

      streamer.broadcast('exec-1', { type: 'status', result: 'done' });

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);
    });

    it('does not send to client subscribed to different execution', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      streamer.clients.set(ws1, { id: 1, subscriptions: new Set(['exec-1']) });
      streamer.clients.set(ws2, { id: 2, subscriptions: new Set(['exec-2']) });

      streamer.broadcast('exec-1', { type: 'log', data: 'x' });

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it('handles send failure gracefully and logs warn', () => {
      const failWs = createMockWs();
      const okWs = createMockWs();
      failWs.send.mockImplementation(() => {
        throw new Error('broken pipe');
      });
      streamer.clients.set(failWs, { id: 1, subscriptions: new Set(['exec-1']) });
      streamer.clients.set(okWs, { id: 2, subscriptions: new Set(['exec-1']) });

      expect(() => streamer.broadcast('exec-1', { type: 'log', data: 'x' })).not.toThrow();

      expect(wsLog.warn).toHaveBeenCalledWith(expect.stringContaining('broken pipe'));
      expect(okWs.send).toHaveBeenCalledTimes(1);
    });

    it('does not log debug for "log" type messages', () => {
      const ws = createMockWs();
      streamer.clients.set(ws, { id: 1, subscriptions: new Set(['exec-1']) });
      vi.clearAllMocks();

      streamer.broadcast('exec-1', { type: 'log', data: 'hello' });

      expect(wsLog.debug).not.toHaveBeenCalled();
    });

    it('logs debug for non-log type messages', () => {
      const ws = createMockWs();
      streamer.clients.set(ws, { id: 1, subscriptions: new Set(['exec-1']) });
      vi.clearAllMocks();

      streamer.broadcast('exec-1', { type: 'status', state: 'done' });

      expect(wsLog.debug).toHaveBeenCalledWith(expect.stringContaining('status'));
    });

    it('sends valid JSON string', () => {
      const ws = createMockWs();
      streamer.clients.set(ws, { id: 1, subscriptions: new Set(['exec-1']) });
      const message = { type: 'log', data: 'line1' };

      streamer.broadcast('exec-1', message);

      const sent = ws.send.mock.calls[0][0];
      expect(() => JSON.parse(sent)).not.toThrow();
      expect(JSON.parse(sent)).toEqual(message);
    });

    it('handles empty clients map without error', () => {
      expect(() => streamer.broadcast('exec-1', { type: 'log' })).not.toThrow();
    });
  });

  describe('broadcastAll', () => {
    it('sends message to all open clients regardless of subscription', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      streamer.clients.set(ws1, { id: 1, subscriptions: new Set() });
      streamer.clients.set(ws2, { id: 2, subscriptions: new Set(['exec-x']) });

      streamer.broadcastAll({ type: 'reload' });

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);
    });

    it('does not send to closed clients', () => {
      const openWs = createMockWs();
      const closedWs = createMockWs();
      closedWs.readyState = WS_CLOSED;
      streamer.clients.set(openWs, { id: 1, subscriptions: new Set() });
      streamer.clients.set(closedWs, { id: 2, subscriptions: new Set() });

      streamer.broadcastAll({ type: 'reload' });

      expect(openWs.send).toHaveBeenCalledTimes(1);
      expect(closedWs.send).not.toHaveBeenCalled();
    });

    it('handles empty clients list without error', () => {
      expect(() => streamer.broadcastAll({ type: 'reload' })).not.toThrow();
    });

    it('handles send failure gracefully and logs warn', () => {
      const failWs = createMockWs();
      const okWs = createMockWs();
      failWs.send.mockImplementation(() => {
        throw new Error('network error');
      });
      streamer.clients.set(failWs, { id: 1, subscriptions: new Set() });
      streamer.clients.set(okWs, { id: 2, subscriptions: new Set() });

      expect(() => streamer.broadcastAll({ type: 'reload' })).not.toThrow();

      expect(wsLog.warn).toHaveBeenCalledWith(expect.stringContaining('network error'));
      expect(okWs.send).toHaveBeenCalledTimes(1);
    });

    it('sends valid JSON string', () => {
      const ws = createMockWs();
      streamer.clients.set(ws, { id: 1, subscriptions: new Set() });
      const message = { type: 'reload', version: 42 };

      streamer.broadcastAll(message);

      const sent = ws.send.mock.calls[0][0];
      expect(JSON.parse(sent)).toEqual(message);
    });

    it('logs debug with message type and sent count', () => {
      const ws = createMockWs();
      streamer.clients.set(ws, { id: 1, subscriptions: new Set() });
      vi.clearAllMocks();

      streamer.broadcastAll({ type: 'ping' });

      expect(wsLog.debug).toHaveBeenCalledWith(expect.stringContaining('ping'));
    });
  });

  describe('getStats', () => {
    it('returns zero totalClients when no clients', () => {
      const stats = streamer.getStats();
      expect(stats.totalClients).toBe(0);
      expect(stats.clients).toHaveLength(0);
    });

    it('returns totalClients equal to connected client count', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      streamer.clients.set(ws1, { id: 1, subscriptions: new Set() });
      streamer.clients.set(ws2, { id: 2, subscriptions: new Set(['exec-1', 'exec-2']) });

      const stats = streamer.getStats();
      expect(stats.totalClients).toBe(2);
    });

    it('returns client list with id and subscriptionCount', () => {
      const ws = createMockWs();
      streamer.clients.set(ws, {
        id: 5,
        subscriptions: new Set(['exec-a', 'exec-b', 'exec-c']),
      });

      const stats = streamer.getStats();
      expect(stats.clients).toHaveLength(1);
      expect(stats.clients[0].id).toBe(5);
      expect(stats.clients[0].subscriptionCount).toBe(3);
    });

    it('returns subscriptionCount 0 for client with no subscriptions', () => {
      const ws = createMockWs();
      streamer.clients.set(ws, { id: 3, subscriptions: new Set() });

      const stats = streamer.getStats();
      expect(stats.clients[0].subscriptionCount).toBe(0);
    });

    it('lists all clients in stats', () => {
      for (let i = 1; i <= 3; i++) {
        const ws = createMockWs();
        streamer.clients.set(ws, { id: i, subscriptions: new Set() });
      }

      const stats = streamer.getStats();
      expect(stats.totalClients).toBe(3);
      expect(stats.clients).toHaveLength(3);
      const ids = stats.clients.map((c) => c.id).sort((a, b) => a - b);
      expect(ids).toEqual([1, 2, 3]);
    });

    it('does not expose internal subscriptions Set directly', () => {
      const ws = createMockWs();
      streamer.clients.set(ws, { id: 1, subscriptions: new Set(['x']) });

      const stats = streamer.getStats();
      expect(stats.clients[0].subscriptions).toBeUndefined();
    });
  });

  describe('getSubscribers', () => {
    it('returns empty when no clients subscribe to execution', () => {
      const result = streamer.getSubscribers('exec-unknown');
      expect(result.count).toBe(0);
      expect(result.clients).toHaveLength(0);
    });

    it('returns single subscriber', () => {
      const ws = createMockWs();
      streamer.clients.set(ws, { id: 1, subscriptions: new Set(['exec-1']) });

      const result = streamer.getSubscribers('exec-1');
      expect(result.count).toBe(1);
      expect(result.clients[0].clientId).toBe(1);
      expect(result.clients[0].readyState).toBe(WS_OPEN);
    });

    it('returns multiple subscribers', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      streamer.clients.set(ws1, { id: 1, subscriptions: new Set(['exec-1']) });
      streamer.clients.set(ws2, { id: 2, subscriptions: new Set(['exec-1', 'exec-2']) });

      const result = streamer.getSubscribers('exec-1');
      expect(result.count).toBe(2);
    });

    it('excludes clients subscribed to different execution', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      streamer.clients.set(ws1, { id: 1, subscriptions: new Set(['exec-1']) });
      streamer.clients.set(ws2, { id: 2, subscriptions: new Set(['exec-2']) });

      const result = streamer.getSubscribers('exec-1');
      expect(result.count).toBe(1);
      expect(result.clients[0].clientId).toBe(1);
    });
  });
});
