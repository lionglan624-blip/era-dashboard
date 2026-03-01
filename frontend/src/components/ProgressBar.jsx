import React from 'react';

export default function ProgressBar({ completed, total, label }) {
  if (!total) return null;
  const pct = Math.round((completed / total) * 100);

  return (
    <div className="progress-container">
      <div className="progress-label">
        <span>{label}</span>
        <span>
          {completed}/{total}
        </span>
      </div>
      <div className="progress-bar">
        <div
          className="progress-fill"
          style={{
            width: `${pct}%`,
            backgroundColor: pct === 100 ? '#059669' : '#3b82f6',
          }}
        />
      </div>
    </div>
  );
}
