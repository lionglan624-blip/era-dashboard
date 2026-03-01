import React, {
  useMemo,
  useCallback,
  useContext,
  createContext,
  memo,
  useState,
  useEffect,
} from 'react';
import StatusBadge from './StatusBadge.jsx';

// Maximum recursion depth for tree traversal (prevents infinite loops from circular deps)
const MAX_TREE_DEPTH = 10;

// localStorage key for persisting collapsed phase sections
const COLLAPSED_PHASES_KEY = 'dashboard-collapsed-phases';

/** Format elapsed time since start as "Xs", "Xm", "Xh" */
function formatElapsedTime(startTimestamp) {
  if (!startTimestamp) return null;
  // startTimestamp may be ISO string or number
  const startMs =
    typeof startTimestamp === 'string' ? new Date(startTimestamp).getTime() : startTimestamp;
  if (isNaN(startMs)) return null;
  const elapsed = Date.now() - startMs;
  if (elapsed < 0) return '0s';
  if (elapsed < 60000) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m`;
  return `${Math.floor(elapsed / 3600000)}h`;
}

// Split contexts: callbacks (stable) vs data (dynamic) to minimize re-renders
// TreeNode memo can skip re-render when only callbacks context changes (which it shouldn't)
const TreeCallbacksContext = createContext(null);
const TreeDataContext = createContext(null);

/**
 * Build tree structure from features based on dependencies
 * - Root nodes: features with no pending dependencies
 * - Child nodes: features that depend on a parent
 * @param {Array} features - All features
 * @param {Set} runningFeatures - Feature IDs with running sessions
 */
function buildTree(features, runningFeatures) {
  // Filter to active features only (not DONE, not CANCELLED)
  // Exception: keep [DONE] features that still have a running session
  // Note: String(f.id) ensures type match with runningFeatures Set (which uses string IDs)
  const active = features.filter((f) => {
    if (f.status === '[CANCELLED]') return false;
    if (f.status === '[DONE]') {
      // Keep [DONE] features only if they still have a running session
      return runningFeatures.has(String(f.id));
    }
    return true;
  });

  // Build dependency map: childId -> [parentIds]
  const dependsOnMap = new Map();
  for (const f of active) {
    if (f.pendingDeps) {
      const parentIds = f.pendingDeps
        .split(',')
        .map((d) => d.trim().replace(/\D/g, ''))
        .filter(Boolean);
      dependsOnMap.set(f.id, parentIds);
    } else {
      dependsOnMap.set(f.id, []);
    }
  }

  // Build reverse map: parentId -> [childIds]
  const childrenMap = new Map();
  for (const f of active) {
    childrenMap.set(f.id, []);
  }
  for (const [childId, parentIds] of dependsOnMap) {
    for (const parentId of parentIds) {
      if (childrenMap.has(parentId)) {
        childrenMap.get(parentId).push(childId);
      }
    }
  }

  // Find roots: no pending dependencies, sorted by ID ascending
  const roots = active
    .filter((f) => !f.pendingDeps || f.pendingDeps.trim() === '')
    .sort((a, b) => Number(a.id) - Number(b.id));

  // Build tree recursively
  const featureById = new Map(active.map((f) => [f.id, f]));
  const visited = new Set();

  function buildNode(id, depth = 0) {
    // Prevent cycles and handle diamond dependencies.
    // Diamond deps (A→C, B→C): C appears only under the first-visited parent.
    // This is intentional: tree view shows execution order (depth-first), not full DAG.
    // Users can see the actual dependency via the feature's pendingDeps field.
    if (visited.has(id) || depth > MAX_TREE_DEPTH) return null;
    visited.add(id);

    const feature = featureById.get(id);
    if (!feature) return null;

    const childIds = (childrenMap.get(id) || []).slice().sort((a, b) => Number(a) - Number(b));
    const children = childIds.map((cid) => buildNode(cid, depth + 1)).filter(Boolean);

    return { feature, children };
  }

  // Build from roots
  const trees = roots.map((r) => buildNode(r.id)).filter(Boolean);

  // Find orphans (features not reachable from roots due to circular deps)
  const allInTree = new Set(visited);
  const orphans = active
    .filter((f) => !allInTree.has(f.id))
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((f) => ({ feature: f, children: [], isOrphan: true }));

  return [...trees, ...orphans];
}

/**
 * Group tree nodes by phase.
 * Root nodes are grouped by feature.phase; children stay nested under their parent.
 * Returns array of { phase, phaseName, count, nodes } objects, ordered by phase number.
 */
function groupByPhase(trees) {
  const groups = new Map();
  for (const node of trees) {
    const phase = node.feature.phase || 'Other';
    const phaseName = node.feature.phaseName || '';
    if (!groups.has(phase)) {
      groups.set(phase, { phase, phaseName, nodes: [] });
    }
    groups.get(phase).nodes.push(node);
  }

  // Sort by phase number (extract number from "Phase 19")
  return Array.from(groups.values()).sort((a, b) => {
    const numA = parseInt(a.phase.replace(/\D/g, '')) || 999;
    const numB = parseInt(b.phase.replace(/\D/g, '')) || 999;
    return numA - numB;
  });
}

/** Count all features (including nested children) in a tree node */
function countNodes(node) {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}

const PhaseHeader = memo(function PhaseHeader({ phase, phaseName, count, collapsed, onToggle }) {
  return (
    <div className="tree-phase-header" onClick={onToggle}>
      <span className="tree-phase-collapse">{collapsed ? '▶' : '▼'}</span>
      <span className="tree-phase-title">
        {phase}
        {phaseName ? `: ${phaseName}` : ''}
      </span>
      <span className="tree-phase-count">{count}</span>
    </div>
  );
});

const TreeNode = memo(function TreeNode({ node, depth }) {
  const callbacks = useContext(TreeCallbacksContext);
  const data = useContext(TreeDataContext);
  const { feature, children, isOrphan } = node;
  const { id, name, status, pendingDeps, type, progress } = feature;

  // Derive state from data context maps for this feature
  const isRunning = data.runningFeatures?.has(id) || false;

  const currentPhase = data.featurePhases?.get(id);
  const sessionId = data.featureSessionIds?.get(id)?.sessionId;
  const contextPercent = data.featureContextPercent?.get(id);
  const lastActivityTime = data.featureStartedAt?.get(id);
  const lastOutcome = data.featureLastOutcome?.get(id);
  const runningCommand = data.featureRunningCommand?.get(id);
  const isInputWaiting = data.featureInputWaiting?.has(id) || false;

  // Local tick for running nodes only: re-render every second to update "Xs ago" display.
  // Only running TreeNodes pay this cost; non-running nodes skip the interval entirely.
  const [, setLocalTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setLocalTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  const activityAgo = isRunning ? formatElapsedTime(lastActivityTime) : null;

  const canRunFC = status === '[DRAFT]' && !isRunning;
  const canRunFL = status === '[PROPOSED]' && !isRunning;
  const canRun =
    (status === '[REVIEWED]' || status === '[WIP]' || status === '[BLOCKED]') && !isRunning;
  const executableCommand = canRunFC ? 'fc' : canRunFL ? 'fl' : canRun ? 'run' : null;
  const isBlocked = !!pendingDeps;
  // Show Resume button when session is stopped (completed/failed) with sessionId
  // NOT for running - that would create duplicate sessions
  const canResume = !isRunning && sessionId;

  // Determine panel highlight state (mutually exclusive, priority order)
  const stateClass = isInputWaiting
    ? 'state-input-waiting'
    : !isRunning && lastOutcome?.status === 'failed'
      ? 'state-failed'
      : !isRunning && lastOutcome?.status === 'handed-off'
        ? 'state-handed-off'
        : executableCommand && !isRunning && lastOutcome?.status === 'completed'
          ? 'state-step-done'
          : isBlocked
            ? ''
            : executableCommand
              ? 'state-executable'
              : '';

  const handleClick = () => {
    if (executableCommand) {
      callbacks.onTileClick(id, executableCommand);
    }
  };

  return (
    <div className="tree-node">
      <div
        className={`tree-item ${executableCommand ? 'executable' : ''} ${isBlocked ? 'blocked' : ''} ${stateClass} ${isRunning ? 'running' : ''}`}
        onClick={handleClick}
        style={{ marginLeft: depth * 24 }}
      >
        {/* Left: Running label (2-row spanning) or placeholder (root only) */}
        {isRunning ? (
          <div className="tree-running-label">{(runningCommand || 'run').toUpperCase()}</div>
        ) : depth === 0 ? (
          <div className="tree-running-placeholder" />
        ) : null}

        {/* Center: Main content */}
        <div className="tree-item-center">
          <div className="tree-item-row1">
            {(depth > 0 || isOrphan) && (
              <span className="tree-branch">
                {depth > 0 ? '└─ ' : ''}
                {isOrphan ? '⟳ ' : ''}
              </span>
            )}
            <span className="tree-id">F{id}</span>
            <StatusBadge status={status} />
            <span className="tree-type">{type || '\u00A0'}</span>
            <span className="tree-name">{name}</span>
          </div>
          <div className="tree-item-row2">
            {canResume && (
              <button
                className="btn-tree-resume"
                onClick={(e) => {
                  e.stopPropagation();
                  callbacks.onResume(id);
                }}
                title="Resume in Terminal"
              >
                R
              </button>
            )}
            {isRunning ? (
              <>
                <span className="tree-phase">
                  {currentPhase &&
                  currentPhase.command === 'fl' &&
                  currentPhase.iteration !== null &&
                  currentPhase.iteration !== undefined
                    ? `iter${currentPhase.iteration}`
                    : currentPhase &&
                        currentPhase.phase !== null &&
                        currentPhase.phase !== undefined
                      ? `P${currentPhase.phase}${currentPhase.totalPhases ? `/${currentPhase.totalPhases}` : ''}`
                      : '—'}
                </span>
                <span
                  className={`tree-context ${contextPercent > 80 ? 'high' : contextPercent > 50 ? 'medium' : ''}`}
                >
                  {contextPercent != null ? `${contextPercent}%` : '—'}
                </span>
                <span className="tree-elapsed">{activityAgo || '—'}</span>
              </>
            ) : lastOutcome &&
              ['completed', 'failed', 'handed-off'].includes(lastOutcome.status) ? (
              <span className={`tree-outcome tree-outcome-${lastOutcome.status}`}>
                {lastOutcome.status === 'completed' &&
                  `✓ ${(lastOutcome.command || '').toUpperCase()} Done`}
                {lastOutcome.status === 'handed-off' &&
                  `📤 ${(lastOutcome.command || '').toUpperCase()} Terminal`}
                {lastOutcome.status === 'failed' &&
                  `✗ ${(lastOutcome.command || '').toUpperCase()} Failed`}
              </span>
            ) : depth === 0 ? (
              <>
                <span className="tree-phase tree-placeholder">&nbsp;</span>
                <span className="tree-context tree-placeholder">&nbsp;</span>
                <span className="tree-elapsed tree-placeholder">&nbsp;</span>
              </>
            ) : null}
          </div>
        </div>

        {/* Right: Progress section */}
        {progress && (
          <div className="tree-item-progress">
            {progress?.tasks?.total > 0 && (
              <div className="tree-progress-row">
                <span className="tree-progress-label">
                  Tasks {progress.tasks.completed}/{progress.tasks.total}
                </span>
                <div className="tree-progress-bar">
                  <div
                    className="tree-progress-fill"
                    style={{
                      width: `${Math.round((progress.tasks.completed / progress.tasks.total) * 100)}%`,
                      backgroundColor:
                        progress.tasks.completed === progress.tasks.total ? '#059669' : '#3b82f6',
                    }}
                  />
                </div>
              </div>
            )}
            {progress?.acs?.total > 0 && (
              <div className="tree-progress-row">
                <span className="tree-progress-label">
                  AC {progress.acs.completed}/{progress.acs.total}
                </span>
                <div className="tree-progress-bar">
                  <div
                    className="tree-progress-fill"
                    style={{
                      width: `${Math.round((progress.acs.completed / progress.acs.total) * 100)}%`,
                      backgroundColor:
                        progress.acs.completed === progress.acs.total ? '#059669' : '#3b82f6',
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Far right: Menu button */}
        <button
          className="btn-tree-menu"
          onClick={(e) => {
            e.stopPropagation();
            callbacks.onMenuClick(id);
          }}
          title="詳細"
        >
          ⋮
        </button>
      </div>

      {children.length > 0 && (
        <div className="tree-children">
          {children.map((child) => (
            <TreeNode key={child.feature.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
});

export default function TreeView({
  features,
  runningFeatures,
  featurePhases,
  featureSessionIds,
  featureContextPercent,
  featureStartedAt,
  featureLastOutcome,
  featureRunningCommand,
  featureInputWaiting,
  onRunCommand,
  onOpenTerminal,
  onResumeTerminal,
  onSelect,
}) {
  // Note: buildTree returns new objects each time, so TreeNode memo only helps when
  // features ref is stable (within the 2s featureService cache window).
  // Map-based props (phases, context, etc.) are independently memoized in App.
  const trees = useMemo(() => buildTree(features, runningFeatures), [features, runningFeatures]);
  const phaseGroups = useMemo(() => groupByPhase(trees), [trees]);

  // Collapsed phase state, persisted to localStorage
  const [collapsedPhases, setCollapsedPhases] = useState(() => {
    try {
      const saved = localStorage.getItem(COLLAPSED_PHASES_KEY);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  const togglePhase = useCallback((phase) => {
    setCollapsedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phase)) {
        next.delete(phase);
      } else {
        next.add(phase);
      }
      try {
        localStorage.setItem(COLLAPSED_PHASES_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, []);

  const handleTileClick = useCallback(
    (id, command) => {
      onRunCommand(id, command);
    },
    [onRunCommand],
  );

  const handleMenuClick = useCallback(
    (id) => {
      onSelect(id);
    },
    [onSelect],
  );

  const handleResume = useCallback(
    (featureId) => {
      onResumeTerminal(featureId);
    },
    [onResumeTerminal],
  );

  // Split context: callbacks (stable) vs data (dynamic)
  // Callbacks context rarely changes (useCallback deps are stable), so TreeNode memo
  // can often skip re-renders when only data changes trigger re-renders.
  const callbacksValue = useMemo(
    () => ({
      onTileClick: handleTileClick,
      onMenuClick: handleMenuClick,
      onTerminal: onOpenTerminal,
      onResume: handleResume,
    }),
    [handleTileClick, handleMenuClick, onOpenTerminal, handleResume],
  );

  const dataValue = useMemo(
    () => ({
      runningFeatures,
      featurePhases,
      featureSessionIds,
      featureContextPercent,
      featureStartedAt,
      featureLastOutcome,
      featureRunningCommand,
      featureInputWaiting,
    }),
    [
      runningFeatures,
      featurePhases,
      featureSessionIds,
      featureContextPercent,
      featureStartedAt,
      featureLastOutcome,
      featureRunningCommand,
      featureInputWaiting,
    ],
  );

  if (trees.length === 0) {
    return (
      <div className="tree-empty">
        <p>No active features</p>
      </div>
    );
  }

  return (
    <TreeCallbacksContext.Provider value={callbacksValue}>
      <TreeDataContext.Provider value={dataValue}>
        <div className="tree-view">
          {phaseGroups.map((group) => {
            const isCollapsed = collapsedPhases.has(group.phase);
            const totalCount = group.nodes.reduce((sum, n) => sum + countNodes(n), 0);
            return (
              <div key={group.phase} className="tree-phase-section">
                <PhaseHeader
                  phase={group.phase}
                  phaseName={group.phaseName}
                  count={totalCount}
                  collapsed={isCollapsed}
                  onToggle={() => togglePhase(group.phase)}
                />
                {!isCollapsed && (
                  <div className="tree-phase-body">
                    {group.nodes.map((tree) => (
                      <TreeNode key={tree.feature.id} node={tree} depth={0} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </TreeDataContext.Provider>
    </TreeCallbacksContext.Provider>
  );
}
