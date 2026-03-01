import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusBadge from './StatusBadge';

describe('StatusBadge', () => {
  describe('Status Colors', () => {
    it('renders [DRAFT] with gray background', () => {
      render(<StatusBadge status="[DRAFT]" />);
      const badge = screen.getByText('DRAFT');
      expect(badge.style.backgroundColor).toBe('rgb(107, 114, 128)');
      expect(badge.style.color).toBe('rgb(255, 255, 255)');
    });

    it('renders [PROPOSED] with blue background', () => {
      render(<StatusBadge status="[PROPOSED]" />);
      const badge = screen.getByText('PROPOSED');
      expect(badge.style.backgroundColor).toBe('rgb(59, 130, 246)');
      expect(badge.style.color).toBe('rgb(255, 255, 255)');
    });

    it('renders [REVIEWED] with green background', () => {
      render(<StatusBadge status="[REVIEWED]" />);
      const badge = screen.getByText('REVIEWED');
      expect(badge.style.backgroundColor).toBe('rgb(16, 185, 129)');
      expect(badge.style.color).toBe('rgb(255, 255, 255)');
    });

    it('renders [WIP] with orange background and black text', () => {
      render(<StatusBadge status="[WIP]" />);
      const badge = screen.getByText('WIP');
      expect(badge.style.backgroundColor).toBe('rgb(245, 158, 11)');
      expect(badge.style.color).toBe('rgb(0, 0, 0)');
    });

    it('renders [BLOCKED] with red background', () => {
      render(<StatusBadge status="[BLOCKED]" />);
      const badge = screen.getByText('BLOCKED');
      expect(badge.style.backgroundColor).toBe('rgb(239, 68, 68)');
      expect(badge.style.color).toBe('rgb(255, 255, 255)');
    });

    it('renders [DONE] with dark green background', () => {
      render(<StatusBadge status="[DONE]" />);
      const badge = screen.getByText('DONE');
      expect(badge.style.backgroundColor).toBe('rgb(5, 150, 105)');
      expect(badge.style.color).toBe('rgb(255, 255, 255)');
    });

    it('renders [CANCELLED] with gray background', () => {
      render(<StatusBadge status="[CANCELLED]" />);
      const badge = screen.getByText('CANCELLED');
      expect(badge.style.backgroundColor).toBe('rgb(156, 163, 175)');
      expect(badge.style.color).toBe('rgb(255, 255, 255)');
    });

    it('falls back to gray for unknown status', () => {
      render(<StatusBadge status="[UNKNOWN]" />);
      const badge = screen.getByText('UNKNOWN');
      expect(badge.style.backgroundColor).toBe('rgb(107, 114, 128)');
      expect(badge.style.color).toBe('rgb(255, 255, 255)');
    });
  });

  describe('Bracket Stripping', () => {
    it('strips brackets from status label', () => {
      render(<StatusBadge status="[WIP]" />);
      expect(screen.getByText('WIP')).toBeInTheDocument();
      expect(screen.queryByText('[WIP]')).not.toBeInTheDocument();
    });

    it('handles status without brackets', () => {
      render(<StatusBadge status="DONE" />);
      expect(screen.getByText('DONE')).toBeInTheDocument();
    });

    it('handles multiple brackets in status', () => {
      render(<StatusBadge status="[[TEST]]" />);
      expect(screen.getByText('TEST')).toBeInTheDocument();
    });
  });

  describe('Style Attributes', () => {
    it('applies className status-badge', () => {
      render(<StatusBadge status="[DONE]" />);
      const badge = screen.getByText('DONE');
      expect(badge.className).toBe('status-badge');
    });

    it('applies inline styles for background and text color', () => {
      render(<StatusBadge status="[WIP]" />);
      const badge = screen.getByText('WIP');
      expect(badge.style.backgroundColor).toBe('rgb(245, 158, 11)');
      expect(badge.style.color).toBe('rgb(0, 0, 0)');
    });
  });
});
