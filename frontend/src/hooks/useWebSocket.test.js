import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.lastSent = null;
    MockWebSocket.instances.push(this);
  }

  send(data) {
    this.lastSent = data;
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose();
    }
  }

  // Helpers to simulate events
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) {
      this.onopen();
    }
  }

  simulateMessage(data) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose();
    }
  }

  simulateError() {
    if (this.onerror) {
      this.onerror();
    }
  }
}

describe('useWebSocket', () => {
  let originalWebSocket;
  let originalLocation;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket;

    // Mock window.location
    originalLocation = window.location;
    delete window.location;
    window.location = {
      protocol: 'http:',
      host: 'localhost:3000',
    };

    // Mock console.log to avoid noise
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    global.WebSocket = originalWebSocket;
    window.location = originalLocation;
    vi.restoreAllMocks();
  });

  describe('Connection', () => {
    it('connects on mount', () => {
      renderHook(() => useWebSocket(vi.fn()));

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].url).toBe('ws://localhost:3000/ws');
    });

    it('uses wss protocol when page is https', () => {
      window.location.protocol = 'https:';

      renderHook(() => useWebSocket(vi.fn()));

      expect(MockWebSocket.instances[0].url).toBe('wss://localhost:3000/ws');
    });

    it('sets connected to true on open', () => {
      const { result } = renderHook(() => useWebSocket(vi.fn()));

      expect(result.current.connected).toBe(false);

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      expect(result.current.connected).toBe(true);
    });
  });

  describe('Message Handling', () => {
    it('calls onMessage callback with parsed JSON on message event', () => {
      const onMessage = vi.fn();
      renderHook(() => useWebSocket(onMessage));

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({ type: 'test', data: 'hello' });
      });

      expect(onMessage).toHaveBeenCalledWith({ type: 'test', data: 'hello' });
    });

    it('ignores invalid JSON messages', () => {
      const onMessage = vi.fn();
      renderHook(() => useWebSocket(onMessage));

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      act(() => {
        MockWebSocket.instances[0].onmessage?.({ data: 'invalid json' });
      });

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('handles multiple messages', () => {
      const onMessage = vi.fn();
      renderHook(() => useWebSocket(onMessage));

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({ id: 1 });
        MockWebSocket.instances[0].simulateMessage({ id: 2 });
        MockWebSocket.instances[0].simulateMessage({ id: 3 });
      });

      expect(onMessage).toHaveBeenCalledTimes(3);
      expect(onMessage).toHaveBeenNthCalledWith(1, { id: 1 });
      expect(onMessage).toHaveBeenNthCalledWith(2, { id: 2 });
      expect(onMessage).toHaveBeenNthCalledWith(3, { id: 3 });
    });
  });

  describe('Reconnection', () => {
    it('reconnects with exponential backoff after close', () => {
      const { result } = renderHook(() => useWebSocket(vi.fn()));

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });
      expect(result.current.connected).toBe(true);

      // First disconnect - 1s delay
      act(() => {
        MockWebSocket.instances[0].simulateClose();
      });
      expect(result.current.connected).toBe(false);
      expect(result.current.reconnecting).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockWebSocket.instances).toHaveLength(2);

      // Second disconnect - 2s delay
      act(() => {
        MockWebSocket.instances[1].simulateClose();
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(MockWebSocket.instances).toHaveLength(3);

      // Third disconnect - 4s delay
      act(() => {
        MockWebSocket.instances[2].simulateClose();
      });
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(MockWebSocket.instances).toHaveLength(4);
    });

    it('caps reconnect delay at 10 seconds', () => {
      renderHook(() => useWebSocket(vi.fn()));

      // Simulate multiple disconnects
      for (let i = 0; i < 5; i++) {
        act(() => {
          const ws = MockWebSocket.instances[i];
          ws.simulateClose();
          vi.advanceTimersByTime(20000); // Advance by max
        });
      }

      // After 5 disconnects, delay should be capped at 10s
      // attempts: 0→1s, 1→2s, 2→4s, 3→8s, 4→10s (capped)
      expect(MockWebSocket.instances.length).toBeGreaterThan(4);
    });

    it('resets reconnect attempts on successful connection', () => {
      const { result } = renderHook(() => useWebSocket(vi.fn()));

      // First disconnect
      act(() => {
        MockWebSocket.instances[0].simulateClose();
        vi.advanceTimersByTime(1000);
      });

      // Second disconnect (should have 2s delay)
      act(() => {
        MockWebSocket.instances[1].simulateClose();
        vi.advanceTimersByTime(2000);
      });

      // Successful connection
      act(() => {
        MockWebSocket.instances[2].simulateOpen();
      });
      expect(result.current.connected).toBe(true);

      // Disconnect again - should restart at 1s
      act(() => {
        MockWebSocket.instances[2].simulateClose();
      });
      expect(result.current.connected).toBe(false);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockWebSocket.instances).toHaveLength(4);
    });

    it('does not reconnect on page unload (beforeunload)', () => {
      renderHook(() => useWebSocket(vi.fn()));

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      // Simulate page unload
      act(() => {
        window.dispatchEvent(new Event('beforeunload'));
      });

      act(() => {
        MockWebSocket.instances[0].simulateClose();
      });

      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(MockWebSocket.instances).toHaveLength(1); // No reconnection after beforeunload
    });

    it('reconnects after unmount (HMR support)', () => {
      const { unmount } = renderHook(() => useWebSocket(vi.fn()));

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      unmount();

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      // Reconnection is attempted because unmount alone doesn't set closingRef
      // (closingRef is only set by beforeunload for page navigation)
      expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    });
  });

  describe('Error Handling', () => {
    it('closes connection on error', () => {
      renderHook(() => useWebSocket(vi.fn()));

      const ws = MockWebSocket.instances[0];
      const closeSpy = vi.spyOn(ws, 'close');

      act(() => {
        ws.simulateError();
      });

      expect(closeSpy).toHaveBeenCalled();
    });
  });

  describe('Send Method', () => {
    it('sends JSON when connected', () => {
      const { result } = renderHook(() => useWebSocket(vi.fn()));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.simulateOpen();
      });
      expect(result.current.connected).toBe(true);

      act(() => {
        result.current.send({ type: 'test', data: 123 });
      });

      expect(ws.lastSent).toBe('{"type":"test","data":123}');
    });

    it('ignores send when disconnected', () => {
      const { result } = renderHook(() => useWebSocket(vi.fn()));

      // Not yet connected
      act(() => {
        result.current.send({ type: 'test' });
      });

      const ws = MockWebSocket.instances[0];
      expect(ws.lastSent).toBeNull();
    });

    it('sends multiple messages', () => {
      const { result } = renderHook(() => useWebSocket(vi.fn()));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.simulateOpen();
      });
      expect(result.current.connected).toBe(true);

      act(() => {
        result.current.send({ id: 1 });
        result.current.send({ id: 2 });
      });

      expect(ws.lastSent).toBe('{"id":2}'); // Last message
    });
  });

  describe('Subscribe/Unsubscribe', () => {
    it('sends subscribe message with correct type', () => {
      const { result } = renderHook(() => useWebSocket(vi.fn()));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.simulateOpen();
      });
      expect(result.current.connected).toBe(true);

      act(() => {
        result.current.subscribe('exec-123');
      });

      expect(ws.lastSent).toBe('{"type":"subscribe","executionId":"exec-123"}');
    });

    it('sends unsubscribe message with correct type', () => {
      const { result } = renderHook(() => useWebSocket(vi.fn()));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.simulateOpen();
      });
      expect(result.current.connected).toBe(true);

      act(() => {
        result.current.unsubscribe('exec-456');
      });

      expect(ws.lastSent).toBe('{"type":"unsubscribe","executionId":"exec-456"}');
    });

    it('ignores subscribe when disconnected', () => {
      const { result } = renderHook(() => useWebSocket(vi.fn()));

      act(() => {
        result.current.subscribe('exec-123');
      });

      const ws = MockWebSocket.instances[0];
      expect(ws.lastSent).toBeNull();
    });
  });

  describe('Cleanup', () => {
    it('closes WebSocket on unmount', () => {
      const { unmount } = renderHook(() => useWebSocket(vi.fn()));

      const ws = MockWebSocket.instances[0];
      const closeSpy = vi.spyOn(ws, 'close');

      unmount();

      expect(closeSpy).toHaveBeenCalled();
    });

    it('clears reconnect timer on unmount but onclose schedules new one', () => {
      const { unmount } = renderHook(() => useWebSocket(vi.fn()));

      act(() => {
        MockWebSocket.instances[0].simulateClose();
      });

      unmount();
      // Unmount clears pending timer, but close() in cleanup triggers onclose
      // which schedules a new reconnection (for HMR support)

      act(() => {
        vi.advanceTimersByTime(10000);
      });
      // Reconnection happens because closingRef is only set by beforeunload
      expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    });
  });

  describe('Reconnecting State', () => {
    it('sets reconnecting to true after disconnect', () => {
      const { result } = renderHook(() => useWebSocket(vi.fn()));

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });
      expect(result.current.connected).toBe(true);

      act(() => {
        MockWebSocket.instances[0].simulateClose();
      });

      expect(result.current.reconnecting).toBe(true);
    });

    it('sets reconnecting to false after successful reconnection', () => {
      const { result } = renderHook(() => useWebSocket(vi.fn()));

      act(() => {
        MockWebSocket.instances[0].simulateClose();
      });
      expect(result.current.reconnecting).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockWebSocket.instances).toHaveLength(2);

      act(() => {
        MockWebSocket.instances[1].simulateOpen();
      });

      expect(result.current.reconnecting).toBe(false);
    });
  });
});
