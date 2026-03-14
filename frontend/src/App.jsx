import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useFeatures, useFeatureDetail } from './hooks/useFeatures.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useExecution } from './hooks/useExecution.js';
import TreeView from './components/TreeView.jsx';
import FeatureDetail from './components/FeatureDetail.jsx';
import ExecutionPanel from './components/ExecutionPanel.jsx';

// UI timing constants
const CS_PROFILE_SWITCH_DELAY_MS = 1500; // Wait for cs.bat profile switch to complete

// Month abbreviation → number mapping for reset time formatting
const MONTH_MAP = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Convert "Feb 9, 9pm" → "9pm" (≤24h) or "2/9" (>24h). Also handles time-only "1pm", "5:59am". */
function formatResetTime(raw) {
  if (!raw) return null;
  // Time-only format from session resets: "1pm", "11am", "5:59am"
  const timeOnly = raw.match(/^(\d{1,2}(?::\d{2})?)(am|pm)$/i);
  if (timeOnly) return raw;
  // "Feb 9, 9pm" or "Feb 21, 5:59am"
  const m = raw.match(/^([A-Za-z]+)\s+(\d+),?\s*(.*)/);
  if (!m) return null;
  const mon = MONTH_MAP[m[1].toLowerCase()];
  if (!mon) return null;
  const day = parseInt(m[2], 10);
  const timePart = m[3].trim();
  const timeMatch = timePart.match(/^(\d+)(?::\d{2})?(am|pm)$/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    if (timeMatch[2].toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (timeMatch[2].toLowerCase() === 'am' && hour === 12) hour = 0;
    const now = new Date();
    const reset = new Date(now.getFullYear(), mon - 1, day, hour);
    if (reset < now) return `${mon}/${day}`;
    return reset - now <= 86400000 ? timePart : `${mon}/${day}`;
  }
  return `${mon}/${m[2]}`;
}

export default function App() {
  const { features, loading, error, refetch } = useFeatures();
  const {
    state: { executions, executionStates, featurePhases, inputRequests },
    dispatch,
    startCommand,
    killExecution,
    bulkQueueRoots,
    cancelQueueItem,
    addLog,
    updateStatus,
    fetchExecutions,
    fetchHistory,
  } = useExecution();

  const [selectedFeatureId, setSelectedFeatureId] = useState(null);
  const [activeExecutionId, setActiveExecutionId] = useState(null);
  const [showExecutionPanel, setShowExecutionPanel] = useState(false);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const headerRef = useRef(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [shellStates, setShellStates] = useState({});
  const [drPending, setDrPending] = useState(false);
  const [featureQueueWaiters, setFeatureQueueWaiters] = useState(new Map());

  // Health check state
  const [healthStatus, setHealthStatus] = useState({
    backend: null, // null = unknown, true = ok, false = down
    claudeRunning: 0,
    proxy: null, // null = unknown, { enabled, status }
    lastCheck: null,
    projectRoot: null, // Project root path from backend
    gitDirty: false,
    gitChangedCount: 0,
    rateLimit: null,
    claudeStatus: null,
    runLockFeatureId: null,
  });
  const healthCheckRef = useRef(null);
  const recentNotificationsRef = useRef(new Set()); // Track recent notification keys for deduplication
  const executionsRef = useRef(executions); // Stable ref for wsHandlers that need current executions
  const subscribeRef = useRef(null); // Stable ref for subscribe (chain events need to subscribe to new executions)
  const activeExecutionIdRef = useRef(activeExecutionId); // Stable ref for tab management

  // CCS enabled status (read-only, managed via ~/.ccs/)
  const [ccsProfile, setCcsProfile] = useState(null);

  // Measure header height for execution panel positioning
  useEffect(() => {
    if (!headerRef.current) return;
    const measure = () => {
      if (headerRef.current) {
        setHeaderHeight(headerRef.current.offsetHeight);
      }
    };
    measure();
    const ro = new ResizeObserver(() => requestAnimationFrame(measure));
    ro.observe(headerRef.current);
    return () => ro.disconnect();
  }, []);

  // Keep refs in sync
  useEffect(() => {
    executionsRef.current = executions;
  }, [executions]);
  useEffect(() => {
    activeExecutionIdRef.current = activeExecutionId;
  }, [activeExecutionId]);

  // Sync activeExecutionId validity when executions change (tab removed, etc.)
  // Also auto-select first execution when panel has tabs but no active selection,
  // to avoid showing "Waiting for output..." with tabs visible.
  useEffect(() => {
    if (activeExecutionId && !executions.has(activeExecutionId)) {
      const remaining = Array.from(executions.keys());
      if (remaining.length > 0) {
        setActiveExecutionId(remaining[0]);
      } else {
        setActiveExecutionId(null);
        setShowExecutionPanel(false);
      }
    } else if (!activeExecutionId && executions.size > 0 && showExecutionPanel) {
      setActiveExecutionId(Array.from(executions.keys())[0]);
    }
  }, [executions, activeExecutionId, showExecutionPanel]);

  const addNotification = useCallback((notification) => {
    // Deduplicate: create a key from notification content
    const dedupeKey = `${notification.type}:${notification.featureId || ''}:${notification.message || ''}`;

    // Skip if we've shown this notification recently (within 2 seconds)
    if (recentNotificationsRef.current.has(dedupeKey)) {
      return;
    }

    // Mark as recently shown
    recentNotificationsRef.current.add(dedupeKey);
    setTimeout(() => {
      recentNotificationsRef.current.delete(dedupeKey);
    }, 2000);

    const id = Date.now();
    setNotifications((prev) => [...prev, { id, ...notification }]);
    // Auto-dismiss after 10 seconds (unless persistent)
    if (!notification.persistent) {
      setTimeout(() => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
      }, 10000);
    }
  }, []);

  const dismissNotification = useCallback((id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const { feature: selectedFeature } = useFeatureDetail(selectedFeatureId);

  // Helper: subscribe to a new chain/retry execution, fetch its data, and switch active tab
  const subscribeAndFetchExecution = useCallback(
    (newExecutionId, errorContext) => {
      if (!newExecutionId) return;
      subscribeRef.current?.(newExecutionId);
      setActiveExecutionId(newExecutionId);
      fetch(`/api/execution/${newExecutionId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((exec) => {
          if (exec) dispatch({ type: 'ADD_EXECUTION', exec });
        })
        .catch((err) => {
          addNotification({
            type: 'warning',
            title: `${errorContext} Error`,
            message: `Failed to fetch execution: ${err.message}`,
          });
        });
    },
    [dispatch, addNotification],
  );

  const reconcileOldExecution = useCallback(
    (oldExecutionId) => {
      if (!oldExecutionId) return;
      fetch(`/api/execution/${oldExecutionId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((exec) => {
          if (exec) dispatch({ type: 'RECONCILE_EXECUTION', exec });
        })
        .catch(() => {}); // Silent: old exec may be TTL-cleaned (404 expected)
    },
    [dispatch],
  );

  // Health check function (extracted for reuse, before wsHandlers which references it)
  const checkHealth = useCallback(async (refreshRateLimit = false) => {
    try {
      const url = refreshRateLimit ? '/api/health?refresh=1' : '/api/health';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setHealthStatus({
          backend: true,
          claudeRunning: data.claude?.runningCount || 0,
          proxy: data.proxy || null,
          lastCheck: Date.now(),
          projectRoot: data.projectRoot || null,
          gitDirty: data.git?.dirty || false,
          gitChangedCount: data.git?.changedCount || 0,
          rateLimit: data.rateLimit || null,
          claudeStatus: data.claudeStatus || null,
          ccsProfiles: data.ccsProfiles || [],
          runLockFeatureId: data.claude?.runLockFeatureId || null,
        });
        // Sync CCS profile
        if (data.ccsProfile !== undefined) {
          setCcsProfile(data.ccsProfile);
        }
        // Restore pending DR state (survives browser reload)
        if (data.pendingRestart !== undefined) {
          setDrPending(data.pendingRestart);
        }
        // Shell states (cs/dr/upd) are NOT restored from health on F5.
        // They survive backend restart via React state (WS reconnect preserves it).
        // F5 resets all shell states to empty (transient notification).
      } else {
        setHealthStatus((prev) => ({
          ...prev,
          backend: false,
          lastCheck: Date.now(),
          projectRoot: prev.projectRoot,
          gitDirty: false,
          gitChangedCount: 0,
          rateLimit: prev.rateLimit,
          ccsProfiles: prev.ccsProfiles,
        }));
      }
    } catch (err) {
      console.warn('Health check failed:', err);
      setHealthStatus((prev) => ({
        ...prev,
        backend: false,
        lastCheck: Date.now(),
        projectRoot: prev.projectRoot,
        gitDirty: false,
        gitChangedCount: 0,
        rateLimit: prev.rateLimit,
        ccsProfiles: prev.ccsProfiles,
      }));
    }
  }, []);

  // WebSocket message handlers keyed by msg.type
  // dispatch actions update executions/executionStates/featurePhases/inputRequests atomically
  const wsHandlers = useMemo(
    () => ({
      log: (msg) => {
        addLog(msg.executionId, {
          line: msg.line,
          timestamp: msg.timestamp,
          level: msg.level,
        });
      },
      status: (msg) => {
        updateStatus(msg.executionId, msg.status, msg.exitCode);
        if (
          (msg.status === 'completed' || msg.status === 'failed') &&
          executionsRef.current.has(msg.executionId)
        ) {
          setTimeout(refetch, 1000);
          // Re-check git status after commit completes
          const completedExec = executionsRef.current.get(msg.executionId);
          if (completedExec?.command === 'commit') {
            setTimeout(checkHealth, 2000);
          }
        }
      },
      'features-updated': () => {
        refetch();
      },
      'status-changed': (msg) => {
        // No reducer dispatch needed: old executions are cleaned up via user actions
        // (CLOSE_TAB / CLOSE_FINISHED_TABS), not automatically on status change.
        addNotification({
          type: 'status-changed',
          title: `F${msg.featureId} Status Changed`,
          message: `${msg.oldStatus} → ${msg.newStatus}`,
          featureId: msg.featureId,
          persistent: true,
        });
        refetch();
      },
      'phase-update': (msg) => {
        dispatch({
          type: 'SET_FEATURE_PHASE',
          featureId: msg.featureId,
          phase: msg.phase,
          name: msg.phaseName,
        });
      },
      state: (msg) => {
        dispatch({ type: 'WS_STATE', msg });
      },
      'input-required': (msg) => {
        dispatch({ type: 'WS_INPUT_REQUIRED', msg });
        addNotification({
          type: 'attention',
          title: 'Input Required',
          message: 'Check execution panel for user prompt',
          executionId: msg.executionId,
          persistent: true,
        });
      },
      stalled: (msg) => {
        dispatch({ type: 'WS_STALLED', msg });
        const stalledExec = executionsRef.current.get(msg.executionId);
        const stalledFeatureId = stalledExec?.featureId;
        addNotification({
          type: 'warning',
          title: `${stalledFeatureId ? `F${stalledFeatureId}` : 'Execution'} Stalled`,
          message: `No output for ${Math.round(msg.elapsed / 1000)}s`,
          executionId: msg.executionId,
          featureId: stalledFeatureId,
        });
      },
      'input-wait': (msg) => {
        dispatch({ type: 'WS_INPUT_WAIT', msg });
        addNotification({
          type: 'attention',
          title: 'Input Required',
          message: `${msg.pattern} — answer in panel`,
          executionId: msg.executionId,
          persistent: true,
        });
      },
      handoff: (msg) => {
        dispatch({ type: 'WS_HANDOFF', msg });
        addNotification({
          type: 'info',
          title: 'Handed Off to Terminal',
          message: msg.reason,
          executionId: msg.executionId,
        });
      },
      'chain-progress': (msg) => {
        addNotification({
          type: 'info',
          title: `F${msg.featureId} Chain`,
          message: `${msg.previousCommand.toUpperCase()} done → ${msg.nextCommand.toUpperCase()}`,
          featureId: msg.featureId,
          persistent: true,
        });
        subscribeAndFetchExecution(msg.newExecutionId, 'Chain');
        reconcileOldExecution(msg.oldExecutionId);
      },
      'chain-retry': (msg) => {
        const cmd = (msg.command || 'fl').toUpperCase();
        const isContext = msg.retryType === 'context';
        addNotification({
          type: 'warning',
          title: `F${msg.featureId} ${cmd} Retry`,
          message: isContext
            ? `Context limit hit. Retry ${msg.retryCount}/${msg.maxRetries}`
            : `FL re-run requested. Retry ${msg.retryCount}/${msg.maxRetries}`,
          featureId: msg.featureId,
          persistent: true,
        });
        subscribeAndFetchExecution(msg.newExecutionId, 'Retry');
        reconcileOldExecution(msg.oldExecutionId);
      },
      'fl-retry-exhausted': (msg) => {
        addNotification({
          type: 'warning',
          title: `F${msg.featureId} FL Retry Exhausted`,
          message: `FL retries used up (${msg.retryCount}/${msg.maxRetries}). Manual /fl re-run needed.`,
          featureId: msg.featureId,
          persistent: true,
        });
      },
      'account-limit': (msg) => {
        const cmd = (msg.command || '').toUpperCase();
        addNotification({
          type: 'warning',
          title: `F${msg.featureId} Account Limit`,
          message: `${cmd} stopped — usage limit hit. Retry will not help.`,
          featureId: msg.featureId,
          persistent: true,
        });
      },
      'rate-limit-retry': (msg) => {
        addNotification({
          type: 'info',
          title: `F${msg.featureId} Rate Limit Retry`,
          message: msg.resumed ? 'Resuming after rate limit' : 'Retrying with profile switch',
          featureId: msg.featureId,
          persistent: true,
        });
        subscribeAndFetchExecution(msg.newExecutionId, 'Rate Limit');
        reconcileOldExecution(msg.oldExecutionId);
      },
      'rate-limit-waiting': (msg) => {
        addNotification({
          type: 'info',
          title: `F${msg.featureId} Rate Limit`,
          message: `Waiting until ${new Date(msg.retryAt).toLocaleTimeString()} (${Math.round(msg.delayMs / 60000)}min)`,
          featureId: msg.featureId,
          persistent: true,
        });
      },
      'rate-limit-exhausted': (msg) => {
        addNotification({
          type: 'warning',
          title: `F${msg.featureId} Rate Limit Exhausted`,
          message: `Still at ${msg.percent}% usage. Manual re-run needed.`,
          featureId: msg.featureId,
          persistent: true,
        });
      },
      'chain-blocked': (msg) => {
        addNotification({
          type: 'warning',
          title: `F${msg.featureId} Chain Blocked`,
          message: `Pending deps: ${msg.pendingDeps}`,
          featureId: msg.featureId,
          persistent: true,
        });
      },
      'execution-started': (msg) => {
        if (msg.source === 'dequeue') {
          // Dequeued execution: subscribe + fetch without switching active tab
          if (!msg.executionId) return;
          subscribeRef.current?.(msg.executionId);
          fetch(`/api/execution/${msg.executionId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((exec) => {
              if (exec) dispatch({ type: 'ADD_EXECUTION', exec });
            })
            .catch(() => {});
        } else {
          // External API (curl) or slash/debug: subscribe + switch tab
          subscribeAndFetchExecution(msg.executionId, msg.command.toUpperCase());
        }
      },
      'upd-complete': (msg) => {
        const changed = msg.oldVersion !== msg.newVersion;
        addNotification({
          type: 'info',
          title: 'Update',
          message: changed
            ? `${msg.oldVersion} → ${msg.newVersion}`
            : `${msg.newVersion || 'unknown'} (no change)`,
          persistent: true,
        });
      },
      'shell-complete': (msg) => {
        setShellStates((prev) => ({
          ...prev,
          [msg.command]: msg.success ? 'completed' : 'failed',
        }));
      },
      'queue-updated': (msg) => {
        const waiterMap = new Map();
        if (msg.chainWaiters) {
          for (const w of msg.chainWaiters)
            waiterMap.set(String(w.featureId), { position: null, executionId: w.executionId });
        }
        if (msg.queued) {
          for (let i = 0; i < msg.queued.length; i++) {
            waiterMap.set(String(msg.queued[i].featureId), {
              position: i + 1,
              executionId: msg.queued[i].id,
            });
          }
        }
        setFeatureQueueWaiters(waiterMap);
      },
      'auto-dr-pending': () => {
        setDrPending(true);
      },
      'auto-dr': () => {
        setDrPending(false);
        setShellStates((prev) => ({ ...prev, dr: 'completed' }));
      },
    }),
    [
      addLog,
      updateStatus,
      refetch,
      addNotification,
      dispatch,
      subscribeAndFetchExecution,
      reconcileOldExecution,
      checkHealth,
    ],
  );

  const handleWsMessage = useCallback(
    (msg) => {
      const handler = wsHandlers[msg.type];
      if (handler) handler(msg);
    },
    [wsHandlers],
  );

  const { connected, reconnecting, subscribe, unsubscribe } = useWebSocket(handleWsMessage);
  const wasConnectedRef = useRef(false);

  // Keep subscribeRef in sync via useEffect (not during render, for Strict Mode safety)
  useEffect(() => {
    subscribeRef.current = subscribe;
  }, [subscribe]);

  // Fetch existing executions when connected and subscribe to active ones
  // Also refetch features on reconnect (backend may have restarted)
  useEffect(() => {
    if (connected) {
      fetchExecutions().then((activeIds) => {
        // Subscribe to all running executions for live updates
        for (const execId of activeIds) {
          subscribe(execId);
        }
        // Initialize active execution if none selected
        if (activeIds.length > 0) {
          setActiveExecutionId((prev) => prev ?? activeIds[0]);
        }
      });
      // Restore queue waiters from backend (survives F5, cleared only by DR)
      fetch('/api/execution/queue')
        .then((r) => (r.ok ? r.json() : null))
        .then((qs) => {
          if (!qs) return;
          const waiterMap = new Map();
          if (qs.chainWaiters) {
            for (const w of qs.chainWaiters)
              waiterMap.set(String(w.featureId), { position: null, executionId: w.executionId });
          }
          if (qs.queued) {
            for (let i = 0; i < qs.queued.length; i++) {
              waiterMap.set(String(qs.queued[i].featureId), {
                position: i + 1,
                executionId: qs.queued[i].id,
              });
            }
          }
          setFeatureQueueWaiters(waiterMap);
        })
        .catch(() => {});
      // Refetch features on reconnect (not on initial connect)
      if (wasConnectedRef.current) {
        refetch();
      }
      wasConnectedRef.current = true;
    }
  }, [connected, fetchExecutions, subscribe, refetch]);

  // Health check polling
  useEffect(() => {
    checkHealth(true); // Initial check (trigger fresh rate limit capture)
    // Rapid retry for startup: rate limit capture takes ~5s, retry quickly to pick it up
    const startupRetry = setTimeout(checkHealth, 8000);
    healthCheckRef.current = setInterval(checkHealth, 30000); // Every 30 seconds

    return () => {
      clearTimeout(startupRetry);
      if (healthCheckRef.current) {
        clearInterval(healthCheckRef.current);
      }
    };
  }, [checkHealth]);

  // Slash command execution states (commit, sync-deps)
  // Priority: running > handed-off > failed > completed
  const slashCommandStates = useMemo(() => {
    const states = {};
    const priority = { running: 4, 'handed-off': 3, failed: 2, completed: 1 };
    for (const [, exec] of executions) {
      if (exec.featureId === null && exec.command) {
        const cmd = exec.command;
        const cur = priority[exec.status] || 0;
        const prev = priority[states[cmd]] || 0;
        if (cur > prev) states[cmd] = exec.status;
      }
    }
    return states;
  }, [executions]);

  const slashBtnClass = useCallback(
    (cmd) => {
      const s = slashCommandStates[cmd];
      if (s === 'running') return 'btn-slash slash-running';
      if (s === 'completed') return 'btn-slash slash-done';
      if (s === 'failed') return 'btn-slash slash-failed';
      if (s === 'handed-off') return 'btn-slash slash-handoff';
      if (cmd === 'commit' && healthStatus.gitDirty) return 'btn-slash slash-dirty';
      return 'btn-slash';
    },
    [slashCommandStates, healthStatus.gitDirty],
  );

  const shellBtnClass = useCallback(
    (cmd) => {
      const s = shellStates[cmd];
      if (s === 'running') return 'btn-cmd cmd-running';
      if (s === 'completed') return 'btn-cmd cmd-done';
      if (s === 'failed') return 'btn-cmd cmd-failed';
      if (cmd === 'dr' && drPending) return 'btn-cmd cmd-pending';
      return 'btn-cmd';
    },
    [shellStates, drPending],
  );

  // Derive all feature-level Maps from executions in a single pass
  const {
    runningFeatures,
    featureSessionIds,
    featureLastOutcome,
    featureContextPercent,
    featureStartedAt,
    featureRunningCommand,
    featureInputWaiting,
    featureRetryInfo,
    featureProfiles,
  } = useMemo(() => {
    const running = new Set();
    const sessionIds = new Map();
    const lastOutcome = new Map();
    const contextPercent = new Map();
    const startedAt = new Map();
    const runningCmd = new Map();
    const inputWaiting = new Set();
    const retryInfo = new Map();
    const profiles = new Map();

    for (const [execId, exec] of executions) {
      const isStopped =
        exec.status === 'completed' || exec.status === 'failed' || exec.status === 'handed-off';

      if (exec.status === 'running') {
        running.add(exec.featureId);
        if (exec.command) runningCmd.set(exec.featureId, exec.command.toUpperCase());
        if (exec.ccsProfile) profiles.set(exec.featureId, exec.ccsProfile);
        const state = executionStates.get(execId);
        if (state?.contextPercent != null) contextPercent.set(exec.featureId, state.contextPercent);
        if (exec.startedAt != null) startedAt.set(exec.featureId, exec.startedAt);
        if (state?.waitingForInput) inputWaiting.add(exec.featureId);
        if (exec.chain) {
          const fl = exec.chain.retryCount || 0;
          const ctx = exec.chain.contextRetryCount || 0;
          const inc = exec.chain.incompleteRetryCount || 0;
          if (fl + ctx + inc > 0) {
            retryInfo.set(exec.featureId, { fl, context: ctx, incomplete: inc });
          }
        }
        // Also store executionId for running executions so input-waiting click can navigate
        sessionIds.set(exec.featureId, {
          executionId: execId,
          sessionId: exec.sessionId,
          startedAt: exec.startedAt,
        });
      }

      // Check waitingForInput for completed executions too (browser-first y/n design):
      // CLI exits after emitting y/n text, but user still needs to answer via resume.
      if (isStopped) {
        const state = executionStates.get(execId);
        if (state?.waitingForInput) inputWaiting.add(exec.featureId);
      }

      if (isStopped && exec.sessionId) {
        const existing = sessionIds.get(exec.featureId);
        if (
          !existing ||
          (exec.startedAt && (!existing.startedAt || exec.startedAt > existing.startedAt))
        ) {
          sessionIds.set(exec.featureId, {
            executionId: execId,
            sessionId: exec.sessionId,
            startedAt: exec.startedAt,
          });
        }
      }

      if (isStopped) {
        const existing = lastOutcome.get(exec.featureId);
        if (
          !existing ||
          (exec.startedAt && (!existing.startedAt || exec.startedAt > existing.startedAt))
        ) {
          lastOutcome.set(exec.featureId, {
            status: exec.status,
            command: exec.command,
            startedAt: exec.startedAt,
          });
        }
      }

      // Input requests from AskUserQuestion
      if (inputRequests.has(execId)) inputWaiting.add(exec.featureId);
    }

    return {
      runningFeatures: running,
      featureSessionIds: sessionIds,
      featureLastOutcome: lastOutcome,
      featureContextPercent: contextPercent,
      featureStartedAt: startedAt,
      featureRunningCommand: runningCmd,
      featureInputWaiting: inputWaiting,
      featureRetryInfo: retryInfo,
      featureProfiles: profiles,
    };
  }, [executions, executionStates, inputRequests]);

  const handleRunCommand = useCallback(
    async (featureId, command) => {
      try {
        // Auto-release stale run-lock before /run (avoids silent queueing)
        if (command === 'run' && healthStatus.runLockFeatureId) {
          const res = await fetch('/api/execution/run-lock', { method: 'DELETE' });
          const data = await res.json();
          if (data.released) {
            addNotification({
              type: 'info',
              title: 'Run Lock',
              message: `F${data.featureId} lock released`,
            });
            checkHealth();
          }
          // If 409 (active /run), proceed — backend will queue normally
        }
        // Always chain: fc→fl→run auto-progression (stops on error/handoff/[DONE])
        const execId = await startCommand(featureId, command, { chain: true });
        setActiveExecutionId(execId);
        // Don't auto-show panel - user can open it manually via floating button
        subscribe(execId);
      } catch (err) {
        addNotification({
          type: 'warning',
          title: `${command.toUpperCase()} Failed`,
          message: err.message,
        });
      }
    },
    [startCommand, subscribe, addNotification, healthStatus.runLockFeatureId, checkHealth],
  );

  const handleReleaseLock = useCallback(
    async (featureId) => {
      try {
        const res = await fetch('/api/execution/run-lock', { method: 'DELETE' });
        const data = await res.json();
        if (data.released) {
          addNotification({
            type: 'info',
            title: 'Run Lock',
            message: `F${featureId} lock released`,
          });
          checkHealth();
        }
      } catch (err) {
        addNotification({ type: 'warning', title: 'Lock Release Failed', message: err.message });
      }
    },
    [addNotification, checkHealth],
  );

  const handleBulkQueue = useCallback(
    async (featureIds) => {
      try {
        const data = await bulkQueueRoots(featureIds);
        // Subscribe to each queued execution for WS updates
        for (const exec of data.queued) {
          subscribe(exec.id);
        }
        // Set the first queued item as active
        if (data.queued.length > 0) {
          setActiveExecutionId(data.queued[0].id);
        }
        // Notify user
        const qCount = data.queued.length;
        const sCount = data.skipped.length;
        if (qCount > 0) {
          addNotification({
            type: 'info',
            title: 'Queue Roots',
            message: `${qCount} queued${sCount > 0 ? `, ${sCount} skipped` : ''}`,
          });
        } else {
          addNotification({
            type: 'warning',
            title: 'Queue Roots',
            message: sCount > 0 ? `${sCount} skipped` : 'Nothing to queue',
          });
        }
      } catch (err) {
        console.error('Bulk queue failed:', err);
        addNotification({
          type: 'warning',
          title: 'Queue Roots Failed',
          message: err.message,
        });
      }
    },
    [bulkQueueRoots, subscribe, addNotification],
  );

  const handleCancelQueueItem = useCallback(
    async (featureId) => {
      const waiter = featureQueueWaiters.get(String(featureId));
      if (!waiter?.executionId) return;
      try {
        await cancelQueueItem(waiter.executionId);
      } catch (err) {
        console.error('Cancel queue item failed:', err);
      }
    },
    [cancelQueueItem, featureQueueWaiters],
  );

  const handleClearQueue = useCallback(async () => {
    try {
      await fetch('/api/execution/queue/clear', { method: 'POST' });
    } catch (err) {
      console.error('Clear queue failed:', err);
    }
  }, []);

  const handleOpenTerminal = useCallback(
    async (featureId, command) => {
      try {
        // Check if there's a running execution for this feature
        // Note: relies on executionsRef (frontend state) which may be stale during
        // WebSocket disconnect. Acceptable trade-off for personal tool; a backend
        // "find running for feature" API would be more robust.
        let runningExecId = null;
        const featureIdStr = String(featureId);
        for (const [execId, exec] of executionsRef.current) {
          if (exec.featureId === featureIdStr && exec.status === 'running') {
            runningExecId = execId;
            break;
          }
        }

        if (runningExecId) {
          // Resume existing session in terminal
          const res = await fetch(`/api/execution/${runningExecId}/resume/terminal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          if (!res.ok) {
            const err = await res.json();
            addNotification({
              type: 'warning',
              title: 'Resume Failed',
              message: err.error,
            });
          }
        } else {
          // Open new terminal
          await fetch('/api/execution/terminal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ featureId, command }),
          });
        }
      } catch (err) {
        addNotification({ type: 'warning', title: 'Terminal Error', message: err.message });
      }
    },
    [addNotification],
  );

  const handleAnswer = useCallback(
    async (executionId, answer) => {
      try {
        const res = await fetch(`/api/execution/${executionId}/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer }),
        });
        if (!res.ok) {
          const err = await res.json();
          addNotification({
            type: 'warning',
            title: 'Answer Failed',
            message: err.error,
          });
        } else {
          const data = await res.json();
          // Clear input state for old execution
          dispatch({ type: 'CLEAR_INPUT', executionId });
          // Select the new execution tab
          if (data.executionId) {
            setActiveExecutionId(data.executionId);
          }
        }
      } catch (err) {
        addNotification({ type: 'warning', title: 'Answer Error', message: err.message });
      }
    },
    [dispatch, addNotification],
  );

  const handleResumeBrowser = useCallback(
    async (executionId) => {
      try {
        const res = await fetch(`/api/execution/${executionId}/resume/browser`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'continue' }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Resume failed' }));
          addNotification({
            type: 'warning',
            title: 'Resume Failed',
            message: err.error,
          });
        }
        // execution-started WS event will auto-add the new execution tab
      } catch (err) {
        addNotification({ type: 'warning', title: 'Resume Error', message: err.message });
      }
    },
    [addNotification],
  );

  const handleResumeTerminal = useCallback(
    async (executionId) => {
      try {
        const res = await fetch(`/api/execution/${executionId}/resume/terminal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
          const err = await res.json();
          addNotification({
            type: 'warning',
            title: 'Resume Failed',
            message: err.error,
          });
        } else {
          // Mark execution as handed-off so TreeView shows orange state instead of stale green
          dispatch({
            type: 'UPDATE_EXECUTION',
            executionId,
            updates: { status: 'handed-off' },
          });
        }
      } catch (err) {
        addNotification({ type: 'warning', title: 'Terminal Error', message: err.message });
      }
    },
    [dispatch, addNotification],
  );

  // Resume by featureId (for TreeView)
  const handleResumeByFeature = useCallback(
    (featureId) => {
      const info = featureSessionIds.get(featureId);
      if (info?.executionId) {
        handleResumeTerminal(info.executionId);
      } else {
        addNotification({
          type: 'warning',
          title: 'Resume',
          message: `No session found for F${featureId}`,
        });
      }
    },
    [featureSessionIds, handleResumeTerminal, addNotification],
  );

  const handleResumeBrowserByFeature = useCallback(
    (featureId) => {
      const info = featureSessionIds.get(featureId);
      if (info?.executionId) {
        handleResumeBrowser(info.executionId);
      } else {
        addNotification({
          type: 'warning',
          title: 'Resume',
          message: `No session found for F${featureId}`,
        });
      }
    },
    [featureSessionIds, handleResumeBrowser, addNotification],
  );

  // Navigate to ExecutionPanel when input-waiting tile clicked (Y/N buttons are there)
  const handleInputWaitingClick = useCallback(
    (featureId) => {
      const info = featureSessionIds.get(featureId);
      if (info?.executionId) {
        setActiveExecutionId(info.executionId);
        setShowExecutionPanel(true);
      }
    },
    [featureSessionIds],
  );

  const handleOpenHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const entries = await fetchHistory();
      setHistoryEntries(entries);
    } finally {
      setHistoryLoading(false);
    }
  }, [fetchHistory]);

  const handleShellCommand = useCallback(
    async (command, profile) => {
      setShellStates((prev) => ({ ...prev, [command]: 'running' }));
      const body = profile !== undefined ? { command, profile } : { command };
      try {
        const res = await fetch('/api/execution/shell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json();
          setShellStates((prev) => ({ ...prev, [command]: 'failed' }));
          addNotification({
            type: 'warning',
            title: 'Command Failed',
            message: err.error,
          });
        } else {
          const msg = profile !== undefined ? `Switched to ${profile}` : 'Launched';
          addNotification({ type: 'info', title: `${command}`, message: msg });
          // Refresh health check after profile switch (cs.bat needs time to complete)
          if (command === 'cs') {
            setTimeout(checkHealth, CS_PROFILE_SWITCH_DELAY_MS);
          }
        }
      } catch (err) {
        setShellStates((prev) => ({ ...prev, [command]: 'failed' }));
        addNotification({ type: 'warning', title: 'Error', message: err.message });
      }
    },
    [addNotification, checkHealth],
  );

  const handleSlashCommand = useCallback(
    async (command) => {
      try {
        const res = await fetch('/api/execution/slash', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command }),
        });
        if (!res.ok) {
          const err = await res.json();
          addNotification({
            type: 'warning',
            title: 'Command Failed',
            message: err.error,
          });
          return;
        }
        const data = await res.json();
        dispatch({ type: 'ADD_EXECUTION', exec: data });
        subscribe(data.id);
        addNotification({ type: 'info', title: `/${command}`, message: 'Started' });
      } catch (err) {
        addNotification({ type: 'warning', title: 'Error', message: err.message });
      }
    },
    [addNotification, dispatch, subscribe],
  );

  const handleCloseTab = useCallback(
    (executionId) => {
      const exec = executionsRef.current.get(executionId);
      if (exec && exec.status === 'running') {
        killExecution(executionId); // Internal DELETE → killExecution path
      } else {
        // Remove finished execution from backend memory
        fetch(`/api/execution/${executionId}`, { method: 'DELETE' }).catch(() => {});
      }
      unsubscribe(executionId);
      dispatch({ type: 'CLOSE_TAB', executionId });
      // If this was the last tab, close panel synchronously (don't wait for useEffect)
      const remaining =
        executionsRef.current.size - (executionsRef.current.has(executionId) ? 1 : 0);
      if (remaining === 0) {
        setActiveExecutionId(null);
        setShowExecutionPanel(false);
      }
    },
    [unsubscribe, dispatch, killExecution],
  );

  const handleCloseFinishedTabs = useCallback(() => {
    let hasRemaining = false;
    for (const [execId, exec] of executionsRef.current) {
      if (exec.status === 'completed' || exec.status === 'failed' || exec.status === 'handed-off') {
        unsubscribe(execId);
        // Remove finished execution from backend memory
        fetch(`/api/execution/${execId}`, { method: 'DELETE' }).catch(() => {});
      } else {
        hasRemaining = true;
      }
    }
    dispatch({ type: 'CLOSE_FINISHED_TABS' });
    if (!hasRemaining) {
      setActiveExecutionId(null);
      setShowExecutionPanel(false);
    }
  }, [unsubscribe, dispatch]);

  // Show floating button when panel is closed but executions exist
  const _hasActiveExecutions = useMemo(() => {
    for (const [, exec] of executions) {
      if (exec.status === 'running') {
        return true;
      }
    }
    return false;
  }, [executions]);

  if (loading) {
    return <div className="app-loading">Loading features...</div>;
  }

  if (error) {
    return (
      <div className="app-error">
        <h2>Error loading features</h2>
        <p>{error}</p>
        <button onClick={refetch}>Retry</button>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Notification Toast Area */}
      {notifications.length > 0 && (
        <div className="notification-container">
          {notifications.map((n) => (
            <div
              key={n.id}
              className={`notification notification-${n.type}`}
              onClick={() => dismissNotification(n.id)}
            >
              <div className="notification-content">
                <strong>{n.title}</strong>
                <span>{n.message}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Disconnected Banner */}
      {!connected && (
        <div className="disconnected-banner">
          <span className="disconnected-icon">⚡</span>
          <span>{reconnecting ? 'Reconnecting...' : 'Disconnected'}</span>
        </div>
      )}

      <header className="app-header" ref={headerRef}>
        <div className="header-left">
          <h1>
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                window.location.reload();
              }}
            >
              Feature Dashboard
            </a>
          </h1>
          <div className="header-commands">
            <button
              className={shellBtnClass('cs')}
              onClick={() => handleShellCommand('cs')}
              title="Switch CCS Profile"
            >
              cs
            </button>
            <button
              className={shellBtnClass('dr')}
              onClick={() => handleShellCommand('dr')}
              title="Restart Dashboard"
            >
              dr
            </button>
            <button
              className={shellBtnClass('upd')}
              onClick={() => handleShellCommand('upd')}
              title="Update CCS"
            >
              upd
            </button>
            <button
              className={slashBtnClass('commit')}
              onClick={() => handleSlashCommand('commit')}
              title="Run /commit"
            >
              /commit
              {healthStatus.gitDirty && healthStatus.gitChangedCount > 0 && (
                <span className="commit-badge">{healthStatus.gitChangedCount}</span>
              )}
            </button>
            <button
              className={slashBtnClass('sync-deps')}
              onClick={() => handleSlashCommand('sync-deps')}
              title="Run /sync-deps"
            >
              /sync-deps
            </button>
            <div
              className={`system-status ${!healthStatus.backend || !connected ? 'has-error' : ''}`}
            >
              <div className="status-indicators">
                <span
                  className={`status-item ${healthStatus.backend === false ? 'error' : ''}`}
                  title="Backend API"
                >
                  BE {healthStatus.backend === null ? '?' : healthStatus.backend ? '●' : '✗'}
                </span>
                <span className={`status-item ${!connected ? 'error' : ''}`} title="WebSocket">
                  WS {connected ? '●' : '✗'}
                </span>
                {healthStatus.proxy && healthStatus.proxy.enabled && (
                  <span
                    className={`status-item ${healthStatus.proxy.status !== 'online' ? 'error' : ''}`}
                    title={`Proxy: ${healthStatus.proxy.url || 'N/A'}`}
                  >
                    PX {healthStatus.proxy.status === 'online' ? '●' : '✗'}
                  </span>
                )}
                {(() => {
                  const cs = healthStatus.claudeStatus;
                  const worst = cs?.worst || 'unknown';
                  const statusClass =
                    worst === 'major_outage'
                      ? 'error'
                      : worst === 'degraded_performance' || worst === 'partial_outage'
                        ? 'warning'
                        : worst === 'under_maintenance'
                          ? 'maintenance'
                          : '';
                  const statusIcon =
                    worst === 'major_outage'
                      ? '✗'
                      : worst === 'degraded_performance' || worst === 'partial_outage'
                        ? '▲'
                        : worst === 'under_maintenance'
                          ? '⚙'
                          : worst === 'operational'
                            ? '●'
                            : '?';
                  const title = cs?.components
                    ? cs.components.map((c) => `${c.name}: ${c.status}`).join('\n')
                    : 'Claude platform status unknown';
                  return (
                    <span className={`status-item ${statusClass}`} title={title}>
                      API {statusIcon}
                    </span>
                  );
                })()}
              </div>
              <div className="rate-limit-group">
                {(healthStatus.ccsProfiles?.length > 0
                  ? healthStatus.ccsProfiles
                  : ccsProfile
                    ? [ccsProfile]
                    : []
                ).map((profile) => {
                  const data = healthStatus.rateLimit?.[profile];
                  const isActive = profile === ccsProfile;
                  const rateClass =
                    data?.weekly?.percent >= 90 || data?.session?.percent >= 90
                      ? 'rate-critical'
                      : data?.weekly?.percent >= 70 || data?.session?.percent >= 70
                        ? 'rate-warning'
                        : '';
                  const weeklyReset =
                    data?.weekly?.percent > 75
                      ? formatResetTime(data?.weekly?.resetsAt || null)
                      : null;
                  const sessionReset =
                    data?.session?.percent > 75
                      ? formatResetTime(data?.session?.resetsAt || null)
                      : null;
                  const tooltip = [
                    isActive ? '● Active' : 'Click to switch',
                    data?.weekly
                      ? `W: ${data.weekly.percent}% (resets ${data.weekly.resetsAt || '?'})`
                      : null,
                    data?.session
                      ? `S: ${data.session.percent}% (resets ${data.session.resetsAt || '?'})`
                      : null,
                  ]
                    .filter(Boolean)
                    .join('\n');
                  const handleProfileClick = () => {
                    if (isActive) return;
                    handleShellCommand('cs', profile);
                  };
                  return (
                    <div
                      key={profile}
                      className={`rate-limit-entry ${rateClass} ${isActive ? 'rate-active' : ''} ${!isActive ? 'rate-clickable' : ''}`}
                      title={tooltip}
                      onClick={handleProfileClick}
                      style={{
                        cursor: isActive ? 'default' : 'pointer',
                      }}
                    >
                      <span className="rate-profile-name">{profile}</span>
                      <span className="rate-values">
                        W:{data?.weekly ? `${data.weekly.percent}%` : '-'} S:
                        {data?.session ? `${data.session.percent}%` : '-'}
                      </span>
                      <span className="rate-reset">
                        {weeklyReset && <>↻W:{weeklyReset}</>}
                        {sessionReset && (
                          <>
                            {weeklyReset ? ' ' : ''}↻S:{sessionReset}
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className={`app-main ${showExecutionPanel ? 'with-panel' : ''}`}>
        <TreeView
          features={features}
          runningFeatures={runningFeatures}
          featurePhases={featurePhases}
          featureSessionIds={featureSessionIds}
          featureContextPercent={featureContextPercent}
          featureStartedAt={featureStartedAt}
          featureLastOutcome={featureLastOutcome}
          featureRunningCommand={featureRunningCommand}
          featureInputWaiting={featureInputWaiting}
          featureRetryInfo={featureRetryInfo}
          featureProfiles={featureProfiles}
          featureQueueWaiters={featureQueueWaiters}
          runLockFeatureId={healthStatus.runLockFeatureId}
          onReleaseLock={handleReleaseLock}
          onRunCommand={handleRunCommand}
          onOpenTerminal={handleOpenTerminal}
          onResumeBrowser={handleResumeBrowserByFeature}
          onResumeTerminal={handleResumeByFeature}
          onInputWaitingClick={handleInputWaitingClick}
          onBulkQueue={handleBulkQueue}
          onCancelQueueItem={handleCancelQueueItem}
          onClearQueue={handleClearQueue}
          onSelect={setSelectedFeatureId}
          onStopExecution={killExecution}
        />
      </main>

      {selectedFeature && (
        <FeatureDetail
          feature={selectedFeature}
          onClose={() => setSelectedFeatureId(null)}
          onRunCommand={handleRunCommand}
          isRunning={runningFeatures.has(String(selectedFeature.id))}
        />
      )}

      {showExecutionPanel && (
        <ExecutionPanel
          executions={executions}
          activeId={activeExecutionId}
          executionStates={executionStates}
          inputRequests={inputRequests}
          projectRoot={healthStatus.projectRoot}
          headerHeight={headerHeight}
          historyEntries={historyEntries}
          historyLoading={historyLoading}
          onSelectExecution={setActiveExecutionId}
          onKill={killExecution}
          onClose={() => setShowExecutionPanel(false)}
          onCloseTab={handleCloseTab}
          onCloseFinishedTabs={handleCloseFinishedTabs}
          onResumeBrowser={handleResumeBrowser}
          onResumeTerminal={handleResumeTerminal}
          onAnswer={handleAnswer}
          onOpenHistory={handleOpenHistory}
        />
      )}

      {!showExecutionPanel && (
        <button className="floating-panel-btn" onClick={() => setShowExecutionPanel(true)}>
          <span className="fpb-icon">&#9654;</span>
          <span className="fpb-label">
            {runningFeatures.size > 0 ? `${runningFeatures.size} running` : 'Executions'}
          </span>
        </button>
      )}
    </div>
  );
}
