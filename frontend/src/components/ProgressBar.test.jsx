import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProgressBar from './ProgressBar';

describe('ProgressBar', () => {
  describe('Null Rendering', () => {
    it('returns null when total is 0', () => {
      const { container } = render(<ProgressBar completed={0} total={0} label="Test" />);
      expect(container.firstChild).toBeNull();
    });

    it('returns null when total is undefined', () => {
      const { container } = render(<ProgressBar completed={5} total={undefined} label="Test" />);
      expect(container.firstChild).toBeNull();
    });

    it('returns null when total is null', () => {
      const { container } = render(<ProgressBar completed={5} total={null} label="Test" />);
      expect(container.firstChild).toBeNull();
    });

    it('returns null when total is false', () => {
      const { container } = render(<ProgressBar completed={5} total={false} label="Test" />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('Label and Count', () => {
    it('renders label text', () => {
      render(<ProgressBar completed={3} total={10} label="Tasks" />);
      expect(screen.getByText('Tasks')).toBeInTheDocument();
    });

    it('renders completed/total count', () => {
      render(<ProgressBar completed={5} total={12} label="ACs" />);
      expect(screen.getByText('5/12')).toBeInTheDocument();
    });

    it('displays 0/0 when both are zero but total is truthy edge case', () => {
      // This case won't render due to !total check, but test boundary
      render(<ProgressBar completed={0} total={1} label="Empty" />);
      expect(screen.getByText('0/1')).toBeInTheDocument();
    });
  });

  describe('Percentage Calculation', () => {
    it('calculates percentage correctly and rounds', () => {
      render(<ProgressBar completed={1} total={3} label="Test" />);
      // 1/3 = 0.333... = 33% (rounded)
      const fill = document.querySelector('.progress-fill');
      expect(fill.style.width).toBe('33%');
    });

    it('handles 50% completion', () => {
      render(<ProgressBar completed={5} total={10} label="Test" />);
      const fill = document.querySelector('.progress-fill');
      expect(fill.style.width).toBe('50%');
    });

    it('handles 100% completion', () => {
      render(<ProgressBar completed={10} total={10} label="Test" />);
      const fill = document.querySelector('.progress-fill');
      expect(fill.style.width).toBe('100%');
    });

    it('rounds percentage correctly for edge cases', () => {
      // 2/3 = 0.666... = 67% (rounded)
      render(<ProgressBar completed={2} total={3} label="Test" />);
      const fill = document.querySelector('.progress-fill');
      expect(fill.style.width).toBe('67%');
    });
  });

  describe('Color Styling', () => {
    it('uses green color at 100% completion', () => {
      render(<ProgressBar completed={10} total={10} label="Complete" />);
      const fill = document.querySelector('.progress-fill');
      expect(fill.style.backgroundColor).toBe('rgb(5, 150, 105)');
    });

    it('uses blue color when incomplete', () => {
      render(<ProgressBar completed={5} total={10} label="Incomplete" />);
      const fill = document.querySelector('.progress-fill');
      expect(fill.style.backgroundColor).toBe('rgb(59, 130, 246)');
    });

    it('uses blue color at 99% (not complete)', () => {
      render(<ProgressBar completed={99} total={100} label="Almost" />);
      const fill = document.querySelector('.progress-fill');
      expect(fill.style.backgroundColor).toBe('rgb(59, 130, 246)');
    });

    it('uses blue color at 0%', () => {
      render(<ProgressBar completed={0} total={10} label="None" />);
      const fill = document.querySelector('.progress-fill');
      expect(fill.style.backgroundColor).toBe('rgb(59, 130, 246)');
    });
  });

  describe('Width Style', () => {
    it('sets width to percentage value', () => {
      render(<ProgressBar completed={7} total={10} label="Test" />);
      const fill = document.querySelector('.progress-fill');
      expect(fill.style.width).toBe('70%');
    });

    it('handles 0% width', () => {
      render(<ProgressBar completed={0} total={100} label="Test" />);
      const fill = document.querySelector('.progress-fill');
      expect(fill.style.width).toBe('0%');
    });

    it('handles 1% width (edge case rounding)', () => {
      render(<ProgressBar completed={1} total={100} label="Test" />);
      const fill = document.querySelector('.progress-fill');
      expect(fill.style.width).toBe('1%');
    });
  });
});
