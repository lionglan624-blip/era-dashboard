import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ChainExecutor,
  getNextChainCommand,
  isExpectedStatusAfterCommand,
} from './chainExecutor.js';

describe('Chain Execution Pure Functions', () => {
  describe('getNextChainCommand', () => {
    it('returns fl for [PROPOSED] status', () => {
      expect(getNextChainCommand('[PROPOSED]')).toBe('fl');
    });

    it('returns run for [REVIEWED] status', () => {
      expect(getNextChainCommand('[REVIEWED]')).toBe('run');
    });

    it('returns null for [DONE] status (chain complete)', () => {
      expect(getNextChainCommand('[DONE]')).toBeNull();
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

    it('returns false for run command (no expected status)', () => {
      expect(isExpectedStatusAfterCommand('run', '[DONE]')).toBe(false);
    });

    it('returns false for unknown command', () => {
      expect(isExpectedStatusAfterCommand('unknown', '[PROPOSED]')).toBe(false);
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
        expect.objectContaining({ line: expect.stringContaining('Waiting for feature status') }),
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
      expect(chainExecutor.hasWaiter('100')).toBe(false); // Waiter still deleted
    });

    it('does not trigger if no next command (chain complete)', () => {
      chainExecutor.handleStatusChanged('100', '[REVIEWED]', '[DONE]');

      expect(mockDeps.executeCommand).not.toHaveBeenCalled();
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
      chainExecutor.chainWaiters.set('100', { executionId: 'exec-1', registeredAt: Date.now() });
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
      chainExecutor.chainWaiters.set('100', { executionId: 'exec-1', registeredAt: Date.now() });
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
