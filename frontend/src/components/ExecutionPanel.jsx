import React, { useState } from 'react';
import LogViewer from './LogViewer.jsx';

export default function ExecutionPanel({
  executions,
  activeId,
  executionStates = new Map(),
  inputRequests = new Map(),
  projectRoot = null,
  onSelectExecution,
  onClose,
  onKill,
  onCloseTab,
  onCloseFinishedTabs,
  onResumeTerminal,
}) {
  const [copyFeedback, setCopyFeedback] = useState(null);

  const handleCopyResumeCommand = (sessionId) => {
    if (!sessionId) return;
    const rootPath = projectRoot || 'C:\\Era\\erakoumakanNTR'; // Fallback for initial load
    const command = `cd "${rootPath}" && ccs -r ${sessionId}`;
    navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopyFeedback('Copied!');
        setTimeout(() => setCopyFeedback(null), 1500);
      })
      .catch(() => {
        setCopyFeedback('Failed');
        setTimeout(() => setCopyFeedback(null), 1500);
      });
  };

  const visibleExecs = Array.from(executions.values())
    .filter((e) => e.logs?.length > 0 || e.status === 'running' || e.status === 'handed-off')
    .sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      return (b.logs?.length || 0) - (a.logs?.length || 0);
    });

  if (visibleExecs.length === 0) return null;

  const activeExec = executions.get(activeId) || visibleExecs[0];
  if (!activeExec) return null;

  const execId = activeExec.executionId || activeExec.id;
  const execState = executionStates.get(execId) || {};
  const inputRequest = inputRequests.get(execId);

  // Helper: get tab icon
  const getTabIcon = (exec) => {
    const eid = exec.executionId || exec.id;
    const state = executionStates.get(eid) || {};

    // Priority: input > stalled > status
    if (inputRequests.has(eid)) return '◐';
    if (state.taskDepth > 0) return '⧖';
    if (state.isStalled) return '⏸';

    if (exec.status === 'running') return '●';
    if (exec.status === 'completed') return '✓';
    if (exec.status === 'failed') return '✗';
    if (exec.status === 'handed-off') return '📤';
    return '—';
  };

  // Helper: get status bar content
  const getStatusBar = () => {
    const state = execState;

    // Priority: input > stalled > handed-off > status
    if (inputRequest) {
      return { icon: '◐', text: 'Waiting for input' };
    }
    if (state.taskDepth > 0) {
      return { icon: '⧖', text: `Subagent running (depth=${state.taskDepth})` };
    }
    if (state.isStalled) {
      return { icon: '⏸', text: 'Stalled - no output' };
    }
    if (activeExec.status === 'handed-off') {
      const cmd = (activeExec.command || 'fl').toUpperCase();
      return { icon: '📤', text: `${cmd} → Terminal` };
    }
    if (activeExec.status === 'running') {
      return { icon: '●', text: 'Running' };
    }
    if (activeExec.status === 'completed') {
      const cmd = (activeExec.command || 'fl').toUpperCase();
      return { icon: '✓', text: `${cmd} Done` };
    }
    if (activeExec.status === 'failed') {
      const cmd = (activeExec.command || 'fl').toUpperCase();
      return { icon: '✗', text: `${cmd} Failed` };
    }
    return { icon: '—', text: activeExec.status };
  };

  const statusBar = getStatusBar();
  const hasFinishedTabs = visibleExecs.some(
    (e) => e.status === 'completed' || e.status === 'failed' || e.status === 'handed-off',
  );

  return (
    <div className="execution-panel">
      <div className="execution-tabs">
        <button className="btn-close-panel" onClick={onClose} title="Close panel">
          ✕
        </button>
        {hasFinishedTabs && (
          <button
            className="btn-close-finished-tabs"
            onClick={() => onCloseFinishedTabs?.()}
            title="Close completed/failed tabs"
          >
            Clear
          </button>
        )}
        {visibleExecs.map((exec) => {
          const eid = exec.executionId || exec.id;
          return (
            <div
              key={eid}
              className={`exec-tab ${eid === execId ? 'active' : ''} exec-tab-${exec.status}`}
              onClick={() => onSelectExecution(eid)}
            >
              <span className="tab-label">
                <span>F{exec.featureId}</span>
                <span className="tab-command">/{exec.command || 'fl'}</span>
              </span>
              <span className={`tab-status tab-${exec.status}`}>{getTabIcon(exec)}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab?.(eid);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="execution-header">
        <div className="exec-header-info">
          <h3>
            F{activeExec.featureId}: /{activeExec.command || 'fl'}
          </h3>
          <span className="status-inline">
            <span>{statusBar.icon}</span>
            <span>{statusBar.text}</span>
          </span>
          {execState.contextPercent != null && (
            <span className={`context-percent ${execState.contextPercent > 80 ? 'high' : ''}`}>
              {execState.contextPercent}%
            </span>
          )}
          {activeExec.sessionId && (
            <button
              className="btn-copy-id"
              onClick={() => handleCopyResumeCommand(activeExec.sessionId)}
              title={`Copy: cd "${projectRoot || 'C:\\Era\\erakoumakanNTR'}" && ccs -r ${activeExec.sessionId}`}
            >
              {copyFeedback || 'Copy ID'}
            </button>
          )}
          {activeExec.status !== 'running' && activeExec.sessionId && (
            <button className="btn-resume" onClick={() => onResumeTerminal?.(execId)}>
              Resume
            </button>
          )}
          {activeExec.status === 'running' && (
            <button className="btn-kill" onClick={() => onKill(execId)}>
              Stop
            </button>
          )}
        </div>
      </div>

      {execState.waitingForInput && (
        <div className="terminal-input-panel">
          <div className="panel-header">Terminal Input Required</div>
          <div className="input-pattern">{execState.waitingInputPattern}</div>
        </div>
      )}

      {inputRequest && (
        <div className="input-request-panel">
          <div className="panel-header">AskUserQuestion detected (handed off to Terminal):</div>
          {inputRequest.context && <div className="request-context">{inputRequest.context}</div>}
          {inputRequest.questions?.map((q, i) => (
            <div key={i} className="question-block">
              {q.header && <div className="question-header">{q.header}</div>}
              {q.question && <div className="question-text">{q.question}</div>}
              {q.options && (
                <div className="question-options">
                  {q.options.map((opt, j) => (
                    <div key={j} className="option">
                      <span className="option-label">{opt.label}</span>
                      {opt.description && <span className="option-desc">{opt.description}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <LogViewer logs={activeExec.logs || []} />
    </div>
  );
}
