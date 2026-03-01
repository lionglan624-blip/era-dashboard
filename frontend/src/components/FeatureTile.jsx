import React from 'react';
import StatusBadge from './StatusBadge.jsx';
import ProgressBar from './ProgressBar.jsx';

export default function FeatureTile({ feature, onRunCommand, onSelect, isRunning, isQueued }) {
  const { id, name, status, type, dependsOn, progress } = feature;

  const canRunFC = status === '[DRAFT]' && !isRunning && !isQueued;
  const canRunFL = status === '[PROPOSED]' && !isRunning && !isQueued;
  const canRun = status === '[REVIEWED]' && !isRunning && !isQueued;

  return (
    <div
      className={`feature-tile ${status.replace(/[\[\]]/g, '').toLowerCase()}`}
      onClick={() => onSelect(id)}
    >
      <div className="tile-header">
        <span className="feature-id">F{id}</span>
        <StatusBadge status={status} />
      </div>

      <h3 className="feature-name">{name}</h3>

      {type && <span className="feature-type">{type}</span>}

      {progress && (
        <div className="tile-progress">
          <ProgressBar completed={progress.acs.completed} total={progress.acs.total} label="AC" />
          <ProgressBar
            completed={progress.tasks.completed}
            total={progress.tasks.total}
            label="Tasks"
          />
        </div>
      )}

      {dependsOn && (
        <div className="dependency-chips">
          {dependsOn
            .split(',')
            .filter(Boolean)
            .map((dep) => (
              <span key={dep} className="dep-chip">
                {dep.trim()}
              </span>
            ))}
        </div>
      )}

      <div className="tile-actions">
        {canRunFC && (
          <button
            className="btn-action btn-fc"
            onClick={(e) => {
              e.stopPropagation();
              onRunCommand(id, 'fc');
            }}
          >
            Run FC
          </button>
        )}
        {canRunFL && (
          <button
            className="btn-action btn-fl"
            onClick={(e) => {
              e.stopPropagation();
              onRunCommand(id, 'fl');
            }}
          >
            Run FL
          </button>
        )}
        {canRun && (
          <button
            className="btn-action btn-run"
            onClick={(e) => {
              e.stopPropagation();
              onRunCommand(id, 'run');
            }}
          >
            Run
          </button>
        )}
        {isRunning && <span className="running-indicator">Running...</span>}
        {isQueued && <span className="queued-indicator">Queued</span>}
      </div>
    </div>
  );
}
