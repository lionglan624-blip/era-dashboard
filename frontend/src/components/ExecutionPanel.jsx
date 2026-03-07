import React, { useState, useEffect } from 'react';
import LogViewer from './LogViewer.jsx';
import HistoryView from './HistoryView.jsx';

export default function ExecutionPanel({
  executions,
  activeId,
  executionStates = new Map(),
  inputRequests = new Map(),
  projectRoot = null,
  headerHeight = 0,
  historyEntries = [],
  historyLoading = false,
  onSelectExecution,
  onClose,
  onKill,
  onCloseTab,
  onCloseFinishedTabs,
  onResumeBrowser,
  onResumeTerminal,
  onAnswer,
  onOpenHistory,
}) {
  const [copyFeedback, setCopyFeedback] = useState(null);
  const [answerPending, setAnswerPending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Reset answerPending when active execution changes or input state clears
  const activeState = executionStates.get(activeId);
  const activeInputReq = inputRequests.has(activeId);
  useEffect(() => {
    if (answerPending && !activeState?.waitingForInput && !activeInputReq) {
      setAnswerPending(false);
    }
  }, [activeId, activeState?.waitingForInput, activeInputReq, answerPending]);

  const handleCopyResumeCommand = (sessionId) => {
    if (!sessionId) return;
    const rootPath = projectRoot || 'C:\\Era\\devkit'; // Fallback for initial load
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

  const panelStyle = { top: `${headerHeight || 100}px` };

  const handleOpenHistory = () => {
    setShowHistory(true);
    onOpenHistory?.();
  };

  if (visibleExecs.length === 0) {
    return (
      <div className="execution-panel" style={panelStyle}>
        <div className="execution-tabs">
          <button
            className="btn-close-panel"
            onClick={onClose}
            title="Close panel"
            style={{ color: 'var(--text)', fontSize: '24px' }}
          >
            ✕
          </button>
          <span style={{ color: 'var(--text-dim)', fontSize: '12px', padding: '8px 0' }}>
            No executions
          </span>
          <button
            className="btn-history"
            onClick={handleOpenHistory}
            title="View execution history"
          >
            History
          </button>
        </div>
        {showHistory ? (
          <HistoryView
            entries={historyEntries}
            loading={historyLoading}
            projectRoot={projectRoot}
            onResumeBrowser={onResumeBrowser}
            onResumeTerminal={onResumeTerminal}
          />
        ) : (
          <div
            className="log-viewer"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-dim)',
              opacity: 0.4,
              fontSize: '14px',
            }}
          >
            Waiting for execution...
          </div>
        )}
      </div>
    );
  }

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
    if (inputRequests.has(eid) || state.waitingForInput) return '◐';
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
      return { icon: '◐', text: 'Choose an option' };
    }
    if (state.waitingForInput) {
      return { icon: '◐', text: state.waitingInputPattern || 'Waiting for input' };
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
    <div className="execution-panel" style={panelStyle}>
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
              className={`exec-tab ${eid === execId && !showHistory ? 'active' : ''} exec-tab-${exec.status}`}
              onClick={() => {
                setShowHistory(false);
                onSelectExecution(eid);
              }}
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
        <button
          className={`btn-history ${showHistory ? 'active' : ''}`}
          onClick={handleOpenHistory}
          title="View execution history"
        >
          History
        </button>
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
              title={`Copy: cd "${projectRoot || 'C:\\Era\\devkit'}" && ccs -r ${activeExec.sessionId}`}
            >
              {copyFeedback || 'Copy ID'}
            </button>
          )}
          {activeExec.status !== 'running' && activeExec.sessionId && (
            <>
              <button className="btn-resume" onClick={() => onResumeBrowser?.(execId)}>
                Continue
              </button>
              <button className="btn-terminal" onClick={() => onResumeTerminal?.(execId)}>
                Terminal
              </button>
            </>
          )}
          {activeExec.status === 'running' && (
            <button className="btn-kill" onClick={() => onKill(execId)}>
              Stop
            </button>
          )}
        </div>
      </div>

      {execState.waitingForInput && !inputRequest && (
        <div className="terminal-input-panel">
          <div className="panel-header">{execState.waitingInputPattern || 'Input Required'}</div>
          <div className="input-actions">
            <button
              className="btn-answer btn-answer-y"
              disabled={answerPending}
              onClick={() => {
                setAnswerPending(true);
                onAnswer?.(execId, 'y');
              }}
            >
              Yes
            </button>
            <button
              className="btn-answer btn-answer-n"
              disabled={answerPending}
              onClick={() => {
                setAnswerPending(true);
                onAnswer?.(execId, 'n');
              }}
            >
              No
            </button>
            <button
              className="btn-answer-terminal"
              disabled={answerPending}
              onClick={() => onResumeTerminal?.(execId)}
              title="Open in Terminal instead"
            >
              Terminal
            </button>
          </div>
        </div>
      )}

      {inputRequest && (
        <div className="input-request-panel">
          <div className="panel-header">Input Required</div>
          {inputRequest.context && <div className="request-context">{inputRequest.context}</div>}
          {inputRequest.questions?.map((q, i) => (
            <div key={i} className="question-block">
              {q.header && <div className="question-header">{q.header}</div>}
              {q.question && <div className="question-text">{q.question}</div>}
              {q.options && (
                <div className="question-options">
                  {q.options.map((opt, j) => (
                    <button
                      key={j}
                      className="btn-answer-option"
                      disabled={answerPending}
                      onClick={() => {
                        setAnswerPending(true);
                        onAnswer?.(execId, opt.label);
                      }}
                    >
                      <span className="option-label">{opt.label}</span>
                      {opt.description && <span className="option-desc">{opt.description}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="input-actions">
            <button
              className="btn-answer-terminal"
              disabled={answerPending}
              onClick={() => onResumeTerminal?.(execId)}
              title="Open in Terminal instead"
            >
              Terminal
            </button>
          </div>
        </div>
      )}

      {showHistory ? (
        <HistoryView
          entries={historyEntries}
          loading={historyLoading}
          projectRoot={projectRoot}
          onResumeBrowser={onResumeBrowser}
          onResumeTerminal={onResumeTerminal}
        />
      ) : (
        <LogViewer logs={activeExec.logs || []} />
      )}
    </div>
  );
}
