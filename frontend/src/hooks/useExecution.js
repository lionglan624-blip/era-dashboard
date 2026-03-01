import { useReducer, useCallback, useRef, useEffect } from 'react';

const API_BASE = '/api';
const MAX_LOG_ENTRIES = 5000; // Match backend limit to prevent unbounded browser memory growth
let logIdCounter = 0; // Module-scope: survives HMR, monotonically increments across renders

/**
 * @typedef {Object} LogEntry
 * @property {number} id - Unique log entry ID
 * @property {string} line - Log line content
 * @property {string} timestamp - ISO timestamp
 * @property {string} level - Log level (info, error, debug, warning)
 */

/**
 * @typedef {Object} ExecutionState
 * @property {string} status - Execution status
 * @property {number|null} phase - Current phase number
 * @property {string|null} phaseName - Current phase name
 * @property {string|null} sessionId - Claude session ID
 * @property {boolean} inputRequired - Whether input is required
 * @property {boolean} waitingForInput - Whether waiting for user input
 * @property {number|null} contextPercent - Context window usage percentage
 * @property {boolean} isStalled - Whether execution has stalled
 */

// =============================================================================
// Reducer: manages executions + executionStates + featurePhases + inputRequests
// atomically in a single dispatch (avoids multi-setState render flicker)
// =============================================================================

function normalizeExec(exec) {
  return {
    ...exec,
    featureId: exec.featureId != null ? String(exec.featureId) : null,
    executionId: exec.id,
    logs: exec.logs || [],
  };
}

function createInitialState() {
  return {
    executions: new Map(), // executionId -> execution data (logs, status, etc.)
    executionStates: new Map(), // executionId -> live state (phase, context%, stall, etc.)
    featurePhases: new Map(), // featureId -> { phase, name }
    inputRequests: new Map(), // executionId -> { context, questions, toolUseId }
  };
}

function reducer(state, action) {
  switch (action.type) {
    case 'BATCH_LOGS': {
      const nextExec = new Map(state.executions);
      let changed = false;
      for (const [execId, entries] of action.buffer) {
        const exec = nextExec.get(execId);
        if (exec) {
          const newLogs = exec.logs.concat(entries);
          nextExec.set(execId, {
            ...exec,
            logs: newLogs.length > MAX_LOG_ENTRIES ? newLogs.slice(-MAX_LOG_ENTRIES) : newLogs,
          });
          changed = true;
        }
      }
      return changed ? { ...state, executions: nextExec } : state;
    }

    case 'UPDATE_STATUS': {
      const { executionId, status, exitCode } = action;
      const exec = state.executions.get(executionId);
      if (!exec) return state;

      const changes = {};

      // Update execution status
      const nextExec = new Map(state.executions);
      nextExec.set(executionId, { ...exec, status, exitCode });
      changes.executions = nextExec;

      // Clear input-related state on terminal status
      const isTerminal = status === 'completed' || status === 'failed';
      if (isTerminal) {
        if (state.inputRequests.has(executionId)) {
          const nextIR = new Map(state.inputRequests);
          nextIR.delete(executionId);
          changes.inputRequests = nextIR;
        }
        const es = state.executionStates.get(executionId);
        if (es?.waitingForInput) {
          const nextES = new Map(state.executionStates);
          nextES.set(executionId, { ...es, waitingForInput: false });
          changes.executionStates = nextES;
        }
      }

      return { ...state, ...changes };
    }

    // WebSocket 'state' event: updates executionStates + executions + featurePhases atomically
    case 'WS_STATE': {
      const { msg } = action;
      const changes = {};

      // Always update executionStates
      const nextES = new Map(state.executionStates);
      nextES.set(msg.executionId, {
        status: msg.status,
        phase: msg.phase,
        phaseName: msg.phaseName,
        sessionId: msg.sessionId,
        inputRequired: msg.inputRequired,
        waitingForInput: msg.waitingForInput,
        waitingInputPattern: msg.waitingInputPattern,
        pendingTool: msg.pendingTool,
        contextPercent: msg.contextPercent,
        tokenUsage: msg.tokenUsage,
        isStalled: msg.isStalled || false,
        taskDepth: msg.taskDepth || 0,
        lastActivityTime: msg.lastActivityTime,
      });
      changes.executionStates = nextES;

      // Update executions status/sessionId if changed.
      // Note: `changes.executions || state.executions` — when no execution change is needed,
      // state.executions is reused by reference (no copy), preserving immutability.
      // A new Map is only created when status or sessionId actually differs.
      const exec = state.executions.get(msg.executionId);
      if (exec) {
        const newSessionId = msg.sessionId || exec.sessionId;
        if (exec.status !== msg.status || exec.sessionId !== newSessionId) {
          const nextExec = new Map(changes.executions || state.executions);
          nextExec.set(msg.executionId, { ...exec, status: msg.status, sessionId: newSessionId });
          changes.executions = nextExec;
        }
        // Update featurePhases (include iteration for FL workflow)
        if (
          (msg.phase !== null && msg.phase !== undefined) ||
          (msg.iteration !== null && msg.iteration !== undefined)
        ) {
          const nextFP = new Map(state.featurePhases);
          const current = nextFP.get(exec.featureId) || {};
          nextFP.set(exec.featureId, {
            phase: msg.phase ?? current.phase,
            name: msg.phaseName ?? current.name,
            totalPhases: msg.totalPhases ?? current.totalPhases,
            iteration: msg.iteration ?? current.iteration,
            command: exec.command, // Store command to distinguish FL from others
          });
          changes.featurePhases = nextFP;
        }
      }

      return { ...state, ...changes };
    }

    case 'WS_INPUT_REQUIRED': {
      const { msg } = action;
      const next = new Map(state.inputRequests);
      next.set(msg.executionId, {
        context: msg.context,
        questions: msg.questions,
        toolUseId: msg.toolUseId,
      });
      return { ...state, inputRequests: next };
    }

    case 'WS_STALLED': {
      const { msg } = action;
      const next = new Map(state.executionStates);
      const existing = next.get(msg.executionId) || {};
      next.set(msg.executionId, { ...existing, isStalled: true });
      return { ...state, executionStates: next };
    }

    case 'WS_INPUT_WAIT': {
      const { msg } = action;
      const next = new Map(state.executionStates);
      const existing = next.get(msg.executionId) || {};
      next.set(msg.executionId, {
        ...existing,
        waitingForInput: true,
        waitingInputPattern: msg.pattern,
      });
      return { ...state, executionStates: next };
    }

    case 'WS_HANDOFF': {
      const { msg } = action;
      const exec = state.executions.get(msg.executionId);
      if (!exec) return state;

      const changes = {};

      // Update execution status
      const nextExec = new Map(state.executions);
      nextExec.set(msg.executionId, { ...exec, status: 'handed-off' });
      changes.executions = nextExec;

      // Clear input requests (AskUserQuestion)
      if (state.inputRequests.has(msg.executionId)) {
        const nextIR = new Map(state.inputRequests);
        nextIR.delete(msg.executionId);
        changes.inputRequests = nextIR;
      }

      // Clear waitingForInput in executionStates
      const es = state.executionStates.get(msg.executionId);
      if (es?.waitingForInput) {
        const nextES = new Map(state.executionStates);
        nextES.set(msg.executionId, { ...es, waitingForInput: false });
        changes.executionStates = nextES;
      }

      return { ...state, ...changes };
    }

    // Feature status changed: clear stale executions for that feature
    case 'WS_STATUS_CHANGED': {
      const { featureId } = action;
      const next = new Map(state.executions);
      let changed = false;
      for (const [execId, exec] of next) {
        if (
          exec.featureId === String(featureId) &&
          (exec.status === 'completed' || exec.status === 'failed' || exec.status === 'handed-off')
        ) {
          next.delete(execId);
          changed = true;
        }
      }
      return changed ? { ...state, executions: next } : state;
    }

    case 'SET_FEATURE_PHASE': {
      const { featureId, phase, name } = action;
      const next = new Map(state.featurePhases);
      if (phase === null) {
        next.delete(featureId);
      } else {
        const current = next.get(featureId) || {};
        next.set(featureId, { ...current, phase, name });
      }
      return { ...state, featurePhases: next };
    }

    case 'SET_EXECUTIONS': {
      return { ...state, executions: action.executions };
    }

    case 'INIT_EXECUTION_STATES': {
      const { executionStates: initES, featurePhases: initFP } = action;
      return { ...state, executionStates: initES, featurePhases: initFP };
    }

    case 'ADD_EXECUTION': {
      const { exec } = action;
      const next = new Map(state.executions);
      next.set(exec.id, normalizeExec(exec));
      // Reset phase data for this feature to avoid stale iteration from previous execution
      const nextFP = new Map(state.featurePhases);
      nextFP.delete(exec.featureId);
      return { ...state, executions: next, featurePhases: nextFP };
    }

    case 'UPDATE_EXECUTION': {
      const { executionId, updates } = action;
      const exec = state.executions.get(executionId);
      if (!exec) return state;
      const next = new Map(state.executions);
      next.set(executionId, { ...exec, ...updates });
      return { ...state, executions: next };
    }

    case 'CLOSE_TAB': {
      const next = new Map(state.executions);
      next.delete(action.executionId);
      return { ...state, executions: next };
    }

    case 'CLOSE_FINISHED_TABS': {
      const next = new Map(state.executions);
      let changed = false;
      for (const [execId, exec] of next) {
        if (
          exec.status === 'completed' ||
          exec.status === 'failed' ||
          exec.status === 'handed-off'
        ) {
          next.delete(execId);
          changed = true;
        }
      }
      return changed ? { ...state, executions: next } : state;
    }

    default:
      return state;
  }
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for managing Claude execution state and API interactions
 * @returns {{
 *   state: { executions: Map, executionStates: Map, featurePhases: Map, inputRequests: Map },
 *   dispatch: Function,
 *   startCommand: (featureId: string, command: string, options?: { chain?: boolean }) => Promise<string>,
 *   killExecution: (executionId: string) => Promise<void>,
 *   addLog: (executionId: string, logEntry: LogEntry) => void,
 *   updateStatus: (executionId: string, status: string, exitCode?: number) => void,
 *   fetchExecutions: () => Promise<string[]>
 * }}
 */
export function useExecution() {
  const [state, dispatch] = useReducer(reducer, null, createInitialState);

  // RAF log batching: collect entries within an animation frame, flush as one dispatch
  const logBufferRef = useRef(new Map());
  const rafIdRef = useRef(null);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  const addLog = useCallback((executionId, logEntry) => {
    if (!logBufferRef.current.has(executionId)) {
      logBufferRef.current.set(executionId, []);
    }
    logBufferRef.current.get(executionId).push({ ...logEntry, id: ++logIdCounter });

    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        const buffer = logBufferRef.current;
        logBufferRef.current = new Map();
        rafIdRef.current = null;
        dispatch({ type: 'BATCH_LOGS', buffer });
      });
    }
  }, []);

  const updateStatus = useCallback((executionId, status, exitCode) => {
    dispatch({ type: 'UPDATE_STATUS', executionId, status, exitCode });
  }, []);

  // API calls
  const startCommand = useCallback(async (featureId, command, { chain = false } = {}) => {
    const endpoint = command === 'run' ? 'run' : command === 'fc' ? 'fc' : 'fl';
    const res = await fetch(`${API_BASE}/execution/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId, chain }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    dispatch({ type: 'ADD_EXECUTION', exec: data });
    return data.id;
  }, []);

  const killExecution = useCallback(async (executionId) => {
    await fetch(`${API_BASE}/execution/${executionId}`, { method: 'DELETE' });
  }, []);

  // Fetch existing executions and their logs from API
  // Returns array of active execution IDs (running) for subscription
  // Replaces entire executions Map with backend state (clears stale frontend entries)
  const fetchExecutions = useCallback(async () => {
    const activeIds = [];
    try {
      const res = await fetch(`${API_BASE}/execution`);
      if (!res.ok) return activeIds;
      const list = await res.json();

      const freshMap = new Map();
      const logFetches = [];

      for (const exec of list) {
        if (exec.status === 'running') {
          activeIds.push(exec.id);
        }

        // Skip finished slash commands (featureId=null) so buttons reset on refresh
        const isFinishedSlash =
          exec.featureId == null &&
          (exec.status === 'completed' || exec.status === 'failed' || exec.status === 'handed-off');
        if (isFinishedSlash) continue;

        logFetches.push(
          fetch(`${API_BASE}/execution/${exec.id}/logs`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (data) {
                freshMap.set(exec.id, {
                  ...exec,
                  featureId: exec.featureId != null ? String(exec.featureId) : null,
                  executionId: exec.id,
                  logs: (data.logs || []).map((l) => ({ ...l, id: ++logIdCounter })),
                });
              }
            })
            .catch((err) => console.debug?.('Failed to fetch logs for execution:', err)),
        );
      }

      await Promise.all(logFetches);
      dispatch({ type: 'SET_EXECUTIONS', executions: freshMap });

      // Initialize executionStates and featurePhases from API data
      const initES = new Map();
      const initFP = new Map();
      for (const exec of list) {
        if (exec.status === 'running' || exec.phase != null) {
          initES.set(exec.id, {
            status: exec.status,
            phase: exec.phase ?? null,
            phaseName: exec.phaseName ?? null,
            sessionId: exec.sessionId ?? null,
            inputRequired: false,
            waitingForInput: false,
            waitingInputPattern: null,
            pendingTool: null,
            contextPercent: exec.contextPercent ?? null,
            tokenUsage: exec.tokenUsage ?? null,
            isStalled: false,
            taskDepth: 0,
            lastActivityTime: null,
          });
        }
        // Build featurePhases for running executions
        const fid = exec.featureId != null ? String(exec.featureId) : null;
        if (fid && exec.status === 'running' && exec.phase != null) {
          initFP.set(fid, {
            phase: exec.phase,
            name: exec.phaseName,
            totalPhases: exec.totalPhases ?? null,
            iteration: exec.iteration ?? null,
            command: exec.command,
          });
        }
      }
      if (initES.size > 0 || initFP.size > 0) {
        dispatch({ type: 'INIT_EXECUTION_STATES', executionStates: initES, featurePhases: initFP });
      }
    } catch (err) {
      console.warn('Failed to fetch executions:', err);
    }
    return activeIds;
  }, []);

  return {
    state, // { executions, executionStates, featurePhases, inputRequests }
    dispatch, // For WS_STATE, WS_HANDOFF, etc. from wsHandlers
    startCommand,
    killExecution,
    addLog,
    updateStatus,
    fetchExecutions,
  };
}
