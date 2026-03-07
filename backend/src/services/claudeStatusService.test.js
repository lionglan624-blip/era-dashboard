import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeStatusService } from './claudeStatusService.js';

// Mock the config imports
vi.mock('../config.js', () => ({
  CLAUDE_STATUS_POLL_INTERVAL_MS: 300000,
  CLAUDE_STATUS_URL: 'https://status.claude.com/api/v2/components.json',
  CLAUDE_STATUS_TIMEOUT_MS: 10000,
  CLAUDE_STATUS_COMPONENT_IDS: ['comp1', 'comp2'],
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockFetch(components = [], ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve({ components }),
  });
}

const MOCK_COMPONENTS = [
  {
    id: 'comp1',
    name: 'Claude Code',
    status: 'operational',
    created_at: '2025-01-01',
    position: 1,
  },
  {
    id: 'comp2',
    name: 'Claude API',
    status: 'operational',
    created_at: '2025-01-01',
    position: 2,
  },
  {
    id: 'other',
    name: 'Other Service',
    status: 'major_outage',
    created_at: '2025-01-01',
    position: 3,
  },
];

describe('ClaudeStatusService', () => {
  let service;
  let mockFetch;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = createMockFetch(MOCK_COMPONENTS);
    service = new ClaudeStatusService({ fetchFn: mockFetch, componentIds: ['comp1', 'comp2'] });
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  describe('getCached', () => {
    it('returns null before first poll', () => {
      expect(service.getCached()).toBeNull();
    });

    it('returns cached data after successful poll', async () => {
      await service._poll();
      const cached = service.getCached();
      expect(cached).not.toBeNull();
      expect(cached.components).toHaveLength(2);
      expect(cached.worst).toBe('operational');
      expect(cached.updatedAt).toBeDefined();
    });
  });

  describe('_poll', () => {
    it('filters components by configured IDs', async () => {
      await service._poll();
      const cached = service.getCached();
      expect(cached.components).toHaveLength(2);
      expect(cached.components.map((c) => c.id)).toEqual(['comp1', 'comp2']);
      // 'other' component should be filtered out
    });

    it('maps component fields correctly', async () => {
      await service._poll();
      const cached = service.getCached();
      expect(cached.components[0]).toEqual({
        id: 'comp1',
        name: 'Claude Code',
        status: 'operational',
      });
    });

    it('preserves cache on fetch failure', async () => {
      await service._poll(); // successful first poll
      const firstCache = service.getCached();

      service._fetchFn = vi.fn().mockRejectedValue(new Error('Network error'));
      await service._poll(); // failed second poll

      expect(service.getCached()).toBe(firstCache); // same reference
    });

    it('preserves cache on non-ok response', async () => {
      await service._poll(); // successful first poll
      const firstCache = service.getCached();

      service._fetchFn = createMockFetch([], false, 503);
      await service._poll();

      expect(service.getCached()).toBe(firstCache);
    });

    it('passes abort signal with timeout', async () => {
      await service._poll();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  describe('_worstStatus', () => {
    it('returns operational when all components operational', () => {
      expect(service._worstStatus([{ status: 'operational' }, { status: 'operational' }])).toBe(
        'operational',
      );
    });

    it('returns degraded_performance as worst', () => {
      expect(
        service._worstStatus([{ status: 'operational' }, { status: 'degraded_performance' }]),
      ).toBe('degraded_performance');
    });

    it('returns major_outage over partial_outage', () => {
      expect(service._worstStatus([{ status: 'partial_outage' }, { status: 'major_outage' }])).toBe(
        'major_outage',
      );
    });

    it('returns under_maintenance correctly', () => {
      expect(
        service._worstStatus([{ status: 'operational' }, { status: 'under_maintenance' }]),
      ).toBe('under_maintenance');
    });

    it('returns unknown for empty array', () => {
      expect(service._worstStatus([])).toBe('unknown');
    });
  });

  describe('start/stop', () => {
    it('polls immediately on start', async () => {
      service.start();
      // Flush the initial _poll() promise without advancing the interval
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('polls periodically after start', async () => {
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(300000);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('stops polling after stop', async () => {
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      service.stop();

      await vi.advanceTimersByTimeAsync(600000);
      expect(mockFetch).toHaveBeenCalledTimes(1); // no additional calls
    });

    it('stop is safe to call without start', () => {
      expect(() => service.stop()).not.toThrow();
    });
  });

  describe('refresh', () => {
    it('triggers a poll', async () => {
      service.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not throw on fetch failure', async () => {
      service._fetchFn = vi.fn().mockRejectedValue(new Error('fail'));
      expect(() => service.refresh()).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
    });
  });
});
