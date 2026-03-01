import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';
import { nowJST } from '../utils/timeUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', '..', 'email.config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { enabled: false };
  }
}

export class StatusMailService {
  constructor({
    configLoader = loadConfig,
    imapClientFactory = null,
    transportFactory = null,
    featureService = null,
    claudeService = null,
    rateLimitService = null,
  } = {}) {
    this.logger = createLogger('status-mail');
    const config = configLoader();

    this.enabled = config.enabled === true && config.statusMail?.enabled === true;
    this.user = config.user || '';
    this.reconnectDelayMs = config.statusMail?.reconnectDelayMs || 10000;

    // Allowed senders: self + configured addresses (all lowercased)
    const extra = config.statusMail?.allowedSenders || [];
    this.allowedSenders = new Set(
      [this.user, ...extra].filter(Boolean).map((s) => s.toLowerCase()),
    );

    // IMAP config
    this.imapConfig = {
      host: config.statusMail?.imapHost || 'imap.gmail.com',
      port: config.statusMail?.imapPort || 993,
      secure: true,
      auth: {
        user: this.user,
        pass: config.pass || '',
      },
      logger: false,
    };

    // Store factories for DI
    this._imapClientFactory = imapClientFactory || ((cfg) => new ImapFlow(cfg));
    this._transportFactory = transportFactory;

    // Store service refs
    this.featureService = featureService;
    this.claudeService = claudeService;
    this.rateLimitService = rateLimitService;

    // Create transporter
    this.transporter = null;
    if (this.enabled && this.user) {
      this.transporter = this._transportFactory
        ? this._transportFactory(config)
        : nodemailer.createTransport({
            host: config.smtpHost || 'smtp.gmail.com',
            port: config.smtpPort || 587,
            secure: false,
            auth: { user: config.user, pass: config.pass },
          });
      this.logger.info('Status mail IDLE listener enabled');
    } else if (this.enabled) {
      this.logger.warn('Status mail enabled but user not configured');
      this.enabled = false;
    }

    // IDLE state
    this._client = null;
    this._lock = null;
    this._processedUids = new Set();
    this._reconnectTimer = null;
    this._stopping = false;
  }

  start() {
    if (!this.enabled) return;

    this._stopping = false;
    this.logger.info('Starting IMAP IDLE connection');
    this._connect().catch(() => {});
  }

  async stop() {
    this._stopping = true;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._lock) {
      this._lock.release();
      this._lock = null;
    }

    if (this._client) {
      try {
        await this._client.logout();
      } catch {
        // Ignore logout errors
      }
      this._client = null;
    }

    this.logger.info('Status mail IDLE listener stopped');
  }

  async _connect() {
    if (this._stopping) return;

    try {
      const client = this._imapClientFactory(this.imapConfig);

      // Register event handlers BEFORE connecting
      client.on('exists', (data) => {
        this._onNewMail(data);
      });

      client.on('close', () => {
        this._onDisconnect();
      });

      await client.connect();
      this._lock = await client.getMailboxLock('INBOX');
      this._client = client;

      this.logger.info('IMAP connected, listening for new mail (IDLE mode)');

      // Check latest message in case there's a pending request from before startup
      await this._checkMessages('*');
    } catch (err) {
      this.logger.error(`Failed to connect IMAP: ${err.message}`);
      this._onDisconnect();
    }
  }

  _onNewMail(data) {
    const start = (data.prevCount || 0) + 1;
    const range = `${start}:*`;
    this.logger.info(
      `New mail detected: ${data.count} messages (prev: ${data.prevCount}), checking ${range}`,
    );
    this._checkMessages(range).catch((err) => {
      this.logger.error(`Error checking new messages: ${err.message}`);
    });
  }

  _onDisconnect() {
    if (this._stopping) return;

    this.logger.warn(`IMAP disconnected, reconnecting in ${this.reconnectDelayMs}ms`);
    this._lock = null;
    this._client = null;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
    }
    this._reconnectTimer = setTimeout(() => {
      this._connect().catch(() => {});
    }, this.reconnectDelayMs);
  }

  async _checkMessages(seqRange) {
    if (!this._client || !this._lock) return;

    try {
      // Fetch messages by sequence range (no UNSEEN filter — Gmail marks self-sent as Seen)
      for await (const msg of this._client.fetch(seqRange, {
        envelope: true,
        source: true,
        uid: true,
      })) {
        if (this._processedUids.has(msg.uid)) continue;
        if (this._isStatusRequest(msg.envelope, msg.source)) {
          this.logger.info(`Status request found (uid: ${msg.uid})`);
          const report = this._buildStatusReport();
          await this._sendReply(msg.envelope, report);
          // Mark as Seen instead of deleting — delete/EXPUNGE disrupts IDLE connection
          try {
            await this._client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
          } catch (flagErr) {
            this.logger.error(`Failed to flag message: ${flagErr.message}`);
          }
          this._processedUids.add(msg.uid);
          this.logger.info(`Processed status request: ${msg.envelope.messageId}`);
        }
      }
    } catch (err) {
      this.logger.error(`Error checking messages: ${err.message}`);
    }
  }

  _isStatusRequest(envelope, rawSource) {
    // Check sender against allowedSenders whitelist
    const fromAddr = envelope.from?.[0]?.address?.toLowerCase();
    if (!fromAddr || !this.allowedSenders.has(fromAddr)) {
      return false;
    }

    // Check subject (must be empty, not a reply)
    const subject = (envelope.subject || '').trim();
    if (/^Re:/i.test(subject)) {
      return false; // Loop prevention
    }
    if (subject !== '') {
      return false; // Must be empty
    }

    // Parse body
    const raw = rawSource.toString();
    const bodyStartIndex = raw.indexOf('\r\n\r\n');
    if (bodyStartIndex === -1) {
      return true; // No body separator, empty email
    }

    let body = raw.substring(bodyStartIndex + 4);

    // Strip MIME boundaries (Gmail uses 24-30 hex char boundaries)
    body = body.replace(/--[a-zA-Z0-9_\-.]+(--)?/g, '');
    body = body.replace(/Content-Type:.*$/gim, '');
    body = body.replace(/Content-Transfer-Encoding:.*$/gim, '');
    body = body.trim();

    // Generous threshold: base64-encoded empty body can be ~40 chars (e.g., "DQo=" for CRLF)
    if (body.length > 50) {
      return false;
    }

    return true;
  }

  _buildStatusReport() {
    const lines = [
      'Dashboard Status Report',
      '=======================',
      nowJST(),
      '',
      ...this._formatExecutions(),
      '',
      ...this._formatRateLimits(),
      '',
      ...this._formatFeatureSummary(),
    ];
    return lines.join('\n');
  }

  _formatExecutions() {
    const lines = ['--- Executions ---'];

    if (!this.claudeService) {
      lines.push('  (service unavailable)');
      return lines;
    }

    const qs = this.claudeService.getQueueStatus();
    lines.push(`Running: ${qs.runningCount} | Queued: ${qs.queuedCount}`);

    if (qs.runningCount === 0 && qs.queuedCount === 0) {
      lines.push('  (idle)');
      return lines;
    }

    // List running executions with contextPercent from listExecutions()
    const executions = this.claudeService.listExecutions();
    for (const exec of executions) {
      if (exec.status === 'running') {
        const label = exec.featureId ? `F${exec.featureId}` : exec.command;
        const phaseInfo = exec.phaseName ? ` Phase ${exec.phase} "${exec.phaseName}"` : '';
        const ctx = exec.contextPercent != null ? ` (Context: ${exec.contextPercent}%)` : '';
        lines.push(`  [Running] ${label} ${exec.command}${phaseInfo}${ctx}`);
      }
    }

    // List queued executions
    for (const q of qs.queued || []) {
      const label = q.featureId ? `F${q.featureId}` : q.command;
      lines.push(`  [Queued]  ${label} ${q.command}`);
    }

    return lines;
  }

  _formatRateLimits() {
    const lines = ['--- Rate Limits ---'];

    if (!this.rateLimitService) {
      lines.push('  (service unavailable)');
      return lines;
    }

    const cached = this.rateLimitService.getCached();
    if (!cached || Object.keys(cached).length === 0) {
      lines.push('  (no data)');
      return lines;
    }

    for (const [profile, data] of Object.entries(cached)) {
      lines.push(`Profile: ${profile}`);
      if (!data) {
        lines.push('  (no warnings)');
        continue;
      }
      if (data.weekly) {
        lines.push(
          `  Weekly: ${data.weekly.percent}%${data.weekly.resetsAt ? ` (resets ${data.weekly.resetsAt})` : ''}`,
        );
      }
      if (data.session) {
        lines.push(
          `  Session: ${data.session.percent}%${data.session.resetsAt ? ` (resets ${data.session.resetsAt})` : ''}`,
        );
      }
    }

    return lines;
  }

  _formatFeatureSummary() {
    const lines = ['--- Features Summary ---'];

    if (!this.featureService) {
      lines.push('  (service unavailable)');
      return lines;
    }

    const { features } = this.featureService.getAllFeatures();
    if (!features || features.length === 0) {
      lines.push('  (no features)');
      return lines;
    }

    // Count by status
    const statusOrder = [
      '[DONE]',
      '[WIP]',
      '[REVIEWED]',
      '[PROPOSED]',
      '[BLOCKED]',
      '[DRAFT]',
      '[CANCELLED]',
    ];
    const counts = {};
    for (const f of features) {
      const s = f.status || '[UNKNOWN]';
      counts[s] = (counts[s] || 0) + 1;
    }

    // Summary line
    const parts = statusOrder.filter((s) => counts[s]).map((s) => `${s}: ${counts[s]}`);
    if (parts.length > 0) lines.push(parts.join(' | '));

    // WIP details
    const wipFeatures = features.filter((f) => f.status === '[WIP]');
    if (wipFeatures.length > 0) {
      lines.push('');
      lines.push('WIP Features:');
      for (const f of wipFeatures) {
        const progress = f.progress
          ? ` (AC: ${f.progress.acs.completed}/${f.progress.acs.total}, Tasks: ${f.progress.tasks.completed}/${f.progress.tasks.total})`
          : '';
        const type = f.type ? ` ${f.type}` : '';
        lines.push(`  F${f.id}${type} - ${f.name || 'Unnamed'}${progress}`);
      }
    }

    return lines;
  }

  async _sendReply(envelope, reportText) {
    if (!this.transporter) return;

    try {
      await this.transporter.sendMail({
        from: this.user,
        to: this.user,
        subject: 'Re: (Dashboard Status)',
        text: reportText,
        inReplyTo: envelope.messageId,
        references: envelope.messageId,
      });
      this.logger.info('Status report sent');
    } catch (err) {
      this.logger.error(`Failed to send status report: ${err.message}`);
    }
  }
}

export { loadConfig };
