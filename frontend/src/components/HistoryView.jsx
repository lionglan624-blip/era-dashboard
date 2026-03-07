import React, { useState } from 'react';

const STATUS_ICONS = {
  completed: '\u2713',
  failed: '\u2717',
  'handed-off': '\ud83d\udce4',
};

function formatDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt) - new Date(startedAt);
  if (ms < 0) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return `${hr}h${rem}m`;
}

function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function HistoryView({
  entries = [],
  loading = false,
  projectRoot = null,
  onResumeBrowser,
  onResumeTerminal,
}) {
  const [copyFeedback, setCopyFeedback] = useState(null);

  const handleCopyId = (sessionId) => {
    if (!sessionId) return;
    const rootPath = projectRoot || 'C:\\Era\\devkit';
    const command = `cd "${rootPath}" && ccs -r ${sessionId}`;
    navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopyFeedback(sessionId);
        setTimeout(() => setCopyFeedback(null), 1500);
      })
      .catch(() => {});
  };

  if (loading) {
    return (
      <div className="history-list" style={{ padding: '16px', color: 'var(--text-dim)' }}>
        Loading history...
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div
        className="history-list"
        style={{
          padding: '16px',
          color: 'var(--text-muted)',
          textAlign: 'center',
          opacity: 0.6,
        }}
      >
        No execution history
      </div>
    );
  }

  return (
    <div className="history-list">
      {entries.map((entry) => (
        <div key={entry.executionId} className={`history-row history-row-${entry.status}`}>
          <span className={`history-icon history-icon-${entry.status}`}>
            {STATUS_ICONS[entry.status] || '\u2014'}
          </span>
          <span className="history-feature">
            {entry.featureId ? `F${entry.featureId}` : '\u2014'}
          </span>
          <span className="history-command">/{entry.command || 'fl'}</span>
          <span className="history-time">
            {formatTimestamp(entry.completedAt || entry.startedAt)}
          </span>
          <span className="history-duration">
            {formatDuration(entry.startedAt, entry.completedAt) || ''}
          </span>
          <span
            className={`history-ctx ${entry.contextPercent > 80 ? 'high' : entry.contextPercent > 50 ? 'medium' : ''}`}
          >
            {entry.contextPercent != null ? `${entry.contextPercent}%` : ''}
          </span>
          <span className="history-actions">
            {entry.sessionId && (
              <button
                className="btn-copy-id"
                onClick={() => handleCopyId(entry.sessionId)}
                title={`Copy resume command for ${entry.sessionId}`}
              >
                {copyFeedback === entry.sessionId ? 'Copied!' : 'Copy ID'}
              </button>
            )}
            {entry.sessionId && onResumeBrowser && (
              <button className="btn-resume" onClick={() => onResumeBrowser(entry.executionId)}>
                Continue
              </button>
            )}
            {entry.sessionId && onResumeTerminal && (
              <button className="btn-terminal" onClick={() => onResumeTerminal(entry.executionId)}>
                Terminal
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
