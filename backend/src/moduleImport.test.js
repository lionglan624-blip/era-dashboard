import { describe, it, expect } from 'vitest';

describe('Module import smoke tests', () => {
  // Services
  it('imports claudeService', async () => {
    const mod = await import('./services/claudeService.js');
    expect(mod.ClaudeService).toBeDefined();
  });

  it('imports ratelimitService', async () => {
    const mod = await import('./services/ratelimitService.js');
    expect(mod.RateLimitService).toBeDefined();
  });

  it('imports chainExecutor', async () => {
    const mod = await import('./services/chainExecutor.js');
    expect(mod.ChainExecutor).toBeDefined();
  });

  it('imports featureService', async () => {
    const mod = await import('./services/featureService.js');
    expect(mod.FeatureService).toBeDefined();
  });

  it('imports fileWatcher', async () => {
    try {
      const mod = await import('./services/fileWatcher.js');
      expect(mod.FileWatcher).toBeDefined();
    } catch (err) {
      // Allow infrastructure errors (missing native deps), fail on code errors
      expect(err).not.toBeInstanceOf(ReferenceError);
      expect(err).not.toBeInstanceOf(SyntaxError);
    }
  });

  it('imports streamParser', async () => {
    const mod = await import('./services/streamParser.js');
    expect(mod.StreamParser).toBeDefined();
  });

  it('imports emailService', async () => {
    const mod = await import('./services/emailService.js');
    expect(mod.EmailService).toBeDefined();
  });

  it('imports retryManager', async () => {
    const mod = await import('./services/retryManager.js');
    expect(mod.RetryManager).toBeDefined();
  });

  it('imports resumeManager', async () => {
    const mod = await import('./services/resumeManager.js');
    expect(mod.ResumeManager).toBeDefined();
  });

  it('imports shellExecutor', async () => {
    try {
      const mod = await import('./services/shellExecutor.js');
      expect(mod.ShellExecutor).toBeDefined();
    } catch (err) {
      // Allow infrastructure errors (missing native deps like node-pty), fail on code errors
      expect(err).not.toBeInstanceOf(ReferenceError);
      expect(err).not.toBeInstanceOf(SyntaxError);
    }
  });

  it('imports vtScreenBuffer', async () => {
    const mod = await import('./services/vtScreenBuffer.js');
    expect(mod.VtScreenBuffer).toBeDefined();
  });

  it('imports cleanupService', async () => {
    try {
      const mod = await import('./services/cleanupService.js');
      expect(mod.CleanupService).toBeDefined();
    } catch (err) {
      // Allow infrastructure errors (missing native deps), fail on code errors
      expect(err).not.toBeInstanceOf(ReferenceError);
      expect(err).not.toBeInstanceOf(SyntaxError);
    }
  });

  // Config
  it('imports config with key constants', async () => {
    const mod = await import('./config.js');
    expect(mod.MAX_CONCURRENT_EXECUTIONS).toBeDefined();
    expect(mod.AUTO_SWITCH_THRESHOLD).toBeDefined();
    expect(mod.STALL_TIMEOUT_MS).toBeDefined();
  });

  // Parsers
  it('imports featureParser', async () => {
    const mod = await import('./parsers/featureParser.js');
    expect(mod).toBeDefined();
  });

  it('imports indexParser', async () => {
    const mod = await import('./parsers/indexParser.js');
    expect(mod).toBeDefined();
  });

  // Utils
  it('imports validation', async () => {
    const mod = await import('./services/validation.js');
    expect(mod.validateFeatureId).toBeDefined();
  });

  it('imports inputPatterns', async () => {
    const mod = await import('./services/inputPatterns.js');
    expect(mod.INPUT_WAIT_PATTERNS).toBeDefined();
  });

  it('imports ccsUtils', async () => {
    const mod = await import('./services/ccsUtils.js');
    expect(mod.getCcsProfiles).toBeDefined();
  });
});
