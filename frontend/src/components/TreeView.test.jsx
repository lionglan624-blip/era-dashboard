import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TreeView from './TreeView.jsx';

// Factory: Feature
function createFeature(overrides = {}) {
  return {
    id: '100',
    name: 'Test Feature',
    status: '[PROPOSED]',
    pendingDeps: '',
    type: 'kojo',
    progress: null,
    ...overrides,
  };
}

// Factory: TreeView props
function createTreeProps(features = [], overrides = {}) {
  return {
    features,
    runningFeatures: new Set(),
    featurePhases: new Map(),
    featureSessionIds: new Map(),
    featureContextPercent: new Map(),
    featureStartedAt: new Map(),
    featureLastOutcome: new Map(),
    featureRunningCommand: new Map(),
    featureInputWaiting: new Set(),
    onRunCommand: vi.fn(),
    onOpenTerminal: vi.fn(),
    onResumeTerminal: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
}

describe('TreeView', () => {
  describe('Rendering - Empty State', () => {
    it('renders "No active features" when features array is empty', () => {
      const props = createTreeProps([]);
      render(<TreeView {...props} />);
      expect(screen.getByText('No active features')).toBeInTheDocument();
    });

    it('renders "No active features" when all features are [DONE] and not running', () => {
      const features = [
        createFeature({ id: '100', status: '[DONE]' }),
        createFeature({ id: '101', status: '[DONE]' }),
      ];
      const props = createTreeProps(features);
      render(<TreeView {...props} />);
      expect(screen.getByText('No active features')).toBeInTheDocument();
    });

    it('keeps [DONE] feature visible when session is still running', () => {
      const features = [
        createFeature({ id: '100', name: 'Still Running', status: '[DONE]' }),
        createFeature({ id: '101', name: 'Already Done', status: '[DONE]' }),
      ];
      const runningFeatures = new Set(['100']);
      const props = createTreeProps(features, { runningFeatures });
      render(<TreeView {...props} />);

      // Feature 100 should be visible (still running)
      expect(screen.getByText('Still Running')).toBeInTheDocument();
      // Feature 101 should be filtered out (session completed)
      expect(screen.queryByText('Already Done')).not.toBeInTheDocument();
    });

    it('renders "No active features" when all features are [CANCELLED]', () => {
      const features = [createFeature({ id: '100', status: '[CANCELLED]' })];
      const props = createTreeProps(features);
      render(<TreeView {...props} />);
      expect(screen.getByText('No active features')).toBeInTheDocument();
    });
  });

  describe('Rendering - Tree Structure', () => {
    it('renders root features (no pendingDeps) as tree nodes', () => {
      const features = [
        createFeature({ id: '100', name: 'Root Feature' }),
        createFeature({ id: '101', name: 'Another Root' }),
      ];
      const props = createTreeProps(features);
      render(<TreeView {...props} />);

      expect(screen.getByText('Root Feature')).toBeInTheDocument();
      expect(screen.getByText('Another Root')).toBeInTheDocument();
    });

    it('shows feature ID (F{id})', () => {
      const features = [createFeature({ id: '100' })];
      const props = createTreeProps(features);
      render(<TreeView {...props} />);

      expect(screen.getByText('F100')).toBeInTheDocument();
    });

    it('shows feature name', () => {
      const features = [createFeature({ name: 'My Feature' })];
      const props = createTreeProps(features);
      render(<TreeView {...props} />);

      expect(screen.getByText('My Feature')).toBeInTheDocument();
    });

    it('renders StatusBadge', () => {
      const features = [createFeature({ status: '[PROPOSED]' })];
      const props = createTreeProps(features);
      const { container } = render(<TreeView {...props} />);

      // StatusBadge component renders the status
      const badge = container.querySelector('.status-badge');
      expect(badge).toBeInTheDocument();
    });

    it('renders children indented (depth > 0 shows └─ prefix)', () => {
      const features = [
        createFeature({ id: '100', name: 'Parent' }),
        createFeature({ id: '101', name: 'Child', pendingDeps: 'F100' }),
      ];
      const props = createTreeProps(features);
      const { container } = render(<TreeView {...props} />);

      // Child node should have tree-branch with └─ prefix
      const childNode = screen.getByText('Child').closest('.tree-node');
      const branchSpan = childNode.querySelector('.tree-branch');
      expect(branchSpan).toHaveTextContent('└─');
    });

    it('filters out [DONE] features when not running', () => {
      const features = [
        createFeature({ id: '100', name: 'Active', status: '[PROPOSED]' }),
        createFeature({ id: '101', name: 'Done', status: '[DONE]' }),
      ];
      const props = createTreeProps(features);
      render(<TreeView {...props} />);

      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.queryByText('Done')).not.toBeInTheDocument();
    });

    it('filters out [CANCELLED] features', () => {
      const features = [
        createFeature({ id: '100', name: 'Active', status: '[PROPOSED]' }),
        createFeature({ id: '101', name: 'Cancelled', status: '[CANCELLED]' }),
      ];
      const props = createTreeProps(features);
      render(<TreeView {...props} />);

      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();
    });

    it('shows orphan features with ⟳ prefix (features with circular deps)', () => {
      // Create circular dependency: 100→101, 101→100
      const features = [
        createFeature({ id: '100', pendingDeps: 'F101' }),
        createFeature({ id: '101', pendingDeps: 'F100' }),
      ];
      const props = createTreeProps(features);
      const { container } = render(<TreeView {...props} />);

      // Both nodes should be orphans with ⟳ prefix
      const branchSpans = container.querySelectorAll('.tree-branch');
      const hasOrphanPrefix = Array.from(branchSpans).some((span) =>
        span.textContent.includes('⟳'),
      );
      expect(hasOrphanPrefix).toBe(true);
    });
  });

  describe('Executable States', () => {
    it('marks tile as executable for [DRAFT] features', () => {
      const features = [createFeature({ status: '[DRAFT]' })];
      const props = createTreeProps(features);
      const { container } = render(<TreeView {...props} />);

      const tile = container.querySelector('.tree-item');
      expect(tile).toHaveClass('executable');
    });

    it('marks tile as executable for [PROPOSED] features', () => {
      const features = [createFeature({ status: '[PROPOSED]' })];
      const props = createTreeProps(features);
      const { container } = render(<TreeView {...props} />);

      const tile = container.querySelector('.tree-item');
      expect(tile).toHaveClass('executable');
    });

    it('marks tile as executable for [REVIEWED] features', () => {
      const features = [createFeature({ status: '[REVIEWED]' })];
      const props = createTreeProps(features);
      const { container } = render(<TreeView {...props} />);

      const tile = container.querySelector('.tree-item');
      expect(tile).toHaveClass('executable');
    });

    it('marks tile as executable for [WIP] features', () => {
      const features = [createFeature({ status: '[WIP]' })];
      const props = createTreeProps(features);
      const { container } = render(<TreeView {...props} />);

      const tile = container.querySelector('.tree-item');
      expect(tile).toHaveClass('executable');
    });

    it('marks tile as executable for [BLOCKED] features', () => {
      const features = [createFeature({ status: '[BLOCKED]' })];
      const props = createTreeProps(features);
      const { container } = render(<TreeView {...props} />);

      const tile = container.querySelector('.tree-item');
      expect(tile).toHaveClass('executable');
    });

    it('does not mark tile as executable when feature is running', () => {
      const features = [createFeature({ id: '100', status: '[PROPOSED]' })];
      const runningFeatures = new Set(['100']);
      const props = createTreeProps(features, { runningFeatures });
      const { container } = render(<TreeView {...props} />);

      const tile = container.querySelector('.tree-item');
      expect(tile).not.toHaveClass('executable');
    });
  });

  describe('Buttons', () => {
    it('shows Resume (R) button when feature has sessionId and is not running', () => {
      const features = [createFeature({ id: '100' })];
      const featureSessionIds = new Map([
        ['100', { executionId: 'exec-1', sessionId: 'session-1' }],
      ]);
      const props = createTreeProps(features, { featureSessionIds });
      const { container } = render(<TreeView {...props} />);

      const resumeBtn = container.querySelector('.btn-tree-resume');
      expect(resumeBtn).toBeInTheDocument();
      expect(resumeBtn).toHaveTextContent('R');
    });

    it('does not show Resume button when feature is running', () => {
      const features = [createFeature({ id: '100' })];
      const runningFeatures = new Set(['100']);
      const featureSessionIds = new Map([
        ['100', { executionId: 'exec-1', sessionId: 'session-1' }],
      ]);
      const props = createTreeProps(features, { runningFeatures, featureSessionIds });
      const { container } = render(<TreeView {...props} />);

      const resumeBtn = container.querySelector('.btn-tree-resume');
      expect(resumeBtn).not.toBeInTheDocument();
    });

    it('shows ⋮ menu button for all features', () => {
      const features = [createFeature({ id: '100' })];
      const props = createTreeProps(features);
      const { container } = render(<TreeView {...props} />);

      const menuBtn = container.querySelector('.btn-tree-menu');
      expect(menuBtn).toBeInTheDocument();
      expect(menuBtn).toHaveTextContent('⋮');
    });
  });

  describe('User Interactions', () => {
    it('calls onRunCommand when executable tile clicked', async () => {
      const user = userEvent.setup();
      const features = [createFeature({ id: '100', status: '[PROPOSED]' })];
      const onRunCommand = vi.fn();
      const props = createTreeProps(features, { onRunCommand });
      render(<TreeView {...props} />);

      const tile = screen.getByText('Test Feature').closest('.tree-item');
      await user.click(tile);

      expect(onRunCommand).toHaveBeenCalledWith('100', 'fl');
    });

    it('does not call onRunCommand when non-executable tile clicked', async () => {
      const user = userEvent.setup();
      // Use a status that has no executable command (not DRAFT/PROPOSED/REVIEWED/WIP/BLOCKED)
      // But also not filtered out (not DONE/CANCELLED)
      // Actually, looking at the code, all visible statuses have executableCommand
      // So we test with running=true to disable executableCommand
      const features = [createFeature({ id: '100', status: '[PROPOSED]' })];
      const runningFeatures = new Set(['100']);
      const onRunCommand = vi.fn();
      const props = createTreeProps(features, { onRunCommand, runningFeatures });
      render(<TreeView {...props} />);

      const tile = screen.getByText('Test Feature').closest('.tree-item');
      await user.click(tile);

      // Running features don't trigger onRunCommand
      expect(onRunCommand).not.toHaveBeenCalled();
    });

    it('calls onSelect when ⋮ button clicked', async () => {
      const user = userEvent.setup();
      const features = [createFeature({ id: '100' })];
      const onSelect = vi.fn();
      const props = createTreeProps(features, { onSelect });
      const { container } = render(<TreeView {...props} />);

      const menuBtn = container.querySelector('.btn-tree-menu');
      await user.click(menuBtn);

      expect(onSelect).toHaveBeenCalledWith('100');
    });

    it('calls onResumeTerminal when R button clicked', async () => {
      const user = userEvent.setup();
      const features = [createFeature({ id: '100' })];
      const featureSessionIds = new Map([
        ['100', { executionId: 'exec-1', sessionId: 'session-1' }],
      ]);
      const onResumeTerminal = vi.fn();
      const props = createTreeProps(features, { featureSessionIds, onResumeTerminal });
      const { container } = render(<TreeView {...props} />);

      const resumeBtn = container.querySelector('.btn-tree-resume');
      await user.click(resumeBtn);

      expect(onResumeTerminal).toHaveBeenCalledWith('100');
    });

    it('button clicks do not trigger tile click (stopPropagation)', async () => {
      const user = userEvent.setup();
      const features = [createFeature({ id: '100', status: '[PROPOSED]' })];
      const onRunCommand = vi.fn();
      const onSelect = vi.fn();
      const props = createTreeProps(features, { onRunCommand, onSelect });
      const { container } = render(<TreeView {...props} />);

      const menuBtn = container.querySelector('.btn-tree-menu');
      await user.click(menuBtn);

      expect(onSelect).toHaveBeenCalledWith('100');
      expect(onRunCommand).not.toHaveBeenCalled();
    });
  });

  describe('Progress Display', () => {
    it('renders AC progress when progress.acs is present', () => {
      const features = [
        createFeature({
          progress: {
            acs: { completed: 3, total: 5 },
          },
        }),
      ];
      const props = createTreeProps(features);
      render(<TreeView {...props} />);

      expect(screen.getByText('AC 3/5')).toBeInTheDocument();
    });

    it('renders Tasks progress when progress.tasks is present', () => {
      const features = [
        createFeature({
          progress: {
            tasks: { completed: 2, total: 4 },
          },
        }),
      ];
      const props = createTreeProps(features);
      render(<TreeView {...props} />);

      expect(screen.getByText('Tasks 2/4')).toBeInTheDocument();
    });

    it('does not render progress when progress is null', () => {
      const features = [createFeature({ progress: null })];
      const props = createTreeProps(features);
      const { container } = render(<TreeView {...props} />);

      const progressBar = container.querySelector('.tree-progress-bar');
      expect(progressBar).not.toBeInTheDocument();
    });
  });

  describe('State Indicators', () => {
    it('shows running command for running features', () => {
      const features = [createFeature({ id: '100' })];
      const runningFeatures = new Set(['100']);
      const featureRunningCommand = new Map([['100', 'FL']]);
      const props = createTreeProps(features, { runningFeatures, featureRunningCommand });
      render(<TreeView {...props} />);

      expect(screen.getByText('FL')).toBeInTheDocument();
    });

    it('shows context percent when available', () => {
      const features = [createFeature({ id: '100' })];
      const runningFeatures = new Set(['100']);
      const featureContextPercent = new Map([['100', 75]]);
      const props = createTreeProps(features, { runningFeatures, featureContextPercent });
      render(<TreeView {...props} />);

      expect(screen.getByText('75%')).toBeInTheDocument();
    });

    it('shows elapsed time since session started for running features', () => {
      const features = [createFeature({ id: '100' })];
      const runningFeatures = new Set(['100']);
      // Session started 30 seconds ago (ISO string format from backend)
      const featureStartedAt = new Map([['100', new Date(Date.now() - 30000).toISOString()]]);
      const props = createTreeProps(features, { runningFeatures, featureStartedAt });
      const { container } = render(<TreeView {...props} />);

      const elapsedEl = container.querySelector('.tree-elapsed');
      expect(elapsedEl).toBeInTheDocument();
      expect(elapsedEl).toHaveTextContent('30s');
    });

    it('shows placeholder (not real elapsed time) when root feature is not running', () => {
      // Root feature (depth=0, no pendingDeps) should show placeholder
      const features = [createFeature({ id: '100' })];
      // featureStartedAt is set but runningFeatures does not include '100'
      const featureStartedAt = new Map([['100', new Date(Date.now() - 30000).toISOString()]]);
      const props = createTreeProps(features, { featureStartedAt });
      const { container } = render(<TreeView {...props} />);

      const elapsedEl = container.querySelector('.tree-elapsed');
      expect(elapsedEl).toBeInTheDocument();
      expect(elapsedEl).toHaveClass('tree-placeholder');
    });

    it('does not show placeholder for child feature (depth > 0) when not running', () => {
      // Child feature (depth > 0) should not show placeholder
      const features = [
        createFeature({ id: '100' }),
        createFeature({ id: '101', pendingDeps: 'F100' }),
      ];
      const props = createTreeProps(features);
      const { container } = render(<TreeView {...props} />);

      // Should have 2 tree-items, but only the root (F100) should have placeholder
      const placeholders = container.querySelectorAll('.tree-placeholder');
      expect(placeholders.length).toBe(3); // phase, context, elapsed for root only
    });

    it('shows last outcome for completed features', () => {
      const features = [createFeature({ id: '100' })];
      const featureLastOutcome = new Map([['100', { status: 'completed', command: 'fl' }]]);
      const props = createTreeProps(features, { featureLastOutcome });
      render(<TreeView {...props} />);

      expect(screen.getByText('✓ FL Done')).toBeInTheDocument();
    });

    it('shows last outcome for failed features', () => {
      const features = [createFeature({ id: '100' })];
      const featureLastOutcome = new Map([['100', { status: 'failed', command: 'run' }]]);
      const props = createTreeProps(features, { featureLastOutcome });
      render(<TreeView {...props} />);

      expect(screen.getByText('✗ RUN Failed')).toBeInTheDocument();
    });

    it('shows last outcome for handed-off features', () => {
      const features = [createFeature({ id: '100' })];
      const featureLastOutcome = new Map([['100', { status: 'handed-off', command: 'fc' }]]);
      const props = createTreeProps(features, { featureLastOutcome });
      render(<TreeView {...props} />);

      expect(screen.getByText('📤 FC Terminal')).toBeInTheDocument();
    });
  });
});
