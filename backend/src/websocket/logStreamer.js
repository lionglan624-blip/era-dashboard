import { WebSocketServer } from 'ws';
import { wsLog } from '../utils/logger.js';

export class LogStreamer {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // ws -> { id, subscriptions: Set<executionId> }
    this.clientIdCounter = 0;
  }

  attach(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      const clientId = ++this.clientIdCounter;
      const clientIp = req.socket.remoteAddress;

      this.clients.set(ws, { id: clientId, subscriptions: new Set() });
      wsLog.info(
        `Client ${clientId} connected from ${clientIp}. Total clients: ${this.clients.size}`,
      );

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          const client = this.clients.get(ws);
          if (!client) return;

          if (msg.type === 'subscribe' && msg.executionId) {
            client.subscriptions.add(msg.executionId);
            wsLog.debug(`Client ${clientId} subscribed to ${msg.executionId}`);
          } else if (msg.type === 'unsubscribe' && msg.executionId) {
            client.subscriptions.delete(msg.executionId);
            wsLog.debug(`Client ${clientId} unsubscribed from ${msg.executionId}`);
          }
        } catch (err) {
          wsLog.warn(`Client ${clientId} sent malformed message: ${err.message}`);
        }
      });

      ws.on('close', (code, _reason) => {
        const client = this.clients.get(ws);
        this.clients.delete(ws);
        wsLog.info(
          `Client ${client?.id || '?'} disconnected (code: ${code}). Total clients: ${this.clients.size}`,
        );
      });

      ws.on('error', (err) => {
        const client = this.clients.get(ws);
        wsLog.error(`Client ${client?.id || '?'} error: ${err.message}`);
        this.clients.delete(ws);
      });

      // Send welcome message
      try {
        ws.send(
          JSON.stringify({ type: 'connected', clientId, timestamp: new Date().toISOString() }),
        );
      } catch (err) {
        wsLog.debug(`Failed to send welcome to client ${clientId}: ${err.message}`);
      }
    });

    this.wss.on('error', (err) => {
      wsLog.error(`WebSocketServer error: ${err.message}`);
    });

    wsLog.info('WebSocket server attached');
  }

  /** Broadcast to clients subscribed to a specific execution */
  broadcast(executionId, message) {
    const json = JSON.stringify(message);
    let sentCount = 0;

    for (const [ws, client] of this.clients) {
      if (client.subscriptions.has(executionId) && ws.readyState === ws.OPEN) {
        try {
          ws.send(json);
          sentCount++;
        } catch (err) {
          wsLog.warn(`Failed to send to client ${client.id}: ${err.message}`);
        }
      }
    }

    // Log only for significant events (not every log line)
    if (message.type !== 'log') {
      wsLog.debug(
        `Broadcast [${message.type}] to ${sentCount} clients for execution ${executionId}`,
      );
    }
  }

  /** Broadcast to all connected clients */
  broadcastAll(message) {
    const json = JSON.stringify(message);
    let sentCount = 0;

    for (const [ws, client] of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(json);
          sentCount++;
        } catch (err) {
          wsLog.warn(`Failed to send to client ${client.id}: ${err.message}`);
        }
      }
    }

    wsLog.debug(`BroadcastAll [${message.type}] to ${sentCount} clients`);
  }

  /** Get connection stats */
  getStats() {
    return {
      totalClients: this.clients.size,
      clients: Array.from(this.clients.values()).map((c) => ({
        id: c.id,
        subscriptionCount: c.subscriptions.size,
      })),
    };
  }
}
