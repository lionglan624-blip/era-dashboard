import React from 'react';

const STATUS_COLORS = {
  '[DRAFT]': { bg: '#6b7280', text: '#fff' },
  '[PROPOSED]': { bg: '#3b82f6', text: '#fff' },
  '[REVIEWED]': { bg: '#10b981', text: '#fff' },
  '[WIP]': { bg: '#f59e0b', text: '#000' },
  '[BLOCKED]': { bg: '#ef4444', text: '#fff' },
  '[DONE]': { bg: '#059669', text: '#fff' },
  '[CANCELLED]': { bg: '#9ca3af', text: '#fff' },
};

export default function StatusBadge({ status }) {
  const colors = STATUS_COLORS[status] || { bg: '#6b7280', text: '#fff' };
  const label = status.replace(/[\[\]]/g, '');

  return (
    <span
      className="status-badge"
      style={{
        backgroundColor: colors.bg,
        color: colors.text,
      }}
    >
      {label}
    </span>
  );
}
