import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App.jsx';

// Mock hooks
vi.mock('./hooks/useFeatures.js', () => ({
  useFeatures: vi.fn(),
  useFeatureDetail: vi.fn(),
}));
vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: vi.fn(),
}));
vi.mock('./hooks/useExecution.js', () => ({
  useExecution: vi.fn(),
}));

// Import mocked hooks
import { useFeatures, useFeatureDetail } from './hooks/useFeatures.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useExecution } from './hooks/useExecution.js';

// Default mock returns
const defaultFeatures = {
  features: [{ id: '100', name: 'Test', status: '[PROPOSED]', pendingDeps: '' }],
  phases: [],
  loading: false,
  error: null,
  refetch: vi.fn(),
};

const defaultExecution = {
  state: {
    executions: new Map(),
    executionStates: new Map(),
    featurePhases: new Map(),
    inputRequests: new Map(),
  },
  dispatch: vi.fn(),
  startCommand: vi.fn(),
  killExecution: vi.fn(),
  addLog: vi.fn(),
  updateStatus: vi.fn(),
  fetchExecutions: vi.fn().mockResolvedValue([]),
};

const defaultWs = {
  connected: true,
  reconnecting: false,
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  send: vi.fn(),
};

describe('App', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    useFeatures.mockReturnValue(defaultFeatures);
    useFeatureDetail.mockReturnValue({ feature: null });
    useWebSocket.mockReturnValue(defaultWs);
    useExecution.mockReturnValue(defaultExecution);
    // Mock fetch for health check
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ claude: { runningCount: 0 }, proxy: null }),
    });
  });

  describe('Loading State', () => {
    it('shows loading state when features loading', () => {
      useFeatures.mockReturnValue({ ...defaultFeatures, loading: true });
      render(<App />);

      expect(screen.getByText('Loading features...')).toBeInTheDocument();
    });
  });

  describe('Error State', () => {
    it('shows error state with retry button when features fail', () => {
      const refetch = vi.fn();
      useFeatures.mockReturnValue({
        ...defaultFeatures,
        loading: false,
        error: 'Failed to load features',
        refetch,
      });
      render(<App />);

      expect(screen.getByText('Error loading features')).toBeInTheDocument();
      expect(screen.getByText('Failed to load features')).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('calls refetch when Retry button clicked', async () => {
      const user = userEvent.setup();
      const refetch = vi.fn();
      useFeatures.mockReturnValue({
        ...defaultFeatures,
        loading: false,
        error: 'Failed to load features',
        refetch,
      });
      render(<App />);

      await user.click(screen.getByText('Retry'));

      expect(refetch).toHaveBeenCalled();
    });
  });

  describe('TreeView Rendering', () => {
    it('renders TreeView with features when loaded', () => {
      render(<App />);

      // TreeView should render the feature
      expect(screen.getByText('Test')).toBeInTheDocument();
    });
  });

  describe('WebSocket Connection', () => {
    it('shows disconnected banner when WebSocket not connected', () => {
      useWebSocket.mockReturnValue({ ...defaultWs, connected: false, reconnecting: false });
      render(<App />);

      expect(screen.getByText('Disconnected')).toBeInTheDocument();
    });

    it('shows reconnecting message when reconnecting', () => {
      useWebSocket.mockReturnValue({ ...defaultWs, connected: false, reconnecting: true });
      render(<App />);

      expect(screen.getByText('Reconnecting...')).toBeInTheDocument();
    });

    it('does not show disconnected banner when connected', () => {
      render(<App />);

      expect(screen.queryByText('Disconnected')).not.toBeInTheDocument();
    });
  });

  describe('Health Status', () => {
    it('shows health status indicators (BE, WS)', async () => {
      render(<App />);

      // Wait for health check to complete
      await waitFor(() => {
        expect(screen.getByText(/BE/)).toBeInTheDocument();
      });

      expect(screen.getByText(/BE ●/)).toBeInTheDocument();
      expect(screen.getByText(/WS ●/)).toBeInTheDocument();
    });

    it('shows error indicator when backend is down', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
      });

      render(<App />);

      await waitFor(() => {
        expect(screen.getByText(/BE ✗/)).toBeInTheDocument();
      });
    });

    it('shows error indicator when WebSocket is disconnected', () => {
      useWebSocket.mockReturnValue({ ...defaultWs, connected: false });
      render(<App />);

      expect(screen.getByText(/WS ✗/)).toBeInTheDocument();
    });
  });

  describe('Command Buttons', () => {
    it('renders shell command buttons (cs, dr)', () => {
      render(<App />);

      expect(screen.getByText('cs')).toBeInTheDocument();
      expect(screen.getByText('dr')).toBeInTheDocument();
    });

    it('renders slash command buttons (/commit, /sync-deps)', () => {
      render(<App />);

      expect(screen.getByText('/commit')).toBeInTheDocument();
      expect(screen.getByText('/sync-deps')).toBeInTheDocument();
    });
  });

  describe('FeatureDetail Modal', () => {
    it('opens FeatureDetail when feature selected', async () => {
      const user = userEvent.setup();
      const mockFeature = { id: '100', name: 'Test Feature', status: '[PROPOSED]' };
      useFeatureDetail.mockImplementation((id) => ({
        feature: id ? mockFeature : null,
      }));

      const { container } = render(<App />);

      // Click ⋮ button to select feature
      const menuBtn = container.querySelector('.btn-tree-menu');
      await user.click(menuBtn);

      // FeatureDetail should open
      await waitFor(() => {
        expect(useFeatureDetail).toHaveBeenCalledWith('100');
      });
    });
  });

  describe('ExecutionPanel', () => {
    it('shows floating button when executions exist but panel is closed', () => {
      const executions = new Map([
        ['exec-1', { id: 'exec-1', status: 'running', logs: [{ line: 'test' }] }],
      ]);
      useExecution.mockReturnValue({
        ...defaultExecution,
        state: { ...defaultExecution.state, executions },
      });

      render(<App />);

      expect(screen.getByText('1 running')).toBeInTheDocument();
    });

    it('does not show floating button when no executions', () => {
      render(<App />);

      expect(screen.queryByText(/running/)).not.toBeInTheDocument();
    });

    it('opens ExecutionPanel when floating button clicked', async () => {
      const user = userEvent.setup();
      const executions = new Map([
        [
          'exec-1',
          {
            id: 'exec-1',
            executionId: 'exec-1',
            featureId: '100',
            command: 'fl',
            status: 'running',
            logs: [{ line: 'test' }],
          },
        ],
      ]);
      useExecution.mockReturnValue({
        ...defaultExecution,
        state: { ...defaultExecution.state, executions },
      });

      render(<App />);

      await user.click(screen.getByText('1 running'));

      // ExecutionPanel should render
      expect(screen.getByText('F100: /fl')).toBeInTheDocument();
    });
  });

  describe('WebSocket Message Handling', () => {
    it('handles log message by calling addLog', () => {
      const addLog = vi.fn();
      useExecution.mockReturnValue({ ...defaultExecution, addLog });

      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      // Simulate WebSocket message
      messageHandler({
        type: 'log',
        executionId: 'exec-1',
        line: 'test log',
        timestamp: Date.now(),
        level: 'info',
      });

      expect(addLog).toHaveBeenCalledWith('exec-1', {
        line: 'test log',
        timestamp: expect.any(Number),
        level: 'info',
      });
    });

    it('handles status message by calling updateStatus', () => {
      const updateStatus = vi.fn();
      const refetch = vi.fn();
      useExecution.mockReturnValue({ ...defaultExecution, updateStatus });
      useFeatures.mockReturnValue({ ...defaultFeatures, refetch });

      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      // Simulate WebSocket message
      messageHandler({
        type: 'status',
        executionId: 'exec-1',
        status: 'completed',
        exitCode: 0,
      });

      expect(updateStatus).toHaveBeenCalledWith('exec-1', 'completed', 0);
    });

    it('handles features-updated message by calling refetch', () => {
      const refetch = vi.fn();
      useFeatures.mockReturnValue({ ...defaultFeatures, refetch });

      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      // Simulate WebSocket message
      messageHandler({ type: 'features-updated' });

      expect(refetch).toHaveBeenCalled();
    });

    it('handles phase-update message by dispatching SET_FEATURE_PHASE', () => {
      const dispatch = vi.fn();
      useExecution.mockReturnValue({ ...defaultExecution, dispatch });

      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      // Simulate WebSocket message
      messageHandler({
        type: 'phase-update',
        featureId: '100',
        phase: 2,
        phaseName: 'Implementation',
      });

      expect(dispatch).toHaveBeenCalledWith({
        type: 'SET_FEATURE_PHASE',
        featureId: '100',
        phase: 2,
        name: 'Implementation',
      });
    });

    it('handles state message by dispatching WS_STATE', () => {
      const dispatch = vi.fn();
      useExecution.mockReturnValue({ ...defaultExecution, dispatch });

      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      const msg = {
        type: 'state',
        executionId: 'exec-1',
        contextPercent: 50,
      };

      // Simulate WebSocket message
      messageHandler(msg);

      expect(dispatch).toHaveBeenCalledWith({
        type: 'WS_STATE',
        msg,
      });
    });

    it('handles input-required message by dispatching WS_INPUT_REQUIRED', () => {
      const dispatch = vi.fn();
      useExecution.mockReturnValue({ ...defaultExecution, dispatch });

      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      const msg = {
        type: 'input-required',
        executionId: 'exec-1',
        questions: [],
      };

      // Simulate WebSocket message
      messageHandler(msg);

      expect(dispatch).toHaveBeenCalledWith({
        type: 'WS_INPUT_REQUIRED',
        msg,
      });
    });

    it('handles stalled message by dispatching WS_STALLED', () => {
      const dispatch = vi.fn();
      useExecution.mockReturnValue({ ...defaultExecution, dispatch });

      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      const msg = {
        type: 'stalled',
        executionId: 'exec-1',
        elapsed: 60000,
      };

      // Simulate WebSocket message
      messageHandler(msg);

      expect(dispatch).toHaveBeenCalledWith({
        type: 'WS_STALLED',
        msg,
      });
    });

    it('handles handoff message by dispatching WS_HANDOFF', () => {
      const dispatch = vi.fn();
      useExecution.mockReturnValue({ ...defaultExecution, dispatch });

      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      const msg = {
        type: 'handoff',
        executionId: 'exec-1',
        reason: 'User input required',
      };

      // Simulate WebSocket message
      messageHandler(msg);

      expect(dispatch).toHaveBeenCalledWith({
        type: 'WS_HANDOFF',
        msg,
      });
    });
  });

  describe('Execution Fetch on Connect', () => {
    it('fetches executions and subscribes when WebSocket connects', async () => {
      const fetchExecutions = vi.fn().mockResolvedValue(['exec-1', 'exec-2']);
      const subscribe = vi.fn();
      useExecution.mockReturnValue({ ...defaultExecution, fetchExecutions });
      useWebSocket.mockReturnValue({ ...defaultWs, subscribe });

      render(<App />);

      await waitFor(() => {
        expect(fetchExecutions).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(subscribe).toHaveBeenCalledWith('exec-1');
        expect(subscribe).toHaveBeenCalledWith('exec-2');
      });
    });
  });

  describe('Health Check Edge Cases', () => {
    it('handles health check network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      render(<App />);

      await waitFor(() => {
        expect(screen.getByText(/BE ✗/)).toBeInTheDocument();
      });
    });

    it('handles health check timeout', async () => {
      global.fetch = vi
        .fn()
        .mockImplementation(
          () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100)),
        );

      render(<App />);

      await waitFor(
        () => {
          expect(screen.getByText(/BE ✗/)).toBeInTheDocument();
        },
        { timeout: 500 },
      );
    });
  });

  describe('WebSocket Message Handling Edge Cases', () => {
    it('ignores unknown message types without error', () => {
      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      // Should not throw for unknown message type
      expect(() => {
        messageHandler({ type: 'unknown-type', data: {} });
      }).not.toThrow();
    });

    it('ignores message without type', () => {
      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      // Should not throw for message without type
      expect(() => {
        messageHandler({ data: 'something' });
      }).not.toThrow();
    });

    it('handles chain-progress message by subscribing to new execution', async () => {
      const subscribe = vi.fn();
      const dispatch = vi.fn();
      useExecution.mockReturnValue({ ...defaultExecution, dispatch });
      useWebSocket.mockReturnValue({ ...defaultWs, subscribe });

      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return { ...defaultWs, subscribe };
      });

      // Mock fetch for the new execution
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'new-exec', status: 'running', logs: [] }),
      });

      render(<App />);

      messageHandler({
        type: 'chain-progress',
        featureId: '100',
        newExecutionId: 'new-exec',
        previousCommand: 'fc',
        nextCommand: 'fl',
      });

      await waitFor(() => {
        expect(subscribe).toHaveBeenCalledWith('new-exec');
      });
    });

    it('handles chain-retry message', async () => {
      const subscribe = vi.fn();
      useWebSocket.mockReturnValue({ ...defaultWs, subscribe });

      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return { ...defaultWs, subscribe };
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'retry-exec', status: 'running', logs: [] }),
      });

      render(<App />);

      messageHandler({
        type: 'chain-retry',
        featureId: '100',
        newExecutionId: 'retry-exec',
        retryCount: 1,
      });

      await waitFor(() => {
        expect(subscribe).toHaveBeenCalledWith('retry-exec');
      });
    });

    it('shows correct command in chain-retry notification title', async () => {
      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      // Test RUN command in title
      messageHandler({
        type: 'chain-retry',
        featureId: '100',
        command: 'run',
        newExecutionId: 'run-retry-exec',
        retryCount: 1,
        maxRetries: 3,
      });

      await waitFor(() => {
        expect(screen.getByText('F100 RUN Retry')).toBeInTheDocument();
      });

      // Test FC command in title
      messageHandler({
        type: 'chain-retry',
        featureId: '200',
        command: 'fc',
        newExecutionId: 'fc-retry-exec',
        retryCount: 2,
        maxRetries: 3,
      });

      await waitFor(() => {
        expect(screen.getByText('F200 FC Retry')).toBeInTheDocument();
      });

      // Test FL command (explicit)
      messageHandler({
        type: 'chain-retry',
        featureId: '300',
        command: 'fl',
        newExecutionId: 'fl-retry-exec',
        retryCount: 1,
        maxRetries: 3,
      });

      await waitFor(() => {
        expect(screen.getByText('F300 FL Retry')).toBeInTheDocument();
      });
    });

    it('defaults to FL when command field is missing in chain-retry', async () => {
      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      // Message without command field (backward compatibility)
      messageHandler({
        type: 'chain-retry',
        featureId: '100',
        newExecutionId: 'retry-exec',
        retryCount: 1,
        maxRetries: 3,
      });

      await waitFor(() => {
        expect(screen.getByText('F100 FL Retry')).toBeInTheDocument();
      });
    });
  });

  describe('Notification Deduplication', () => {
    it('deduplicates rapid identical status-changed notifications', async () => {
      const refetch = vi.fn();
      useFeatures.mockReturnValue({ ...defaultFeatures, refetch });

      let messageHandler;
      useWebSocket.mockImplementation((handler) => {
        messageHandler = handler;
        return defaultWs;
      });

      render(<App />);

      // Send same notification twice rapidly
      const notification = {
        type: 'status-changed',
        featureId: '100',
        oldStatus: '[DRAFT]',
        newStatus: '[PROPOSED]',
      };

      messageHandler(notification);
      messageHandler(notification); // Should be deduplicated

      // Only one notification should appear
      await waitFor(() => {
        const notifications = screen.getAllByText(/F100 Status Changed/);
        expect(notifications.length).toBe(1);
      });
    });
  });

  describe('Execution State Sync', () => {
    it('does not crash when executions change', async () => {
      const executions = new Map([
        [
          'exec-1',
          { id: 'exec-1', featureId: '100', command: 'fc', status: 'completed', logs: [] },
        ],
        ['exec-2', { id: 'exec-2', featureId: '200', command: 'fl', status: 'running', logs: [] }],
      ]);
      useExecution.mockReturnValue({
        ...defaultExecution,
        state: { ...defaultExecution.state, executions },
      });

      const { rerender } = render(<App />);

      // Remove exec-1, exec-2 should become active
      const newExecutions = new Map([
        ['exec-2', { id: 'exec-2', featureId: '200', command: 'fl', status: 'running', logs: [] }],
      ]);
      useExecution.mockReturnValue({
        ...defaultExecution,
        state: { ...defaultExecution.state, executions: newExecutions },
      });

      // Should not crash on rerender with changed executions
      expect(() => rerender(<App />)).not.toThrow();

      // Floating button should still show running count
      expect(screen.getByText('1 running')).toBeInTheDocument();
    });
  });
});
