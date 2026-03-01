import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FeatureDetail from './FeatureDetail.jsx';

function createFeature(overrides = {}) {
  return {
    id: '100',
    title: 'Test Feature',
    status: '[PROPOSED]',
    type: 'kojo',
    created: '2024-01-01',
    summary: 'Test summary',
    acceptanceCriteria: [],
    tasks: [],
    dependencies: [],
    ...overrides,
  };
}

describe('FeatureDetail', () => {
  it('returns null when feature is null', () => {
    const { container } = render(<FeatureDetail feature={null} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders feature title', () => {
    const feature = createFeature({ id: '123', title: 'Sample Feature' });
    render(<FeatureDetail feature={feature} onClose={vi.fn()} />);
    expect(screen.getByText('F123: Sample Feature')).toBeInTheDocument();
  });

  it('renders StatusBadge with status', () => {
    const feature = createFeature({ status: '[WIP]' });
    render(<FeatureDetail feature={feature} onClose={vi.fn()} />);
    expect(screen.getByText('WIP')).toBeInTheDocument();
  });

  it('renders type badge when present', () => {
    const feature = createFeature({ type: 'engine' });
    render(<FeatureDetail feature={feature} onClose={vi.fn()} />);
    expect(screen.getByText('engine')).toBeInTheDocument();
  });

  it('renders summary section when present', () => {
    const feature = createFeature({ summary: 'This is a summary' });
    render(<FeatureDetail feature={feature} onClose={vi.fn()} />);
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getByText('This is a summary')).toBeInTheDocument();
  });

  it('omits summary section when absent', () => {
    const feature = createFeature({ summary: null });
    render(<FeatureDetail feature={feature} onClose={vi.fn()} />);
    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
  });

  it('renders AC table with progress bar', () => {
    const feature = createFeature({
      acceptanceCriteria: [
        { ac: 1, description: 'AC 1', type: 'output', matcher: 'contains', completed: true },
        { ac: 2, description: 'AC 2', type: 'variable', matcher: 'equals', completed: false },
      ],
    });
    render(<FeatureDetail feature={feature} onClose={vi.fn()} />);
    expect(screen.getByText('Acceptance Criteria')).toBeInTheDocument();
    expect(screen.getByText('AC 1')).toBeInTheDocument();
    expect(screen.getByText('AC 2')).toBeInTheDocument();
  });

  it('completed AC rows have row-done class and checkmark', () => {
    const feature = createFeature({
      acceptanceCriteria: [
        { ac: 1, description: 'AC 1', type: 'output', matcher: 'contains', completed: true },
        { ac: 2, description: 'AC 2', type: 'variable', matcher: 'equals', completed: false },
      ],
    });
    const { container } = render(<FeatureDetail feature={feature} onClose={vi.fn()} />);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows[0]).toHaveClass('row-done');
    expect(rows[0].textContent).toContain('✅');
    expect(rows[1]).not.toHaveClass('row-done');
    expect(rows[1].textContent).toContain('⬜');
  });

  it('renders Tasks table with progress bar', () => {
    const feature = createFeature({
      tasks: [
        { task: 1, ac: 1, description: 'Task 1', completed: true },
        { task: 2, ac: 2, description: 'Task 2', completed: false },
      ],
    });
    render(<FeatureDetail feature={feature} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByText('Task 1')).toBeInTheDocument();
    expect(screen.getByText('Task 2')).toBeInTheDocument();
  });

  it('renders Dependencies table when present', () => {
    const feature = createFeature({
      dependencies: [{ type: 'blocks', id: 'F99', description: 'Prerequisite', status: '[DONE]' }],
    });
    render(<FeatureDetail feature={feature} onClose={vi.fn()} />);
    expect(screen.getByText('Dependencies')).toBeInTheDocument();
    expect(screen.getByText('blocks')).toBeInTheDocument();
    expect(screen.getByText('F99')).toBeInTheDocument();
    expect(screen.getByText('Prerequisite')).toBeInTheDocument();
  });

  it('calls onClose when overlay clicked', async () => {
    const onClose = vi.fn();
    const feature = createFeature();
    const { container } = render(<FeatureDetail feature={feature} onClose={onClose} />);
    const overlay = container.querySelector('.feature-detail-overlay');
    await userEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does NOT call onClose when modal content clicked', async () => {
    const onClose = vi.fn();
    const feature = createFeature();
    const { container } = render(<FeatureDetail feature={feature} onClose={onClose} />);
    const modal = container.querySelector('.feature-detail');
    await userEvent.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when × button clicked', async () => {
    const onClose = vi.fn();
    const feature = createFeature();
    render(<FeatureDetail feature={feature} onClose={onClose} />);
    const closeButton = screen.getByText('×');
    await userEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
