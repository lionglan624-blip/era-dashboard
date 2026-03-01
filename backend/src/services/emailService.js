import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';
import { nowJST } from '../utils/timeUtils.js';
import { MAX_RETRIES, MAX_FL_RETRIES } from '../config.js';

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

export class EmailService {
  constructor({ configLoader = loadConfig, transportFactory = null } = {}) {
    this.logger = createLogger('email');
    const config = configLoader();
    this.enabled = config.enabled === true;
    this.user = config.user || '';
    this.transporter = null;

    if (this.enabled && this.user) {
      this.transporter = transportFactory
        ? transportFactory(config)
        : nodemailer.createTransport({
            host: config.smtpHost || 'smtp.gmail.com',
            port: config.smtpPort || 587,
            secure: false,
            auth: { user: config.user, pass: config.pass },
          });
      this.logger.info('Email notifications enabled');
    } else if (this.enabled) {
      this.logger.warn('Email enabled but user not configured');
      this.enabled = false;
    }
  }

  async sendHandoffNotification(
    execution,
    reason,
    chainHistory = undefined,
    featureInfo = undefined,
  ) {
    const cmdUpper = execution.command.toUpperCase();
    const simpleReason = this._simplifyReason(reason);

    const subject = execution.featureId
      ? `${cmdUpper} ${execution.featureId} ${simpleReason}`
      : `${execution.command} ${simpleReason}`;

    const textLines = [];

    // First line: feature title and status if available
    if (featureInfo) {
      textLines.push(`F${execution.featureId} ${featureInfo.title} ${featureInfo.status}`);
      textLines.push('');
    }

    textLines.push(`${cmdUpper} handoff: ${reason}`);
    textLines.push(`Session: ${execution.sessionId || 'N/A'}`);

    const chainSummary = this._formatChainSummary(chainHistory, execution.command, 'handoff');
    if (chainSummary) {
      textLines.push(`Chain: ${chainSummary}`);
    }

    textLines.push(nowJST());

    const text = textLines.join('\n');
    await this._send(subject, text);
  }

  async sendCompletionNotification(
    execution,
    status,
    exitCode,
    chainHistory = undefined,
    featureInfo = undefined,
  ) {
    const cmdUpper = execution.command.toUpperCase();
    // Use the last chain history entry's result (already classified by claudeService)
    // Fall back to exit code for non-chain executions
    const lastHistoryEntry = chainHistory?.[chainHistory.length - 1];
    const currentResult = lastHistoryEntry?.result || (exitCode === 0 ? 'ok' : 'fail');

    const subjectResult = this._formatSubjectResult(currentResult, execution);
    const subject = execution.featureId
      ? `${cmdUpper} ${execution.featureId} ${subjectResult}`
      : `${execution.command} ${subjectResult}`;

    const textLines = [];

    // First line: feature title and status if available
    if (featureInfo) {
      textLines.push(`F${execution.featureId} ${featureInfo.title} ${featureInfo.status}`);
      textLines.push('');
    }

    if (currentResult === 'account-limit') {
      const retryInfo = execution.rateLimitRetryAt
        ? `Retry scheduled at ${new Date(execution.rateLimitRetryAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}`
        : execution.rateLimitSwitchedTo
          ? `Switching to profile ${execution.rateLimitSwitchedTo}, retrying immediately`
          : 'No retry scheduled (no safe profile or reset time available)';
      textLines.push(`${cmdUpper} account-limit — API rate limit (429) hit`);
      textLines.push(`Retry: ${retryInfo}`);
    } else if (currentResult === 'retry-exhausted') {
      textLines.push(
        `${cmdUpper} retry-exhausted (${execution.chain?.retryCount || '?'}/3) — manual /fl re-run needed`,
      );
    } else if (currentResult === 'context-retry-exhausted') {
      textLines.push(
        `${cmdUpper} context-retry-exhausted (${execution.chain?.contextRetryCount || '?'}/3) — context limit, retries depleted`,
      );
    } else {
      textLines.push(`${cmdUpper} ${currentResult} (exit ${exitCode})`);
    }

    const chainSummary = this._formatChainSummary(chainHistory, execution.command, currentResult);
    if (chainSummary) {
      textLines.push(`Chain: ${chainSummary}`);
    }

    textLines.push(nowJST());

    const text = textLines.join('\n');
    await this._send(subject, text);
  }

  async sendRateLimitRecoveredNotification(execution, featureInfo = undefined) {
    const cmdUpper = execution.command.toUpperCase();
    const subject = execution.featureId
      ? `${cmdUpper} ${execution.featureId} rate-limit-recovered`
      : `${execution.command} rate-limit-recovered`;

    const textLines = [];
    if (featureInfo) {
      textLines.push(`F${execution.featureId} ${featureInfo.title} ${featureInfo.status}`);
      textLines.push('');
    }
    textLines.push(`${cmdUpper} rate-limit-recovered — retrying after rate limit reset`);
    textLines.push(nowJST());

    await this._send(subject, textLines.join('\n'));
  }

  async sendRateLimitExhaustedNotification(execution, reason, featureInfo = undefined) {
    const cmdUpper = execution.command.toUpperCase();
    const subject = execution.featureId
      ? `${cmdUpper} ${execution.featureId} rate-limit-exhausted`
      : `${execution.command} rate-limit-exhausted`;

    const textLines = [];
    if (featureInfo) {
      textLines.push(`F${execution.featureId} ${featureInfo.title} ${featureInfo.status}`);
      textLines.push('');
    }
    textLines.push(`${cmdUpper} rate-limit-exhausted — ${reason}`);
    textLines.push(nowJST());

    await this._send(subject, textLines.join('\n'));
  }

  /**
   * Format chain history into a compact summary string
   * @param {Array<{command: string, result: string, reason?: string}>} chainHistory - Chain execution history
   * @param {string} currentCommand - Current command being completed
   * @param {string} currentResult - Current result (ok/fail/handoff)
   * @returns {string|null} Formatted chain summary or null if no chain
   * @private
   */
  _formatChainSummary(chainHistory, currentCommand, currentResult) {
    if (!chainHistory || chainHistory.length === 0) return null;

    const steps = chainHistory.map((entry) => {
      const cmd = entry.command;
      const res = entry.result;
      if (res === 'retry' && entry.reason) {
        // Abbreviate reason for brevity
        const shortReason = entry.reason.includes('context')
          ? 'context'
          : entry.reason.includes('max_tokens')
            ? 'tokens'
            : 'retry';
        return `${cmd}(retry:${shortReason})`;
      }
      return `${cmd}(${res})`;
    });

    // Add current command
    steps.push(`${currentCommand}(${currentResult})`);

    return steps.join(' → ');
  }

  /**
   * Format result string for email subject line (human-readable)
   * @param {string} result - Result from chain history (ok/fail/account-limit/retry-exhausted/context-retry-exhausted)
   * @param {Object} execution - Execution object (for retry counts)
   * @returns {string} Human-readable subject result
   * @private
   */
  _formatSubjectResult(result, execution) {
    const chain = execution.chain;
    switch (result) {
      case 'context-retry-exhausted':
        return `context-limit ${chain?.contextRetryCount || '?'}/${MAX_RETRIES}`;
      case 'account-limit':
        return 'account-limit';
      case 'retry-exhausted':
        return `fl-retry ${chain?.retryCount || '?'}/${MAX_FL_RETRIES}`;
      case 'rate-limit-recovered':
        return 'rate-limit-recovered';
      case 'rate-limit-exhausted':
        return 'rate-limit-exhausted';
      default:
        return result;
    }
  }

  /**
   * Simplify reason string for subject line
   * @param {string} reason - Original reason text
   * @returns {string} Simplified reason for subject
   * @private
   */
  _simplifyReason(reason) {
    const lower = reason.toLowerCase();

    if (lower.includes('askuserquestion')) {
      return 'askuserquestion';
    }
    if (lower.includes('y/n')) {
      return 'input-wait';
    }
    if (lower.endsWith('?')) {
      return 'question';
    }

    // Default: lowercase and truncate to 30 chars
    return lower.substring(0, 30);
  }

  async _send(subject, text) {
    if (!this.enabled || !this.transporter) return;
    try {
      await this.transporter.sendMail({
        from: this.user,
        to: this.user,
        subject,
        text,
      });
      this.logger.info(`Email sent: ${subject}`);
    } catch (err) {
      this.logger.error(`Email failed: ${err.message}`);
    }
  }
}
