import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useFeatures, useFeatureDetail } from './useFeatures';

describe('useFeatures', () => {
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createMockResponse = (data, ok = true, status = 200) => {
    return Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(data),
    });
  };

  describe('Initial Fetch', () => {
    it('fetches features on mount', async () => {
      const mockData = {
        features: [{ id: 1 }, { id: 2 }],
        phases: [{ name: 'Phase 1' }],
      };
      mockFetch.mockReturnValue(createMockResponse(mockData));

      const { result } = renderHook(() => useFeatures());

      expect(result.current.loading).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('/api/features');

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.features).toEqual(mockData.features);
      expect(result.current.phases).toEqual(mockData.phases);
      expect(result.current.error).toBeNull();
    });

    it('sets features and phases from response', async () => {
      const mockData = {
        features: [{ id: 3, title: 'F3' }],
        phases: [
          { id: 1, name: 'P1' },
          { id: 2, name: 'P2' },
        ],
      };
      mockFetch.mockReturnValue(createMockResponse(mockData));

      const { result } = renderHook(() => useFeatures());

      await waitFor(() => {
        expect(result.current.features).toEqual(mockData.features);
      });

      expect(result.current.phases).toEqual(mockData.phases);
    });

    it('handles missing features in response', async () => {
      const mockData = { phases: [{ id: 1 }] };
      mockFetch.mockReturnValue(createMockResponse(mockData));

      const { result } = renderHook(() => useFeatures());

      await waitFor(() => {
        expect(result.current.features).toEqual([]);
      });
    });

    it('handles missing phases in response', async () => {
      const mockData = { features: [{ id: 1 }] };
      mockFetch.mockReturnValue(createMockResponse(mockData));

      const { result } = renderHook(() => useFeatures());

      await waitFor(() => {
        expect(result.current.phases).toEqual([]);
      });
    });
  });

  describe('Error Handling', () => {
    it('sets error on fetch failure', async () => {
      mockFetch.mockReturnValue(createMockResponse({}, false, 500));

      const { result } = renderHook(() => useFeatures());

      await waitFor(() => {
        expect(result.current.error).toBe('HTTP 500');
      });

      expect(result.current.loading).toBe(false);
    });

    it('sets error on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useFeatures());

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
      });

      expect(result.current.loading).toBe(false);
    });

    it('clears previous error on successful refetch', async () => {
      mockFetch.mockReturnValueOnce(createMockResponse({}, false, 500));

      const { result } = renderHook(() => useFeatures());

      await waitFor(() => {
        expect(result.current.error).toBe('HTTP 500');
      });

      mockFetch.mockReturnValueOnce(createMockResponse({ features: [], phases: [] }));
      result.current.refetch();

      await waitFor(() => {
        expect(result.current.error).toBeNull();
      });
    });
  });

  describe('Loading State', () => {
    it('sets loading to false after successful fetch', async () => {
      mockFetch.mockReturnValue(createMockResponse({ features: [], phases: [] }));

      const { result } = renderHook(() => useFeatures());

      expect(result.current.loading).toBe(true);

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });

    it('sets loading to false after failed fetch', async () => {
      mockFetch.mockReturnValue(createMockResponse({}, false, 404));

      const { result } = renderHook(() => useFeatures());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });
  });

  describe('Refetch', () => {
    it('refetches data when refetch is called', async () => {
      const initialData = { features: [{ id: 1 }], phases: [] };
      const updatedData = { features: [{ id: 1 }, { id: 2 }], phases: [] };

      mockFetch.mockReturnValueOnce(createMockResponse(initialData));

      const { result } = renderHook(() => useFeatures());

      await waitFor(() => {
        expect(result.current.features).toEqual(initialData.features);
      });

      mockFetch.mockReturnValueOnce(createMockResponse(updatedData));
      result.current.refetch();

      await waitFor(() => {
        expect(result.current.features).toEqual(updatedData.features);
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe('useFeatureDetail', () => {
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createMockResponse = (data, ok = true, status = 200) => {
    return Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(data),
    });
  };

  describe('Null ID Handling', () => {
    it('returns null feature when id is null', () => {
      const { result } = renderHook(() => useFeatureDetail(null));

      expect(result.current.feature).toBeNull();
      expect(result.current.loading).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null feature when id is undefined', () => {
      const { result } = renderHook(() => useFeatureDetail(undefined));

      expect(result.current.feature).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('Loading State', () => {
    it('sets loading to true during fetch', async () => {
      mockFetch.mockReturnValue(new Promise(() => {})); // Never resolves

      const { result } = renderHook(() => useFeatureDetail(123));

      expect(result.current.loading).toBe(true);
    });

    it('sets loading to false after successful fetch', async () => {
      const mockData = { id: 123, title: 'Feature 123' };
      mockFetch.mockReturnValue(createMockResponse(mockData));

      const { result } = renderHook(() => useFeatureDetail(123));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });
  });

  describe('Successful Fetch', () => {
    it('sets feature data on success', async () => {
      const mockData = { id: 456, title: 'Feature 456', status: '[WIP]' };
      mockFetch.mockReturnValue(createMockResponse(mockData));

      const { result } = renderHook(() => useFeatureDetail(456));

      await waitFor(() => {
        expect(result.current.feature).toEqual(mockData);
      });

      expect(result.current.error).toBeNull();
      expect(mockFetch).toHaveBeenCalledWith('/api/features/456');
    });

    it('clears previous error on successful fetch', async () => {
      mockFetch.mockReturnValueOnce(createMockResponse({}, false, 404));

      const { result, rerender } = renderHook(({ id }) => useFeatureDetail(id), {
        initialProps: { id: 123 },
      });

      await waitFor(() => {
        expect(result.current.error).toBe('HTTP 404');
      });

      mockFetch.mockReturnValueOnce(createMockResponse({ id: 456, title: 'OK' }));
      rerender({ id: 456 });

      await waitFor(() => {
        expect(result.current.error).toBeNull();
      });
    });
  });

  describe('Error Handling', () => {
    it('sets error on fetch failure', async () => {
      mockFetch.mockReturnValue(createMockResponse({}, false, 500));

      const { result } = renderHook(() => useFeatureDetail(789));

      await waitFor(() => {
        expect(result.current.error).toBe('HTTP 500');
      });

      expect(result.current.loading).toBe(false);
    });

    it('sets error on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const { result } = renderHook(() => useFeatureDetail(999));

      await waitFor(() => {
        expect(result.current.error).toBe('Connection refused');
      });
    });
  });

  describe('ID Change Handling', () => {
    it('refetches when id changes', async () => {
      const mockData1 = { id: 1, title: 'Feature 1' };
      const mockData2 = { id: 2, title: 'Feature 2' };

      mockFetch.mockReturnValueOnce(createMockResponse(mockData1));

      const { result, rerender } = renderHook(({ id }) => useFeatureDetail(id), {
        initialProps: { id: 1 },
      });

      await waitFor(() => {
        expect(result.current.feature).toEqual(mockData1);
      });

      mockFetch.mockReturnValueOnce(createMockResponse(mockData2));
      rerender({ id: 2 });

      await waitFor(() => {
        expect(result.current.feature).toEqual(mockData2);
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith('/api/features/1');
      expect(mockFetch).toHaveBeenCalledWith('/api/features/2');
    });

    it('clears feature when id changes to null', async () => {
      const mockData = { id: 1, title: 'Feature 1' };
      mockFetch.mockReturnValue(createMockResponse(mockData));

      const { result, rerender } = renderHook(({ id }) => useFeatureDetail(id), {
        initialProps: { id: 1 },
      });

      await waitFor(() => {
        expect(result.current.feature).toEqual(mockData);
      });

      rerender({ id: null });

      expect(result.current.feature).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1); // No additional fetch
    });
  });
});
