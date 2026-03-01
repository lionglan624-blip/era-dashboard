import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ExecutionPanel from './ExecutionPanel.jsx';

// Factory: Execution
function createExecution(overrides = {}) {
  return {
    id: 'exec-1',
    executionId: 'exec-1',
    featureId: '100',
    command: 'fl',
    status: 'running',
    logs: [],
    sessionId: null,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Factory: ExecutionPanel props
function createPanelProps(executions = new Map(), overrides = {}) {
  return {
    executions,
    activeId: executions.keys().next().value || null,
    executionStates: new Map(),
    inputRequests: new Map(),
    onSelectExecution: vi.fn(),
    onKill: vi.fn(),
    onClose: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseFinishedTabs: vi.fn(),
    onResumeTerminal: vi.fn(),
    ...overrides,
  };
}

describe('ExecutionPanel', () => {
  describe('Rendering - Visibility', () => {
    it('returns null when no visible executions (empty map)', () => {
      const props = createPanelProps(new Map());
      const { container } = render(<ExecutionPanel {...props} />);
      expect(container.firstChild).toBeNull();
    });

    it('returns null when all executions have no logs and are not running', () => {
      const executions = new Map([['exec-1', createExecution({ status: 'completed', logs: [] })]]);
      const props = createPanelProps(executions);
      const { container } = render(<ExecutionPanel {...props} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders when execution has logs', () => {
      const executions = new Map([
        [
          'exec-1',
          createExecution({ status: 'completed', logs: [{ line: 'test', timestamp: Date.now() }] }),
        ],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.getByText('F100: /fl')).toBeInTheDocument();
    });

    it('renders when execution is running', () => {
      const executions = new Map([['exec-1', createExecution({ status: 'running', logs: [] })]]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.getByText('F100: /fl')).toBeInTheDocument();
    });

    it('renders when execution is handed-off', () => {
      const executions = new Map([['exec-1', createExecution({ status: 'handed-off', logs: [] })]]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.getByText('F100: /fl')).toBeInTheDocument();
    });
  });

  describe('Tabs', () => {
    it('renders tabs for visible executions', () => {
      const executions = new Map([
        ['exec-1', createExecution({ featureId: '100', command: 'fl', status: 'running' })],
        [
          'exec-2',
          createExecution({
            id: 'exec-2',
            executionId: 'exec-2',
            featureId: '101',
            command: 'run',
            status: 'running',
          }),
        ],
      ]);
      const props = createPanelProps(executions);
      const { container } = render(<ExecutionPanel {...props} />);

      const tabs = container.querySelectorAll('.exec-tab');
      expect(tabs).toHaveLength(2);
    });

    it('tab shows feature ID and command', () => {
      const executions = new Map([
        ['exec-1', createExecution({ featureId: '100', command: 'fl', status: 'running' })],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.getByText('F100')).toBeInTheDocument();
      expect(screen.getByText('/fl')).toBeInTheDocument();
    });

    it('tab shows ● icon for running execution', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      const { container } = render(<ExecutionPanel {...props} />);

      const tabStatus = container.querySelector('.tab-status');
      expect(tabStatus).toHaveTextContent('●');
    });

    it('tab shows ◐ icon when waiting for input', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const inputRequests = new Map([['exec-1', { questions: [] }]]);
      const props = createPanelProps(executions, { inputRequests });
      const { container } = render(<ExecutionPanel {...props} />);

      const tabStatus = container.querySelector('.tab-status');
      expect(tabStatus).toHaveTextContent('◐');
    });

    it('tab shows ⏸ icon when stalled', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const executionStates = new Map([['exec-1', { isStalled: true }]]);
      const props = createPanelProps(executions, { executionStates });
      const { container } = render(<ExecutionPanel {...props} />);

      const tabStatus = container.querySelector('.tab-status');
      expect(tabStatus).toHaveTextContent('⏸');
    });

    it('tab shows ✓ icon for completed execution', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'completed', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      const { container } = render(<ExecutionPanel {...props} />);

      const tabStatus = container.querySelector('.tab-status');
      expect(tabStatus).toHaveTextContent('✓');
    });

    it('tab shows ✗ icon for failed execution', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'failed', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      const { container } = render(<ExecutionPanel {...props} />);

      const tabStatus = container.querySelector('.tab-status');
      expect(tabStatus).toHaveTextContent('✗');
    });

    it('tab shows 📤 icon for handed-off execution', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'handed-off', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      const { container } = render(<ExecutionPanel {...props} />);

      const tabStatus = container.querySelector('.tab-status');
      expect(tabStatus).toHaveTextContent('📤');
    });

    it('active tab has "active" class', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running' })],
        ['exec-2', createExecution({ id: 'exec-2', executionId: 'exec-2', status: 'running' })],
      ]);
      const props = createPanelProps(executions, { activeId: 'exec-1' });
      const { container } = render(<ExecutionPanel {...props} />);

      const activeTabs = container.querySelectorAll('.exec-tab.active');
      expect(activeTabs).toHaveLength(1);
      expect(activeTabs[0]).toHaveClass('active');
    });
  });

  describe('Status Bar', () => {
    it('shows status bar with correct icon and text for running', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      const { container } = render(<ExecutionPanel {...props} />);

      const statusBar = container.querySelector('.status-inline');
      expect(within(statusBar).getByText('●')).toBeInTheDocument();
      expect(within(statusBar).getByText('Running')).toBeInTheDocument();
    });

    it('shows status bar for completed execution', () => {
      const executions = new Map([
        [
          'exec-1',
          createExecution({ status: 'completed', command: 'fl', logs: [{ line: 'test' }] }),
        ],
      ]);
      const props = createPanelProps(executions);
      const { container } = render(<ExecutionPanel {...props} />);

      const statusBar = container.querySelector('.status-inline');
      expect(within(statusBar).getByText('✓')).toBeInTheDocument();
      expect(within(statusBar).getByText('FL Done')).toBeInTheDocument();
    });

    it('shows status bar for failed execution', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'failed', command: 'run', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      const { container } = render(<ExecutionPanel {...props} />);

      const statusBar = container.querySelector('.status-inline');
      expect(within(statusBar).getByText('✗')).toBeInTheDocument();
      expect(within(statusBar).getByText('RUN Failed')).toBeInTheDocument();
    });

    it('shows status bar for handed-off execution', () => {
      const executions = new Map([
        [
          'exec-1',
          createExecution({ status: 'handed-off', command: 'fc', logs: [{ line: 'test' }] }),
        ],
      ]);
      const props = createPanelProps(executions);
      const { container } = render(<ExecutionPanel {...props} />);

      const statusBar = container.querySelector('.status-inline');
      expect(within(statusBar).getByText('📤')).toBeInTheDocument();
      expect(within(statusBar).getByText('FC → Terminal')).toBeInTheDocument();
    });

    it('shows status bar for stalled execution', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const executionStates = new Map([['exec-1', { isStalled: true }]]);
      const props = createPanelProps(executions, { executionStates });
      const { container } = render(<ExecutionPanel {...props} />);

      const statusBar = container.querySelector('.status-inline');
      expect(within(statusBar).getByText('⏸')).toBeInTheDocument();
      expect(within(statusBar).getByText('Stalled - no output')).toBeInTheDocument();
    });

    it('shows context percent with warning class when >80%', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const executionStates = new Map([['exec-1', { contextPercent: 85 }]]);
      const props = createPanelProps(executions, { executionStates });
      render(<ExecutionPanel {...props} />);

      const contextSpan = screen.getByText('85%');
      expect(contextSpan).toHaveClass('high');
    });

    it('shows context percent without warning when ≤80%', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const executionStates = new Map([['exec-1', { contextPercent: 50 }]]);
      const props = createPanelProps(executions, { executionStates });
      render(<ExecutionPanel {...props} />);

      expect(screen.getByText('50%')).toBeInTheDocument();
    });
  });

  describe('Action Buttons', () => {
    it('shows Stop button when running', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.getByText('Stop')).toBeInTheDocument();
    });

    it('does not show Stop button when not running', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'completed', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.queryByText('Stop')).not.toBeInTheDocument();
    });

    it('shows Resume button when stopped with sessionId', () => {
      const executions = new Map([
        [
          'exec-1',
          createExecution({
            status: 'completed',
            sessionId: 'session-1',
            logs: [{ line: 'test' }],
          }),
        ],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.getByText('Resume')).toBeInTheDocument();
    });

    it('does not show Resume button when running', () => {
      const executions = new Map([
        [
          'exec-1',
          createExecution({ status: 'running', sessionId: 'session-1', logs: [{ line: 'test' }] }),
        ],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.queryByText('Resume')).not.toBeInTheDocument();
    });

    it('does not show Resume button when no sessionId', () => {
      const executions = new Map([
        [
          'exec-1',
          createExecution({ status: 'completed', sessionId: null, logs: [{ line: 'test' }] }),
        ],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.queryByText('Resume')).not.toBeInTheDocument();
    });

    it('shows Clear button when finished tabs exist', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'completed', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.getByText('Clear')).toBeInTheDocument();
    });

    it('does not show Clear button when no finished tabs', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.queryByText('Clear')).not.toBeInTheDocument();
    });
  });

  describe('User Interactions', () => {
    it('calls onKill when Stop clicked', async () => {
      const user = userEvent.setup();
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const onKill = vi.fn();
      const props = createPanelProps(executions, { onKill });
      render(<ExecutionPanel {...props} />);

      await user.click(screen.getByText('Stop'));

      expect(onKill).toHaveBeenCalledWith('exec-1');
    });

    it('calls onSelectExecution when tab clicked', async () => {
      const user = userEvent.setup();
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running' })],
        ['exec-2', createExecution({ id: 'exec-2', executionId: 'exec-2', status: 'running' })],
      ]);
      const onSelectExecution = vi.fn();
      const props = createPanelProps(executions, { onSelectExecution, activeId: 'exec-1' });
      const { container } = render(<ExecutionPanel {...props} />);

      const tabs = container.querySelectorAll('.exec-tab');
      await user.click(tabs[1]);

      expect(onSelectExecution).toHaveBeenCalledWith('exec-2');
    });

    it('calls onCloseTab when tab × clicked', async () => {
      const user = userEvent.setup();
      const executions = new Map([['exec-1', createExecution({ status: 'running' })]]);
      const onCloseTab = vi.fn();
      const props = createPanelProps(executions, { onCloseTab });
      const { container } = render(<ExecutionPanel {...props} />);

      const closeBtn = container.querySelector('.tab-close');
      await user.click(closeBtn);

      expect(onCloseTab).toHaveBeenCalledWith('exec-1');
    });

    it('calls onClose when Close button clicked', async () => {
      const user = userEvent.setup();
      const executions = new Map([['exec-1', createExecution({ status: 'running' })]]);
      const onClose = vi.fn();
      const props = createPanelProps(executions, { onClose });
      render(<ExecutionPanel {...props} />);

      await user.click(screen.getByTitle('Close panel'));

      expect(onClose).toHaveBeenCalled();
    });

    it('calls onCloseFinishedTabs when Clear clicked', async () => {
      const user = userEvent.setup();
      const executions = new Map([
        ['exec-1', createExecution({ status: 'completed', logs: [{ line: 'test' }] })],
      ]);
      const onCloseFinishedTabs = vi.fn();
      const props = createPanelProps(executions, { onCloseFinishedTabs });
      render(<ExecutionPanel {...props} />);

      await user.click(screen.getByText('Clear'));

      expect(onCloseFinishedTabs).toHaveBeenCalled();
    });

    it('calls onResumeTerminal when Resume button clicked', async () => {
      const user = userEvent.setup();
      const executions = new Map([
        [
          'exec-1',
          createExecution({
            status: 'completed',
            sessionId: 'session-1',
            logs: [{ line: 'test' }],
          }),
        ],
      ]);
      const onResumeTerminal = vi.fn();
      const props = createPanelProps(executions, { onResumeTerminal });
      render(<ExecutionPanel {...props} />);

      await user.click(screen.getByText('Resume'));

      expect(onResumeTerminal).toHaveBeenCalledWith('exec-1');
    });
  });

  describe('Terminal Input Panel', () => {
    it('shows terminal input panel when waitingForTerminalInput', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const executionStates = new Map([
        ['exec-1', { waitingForInput: true, waitingInputPattern: 'y/n' }],
      ]);
      const props = createPanelProps(executions, { executionStates });
      render(<ExecutionPanel {...props} />);

      expect(screen.getByText('Terminal Input Required')).toBeInTheDocument();
      expect(screen.getByText('y/n')).toBeInTheDocument();
    });

    it('does not show terminal input panel when not waiting for input', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(screen.queryByText('Terminal Input Required')).not.toBeInTheDocument();
    });
  });

  describe('Input Request Panel', () => {
    it('shows input request panel when inputRequest present', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const inputRequests = new Map([
        [
          'exec-1',
          {
            context: 'Please answer the following question',
            questions: [
              {
                header: 'Option',
                question: 'Choose one',
                options: [
                  { label: 'A', description: 'First option' },
                  { label: 'B', description: 'Second option' },
                ],
              },
            ],
          },
        ],
      ]);
      const props = createPanelProps(executions, { inputRequests });
      render(<ExecutionPanel {...props} />);

      expect(
        screen.getByText('AskUserQuestion detected (handed off to Terminal):'),
      ).toBeInTheDocument();
      expect(screen.getByText('Please answer the following question')).toBeInTheDocument();
      expect(screen.getByText('Choose one')).toBeInTheDocument();
      expect(screen.getByText('A')).toBeInTheDocument();
      expect(screen.getByText('First option')).toBeInTheDocument();
    });

    it('does not show input request panel when no inputRequest', () => {
      const executions = new Map([
        ['exec-1', createExecution({ status: 'running', logs: [{ line: 'test' }] })],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      expect(
        screen.queryByText('AskUserQuestion detected (handed off to Terminal):'),
      ).not.toBeInTheDocument();
    });
  });

  describe('LogViewer Integration', () => {
    it('renders LogViewer with logs', () => {
      const executions = new Map([
        [
          'exec-1',
          createExecution({
            status: 'running',
            logs: [
              { line: 'Starting execution', timestamp: Date.now(), level: 'info' },
              { line: 'Processing...', timestamp: Date.now() + 1000, level: 'info' },
            ],
          }),
        ],
      ]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      // LogViewer renders logs
      expect(screen.getByText('Starting execution')).toBeInTheDocument();
      expect(screen.getByText('Processing...')).toBeInTheDocument();
    });

    it('renders LogViewer with empty logs', () => {
      const executions = new Map([['exec-1', createExecution({ status: 'running', logs: [] })]]);
      const props = createPanelProps(executions);
      render(<ExecutionPanel {...props} />);

      // LogViewer shows "Waiting for output..." for empty logs
      expect(screen.getByText('Waiting for output...')).toBeInTheDocument();
    });
  });
});
