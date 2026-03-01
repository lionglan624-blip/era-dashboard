import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useExecution } from './useExecution.js';

describe('useExecution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('reducer: BATCH_LOGS', () => {
    it('appends logs to existing execution', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: 100, logs: [] },
        });
      });

      act(() => {
        result.current.dispatch({
          type: 'BATCH_LOGS',
          buffer: new Map([['exec1', [{ line: 'log1' }, { line: 'log2' }]]]),
        });
      });

      const exec = result.current.state.executions.get('exec1');
      expect(exec.logs).toHaveLength(2);
      expect(exec.logs[0].line).toBe('log1');
      expect(exec.logs[1].line).toBe('log2');
    });

    it('trims logs when exceeding MAX_LOG_ENTRIES', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: 100, logs: [] },
        });
      });

      const largeBatch = Array.from({ length: 5001 }, (_, i) => ({ line: `log${i}` }));
      act(() => {
        result.current.dispatch({
          type: 'BATCH_LOGS',
          buffer: new Map([['exec1', largeBatch]]),
        });
      });

      const exec = result.current.state.executions.get('exec1');
      expect(exec.logs).toHaveLength(5000);
      expect(exec.logs[0].line).toBe('log1');
    });

    it('returns same state if no matching execution', () => {
      const { result } = renderHook(() => useExecution());
      const prevState = result.current.state;

      act(() => {
        result.current.dispatch({
          type: 'BATCH_LOGS',
          buffer: new Map([['nonexistent', [{ line: 'log1' }]]]),
        });
      });

      expect(result.current.state).toBe(prevState);
    });
  });

  describe('reducer: UPDATE_STATUS', () => {
    it('updates execution status and exitCode', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: 100, status: 'running', logs: [] },
        });
      });

      act(() => {
        result.current.dispatch({
          type: 'UPDATE_STATUS',
          executionId: 'exec1',
          status: 'completed',
          exitCode: 0,
        });
      });

      const exec = result.current.state.executions.get('exec1');
      expect(exec.status).toBe('completed');
      expect(exec.exitCode).toBe(0);
    });

    it('returns same state if execution not found', () => {
      const { result } = renderHook(() => useExecution());
      const prevState = result.current.state;

      act(() => {
        result.current.dispatch({
          type: 'UPDATE_STATUS',
          executionId: 'nonexistent',
          status: 'completed',
          exitCode: 0,
        });
      });

      expect(result.current.state).toBe(prevState);
    });
  });

  describe('reducer: WS_STATE', () => {
    it('updates executionStates atomically', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'WS_STATE',
          msg: {
            executionId: 'exec1',
            status: 'running',
            phase: 1,
            phaseName: 'Phase 1',
            sessionId: 'sess1',
            contextPercent: 50,
            isStalled: false,
          },
        });
      });

      const state = result.current.state.executionStates.get('exec1');
      expect(state.status).toBe('running');
      expect(state.phase).toBe(1);
      expect(state.phaseName).toBe('Phase 1');
      expect(state.sessionId).toBe('sess1');
      expect(state.contextPercent).toBe(50);
      expect(state.isStalled).toBe(false);
    });

    it('updates executions status and sessionId when changed', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: 100, status: 'pending', sessionId: null, logs: [] },
        });
      });

      act(() => {
        result.current.dispatch({
          type: 'WS_STATE',
          msg: {
            executionId: 'exec1',
            status: 'running',
            sessionId: 'sess1',
            phase: null,
          },
        });
      });

      const exec = result.current.state.executions.get('exec1');
      expect(exec.status).toBe('running');
      expect(exec.sessionId).toBe('sess1');
    });

    it('updates featurePhases when phase present', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: '100', status: 'running', logs: [] },
        });
      });

      act(() => {
        result.current.dispatch({
          type: 'WS_STATE',
          msg: {
            executionId: 'exec1',
            status: 'running',
            phase: 2,
            phaseName: 'Phase 2',
          },
        });
      });

      const phase = result.current.state.featurePhases.get('100');
      expect(phase.phase).toBe(2);
      expect(phase.name).toBe('Phase 2');
    });

    it('reuses executions when no change needed', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: 100, status: 'running', sessionId: 'sess1', logs: [] },
        });
      });

      const prevExec = result.current.state.executions;

      act(() => {
        result.current.dispatch({
          type: 'WS_STATE',
          msg: {
            executionId: 'exec1',
            status: 'running',
            sessionId: 'sess1',
            phase: null,
          },
        });
      });

      expect(result.current.state.executions).toBe(prevExec);
    });
  });

  describe('reducer: WS_INPUT_REQUIRED', () => {
    it('stores input request in inputRequests map', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'WS_INPUT_REQUIRED',
          msg: {
            executionId: 'exec1',
            context: 'test context',
            questions: ['q1', 'q2'],
            toolUseId: 'tool1',
          },
        });
      });

      const req = result.current.state.inputRequests.get('exec1');
      expect(req.context).toBe('test context');
      expect(req.questions).toEqual(['q1', 'q2']);
      expect(req.toolUseId).toBe('tool1');
    });
  });

  describe('reducer: WS_STALLED', () => {
    it('sets isStalled=true in executionStates', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'WS_STALLED',
          msg: { executionId: 'exec1' },
        });
      });

      const state = result.current.state.executionStates.get('exec1');
      expect(state.isStalled).toBe(true);
    });
  });

  describe('reducer: WS_HANDOFF', () => {
    it('sets execution status to handed-off', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: 100, status: 'running', logs: [] },
        });
      });

      act(() => {
        result.current.dispatch({
          type: 'WS_HANDOFF',
          msg: { executionId: 'exec1' },
        });
      });

      const exec = result.current.state.executions.get('exec1');
      expect(exec.status).toBe('handed-off');
    });
  });

  describe('reducer: SET_FEATURE_PHASE', () => {
    it('sets featurePhases', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'SET_FEATURE_PHASE',
          featureId: '100',
          phase: 3,
          name: 'Phase 3',
        });
      });

      const phase = result.current.state.featurePhases.get('100');
      expect(phase.phase).toBe(3);
      expect(phase.name).toBe('Phase 3');
    });

    it('deletes featurePhases when phase is null', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'SET_FEATURE_PHASE',
          featureId: '100',
          phase: 3,
          name: 'Phase 3',
        });
      });

      act(() => {
        result.current.dispatch({
          type: 'SET_FEATURE_PHASE',
          featureId: '100',
          phase: null,
        });
      });

      expect(result.current.state.featurePhases.has('100')).toBe(false);
    });
  });

  describe('reducer: ADD_EXECUTION', () => {
    it('normalizes and adds execution', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: 100 },
        });
      });

      const exec = result.current.state.executions.get('exec1');
      expect(exec.featureId).toBe('100');
      expect(exec.executionId).toBe('exec1');
      expect(exec.logs).toEqual([]);
    });
  });

  describe('reducer: UPDATE_EXECUTION', () => {
    it('merges updates into existing execution', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: 100, status: 'running', logs: [] },
        });
      });

      act(() => {
        result.current.dispatch({
          type: 'UPDATE_EXECUTION',
          executionId: 'exec1',
          updates: { status: 'paused' },
        });
      });

      const exec = result.current.state.executions.get('exec1');
      expect(exec.status).toBe('paused');
    });
  });

  describe('reducer: CLOSE_TAB', () => {
    it('removes execution from map', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: 100, logs: [] },
        });
      });

      act(() => {
        result.current.dispatch({
          type: 'CLOSE_TAB',
          executionId: 'exec1',
        });
      });

      expect(result.current.state.executions.has('exec1')).toBe(false);
    });
  });

  describe('reducer: CLOSE_FINISHED_TABS', () => {
    it('removes completed/failed/handed-off executions', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: 100, status: 'completed', logs: [] },
        });
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec2', featureId: 101, status: 'failed', logs: [] },
        });
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec3', featureId: 102, status: 'handed-off', logs: [] },
        });
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec4', featureId: 103, status: 'running', logs: [] },
        });
      });

      act(() => {
        result.current.dispatch({ type: 'CLOSE_FINISHED_TABS' });
      });

      expect(result.current.state.executions.has('exec1')).toBe(false);
      expect(result.current.state.executions.has('exec2')).toBe(false);
      expect(result.current.state.executions.has('exec3')).toBe(false);
      expect(result.current.state.executions.has('exec4')).toBe(true);
    });
  });

  describe('reducer: default', () => {
    it('returns same state for unknown action', () => {
      const { result } = renderHook(() => useExecution());
      const prevState = result.current.state;

      act(() => {
        result.current.dispatch({ type: 'UNKNOWN_ACTION' });
      });

      expect(result.current.state).toBe(prevState);
    });
  });

  describe('startCommand', () => {
    it('POSTs to correct endpoint for run command', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'exec1', featureId: 100, logs: [] }),
      });

      const { result } = renderHook(() => useExecution());

      let executionId;
      await act(async () => {
        executionId = await result.current.startCommand(100, 'run');
      });

      expect(global.fetch).toHaveBeenCalledWith('/api/execution/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureId: 100, chain: false }),
      });
      expect(executionId).toBe('exec1');
      expect(result.current.state.executions.has('exec1')).toBe(true);
    });

    it('POSTs to fc endpoint for fc command', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'exec2', featureId: 101, logs: [] }),
      });

      const { result } = renderHook(() => useExecution());

      await act(async () => {
        await result.current.startCommand(101, 'fc');
      });

      expect(global.fetch).toHaveBeenCalledWith('/api/execution/fc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureId: 101, chain: false }),
      });
    });

    it('POSTs to fl endpoint for other commands', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'exec3', featureId: 102, logs: [] }),
      });

      const { result } = renderHook(() => useExecution());

      await act(async () => {
        await result.current.startCommand(102, 'fl');
      });

      expect(global.fetch).toHaveBeenCalledWith('/api/execution/fl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureId: 102, chain: false }),
      });
    });

    it('throws with status 409 for conflict', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Conflict', existingExecutionId: 'existing1' }),
      });

      const { result } = renderHook(() => useExecution());

      await expect(async () => {
        await act(async () => {
          await result.current.startCommand(100, 'run');
        });
      }).rejects.toThrow('Conflict');
    });
  });

  describe('killExecution', () => {
    it('sends DELETE request', async () => {
      global.fetch.mockResolvedValueOnce({ ok: true });

      const { result } = renderHook(() => useExecution());

      await act(async () => {
        await result.current.killExecution('exec1');
      });

      expect(global.fetch).toHaveBeenCalledWith('/api/execution/exec1', { method: 'DELETE' });
    });
  });

  describe('addLog', () => {
    it('buffers logs and dispatches BATCH_LOGS via RAF', () => {
      const { result } = renderHook(() => useExecution());

      act(() => {
        result.current.dispatch({
          type: 'ADD_EXECUTION',
          exec: { id: 'exec1', featureId: 100, logs: [] },
        });
      });

      act(() => {
        result.current.addLog('exec1', { line: 'log1', timestamp: Date.now(), level: 'info' });
        result.current.addLog('exec1', { line: 'log2', timestamp: Date.now(), level: 'info' });
      });

      act(() => {
        vi.runAllTimers();
      });

      const exec = result.current.state.executions.get('exec1');
      expect(exec.logs).toHaveLength(2);
      expect(exec.logs[0].line).toBe('log1');
      expect(exec.logs[1].line).toBe('log2');
    });
  });

  describe('fetchExecutions', () => {
    it('fetches execution list and logs, returns activeIds', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: 'exec1', featureId: 100, status: 'running' },
            { id: 'exec2', featureId: 101, status: 'completed' },
          ],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ logs: [{ line: 'log1', timestamp: Date.now() }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ logs: [{ line: 'log2', timestamp: Date.now() }] }),
        });

      const { result } = renderHook(() => useExecution());

      let activeIds;
      await act(async () => {
        activeIds = await result.current.fetchExecutions();
      });

      expect(activeIds).toEqual(['exec1']);
      expect(result.current.state.executions.size).toBe(2);
      expect(result.current.state.executions.get('exec1').logs).toHaveLength(1);
    });
  });
});
