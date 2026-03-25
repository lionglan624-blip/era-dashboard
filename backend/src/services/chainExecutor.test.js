import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ChainExecutor,
  getNextChainCommand,
  isExpectedStatusAfterCommand,
  isStatusBeyond,
} from './chainExecutor.js';

describe('Chain Execution Pure Functions', () => {
  describe('getNextChainCommand', () => {
    it('returns fl for [PROPOSED] status', () => {
      expect(getNextChainCommand('[PROPOSED]')).toBe('fl');
    });

    it('returns run for [REVIEWED] status', () => {
      expect(getNextChainCommand('[REVIEWED]')).toBe('run');
    });

    it('returns imp for [DONE] status', () => {
      expect(getNextChainCommand('[DONE]')).toBe('imp');
    });

    it('returns null for [DRAFT] status', () => {
      expect(getNextChainCommand('[DRAFT]')).toBeNull();
    });

    it('returns null for [WIP] status', () => {
      expect(getNextChainCommand('[WIP]')).toBeNull();
    });

    it('returns null for [BLOCKED] status', () => {
      expect(getNextChainCommand('[BLOCKED]')).toBeNull();
    });

    it('returns null for unknown status', () => {
      expect(getNextChainCommand('[UNKNOWN]')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(getNextChainCommand('')).toBeNull();
    });
  });

  describe('isExpectedStatusAfterCommand', () => {
    it('returns true for fc → [PROPOSED]', () => {
      expect(isExpectedStatusAfterCommand('fc', '[PROPOSED]')).toBe(true);
    });

    it('returns true for fl → [REVIEWED]', () => {
      expect(isExpectedStatusAfterCommand('fl', '[REVIEWED]')).toBe(true);
    });

    it('returns false for fc → [REVIEWED]', () => {
      expect(isExpectedStatusAfterCommand('fc', '[REVIEWED]')).toBe(false);
    });

    it('returns false for fl → [PROPOSED]', () => {
      expect(isExpectedStatusAfterCommand('fl', '[PROPOSED]')).toBe(false);
    });

    it('returns true for run → [DONE]', () => {
      expect(isExpectedStatusAfterCommand('run', '[DONE]')).toBe(true);
    });

    it('returns false for imp (no expected status)', () => {
      expect(isExpectedStatusAfterCommand('imp', '[DONE]')).toBe(false);
    });

    it('returns false for unknown command', () => {
      expect(isExpectedStatusAfterCommand('unknown', '[PROPOSED]')).toBe(false);
    });
  });

  describe('isStatusBeyond', () => {
    it('returns true when [DONE] is beyond [REVIEWED] (fl expected)', () => {
      expect(isStatusBeyond('[DONE]', '[REVIEWED]')).toBe(true);
    });

    it('returns true when [WIP] is beyond [REVIEWED] (fl expected)', () => {
      expect(isStatusBeyond('[WIP]', '[REVIEWED]')).toBe(true);
    });

    it('returns true when [DONE] is beyond [PROPOSED] (fc expected)', () => {
      expect(isStatusBeyond('[DONE]', '[PROPOSED]')).toBe(true);
    });

    it('returns true when [REVIEWED] is beyond [PROPOSED] (fc expected)', () => {
      expect(isStatusBeyond('[REVIEWED]', '[PROPOSED]')).toBe(true);
    });

    it('returns false when statuses are equal', () => {
      expect(isStatusBeyond('[REVIEWED]', '[REVIEWED]')).toBe(false);
    });

    it('returns false when current is behind expected ([DRAFT] vs [PROPOSED])', () => {
      expect(isStatusBeyond('[DRAFT]', '[PROPOSED]')).toBe(false);
    });

    it('returns false when current is behind expected ([PROPOSED] vs [REVIEWED])', () => {
      expect(isStatusBeyond('[PROPOSED]', '[REVIEWED]')).toBe(false);
    });

    it('returns false for unknown current status', () => {
      expect(isStatusBeyond('[UNKNOWN]', '[REVIEWED]')).toBe(false);
    });

    it('returns false for unknown expected status', () => {
      expect(isStatusBeyond('[DONE]', '[UNKNOWN]')).toBe(false);
    });

    it('returns false for [BLOCKED] (not in progression)', () => {
      expect(isStatusBeyond('[BLOCKED]', '[REVIEWED]')).toBe(false);
    });
  });
});

describe('ChainExecutor', () => {
  let chainExecutor;
  let mockDeps;

  beforeEach(() => {
    mockDeps = {
      getExecution: vi.fn(),
      executeCommand: vi.fn().mockReturnValue('new-exec-id'),
      pushLog: vi.fn(),
      broadcastAll: vi.fn(),
      getStatusFromCache: vi.fn(),
    };
    chainExecutor = new ChainExecutor(mockDeps);
  });

  describe('registerWaiter', () => {
    const createExecution = (overrides = {}) => ({
      id: 'exec-123',
      featureId: '100',
      command: 'fc',
      chainParentId: null,
      ...overrides,
    });

    it('registers waiter when status not yet changed', () => {
      mockDeps.getStatusFromCache.mockReturnValue('[DRAFT]');
      const execution = createExecution();

      chainExecutor.registerWaiter(execution);

      expect(chainExecutor.hasWaiter('100')).toBe(true);
      expect(mockDeps.pushLog).toHaveBeenCalledWith(
        execution,
        expect.objectContaining({
          line: expect.stringContaining('Waiting for feature status'),
        }),
      );
    });

    it('triggers immediately when status already matches expected', () => {
      mockDeps.getStatusFromCache.mockReturnValue('[PROPOSED]');
      const execution = createExecution({ command: 'fc', chain: { history: [] } });

      chainExecutor.registerWaiter(execution);

      expect(chainExecutor.hasWaiter('100')).toBe(false);
      expect(mockDeps.executeCommand).toHaveBeenCalledWith('100', 'fl', {
        chain: true,
        chainParentId: 'exec-123',
        chainHistory: [{ command: 'fc', result: 'ok' }],
      });
      expect(mockDeps.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-progress',
          featureId: '100',
          previousCommand: 'fc',
          nextCommand: 'fl',
        }),
      );
    });

    it('uses chainParentId if already set', () => {
      mockDeps.getStatusFromCache.mockReturnValue('[PROPOSED]');
      const execution = createExecution({
        command: 'fc',
        chainParentId: 'parent-exec',
        chain: { history: [] },
      });

      chainExecutor.registerWaiter(execution);

      expect(mockDeps.executeCommand).toHaveBeenCalledWith('100', 'fl', {
        chain: true,
        chainParentId: 'parent-exec',
        chainHistory: [{ command: 'fc', result: 'ok' }],
      });
    });

    it('does not trigger when status does not match expected', () => {
      mockDeps.getStatusFromCache.mockReturnValue('[REVIEWED]'); // Expected [PROPOSED] for fc
      const execution = createExecution({ command: 'fc' });

      chainExecutor.registerWaiter(execution);

      expect(chainExecutor.hasWaiter('100')).toBe(true);
      expect(mockDeps.executeCommand).not.toHaveBeenCalled();
    });

    it('handles null status from cache', () => {
      mockDeps.getStatusFromCache.mockReturnValue(null);
      const execution = createExecution();

      chainExecutor.registerWaiter(execution);

      expect(chainExecutor.hasWaiter('100')).toBe(true);
    });

    it('handles undefined getStatusFromCache', () => {
      delete mockDeps.getStatusFromCache;
      chainExecutor = new ChainExecutor(mockDeps);
      const execution = createExecution();

      expect(() => chainExecutor.registerWaiter(execution)).not.toThrow();
      expect(chainExecutor.hasWaiter('100')).toBe(true);
    });
  });

  describe('handleStatusChanged', () => {
    beforeEach(() => {
      const execution = {
        id: 'exec-123',
        featureId: '100',
        command: 'fc',
        chainParentId: null,
        chain: { history: [] },
      };
      mockDeps.getExecution.mockReturnValue(execution);
      chainExecutor.chainWaiters.set('100', {
        executionId: 'exec-123',
        registeredAt: Date.now(),
      });
    });

    it('triggers next command on status change', () => {
      chainExecutor.handleStatusChanged('100', '[DRAFT]', '[PROPOSED]');

      expect(mockDeps.executeCommand).toHaveBeenCalledWith('100', 'fl', {
        chain: true,
        chainParentId: 'exec-123',
        chainHistory: [{ command: 'fc', result: 'ok' }],
      });
      expect(chainExecutor.hasWaiter('100')).toBe(false);
    });

    it('broadcasts chain-progress event', () => {
      chainExecutor.handleStatusChanged('100', '[DRAFT]', '[PROPOSED]');

      expect(mockDeps.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-progress',
          featureId: '100',
          previousCommand: 'fc',
          nextCommand: 'fl',
          oldStatus: '[DRAFT]',
          newStatus: '[PROPOSED]',
        }),
      );
    });

    it('does nothing if no waiter exists', () => {
      chainExecutor.chainWaiters.clear();

      chainExecutor.handleStatusChanged('100', '[DRAFT]', '[PROPOSED]');

      expect(mockDeps.executeCommand).not.toHaveBeenCalled();
    });

    it('does nothing if execution not found', () => {
      mockDeps.getExecution.mockReturnValue(undefined);

      chainExecutor.handleStatusChanged('100', '[DRAFT]', '[PROPOSED]');

      expect(mockDeps.executeCommand).not.toHaveBeenCalled();
      expect(chainExecutor.hasWaiter('100')).toBe(false); // Waiter cleaned up
    });

    it('defers chain trigger when execution is still running', () => {
      const execution = {
        id: 'exec-123',
        featureId: '100',
        command: 'fc',
        chainParentId: null,
        chain: { history: [] },
        status: 'running',
      };
      mockDeps.getExecution.mockReturnValue(execution);

      chainExecutor.handleStatusChanged('100', '[DRAFT]', '[PROPOSED]');

      expect(mockDeps.executeCommand).not.toHaveBeenCalled();
      expect(chainExecutor.hasWaiter('100')).toBe(true); // Waiter preserved
    });

    it('triggers chain when execution is completed', () => {
      const execution = {
        id: 'exec-123',
        featureId: '100',
        command: 'fc',
        chainParentId: null,
        chain: { history: [] },
        status: 'completed',
      };
      mockDeps.getExecution.mockReturnValue(execution);

      chainExecutor.handleStatusChanged('100', '[DRAFT]', '[PROPOSED]');

      expect(mockDeps.executeCommand).toHaveBeenCalledWith('100', 'fl', {
        chain: true,
        chainParentId: 'exec-123',
        chainHistory: [{ command: 'fc', result: 'ok' }],
      });
      expect(chainExecutor.hasWaiter('100')).toBe(false);
    });

    it('triggers imp on [DONE] status', () => {
      chainExecutor.handleStatusChanged('100', '[REVIEWED]', '[DONE]');

      expect(mockDeps.executeCommand).toHaveBeenCalledWith('100', 'imp', expect.any(Object));
    });

    it('does not trigger if no next command (e.g., [BLOCKED])', () => {
      chainExecutor.handleStatusChanged('100', '[REVIEWED]', '[BLOCKED]');

      expect(mockDeps.executeCommand).not.toHaveBeenCalled();
    });

    it('handles run → [DONE] → imp chain', () => {
      const execution = {
        id: 'exec-789',
        featureId: '300',
        command: 'run',
        chainParentId: 'parent-123',
        chain: {
          history: [
            { command: 'fc', result: 'ok' },
            { command: 'fl', result: 'ok' },
          ],
        },
      };
      mockDeps.getExecution.mockReturnValue(execution);
      chainExecutor.chainWaiters.set('300', {
        executionId: 'exec-789',
        registeredAt: Date.now(),
      });

      chainExecutor.handleStatusChanged('300', '[WIP]', '[DONE]');

      expect(mockDeps.executeCommand).toHaveBeenCalledWith('300', 'imp', {
        chain: true,
        chainParentId: 'parent-123',
        chainHistory: [
          { command: 'fc', result: 'ok' },
          { command: 'fl', result: 'ok' },
          { command: 'run', result: 'ok' },
        ],
      });
    });

    it('handles fl → [REVIEWED] → run chain', () => {
      const execution = {
        id: 'exec-456',
        featureId: '200',
        command: 'fl',
        chainParentId: 'parent-123',
        chain: { history: [{ command: 'fc', result: 'ok' }] },
      };
      mockDeps.getExecution.mockReturnValue(execution);
      chainExecutor.chainWaiters.set('200', {
        executionId: 'exec-456',
        registeredAt: Date.now(),
      });

      chainExecutor.handleStatusChanged('200', '[PROPOSED]', '[REVIEWED]');

      expect(mockDeps.executeCommand).toHaveBeenCalledWith('200', 'run', {
        chain: true,
        chainParentId: 'parent-123',
        chainHistory: [
          { command: 'fc', result: 'ok' },
          { command: 'fl', result: 'ok' },
        ],
      });
    });
  });

  describe('waiter management', () => {
    it('hasWaiter returns true when waiter exists', () => {
      chainExecutor.chainWaiters.set('100', {
        executionId: 'exec-1',
        registeredAt: Date.now(),
      });
      expect(chainExecutor.hasWaiter('100')).toBe(true);
    });

    it('hasWaiter returns false when waiter does not exist', () => {
      expect(chainExecutor.hasWaiter('999')).toBe(false);
    });

    it('getWaiter returns waiter info', () => {
      const waiter = { executionId: 'exec-1', registeredAt: Date.now() };
      chainExecutor.chainWaiters.set('100', waiter);
      expect(chainExecutor.getWaiter('100')).toBe(waiter);
    });

    it('getWaiter returns undefined for non-existent waiter', () => {
      expect(chainExecutor.getWaiter('999')).toBeUndefined();
    });

    it('deleteWaiter removes waiter', () => {
      chainExecutor.chainWaiters.set('100', {
        executionId: 'exec-1',
        registeredAt: Date.now(),
      });
      expect(chainExecutor.deleteWaiter('100')).toBe(true);
      expect(chainExecutor.hasWaiter('100')).toBe(false);
    });

    it('deleteWaiter returns false for non-existent waiter', () => {
      expect(chainExecutor.deleteWaiter('999')).toBe(false);
    });

    it('getAllWaiters returns all waiters', () => {
      chainExecutor.chainWaiters.set('100', { executionId: 'exec-1', registeredAt: 1000 });
      chainExecutor.chainWaiters.set('200', { executionId: 'exec-2', registeredAt: 2000 });

      const allWaiters = chainExecutor.getAllWaiters();
      expect(allWaiters.size).toBe(2);
      expect(allWaiters.get('100').executionId).toBe('exec-1');
      expect(allWaiters.get('200').executionId).toBe('exec-2');
    });
  });

  describe('registerWaiter chain-cut guard', () => {
    it('returns false and skips waiter when chainCutRequested is true', () => {
      const execution = {
        id: 'exec-cut',
        featureId: '500',
        command: 'fc',
        chainParentId: null,
        chainCutRequested: true,
      };

      const result = chainExecutor.registerWaiter(execution);

      expect(result).toBe(false);
      expect(chainExecutor.hasWaiter('500')).toBe(false);
      expect(mockDeps.executeCommand).not.toHaveBeenCalled();
    });
  });

  describe('handleStatusChanged chain-cut guard', () => {
    beforeEach(() => {
      const execution = {
        id: 'exec-123',
        featureId: '100',
        command: 'fc',
        chainParentId: null,
        chain: { history: [] },
        chainCutRequested: true,
      };
      mockDeps.getExecution.mockReturnValue(execution);
      chainExecutor.chainWaiters.set('100', {
        executionId: 'exec-123',
        registeredAt: Date.now(),
      });
    });

    it('deletes waiter and does not execute next command when chainCutRequested is true', () => {
      chainExecutor.handleStatusChanged('100', '[DRAFT]', '[PROPOSED]');

      expect(chainExecutor.hasWaiter('100')).toBe(false);
      expect(mockDeps.executeCommand).not.toHaveBeenCalled();
    });
  });

  describe('_broadcastChainProgress', () => {
    it('broadcasts with timestamp', () => {
      chainExecutor._broadcastChainProgress({
        featureId: '100',
        previousCommand: 'fc',
        nextCommand: 'fl',
        oldStatus: '[DRAFT]',
        newStatus: '[PROPOSED]',
        oldExecutionId: 'old-id',
        newExecutionId: 'new-id',
      });

      expect(mockDeps.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chain-progress',
          timestamp: expect.any(String),
        }),
      );
    });

    it('handles null broadcastAll gracefully', () => {
      delete mockDeps.broadcastAll;
      chainExecutor = new ChainExecutor(mockDeps);

      expect(() => {
        chainExecutor._broadcastChainProgress({ featureId: '100' });
      }).not.toThrow();
    });
  });
});
