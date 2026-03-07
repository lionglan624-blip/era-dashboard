import { useEffect, useRef, useCallback, useState } from 'react';

export function useWebSocket(onMessage) {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const closingRef = useRef(false);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  const onMessageRef = useRef(onMessage);

  // Keep onMessage ref updated without triggering reconnect
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  const connect = useCallback(() => {
    // Guard: close existing connection before creating new one
    if (wsRef.current) {
      const old = wsRef.current;
      wsRef.current = null;
      old.onclose = null; // Prevent reconnect from old connection's close event
      old.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setReconnecting(false);
      reconnectAttempts.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        onMessageRef.current?.(msg);
      } catch (err) {
        console.debug?.('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      // Only reconnect if this is still the active connection and not intentionally closing
      if (wsRef.current === ws && !closingRef.current) {
        setReconnecting(true);
        // Exponential backoff: 1s, 2s, 4s, 8s, max 10s
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 10000);
        reconnectAttempts.current++;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    closingRef.current = false; // Reset on mount (StrictMode re-mount)
    connect();
    return () => {
      closingRef.current = true;
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect trigger from close event
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((message) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const subscribe = useCallback(
    (executionId) => {
      send({ type: 'subscribe', executionId });
    },
    [send],
  );

  const unsubscribe = useCallback(
    (executionId) => {
      send({ type: 'unsubscribe', executionId });
    },
    [send],
  );

  return { connected, reconnecting, subscribe, unsubscribe, send };
}
