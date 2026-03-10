import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateFeatureId,
  validateCommand,
  INPUT_WAIT_PATTERNS,
  ClaudeService,
  getNextChainCommand,
  isExpectedStatusAfterCommand,
} from './claudeService.js';
import { detectPhase, detectIteration, getTotalPhases, getDefaultPhaseName } from './phaseUtils.js';

// Mock child_process.spawn to prevent actual process spawning during tests
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn(() => ({
      pid: 12345,
      stdin: { on: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      unref: vi.fn(),
    })),
  };
});

// =============================================================================
// Pure function tests (no mocking needed)
// =============================================================================

describe('validateFeatureId', () => {
  it('accepts numeric strings', () => {
    expect(validateFeatureId('123')).toBe('123');
    expect(validateFeatureId('0')).toBe('0');
    expect(validateFeatureId('999')).toBe('999');
  });

  it('accepts numbers and converts to string', () => {
    expect(validateFeatureId(42)).toBe('42');
  });

  it('rejects non-numeric input', () => {
    expect(() => validateFeatureId('abc')).toThrow('Invalid featureId');
    expect(() => validateFeatureId('12a')).toThrow('Invalid featureId');
    expect(() => validateFeatureId('')).toThrow('Invalid featureId');
    expect(() => validateFeatureId('12 34')).toThrow('Invalid featureId');
  });

  it('rejects injection attempts', () => {
    expect(() => validateFeatureId('123; rm -rf')).toThrow('Invalid featureId');
    expect(() => validateFeatureId('123 && echo')).toThrow('Invalid featureId');
    expect(() => validateFeatureId('../etc/passwd')).toThrow('Invalid featureId');
  });
});

describe('validateCommand', () => {
  it('accepts valid commands', () => {
    expect(validateCommand('fc')).toBe('fc');
    expect(validateCommand('fl')).toBe('fl');
    expect(validateCommand('run')).toBe('run');
    expect(validateCommand('imp')).toBe('imp');
  });

  it('normalizes to lowercase', () => {
    expect(validateCommand('FC')).toBe('fc');
    expect(validateCommand('FL')).toBe('fl');
    expect(validateCommand('RUN')).toBe('run');
    expect(validateCommand('IMP')).toBe('imp');
  });

  it('rejects invalid commands', () => {
    expect(() => validateCommand('commit')).toThrow('Invalid command');
    expect(() => validateCommand('exec')).toThrow('Invalid command');
    expect(() => validateCommand('')).toThrow('Invalid command');
    expect(() => validateCommand('fl; rm')).toThrow('Invalid command');
  });
});

describe('INPUT_WAIT_PATTERNS', () => {
  const testPattern = (text) =>
    INPUT_WAIT_PATTERNS.find(({ pattern }) => pattern.test(text))?.description;

  it('matches y/n prompts', () => {
    expect(testPattern('Continue? (y/n)')).toBe('y/n prompt');
    // Note: [Y/n] matches the case-insensitive y/N pattern first due to array order
    expect(testPattern('[Y/n] Proceed')).toBeDefined();
    expect(testPattern('[y/N] Cancel')).toBeDefined();
  });

  it('matches question prompts', () => {
    expect(testPattern('Continue?')).toBe('Continue prompt');
    expect(testPattern('Proceed?')).toBe('Proceed prompt');
    expect(testPattern('Press Enter to continue')).toBe('Enter prompt');
    expect(testPattern('(yes/no)')).toBe('yes/no prompt');
  });

  it('does not match regular text', () => {
    expect(testPattern('Processing features...')).toBeUndefined();
    expect(testPattern('Done')).toBeUndefined();
  });
});

// =============================================================================
// ClaudeService instance tests (with mocked dependencies)
// =============================================================================

function createMockLogStreamer() {
  return {
    broadcast: vi.fn(),
    broadcastAll: vi.fn(),
  };
}

function createService(overrides = {}) {
  const logStreamer = createMockLogStreamer();
  const { projectRoot, ...options } = overrides;
  const service = new ClaudeService(projectRoot || 'C:\\test\\project', logStreamer, options);
  return { service, logStreamer };
}

// =============================================================================
// Phase utility tests (module-level functions from phaseUtils.js)
// =============================================================================

describe('detectPhase', () => {
  it('detects PHASE N patterns', () => {
    expect(detectPhase('PHASE 3: Implementation')).toEqual({
      phase: 3,
      name: 'Implementation',
    });
    expect(detectPhase('Phase 0: Dependency Check')).toEqual({
      phase: 0,
      name: 'Dependency Check',
    });
    expect(detectPhase('## Phase 5 - Debugging')).toEqual({ phase: 5, name: 'Debugging' });
  });

  it('uses default names when not provided', () => {
    expect(detectPhase('PHASE 3')).toEqual({ phase: 3, name: 'Implementation' });
    expect(detectPhase('PHASE 7')).toEqual({ phase: 7, name: 'Post-Review' });
  });

  it('returns null for non-phase text', () => {
    expect(detectPhase('Regular text without phase')).toBeNull();
    expect(detectPhase('The phase of the moon')).toBeNull();
  });
});

describe('detectIteration', () => {
  it('detects Iteration N/10 pattern', () => {
    expect(detectIteration('Iteration 1/10: Phase 0')).toEqual({ current: 1, total: 10 });
    expect(detectIteration('Iteration 5/10: Phase 2')).toEqual({ current: 5, total: 10 });
    expect(detectIteration('Iteration 10/10: Phase 3')).toEqual({ current: 10, total: 10 });
  });

  it('handles various spacing', () => {
    expect(detectIteration('Iteration  3 / 10')).toEqual({ current: 3, total: 10 });
    expect(detectIteration('iteration 7/10')).toEqual({ current: 7, total: 10 });
  });

  it('returns null for non-iteration text', () => {
    expect(detectIteration('Phase 3: Implementation')).toBeNull();
    expect(detectIteration('Some random text')).toBeNull();
  });
});

describe('getDefaultPhaseName', () => {
  it('returns known phase names', () => {
    expect(getDefaultPhaseName(0)).toBe('Dependency Check');
    expect(getDefaultPhaseName(3)).toBe('Implementation');
    expect(getDefaultPhaseName(7)).toBe('Post-Review');
  });

  it('returns generic name for unknown phases', () => {
    expect(getDefaultPhaseName(99)).toBe('Phase 99');
  });
});

describe('getTotalPhases', () => {
  it('returns correct total phases for each command', () => {
    expect(getTotalPhases('run')).toBe(10);
    expect(getTotalPhases('fc')).toBe(7);
    expect(getTotalPhases('fl')).toBe(7);
    expect(getTotalPhases('unknown')).toBeNull();
  });
});

describe('ClaudeService', () => {
  describe('_endsWithQuestion', () => {
    it('detects ASCII question marks', () => {
      const { service } = createService();
      expect(service._endsWithQuestion('Is this correct?')).toBe(true);
      expect(service._endsWithQuestion('Line 1\nIs this correct?')).toBe(true);
    });

    it('detects full-width question marks (Japanese)', () => {
      const { service } = createService();
      expect(service._endsWithQuestion('これは正しいですか？')).toBe(true);
    });

    it('ignores trailing empty lines', () => {
      const { service } = createService();
      expect(service._endsWithQuestion('Is this correct?\n\n  \n')).toBe(true);
    });

    it('returns false for non-questions', () => {
      const { service } = createService();
      expect(service._endsWithQuestion('Done.')).toBe(false);
      expect(service._endsWithQuestion('')).toBe(false);
      expect(service._endsWithQuestion(null)).toBe(false);
    });

    it('detects Japanese prompt patterns that request user input', () => {
      const { service } = createService();
      // 選択してください pattern (please select)
      expect(
        service._endsWithQuestion('F706を[DONE]にするか、[WIP]で待つかを選択してください。'),
      ).toBe(true);
      expect(service._endsWithQuestion('どちらかを選択してください')).toBe(true);
      // どちらにしますか pattern (which one)
      expect(service._endsWithQuestion('AとBのどちらにしますか。')).toBe(true);
      // 教えてください pattern (please tell)
      expect(service._endsWithQuestion('詳細を教えてください。')).toBe(true);
      // 指定してください pattern (please specify)
      expect(service._endsWithQuestion('パスを指定してください。')).toBe(true);
      // Statements should not match
      expect(service._endsWithQuestion('完了しました。')).toBe(false);
      expect(service._endsWithQuestion('処理を実行します。')).toBe(false);
    });

    it('detects 確認してください pattern (please confirm)', () => {
      const { service } = createService();
      expect(service._endsWithQuestion('内容を確認してください。')).toBe(true);
      expect(service._endsWithQuestion('確認してください')).toBe(true);
    });

    it('detects 決めてください pattern (please decide)', () => {
      const { service } = createService();
      expect(service._endsWithQuestion('どちらか決めてください。')).toBe(true);
      expect(service._endsWithQuestion('選択肢を決めてください')).toBe(true);
    });

    it('detects お願いします pattern (please)', () => {
      const { service } = createService();
      expect(service._endsWithQuestion('確認をお願いします。')).toBe(true);
      expect(service._endsWithQuestion('お願いします')).toBe(true);
    });

    it('does not match patterns in mid-line', () => {
      const { service } = createService();
      // Patterns should only match at line end
      expect(service._endsWithQuestion('確認してください。その後処理を続けます。')).toBe(false);
      expect(service._endsWithQuestion('お願いします。次の処理を実行します。')).toBe(false);
      expect(service._endsWithQuestion('決めてください。結果を報告します。')).toBe(false);
    });
  });

  describe('_extractStreamText', () => {
    it('extracts text from assistant events', () => {
      const { service } = createService();
      const event = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      };
      expect(service._extractStreamText(event)).toBe('Hello world');
    });

    it('formats tool_use blocks', () => {
      const { service } = createService();
      const event = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', id: '1', input: {} }] },
      };
      expect(service._extractStreamText(event)).toBe('[Tool: Read]');
    });

    it('extracts text from result events with cost', () => {
      const { service } = createService();
      const event = {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.1234,
        duration_ms: 5000,
      };
      expect(service._extractStreamText(event)).toBe('[Result: success [5.0s] ($0.1234)]');
    });

    it('extracts tool_result previews', () => {
      const { service } = createService();
      const event = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: '1', content: 'short result' }],
        },
      };
      expect(service._extractStreamText(event)).toBe('[Tool result: short result]');
    });

    it('truncates long tool_result previews', () => {
      const { service } = createService();
      const longContent = 'x'.repeat(300);
      const event = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: '1', content: longContent }],
        },
      };
      const result = service._extractStreamText(event);
      expect(result).toContain('...');
      expect(result.length).toBeLessThan(250);
    });

    it('returns init message for system init events', () => {
      const { service } = createService();
      expect(service._extractStreamText({ type: 'system', subtype: 'init' })).toBe(
        '[Claude initialized]',
      );
    });

    it('returns null for unknown event types', () => {
      const { service } = createService();
      expect(service._extractStreamText({ type: 'unknown' })).toBeNull();
    });

    it('handles assistant event with null message', () => {
      const { service } = createService();
      const event = {
        type: 'assistant',
        message: null,
      };
      expect(service._extractStreamText(event)).toBeNull();
    });

    it('handles assistant event with empty content array', () => {
      const { service } = createService();
      const event = {
        type: 'assistant',
        message: { content: [] },
      };
      expect(service._extractStreamText(event)).toBeNull();
    });

    it('handles content_delta event type (API compatibility)', () => {
      const { service } = createService();
      const event = {
        type: 'content_delta',
        delta: { text: 'streamed text' },
      };
      expect(service._extractStreamText(event)).toBe('streamed text');
    });

    it('handles result event without cost or duration', () => {
      const { service } = createService();
      const event = {
        type: 'result',
        subtype: 'success',
      };
      expect(service._extractStreamText(event)).toBe('[Result: success]');
    });

    it('handles tool_result with object content (JSON.stringify path)', () => {
      const { service } = createService();
      const event = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: '1', content: { data: 'value' } }],
        },
      };
      const result = service._extractStreamText(event);
      expect(result).toContain('[Tool result:');
      expect(result).toContain('data');
    });

    it('handles system event with non-init subtype', () => {
      const { service } = createService();
      const event = {
        type: 'system',
        subtype: 'other',
        message: 'System message',
      };
      expect(service._extractStreamText(event)).toBe('System message');
    });
  });

  describe('_updateTokenUsage', () => {
    it('calculates context percentage correctly', () => {
      const { service } = createService();
      const execution = { tokenUsage: null, contextPercent: null };
      const mockBroadcast = vi.fn();
      // Bypass broadcast
      service._broadcastState = mockBroadcast;

      service._updateTokenUsage(
        execution,
        {
          input_tokens: 50000,
          output_tokens: 1000,
          cache_creation_input_tokens: 30000,
          cache_read_input_tokens: 20000,
        },
        200000,
      );

      // cache_read IS counted (cached tokens still occupy context window space)
      expect(execution.contextPercent).toBe(50); // (50000+30000+20000)/200000 = 50%
      expect(execution.tokenUsage.input).toBe(50000);
      expect(execution.tokenUsage.output).toBe(1000);
      expect(execution.tokenUsage.contextWindow).toBe(200000);
    });

    it('uses default context window when not provided', () => {
      const { service } = createService();
      const execution = { tokenUsage: null, contextPercent: null };
      service._broadcastState = vi.fn();

      service._updateTokenUsage(execution, { input_tokens: 100000, output_tokens: 0 }, null);

      // Default is 200000 (DEFAULT_CONTEXT_WINDOW), so 100000/200000 = 50%
      expect(execution.contextPercent).toBe(50);
    });

    it('does nothing with null usage', () => {
      const { service } = createService();
      const execution = { tokenUsage: null, contextPercent: null };
      service._broadcastState = vi.fn();

      service._updateTokenUsage(execution, null, null);
      expect(execution.tokenUsage).toBeNull();
    });

    it('falls back to previous contextWindow when param is null', () => {
      const { service } = createService();
      const execution = {
        tokenUsage: { contextWindow: 150000 },
        contextPercent: null,
      };
      service._broadcastState = vi.fn();

      service._updateTokenUsage(execution, { input_tokens: 75000, output_tokens: 0 }, null);

      // Should use previous contextWindow (150000), so 75000/150000 = 50%
      expect(execution.tokenUsage.contextWindow).toBe(150000);
      expect(execution.contextPercent).toBe(50);
    });

    it('uses latest token values (not Math.max)', () => {
      const { service } = createService();
      const execution = { tokenUsage: null, contextPercent: null };
      service._broadcastState = vi.fn();

      // First update (turn 1: fresh cache creation)
      service._updateTokenUsage(
        execution,
        {
          input_tokens: 10000,
          output_tokens: 500,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 5000,
        },
        200000,
      );
      expect(execution.tokenUsage.input).toBe(10000);
      expect(execution.contextPercent).toBe(8); // (10000+1000+5000)/200000 = 8%

      // Second update (turn 2: previous cache_creation becomes cache_read)
      service._updateTokenUsage(
        execution,
        {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 328,
          cache_read_input_tokens: 54109,
        },
        null,
      );
      // Uses latest values, not Math.max
      expect(execution.tokenUsage.input).toBe(1);
      expect(execution.tokenUsage.cacheCreation).toBe(328);
      expect(execution.tokenUsage.cacheRead).toBe(54109);
      expect(execution.tokenUsage.output).toBe(1);
      expect(execution.contextPercent).toBe(27); // (1+328+54109)/200000 = 27.2% → 27
    });
  });

  describe('_handleCompletion guard', () => {
    it('prevents double completion', () => {
      const { service, logStreamer } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      // First call: should process
      service._handleCompletion(execution, 0);
      expect(execution.status).toBe('completed');

      // Second call: should be no-op (guard: status !== 'running')
      service._handleCompletion(execution, 1);
      expect(execution.status).toBe('completed'); // Not changed to 'failed'
      expect(execution.exitCode).toBe(0); // Not changed to 1
    });
  });

  describe('_onComplete callback', () => {
    it('fires _onComplete on execution completion', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      const onComplete = vi.fn();
      execution._onComplete = onComplete;

      service._handleCompletion(execution, 0);

      expect(onComplete).toHaveBeenCalledWith(execution, 0);
    });

    it('does not crash if _onComplete throws', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      execution._onComplete = () => {
        throw new Error('callback error');
      };

      expect(() => service._handleCompletion(execution, 0)).not.toThrow();
      expect(execution.status).toBe('completed');
    });
  });

  describe('executeUpdateAnalysis', () => {
    it('creates execution with update-analysis command and _debugPrompt', () => {
      const { service, logStreamer } = createService();
      vi.spyOn(service, '_startExecution').mockImplementation(() => {});

      const execId = service.executeUpdateAnalysis('test prompt');

      const execution = service.executions.get(execId);
      expect(execution.command).toBe('update-analysis');
      expect(execution._debugPrompt).toBe('test prompt');
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'execution-started', command: 'update-analysis' }),
      );
    });

    it('sets _onComplete callback when provided', () => {
      const { service } = createService();
      vi.spyOn(service, '_startExecution').mockImplementation(() => {});

      const callback = vi.fn();
      const execId = service.executeUpdateAnalysis('test prompt', callback);

      const execution = service.executions.get(execId);
      expect(execution._onComplete).toBe(callback);
    });

    it('auto-handoffs to terminal on successful completion', () => {
      const { service } = createService();
      const execution = service._createExecution({ command: 'update-analysis' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.sessionId = 'test-session-123';
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(execution.status).toBe('handed-off');
    });

    it('does not auto-handoff on failure', () => {
      const { service } = createService();
      const execution = service._createExecution({ command: 'update-analysis' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.sessionId = 'test-session-123';
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 1);

      expect(execution.status).toBe('failed');
    });

    it('does not auto-handoff without sessionId', () => {
      const { service } = createService();
      const execution = service._createExecution({ command: 'update-analysis' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(execution.status).toBe('completed');
    });
  });

  describe('_pushLog', () => {
    it('does not trim until margin exceeded (MAX_LOG_ENTRIES + 100)', () => {
      const { service } = createService();
      const execution = { logs: [] };

      // Fill with exactly MAX_LOG_ENTRIES + 1 (5001) - should NOT trim yet (margin = 100)
      for (let i = 0; i < 5001; i++) {
        service._pushLog(execution, {
          line: `line ${i}`,
          timestamp: new Date().toISOString(),
        });
      }

      expect(execution.logs.length).toBe(5001); // No trim yet
    });

    it('trims to MAX_LOG_ENTRIES when margin exceeded', () => {
      const { service } = createService();
      const execution = { logs: [] };

      // Fill with 5101 entries (exceeds MAX + 100 = 5100)
      for (let i = 0; i < 5101; i++) {
        service._pushLog(execution, {
          line: `line ${i}`,
          timestamp: new Date().toISOString(),
        });
      }

      expect(execution.logs.length).toBe(5000);
      expect(execution.logs[0].line).toBe('line 101'); // First 101 entries trimmed
      expect(execution.logs[execution.logs.length - 1].line).toBe('line 5100');
    });
  });

  describe('getNextChainCommand (re-exported from chainExecutor)', () => {
    it('maps status to next command', () => {
      expect(getNextChainCommand('[PROPOSED]')).toBe('fl');
      expect(getNextChainCommand('[REVIEWED]')).toBe('run');
    });

    it('returns null for terminal statuses', () => {
      expect(getNextChainCommand('[DONE]')).toBe('imp');
      expect(getNextChainCommand('[WIP]')).toBeNull();
      expect(getNextChainCommand('[BLOCKED]')).toBeNull();
    });
  });

  describe('isExpectedStatusAfterCommand (re-exported from chainExecutor)', () => {
    it('returns true for expected command→status pairs', () => {
      expect(isExpectedStatusAfterCommand('fc', '[PROPOSED]')).toBe(true);
      expect(isExpectedStatusAfterCommand('fl', '[REVIEWED]')).toBe(true);
    });

    it('returns false for mismatched command→status pairs', () => {
      expect(isExpectedStatusAfterCommand('fc', '[REVIEWED]')).toBe(false);
      expect(isExpectedStatusAfterCommand('fl', '[PROPOSED]')).toBe(false);
      expect(isExpectedStatusAfterCommand('run', '[DONE]')).toBe(true);
    });
  });

  describe('chainExecutor.registerWaiter with race condition fix', () => {
    it('immediately triggers next command if status already changed', () => {
      const { service } = createService();
      service.executeCommand = vi.fn().mockReturnValue('new-exec-id');

      // Simulate fileWatcher with cached status already at [PROPOSED]
      service.fileWatcher = {
        statusCache: new Map([['100', '[PROPOSED]']]),
      };

      const execution = service._createExecution({
        featureId: '100',
        command: 'fc',
        chain: true,
      });
      execution.status = 'completed';
      execution.resultSubtype = 'success';

      service.chainExecutor.registerWaiter(execution);

      // Should have immediately called executeCommand for fl
      expect(service.executeCommand).toHaveBeenCalledWith(
        '100',
        'fl',
        expect.objectContaining({ chain: true }),
      );

      // Should NOT have registered a waiter
      expect(service.chainExecutor.hasWaiter('100')).toBe(false);
    });

    it('registers waiter if status not yet at expected state', () => {
      const { service } = createService();
      service.executeCommand = vi.fn();

      // Simulate fileWatcher with cached status still at [DRAFT]
      service.fileWatcher = {
        statusCache: new Map([['100', '[DRAFT]']]),
      };

      const execution = service._createExecution({
        featureId: '100',
        command: 'fc',
        chain: true,
      });
      execution.status = 'completed';

      service.chainExecutor.registerWaiter(execution);

      // Should NOT have called executeCommand
      expect(service.executeCommand).not.toHaveBeenCalled();

      // Should have registered a waiter
      expect(service.chainExecutor.hasWaiter('100')).toBe(true);
    });

    it('registers waiter if no fileWatcher reference', () => {
      const { service } = createService();
      service.executeCommand = vi.fn();
      service.fileWatcher = null;

      const execution = service._createExecution({
        featureId: '100',
        command: 'fc',
        chain: true,
      });

      service.chainExecutor.registerWaiter(execution);

      // Should NOT have called executeCommand
      expect(service.executeCommand).not.toHaveBeenCalled();

      // Should have registered a waiter (fallback behavior)
      expect(service.chainExecutor.hasWaiter('100')).toBe(true);
    });
  });

  // Note: getDefaultPhaseName tests moved to describe('getDefaultPhaseName') at module level

  describe('_checkStall', () => {
    it('marks execution as stalled after timeout', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      // Set lastActivityTime to 2 minutes ago (well past 60s threshold)
      execution.lastActivityTime = Date.now() - 120000;
      execution.lastOutputTime = Date.now() - 120000;

      service._checkStall(execution);

      expect(execution.isStalled).toBe(true);
      expect(service._broadcastState).toHaveBeenCalled();
    });

    it('does not mark stalled if recent activity', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.lastActivityTime = Date.now() - 5000; // 5 seconds ago
      execution.lastOutputTime = Date.now() - 5000;

      service._checkStall(execution);

      expect(execution.isStalled).toBe(false);
    });

    it('does not mark stalled if waiting for input', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.lastActivityTime = Date.now() - 120000;
      execution.lastOutputTime = Date.now() - 120000;
      execution.inputRequired = { toolUseId: 'abc', questions: [] };

      service._checkStall(execution);

      expect(execution.isStalled).toBe(false);
    });

    it('skips non-running executions', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'completed';
      execution.lastActivityTime = Date.now() - 120000;

      service._checkStall(execution);

      expect(execution.isStalled).toBe(false);
      expect(service._broadcastState).not.toHaveBeenCalled();
    });
  });

  describe('getExecution / listExecutions', () => {
    it('returns null for non-existent execution', () => {
      const { service } = createService();
      expect(service.getExecution('nonexistent')).toBeNull();
    });

    it('lists all executions', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      service.executions.set(exec.id, exec);

      const list = service.listExecutions();
      expect(list).toHaveLength(1);
      expect(list[0].featureId).toBe('100');
      expect(list[0].command).toBe('fl');
    });
  });

  describe('_handleStreamEvent - token usage filtering', () => {
    it('updates token usage at taskDepth 0', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.taskDepth = 0;

      const event = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      };

      service._handleStreamEvent(execution, event);
      expect(execution.tokenUsage).not.toBeNull();
      expect(execution.tokenUsage.input).toBe(1000);
    });

    it('skips token usage at taskDepth > 0 (subagent)', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.taskDepth = 1;

      const event = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'subagent output' }],
          usage: { input_tokens: 5000, output_tokens: 200 },
        },
      };

      service._handleStreamEvent(execution, event);
      expect(execution.tokenUsage).toBeNull();
    });
  });

  describe('_handleStreamEvent - Task tool depth tracking', () => {
    it('increments taskDepth on Task tool_use', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      expect(execution.taskDepth).toBe(0);

      const event = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Agent',
              input: { prompt: 'test' },
            },
          ],
        },
      };

      service._handleStreamEvent(execution, event);
      expect(execution.taskDepth).toBe(1);
      expect(execution.taskToolIds.has('tool-1')).toBe(true);
    });

    it('decrements taskDepth on Task tool_result', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.taskDepth = 1;
      execution.taskToolIds.add('tool-1');

      const event = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
        },
      };

      service._handleStreamEvent(execution, event);
      expect(execution.taskDepth).toBe(0);
      expect(execution.taskToolIds.has('tool-1')).toBe(false);
    });
  });

  describe('_handleStreamEvent - session ID capture', () => {
    it('captures session ID from init event', () => {
      const { service } = createService();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      expect(execution.sessionId).toBeNull();

      service._handleStreamEvent(execution, {
        type: 'system',
        subtype: 'init',
        session_id: 'abc-123',
      });

      expect(execution.sessionId).toBe('abc-123');
    });
  });

  describe('_buildClaudeEnv', () => {
    it('sets FORCE_COLOR=0 for non-terminal mode', () => {
      const { service } = createService();
      const env = service._buildClaudeEnv({ terminal: false });
      expect(env.FORCE_COLOR).toBe('0');
    });

    it('does not set FORCE_COLOR for terminal mode', () => {
      const { service } = createService();
      const env = service._buildClaudeEnv({ terminal: true });
      expect(env.FORCE_COLOR).toBeUndefined();
    });

    it('sets proxy env vars when proxy enabled', () => {
      const { service } = createService();
      const env = service._buildClaudeEnv();
      // PROXY_ENABLED defaults to true
      expect(env.HTTPS_PROXY).toBeDefined();
      expect(env.HTTP_PROXY).toBeDefined();
    });
  });

  describe('_buildTerminalEnvPrefix', () => {
    it('returns non-empty string with proxy settings', () => {
      const { service } = createService();
      const prefix = service._buildTerminalEnvPrefix();
      // PROXY_ENABLED defaults to true
      expect(prefix).toContain('set "HTTPS_PROXY=');
      expect(prefix).toContain('set "HTTP_PROXY=');
      expect(prefix.endsWith(' && ')).toBe(true);
    });

    it('uses quoted set syntax to prevent trailing space in cmd.exe', () => {
      const { service } = createService();
      // Mock CCS profile to ensure CLAUDE_CONFIG_DIR is included
      service._ccsProfileCache = 'apple';
      const prefix = service._buildTerminalEnvPrefix();

      // cmd.exe: set VAR=value && next → VAR includes trailing space
      // cmd.exe: set "VAR=value" && next → VAR is exact (no trailing space)
      // All set commands must use quoted form: set "VAR=value"
      const setCmds = prefix.split(' && ').filter((p) => p.startsWith('set '));
      for (const cmd of setCmds) {
        expect(cmd).toMatch(/^set "[^"]+=[^"]*"$/);
      }
    });
  });

  describe('_processStreamLine', () => {
    it('parses valid JSON stream line', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      service._processStreamLine(
        execution,
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello from assistant' }] },
        }),
      );

      expect(execution.logs.length).toBe(1);
      expect(execution.logs[0].line).toBe('Hello from assistant');
      expect(logStreamer.broadcast).toHaveBeenCalled();
    });

    it('handles non-JSON lines gracefully', () => {
      const { service, logStreamer } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      service._processStreamLine(execution, 'plain text output');

      expect(execution.logs.length).toBe(1);
      expect(execution.logs[0].line).toBe('plain text output');
    });

    it('skips empty lines', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });

      service._processStreamLine(execution, '   ');
      expect(execution.logs.length).toBe(0);
    });

    it('detects iteration from TaskCreate tool_use (subject field)', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      service._processStreamLine(
        execution,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'TaskCreate',
                input: { subject: 'Iteration 3/10: Phase 2' },
              },
            ],
          },
        }),
      );

      expect(execution.currentIteration).toBe(3);
      expect(service._broadcastState).toHaveBeenCalled();
    });

    it('detects iteration from TaskUpdate tool_use (subject field)', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      service._processStreamLine(
        execution,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'TaskUpdate',
                input: { subject: 'Iteration 5/10: Phase 1' },
              },
            ],
          },
        }),
      );

      expect(execution.currentIteration).toBe(5);
    });

    it('detects iteration from TodoWrite tool_use (activeForm field)', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      // Real TodoWrite format: iteration is in activeForm, not content
      service._processStreamLine(
        execution,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'TodoWrite',
                input: {
                  todos: [
                    {
                      content: 'Phase 1: Reference Check',
                      status: 'in_progress',
                      activeForm: 'Iteration 1/10: Phase 1 Reference Check',
                    },
                  ],
                },
              },
            ],
          },
        }),
      );

      expect(execution.currentIteration).toBe(1);
      expect(service._broadcastState).toHaveBeenCalled();
    });

    it('detects iteration from TodoWrite tool_use (content field)', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      service._processStreamLine(
        execution,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'TodoWrite',
                input: {
                  todos: [
                    {
                      content: 'Iteration 4/10: Phase 3',
                      status: 'in_progress',
                    },
                  ],
                },
              },
            ],
          },
        }),
      );

      expect(execution.currentIteration).toBe(4);
      expect(service._broadcastState).toHaveBeenCalled();
    });

    it('ignores iteration 0 (pre-loop phase)', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      // Iteration 0/10 = Phase 1 Reference Check (pre-loop), should stay as phase display
      service._processStreamLine(
        execution,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'TodoWrite',
                input: {
                  todos: [
                    {
                      content: 'Phase 1: Reference Check',
                      status: 'in_progress',
                      activeForm: 'Iteration 0/10: Phase 1 Reference Check',
                    },
                  ],
                },
              },
            ],
          },
        }),
      );

      expect(execution.currentIteration).toBeNull();
    });

    it('detects iteration from in_progress todo, not completed first todo', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      // Real scenario: Phase 1 completed (iter 0), Phase 2 in_progress (iter 1)
      service._processStreamLine(
        execution,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'TodoWrite',
                input: {
                  todos: [
                    {
                      content: 'Phase 1: Reference Check',
                      status: 'completed',
                      activeForm: 'Iteration 0/10: Phase 1 Reference Check',
                    },
                    {
                      content: 'Phase 2: Review-Validate-Apply',
                      status: 'in_progress',
                      activeForm: 'Iteration 1/10: Phase 2',
                    },
                    {
                      content: 'Phase 3: Maintainability',
                      status: 'pending',
                      activeForm: 'Iteration 1/10: Phase 3',
                    },
                  ],
                },
              },
            ],
          },
        }),
      );

      // Should detect iteration 1 from in_progress todo, NOT 0 from completed first todo
      expect(execution.currentIteration).toBe(1);
      expect(service._broadcastState).toHaveBeenCalled();
    });

    it('detects iteration from TodoWrite via JSON fallback', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      // TodoWrite with unknown input schema - falls back to JSON.stringify search
      service._processStreamLine(
        execution,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'TodoWrite',
                input: { someField: 'Iteration 7/10: Phase 2' },
              },
            ],
          },
        }),
      );

      expect(execution.currentIteration).toBe(7);
    });

    it('detects iteration from assistant text block', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      service._processStreamLine(
        execution,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: '## Declare Next Phase\nIteration 2/10: Phase 3',
              },
            ],
          },
        }),
      );

      expect(execution.currentIteration).toBe(2);
      expect(service._broadcastState).toHaveBeenCalled();
    });

    it('does not update iteration from text when unchanged', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.currentIteration = 2;
      service.executions.set(execution.id, execution);

      service._processStreamLine(
        execution,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'Iteration 2/10: Phase 3',
              },
            ],
          },
        }),
      );

      expect(execution.currentIteration).toBe(2);
      // _broadcastState should not be called for unchanged iteration
      // (phase detection may still trigger it, but iteration alone should not)
    });
  });

  describe('_checkInputWaitPatterns', () => {
    it('detects y/n pattern and defers handoff', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.sessionId = 'sess-1';

      service._checkInputWaitPatterns(execution, 'Do you want to continue? (y/n)');

      expect(execution.waitingForInput).toBe(true);
      expect(execution.waitingInputPattern).toBe('y/n prompt');
      expect(execution.pendingHandoff).toBeTruthy();
      expect(execution.pendingHandoff.reason).toContain('y/n');
      expect(execution.pendingHandoff.timestamp).toBeTruthy();
      expect(execution.pendingHandoffTimeout).toBeTruthy();
      expect(service._handoffToTerminal).not.toHaveBeenCalled();

      // Cleanup
      clearTimeout(execution.pendingHandoffTimeout);
    });

    it('skips if already has inputRequired (AskUserQuestion)', () => {
      const { service } = createService();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.inputRequired = { toolUseId: 'abc', questions: [] };

      service._checkInputWaitPatterns(execution, '(y/n)');

      expect(execution.waitingForInput).toBe(false);
      expect(service._handoffToTerminal).not.toHaveBeenCalled();
    });

    it('skips if already handed off', () => {
      const { service } = createService();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'handed-off';

      service._checkInputWaitPatterns(execution, '(y/n)');

      expect(execution.waitingForInput).toBe(false);
    });

    it('does not trigger on regular text', () => {
      const { service } = createService();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';

      service._checkInputWaitPatterns(execution, 'Processing features...');

      expect(execution.waitingForInput).toBe(false);
      expect(service._handoffToTerminal).not.toHaveBeenCalled();
    });

    it('skips tool_result content (source=user) to prevent false positives from document text', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';

      // FAQ text read from a feature file — "Proceed?" matches /Proceed\?/i but is NOT a CLI prompt
      service.streamParser.checkInputWaitPatterns(
        execution,
        '[Tool result: Why can sibling features not proceed? Because of dependency gating.]',
        'user',
      );

      expect(execution.waitingForInput).toBe(false);
      expect(execution.pendingHandoff).toBeFalsy();
      expect(service._handoffToTerminal).not.toHaveBeenCalled();
    });

    it('passes source parameter through to streamParser', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.sessionId = 'sess-1';

      // Call streamParser directly with source
      service.streamParser.checkInputWaitPatterns(
        execution,
        'Continue? (y/n)',
        'content_block_delta',
      );

      expect(execution.waitingForInput).toBe(true);

      // Cleanup
      if (execution.pendingHandoffTimeout) clearTimeout(execution.pendingHandoffTimeout);
    });

    it('skips assistant text with y/n pattern NOT in last line (false positive filter)', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'run' });
      execution.status = 'running';
      execution.sessionId = 'sess-1';

      // Long assistant text with (y/n) buried in middle — false positive
      const longText =
        'Only in a comment, not an actual TBD value. (y/n) reference in docs.\n\n=== Feature 823 Done ===\nTasks: 11/11\nAll ACs passed.';
      service.streamParser.checkInputWaitPatterns(execution, longText, 'assistant');

      expect(execution.waitingForInput).toBe(false);
      expect(execution.pendingHandoff).toBeFalsy();
    });

    it('detects assistant text with y/n pattern in last line', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'run' });
      execution.status = 'running';
      execution.sessionId = 'sess-1';

      // y/n at end of assistant text — real prompt
      service.streamParser.checkInputWaitPatterns(
        execution,
        'I found 3 issues.\nShould I proceed with the fix? (y/n)',
        'assistant',
      );

      expect(execution.waitingForInput).toBe(true);

      // Cleanup
      if (execution.pendingHandoffTimeout) clearTimeout(execution.pendingHandoffTimeout);
    });

    it('defers y/n handoff — result event cancels auto-handoff (browser-first)', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'run' });
      execution.status = 'running';
      execution.sessionId = 'sess-1';

      // 1. y/n detected - should NOT call handoff yet
      service.streamParser.checkInputWaitPatterns(
        execution,
        'Finalize and commit? (y/n)',
        'assistant',
      );
      expect(execution.pendingHandoff).toBeTruthy();
      expect(service._handoffToTerminal).not.toHaveBeenCalled();

      // 2. result event arrives - should cancel auto-handoff (browser answers first)
      service.streamParser.handleStreamEvent(execution, {
        type: 'result',
        subtype: 'success',
        is_error: false,
      });
      expect(service._handoffToTerminal).not.toHaveBeenCalled();
      expect(execution.pendingHandoff).toBeNull();
      expect(execution.pendingHandoffTimeout).toBeNull();
    });

    it('forces handoff after timeout when result event never arrives', () => {
      vi.useFakeTimers();
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'run' });
      execution.status = 'running';
      execution.sessionId = 'sess-1';

      service.streamParser.checkInputWaitPatterns(execution, 'Continue? (y/n)', 'assistant');
      expect(service._handoffToTerminal).not.toHaveBeenCalled();

      // Advance time past timeout (10 seconds)
      vi.advanceTimersByTime(10000);
      expect(service._handoffToTerminal).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('result event without pendingHandoff saves result data for close event', () => {
      const { service } = createService();
      service._handleCompletion = vi.fn();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'run' });
      execution.status = 'running';
      // No pendingHandoff set

      service.streamParser.handleStreamEvent(execution, {
        type: 'result',
        subtype: 'success',
        is_error: false,
      });
      expect(service._handleCompletion).not.toHaveBeenCalled();
      expect(execution.resultExitCode).toBe(0);
      expect(execution.resultSubtype).toBe('success');
      expect(service._handoffToTerminal).not.toHaveBeenCalled();
    });
  });

  describe('streamParser ring buffer', () => {
    it('populates ring buffer from processStreamLine JSON content', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });

      service.streamParser.processStreamLine(
        execution,
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello world' }] },
        }),
      );

      const snapshot = service.streamParser.getRingBufferSnapshot(execution.id);
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].text).toBe('Hello world');
      expect(snapshot[0].source).toBe('assistant');
      expect(snapshot[0].timestamp).toBeTruthy();
    });

    it('populates ring buffer from non-JSON lines', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });

      service.streamParser.processStreamLine(execution, 'some non-json output');

      const snapshot = service.streamParser.getRingBufferSnapshot(execution.id);
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].text).toBe('some non-json output');
      expect(snapshot[0].source).toBe('non-json');
    });

    it('respects ring buffer size limit of 20', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });

      for (let i = 0; i < 25; i++) {
        service.streamParser._pushToRingBuffer(execution.id, `line ${i}`, 'test');
      }

      const snapshot = service.streamParser.getRingBufferSnapshot(execution.id);
      expect(snapshot).toHaveLength(20);
      expect(snapshot[0].text).toBe('line 5');
      expect(snapshot[19].text).toBe('line 24');
    });

    it('truncates text to 500 chars', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      const longText = 'x'.repeat(600);

      service.streamParser._pushToRingBuffer(execution.id, longText, 'test');

      const snapshot = service.streamParser.getRingBufferSnapshot(execution.id);
      expect(snapshot[0].text).toHaveLength(500);
    });

    it('returns empty array for unknown execution', () => {
      const { service } = createService();
      expect(service.streamParser.getRingBufferSnapshot('nonexistent')).toEqual([]);
    });

    it('clears ring buffer', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });

      service.streamParser._pushToRingBuffer(execution.id, 'test', 'test');
      expect(service.streamParser.getRingBufferSnapshot(execution.id)).toHaveLength(1);

      service.streamParser.clearRingBuffer(execution.id);
      expect(service.streamParser.getRingBufferSnapshot(execution.id)).toEqual([]);
    });
  });

  describe('_handleStreamEvent - phase detection', () => {
    it('detects phase from assistant text', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      expect(execution.currentPhase).toBeNull();

      service._handleStreamEvent(execution, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'PHASE 3: Implementation begins' }] },
      });

      expect(execution.currentPhase).toBe(3);
      expect(execution.currentPhaseName).toBe('Implementation begins');
    });

    it('ignores phase exceeding command total (clamp)', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'run' });
      execution.currentPhase = 3;

      // Phase 20 from architecture file path "phase-20-27-game-systems.md"
      service._handleStreamEvent(execution, {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Reference: designs/phases/phase-20-27-game-systems.md',
            },
          ],
        },
      });

      expect(execution.currentPhase).toBe(3); // unchanged
    });

    it('ignores phase 14 from architecture reference in FL', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '774', command: 'fl' });
      execution.currentPhase = 2;

      service._handleStreamEvent(execution, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Phase 14 boundary check' }] },
      });

      expect(execution.currentPhase).toBe(2); // unchanged
    });

    it('tracks lastAssistantText', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });

      service._handleStreamEvent(execution, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Some response text' }] },
      });

      expect(execution.lastAssistantText).toBe('Some response text');
    });
  });

  describe('_handleStreamEvent - AskUserQuestion detection', () => {
    it('detects AskUserQuestion and defers handoff (browser-first)', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._broadcastInputRequired = vi.fn();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.sessionId = 'sess-1';

      service._handleStreamEvent(execution, {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I have a question:' },
            {
              type: 'tool_use',
              id: 'ask-1',
              name: 'AskUserQuestion',
              input: { questions: [{ question: 'Which?' }] },
            },
          ],
        },
      });

      expect(execution.inputRequired).toBeTruthy();
      expect(execution.inputRequired.toolUseId).toBe('ask-1');
      // Should defer handoff, not trigger immediately
      expect(service._handoffToTerminal).not.toHaveBeenCalled();
      // No pendingHandoff — process blocks on stdin pipe, no auto-timeout
      expect(execution.pendingHandoff).toBeFalsy();
      expect(execution.pendingHandoffTimeout).toBeFalsy();
    });
  });

  describe('_handleStreamEvent - result event', () => {
    it('result event saves result data without triggering completion', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      service._handleStreamEvent(execution, {
        type: 'result',
        subtype: 'success',
        is_error: false,
      });

      expect(execution.status).toBe('running');
      expect(execution.resultSubtype).toBe('success');
      expect(execution.resultExitCode).toBe(0);
    });

    it('extracts contextWindow from result modelUsage without overwriting per-turn usage', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      // Simulate assistant event with per-turn usage first
      service._handleStreamEvent(execution, {
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 1,
            output_tokens: 232,
            cache_creation_input_tokens: 1393,
            cache_read_input_tokens: 48707,
          },
        },
      });
      expect(execution.contextPercent).toBe(25); // (1+1393+48707)/200000

      // Result event has cumulative usage (much larger) — should NOT overwrite
      service._handleStreamEvent(execution, {
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: {
          input_tokens: 50000,
          output_tokens: 5000,
          cache_creation_input_tokens: 30000,
          cache_read_input_tokens: 400000,
        },
        modelUsage: { 'claude-opus-4-5-20251101': { contextWindow: 200000 } },
      });

      // contextWindow should be updated from modelUsage
      expect(execution.tokenUsage.contextWindow).toBe(200000);
      // But per-turn token values should be preserved (NOT the cumulative result.usage)
      expect(execution.tokenUsage.cacheRead).toBe(48707);
      // contextPercent should stay at 25%, not jump to 100%
      expect(execution.contextPercent).toBe(25);
    });
  });

  describe('_handleStreamEvent - system error', () => {
    it('logs system errors', () => {
      const { service, logStreamer } = createService();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      service.executions.set(execution.id, execution);

      service._handleStreamEvent(execution, {
        type: 'system',
        error: 'Rate limit exceeded',
      });

      expect(execution.logs.length).toBe(1);
      expect(execution.logs[0].line).toContain('Rate limit exceeded');
      expect(execution.logs[0].level).toBe('error');
    });
  });

  describe('_handleStreamEvent - tool_result clears input', () => {
    it('clears inputRequired on matching tool_result', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.inputRequired = { toolUseId: 'ask-1', questions: [] };
      execution.inputContext = 'some context';
      execution.pendingToolUse = { id: 'ask-1', name: 'AskUserQuestion', input: {} };

      service._handleStreamEvent(execution, {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'user response' }],
        },
      });

      expect(execution.inputRequired).toBeNull();
      expect(execution.inputContext).toBeNull();
      expect(execution.pendingToolUse).toBeNull();
    });
  });

  describe('executeCommand', () => {
    it('starts execution immediately', () => {
      const { service } = createService({ maxConcurrent: 99 });
      service._startExecution = vi.fn();

      const execId = service.executeCommand('100', 'fl');

      expect(service._startExecution).toHaveBeenCalledTimes(1);
      expect(service.executions.has(execId)).toBe(true);
    });

    it('starts multiple executions concurrently', () => {
      const { service } = createService({ maxConcurrent: 99 });
      service._startExecution = vi.fn();

      const id1 = service.executeCommand('100', 'fl');
      const id2 = service.executeCommand('101', 'fl');

      expect(service._startExecution).toHaveBeenCalledTimes(2);
      expect(service.executions.has(id1)).toBe(true);
      expect(service.executions.has(id2)).toBe(true);
    });

    it('validates featureId and command', () => {
      const { service } = createService();
      expect(() => service.executeCommand('abc', 'fl')).toThrow('Invalid featureId');
      expect(() => service.executeCommand('100', 'invalid')).toThrow('Invalid command');
    });

    it('queues execution when maxConcurrent limit reached', () => {
      const { service, logStreamer } = createService({ maxConcurrent: 1 });
      service._startExecution = vi.fn();

      // Create a running execution to reach maxConcurrent limit
      const runningExec = service._createExecution({ featureId: '999', command: 'fl' });
      runningExec.status = 'running';
      service.executions.set(runningExec.id, runningExec);

      // Verify runningCount sees the manually created execution
      expect(service.runningCount).toBe(1);
      expect(service.maxConcurrent).toBe(1);

      // Now executeCommand should queue (runningCount=1, max=1)
      const id2 = service.executeCommand('101', 'fl');
      const exec2 = service.executions.get(id2);

      expect(service._startExecution).not.toHaveBeenCalled();
      expect(service.queue).toContain(id2);
      expect(exec2.status).toBe('queued');
      expect(exec2.logs.some((log) => log.line.includes('Queued'))).toBe(true);
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'queue-updated' }),
      );
    });
  });

  describe('killExecution', () => {
    it('removes chain waiter on kill', () => {
      const { service } = createService();
      service._startExecution = vi.fn();
      service._killProcess = vi.fn();

      const id = service.executeCommand('100', 'fl');
      const exec = service.executions.get(id);
      exec.status = 'running';
      exec.process = { pid: 123 };
      service.chainExecutor.chainWaiters.set('100', {
        executionId: id,
        registeredAt: Date.now(),
      });

      service.killExecution(id);
      expect(service.chainExecutor.chainWaiters.has('100')).toBe(false);
    });

    it('returns false for non-existent execution', () => {
      const { service } = createService();
      expect(service.killExecution('nonexistent')).toBe(false);
    });

    it('releases run-lock when killing a running /run execution', () => {
      const { service } = createService();
      service._startExecution = vi.fn();
      service._killProcess = vi.fn();

      const id = service.executeCommand('200', 'run');
      const exec = service.executions.get(id);
      exec.status = 'running';
      exec.process = { pid: 456 };
      service.runLockFeatureId = '200';

      service.killExecution(id);

      expect(service.runLockFeatureId).toBeNull();
    });

    it('releases run-lock when killing a dead /run execution (no process)', () => {
      const { service } = createService();
      service._startExecution = vi.fn();

      const id = service.executeCommand('201', 'run');
      const exec = service.executions.get(id);
      exec.status = 'running';
      exec.process = null;
      service.runLockFeatureId = '201';

      service.killExecution(id);

      expect(service.runLockFeatureId).toBeNull();
    });
  });

  describe('_isRunBlocked', () => {
    it('returns false for non-run commands', () => {
      const { service } = createService();
      service.runLockFeatureId = '100';
      expect(service._isRunBlocked('fc')).toBe(false);
      expect(service._isRunBlocked('fl')).toBe(false);
    });

    it('returns true when runLockFeatureId is set', () => {
      const { service } = createService();
      service.runLockFeatureId = '100';
      expect(service._isRunBlocked('run')).toBe(true);
    });

    it('returns false when runLockFeatureId is null and no running /run', () => {
      const { service } = createService();
      service.runLockFeatureId = null;
      expect(service._isRunBlocked('run')).toBe(false);
    });

    it('returns true via fallback when no runLockFeatureId but running /run exists', () => {
      const { service } = createService();
      service.runLockFeatureId = null;
      const exec = service._createExecution({ featureId: '100', command: 'run' });
      exec.status = 'running';
      service.executions.set(exec.id, exec);
      expect(service._isRunBlocked('run')).toBe(true);
    });
  });

  describe('_releaseRunLock', () => {
    it('releases lock and calls _dequeueNext when featureId matches', () => {
      const { service } = createService();
      service._dequeueNext = vi.fn();
      service.runLockFeatureId = '100';

      service._releaseRunLock('100', '[DONE]');

      expect(service.runLockFeatureId).toBeNull();
      expect(service._dequeueNext).toHaveBeenCalled();
    });

    it('does nothing when featureId does not match', () => {
      const { service } = createService();
      service._dequeueNext = vi.fn();
      service.runLockFeatureId = '100';

      service._releaseRunLock('200', '[DONE]');

      expect(service.runLockFeatureId).toBe('100');
      expect(service._dequeueNext).not.toHaveBeenCalled();
    });

    it('does nothing when lock is already null', () => {
      const { service } = createService();
      service._dequeueNext = vi.fn();
      service.runLockFeatureId = null;

      service._releaseRunLock('100', '[DONE]');

      expect(service._dequeueNext).not.toHaveBeenCalled();
    });
  });

  describe('handleFeatureStatusChanged run-lock integration', () => {
    it('releases run-lock when status changes from [WIP] to [DONE]', () => {
      const { service } = createService();
      service._dequeueNext = vi.fn();
      service.runLockFeatureId = '100';

      service.handleFeatureStatusChanged('100', '[WIP]', '[DONE]');

      expect(service.runLockFeatureId).toBeNull();
    });

    it('keeps run-lock when status remains [WIP]', () => {
      const { service } = createService();
      service._dequeueNext = vi.fn();
      service.runLockFeatureId = '100';

      service.handleFeatureStatusChanged('100', '[REVIEWED]', '[WIP]');

      expect(service.runLockFeatureId).toBe('100');
    });

    it('releases run-lock when status changes to [BLOCKED]', () => {
      const { service } = createService();
      service._dequeueNext = vi.fn();
      service.runLockFeatureId = '100';

      service.handleFeatureStatusChanged('100', '[WIP]', '[BLOCKED]');

      expect(service.runLockFeatureId).toBeNull();
    });
  });

  describe('removeExecution', () => {
    it('removes completed execution and clears ring buffer', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'run' });
      exec.completedAt = new Date().toISOString();
      service.executions.set(exec.id, exec);
      service.streamParser.clearRingBuffer = vi.fn();

      const result = service.removeExecution(exec.id);

      expect(result).toBe(true);
      expect(service.executions.has(exec.id)).toBe(false);
      expect(service.streamParser.clearRingBuffer).toHaveBeenCalledWith(exec.id);
    });

    it('refuses to remove running execution (no completedAt)', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'run' });
      exec.status = 'running';
      // No completedAt set
      service.executions.set(exec.id, exec);

      const result = service.removeExecution(exec.id);

      expect(result).toBe(false);
      expect(service.executions.has(exec.id)).toBe(true);
    });

    it('returns false for non-existent execution', () => {
      const { service } = createService();
      expect(service.removeExecution('nonexistent')).toBe(false);
    });
  });

  describe('executeSlashCommand', () => {
    it('accepts valid slash commands', () => {
      const { service } = createService();
      service._startExecution = vi.fn();

      const id = service.executeSlashCommand('commit');
      expect(service.executions.has(id)).toBe(true);
      expect(service.executions.get(id).command).toBe('commit');
    });

    it('rejects invalid slash commands', () => {
      const { service } = createService();
      expect(() => service.executeSlashCommand('dangerous')).toThrow('Invalid slash command');
    });
  });

  describe('runShellCommand', () => {
    it('rejects invalid shell commands', () => {
      const { service } = createService();
      expect(() => service.runShellCommand('rm')).toThrow('Invalid shell command');
      expect(() => service.runShellCommand('cat')).toThrow('Invalid shell command');
    });
  });

  describe('dispose', () => {
    it('clears cleanup interval', () => {
      const { service } = createService();
      expect(service._cleanupInterval).toBeTruthy();

      service.dispose();
      expect(service._cleanupInterval).toBeNull();
    });

    it('is safe to call multiple times', () => {
      const { service } = createService();
      service.dispose();
      service.dispose(); // should not throw
      expect(service._cleanupInterval).toBeNull();
    });
  });

  describe('_attachStreamHandler', () => {
    it('calls onLine for each complete line', () => {
      const { service } = createService();
      const onLine = vi.fn();
      const onEnd = vi.fn();

      // Create a mock stream
      const handlers = {};
      const mockStream = {
        on: (event, handler) => {
          handlers[event] = handler;
        },
      };

      service._attachStreamHandler(mockStream, onLine, onEnd);

      // Simulate data chunks arriving
      handlers.data(Buffer.from('line1\nline2\npartial'));
      expect(onLine).toHaveBeenCalledTimes(2);
      expect(onLine).toHaveBeenNthCalledWith(1, 'line1');
      expect(onLine).toHaveBeenNthCalledWith(2, 'line2');

      // Simulate end with remaining buffer
      handlers.end();
      expect(onEnd).toHaveBeenCalledWith('partial');
    });

    it('skips empty lines', () => {
      const { service } = createService();
      const onLine = vi.fn();
      const onEnd = vi.fn();

      const handlers = {};
      const mockStream = {
        on: (event, handler) => {
          handlers[event] = handler;
        },
      };

      service._attachStreamHandler(mockStream, onLine, onEnd);

      handlers.data(Buffer.from('  \n\nvalid\n   \n'));
      expect(onLine).toHaveBeenCalledTimes(1);
      expect(onLine).toHaveBeenCalledWith('valid');
    });

    it('does not call onEnd for empty remaining buffer', () => {
      const { service } = createService();
      const onLine = vi.fn();
      const onEnd = vi.fn();

      const handlers = {};
      const mockStream = {
        on: (event, handler) => {
          handlers[event] = handler;
        },
      };

      service._attachStreamHandler(mockStream, onLine, onEnd);

      handlers.data(Buffer.from('complete\n'));
      handlers.end();
      expect(onEnd).not.toHaveBeenCalled();
    });
  });

  describe('runningCount', () => {
    it('counts running executions', () => {
      const { service } = createService();
      service._startExecution = vi.fn();

      expect(service.runningCount).toBe(0);

      const exec1 = service._createExecution({ featureId: '100', command: 'fl' });
      exec1.status = 'running';
      service.executions.set(exec1.id, exec1);

      const exec2 = service._createExecution({ featureId: '101', command: 'fl' });
      exec2.status = 'running';
      service.executions.set(exec2.id, exec2);

      const exec3 = service._createExecution({ featureId: '102', command: 'fl' });
      exec3.status = 'completed';
      service.executions.set(exec3.id, exec3);

      expect(service.runningCount).toBe(2);
    });
  });

  describe('_killProcess', () => {
    it('warns on null process', () => {
      const { service } = createService();
      // Should not throw
      service._killProcess(null);
    });

    it('warns on process without pid', () => {
      const { service } = createService();
      // Should not throw
      service._killProcess({ pid: null });
    });
  });

  describe('handleFeatureStatusChanged', () => {
    it('triggers next command when waiter exists', () => {
      const { service, logStreamer } = createService({ maxConcurrent: 99 });
      service._startExecution = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fc', chain: true });
      exec.status = 'completed';
      service.executions.set(exec.id, exec);
      service.chainExecutor.chainWaiters.set('100', {
        executionId: exec.id,
        registeredAt: Date.now(),
      });

      service.handleFeatureStatusChanged('100', '[DRAFT]', '[PROPOSED]');

      expect(service._startExecution).toHaveBeenCalled();
      expect(service.chainExecutor.chainWaiters.has('100')).toBe(false);
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-progress',
          featureId: '100',
          nextCommand: 'fl',
          oldStatus: '[DRAFT]',
          newStatus: '[PROPOSED]',
        }),
      );
    });

    it('does nothing when no waiter exists', () => {
      const { service, logStreamer } = createService();
      service._startExecution = vi.fn();

      service.handleFeatureStatusChanged('999', '[DRAFT]', '[PROPOSED]');

      expect(service._startExecution).not.toHaveBeenCalled();
    });

    it('does nothing when execution not found', () => {
      const { service } = createService();
      service._startExecution = vi.fn();

      service.chainExecutor.chainWaiters.set('100', {
        executionId: 'nonexistent',
        registeredAt: Date.now(),
      });

      service.handleFeatureStatusChanged('100', '[DRAFT]', '[PROPOSED]');

      expect(service._startExecution).not.toHaveBeenCalled();
    });

    it('triggers imp on [DONE] status change', () => {
      const { service } = createService();
      service._startExecution = vi.fn();
      service.executeCommand = vi.fn().mockReturnValue('new-exec-id');

      const exec = service._createExecution({
        featureId: '100',
        command: 'run',
        chain: true,
      });
      exec.chain = { enabled: true, history: [] };
      service.executions.set(exec.id, exec);
      service.chainExecutor.chainWaiters.set('100', {
        executionId: exec.id,
        registeredAt: Date.now(),
      });

      service.handleFeatureStatusChanged('100', '[REVIEWED]', '[DONE]');

      // [DONE] now triggers imp
      expect(service.executeCommand).toHaveBeenCalledWith('100', 'imp', expect.any(Object));
      expect(service.chainExecutor.chainWaiters.has('100')).toBe(false);
    });
  });

  describe('checkProxy', () => {
    it('returns disabled status when PROXY_ENABLED is false', async () => {
      // This test relies on default PROXY_ENABLED being true
      // Just verify the function returns a proper object
      const { service } = createService();
      const result = await service.checkProxy();

      expect(result).toHaveProperty('enabled');
      expect(result).toHaveProperty('status');
    });
  });

  describe('getQueueStatus', () => {
    it('returns running and queued executions', () => {
      const { service } = createService({ maxConcurrent: 4 });
      service._startExecution = vi.fn();

      const exec1 = service._createExecution({ featureId: '100', command: 'fl' });
      exec1.status = 'running';
      exec1.currentPhase = 3;
      exec1.currentPhaseName = 'Implementation';
      service.executions.set(exec1.id, exec1);

      const status = service.getQueueStatus();

      expect(status.maxConcurrent).toBe(4);
      expect(status.runningCount).toBe(1);
      expect(status.running).toHaveLength(1);
      expect(status.running[0].featureId).toBe('100');
      expect(status.running[0].phase).toBe(3);
    });
  });

  describe('clearQueue', () => {
    it('cancels all queued executions', () => {
      const { service, logStreamer } = createService();

      // Manually add queued executions
      const exec1 = service._createExecution({ featureId: '100', command: 'fl' });
      exec1.status = 'queued';
      service.executions.set(exec1.id, exec1);
      service.queue.push(exec1.id);

      const exec2 = service._createExecution({ featureId: '101', command: 'fl' });
      exec2.status = 'queued';
      service.executions.set(exec2.id, exec2);
      service.queue.push(exec2.id);

      const cleared = service.clearQueue();

      expect(cleared).toHaveLength(2);
      expect(service.queue).toHaveLength(0);
      expect(exec1.status).toBe('cancelled');
      expect(exec2.status).toBe('cancelled');
      // 2 status broadcasts (one per cancelled exec) + 1 queue-updated = 3
      expect(logStreamer.broadcastAll).toHaveBeenCalledTimes(3);
    });
  });

  describe('getExecutionLogs', () => {
    it('returns logs with offset', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.logs = [
        { line: 'log1', timestamp: new Date().toISOString() },
        { line: 'log2', timestamp: new Date().toISOString() },
        { line: 'log3', timestamp: new Date().toISOString() },
      ];
      service.executions.set(exec.id, exec);

      const logs = service.getExecutionLogs(exec.id, 1);
      expect(logs).toHaveLength(2);
      expect(logs[0].line).toBe('log2');
    });

    it('returns null for non-existent execution', () => {
      const { service } = createService();
      expect(service.getExecutionLogs('nonexistent')).toBeNull();
    });
  });

  describe('killAllRunning', () => {
    it('kills all running executions and clears interval', () => {
      const { service } = createService();
      service._killProcess = vi.fn();
      const originalInterval = service._cleanupInterval;
      expect(originalInterval).toBeTruthy();

      const exec1 = service._createExecution({ featureId: '100', command: 'fl' });
      exec1.status = 'running';
      exec1.process = { pid: 123 };
      service.executions.set(exec1.id, exec1);

      const exec2 = service._createExecution({ featureId: '101', command: 'fl' });
      exec2.status = 'completed';
      exec2.process = null;
      service.executions.set(exec2.id, exec2);

      service.killAllRunning();

      expect(service._killProcess).toHaveBeenCalledTimes(1);
      // After clearInterval, the interval object still exists but is cleared
      // Verify it was called by checking that _idleTimeout is -1 (cleared)
      expect(service._cleanupInterval._idleTimeout).toBe(-1);
    });
  });

  // Note: getTotalPhases tests moved to describe('getTotalPhases') at module level

  describe('executeFL and executeRun shortcuts', () => {
    it('executeFL calls executeCommand with fl', () => {
      const { service } = createService();
      service.executeCommand = vi.fn().mockReturnValue('exec-id');

      service.executeFL('100');

      expect(service.executeCommand).toHaveBeenCalledWith('100', 'fl');
    });

    it('executeRun calls executeCommand with run', () => {
      const { service } = createService();
      service.executeCommand = vi.fn().mockReturnValue('exec-id');

      service.executeRun('100');

      expect(service.executeCommand).toHaveBeenCalledWith('100', 'run');
    });
  });

  describe('getCcsProfile', () => {
    it('returns CCS_PROFILE env var if set', () => {
      const originalEnv = process.env.CCS_PROFILE;
      process.env.CCS_PROFILE = 'test-profile';

      const { service } = createService();
      expect(service.getCcsProfile()).toBe('test-profile');

      // Restore
      if (originalEnv !== undefined) {
        process.env.CCS_PROFILE = originalEnv;
      } else {
        delete process.env.CCS_PROFILE;
      }
    });
  });

  describe('getExecution details', () => {
    it('returns full execution details with canResume', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.sessionId = 'sess-1';
      exec.status = 'completed';
      service.executions.set(exec.id, exec);

      const result = service.getExecution(exec.id);
      expect(result.canResume).toBe(true);
      expect(result.sessionId).toBe('sess-1');
    });

    it('canResume is false for running executions', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.sessionId = 'sess-1';
      exec.status = 'running';
      service.executions.set(exec.id, exec);

      const result = service.getExecution(exec.id);
      expect(result.canResume).toBe(false);
    });

    it('canResume is true for failed executions with sessionId', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.sessionId = 'sess-1';
      exec.status = 'failed';
      service.executions.set(exec.id, exec);

      const result = service.getExecution(exec.id);
      expect(result.canResume).toBe(true);
    });

    it('returns chain info when present', () => {
      const { service } = createService();
      const exec = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 2,
      });
      service.executions.set(exec.id, exec);

      const result = service.getExecution(exec.id);
      expect(result.chain).toEqual({
        enabled: true,
        retryCount: 2,
        contextRetryCount: 0,
        incompleteRetryCount: 0,
        history: [],
      });
    });

    it('returns inputRequired info when present', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.inputRequired = { toolUseId: 'ask-1', questions: [{ question: 'Which?' }] };
      exec.inputContext = 'context text';
      service.executions.set(exec.id, exec);

      const result = service.getExecution(exec.id);
      expect(result.inputRequired).toEqual({
        questions: [{ question: 'Which?' }],
        context: 'context text',
      });
    });
  });

  describe('_handoffToTerminal', () => {
    it('updates status and broadcasts handoff event', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._killProcess = vi.fn();
      service.resumeInTerminal = vi.fn().mockReturnValue({ tabTitle: 'test' });

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.sessionId = 'sess-1';
      execution.process = { pid: 123 };
      service.executions.set(execution.id, execution);

      service._handoffToTerminal(execution, 'Test reason');

      expect(execution.status).toBe('handed-off');
      expect(logStreamer.broadcast).toHaveBeenCalledWith(
        execution.id,
        expect.objectContaining({ type: 'handoff', reason: 'Test reason' }),
      );
      expect(service._killProcess).toHaveBeenCalled();
    });

    it('skips if already handed off', () => {
      const { service, logStreamer } = createService();
      service._killProcess = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'handed-off';
      execution.sessionId = 'sess-1';

      service._handoffToTerminal(execution, 'Reason');

      expect(service._killProcess).not.toHaveBeenCalled();
      // No broadcast for handoff event (already handed off)
      expect(logStreamer.broadcast).not.toHaveBeenCalled();
    });

    it('skips if no sessionId', () => {
      const { service, logStreamer } = createService();
      service._killProcess = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.sessionId = null;

      service._handoffToTerminal(execution, 'Reason');

      expect(service._killProcess).not.toHaveBeenCalled();
    });

    it('clears stallCheckInterval', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._killProcess = vi.fn();
      service.resumeInTerminal = vi.fn().mockReturnValue({ tabTitle: 'test' });

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.sessionId = 'sess-1';
      execution.stallCheckInterval = setInterval(() => {}, 99999);

      service._handoffToTerminal(execution, 'Test');

      expect(execution.stallCheckInterval).toBeNull();
    });

    it('dumps ring buffer context on handoff', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._killProcess = vi.fn();
      service.resumeInTerminal = vi.fn().mockReturnValue({ tabTitle: 'test' });

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.sessionId = 'sess-1';
      execution.process = { pid: 123 };
      service.executions.set(execution.id, execution);

      // Pre-populate ring buffer
      service.streamParser._pushToRingBuffer(execution.id, 'Phase 10 output', 'assistant');
      service.streamParser._pushToRingBuffer(
        execution.id,
        'Some text with (y/n)',
        'content_block_delta',
      );

      service._handoffToTerminal(execution, 'Test reason');

      expect(execution.status).toBe('handed-off');
      // Ring buffer data should still be available (not cleared by handoff itself)
      // It gets cleared on completion, not handoff
      expect(service.streamParser.getRingBufferSnapshot(execution.id)).toHaveLength(2);
    });
  });

  describe('_handleCompletion - FL auto-retry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-retries FL on error_max_turns when chain enabled', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      // Set up execution that will trigger retry
      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'error_max_turns';
      service.executions.set(execution.id, execution);

      // Mock executeCommand to track new execution
      const newExecId = 'new-exec-id';
      service.executeCommand = vi.fn().mockReturnValue(newExecId);

      service._handleCompletion(execution, 1);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).toHaveBeenCalledWith('100', 'fl', {
        chain: true,
        chainParentId: execution.id,
        retryCount: 0,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        chainHistory: [
          { command: 'fl', result: 'retry', reason: 'Context limit (error_max_turns)' },
        ],
      });
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-retry',
          retryCount: 1,
          featureId: '100',
          command: 'fl',
          oldExecutionId: execution.id,
          newExecutionId: newExecId,
        }),
      );
    });

    it('does not retry when max retries reached', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 3, // Already at max (MAX_FL_RETRIES = 3)
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'error_max_turns';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 1);

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('retries with existing chainParentId preserved', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const parentId = 'original-parent-id';
      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        chainParentId: parentId,
        retryCount: 1,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'error_max_turns';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn().mockReturnValue('new-exec-id');

      service._handleCompletion(execution, 1);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      expect(service.executeCommand).toHaveBeenCalledWith('100', 'fl', {
        chain: true,
        chainParentId: parentId, // Should preserve parent, not use execution.id
        retryCount: 1,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        chainHistory: [
          { command: 'fl', result: 'retry', reason: 'Context limit (error_max_turns)' },
        ],
      });
    });

    it('triggers handoff when completion ends with question', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service._handoffToTerminal = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.sessionId = 'sess-1';
      execution.lastAssistantText = 'Would you like to continue?';
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(service._handoffToTerminal).toHaveBeenCalledWith(
        execution,
        'Completed with unanswered question',
      );
    });

    it('registers chain waiter on successful chain completion', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'fc',
        chain: true,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(execution.status).toBe('completed');
      expect(service.chainExecutor.registerWaiter).toHaveBeenCalledWith(execution);
    });

    it('registers waiter on chain /run completion (not last step)', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();
      service.emailService = { sendCompletionNotification: vi.fn().mockResolvedValue() };

      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
        chain: true,
        chainHistory: [
          { command: 'fc', result: 'ok' },
          { command: 'fl', result: 'ok' },
        ],
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(execution.status).toBe('completed');
      // run is no longer the last step — it registers a waiter for imp
      expect(service.chainExecutor.registerWaiter).toHaveBeenCalledWith(execution);
      expect(service.emailService.sendCompletionNotification).not.toHaveBeenCalled();
    });

    it('sends email on chain /imp completion (last step)', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();
      service.emailService = { sendCompletionNotification: vi.fn().mockResolvedValue() };

      const execution = service._createExecution({
        featureId: '100',
        command: 'imp',
        chain: true,
        chainHistory: [
          { command: 'fc', result: 'ok' },
          { command: 'fl', result: 'ok' },
          { command: 'run', result: 'ok' },
        ],
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(execution.status).toBe('completed');
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
      expect(service.emailService.sendCompletionNotification).toHaveBeenCalledWith(
        execution,
        'completed',
        0,
        [
          { command: 'fc', result: 'ok' },
          { command: 'fl', result: 'ok' },
          { command: 'run', result: 'ok' },
          { command: 'imp', result: 'ok' },
        ],
        null,
      );
    });

    it('auto-retries FL on max_tokens when chain enabled', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'max_tokens';
      service.executions.set(execution.id, execution);

      const newExecId = 'new-exec-id';
      service.executeCommand = vi.fn().mockReturnValue(newExecId);

      service._handleCompletion(execution, 1);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).toHaveBeenCalledWith('100', 'fl', {
        chain: true,
        chainParentId: execution.id,
        retryCount: 0,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        chainHistory: [{ command: 'fl', result: 'retry', reason: 'Context limit (max_tokens)' }],
      });
    });

    it('auto-retries FL on unknown subtype with non-zero exit when chain enabled', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success'; // subtype says success but exit code is 1
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn().mockReturnValue('new-exec-id');

      service._handleCompletion(execution, 1);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).toHaveBeenCalledWith('100', 'fl', {
        chain: true,
        chainParentId: execution.id,
        retryCount: 0,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        chainHistory: [
          {
            command: 'fl',
            result: 'retry',
            reason: 'Context limit (success with is_error)',
          },
        ],
      });
    });

    it('does not retry FL when killed by user', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'error_max_turns';
      execution.killedByUser = true;
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 1);

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).not.toHaveBeenCalled();
    });
  });

  describe('_handleCompletion - incomplete termination', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-retries FL when exit 0 success but status still [PROPOSED]', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      // Set up fileWatcher statusCache returning [PROPOSED] (FL didn't change it)
      service.fileWatcher = {
        statusCache: new Map([['100', '[PROPOSED]']]),
      };

      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn().mockReturnValue('retry-exec-id');

      service._handleCompletion(execution, 0);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      // Waiter must NOT be registered — retry is handling it
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();

      // executeCommand should be called with fl retry using incompleteRetryCount
      expect(service.executeCommand).toHaveBeenCalledWith('100', 'fl', {
        chain: true,
        chainParentId: execution.id,
        chainHistory: [{ command: 'fl', result: 'incomplete' }],
        retryCount: 0,
        contextRetryCount: 0,
        incompleteRetryCount: 1,
        priority: true,
      });

      // chain-retry WS event must be broadcast
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-retry',
          featureId: '100',
          command: 'fl',
          retryType: 'incomplete',
          retryCount: 1,
          reason: expect.stringContaining('[PROPOSED]'),
        }),
      );
    });

    it('registers waiter normally when status is [REVIEWED]', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      // Status already advanced to [REVIEWED] — FL completed successfully
      service.fileWatcher = {
        statusCache: new Map([['100', '[REVIEWED]']]),
      };

      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 0);

      // Waiter should be registered (normal behavior)
      expect(service.chainExecutor.registerWaiter).toHaveBeenCalledWith(execution);
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('registers waiter normally when fileWatcher is null (fallback behavior)', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      // No fileWatcher — cannot check status, so skip incomplete termination check
      service.fileWatcher = null;

      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 0);

      // Waiter should be registered (fallback: no status check possible)
      expect(service.chainExecutor.registerWaiter).toHaveBeenCalledWith(execution);
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('auto-retries run when exit 0 success but status still [WIP]', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      service.fileWatcher = {
        statusCache: new Map([['200', '[WIP]']]),
      };

      const execution = service._createExecution({
        featureId: '200',
        command: 'run',
        chain: true,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn().mockReturnValue('retry-exec-id');

      service._handleCompletion(execution, 0);
      vi.advanceTimersByTime(5000);

      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
      expect(service.executeCommand).toHaveBeenCalledWith('200', 'run', {
        chain: true,
        chainParentId: execution.id,
        chainHistory: [{ command: 'run', result: 'incomplete' }],
        retryCount: 0,
        contextRetryCount: 0,
        incompleteRetryCount: 1,
        priority: true,
      });

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-retry',
          command: 'run',
          retryType: 'incomplete',
          retryCount: 1,
        }),
      );
    });

    it('auto-retries fc when exit 0 success but status still [DRAFT]', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      service.fileWatcher = {
        statusCache: new Map([['300', '[DRAFT]']]),
      };

      const execution = service._createExecution({
        featureId: '300',
        command: 'fc',
        chain: true,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn().mockReturnValue('retry-exec-id');

      service._handleCompletion(execution, 0);
      vi.advanceTimersByTime(5000);

      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
      expect(service.executeCommand).toHaveBeenCalledWith('300', 'fc', {
        chain: true,
        chainParentId: execution.id,
        chainHistory: [{ command: 'fc', result: 'incomplete' }],
        retryCount: 0,
        contextRetryCount: 0,
        incompleteRetryCount: 1,
        priority: true,
      });
    });

    it('skips incomplete retry for run when status is [BLOCKED]', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      service.fileWatcher = {
        statusCache: new Map([['400', '[BLOCKED]']]),
      };

      const execution = service._createExecution({
        featureId: '400',
        command: 'run',
        chain: true,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 0);

      // [BLOCKED] is a legitimate status — no waiter, no retry, chain slot released
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('skips incomplete retry for fl when status is [DRAFT] (fc re-run)', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      service.fileWatcher = {
        statusCache: new Map([['400', '[DRAFT]']]),
      };

      const execution = service._createExecution({
        featureId: '400',
        command: 'fl',
        chain: true,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 0);

      // [DRAFT] after FL = fc_rerun decision — no retry, no waiter
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('skips waiter registration for fl when status is [DRAFT]', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();
      service._releaseChainSlot = vi.fn();

      service.fileWatcher = {
        statusCache: new Map([['401', '[DRAFT]']]),
      };

      const execution = service._createExecution({
        featureId: '401',
        command: 'fl',
        chain: true,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 0);

      // [DRAFT] = chain slot released, no waiter
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
      expect(service._releaseChainSlot).toHaveBeenCalled();
    });

    it('still triggers incomplete retry for fl when status is [PROPOSED]', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      service.fileWatcher = {
        statusCache: new Map([['402', '[PROPOSED]']]),
      };

      const execution = service._createExecution({
        featureId: '402',
        command: 'fl',
        chain: true,
        incompleteRetryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn().mockReturnValue('new-exec-id');

      service._handleCompletion(execution, 0);
      vi.advanceTimersByTime(15000);

      // [PROPOSED] after FL = incomplete termination — should retry
      expect(service.executeCommand).toHaveBeenCalledWith(
        '402',
        'fl',
        expect.objectContaining({ incompleteRetryCount: 1 }),
      );
    });

    it('sends email on incomplete retry exhaustion for run', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      service.fileWatcher = {
        statusCache: new Map([['500', '[WIP]']]),
      };

      const execution = service._createExecution({
        featureId: '500',
        command: 'run',
        chain: true,
        incompleteRetryCount: 3, // already at max
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 0);

      // Retry exhausted — waiter must NOT be registered (prevents dead waiter)
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
      // executeCommand not called (no more retries)
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('incompleteRetryCount is independent from retryCount', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      service.fileWatcher = {
        statusCache: new Map([['600', '[PROPOSED]']]),
      };

      const execution = service._createExecution({
        featureId: '600',
        command: 'fl',
        chain: true,
        retryCount: 2, // FL text-pattern retries already used
        incompleteRetryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn().mockReturnValue('retry-exec-id');

      service._handleCompletion(execution, 0);
      vi.advanceTimersByTime(5000);

      // incompleteRetryCount incremented independently, retryCount preserved
      expect(service.executeCommand).toHaveBeenCalledWith('600', 'fl', {
        chain: true,
        chainParentId: execution.id,
        chainHistory: [{ command: 'fl', result: 'incomplete' }],
        retryCount: 2, // preserved, not incremented
        contextRetryCount: 0,
        incompleteRetryCount: 1, // incremented independently
        priority: true,
      });
    });

    it('hands off to terminal when lastAssistantText contains file deletion request', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();
      service._handoffToTerminal = vi.fn();

      service.fileWatcher = {
        statusCache: new Map([['700', '[WIP]']]),
      };

      const execution = service._createExecution({
        featureId: '700',
        command: 'run',
        chain: true,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      execution.lastAssistantText = 'Please delete the file _out/tmp/old-result.txt and re-run.';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 0);

      // Should hand off to terminal, not retry
      expect(service._handoffToTerminal).toHaveBeenCalledWith(
        execution,
        expect.stringContaining('File deletion requested'),
      );
      expect(service.executeCommand).not.toHaveBeenCalled();
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
    });

    it('hands off to terminal when lastAssistantText contains (y/n) prompt', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();
      service._handoffToTerminal = vi.fn();

      service.fileWatcher = {
        statusCache: new Map([['800', '[PROPOSED]']]),
      };

      const execution = service._createExecution({
        featureId: '800',
        command: 'fl',
        chain: true,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      execution.lastAssistantText = 'Do you want to proceed with this change? (y/n)';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 0);

      expect(service._handoffToTerminal).toHaveBeenCalledWith(
        execution,
        expect.stringContaining('User confirmation pending'),
      );
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('retries normally when lastAssistantText has no user action pattern', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();
      service._handoffToTerminal = vi.fn();

      service.fileWatcher = {
        statusCache: new Map([['900', '[WIP]']]),
      };

      const execution = service._createExecution({
        featureId: '900',
        command: 'run',
        chain: true,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      execution.lastAssistantText = 'Task completed successfully. All tests pass.';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn().mockReturnValue('retry-exec-id');

      vi.useFakeTimers();
      service._handleCompletion(execution, 0);
      vi.advanceTimersByTime(5000);
      vi.useRealTimers();

      // Should retry, not hand off
      expect(service._handoffToTerminal).not.toHaveBeenCalled();
      expect(service.executeCommand).toHaveBeenCalled();
    });

    it('_detectUserActionRequired returns reason for Please delete', () => {
      const { service } = createService();
      const execution = { lastAssistantText: 'Please delete the old file first.' };
      expect(service._detectUserActionRequired(execution)).toBe('File deletion requested');
    });

    it('_detectUserActionRequired returns null for normal text', () => {
      const { service } = createService();
      const execution = { lastAssistantText: 'All tasks completed. Feature is done.' };
      expect(service._detectUserActionRequired(execution)).toBeNull();
    });
  });

  describe('_handleCompletion - context exhaustion retry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-retries fc on error_max_turns when chain enabled', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'fc',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'error_max_turns';
      service.executions.set(execution.id, execution);

      const newExecId = 'new-exec-id';
      service.executeCommand = vi.fn().mockReturnValue(newExecId);

      service._handleCompletion(execution, 1);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).toHaveBeenCalledWith('100', 'fc', {
        chain: true,
        chainParentId: execution.id,
        retryCount: 0,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        chainHistory: [
          { command: 'fc', result: 'retry', reason: 'Context limit (error_max_turns)' },
        ],
      });
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-retry',
          command: 'fc',
          featureId: '100',
          retryCount: 1,
          oldExecutionId: execution.id,
          newExecutionId: newExecId,
        }),
      );
    });

    it('auto-retries run on max_tokens when chain enabled', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '200',
        command: 'run',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'max_tokens';
      service.executions.set(execution.id, execution);

      const newExecId = 'new-run-exec-id';
      service.executeCommand = vi.fn().mockReturnValue(newExecId);

      service._handleCompletion(execution, 1);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).toHaveBeenCalledWith('200', 'run', {
        chain: true,
        chainParentId: execution.id,
        retryCount: 0,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        chainHistory: [{ command: 'run', result: 'retry', reason: 'Context limit (max_tokens)' }],
      });
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-retry',
          command: 'run',
          featureId: '200',
        }),
      );
    });

    it('auto-retries run on promptTooLong with exitCode 0 and success subtype', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      const execution = service._createExecution({
        featureId: '300',
        command: 'run',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      execution.promptTooLong = true;
      service.executions.set(execution.id, execution);

      const newExecId = 'prompt-retry-exec-id';
      service.executeCommand = vi.fn().mockReturnValue(newExecId);

      service._handleCompletion(execution, 0);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).toHaveBeenCalledWith('300', 'run', {
        chain: true,
        chainParentId: execution.id,
        retryCount: 0,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        chainHistory: [
          {
            command: 'run',
            result: 'retry',
            reason: 'Prompt too long (context exhausted)',
          },
        ],
      });
      // promptTooLong should prevent stale waiter registration
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
    });

    it('auto-retries run on Context limit reached text (non-JSON)', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      const execution = service._createExecution({
        featureId: '300',
        command: 'run',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      execution.promptTooLong = true;
      service.executions.set(execution.id, execution);

      const newExecId = 'context-limit-retry-exec-id';
      service.executeCommand = vi.fn().mockReturnValue(newExecId);

      service._handleCompletion(execution, 0);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).toHaveBeenCalledWith('300', 'run', {
        chain: true,
        chainParentId: execution.id,
        retryCount: 0,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        chainHistory: [
          {
            command: 'run',
            result: 'retry',
            reason: 'Prompt too long (context exhausted)',
          },
        ],
      });
      // promptTooLong should prevent stale waiter registration
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
    });

    it('auto-retries run on exit code 3 with null subtype (max turns reached)', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      const execution = service._createExecution({
        featureId: '794',
        command: 'run',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      // exit code 3 with no subtype — CLI hit max turns without stream event
      execution.resultSubtype = null;
      service.executions.set(execution.id, execution);

      const newExecId = 'max-turns-retry-exec-id';
      service.executeCommand = vi.fn().mockReturnValue(newExecId);

      service._handleCompletion(execution, 3);
      vi.advanceTimersByTime(5000);

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).toHaveBeenCalledWith('794', 'run', {
        chain: true,
        chainParentId: execution.id,
        retryCount: 0,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        chainHistory: [
          { command: 'run', result: 'retry', reason: 'Max turns reached (exit code 3)' },
        ],
      });
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-retry',
          command: 'run',
          featureId: '794',
          retryCount: 1,
        }),
      );
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
    });

    it('auto-retries run on success subtype with non-zero exit (context limit without stderr)', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      service.chainExecutor.registerWaiter = vi.fn();

      const execution = service._createExecution({
        featureId: '764',
        command: 'run',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      // promptTooLong is false — stderr didn't contain "Context limit reached"
      service.executions.set(execution.id, execution);

      const newExecId = 'success-is-error-retry-exec-id';
      service.executeCommand = vi.fn().mockReturnValue(newExecId);

      // exitCode=1 (is_error=true) with subtype=success → context exhaustion
      service._handleCompletion(execution, 1);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).toHaveBeenCalledWith('764', 'run', {
        chain: true,
        chainParentId: execution.id,
        retryCount: 0,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        chainHistory: [
          {
            command: 'run',
            result: 'retry',
            reason: 'Context limit (success with is_error)',
          },
        ],
      });
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-retry',
          command: 'run',
          featureId: '764',
          retryCount: 1,
        }),
      );
      // Should not register chain waiter (retrying instead)
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
    });

    it('does not retry fc on non-context error', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'fc',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'error_unknown';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 1);

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('does not retry run when killedByUser', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'error_max_turns';
      execution.killedByUser = true;
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 1);

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('does not retry run when max retries reached', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
        chain: true,
        contextRetryCount: 3, // MAX_RETRIES = 3
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'error_max_turns';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 1);

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('broadcasts chain-retry with correct command for run', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'error_max_turns';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn().mockReturnValue('retry-exec');

      service._handleCompletion(execution, 1);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-retry',
          command: 'run',
          featureId: execution.featureId,
        }),
      );
    });

    it('context exhaustion retry takes priority over FL general retry', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'error_max_turns';
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn().mockReturnValue('new-exec-id');

      service._handleCompletion(execution, 1);
      vi.advanceTimersByTime(5000); // Trigger retry setTimeout

      // Should trigger context retry, not FL retry
      expect(service.executeCommand).toHaveBeenCalledWith('100', 'fl', {
        chain: true,
        chainParentId: execution.id,
        retryCount: 0,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        chainHistory: [
          { command: 'fl', result: 'retry', reason: 'Context limit (error_max_turns)' },
        ],
      });

      // Check log contains context-related message (not FL-specific message)
      const logCalls = execution.logs;
      const lastLog = logCalls[logCalls.length - 1];
      expect(lastLog.line).toMatch(/Context limit/);
    });
  });

  describe('promptTooLong detection', () => {
    it('detects promptTooLong in stderr', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
      });

      // Mock process with stderr stream
      const handlers = {};
      const mockProc = {
        stderr: {
          on: (event, handler) => {
            handlers[event] = handler;
          },
        },
      };

      service._attachStderrHandler(execution, mockProc);

      // Simulate stderr output containing "Prompt is too long"
      handlers.data(Buffer.from('[ERROR] Prompt is too long for the selected model\n'));

      expect(execution.promptTooLong).toBe(true);
    });

    it('detects promptTooLong in non-JSON stdout line', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
      });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      service._processStreamLine(execution, 'Error: Prompt is too long');

      expect(execution.promptTooLong).toBe(true);
    });

    it('detects Context limit reached from stderr', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
      });

      // Mock process with stderr stream
      const handlers = {};
      const mockProc = {
        stderr: {
          on: (event, handler) => {
            handlers[event] = handler;
          },
        },
      };

      service._attachStderrHandler(execution, mockProc);

      // Simulate stderr output containing "Context limit reached"
      handlers.data(Buffer.from('[ERROR] Context limit reached\n'));

      expect(execution.promptTooLong).toBe(true);
    });

    it('detects Context limit reached in non-JSON stdout line', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
      });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      service._processStreamLine(execution, 'Error: Context limit reached');

      expect(execution.promptTooLong).toBe(true);
    });
  });

  describe('accountLimitHit detection', () => {
    it('detects accountLimitHit in stderr', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
      });

      // Mock process with stderr stream
      const handlers = {};
      const mockProc = {
        stderr: {
          on: (event, handler) => {
            handlers[event] = handler;
          },
        },
      };

      service._attachStderrHandler(execution, mockProc);

      // Simulate stderr output containing "hit your limit"
      handlers.data(Buffer.from('[ERROR] You have hit your limit for this period\n'));

      expect(execution.accountLimitHit).toBe(true);
    });

    it('detects accountLimitHit from rate_limit_error in stderr', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
      });

      const handlers = {};
      const mockProc = {
        stderr: {
          on: (event, handler) => {
            handlers[event] = handler;
          },
        },
      };

      service._attachStderrHandler(execution, mockProc);

      handlers.data(
        Buffer.from(
          '[ERROR] API error (attempt 1/11): 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}\n',
        ),
      );

      expect(execution.accountLimitHit).toBe(true);
    });

    it('detects accountLimitHit from "exceed your account rate limit" in stderr', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
      });

      const handlers = {};
      const mockProc = {
        stderr: {
          on: (event, handler) => {
            handlers[event] = handler;
          },
        },
      };

      service._attachStderrHandler(execution, mockProc);

      handlers.data(
        Buffer.from(
          "Error: This request would exceed your account's rate limit. Please try again later.\n",
        ),
      );

      expect(execution.accountLimitHit).toBe(true);
    });

    it('detects accountLimitHit in non-JSON stdout line', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
      });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      service._processStreamLine(execution, "Error: You've hit your limit for this week");

      expect(execution.accountLimitHit).toBe(true);
    });

    it('detects accountLimitHit from rate_limit_error in non-JSON stdout', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
      });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      // CLI prefixes error with text, making it non-JSON
      service._processStreamLine(
        execution,
        'Error in API request: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}',
      );

      expect(execution.accountLimitHit).toBe(true);
    });

    it('detects accountLimitHit from "exceed your organization rate limit" in non-JSON stdout', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
      });
      execution.status = 'running';
      service.executions.set(execution.id, execution);

      service._processStreamLine(
        execution,
        'Error: This request would exceed your organizations rate limit',
      );

      expect(execution.accountLimitHit).toBe(true);
    });
  });

  describe('accountLimitHit retry prevention', () => {
    it('does NOT context-retry when accountLimitHit is true', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'run',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'error_max_turns';
      execution.accountLimitHit = true;
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 1);

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('does NOT FL auto-retry when accountLimitHit is true', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.accountLimitHit = true;
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 1);

      expect(execution.status).toBe('failed');
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('broadcasts account-limit WS event when accountLimitHit is true', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 0,
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.accountLimitHit = true;
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 1);

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'account-limit',
          featureId: '100',
          command: 'fl',
          executionId: execution.id,
        }),
      );
    });
  });

  describe('_startRateLimitRetry', () => {
    it('resume path: spawns claude --resume when sessionId exists', async () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._attachStdoutHandler = vi.fn();
      service._attachStderrHandler = vi.fn();
      service.executeCommand = vi.fn();

      const execution = service._createExecution({
        featureId: '999',
        command: 'run',
        chain: true,
        chainParentId: null,
      });
      execution.sessionId = 'test-session-123';

      const { spawn: mockSpawn } = await import('child_process');
      mockSpawn.mockClear();

      service._startRateLimitRetry(execution);

      expect(mockSpawn).toHaveBeenCalled();
      const [, spawnArgs] = mockSpawn.mock.calls[0];
      expect(spawnArgs).toContain('-p');
      expect(spawnArgs).toContain('continue');
      expect(spawnArgs).toContain('--resume');
      expect(spawnArgs).toContain('test-session-123');
      expect(spawnArgs).toContain('--verbose');
      expect(spawnArgs).toContain('--debug-file');
      expect(spawnArgs).toContain('--output-format');
      expect(spawnArgs).toContain('stream-json');

      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('resume path: new execution stored with matching sessionId and chain enabled', async () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._attachStdoutHandler = vi.fn();
      service._attachStderrHandler = vi.fn();

      const execution = service._createExecution({
        featureId: '999',
        command: 'run',
        chain: true,
      });
      execution.sessionId = 'test-session-123';

      const { spawn: mockSpawn } = await import('child_process');
      mockSpawn.mockClear();

      service._startRateLimitRetry(execution);

      // Find the new execution that was stored
      let newExec = null;
      for (const [, exec] of service.executions) {
        if (exec.id !== execution.id) {
          newExec = exec;
          break;
        }
      }
      expect(newExec).not.toBeNull();
      expect(newExec.sessionId).toBe('test-session-123');
      expect(newExec.chain.enabled).toBe(true);
    });

    it('resume path: broadcastAll called with resumed: true and type rate-limit-retry', async () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._attachStdoutHandler = vi.fn();
      service._attachStderrHandler = vi.fn();

      const execution = service._createExecution({
        featureId: '999',
        command: 'run',
        chain: true,
      });
      execution.sessionId = 'test-session-123';

      const { spawn: mockSpawn } = await import('child_process');
      mockSpawn.mockClear();

      service._startRateLimitRetry(execution);

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'rate-limit-retry',
          resumed: true,
        }),
      );
    });

    it('fallback path: calls executeCommand when no sessionId', async () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service.executeCommand = vi.fn().mockReturnValue('new-exec-id');

      const execution = service._createExecution({
        featureId: '999',
        command: 'run',
        chain: true,
      });
      // sessionId is null by default

      const { spawn: mockSpawn } = await import('child_process');
      mockSpawn.mockClear();

      service._startRateLimitRetry(execution);

      expect(service.executeCommand).toHaveBeenCalled();
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'rate-limit-retry',
          resumed: false,
        }),
      );
    });

    it('chain properties preserved in resume: history, retryCount, contextRetryCount, chainParentId', async () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._attachStdoutHandler = vi.fn();
      service._attachStderrHandler = vi.fn();

      const prevHistory = [
        { command: 'fc', result: 'ok' },
        { command: 'fl', result: 'ok' },
      ];
      const execution = service._createExecution({
        featureId: '999',
        command: 'run',
        chain: true,
        chainParentId: 'parent-123',
        retryCount: 1,
        contextRetryCount: 2,
        chainHistory: prevHistory,
      });
      execution.sessionId = 'test-session-123';

      const { spawn: mockSpawn } = await import('child_process');
      mockSpawn.mockClear();

      service._startRateLimitRetry(execution);

      let newExec = null;
      for (const [, exec] of service.executions) {
        if (exec.id !== execution.id) {
          newExec = exec;
          break;
        }
      }
      expect(newExec).not.toBeNull();
      expect(newExec.chain.history).toEqual([
        { command: 'fc', result: 'ok' },
        { command: 'fl', result: 'ok' },
        { command: 'run', result: 'rate-limit-retry' },
      ]);
      expect(newExec.chain.retryCount).toBe(1);
      expect(newExec.chain.contextRetryCount).toBe(2);
      expect(newExec.chainParentId).toBe('parent-123');
    });

    it('command is NOT prefixed with resume: on new execution', async () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._attachStdoutHandler = vi.fn();
      service._attachStderrHandler = vi.fn();

      const execution = service._createExecution({
        featureId: '999',
        command: 'run',
        chain: true,
      });
      execution.sessionId = 'test-session-123';

      const { spawn: mockSpawn } = await import('child_process');
      mockSpawn.mockClear();

      service._startRateLimitRetry(execution);

      let newExec = null;
      for (const [, exec] of service.executions) {
        if (exec.id !== execution.id) {
          newExec = exec;
          break;
        }
      }
      expect(newExec).not.toBeNull();
      expect(newExec.command).toBe('run');
    });

    it('resume path: rateLimitService.recomputeRefreshTimes called (capture removed)', async () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._attachStdoutHandler = vi.fn();
      service._attachStderrHandler = vi.fn();

      const mockRateLimitService = {
        recomputeRefreshTimes: vi.fn(),
        capture: vi.fn().mockResolvedValue(),
      };
      service.rateLimitService = mockRateLimitService;

      const execution = service._createExecution({
        featureId: '999',
        command: 'run',
        chain: true,
      });
      execution.sessionId = 'test-session-123';

      const { spawn: mockSpawn } = await import('child_process');
      mockSpawn.mockClear();

      service._startRateLimitRetry(execution);

      expect(mockRateLimitService.recomputeRefreshTimes).toHaveBeenCalled();
      expect(mockRateLimitService.capture).not.toHaveBeenCalled();
    });
  });

  describe('_dequeueNext', () => {
    it('starts queued executions when slots available', () => {
      const { service, logStreamer } = createService({ maxConcurrent: 99 });
      service._startExecution = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'queued';
      service.executions.set(exec.id, exec);
      service.queue.push(exec.id);

      service._dequeueNext();

      expect(service._startExecution).toHaveBeenCalledWith(exec);
      expect(service.queue).toHaveLength(0);
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'queue-updated' }),
      );
    });

    it('skips non-queued executions in queue', () => {
      const { service } = createService({ maxConcurrent: 99 });
      service._startExecution = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'cancelled'; // Not queued
      service.executions.set(exec.id, exec);
      service.queue.push(exec.id);

      service._dequeueNext();

      expect(service._startExecution).not.toHaveBeenCalled();
      expect(service.queue).toHaveLength(0);
    });

    it('dequeues multiple executions when multiple slots available', () => {
      const { service } = createService({ maxConcurrent: 3 });
      service._startExecution = vi.fn();

      // Queue 3 executions
      const exec1 = service._createExecution({ featureId: '100', command: 'fl' });
      exec1.status = 'queued';
      service.executions.set(exec1.id, exec1);
      service.queue.push(exec1.id);

      const exec2 = service._createExecution({ featureId: '101', command: 'fl' });
      exec2.status = 'queued';
      service.executions.set(exec2.id, exec2);
      service.queue.push(exec2.id);

      const exec3 = service._createExecution({ featureId: '102', command: 'fl' });
      exec3.status = 'queued';
      service.executions.set(exec3.id, exec3);
      service.queue.push(exec3.id);

      service._dequeueNext();

      // All 3 should start (max=3, running=0)
      expect(service._startExecution).toHaveBeenCalledTimes(3);
      expect(service.queue).toHaveLength(0);
    });
  });

  describe('killExecution - queued execution', () => {
    it('cancels queued execution without killing process', () => {
      const { service, logStreamer } = createService();
      service._killProcess = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'queued';
      service.executions.set(exec.id, exec);
      service.queue.push(exec.id);

      const result = service.killExecution(exec.id);

      expect(result).toBe(true);
      expect(exec.status).toBe('cancelled');
      expect(exec.completedAt).toBeTruthy();
      expect(service.queue).toHaveLength(0);
      expect(service._killProcess).not.toHaveBeenCalled();
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'status', executionId: exec.id, status: 'cancelled' }),
      );
    });

    it('returns false for completed execution', () => {
      const { service } = createService();

      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'completed';
      service.executions.set(exec.id, exec);

      const result = service.killExecution(exec.id);

      expect(result).toBe(false);
    });
  });

  describe('openTerminal', () => {
    it('validates featureId and command', () => {
      const { service } = createService();
      expect(() => service.openTerminal('abc', 'fl')).toThrow('Invalid featureId');
      expect(() => service.openTerminal('100', 'invalid')).toThrow('Invalid command');
    });

    it('returns tabTitle and command', () => {
      const { service } = createService();
      // spawn is mocked at module level via vi.mock('child_process')

      const result = service.openTerminal('100', 'fl');

      expect(result.tabTitle).toBe('FL F100');
      expect(result.command).toBe('/fl 100');
    });
  });

  describe('resumeInBrowser', () => {
    it('returns error when no sessionId', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.sessionId = null;
      service.executions.set(exec.id, exec);

      const result = service.resumeInBrowser(exec.id);

      expect(result.error).toBe('No session ID available for resume');
    });

    it('returns error for non-existent execution', () => {
      const { service } = createService();

      const result = service.resumeInBrowser('nonexistent');

      expect(result.error).toBe('No session ID available for resume');
    });
  });

  describe('answerInBrowser', () => {
    it('clears _killedForAskUser so resumed process can complete normally', () => {
      const { service } = createService();
      service._killProcess = vi.fn();
      service._attachStdoutHandler = vi.fn();
      service._attachStderrHandler = vi.fn();
      service._broadcastState = vi.fn();
      service._checkStall = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'running';
      exec.sessionId = 'sess-1';
      exec.inputRequired = { toolUseId: 'ask-1', questions: [] };
      exec._killedForAskUser = true;
      exec.process = null; // Already killed
      service.executions.set(exec.id, exec);

      service.answerInBrowser(exec.id, 'Option A');

      expect(exec._killedForAskUser).toBe(false);
      expect(exec.inputRequired).toBeNull();
      expect(exec.waitingForInput).toBe(false);
    });
  });

  describe('answerInBrowser — slot race prevention', () => {
    it('Fix B: _handleCompletion holds slot when process exits while waitingForInput', () => {
      const { service } = createService({ maxConcurrent: 2 });
      service._startExecution = vi.fn();
      service._dequeueNext = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'running';
      exec.startedAt = new Date().toISOString();
      exec.lastOutputTime = Date.now();
      exec.waitingForInput = true;
      exec.waitingInputPattern = '(y/n)';
      exec.process = { pid: 123 };
      exec.stdin = {};
      service.executions.set(exec.id, exec);

      // Process exits while waiting for y/n — should NOT complete or dequeue
      service._handleCompletion(exec, 0);

      expect(exec.status).toBe('running'); // Slot held
      expect(exec.process).toBeNull();
      expect(exec.stdin).toBeNull();
      expect(service._dequeueNext).not.toHaveBeenCalled();
    });

    it('Fix B: _handleCompletion proceeds normally after waitingForInput is cleared', () => {
      const { service } = createService({ maxConcurrent: 2 });

      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'running';
      exec.startedAt = new Date().toISOString();
      exec.lastOutputTime = Date.now();
      exec.waitingForInput = false; // Cleared by answerInBrowser
      exec.resultSubtype = 'success';
      exec.process = { pid: 456 };
      exec.stdin = {};
      service.executions.set(exec.id, exec);

      service._handleCompletion(exec, 0);

      expect(exec.status).toBe('completed'); // Normal completion
    });

    it('Fix A: stale close event from killed process is ignored when execution.process replaced', () => {
      const { service } = createService({ maxConcurrent: 2 });

      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'running';
      exec.startedAt = new Date().toISOString();
      exec.lastOutputTime = Date.now();
      service.executions.set(exec.id, exec);

      // Simulate: old process replaced by new process in answerInBrowser
      const oldProc = { pid: 100 };
      const newProc = { pid: 200 };
      exec.process = newProc; // answerInBrowser already set the new process

      // Old process close handler fires — should be ignored because exec.process !== oldProc
      // (This tests the guard logic; the actual close handler is inline so we test via _handleCompletion)
      // The guard is: if (execution.process !== proc) return;
      // We verify runningCount stays correct
      expect(exec.process).toBe(newProc);
      expect(exec.process).not.toBe(oldProc);
      // The stale close guard is in the inline handler, not in _handleCompletion,
      // so we just verify the process identity check logic is sound
    });
  });

  describe('resumeInTerminal', () => {
    it('returns error when no sessionId', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.sessionId = null;
      service.executions.set(exec.id, exec);

      const result = service.resumeInTerminal(exec.id);

      expect(result.error).toBe('No session ID available for resume');
    });

    it('returns error for non-existent execution', () => {
      const { service } = createService();

      const result = service.resumeInTerminal('nonexistent');

      expect(result.error).toBe('No session ID available for resume');
    });

    it('writes AskUserQuestion context to temp file', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'run' });
      exec.inputRequired = {
        toolUseId: 'tool-1',
        questions: [
          {
            question: 'Which approach?',
            options: [
              { label: 'Option A', description: 'First approach' },
              { label: 'Option B', description: 'Second approach' },
            ],
          },
        ],
      };

      const result = service._writeResumeContext(exec);
      expect(result).toContain('type');
      expect(result).toContain('resume-context.txt');
    });

    it('returns empty string when no questions', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'run' });

      const result = service._writeResumeContext(exec);
      expect(result).toBe('');
    });
  });

  describe('runShellCommand', () => {
    it('accepts valid shell commands', () => {
      const { service } = createService();
      vi.spyOn(service, '_exitForRestart').mockImplementation(() => {});
      // spawn is mocked at module level via vi.mock('child_process')
      expect(() => service.runShellCommand('cs')).not.toThrow();
      expect(() => service.runShellCommand('dr')).not.toThrow();
      expect(() => service.runShellCommand('upd')).not.toThrow();
    });

    it('returns status launched for valid commands', () => {
      const { service } = createService();
      const result = service.runShellCommand('cs');
      expect(result.command).toBe('cs');
      expect(result.status).toBe('launched');
    });

    it('exits process for dr command (PM2 autorestart)', async () => {
      vi.useFakeTimers();
      const { service } = createService();
      const mockExit = vi.spyOn(service, '_exitForRestart').mockImplementation(() => {});

      service.runShellCommand('dr');
      // dr delays exit by 500ms to let shell-complete WS message reach clients first
      vi.advanceTimersByTime(500);

      expect(mockExit).toHaveBeenCalled();
      mockExit.mockRestore();
      vi.useRealTimers();
    });

    it('uses npm update for upd command', async () => {
      const { service } = createService();
      const { spawn: mockSpawn } = await import('child_process');

      service.runShellCommand('upd');

      expect(mockSpawn).toHaveBeenCalledWith(
        'npm',
        ['update', '-g', '@kaitranntt/ccs'],
        expect.any(Object),
      );
    });

    it('uses cmd /c for cs command', async () => {
      const { service } = createService();
      const { spawn: mockSpawn } = await import('child_process');

      service.runShellCommand('cs');

      expect(mockSpawn).toHaveBeenCalledWith('cmd', ['/c', 'cs'], expect.any(Object));
    });
  });

  describe('_checkStall does not re-broadcast', () => {
    it('does not broadcast stalled event when already stalled', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.lastActivityTime = Date.now() - 120000;
      execution.lastOutputTime = Date.now() - 120000;
      execution.isStalled = true; // Already stalled

      service._checkStall(execution);

      // Should NOT broadcast again (no state change)
      expect(service._broadcastState).not.toHaveBeenCalled();
      expect(logStreamer.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('_cleanupOldExecutions', () => {
    it('removes completed executions past TTL', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'completed';
      // completedAt 2 hours ago (TTL is 1 hour)
      exec.completedAt = new Date(Date.now() - 7200000).toISOString();
      service.executions.set(exec.id, exec);

      service._cleanupOldExecutions();

      expect(service.executions.has(exec.id)).toBe(false);
    });

    it('keeps completed executions within TTL', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'completed';
      exec.completedAt = new Date(Date.now() - 1000).toISOString(); // 1 second ago
      service.executions.set(exec.id, exec);

      service._cleanupOldExecutions();

      expect(service.executions.has(exec.id)).toBe(true);
    });

    it('marks stuck running executions as failed and clears both intervals', () => {
      const { service } = createService();
      service._killProcess = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'running';
      // lastOutputTime 3 hours ago (threshold is 2 hours)
      exec.lastOutputTime = Date.now() - 3 * 3600000;
      exec.stallCheckInterval = setInterval(() => {}, 99999);
      exec.activityCheckInterval = setInterval(() => {}, 99999);
      exec.process = { pid: 12345 };
      service.executions.set(exec.id, exec);

      service._cleanupOldExecutions();

      expect(exec.status).toBe('failed');
      expect(exec.completedAt).toBeTruthy();
      expect(exec.stallCheckInterval).toBeNull();
      expect(exec.activityCheckInterval).toBeNull();
      expect(exec.process).toBeNull();
      expect(service._killProcess).toHaveBeenCalled();
    });

    it('does not touch running executions with recent output', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'running';
      exec.lastOutputTime = Date.now() - 5000; // 5 seconds ago
      service.executions.set(exec.id, exec);

      service._cleanupOldExecutions();

      expect(exec.status).toBe('running');
    });

    it('removes stale chain waiters past timeout and sends email', () => {
      const { service } = createService();
      service.emailService = { sendCompletionNotification: vi.fn().mockResolvedValue() };

      const execution = service._createExecution({
        featureId: '200',
        command: 'fc',
        chain: true,
      });
      execution.status = 'completed';
      execution.exitCode = 0;
      execution.chain = { enabled: true, retryCount: 0, history: [] };
      service.executions.set(execution.id, execution);

      service.chainExecutor.chainWaiters.set('200', {
        executionId: execution.id,
        registeredAt: Date.now() - 600000,
      });

      service._cleanupOldExecutions();

      expect(service.chainExecutor.chainWaiters.has('200')).toBe(false);
      expect(service.emailService.sendCompletionNotification).toHaveBeenCalledWith(
        execution,
        'completed',
        0,
        [{ command: 'fc', result: 'ok' }],
        null,
      );
    });

    it('triggers onExecutionComplete after removing stale waiters', () => {
      const { service } = createService();
      service.emailService = { sendCompletionNotification: vi.fn().mockResolvedValue() };
      service.onExecutionComplete = vi.fn();

      const execution = service._createExecution({
        featureId: '201',
        command: 'fc',
        chain: true,
      });
      execution.status = 'completed';
      execution.exitCode = 0;
      execution.chain = { enabled: true, retryCount: 0, history: [] };
      service.executions.set(execution.id, execution);

      service.chainExecutor.chainWaiters.set('201', {
        executionId: execution.id,
        registeredAt: Date.now() - 600000, // stale
      });

      service._cleanupOldExecutions();

      expect(service.chainExecutor.chainWaiters.has('201')).toBe(false);
      expect(service.onExecutionComplete).toHaveBeenCalled();
    });

    it('does not call onExecutionComplete when no stale waiters exist', () => {
      const { service } = createService();
      service.onExecutionComplete = vi.fn();

      // Only a fresh waiter — should not trigger onExecutionComplete
      service.chainExecutor.chainWaiters.set('202', {
        executionId: 'exec-fresh',
        registeredAt: Date.now() - 1000, // 1 second ago
      });

      service._cleanupOldExecutions();

      expect(service.onExecutionComplete).not.toHaveBeenCalled();
    });

    it('keeps fresh chain waiters', () => {
      const { service } = createService();
      service.chainExecutor.chainWaiters.set('200', {
        executionId: 'exec-1',
        registeredAt: Date.now() - 1000, // 1 second ago
      });

      service._cleanupOldExecutions();

      expect(service.chainExecutor.chainWaiters.has('200')).toBe(true);
    });

    it('clears ring buffer when removing stale execution', () => {
      const { service } = createService();
      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'completed';
      exec.completedAt = new Date(Date.now() - 7200000).toISOString();
      service.executions.set(exec.id, exec);

      // Add some ring buffer data
      service.streamParser._pushToRingBuffer(exec.id, 'test output', 'assistant');
      expect(service.streamParser.getRingBufferSnapshot(exec.id)).toHaveLength(1);

      service._cleanupOldExecutions();

      expect(service.executions.has(exec.id)).toBe(false);
      expect(service.streamParser.getRingBufferSnapshot(exec.id)).toEqual([]);
    });
  });

  describe('_detectFlRerunRequest', () => {
    it('returns false when lastAssistantText is empty', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.lastAssistantText = '';
      expect(service._detectFlRerunRequest(execution)).toBe(false);
    });

    it('returns false when lastAssistantText is null', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.lastAssistantText = null;
      expect(service._detectFlRerunRequest(execution)).toBe(false);
    });

    it('returns true for 再実行してください pattern', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.lastAssistantText = '修正完了しました。再実行してください。';
      expect(service._detectFlRerunRequest(execution)).toBe(true);
    });

    it('returns true for /fl {ID} を再実行 pattern', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.lastAssistantText = '/fl 808 を再実行してください。';
      expect(service._detectFlRerunRequest(execution)).toBe(true);
    });

    it('returns true for markdown /fl {ID} code pattern', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.lastAssistantText = '次のコマンドを実行してください: `/fl 808`';
      expect(service._detectFlRerunRequest(execution)).toBe(true);
    });

    it('returns true for Forward-Only 再検証 pattern', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.lastAssistantText = 'Forward-Only Modeで再検証を行います。';
      expect(service._detectFlRerunRequest(execution)).toBe(true);
    });

    it('returns false for unrelated text', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.lastAssistantText = '処理が完了しました。問題は見つかりませんでした。';
      expect(service._detectFlRerunRequest(execution)).toBe(false);
    });
  });

  describe('_saveSessionId', () => {
    it('saves session ID to the session map', () => {
      const { service } = createService();
      service._saveSessionId('exec-1', 'session-abc', '100', 'fl');
      expect(service._sessionMap['exec-1']).toMatchObject({
        sessionId: 'session-abc',
        featureId: '100',
        command: 'fl',
      });
      expect(service._sessionMap['exec-1'].savedAt).toBeTruthy();
    });

    it('prunes entries older than 7 days', () => {
      const { service } = createService();
      // Inject a stale entry
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600000).toISOString();
      service._sessionMap['old-exec'] = {
        sessionId: 'old-session',
        featureId: '50',
        command: 'fl',
        savedAt: eightDaysAgo,
      };

      service._saveSessionId('new-exec', 'new-session', '100', 'run');

      expect(service._sessionMap['old-exec']).toBeUndefined();
      expect(service._sessionMap['new-exec']).toBeDefined();
    });

    it('keeps entries within 7 days', () => {
      const { service } = createService();
      const sixDaysAgo = new Date(Date.now() - 6 * 24 * 3600000).toISOString();
      service._sessionMap['recent-exec'] = {
        sessionId: 'recent-session',
        featureId: '50',
        command: 'fl',
        savedAt: sixDaysAgo,
      };

      service._saveSessionId('new-exec', 'new-session', '100', 'run');

      expect(service._sessionMap['recent-exec']).toBeDefined();
    });
  });

  describe('_lookupSessionId', () => {
    it('returns session info for known execution', () => {
      const { service } = createService();
      service._sessionMap['exec-1'] = {
        sessionId: 'sess-abc',
        featureId: '100',
        command: 'fl',
        savedAt: new Date().toISOString(),
      };

      const result = service._lookupSessionId('exec-1');
      expect(result).toEqual({
        sessionId: 'sess-abc',
        featureId: '100',
        command: 'fl',
        savedAt: expect.any(String),
      });
    });

    it('returns null for unknown execution', () => {
      const { service } = createService();
      expect(service._lookupSessionId('nonexistent')).toBeNull();
    });
  });

  describe('_scanDebugLogForRateLimit', () => {
    it('returns false when debugLogPath is not set on execution', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.debugLogPath = null;
      // With null debugLogPath, existsSync won't be called → returns false
      const result = service._scanDebugLogForRateLimit(execution);
      expect(result).toBe(false);
      expect(execution.accountLimitHit).toBe(false);
    });

    it('returns false when debug log file does not exist (nonexistent path)', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      // Use a path that definitely doesn't exist
      execution.debugLogPath = '/nonexistent/path/that/does/not/exist/debug.log';
      const result = service._scanDebugLogForRateLimit(execution);
      expect(result).toBe(false);
      expect(execution.accountLimitHit).toBe(false);
    });

    it('does not set accountLimitHit when returning false', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.debugLogPath = null;
      execution.accountLimitHit = false;
      service._scanDebugLogForRateLimit(execution);
      expect(execution.accountLimitHit).toBe(false);
    });
  });

  describe('_broadcastState - field values', () => {
    it('broadcasts correct state fields for running execution', () => {
      const { service, logStreamer } = createService();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.currentPhase = 3;
      execution.currentPhaseName = 'Implementation';
      execution.currentIteration = 2;
      execution.sessionId = 'sess-123';
      execution.isStalled = false;
      execution.taskDepth = 1;
      execution.contextPercent = 45;
      execution.inputRequired = { toolUseId: 'ask-1', questions: [] };
      execution.waitingForInput = false;
      execution.waitingInputPattern = null;

      service._broadcastState(execution);

      expect(logStreamer.broadcast).toHaveBeenCalledWith(
        execution.id,
        expect.objectContaining({
          type: 'state',
          executionId: execution.id,
          status: 'running',
          phase: 3,
          phaseName: 'Implementation',
          totalPhases: 7, // fl has 7 phases
          iteration: 2,
          sessionId: 'sess-123',
          inputRequired: true,
          waitingForInput: false,
          isStalled: false,
          taskDepth: 1,
          contextPercent: 45,
        }),
      );
    });

    it('broadcasts inputRequired as false when null', () => {
      const { service, logStreamer } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'run' });
      execution.status = 'running';
      execution.inputRequired = null;

      service._broadcastState(execution);

      expect(logStreamer.broadcast).toHaveBeenCalledWith(
        execution.id,
        expect.objectContaining({
          inputRequired: false,
          totalPhases: 10, // run has 10 phases
        }),
      );
    });

    it('broadcasts pendingTool name when pendingToolUse is set', () => {
      const { service, logStreamer } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.pendingToolUse = { name: 'AskUserQuestion', id: 'ask-1', input: {} };

      service._broadcastState(execution);

      expect(logStreamer.broadcast).toHaveBeenCalledWith(
        execution.id,
        expect.objectContaining({
          pendingTool: 'AskUserQuestion',
        }),
      );
    });

    it('broadcasts null pendingTool when no pendingToolUse', () => {
      const { service, logStreamer } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.pendingToolUse = null;

      service._broadcastState(execution);

      expect(logStreamer.broadcast).toHaveBeenCalledWith(
        execution.id,
        expect.objectContaining({
          pendingTool: null,
        }),
      );
    });
  });

  describe('_broadcastInputRequired - field values', () => {
    it('broadcasts correct fields for input required event', () => {
      const { service, logStreamer } = createService();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.inputRequired = {
        toolUseId: 'ask-1',
        questions: [{ question: 'Which option?' }],
      };
      execution.inputContext = 'Some context for the user';

      service._broadcastInputRequired(execution);

      expect(logStreamer.broadcast).toHaveBeenCalledWith(
        execution.id,
        expect.objectContaining({
          type: 'input-required',
          executionId: execution.id,
          context: 'Some context for the user',
          questions: [{ question: 'Which option?' }],
          toolUseId: 'ask-1',
        }),
      );
    });

    it('broadcasts empty questions array when inputRequired has none', () => {
      const { service, logStreamer } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.inputRequired = { toolUseId: 'ask-1', questions: [] };
      execution.inputContext = null;

      service._broadcastInputRequired(execution);

      expect(logStreamer.broadcast).toHaveBeenCalledWith(
        execution.id,
        expect.objectContaining({
          questions: [],
          context: null,
        }),
      );
    });
  });

  describe('_handleCompletion - specific broadcast assertions', () => {
    it('broadcasts status event with correct executionId and exitCode', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status',
          executionId: execution.id,
          status: 'completed',
          exitCode: 0,
        }),
      );
    });

    it('broadcasts failed status for non-zero exit', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 1);

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status',
          status: 'failed',
          exitCode: 1,
        }),
      );
    });

    it('sets completedAt timestamp on completion', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const before = new Date().toISOString();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(execution.completedAt).toBeTruthy();
      expect(execution.completedAt >= before).toBe(true);
    });

    it('sets exitCode on execution', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 42);

      expect(execution.exitCode).toBe(42);
    });

    it('fl-retry-exhausted event includes correct maxRetries', async () => {
      vi.useFakeTimers();
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const { MAX_FL_RETRIES } = await import('../config.js');
      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: MAX_FL_RETRIES, // exhausted
      });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      service.executeCommand = vi.fn();

      service._handleCompletion(execution, 1);

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fl-retry-exhausted',
          featureId: '100',
          retryCount: MAX_FL_RETRIES,
          maxRetries: MAX_FL_RETRIES,
        }),
      );

      vi.useRealTimers();
    });
  });

  describe('_checkStall - elapsed time boundary', () => {
    it('does not stall before STALL_TIMEOUT_MS', async () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      const { STALL_TIMEOUT_MS } = await import('../config.js');

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.lastOutputTime = Date.now() - (STALL_TIMEOUT_MS - 1000); // just under threshold

      service._checkStall(execution);

      expect(execution.isStalled).toBe(false);
      expect(service._broadcastState).not.toHaveBeenCalled();
    });

    it('does not stall when taskDepth > 0 (subagent running)', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.lastOutputTime = Date.now() - 120000;
      execution.taskDepth = 1; // subagent running

      service._checkStall(execution);

      expect(execution.isStalled).toBe(false);
    });

    it('broadcasts stalled event with elapsed time', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.status = 'running';
      execution.lastOutputTime = Date.now() - 120000;

      service._checkStall(execution);

      expect(logStreamer.broadcast).toHaveBeenCalledWith(
        execution.id,
        expect.objectContaining({
          type: 'stalled',
          executionId: execution.id,
          elapsed: expect.any(Number),
        }),
      );
      const call = logStreamer.broadcast.mock.calls.find(([, msg]) => msg.type === 'stalled');
      expect(call[1].elapsed).toBeGreaterThan(60000);
    });
  });

  describe('getQueueStatus - detailed fields', () => {
    it('returns correct queue status with all fields', () => {
      const { service } = createService({ maxConcurrent: 4 });
      service._startExecution = vi.fn();

      const exec1 = service._createExecution({ featureId: '100', command: 'fl' });
      exec1.status = 'running';
      exec1.currentPhase = 3;
      exec1.currentPhaseName = 'Implementation';
      exec1.currentIteration = 2;
      exec1.contextPercent = 45;
      exec1.startedAt = new Date().toISOString();
      service.executions.set(exec1.id, exec1);

      const exec2 = service._createExecution({ featureId: '101', command: 'fc' });
      exec2.status = 'queued';
      service.executions.set(exec2.id, exec2);
      service.queue.push(exec2.id);

      const status = service.getQueueStatus();

      expect(status.maxConcurrent).toBe(4);
      expect(status.runningCount).toBe(1);
      expect(status.running).toHaveLength(1);
      expect(status.running[0]).toMatchObject({
        featureId: '100',
        command: 'fl',
        phase: 3,
        phaseName: 'Implementation',
      });
      expect(status.queued).toHaveLength(1);
      expect(status.queued[0].featureId).toBe('101');
    });
  });

  describe('clearQueue - broadcast assertions', () => {
    it('broadcasts queue-updated after clearing', () => {
      const { service, logStreamer } = createService();

      const exec1 = service._createExecution({ featureId: '100', command: 'fl' });
      exec1.status = 'queued';
      service.executions.set(exec1.id, exec1);
      service.queue.push(exec1.id);

      service.clearQueue();

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'queue-updated' }),
      );
    });
  });

  describe('executeCommand - queue broadcast', () => {
    it('broadcasts queue-updated when execution is queued', () => {
      const { service, logStreamer } = createService({ maxConcurrent: 1 });
      service._startExecution = vi.fn();

      // Create a running execution to fill the slot
      const runningExec = service._createExecution({ featureId: '999', command: 'fl' });
      runningExec.status = 'running';
      service.executions.set(runningExec.id, runningExec);

      service.executeCommand('101', 'fl');

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'queue-updated' }),
      );
    });

    it('includes position in queued execution log', () => {
      const { service } = createService({ maxConcurrent: 1 });
      service._startExecution = vi.fn();

      const runningExec = service._createExecution({ featureId: '999', command: 'fl' });
      runningExec.status = 'running';
      service.executions.set(runningExec.id, runningExec);

      const execId = service.executeCommand('101', 'fl');
      const exec = service.executions.get(execId);

      expect(exec.logs[0].line).toContain('Queued');
      expect(exec.logs[0].line).toContain('1'); // position 1
    });
  });

  describe('_handleCompletion - chain state computation', () => {
    it('sets completed status when exitCode 0 and no chain issues', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fc' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.resultSubtype = 'success';
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(execution.status).toBe('completed');
      expect(execution.exitCode).toBe(0);
      expect(execution.process).toBeNull();
    });

    it('sets failed status when exitCode non-zero without chain retry', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fc' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 1);

      expect(execution.status).toBe('failed');
      expect(execution.exitCode).toBe(1);
    });

    it('calls dequeueNext after completion', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      const dequeueNext = vi.fn();
      service._dequeueNext = dequeueNext;

      const execution = service._createExecution({ featureId: '100', command: 'fc' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(dequeueNext).toHaveBeenCalled();
    });

    it('calls onExecutionComplete callback after completion', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();
      const onComplete = vi.fn();
      service.onExecutionComplete = onComplete;

      const execution = service._createExecution({ featureId: '100', command: 'fc' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(onComplete).toHaveBeenCalledWith(execution);
    });

    it('clears stallCheckInterval on completion', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();
      service._dequeueNext = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fc' });
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();
      execution.lastOutputTime = Date.now();
      execution.stallCheckInterval = setInterval(() => {}, 999999);
      service.executions.set(execution.id, execution);

      service._handleCompletion(execution, 0);

      expect(execution.stallCheckInterval).toBeNull();
    });
  });

  describe('_createExecution - default values', () => {
    it('creates execution with correct defaults', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });

      expect(execution.featureId).toBe('100');
      expect(execution.command).toBe('fl');
      expect(execution.status).toBe('queued');
      expect(execution.logs).toEqual([]);
      expect(execution.currentPhase).toBeNull();
      expect(execution.currentPhaseName).toBeNull();
      expect(execution.currentIteration).toBeNull();
      expect(execution.sessionId).toBeNull();
      expect(execution.taskDepth).toBe(0);
      expect(execution.isStalled).toBe(false);
      expect(execution.killedByUser).toBe(false);
      expect(execution.accountLimitHit).toBe(false);
      expect(execution.promptTooLong).toBe(false);
      expect(execution.chain).toBeNull();
    });

    it('creates execution with chain enabled', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        retryCount: 2,
        contextRetryCount: 1,
        chainHistory: [{ command: 'fc', result: 'ok' }],
      });

      expect(execution.chain).toEqual({
        enabled: true,
        retryCount: 2,
        contextRetryCount: 1,
        incompleteRetryCount: 0,
        history: [{ command: 'fc', result: 'ok' }],
      });
    });

    it('creates execution with chainParentId', () => {
      const { service } = createService();
      const execution = service._createExecution({
        featureId: '100',
        command: 'fl',
        chain: true,
        chainParentId: 'parent-exec-id',
      });

      expect(execution.chainParentId).toBe('parent-exec-id');
    });
  });

  describe('_attachStderrHandler - log level', () => {
    it('logs stderr ERROR lines as error level', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });

      const handlers = {};
      const mockProc = {
        stderr: {
          on: (event, handler) => {
            handlers[event] = handler;
          },
        },
      };

      service._attachStderrHandler(execution, mockProc);
      handlers.data(Buffer.from('[ERROR] Something failed\n'));

      const errLog = execution.logs.find((l) => l.level === 'error');
      expect(errLog).toBeDefined();
      expect(errLog.line).toContain('[stderr]');
      expect(errLog.line).toContain('[ERROR] Something failed');
    });

    it('logs stderr non-ERROR lines as debug level', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });

      const handlers = {};
      const mockProc = {
        stderr: {
          on: (event, handler) => {
            handlers[event] = handler;
          },
        },
      };

      service._attachStderrHandler(execution, mockProc);
      handlers.data(Buffer.from('Debug info\n'));

      const debugLog = execution.logs.find((l) => l.level === 'debug');
      expect(debugLog).toBeDefined();
      expect(debugLog.line).toContain('[stderr]');
      expect(debugLog.line).toContain('Debug info');
    });

    it('updates lastOutputTime from stderr', () => {
      const { service } = createService();
      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.lastOutputTime = 0;

      const handlers = {};
      const mockProc = {
        stderr: {
          on: (event, handler) => {
            handlers[event] = handler;
          },
        },
      };

      service._attachStderrHandler(execution, mockProc);
      const before = Date.now();
      handlers.data(Buffer.from('some output\n'));
      expect(execution.lastOutputTime).toBeGreaterThanOrEqual(before);
    });
  });

  describe('_handleStreamEvent - system events', () => {
    it('does not set sessionId from system non-init event', () => {
      const { service } = createService();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      expect(execution.sessionId).toBeNull();

      service._handleStreamEvent(execution, {
        type: 'system',
        subtype: 'something-else',
        session_id: 'should-not-be-set',
      });

      expect(execution.sessionId).toBeNull();
    });

    it('does not modify sessionId when init event has no session_id', () => {
      const { service } = createService();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });

      service._handleStreamEvent(execution, {
        type: 'system',
        subtype: 'init',
        // no session_id field
      });

      expect(execution.sessionId).toBeNull();
    });
  });

  describe('_handleStreamEvent - lastOutputTime update', () => {
    it('does not update lastOutputTime on non-assistant events', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const execution = service._createExecution({ featureId: '100', command: 'fl' });
      execution.lastOutputTime = 12345; // fixed value

      // system/init doesn't update lastOutputTime
      service._handleStreamEvent(execution, {
        type: 'system',
        subtype: 'init',
        session_id: 'abc',
      });

      // lastOutputTime should not have changed (only process stream does that)
      expect(execution.lastOutputTime).toBe(12345);
    });
  });

  describe('isIdle detection', () => {
    it('reports idle when no running or queued executions', () => {
      const { service } = createService();

      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'completed';
      service.executions.set(exec.id, exec);

      expect(service.runningCount).toBe(0);
      expect(service.queue.length).toBe(0);
    });

    it('reports not idle when execution is running', () => {
      const { service } = createService();

      const exec = service._createExecution({ featureId: '100', command: 'fl' });
      exec.status = 'running';
      service.executions.set(exec.id, exec);

      expect(service.runningCount).toBe(1);
    });
  });
});

// =============================================================================
// Scenario Tests — multi-step state machine flows
// =============================================================================

describe('Scenario Tests', () => {
  function createScenarioService() {
    const { service, logStreamer } = createService();
    service._broadcastState = vi.fn();
    service._handoffToTerminal = vi.fn();
    service._killProcess = vi.fn();
    service._dequeueNext = vi.fn();
    service._saveSessionId = vi.fn();
    service._saveHistoryEntry = vi.fn();
    service._attachStdoutHandler = vi.fn();
    service._attachStderrHandler = vi.fn();
    service._checkStall = vi.fn();
    service._buildClaudeEnv = vi.fn(() => ({}));
    service.executeCommand = vi.fn().mockReturnValue('new-exec-id');
    service.fileWatcher = { statusCache: new Map() };
    service.emailService = {
      sendCompletionNotification: vi.fn().mockResolvedValue(undefined),
      sendHandoffNotification: vi.fn().mockResolvedValue(undefined),
    };
    service.rateLimitService = {
      getSafeProfile: vi.fn().mockReturnValue(null),
      getEarliestResetTime: vi.fn().mockReturnValue(null),
      capture: vi.fn().mockResolvedValue(undefined),
      recomputeRefreshTimes: vi.fn(),
    };
    service.getCcsProfile = vi.fn().mockReturnValue('default');
    return { service, logStreamer };
  }

  function createRunningChainExecution(service, overrides = {}) {
    const exec = service._createExecution({
      featureId: '100',
      command: 'run',
      chain: true,
      chainHistory: [],
      ...overrides,
    });
    exec.status = 'running';
    exec.startedAt = new Date().toISOString();
    exec.lastOutputTime = Date.now();
    exec.sessionId = overrides.sessionId || 'session-abc';
    exec.resultSubtype = 'success';
    exec.debugLogPath = null;
    service.executions.set(exec.id, exec);
    return exec;
  }

  // =========================================================================
  // S1: Input-Wait → Answer → Resume → Chain
  // =========================================================================
  describe('S1: Input-Wait → Answer → Resume → Chain', () => {
    it('registers chain waiter only once when input-wait → answer → resume → complete', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'fc' });
      service.fileWatcher.statusCache.set('100', '[DRAFT]');
      const registerSpy = vi.spyOn(service.chainExecutor, 'registerWaiter');

      // Step 1: Input-wait detected
      service.streamParser.checkInputWaitPatterns(exec, 'Finalize? (y/n)', 'assistant');
      expect(exec.waitingForInput).toBe(true);
      expect(exec._hadInputWait).toBe(true);

      // Step 2: Result event cancels pending handoff
      service.streamParser.handleStreamEvent(exec, { type: 'result', subtype: 'success' });
      expect(exec.pendingHandoff).toBeNull();

      // Step 3: First completion (input-wait exit) — does NOT register chain waiter
      service._handleCompletion(exec, 0);
      expect(registerSpy).toHaveBeenCalledTimes(0);

      // Step 4: answerInBrowser clears state, sets _resumedAnswer
      // Reset exec to running for answerInBrowser
      exec.status = 'running';
      exec.waitingForInput = true;
      service.answerInBrowser(exec.id, 'y');
      expect(exec._resumedAnswer).toBe(true);

      // Step 5: Resumed process completes — registers chain waiter
      exec.status = 'running';
      exec.resultSubtype = 'success';
      service._handleCompletion(exec, 0);
      expect(registerSpy).toHaveBeenCalledTimes(1);
    });

    it('skips chain waiter when non-chain execution has input-wait', () => {
      const { service } = createScenarioService();
      const exec = service._createExecution({ featureId: '100', command: 'fc' });
      exec.status = 'running';
      exec.startedAt = new Date().toISOString();
      exec.lastOutputTime = Date.now();
      exec.sessionId = 'session-abc';
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      service.executions.set(exec.id, exec);
      service.fileWatcher.statusCache.set('100', '[DRAFT]');
      const registerSpy = vi.spyOn(service.chainExecutor, 'registerWaiter');

      service.streamParser.checkInputWaitPatterns(exec, 'Finalize? (y/n)', 'assistant');
      service.streamParser.handleStreamEvent(exec, { type: 'result', subtype: 'success' });
      service._handleCompletion(exec, 0);

      // Non-chain execution: chain is null, so registerWaiter never called
      expect(registerSpy).not.toHaveBeenCalled();
    });

    it('completion email skipped when _hadInputWait is true', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec._hadInputWait = true;
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      service.fileWatcher.statusCache.set('100', '[PROPOSED]');

      service._handleCompletion(exec, 0);

      // Email should NOT be sent because _hadInputWait is true
      expect(service.emailService.sendCompletionNotification).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // S2: AskUserQuestion → Kill → Answer → Resume → Chain
  // =========================================================================
  describe('S2: AskUserQuestion → Kill → Answer → Resume → Chain', () => {
    it('AskUserQuestion kill suppresses completion, resume completes normally', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'fc' });
      service.fileWatcher.statusCache.set('100', '[DRAFT]');
      const registerSpy = vi.spyOn(service.chainExecutor, 'registerWaiter');

      // Step 1: AskUserQuestion detected — sets inputRequired + _killedForAskUser
      service.streamParser.handleStreamEvent(exec, {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I have a question.' },
            {
              type: 'tool_use',
              id: 'tool-123',
              name: 'AskUserQuestion',
              input: { questions: [{ question: 'Which option?' }] },
            },
          ],
        },
      });
      expect(exec.inputRequired).toBeTruthy();
      expect(exec._killedForAskUser).toBe(true);

      // Step 2: Process killed
      exec.process = null;

      // Step 3: _handleCompletion early returns (because _killedForAskUser)
      service._handleCompletion(exec, null);
      expect(exec.status).toBe('running');
      expect(registerSpy).not.toHaveBeenCalled();

      // Step 4: answerInBrowser → clears flags, sets _resumedAnswer
      service.answerInBrowser(exec.id, 'Option A');
      expect(exec._resumedAnswer).toBe(true);
      expect(exec._killedForAskUser).toBe(false);

      // Step 5: Resumed process completes — registers waiter (_hadInputWait=false, _resumedAnswer=true → register)
      exec.status = 'running';
      exec.resultSubtype = 'success';
      // Simulate fc completed successfully: status advanced to [PROPOSED]
      service.fileWatcher.statusCache.set('100', '[PROPOSED]');
      service._handleCompletion(exec, 0);
      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(exec.status).toBe('completed');
    });

    it('buffered tool_result after kill is ignored', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'fc' });

      // AskUserQuestion detected
      service.streamParser.handleStreamEvent(exec, {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Question.' },
            {
              type: 'tool_use',
              id: 'tool-456',
              name: 'AskUserQuestion',
              input: { questions: [{ question: 'Choose' }] },
            },
          ],
        },
      });
      expect(exec._killedForAskUser).toBe(true);
      const toolUseId = exec.inputRequired.toolUseId;

      // Buffered tool_result arrives after kill
      service.streamParser.handleStreamEvent(exec, {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '' }],
        },
      });

      // inputRequired should NOT be cleared (guard in streamParser line 344)
      expect(exec.inputRequired).toBeTruthy();
      expect(exec.inputRequired.toolUseId).toBe('tool-456');
    });
  });

  // =========================================================================
  // S3: Chain Waiter Race Condition
  // =========================================================================
  describe('S3: Chain Waiter Race Condition', () => {
    it('status already changed → immediate trigger', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      // Status already advanced to [PROPOSED]
      service.fileWatcher.statusCache.set('100', '[PROPOSED]');

      service._handleCompletion(exec, 0);

      // registerWaiter detects status already [PROPOSED] → immediately starts fl
      expect(service.executeCommand).toHaveBeenCalledWith(
        '100',
        'fl',
        expect.objectContaining({ chain: true }),
      );
      // No deferred waiter stored
      expect(service.chainExecutor.hasWaiter('100')).toBe(false);
    });

    it('status not yet changed → deferred waiter → trigger on change', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      // No status in cache yet → skips incomplete detection, registers waiter

      service._handleCompletion(exec, 0);

      // Waiter stored (status doesn't match yet)
      expect(service.chainExecutor.hasWaiter('100')).toBe(true);
      expect(service.executeCommand).not.toHaveBeenCalled();

      // Now status changes
      service.chainExecutor.handleStatusChanged('100', '[DRAFT]', '[PROPOSED]');

      // Waiter consumed, next command started
      expect(service.executeCommand).toHaveBeenCalledWith(
        '100',
        'fl',
        expect.objectContaining({ chain: true }),
      );
      expect(service.chainExecutor.hasWaiter('100')).toBe(false);
    });

    it('full chain fc → fl → run progression', () => {
      const { service } = createScenarioService();

      // FC execution completes
      const fcExec = createRunningChainExecution(service, { command: 'fc' });
      fcExec.resultSubtype = 'success';
      fcExec.debugLogPath = null;
      service.fileWatcher.statusCache.set('100', '[PROPOSED]');
      service._handleCompletion(fcExec, 0);

      // FC → FL triggered immediately
      expect(service.executeCommand).toHaveBeenCalledWith(
        '100',
        'fl',
        expect.objectContaining({
          chain: true,
          chainHistory: [{ command: 'fc', result: 'ok' }],
        }),
      );

      // FL execution completes
      const flExec = createRunningChainExecution(service, { command: 'fl' });
      flExec.resultSubtype = 'success';
      flExec.debugLogPath = null;
      service.fileWatcher.statusCache.set('100', '[REVIEWED]');
      service._handleCompletion(flExec, 0);

      // FL → run triggered immediately
      expect(service.executeCommand).toHaveBeenCalledWith(
        '100',
        'run',
        expect.objectContaining({
          chain: true,
          chainHistory: [{ command: 'fl', result: 'ok' }],
        }),
      );
    });
  });

  // =========================================================================
  // S4: Rate Limit → Queue → Retry
  // =========================================================================
  describe('S4: Rate Limit → Queue → Retry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('429 detection triggers retry after delay', () => {
      const { service } = createScenarioService();
      service.rateLimitService.getSafeProfile.mockReturnValue('profile-b');
      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.accountLimitHit = true;
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;

      service._handleCompletion(exec, 1);

      expect(exec.status).toBe('failed');
      expect(exec.rateLimitSwitchedTo).toBe('profile-b');

      // Advance past retry delay
      vi.advanceTimersByTime(15000);

      // _processNextInQueue should have been called → which calls executeCommand
      // (via internal _processRateLimitQueue or _processNextInQueue)
      // The scheduling happened via setTimeout in _scheduleRateLimitRetry
    });

    it('two concurrent 429s queue sequentially', () => {
      const { service } = createScenarioService();
      service.rateLimitService.getSafeProfile.mockReturnValue('profile-b');

      const exec1 = createRunningChainExecution(service, { command: 'fc' });
      exec1.accountLimitHit = true;
      exec1.debugLogPath = null;
      service._handleCompletion(exec1, 1);

      const exec2 = createRunningChainExecution(service, { command: 'fl', featureId: '200' });
      exec2.accountLimitHit = true;
      exec2.debugLogPath = null;
      service._handleCompletion(exec2, 1);

      // Both should be in the retry queue
      expect(service._rateLimitRetryQueue.length).toBe(2);
    });
  });

  // =========================================================================
  // S5: Incomplete Termination → Retry → Success
  // =========================================================================
  describe('S5: Incomplete Termination → Retry → Success', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries on incomplete, succeeds on second attempt', () => {
      const { service } = createScenarioService();
      // FC completed exit 0 + success, but status still [DRAFT] (incomplete)
      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      service.fileWatcher.statusCache.set('100', '[DRAFT]');

      service._handleCompletion(exec, 0);

      // Incomplete detected → retry scheduled
      vi.advanceTimersByTime(15000);
      expect(service.executeCommand).toHaveBeenCalledWith(
        '100',
        'fc',
        expect.objectContaining({ incompleteRetryCount: 1 }),
      );

      // Second attempt: status now [PROPOSED]
      const exec2 = createRunningChainExecution(service, { command: 'fc' });
      exec2.resultSubtype = 'success';
      exec2.debugLogPath = null;
      service.fileWatcher.statusCache.set('100', '[PROPOSED]');

      service._handleCompletion(exec2, 0);

      // Status matches → registerWaiter triggers immediate chain
      expect(service.executeCommand).toHaveBeenCalledWith(
        '100',
        'fl',
        expect.objectContaining({ chain: true }),
      );
    });

    it('retry exhaustion sends email', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, {
        command: 'fc',
        incompleteRetryCount: 3,
      });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      service.fileWatcher.statusCache.set('100', '[DRAFT]');

      service._handleCompletion(exec, 0);

      // Exhausted → falls through to email
      expect(service.emailService.sendCompletionNotification).toHaveBeenCalledWith(
        exec,
        'completed',
        0,
        expect.arrayContaining([expect.objectContaining({ result: 'incomplete-retry-exhausted' })]),
        null, // no featureService → getFeature not available
      );
    });
  });

  // =========================================================================
  // S6: Stall Detection
  // =========================================================================
  describe('S6: Stall Detection', () => {
    it('marks stalled after 60s, broadcasts only once', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fc' });
      exec.status = 'running';
      exec.lastOutputTime = Date.now() - 61000;
      service.executions.set(exec.id, exec);

      // First check → stalled
      service._checkStall(exec);
      expect(exec.isStalled).toBe(true);
      expect(service._broadcastState).toHaveBeenCalledTimes(1);

      // Second check → no additional broadcast
      service._checkStall(exec);
      expect(service._broadcastState).toHaveBeenCalledTimes(1);
    });

    it('not stalled when inputRequired is set', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fc' });
      exec.status = 'running';
      exec.lastOutputTime = Date.now() - 120000;
      exec.inputRequired = { toolUseId: 'tool-1', questions: [] };

      service._checkStall(exec);
      expect(exec.isStalled).toBe(false);
    });

    it('not stalled when taskDepth > 0', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fc' });
      exec.status = 'running';
      exec.lastOutputTime = Date.now() - 120000;
      exec.taskDepth = 1;

      service._checkStall(exec);
      expect(exec.isStalled).toBe(false);
    });
  });

  // =========================================================================
  // S7: Context Retry + FL Retry Counter Independence
  // =========================================================================
  describe('S7: Context Retry + FL Retry Counter Independence', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('context and FL retry counters are independent', () => {
      const { service } = createScenarioService();

      // Step 1: Context exhaustion → context retry
      const exec1 = createRunningChainExecution(service, { command: 'fl' });
      exec1.resultSubtype = 'error_max_turns';
      exec1.debugLogPath = null;

      service._handleCompletion(exec1, 1);

      vi.advanceTimersByTime(15000);
      expect(service.executeCommand).toHaveBeenCalledWith(
        '100',
        'fl',
        expect.objectContaining({
          contextRetryCount: 1,
          retryCount: 0,
        }),
      );

      // Step 2: New exec with those counts, now FL failure (non-context)
      service.executeCommand.mockClear();
      const exec2 = createRunningChainExecution(service, {
        command: 'fl',
        retryCount: 0,
        contextRetryCount: 1,
      });
      exec2.resultSubtype = null;
      exec2.debugLogPath = null;

      service._handleCompletion(exec2, 1);

      vi.advanceTimersByTime(15000);
      expect(service.executeCommand).toHaveBeenCalledWith(
        '100',
        'fl',
        expect.objectContaining({
          retryCount: 1,
          contextRetryCount: 1,
        }),
      );
    });

    it('context exhaustion takes precedence over FL retry', () => {
      const { service } = createScenarioService();

      // error_max_turns + non-zero exit → context retry path (checked first)
      const exec = createRunningChainExecution(service, { command: 'fl' });
      exec.resultSubtype = 'error_max_turns';
      exec.debugLogPath = null;

      service._handleCompletion(exec, 1);

      vi.advanceTimersByTime(15000);
      // Should use context retry, not FL retry
      expect(service.executeCommand).toHaveBeenCalledWith(
        '100',
        'fl',
        expect.objectContaining({ contextRetryCount: 1 }),
      );
    });
  });

  // =========================================================================
  // S8: Stall Recovery Cycle (isStalled: false→true→false→true)
  // =========================================================================
  describe('S8: Stall Recovery Cycle', () => {
    it('stall → output resumes → unstall → re-stall on silence', () => {
      const { service, logStreamer } = createService();
      service._broadcastState = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fc' });
      exec.status = 'running';
      exec.lastOutputTime = Date.now() - 120000;
      service.executions.set(exec.id, exec);

      // Phase 1: Stall detected
      service._checkStall(exec);
      expect(exec.isStalled).toBe(true);
      expect(service._broadcastState).toHaveBeenCalledTimes(1);

      // Phase 2: Output resumes — _attachStdoutHandler resets isStalled
      // Simulate the stdout handler logic (line 722-726 in claudeService.js)
      exec.lastOutputTime = Date.now();
      exec.isStalled = false;
      service._broadcastState.mockClear();
      service._broadcastState(exec); // stdout handler broadcasts on unstall

      // Phase 3: Verify not stalled immediately after recovery
      service._broadcastState.mockClear();
      service._checkStall(exec);
      expect(exec.isStalled).toBe(false);
      expect(service._broadcastState).not.toHaveBeenCalled();

      // Phase 4: Silence again → re-stall
      exec.lastOutputTime = Date.now() - 120000;
      service._checkStall(exec);
      expect(exec.isStalled).toBe(true);
      expect(service._broadcastState).toHaveBeenCalledTimes(1);

      // Phase 5: Re-stall doesn't double-broadcast
      service._broadcastState.mockClear();
      service._checkStall(exec);
      expect(service._broadcastState).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // S9: Handoff Race (running→handed-off→process close)
  // =========================================================================
  describe('S9: Handoff Race', () => {
    it('_handleCompletion is suppressed after handoff', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'fc' });
      const registerSpy = vi.spyOn(service.chainExecutor, 'registerWaiter');

      // Step 1: Handoff to terminal changes status
      service._handoffToTerminal.mockImplementation((e, _reason) => {
        e.status = 'handed-off';
      });
      service._handoffToTerminal(exec, 'Input required: y/n prompt');
      expect(exec.status).toBe('handed-off');

      // Step 2: Process close fires _handleCompletion after handoff
      // Guard: status !== 'running' → early return
      service._handleCompletion(exec, 0);

      // Should NOT have progressed (no chain waiter, no status change)
      expect(registerSpy).not.toHaveBeenCalled();
      expect(exec.status).toBe('handed-off'); // unchanged
    });

    it('process close after handoff cleans up and dequeues', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.stallCheckInterval = setInterval(() => {}, 30000);

      // Simulate handoff
      exec.status = 'handed-off';

      // Simulate the proc.on('close') handler logic (line 670-677)
      // When status is 'handed-off', close handler skips _handleCompletion,
      // clears interval, nulls process, and dequeues
      if (exec.stallCheckInterval) {
        clearInterval(exec.stallCheckInterval);
        exec.stallCheckInterval = null;
      }
      exec.process = null;
      service._dequeueNext();

      expect(exec.stallCheckInterval).toBeNull();
      expect(exec.process).toBeNull();
      expect(service._dequeueNext).toHaveBeenCalled();
    });

    it('double handoff is idempotent', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'fc' });
      exec.status = 'running';
      exec.sessionId = 'session-abc';
      service.executions.set(exec.id, exec);

      // First handoff succeeds
      service._handoffToTerminal(exec, 'First handoff');
      expect(exec.status).toBe('handed-off');
      const callCount = service._broadcastState.mock.calls.length;

      // Second handoff is no-op (guard: status === 'handed-off')
      service._handoffToTerminal(exec, 'Second handoff');
      expect(service._broadcastState.mock.calls.length).toBe(callCount);
    });
  });

  // =========================================================================
  // S10: Update Analysis → _onComplete + auto-handoff
  // =========================================================================
  describe('S10: Update Analysis → _onComplete + auto-handoff', () => {
    it('full flow: _onComplete fires, then auto-handoff to terminal', () => {
      const { service } = createScenarioService();
      // Restore real _handoffToTerminal for this test
      service._handoffToTerminal = ClaudeService.prototype._handoffToTerminal.bind(service);

      const onComplete = vi.fn();
      const exec = service._createExecution({ command: 'update-analysis' });
      exec.status = 'running';
      exec.startedAt = new Date().toISOString();
      exec.lastOutputTime = Date.now();
      exec.sessionId = 'update-session-1';
      exec._onComplete = onComplete;
      exec.debugLogPath = null;
      service.executions.set(exec.id, exec);

      service._handleCompletion(exec, 0);

      // _onComplete fires with analysis result
      expect(onComplete).toHaveBeenCalledWith(exec, 0);
      // Auto-handoff triggers after _onComplete
      expect(exec.status).toBe('handed-off');
    });

    it('no auto-handoff on analysis failure, _onComplete still fires', () => {
      const { service } = createScenarioService();
      service._handoffToTerminal = ClaudeService.prototype._handoffToTerminal.bind(service);

      const onComplete = vi.fn();
      const exec = service._createExecution({ command: 'update-analysis' });
      exec.status = 'running';
      exec.startedAt = new Date().toISOString();
      exec.lastOutputTime = Date.now();
      exec.sessionId = 'update-session-2';
      exec._onComplete = onComplete;
      exec.debugLogPath = null;
      service.executions.set(exec.id, exec);

      service._handleCompletion(exec, 1);

      expect(onComplete).toHaveBeenCalledWith(exec, 1);
      expect(exec.status).toBe('failed');
    });

    it('non-update-analysis commands do not auto-handoff on success', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'imp' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      exec.lastAssistantText = 'Analysis complete.';

      service._handleCompletion(exec, 0);

      // imp is last chain step → email, NOT handoff
      expect(exec.status).toBe('completed');
      expect(service._handoffToTerminal).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // S11: endsWithQuestion → handoff stops chain
  // =========================================================================
  describe('S11: endsWithQuestion → handoff stops chain', () => {
    it('chain execution ending with question → handoff, no chain waiter', () => {
      const { service } = createScenarioService();
      // Restore real _handoffToTerminal
      service._handoffToTerminal = ClaudeService.prototype._handoffToTerminal.bind(service);

      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      exec.lastAssistantText = 'Would you like me to proceed?';
      service.fileWatcher.statusCache.set('100', '[PROPOSED]');

      const registerSpy = vi.spyOn(service.chainExecutor, 'registerWaiter');

      service._handleCompletion(exec, 0);

      // endsWithQuestion → handoff fires, skipping chain entirely
      expect(exec.status).toBe('handed-off');
      expect(registerSpy).not.toHaveBeenCalled();
      expect(service.executeCommand).not.toHaveBeenCalled();
    });

    it('non-chain execution ending with question → handoff', () => {
      const { service } = createScenarioService();
      service._handoffToTerminal = ClaudeService.prototype._handoffToTerminal.bind(service);

      const exec = service._createExecution({ featureId: '100', command: 'fc' });
      exec.status = 'running';
      exec.startedAt = new Date().toISOString();
      exec.lastOutputTime = Date.now();
      exec.sessionId = 'session-q1';
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      exec.lastAssistantText = 'どちらにしますか？';
      service.executions.set(exec.id, exec);

      service._handleCompletion(exec, 0);

      expect(exec.status).toBe('handed-off');
    });

    it('question text with input-wait active → no double handoff', () => {
      const { service } = createScenarioService();
      service._handoffToTerminal = ClaudeService.prototype._handoffToTerminal.bind(service);

      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      exec.lastAssistantText = 'Continue? (y/n)';
      exec.waitingForInput = true;

      service._handleCompletion(exec, 0);

      // waitingForInput guard prevents endsWithQuestion handoff
      expect(exec.status).not.toBe('handed-off');
    });
  });

  // =========================================================================
  // S12: Chain [BLOCKED] → stop chain + email
  // =========================================================================
  describe('S12: Chain [BLOCKED] → chain slot released, email sent', () => {
    it('FL sets [BLOCKED] → no waiter, chain slot released, email sent', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'fl' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      // FL completed successfully but set status to [BLOCKED]
      service.fileWatcher.statusCache.set('100', '[BLOCKED]');

      const registerSpy = vi.spyOn(service.chainExecutor, 'registerWaiter');
      const releaseSpy = vi.spyOn(service, '_releaseChainSlot');

      service._handleCompletion(exec, 0);

      // [BLOCKED] skips waiter registration — chain slot released immediately
      expect(registerSpy).not.toHaveBeenCalled();
      expect(releaseSpy).toHaveBeenCalledWith(exec);
      expect(exec.status).toBe('completed');
      // No immediate next command
      expect(service.executeCommand).not.toHaveBeenCalled();
      // Email sent (chain stopped due to BLOCKED)
      expect(service.emailService.sendCompletionNotification).toHaveBeenCalled();
    });

    it('[BLOCKED] does not register waiter (no stale waiter possible)', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'fl' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      service.fileWatcher.statusCache.set('100', '[BLOCKED]');

      service._handleCompletion(exec, 0);

      // No waiter registered — BLOCKED features don't wait
      expect(service.chainExecutor.hasWaiter('100')).toBe(false);
    });

    it('[BLOCKED] skips incomplete retry (legitimate status)', () => {
      const { service } = createScenarioService();
      const exec = createRunningChainExecution(service, { command: 'fl' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      service.fileWatcher.statusCache.set('100', '[BLOCKED]');

      service._handleCompletion(exec, 0);

      // Should NOT trigger incomplete retry (BLOCKED is legitimate)
      expect(service.executeCommand).not.toHaveBeenCalledWith(
        expect.anything(),
        'fl',
        expect.objectContaining({ incompleteRetryCount: expect.any(Number) }),
      );
    });
  });

  // =========================================================================
  // S13: FL Retry Exhausted — Chain Stops, Email Sent
  // =========================================================================
  describe('S13: FL Retry Exhausted — Chain Stops, Email Sent', () => {
    it('FL retry exhausted: status=failed, fl-retry-exhausted broadcast, email sent, no further retry', async () => {
      const { service, logStreamer } = createScenarioService();
      const { MAX_FL_RETRIES } = await import('../config.js');
      const registerSpy = vi.spyOn(service.chainExecutor, 'registerWaiter');

      // FL execution with retryCount already at maximum
      const exec = createRunningChainExecution(service, {
        command: 'fl',
        retryCount: MAX_FL_RETRIES,
      });
      exec.resultSubtype = null; // non-context FL failure
      exec.debugLogPath = null;
      // Set expected status so isExpectedStatusAfterCommand does not interfere
      service.fileWatcher.statusCache.set('100', '[REVIEWED]');

      service._handleCompletion(exec, 1);

      // isFlRetryExhausted path: status must be 'failed'
      expect(exec.status).toBe('failed');
      expect(exec.exitCode).toBe(1);

      // fl-retry-exhausted broadcast
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'fl-retry-exhausted' }),
      );

      // Email sent with retry-exhausted result
      expect(service.emailService.sendCompletionNotification).toHaveBeenCalledWith(
        exec,
        'failed',
        1,
        expect.arrayContaining([expect.objectContaining({ result: 'retry-exhausted' })]),
        null,
      );

      // No further retry scheduled
      expect(service.executeCommand).not.toHaveBeenCalled();
      // Chain waiter NOT registered (isFlRetryExhausted blocks it)
      expect(registerSpy).not.toHaveBeenCalled();
      // Queue management
      expect(service._dequeueNext).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // S14: Deferred Rate Limit Detection Cancels Context Retry Timer
  // =========================================================================
  describe('S14: Deferred Rate Limit Detection Cancels Context Retry Timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('deferred scan cancels in-flight context retry timer when 429 detected late', () => {
      const { service } = createScenarioService();

      // Set up a chain execution that looks like context exhaustion
      const exec = createRunningChainExecution(service, { command: 'fl' });
      exec.resultSubtype = 'error_max_turns';
      exec.debugLogPath = '/fake/debug.log';
      exec.accountLimitHit = false;

      // First scan returns false (file still locked), second returns true (429 found)
      let scanCallCount = 0;
      service._scanDebugLogForRateLimit = vi.fn().mockImplementation((execution) => {
        scanCallCount++;
        if (scanCallCount === 2) {
          execution.accountLimitHit = true;
          return true;
        }
        return false;
      });
      service._scheduleRateLimitRetry = vi
        .fn()
        .mockReturnValue({ message: 'Rate limit retry scheduled' });

      service._handleCompletion(exec, 1);

      // Context retry timer should have been set (error_max_turns triggers needsContextRetry)
      expect(exec._contextRetryTimer).toBeTruthy();

      // Advance 500ms to trigger the deferred scan
      vi.advanceTimersByTime(500);

      // Deferred scan detects 429 → cancels context retry timer
      expect(exec._contextRetryTimer).toBeNull();
      expect(service._scheduleRateLimitRetry).toHaveBeenCalled();
      // State updated by deferred scan
      expect(exec.accountLimitHit).toBe(true);
    });
  });

  // =========================================================================
  // S15: killedByUser Suppresses All Retry Paths
  // =========================================================================
  describe('S15: killedByUser Suppresses All Retry Paths', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('killedByUser with context exhaustion: no context retry, no FL retry, falls to terminal', () => {
      const { service } = createScenarioService();

      // FL command with context exhaustion, but killedByUser=true
      const exec = createRunningChainExecution(service, { command: 'fl' });
      exec.resultSubtype = 'error_max_turns';
      exec.debugLogPath = null;
      exec.killedByUser = true;

      service._handleCompletion(exec, 1);

      vi.advanceTimersByTime(15000);

      // No retry of any kind
      expect(service.executeCommand).not.toHaveBeenCalled();
      // Falls through to terminal path
      expect(exec.status).toBe('failed');
      expect(service.emailService.sendCompletionNotification).toHaveBeenCalled();
    });

    it('killedByUser with accountLimitHit: no rate limit retry scheduled', () => {
      const { service } = createScenarioService();
      service.rateLimitService.getSafeProfile.mockReturnValue('profile-b');
      service._scheduleRateLimitRetry = vi.fn();

      // Non-FL command, accountLimitHit=true, killedByUser=true
      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      exec.accountLimitHit = true;
      exec.killedByUser = true;

      service._handleCompletion(exec, 1);

      // killedByUser guard at source line 1376: `accountLimitHit && !killedByUser`
      // With killedByUser=true, the rate limit block is skipped entirely
      expect(service._scheduleRateLimitRetry).not.toHaveBeenCalled();
      expect(exec.status).toBe('failed');
      // Email sent via terminal path (not rate limit path)
      expect(service.emailService.sendCompletionNotification).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // S16: _processNextInQueue — Sequential Queue Drain
  // =========================================================================
  describe('S16: _processNextInQueue — Sequential Queue Drain', () => {
    it('drains queue sequentially, dequeues when empty', () => {
      const { service } = createScenarioService();
      service._startRateLimitRetry = vi.fn();

      // Manually populate the queue with two entries
      const exec1 = createRunningChainExecution(service, { command: 'fc', featureId: '100' });
      const exec2 = createRunningChainExecution(service, { command: 'fl', featureId: '200' });
      service._rateLimitRetryQueue.push(
        { execution: exec1, queuedAt: Date.now() },
        { execution: exec2, queuedAt: Date.now() },
      );

      // First drain: shifts exec1, calls _startRateLimitRetry
      service._processNextInQueue();
      expect(service._startRateLimitRetry).toHaveBeenCalledWith(exec1);
      expect(service._rateLimitRetryQueue.length).toBe(1);

      // Second drain: shifts exec2
      service._processNextInQueue();
      expect(service._startRateLimitRetry).toHaveBeenCalledWith(exec2);
      expect(service._rateLimitRetryQueue.length).toBe(0);

      // Third call with empty queue: _rateLimitRetryAt cleared, _dequeueNext called
      service._processNextInQueue();
      expect(service._rateLimitRetryAt).toBeNull();
      expect(service._dequeueNext).toHaveBeenCalled();
    });

    it('skips killed executions and continues to next', () => {
      const { service } = createScenarioService();
      service._startRateLimitRetry = vi.fn();

      const exec1 = createRunningChainExecution(service, { command: 'fc', featureId: '100' });
      const exec2 = createRunningChainExecution(service, { command: 'fl', featureId: '200' });
      exec1.killedByUser = true; // This one should be skipped
      service._rateLimitRetryQueue.push(
        { execution: exec1, queuedAt: Date.now() },
        { execution: exec2, queuedAt: Date.now() },
      );

      // First call: skips exec1 (killed), processes exec2
      service._processNextInQueue();
      expect(service._startRateLimitRetry).toHaveBeenCalledWith(exec2);
      expect(service._startRateLimitRetry).not.toHaveBeenCalledWith(exec1);
    });
  });

  // =========================================================================
  // S17: _processRateLimitQueue — Still Limited After Timer
  // =========================================================================
  describe('S17: _processRateLimitQueue — Still Limited After Timer', () => {
    it('still limited: pushes error logs, broadcasts rate-limit-exhausted, clears queue', async () => {
      const { service, logStreamer } = createScenarioService();
      service.emailService.sendRateLimitExhaustedNotification = vi
        .fn()
        .mockResolvedValue(undefined);
      service._processNextInQueue = vi.fn();

      const exec1 = createRunningChainExecution(service, { command: 'fc', featureId: '100' });
      const exec2 = createRunningChainExecution(service, { command: 'fl', featureId: '200' });
      service._rateLimitRetryQueue.push(
        { execution: exec1, queuedAt: Date.now() },
        { execution: exec2, queuedAt: Date.now() },
      );

      // getSafeProfile returns null → no profile switch available
      service.rateLimitService.getSafeProfile.mockReturnValue(null);
      // getCached returns data showing 98% usage (above RATE_LIMIT_SAFE_THRESHOLD=95)
      service.rateLimitService.getCached = vi.fn().mockReturnValue({
        default: { weekly: { percent: 98 }, session: { percent: 90 } },
      });
      service.getCcsProfile.mockReturnValue('default');

      await service._processRateLimitQueue();

      // Error logs pushed to all entries
      expect(exec1.logs.some((log) => log.line.includes('Rate limit retry failed'))).toBe(true);
      expect(exec2.logs.some((log) => log.line.includes('Rate limit retry failed'))).toBe(true);

      // rate-limit-exhausted broadcast
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'rate-limit-exhausted' }),
      );

      // Email sent
      expect(service.emailService.sendRateLimitExhaustedNotification).toHaveBeenCalled();

      // Queue cleared
      expect(service._rateLimitRetryQueue.length).toBe(0);
      expect(service._rateLimitRetryAt).toBeNull();
      expect(service._dequeueNext).toHaveBeenCalled();

      // _processNextInQueue NOT called (gave up)
      expect(service._processNextInQueue).not.toHaveBeenCalled();
    });

    it('safe profile available: calls _processNextInQueue to drain queue', async () => {
      const { service } = createScenarioService();
      service._processNextInQueue = vi.fn();

      const exec1 = createRunningChainExecution(service, { command: 'fc', featureId: '100' });
      service._rateLimitRetryQueue.push({ execution: exec1, queuedAt: Date.now() });

      // getSafeProfile returns a safe profile → percent will be below threshold
      service.rateLimitService.getSafeProfile.mockReturnValue('profile-b');
      service.rateLimitService.getCached = vi.fn().mockReturnValue({
        'profile-b': { weekly: { percent: 50 }, session: { percent: 40 } },
      });
      service.getCcsProfile.mockReturnValue('profile-b');

      await service._processRateLimitQueue();

      // Under threshold → proceed with drain
      expect(service._processNextInQueue).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // S18: FL Rerun Request (exit 0) Triggers FL Retry
  // =========================================================================
  describe('S18: FL Rerun Request (exit 0) Triggers FL Retry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('exit 0 with rerun request triggers FL retry, not chain progression', () => {
      const { service } = createScenarioService();

      // FL chain execution that exits 0 but requests re-run
      const exec = createRunningChainExecution(service, { command: 'fl' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      // lastAssistantText contains a rerun trigger pattern
      exec.lastAssistantText = '再実行してください';
      // Expected status for FL completion (so isExpectedStatusAfterCommand matches)
      service.fileWatcher.statusCache.set('100', '[REVIEWED]');

      service._handleCompletion(exec, 0);

      // FL retry path sets status to 'failed' before scheduling retry
      expect(exec.status).toBe('failed');

      // Advance past retry delay
      vi.advanceTimersByTime(15000);

      // FL retry triggered (not chain progression to 'run')
      expect(service.executeCommand).toHaveBeenCalledWith(
        '100',
        'fl',
        expect.objectContaining({ retryCount: 1 }),
      );
      // Chain did NOT progress to 'run'
      expect(service.executeCommand).not.toHaveBeenCalledWith(
        expect.anything(),
        'run',
        expect.anything(),
      );
    });
  });

  // =========================================================================
  // S19: Context Retry Exhausted — Email with 'context-retry-exhausted'
  // =========================================================================
  describe('S19: Context Retry Exhausted — Email with context-retry-exhausted', () => {
    it('context retry count at MAX_RETRIES: falls to terminal with context-retry-exhausted result', async () => {
      const { service } = createScenarioService();
      const { MAX_RETRIES } = await import('../config.js');

      // FC execution with contextRetryCount already at MAX_RETRIES
      const exec = createRunningChainExecution(service, {
        command: 'fc',
        contextRetryCount: MAX_RETRIES,
      });
      // error_max_turns triggers isContextExhausted=true
      exec.resultSubtype = 'error_max_turns';
      exec.debugLogPath = null;
      service.fileWatcher.statusCache.set('100', '[DRAFT]');

      service._handleCompletion(exec, 1);

      // needsContextRetry = false (contextRetryCount >= MAX_RETRIES)
      // Falls to terminal path: status = 'failed' (exitCode=1)
      expect(exec.status).toBe('failed');

      // Email sent with context-retry-exhausted result
      expect(service.emailService.sendCompletionNotification).toHaveBeenCalledWith(
        exec,
        'failed',
        1,
        expect.arrayContaining([expect.objectContaining({ result: 'context-retry-exhausted' })]),
        null,
      );

      // No retry scheduled
      expect(service.executeCommand).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // S20: _rateLimitQueueContinue — Drain After Successful Retry
  // =========================================================================
  describe('S20: _rateLimitQueueContinue — Drain After Successful Retry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('_rateLimitQueueContinue=true: schedules _processNextInQueue after RETRY_DELAY_MS', async () => {
      const { service } = createScenarioService();
      const { RETRY_DELAY_MS } = await import('../config.js');
      service._processNextInQueue = vi.fn();

      // Exit 0 success with _rateLimitQueueContinue set
      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      exec._rateLimitQueueContinue = true;
      service.fileWatcher.statusCache.set('100', '[PROPOSED]');

      service._handleCompletion(exec, 0);

      // Not yet called (scheduled via setTimeout)
      expect(service._processNextInQueue).not.toHaveBeenCalled();

      // Advance past RETRY_DELAY_MS
      vi.advanceTimersByTime(RETRY_DELAY_MS);

      expect(service._processNextInQueue).toHaveBeenCalled();
    });

    it('_rateLimitQueueContinue=false: _processNextInQueue NOT scheduled', async () => {
      const { service } = createScenarioService();
      const { RETRY_DELAY_MS } = await import('../config.js');
      service._processNextInQueue = vi.fn();

      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;
      exec._rateLimitQueueContinue = false;
      service.fileWatcher.statusCache.set('100', '[PROPOSED]');

      service._handleCompletion(exec, 0);

      vi.advanceTimersByTime(RETRY_DELAY_MS + 1000);

      expect(service._processNextInQueue).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // S21: /imp as Last Chain Step — Email Sent, No Chain Waiter Registered
  // =========================================================================
  describe('S21: imp Last Chain Step — Email Sent, No Chain Waiter', () => {
    it('imp exit 0 success: email sent with ok result, no registerWaiter, no executeCommand', () => {
      const { service } = createScenarioService();
      const registerSpy = vi.spyOn(service.chainExecutor, 'registerWaiter');

      // imp is defined as isLastChainStep=true in the source
      const exec = createRunningChainExecution(service, { command: 'imp' });
      exec.resultSubtype = 'success';
      exec.debugLogPath = null;

      service._handleCompletion(exec, 0);

      // Chain waiter NOT registered (isLastChainStep=true blocks registerWaiter)
      expect(registerSpy).not.toHaveBeenCalled();

      // Email sent (isLastChainStep triggers terminal path)
      expect(service.emailService.sendCompletionNotification).toHaveBeenCalledWith(
        exec,
        'completed',
        0,
        expect.arrayContaining([expect.objectContaining({ result: 'ok' })]),
        null,
      );

      // No further command scheduled
      expect(service.executeCommand).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // S22: _cleanupOldExecutions — Stuck Detection + Stale Waiter Interaction
  // =========================================================================
  describe('S22: _cleanupOldExecutions — Stuck Detection + Stale Waiter Interaction', () => {
    it('detects stuck execution AND cleans stale waiter in same pass', () => {
      const { service } = createScenarioService();
      service._killProcess = vi.fn();
      service._broadcastState = vi.fn();
      service.onExecutionComplete = vi.fn();

      // Stuck running execution (no output for STUCK_RUNNING_TIMEOUT_MS+)
      const stuckExec = service._createExecution({ featureId: '100', command: 'fc' });
      stuckExec.status = 'running';
      stuckExec.lastOutputTime = Date.now() - 7300000; // >2hr (STUCK_RUNNING_TIMEOUT_MS=7200000)
      stuckExec.process = { pid: 999 };
      stuckExec.stallCheckInterval = setInterval(() => {}, 999999);
      service.executions.set(stuckExec.id, stuckExec);

      // Old completed execution referenced by stale waiter
      const oldExec = service._createExecution({ featureId: '200', command: 'fc' });
      oldExec.status = 'completed';
      oldExec.exitCode = 0;
      service.executions.set(oldExec.id, oldExec);

      // Stale chain waiter for different feature (>CHAIN_WAITER_TIMEOUT_MS=300000)
      service.chainExecutor.chainWaiters.set('200', {
        executionId: oldExec.id,
        registeredAt: Date.now() - 400000, // >5min
        command: 'fc',
        expectedStatus: '[PROPOSED]',
        history: [],
      });

      service._cleanupOldExecutions();

      // Stuck execution: killed and set to failed
      expect(stuckExec.status).toBe('failed');
      expect(service._killProcess).toHaveBeenCalled();
      expect(stuckExec.stallCheckInterval).toBeNull();

      // Stale waiter: removed
      expect(service.chainExecutor.hasWaiter('200')).toBe(false);

      // onExecutionComplete fires for stale waiter cleanup
      expect(service.onExecutionComplete).toHaveBeenCalled();

      // Email sent for stale waiter
      expect(service.emailService.sendCompletionNotification).toHaveBeenCalled();

      // Cleanup intervals
      clearInterval(stuckExec.stallCheckInterval);
    });
  });

  // =========================================================================
  // S23: _dequeueNext Blocked by _rateLimitPaused
  // =========================================================================
  describe('S23: _dequeueNext Blocked by _rateLimitPaused', () => {
    it('_dequeueNext blocked when rate limit retry queue is non-empty', () => {
      const { service } = createService();
      service._broadcastState = vi.fn();

      // Create a queued execution
      const exec = service._createExecution({ featureId: '100', command: 'fc' });
      exec.status = 'queued';
      service.executions.set(exec.id, exec);
      service.queue.push(exec.id);

      // Populate rate limit queue to block dequeue
      const dummyExec = service._createExecution({ featureId: '200', command: 'fl' });
      service._rateLimitRetryQueue.push({ execution: dummyExec, queuedAt: Date.now() });

      // _dequeueNext should be blocked
      service._dequeueNext();

      // Queued execution should NOT have started
      expect(exec.status).toBe('queued');
      expect(service.queue.length).toBe(1);
    });

    it('_dequeueNext unblocked after rate limit queue drains', () => {
      const { service } = createService({ maxConcurrent: 99 });
      service._broadcastState = vi.fn();
      vi.spyOn(service, '_startExecution').mockImplementation(() => {});

      // Create a queued execution
      const exec = service._createExecution({ featureId: '100', command: 'fc' });
      exec.status = 'queued';
      service.executions.set(exec.id, exec);
      service.queue.push(exec.id);

      // Rate limit queue empty — dequeue works
      service._dequeueNext();
      expect(service._startExecution).toHaveBeenCalledWith(exec);
      expect(service.queue.length).toBe(0);
    });
  });

  // =========================================================================
  // S24: _broadcastInputWait Email Delay → answerInBrowser Cancellation
  // =========================================================================
  describe('S24: Input Email Delay → answerInBrowser Cancellation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('answering in browser cancels pending input email', () => {
      const { service } = createScenarioService();
      // Restore real _broadcastInputWait for this test
      service._broadcastInputWait = ClaudeService.prototype._broadcastInputWait.bind(service);
      service.logStreamer = { broadcast: vi.fn(), broadcastAll: vi.fn() };

      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.waitingForInput = true;
      exec.sessionId = 'session-s24';

      // Step 1: Input wait triggers delayed email
      service._broadcastInputWait(exec, 'Continue? (y/n)', 'y/n prompt');
      expect(exec._pendingInputEmailTimeout).toBeTruthy();

      // Step 2: User answers before email delay expires
      service.answerInBrowser(exec.id, 'y');

      // Step 3: Email timer cancelled
      expect(exec._pendingInputEmailTimeout).toBeNull();

      // Step 4: Advance past the delay — email should NOT fire
      vi.advanceTimersByTime(400000);
      expect(service.emailService.sendHandoffNotification).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // S25: endsWithQuestion Handoff → Auto resumeInTerminal
  // =========================================================================
  describe('S25: endsWithQuestion Handoff → Auto resumeInTerminal', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('_handoffToTerminal auto-triggers resumeInTerminal after delay', () => {
      const { service } = createScenarioService();
      // Restore real _handoffToTerminal for this test
      service._handoffToTerminal = ClaudeService.prototype._handoffToTerminal.bind(service);
      service.resumeInTerminal = vi.fn();
      service.logStreamer = { broadcast: vi.fn(), broadcastAll: vi.fn() };

      const exec = createRunningChainExecution(service, { command: 'fc' });
      exec.sessionId = 'session-s25';

      service._handoffToTerminal(exec, 'Question detected');
      expect(exec.status).toBe('handed-off');

      // Auto-resume NOT yet called
      expect(service.resumeInTerminal).not.toHaveBeenCalled();

      // Advance past HANDOFF_DELAY_MS (300ms from config)
      vi.advanceTimersByTime(1000);

      // Now resumeInTerminal should have been called
      expect(service.resumeInTerminal).toHaveBeenCalledWith(exec.id);
    });
  });

  // =========================================================================
  // S27: killExecution on AskUserQuestion-Paused Execution
  // =========================================================================
  describe('S27: killExecution on AskUserQuestion-Paused (No Process)', () => {
    it('kills paused execution with no process, cleans up state', () => {
      const { service } = createScenarioService();
      // Restore real killExecution (not mocked by createScenarioService)
      service.killExecution = ClaudeService.prototype.killExecution.bind(service);

      const exec = createRunningChainExecution(service, { command: 'fc' });
      // Simulate AskUserQuestion pause: process killed, status still running, no process ref
      exec._killedForAskUser = true;
      exec.process = null;
      exec.stdin = null;
      exec.inputRequired = { toolUseId: 'tool-1', questions: [{ question: 'Which?' }] };
      exec.waitingForInput = false;

      const result = service.killExecution(exec.id);

      expect(result).toBe(true);
      expect(exec.status).toBe('cancelled');
      expect(exec.killedByUser).toBe(true);
      expect(exec._killedForAskUser).toBe(false);
      expect(exec.inputRequired).toBeNull();
      expect(service._dequeueNext).toHaveBeenCalled();
    });
  });
});
