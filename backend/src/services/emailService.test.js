import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailService } from './emailService.js';

function makeExecution(overrides = {}) {
  return {
    id: 'test-exec-id',
    featureId: '123',
    command: 'fl',
    sessionId: 'test-session-id',
    ...overrides,
  };
}

function makeFeatureInfo(overrides = {}) {
  return {
    title: 'テスト機能',
    status: '[WIP]',
    ...overrides,
  };
}

describe('EmailService', () => {
  describe('disabled', () => {
    it('does not create transporter when config disabled', () => {
      const service = new EmailService({
        configLoader: () => ({ enabled: false }),
      });
      expect(service.enabled).toBe(false);
      expect(service.transporter).toBeNull();
    });

    it('does not create transporter when config file missing', () => {
      const service = new EmailService({
        configLoader: () => ({ enabled: false }),
      });
      expect(service.enabled).toBe(false);
    });

    it('disables when enabled but user is empty', () => {
      const service = new EmailService({
        configLoader: () => ({ enabled: true, user: '' }),
      });
      expect(service.enabled).toBe(false);
    });

    it('sendHandoffNotification is no-op when disabled', async () => {
      const service = new EmailService({
        configLoader: () => ({ enabled: false }),
      });
      await expect(
        service.sendHandoffNotification(makeExecution(), 'test'),
      ).resolves.toBeUndefined();
    });

    it('sendCompletionNotification is no-op when disabled', async () => {
      const service = new EmailService({
        configLoader: () => ({ enabled: false }),
      });
      await expect(
        service.sendCompletionNotification(makeExecution(), 'completed', 0),
      ).resolves.toBeUndefined();
    });
  });

  describe('enabled', () => {
    let sendMail;
    let service;

    beforeEach(() => {
      sendMail = vi.fn().mockResolvedValue({ messageId: 'test' });
      service = new EmailService({
        configLoader: () => ({ enabled: true, user: 'test@gmail.com', pass: 'secret' }),
        transportFactory: () => ({ sendMail }),
      });
    });

    it('creates transporter when enabled with user', () => {
      expect(service.enabled).toBe(true);
      expect(service.transporter).not.toBeNull();
    });

    it('sends handoff notification with correct subject and body', async () => {
      await service.sendHandoffNotification(makeExecution(), 'AskUserQuestion requires input');

      expect(sendMail).toHaveBeenCalledOnce();
      const call = sendMail.mock.calls[0][0];
      expect(call.from).toBe('test@gmail.com');
      expect(call.to).toBe('test@gmail.com');
      expect(call.subject).toBe('FL 123 askuserquestion');
      expect(call.text).toContain('FL handoff: AskUserQuestion requires input');
      expect(call.text).toContain('test-session-id');
    });

    it('sends completion notification with OK for success', async () => {
      await service.sendCompletionNotification(makeExecution(), 'completed', 0);

      expect(sendMail).toHaveBeenCalledOnce();
      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 ok');
      expect(call.text).toContain('FL ok (exit 0)');
    });

    it('sends completion notification with FAIL for failure', async () => {
      await service.sendCompletionNotification(makeExecution(), 'failed', 1);

      expect(sendMail).toHaveBeenCalledOnce();
      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 fail');
      expect(call.text).toContain('FL fail (exit 1)');
    });

    it('handles execution without featureId (slash command)', async () => {
      await service.sendHandoffNotification(
        makeExecution({ featureId: null, command: 'commit' }),
        'test',
      );

      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('commit test');
      expect(call.text).toContain('COMMIT handoff: test');
    });

    it('does not throw on sendMail failure (fire-and-forget)', async () => {
      sendMail.mockRejectedValue(new Error('SMTP connection failed'));

      await expect(
        service.sendHandoffNotification(makeExecution(), 'test'),
      ).resolves.toBeUndefined();
    });

    it('does not throw on completion sendMail failure', async () => {
      sendMail.mockRejectedValue(new Error('Auth failed'));

      await expect(
        service.sendCompletionNotification(makeExecution(), 'failed', 1),
      ).resolves.toBeUndefined();
    });
  });

  describe('chainHistory support', () => {
    let sendMail;
    let service;

    beforeEach(() => {
      sendMail = vi.fn().mockResolvedValue({ messageId: 'test' });
      service = new EmailService({
        configLoader: () => ({ enabled: true, user: 'test@gmail.com', pass: 'secret' }),
        transportFactory: () => ({ sendMail }),
      });
    });

    it('sendCompletionNotification with chainHistory includes chain summary in subject', async () => {
      const chainHistory = [
        { command: 'fc', result: 'ok' },
        { command: 'fl', result: 'retry', reason: 'Context limit (max_tokens)' },
        { command: 'fl', result: 'ok' },
      ];
      await service.sendCompletionNotification(makeExecution(), 'completed', 0, chainHistory);

      expect(sendMail).toHaveBeenCalledOnce();
      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 ok');
      expect(call.text).toContain('Chain: fc(ok) → fl(retry:tokens) → fl(ok) → fl(ok)');
    });

    it('sendCompletionNotification without chainHistory is backward compatible', async () => {
      await service.sendCompletionNotification(makeExecution(), 'completed', 0);

      expect(sendMail).toHaveBeenCalledOnce();
      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 ok');
      expect(call.text).toContain('FL ok (exit 0)');
      expect(call.text).not.toContain('Chain:');
    });

    it('sendCompletionNotification with chainHistory and failure shows FAIL', async () => {
      const chainHistory = [
        { command: 'fc', result: 'ok' },
        { command: 'fl', result: 'fail' },
      ];
      await service.sendCompletionNotification(makeExecution(), 'failed', 1, chainHistory);

      expect(sendMail).toHaveBeenCalledOnce();
      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 fail');
      expect(call.text).toContain('Chain: fc(ok) → fl(fail) → fl(fail)');
    });

    it('sendCompletionNotification with context-retry-exhausted shows context-limit in subject', async () => {
      const chainHistory = [
        { command: 'fl', result: 'retry', reason: 'Context limit (success with is_error)' },
        { command: 'fl', result: 'retry', reason: 'Context limit (success with is_error)' },
        { command: 'fl', result: 'context-retry-exhausted' },
      ];
      const exec = makeExecution({ chain: { enabled: true, retryCount: 0, contextRetryCount: 3 } });
      await service.sendCompletionNotification(exec, 'failed', 1, chainHistory);

      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 context-limit 3/3');
      expect(call.text).toContain('context-retry-exhausted (3/3)');
    });

    it('sendCompletionNotification with account-limit shows account-limit in subject', async () => {
      const chainHistory = [
        { command: 'fc', result: 'ok' },
        { command: 'fl', result: 'account-limit' },
      ];
      await service.sendCompletionNotification(makeExecution(), 'failed', 1, chainHistory);

      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 account-limit');
      expect(call.text).toContain('account-limit — API rate limit (429)');
    });

    it('sendCompletionNotification with retry-exhausted shows fl-retry in subject', async () => {
      const chainHistory = [
        { command: 'fl', result: 'retry', reason: 'FL failed (exit=1)' },
        { command: 'fl', result: 'retry', reason: 'FL failed (exit=1)' },
        { command: 'fl', result: 'retry-exhausted' },
      ];
      const exec = makeExecution({ chain: { enabled: true, retryCount: 3, contextRetryCount: 0 } });
      await service.sendCompletionNotification(exec, 'failed', 1, chainHistory);

      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 fl-retry 3/3');
      expect(call.text).toContain('retry-exhausted (3/3)');
    });

    it('sendHandoffNotification with chainHistory includes chain summary', async () => {
      const chainHistory = [{ command: 'fc', result: 'ok' }];
      await service.sendHandoffNotification(makeExecution(), 'AskUserQuestion', chainHistory);

      expect(sendMail).toHaveBeenCalledOnce();
      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 askuserquestion');
      expect(call.text).toContain('Chain: fc(ok) → fl(handoff)');
    });

    it('sendHandoffNotification without chainHistory is backward compatible', async () => {
      await service.sendHandoffNotification(makeExecution(), 'test reason');

      expect(sendMail).toHaveBeenCalledOnce();
      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 test reason');
      expect(call.subject).not.toContain('→');
      expect(call.text).not.toContain('Chain:');
    });

    it('_formatChainSummary returns null for empty history', () => {
      expect(service._formatChainSummary([], 'fl', 'ok')).toBeNull();
      expect(service._formatChainSummary(undefined, 'fl', 'ok')).toBeNull();
    });

    it('_formatChainSummary formats simple chain', () => {
      const history = [{ command: 'fc', result: 'ok' }];
      expect(service._formatChainSummary(history, 'fl', 'ok')).toBe('fc(ok) → fl(ok)');
    });

    it('_formatChainSummary formats chain with retries', () => {
      const history = [
        { command: 'fc', result: 'ok' },
        { command: 'fl', result: 'retry', reason: 'Context limit (max_tokens)' },
        { command: 'fl', result: 'ok' },
      ];
      expect(service._formatChainSummary(history, 'run', 'fail')).toBe(
        'fc(ok) → fl(retry:tokens) → fl(ok) → run(fail)',
      );
    });

    it('_formatChainSummary abbreviates context reason', () => {
      const history = [
        { command: 'fl', result: 'retry', reason: 'Prompt too long (context exhausted)' },
      ];
      expect(service._formatChainSummary(history, 'fl', 'ok')).toBe('fl(retry:context) → fl(ok)');
    });
  });

  describe('featureInfo support', () => {
    let sendMail;
    let service;

    beforeEach(() => {
      sendMail = vi.fn().mockResolvedValue({ messageId: 'test' });
      service = new EmailService({
        configLoader: () => ({ enabled: true, user: 'test@gmail.com', pass: 'secret' }),
        transportFactory: () => ({ sendMail }),
      });
    });

    it('sendHandoffNotification with featureInfo includes title and status in body', async () => {
      const featureInfo = makeFeatureInfo();
      await service.sendHandoffNotification(
        makeExecution(),
        'AskUserQuestion',
        undefined,
        featureInfo,
      );

      expect(sendMail).toHaveBeenCalledOnce();
      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 askuserquestion');
      expect(call.text).toContain('F123 テスト機能 [WIP]');
    });

    it('sendHandoffNotification without featureInfo does not include title line', async () => {
      await service.sendHandoffNotification(makeExecution(), 'test');

      const call = sendMail.mock.calls[0][0];
      expect(call.text).not.toContain('テスト機能');
      expect(call.text).toContain('FL handoff: test');
    });

    it('sendCompletionNotification with featureInfo includes title and status in body', async () => {
      const featureInfo = makeFeatureInfo({ title: '別の機能', status: '[DONE]' });
      await service.sendCompletionNotification(
        makeExecution(),
        'completed',
        0,
        undefined,
        featureInfo,
      );

      expect(sendMail).toHaveBeenCalledOnce();
      const call = sendMail.mock.calls[0][0];
      expect(call.subject).toBe('FL 123 ok');
      expect(call.text).toContain('F123 別の機能 [DONE]');
    });

    it('sendCompletionNotification without featureInfo does not include title line', async () => {
      await service.sendCompletionNotification(makeExecution(), 'completed', 0);

      const call = sendMail.mock.calls[0][0];
      expect(call.text).not.toContain('テスト機能');
      expect(call.text).toContain('FL ok (exit 0)');
    });
  });

  describe('_formatSubjectResult', () => {
    let service;

    beforeEach(() => {
      service = new EmailService({
        configLoader: () => ({ enabled: false }),
      });
    });

    it('formats context-retry-exhausted with retry count', () => {
      const exec = { chain: { contextRetryCount: 3, retryCount: 0 } };
      expect(service._formatSubjectResult('context-retry-exhausted', exec)).toBe(
        'context-limit 3/3',
      );
    });

    it('formats account-limit as-is', () => {
      expect(service._formatSubjectResult('account-limit', {})).toBe('account-limit');
    });

    it('formats retry-exhausted with FL retry count', () => {
      const exec = { chain: { retryCount: 3, contextRetryCount: 0 } };
      expect(service._formatSubjectResult('retry-exhausted', exec)).toBe('fl-retry 3/3');
    });

    it('passes through ok and fail as-is', () => {
      expect(service._formatSubjectResult('ok', {})).toBe('ok');
      expect(service._formatSubjectResult('fail', {})).toBe('fail');
    });

    it('handles missing chain info with fallback', () => {
      expect(service._formatSubjectResult('context-retry-exhausted', {})).toBe('context-limit ?/3');
      expect(service._formatSubjectResult('retry-exhausted', {})).toBe('fl-retry ?/3');
    });
  });

  describe('_simplifyReason', () => {
    let service;

    beforeEach(() => {
      service = new EmailService({
        configLoader: () => ({ enabled: false }),
      });
    });

    it('simplifies AskUserQuestion to askuserquestion', () => {
      expect(service._simplifyReason('AskUserQuestion requires input')).toBe('askuserquestion');
      expect(service._simplifyReason('AskUserQuestion detected')).toBe('askuserquestion');
    });

    it('simplifies y/n pattern to input-wait', () => {
      expect(service._simplifyReason('y/n pattern detected')).toBe('input-wait');
      expect(service._simplifyReason('Waiting for y/n input')).toBe('input-wait');
    });

    it('simplifies question pattern to question', () => {
      expect(service._simplifyReason('Output ended with ?')).toBe('question');
      expect(service._simplifyReason('Should we continue?')).toBe('question');
    });

    it('truncates long reasons to 30 chars', () => {
      const longReason = 'This is a very long reason that exceeds thirty characters';
      expect(service._simplifyReason(longReason)).toBe('this is a very long reason tha');
    });

    it('lowercases and returns short reasons as-is', () => {
      expect(service._simplifyReason('Timeout')).toBe('timeout');
      expect(service._simplifyReason('ERROR')).toBe('error');
    });
  });

  describe('config loading', () => {
    it('uses custom smtpHost and smtpPort from config', () => {
      const factory = vi.fn().mockReturnValue({ sendMail: vi.fn() });
      new EmailService({
        configLoader: () => ({
          enabled: true,
          user: 'test@example.com',
          pass: 'pass',
          smtpHost: 'mail.example.com',
          smtpPort: 465,
        }),
        transportFactory: factory,
      });

      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          smtpHost: 'mail.example.com',
          smtpPort: 465,
        }),
      );
    });
  });
});
