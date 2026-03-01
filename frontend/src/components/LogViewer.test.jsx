import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import LogViewer from './LogViewer.jsx';

const LINE_HEIGHT = 20;

function createLog(overrides = {}) {
  return {
    id: 1,
    line: 'test output',
    timestamp: Date.now(),
    level: 'info',
    ...overrides,
  };
}

function createLogs(count) {
  return Array.from({ length: count }, (_, i) =>
    createLog({
      id: i + 1,
      line: `line ${i + 1}`,
    }),
  );
}

describe('LogViewer', () => {
  it('shows "Waiting for output..." when logs is empty', () => {
    const { container } = render(<LogViewer logs={[]} />);
    expect(container.textContent).toContain('Waiting for output...');
  });

  it('renders log entries with timestamp and line text', () => {
    const logs = [
      createLog({ id: 1, line: 'first log', timestamp: new Date('2024-01-01T12:00:00').getTime() }),
      createLog({
        id: 2,
        line: 'second log',
        timestamp: new Date('2024-01-01T12:01:00').getTime(),
      }),
    ];
    const { container } = render(<LogViewer logs={logs} />);
    expect(container.textContent).toContain('first log');
    expect(container.textContent).toContain('second log');
  });

  it('applies log-error class to error-level logs', () => {
    const logs = [createLog({ id: 1, line: 'error message', level: 'error' })];
    const { container } = render(<LogViewer logs={logs} />);
    const logLine = container.querySelector('.log-error');
    expect(logLine).toBeInTheDocument();
    expect(logLine.textContent).toContain('error message');
  });

  it('applies log-input class to input-level logs', () => {
    const logs = [createLog({ id: 1, line: 'input prompt', level: 'input' })];
    const { container } = render(<LogViewer logs={logs} />);
    const logLine = container.querySelector('.log-input');
    expect(logLine).toBeInTheDocument();
    expect(logLine.textContent).toContain('input prompt');
  });

  it('normal logs have no extra class', () => {
    const logs = [createLog({ id: 1, line: 'normal log', level: 'info' })];
    const { container } = render(<LogViewer logs={logs} />);
    const logLine = container.querySelector('.log-line');
    expect(logLine).toBeInTheDocument();
    expect(logLine).not.toHaveClass('log-error');
    expect(logLine).not.toHaveClass('log-input');
  });

  it('renders all log lines without virtual scrolling', () => {
    const logs = createLogs(100);
    const { container } = render(<LogViewer logs={logs} />);
    const logLines = container.querySelectorAll('.log-line');
    // All logs are rendered (no virtualization)
    expect(logLines.length).toBe(100);
  });

  it('has log-viewer container class', () => {
    const logs = createLogs(10);
    const { container } = render(<LogViewer logs={logs} />);
    const viewer = container.querySelector('.log-viewer');
    expect(viewer).toBeInTheDocument();
  });
});
