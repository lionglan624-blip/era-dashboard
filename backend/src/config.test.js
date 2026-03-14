import { describe, it, expect } from 'vitest';
import {
  getPromoMultiplier,
  isPromoActive,
  getMaxConcurrentExecutions,
  getAutoSwitchThreshold,
} from './config.js';

describe('March 2026 Usage Promotion', () => {
  describe('getPromoMultiplier', () => {
    it('returns 1 before promo starts', () => {
      const before = new Date('2026-03-12T23:00:00Z').getTime();
      expect(getPromoMultiplier(before)).toBe(1);
    });

    it('returns 1 after promo ends', () => {
      const after = new Date('2026-03-28T08:00:00Z').getTime();
      expect(getPromoMultiplier(after)).toBe(1);
    });

    it('returns 1 during weekday peak (Mon 8AM PT = 15:00 UTC)', () => {
      // Mon Mar 16 2026, 8AM PT = 15:00 UTC
      expect(getPromoMultiplier(new Date('2026-03-16T15:00:00Z').getTime())).toBe(1);
    });

    it('returns 1 at buffer boundary (Mon 4AM PT = 11:00 UTC)', () => {
      // 4AM PT = start of dashboard peak (1h before actual 5AM peak)
      expect(getPromoMultiplier(new Date('2026-03-16T11:00:00Z').getTime())).toBe(1);
    });

    it('returns 2 during weekday off-peak (Mon 2PM PT = 21:00 UTC)', () => {
      expect(getPromoMultiplier(new Date('2026-03-16T21:00:00Z').getTime())).toBe(2);
    });

    it('returns 2 during weekday off-peak (Mon 3AM PT = 10:00 UTC)', () => {
      // 3AM PT = before the 4AM buffer cutoff
      expect(getPromoMultiplier(new Date('2026-03-16T10:00:00Z').getTime())).toBe(2);
    });

    it('returns 2 on Saturday (any time)', () => {
      // Sat Mar 14 2026, noon PT = 19:00 UTC
      expect(getPromoMultiplier(new Date('2026-03-14T19:00:00Z').getTime())).toBe(2);
    });

    it('returns 2 on Saturday during would-be peak hours', () => {
      // Sat Mar 14 2026, 8AM PT = 15:00 UTC
      expect(getPromoMultiplier(new Date('2026-03-14T15:00:00Z').getTime())).toBe(2);
    });

    it('returns 2 on Sunday', () => {
      // Sun Mar 15 2026, 3AM PT = 10:00 UTC
      expect(getPromoMultiplier(new Date('2026-03-15T10:00:00Z').getTime())).toBe(2);
    });

    it('returns 2 at off-peak boundary end (Mon 11AM PT = 18:00 UTC)', () => {
      // 11AM PT = end of peak, off-peak resumes
      expect(getPromoMultiplier(new Date('2026-03-16T18:00:00Z').getTime())).toBe(2);
    });
  });

  describe('isPromoActive', () => {
    it('returns true during off-peak', () => {
      expect(isPromoActive(new Date('2026-03-16T21:00:00Z').getTime())).toBe(true);
    });

    it('returns false during peak', () => {
      expect(isPromoActive(new Date('2026-03-16T15:00:00Z').getTime())).toBe(false);
    });

    it('returns false after promo', () => {
      expect(isPromoActive(new Date('2026-04-01T12:00:00Z').getTime())).toBe(false);
    });
  });

  describe('getMaxConcurrentExecutions', () => {
    it('returns base*2 during off-peak promo', () => {
      expect(getMaxConcurrentExecutions(new Date('2026-03-16T21:00:00Z').getTime())).toBe(4);
    });

    it('returns base during peak', () => {
      expect(getMaxConcurrentExecutions(new Date('2026-03-16T15:00:00Z').getTime())).toBe(2);
    });

    it('returns base after promo', () => {
      expect(getMaxConcurrentExecutions(new Date('2026-04-01T12:00:00Z').getTime())).toBe(2);
    });
  });

  describe('getAutoSwitchThreshold', () => {
    it('returns 95 during off-peak promo', () => {
      expect(getAutoSwitchThreshold(new Date('2026-03-16T21:00:00Z').getTime())).toBe(95);
    });

    it('returns 80 during peak', () => {
      expect(getAutoSwitchThreshold(new Date('2026-03-16T15:00:00Z').getTime())).toBe(80);
    });

    it('returns 80 after promo', () => {
      expect(getAutoSwitchThreshold(new Date('2026-04-01T12:00:00Z').getTime())).toBe(80);
    });
  });
});
