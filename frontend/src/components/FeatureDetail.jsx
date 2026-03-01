import React from 'react';
import StatusBadge from './StatusBadge.jsx';
import ProgressBar from './ProgressBar.jsx';

export default function FeatureDetail({ feature, onClose, onRunCommand, isRunning }) {
  if (!feature) return null;

  const {
    id,
    title,
    status,
    type,
    created,
    summary,
    acceptanceCriteria = [],
    tasks = [],
    dependencies = [],
  } = feature;

  const handleCommand = (cmd) => {
    if (onRunCommand) onRunCommand(id, cmd);
    onClose();
  };

  return (
    <div className="feature-detail-overlay" onClick={onClose}>
      <div className="feature-detail" onClick={(e) => e.stopPropagation()}>
        <header className="detail-header">
          <h2>
            F{id}: {title}
          </h2>
          <button className="btn-close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="detail-status-row">
          <div className="detail-badges">
            <StatusBadge status={status} />
            {type && <span className="feature-type">{type}</span>}
            {created && <span className="feature-created">{created}</span>}
          </div>
          <div className="detail-command-buttons">
            <button
              className="btn-detail-cmd btn-fc"
              onClick={() => handleCommand('fc')}
              disabled={isRunning}
            >
              fc
            </button>
            <button
              className="btn-detail-cmd btn-fl"
              onClick={() => handleCommand('fl')}
              disabled={isRunning}
            >
              fl
            </button>
            <button
              className="btn-detail-cmd btn-run"
              onClick={() => handleCommand('run')}
              disabled={isRunning}
            >
              run
            </button>
          </div>
        </div>

        {summary && (
          <section className="detail-section">
            <h3>Summary</h3>
            <p>{summary}</p>
          </section>
        )}

        {acceptanceCriteria.length > 0 && (
          <section className="detail-section">
            <h3>Acceptance Criteria</h3>
            <ProgressBar
              completed={acceptanceCriteria.filter((a) => a.completed).length}
              total={acceptanceCriteria.length}
              label="AC"
            />
            <table className="detail-table">
              <thead>
                <tr>
                  <th>AC#</th>
                  <th>Description</th>
                  <th>Type</th>
                  <th>Matcher</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {acceptanceCriteria.map((ac) => (
                  <tr key={ac.ac} className={ac.completed ? 'row-done' : ''}>
                    <td>{ac.ac}</td>
                    <td>{ac.description}</td>
                    <td>{ac.type}</td>
                    <td>{ac.matcher}</td>
                    <td>{ac.completed ? '✅' : '⬜'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {tasks.length > 0 && (
          <section className="detail-section">
            <h3>Tasks</h3>
            <ProgressBar
              completed={tasks.filter((t) => t.completed).length}
              total={tasks.length}
              label="Tasks"
            />
            <table className="detail-table">
              <thead>
                <tr>
                  <th>Task#</th>
                  <th>AC#</th>
                  <th>Description</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.task} className={t.completed ? 'row-done' : ''}>
                    <td>{t.task}</td>
                    <td>{t.ac}</td>
                    <td>{t.description}</td>
                    <td>{t.completed ? '✅' : '⬜'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {dependencies.length > 0 && (
          <section className="detail-section">
            <h3>Dependencies</h3>
            <table className="detail-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>ID</th>
                  <th>Description</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {dependencies.map((d, i) => (
                  <tr key={i}>
                    <td>{d.type}</td>
                    <td>{d.id}</td>
                    <td>{d.description}</td>
                    <td>{d.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}
