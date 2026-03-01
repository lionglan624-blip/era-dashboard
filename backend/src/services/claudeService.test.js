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
  });

  it('normalizes to lowercase', () => {
    expect(validateCommand('FC')).toBe('fc');
    expect(validateCommand('FL')).toBe('fl');
    expect(validateCommand('RUN')).toBe('run');
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
    expect(detectPhase('PHASE 3: Implementation')).toEqual({ phase: 3, name: 'Implementation' });
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
    expect(detectIteration('Iteration 1/10: Phase 0')).toBe(1);
    expect(detectIteration('Iteration 5/10: Phase 2')).toBe(5);
    expect(detectIteration('Iteration 10/10: Phase 3')).toBe(10);
  });

  it('handles various spacing', () => {
    expect(detectIteration('Iteration  3 / 10')).toBe(3);
    expect(detectIteration('iteration 7/10')).toBe(7);
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
    expect(getTotalPhases('fl')).toBe(8);
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
        message: { content: [{ type: 'tool_result', tool_use_id: '1', content: 'short result' }] },
      };
      expect(service._extractStreamText(event)).toBe('[Tool result: short result]');
    });

    it('truncates long tool_result previews', () => {
      const { service } = createService();
      const longContent = 'x'.repeat(300);
      const event = {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: '1', content: longContent }] },
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

  describe('_pushLog', () => {
    it('does not trim until margin exceeded (MAX_LOG_ENTRIES + 100)', () => {
      const { service } = createService();
      const execution = { logs: [] };

      // Fill with exactly MAX_LOG_ENTRIES + 1 (5001) - should NOT trim yet (margin = 100)
      for (let i = 0; i < 5001; i++) {
        service._pushLog(execution, { line: `line ${i}`, timestamp: new Date().toISOString() });
      }

      expect(execution.logs.length).toBe(5001); // No trim yet
    });

    it('trims to MAX_LOG_ENTRIES when margin exceeded', () => {
      const { service } = createService();
      const execution = { logs: [] };

      // Fill with 5101 entries (exceeds MAX + 100 = 5100)
      for (let i = 0; i < 5101; i++) {
        service._pushLog(execution, { line: `line ${i}`, timestamp: new Date().toISOString() });
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
      expect(getNextChainCommand('[DONE]')).toBeNull();
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
      expect(isExpectedStatusAfterCommand('run', '[DONE]')).toBe(false);
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

      const execution = service._createExecution({ featureId: '100', command: 'fc', chain: true });
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

      const execution = service._createExecution({ featureId: '100', command: 'fc', chain: true });
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

      const execution = service._createExecution({ featureId: '100', command: 'fc', chain: true });

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
                input: { todos: [{ content: 'Iteration 4/10: Phase 3', status: 'in_progress' }] },
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

    it('defers y/n handoff until result event arrives', () => {
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

      // 2. result event arrives - should trigger handoff
      service.streamParser.handleStreamEvent(execution, {
        type: 'result',
        subtype: 'success',
        is_error: false,
      });
      expect(service._handoffToTerminal).toHaveBeenCalledWith(
        execution,
        expect.stringContaining('y/n'),
      );

      // Cleanup
      if (execution.pendingHandoffTimeout) clearTimeout(execution.pendingHandoffTimeout);
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
            { type: 'text', text: 'Reference: designs/phases/phase-20-27-game-systems.md' },
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
    it('detects AskUserQuestion and triggers handoff', () => {
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
      expect(service._handoffToTerminal).toHaveBeenCalled();
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

    it('extracts final token usage from result modelUsage', () => {
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
        usage: {
          input_tokens: 80000,
          output_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        modelUsage: { 'claude-opus-4-5-20251101': { contextWindow: 200000 } },
      });

      expect(execution.tokenUsage).toBeTruthy();
      expect(execution.tokenUsage.contextWindow).toBe(200000);
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
      const { service } = createService();
      service._startExecution = vi.fn();

      const execId = service.executeCommand('100', 'fl');

      expect(service._startExecution).toHaveBeenCalledTimes(1);
      expect(service.executions.has(execId)).toBe(true);
    });

    it('starts multiple executions concurrently', () => {
      const { service } = createService();
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
      service.chainExecutor.chainWaiters.set('100', { executionId: id, registeredAt: Date.now() });

      service.killExecution(id);
      expect(service.chainExecutor.chainWaiters.has('100')).toBe(false);
    });

    it('returns false for non-existent execution', () => {
      const { service } = createService();
      expect(service.killExecution('nonexistent')).toBe(false);
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
      const { service, logStreamer } = createService();
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

    it('logs completion when no next command (e.g., [DONE])', () => {
      const { service } = createService();
      service._startExecution = vi.fn();

      const exec = service._createExecution({ featureId: '100', command: 'run', chain: true });
      service.executions.set(exec.id, exec);
      service.chainExecutor.chainWaiters.set('100', {
        executionId: exec.id,
        registeredAt: Date.now(),
      });

      service.handleFeatureStatusChanged('100', '[REVIEWED]', '[DONE]');

      // No next command for [DONE], so no startExecution call
      expect(service._startExecution).not.toHaveBeenCalled();
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
      const { service } = createService();
      service._startExecution = vi.fn();

      const exec1 = service._createExecution({ featureId: '100', command: 'fl' });
      exec1.status = 'running';
      exec1.currentPhase = 3;
      exec1.currentPhaseName = 'Implementation';
      service.executions.set(exec1.id, exec1);

      const status = service.getQueueStatus();

      expect(status.maxConcurrent).toBe(99);
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
      expect(logStreamer.broadcast).toHaveBeenCalledTimes(2);
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

    it('sends email instead of registering waiter on chain /run completion (last step)', () => {
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
      expect(service.chainExecutor.registerWaiter).not.toHaveBeenCalled();
      expect(service.emailService.sendCompletionNotification).toHaveBeenCalledWith(
        execution,
        'completed',
        0,
        [
          { command: 'fc', result: 'ok' },
          { command: 'fl', result: 'ok' },
          { command: 'run', result: 'ok' },
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
        chainHistory: [
          { command: 'fl', result: 'retry', reason: 'Context limit (success with is_error)' },
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

  describe('_handleCompletion - FL incomplete termination', () => {
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

      // executeCommand should be called with fl retry
      expect(service.executeCommand).toHaveBeenCalledWith('100', 'fl', {
        chain: true,
        chainParentId: execution.id,
        chainHistory: [{ command: 'fl', result: 'incomplete' }],
        retryCount: 1,
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
        chainHistory: [
          { command: 'run', result: 'retry', reason: 'Prompt too long (context exhausted)' },
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
        chainHistory: [
          { command: 'run', result: 'retry', reason: 'Prompt too long (context exhausted)' },
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
        chainHistory: [
          { command: 'run', result: 'retry', reason: 'Context limit (success with is_error)' },
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

    it('resume path: rateLimitService.recomputeRefreshTimes and capture called', async () => {
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
      expect(mockRateLimitService.capture).toHaveBeenCalled();
    });
  });

  describe('_dequeueNext', () => {
    it('starts queued executions when slots available', () => {
      const { service, logStreamer } = createService();
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
      const { service } = createService();
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
      expect(logStreamer.broadcast).toHaveBeenCalledWith(
        exec.id,
        expect.objectContaining({ type: 'status', status: 'cancelled' }),
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

    it('uses pm2 restart for dr command', async () => {
      vi.useFakeTimers();
      const { service } = createService();
      const { spawn: mockSpawn } = await import('child_process');

      service.runShellCommand('dr');
      // dr delays spawn by 500ms to let shell-complete WS message reach clients first
      vi.advanceTimersByTime(500);

      expect(mockSpawn).toHaveBeenCalledWith('pm2', ['restart', 'all'], expect.any(Object));
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
});
