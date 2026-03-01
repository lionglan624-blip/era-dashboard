import React, { useEffect, useRef, useCallback, memo } from 'react';

const SCROLL_THRESHOLD = 40; // px from bottom to consider "at bottom"

const LogLine = memo(function LogLine({ entry }) {
  return (
    <div
      className={`log-line ${
        entry.level === 'error' ? 'log-error' : entry.level === 'input' ? 'log-input' : ''
      }`}
    >
      <span className="log-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
      <span className="log-text">{entry.line}</span>
    </div>
  );
});

export default function LogViewer({ logs }) {
  const containerRef = useRef(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
  }, []);

  // Use last entry id (not logs.length) so scroll triggers even when
  // log trimming keeps length constant after push+slice
  const lastLogId = logs.length > 0 ? logs[logs.length - 1].id : null;
  useEffect(() => {
    if (isAtBottomRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lastLogId]);

  return (
    <div className="log-viewer" ref={containerRef} onScroll={handleScroll}>
      {logs.length === 0 ? (
        <div className="log-empty">Waiting for output...</div>
      ) : (
        <>
          {logs.map((entry, index) => (
            <LogLine key={entry.id || index} entry={entry} />
          ))}
        </>
      )}
    </div>
  );
}
