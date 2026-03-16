import React, { useState } from 'react';

export default function QueueIndicator({ queueStatus, onClearQueue, onCancelItem }) {
  const [expanded, setExpanded] = useState(false);

  if (!queueStatus) return null;

  const {
    runningCount,
    queuedCount,
    maxConcurrent: _maxConcurrent,
    chainSlotCount = 0,
    running = [],
    queued = [],
  } = queueStatus;
  const hasActivity = runningCount > 0 || queuedCount > 0;

  if (!hasActivity) return null;

  const slotWaiting = queued.filter((item) => !item.depBlocked);
  const depWaiting = queued.filter((item) => item.depBlocked);

  return (
    <div className="queue-indicator">
      <button className="queue-summary" onClick={() => setExpanded(!expanded)}>
        <span className="queue-running">Running: {runningCount}</span>
        {queuedCount > 0 && <span className="queue-pending">Queued: {queuedCount}</span>}
        {depWaiting.length > 0 && (
          <span className="queue-dep-blocked">Dep Wait: {depWaiting.length}</span>
        )}
        {chainSlotCount > 0 && <span className="queue-reserved">Reserved: {chainSlotCount}</span>}
        <span className="queue-expand">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="queue-dropdown">
          {running.length > 0 && (
            <div className="queue-section">
              <h4>Running</h4>
              {running.map((item) => (
                <div key={item.id} className="queue-item running">
                  <span className="qi-label">F{item.featureId}</span>
                  <span className="qi-command">/{item.command}</span>
                </div>
              ))}
            </div>
          )}

          {slotWaiting.length > 0 && (
            <div className="queue-section">
              <h4>Queued</h4>
              {slotWaiting.map((item) => (
                <div key={item.id} className="queue-item queued">
                  <span className="qi-label">F{item.featureId}</span>
                  <span className="qi-command">/{item.command}</span>
                  <button className="qi-cancel" onClick={() => onCancelItem(item.id)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {depWaiting.length > 0 && (
            <div className="queue-section">
              <h4>Dep Waiting</h4>
              {depWaiting.map((item) => (
                <div key={item.id} className="queue-item dep-blocked">
                  <span className="qi-label">F{item.featureId}</span>
                  <span className="qi-command">/{item.command}</span>
                  {item.pendingDeps && item.pendingDeps.length > 0 && (
                    <span className="qi-deps">
                      waiting: {item.pendingDeps.map((d) => `F${d}`).join(', ')}
                    </span>
                  )}
                  <button className="qi-cancel" onClick={() => onCancelItem(item.id)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {queued.length > 0 && (
            <button className="btn-clear-queue" onClick={onClearQueue}>
              Clear Queue
            </button>
          )}
        </div>
      )}
    </div>
  );
}
