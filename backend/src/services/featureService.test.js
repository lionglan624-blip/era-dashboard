import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureService } from './featureService.js';
import { IndexParser } from '../parsers/indexParser.js';
import { FeatureParser } from '../parsers/featureParser.js';
import { FEATURE_CACHE_MS } from '../config.js';
import fs from 'fs';

// Mock fs module
vi.mock('fs');

// Mock parser modules with proper class constructors
vi.mock('../parsers/indexParser.js', () => ({
  IndexParser: vi.fn(),
}));

vi.mock('../parsers/featureParser.js', () => ({
  FeatureParser: vi.fn(),
}));

describe('FeatureService', () => {
  let service;
  let mockIndexParser;
  let mockFeatureParser;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock parser instances
    mockIndexParser = {
      parse: vi.fn(),
    };
    mockFeatureParser = {
      parse: vi.fn(),
    };

    // Mock constructor calls to return our mock instances
    vi.mocked(IndexParser).mockImplementation(function () {
      return mockIndexParser;
    });
    vi.mocked(FeatureParser).mockImplementation(function () {
      return mockFeatureParser;
    });

    // Create service instance
    service = new FeatureService('C:\\test\\project');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('initializes parsers correctly', () => {
      expect(IndexParser).toHaveBeenCalledTimes(1);
      expect(FeatureParser).toHaveBeenCalledTimes(1);
      expect(service.indexParser).toBe(mockIndexParser);
      expect(service.featureParser).toBe(mockFeatureParser);
    });

    it('sets projectRoot and featuresDir', () => {
      expect(service.projectRoot).toBe('C:\\test\\project');
      expect(service.featuresDir).toContain('pm\\features');
    });

    it('initializes cache state', () => {
      expect(service.cache).toBeNull();
      expect(service.cacheTime).toBe(0);
    });
  });

  describe('getIndex', () => {
    it('returns parsed index data', () => {
      const mockIndexData = {
        phases: [{ number: 1, name: 'Phase 1', layers: [] }],
        recentlyCompleted: [],
      };
      mockIndexParser.parse.mockReturnValue(mockIndexData);

      const result = service.getIndex();

      expect(mockIndexParser.parse).toHaveBeenCalledWith(
        expect.stringContaining('index-features.md'),
      );
      expect(result).toEqual(mockIndexData);
    });
  });

  describe('getFeature', () => {
    it('returns feature data for existing file', () => {
      const mockFeatureData = {
        id: '100',
        title: 'Test Feature',
        status: '[WIP]',
        type: 'engine',
        acceptanceCriteria: [],
        tasks: [],
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue(mockFeatureData);

      const result = service.getFeature('100');

      expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining('feature-100.md'));
      expect(mockFeatureParser.parse).toHaveBeenCalled();
      expect(result).toEqual(mockFeatureData);
    });

    it('returns null for non-existent file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = service.getFeature('999');

      expect(fs.existsSync).toHaveBeenCalled();
      expect(mockFeatureParser.parse).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe('getAllFeatures', () => {
    it('returns cached data within FEATURE_CACHE_MS (cache hit)', () => {
      const mockCache = {
        features: [{ id: '100', phase: 'Phase 1' }],
        index: { phases: [], recentlyCompleted: [] },
      };
      service.cache = mockCache;
      service.cacheTime = Date.now() - 1000; // 1 second ago (within 2000ms)

      const result = service.getAllFeatures();

      expect(result).toBe(mockCache);
      expect(mockIndexParser.parse).not.toHaveBeenCalled();
    });

    it('fetches fresh data when cache miss (expired)', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Test Phase',
            layers: [
              {
                name: 'Layer 1',
                features: [
                  { id: '100', status: '[WIP]', name: 'Feature 100', dependsOn: '', link: '' },
                ],
              },
            ],
          },
        ],
        recentlyCompleted: [],
      };
      const mockFeatureData = {
        id: '100',
        type: 'engine',
        acceptanceCriteria: [],
        tasks: [],
        dependencies: [],
      };

      service.cacheTime = Date.now() - 5000; // 5 seconds ago (beyond FEATURE_CACHE_MS)
      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue(mockFeatureData);

      const result = service.getAllFeatures();

      expect(mockIndexParser.parse).toHaveBeenCalled();
      expect(result.features).toHaveLength(1);
      expect(result.features[0].id).toBe('100');
      expect(result.features[0].phase).toBe('Phase 1');
      expect(result.features[0].phaseName).toBe('Test Phase');
      expect(result.features[0].layer).toBe('Layer 1');
    });

    it('resolves dependencies correctly (DONE, CANCELLED, archived)', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Phase 1',
            layers: [
              {
                name: 'Layer 1',
                features: [
                  { id: '101', status: '[DONE]', name: 'F101', dependsOn: '', link: '' },
                  { id: '102', status: '[CANCELLED]', name: 'F102', dependsOn: '', link: '' },
                  {
                    id: '103',
                    status: '[WIP]',
                    name: 'F103',
                    dependsOn: 'F101, F102, F104',
                    link: '',
                  },
                ],
              },
            ],
          },
        ],
        recentlyCompleted: [],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue({
        id: '100',
        type: 'engine',
        acceptanceCriteria: [],
        tasks: [],
        dependencies: [],
      });

      const result = service.getAllFeatures();

      const f103 = result.features.find((f) => f.id === '103');
      // F101=[DONE], F102=[CANCELLED], F104=not in index (archived)
      // Only pending dependencies should be empty (all resolved)
      expect(f103.pendingDeps).toBe('');
    });

    it('marks dependencies as pending when not DONE/CANCELLED', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Phase 1',
            layers: [
              {
                name: 'Layer 1',
                features: [
                  { id: '101', status: '[WIP]', name: 'F101', dependsOn: '', link: '' },
                  { id: '102', status: '[REVIEWED]', name: 'F102', dependsOn: '', link: '' },
                  {
                    id: '103',
                    status: '[PROPOSED]',
                    name: 'F103',
                    dependsOn: 'F101, F102',
                    link: '',
                  },
                ],
              },
            ],
          },
        ],
        recentlyCompleted: [],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue({
        id: '100',
        type: 'engine',
        acceptanceCriteria: [],
        tasks: [],
        dependencies: [],
      });

      const result = service.getAllFeatures();

      const f103 = result.features.find((f) => f.id === '103');
      // F101=[WIP], F102=[REVIEWED] → both pending
      expect(f103.pendingDeps).toBe('F101, F102');
    });

    it('handles empty phases and layers', () => {
      const mockIndexData = {
        phases: [],
        recentlyCompleted: [],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);

      const result = service.getAllFeatures();

      expect(result.features).toHaveLength(0);
      expect(result.index.phases).toHaveLength(0);
    });

    it('parses comma-separated dependsOn and extracts numeric IDs', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Phase 1',
            layers: [
              {
                name: 'Layer 1',
                features: [
                  {
                    id: '100',
                    status: '[WIP]',
                    name: 'F100',
                    dependsOn: 'F101, F102, 103',
                    link: '',
                  },
                  { id: '101', status: '[WIP]', name: 'F101', dependsOn: '', link: '' },
                  { id: '102', status: '[WIP]', name: 'F102', dependsOn: '', link: '' },
                  { id: '103', status: '[WIP]', name: 'F103', dependsOn: '', link: '' },
                ],
              },
            ],
          },
        ],
        recentlyCompleted: [],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue({
        id: '100',
        type: 'engine',
        acceptanceCriteria: [],
        tasks: [],
        dependencies: [],
      });

      const result = service.getAllFeatures();

      const f100 = result.features.find((f) => f.id === '100');
      // F101=[WIP], F102=[WIP], 103=[WIP] → all pending
      expect(f100.pendingDeps).toContain('F101');
      expect(f100.pendingDeps).toContain('F102');
      expect(f100.pendingDeps).toContain('103');
    });

    it('adds recently completed features with [DONE] status', () => {
      const mockIndexData = {
        phases: [],
        recentlyCompleted: [
          { id: '200', status: '[DONE]', name: 'Completed Feature', dependsOn: '', link: '' },
        ],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);

      const result = service.getAllFeatures();

      expect(result.features).toHaveLength(1);
      expect(result.features[0].id).toBe('200');
      expect(result.features[0].phase).toBe('Recently Completed');
      expect(result.features[0].phaseName).toBe('');
      expect(result.features[0].layer).toBe('');
      expect(result.features[0].type).toBe('');
      expect(result.features[0].progress).toBeNull();
      expect(result.features[0].dependencies).toEqual([]);
    });

    it('caches result and updates cacheTime', () => {
      const beforeTime = Date.now();
      const mockIndexData = {
        phases: [],
        recentlyCompleted: [],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);

      const result = service.getAllFeatures();

      expect(service.cache).toStrictEqual(result);
      expect(service.cacheTime).toBeGreaterThanOrEqual(beforeTime);
      expect(service.cacheTime).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('calcProgress', () => {
    it('counts completed ACs with [x]', () => {
      const detail = {
        acceptanceCriteria: [
          { ac: 1, completed: true },
          { ac: 2, completed: false },
          { ac: 3, completed: true },
        ],
        tasks: [],
      };

      const result = service.calcProgress(detail);

      expect(result.acs.total).toBe(3);
      expect(result.acs.completed).toBe(2);
    });

    it('counts completed ACs with [X] (case-insensitive)', () => {
      const detail = {
        acceptanceCriteria: [
          { ac: 1, completed: true },
          { ac: 2, completed: true },
        ],
        tasks: [],
      };

      const result = service.calcProgress(detail);

      expect(result.acs.total).toBe(2);
      expect(result.acs.completed).toBe(2);
    });

    it('counts completed tasks', () => {
      const detail = {
        acceptanceCriteria: [],
        tasks: [
          { task: 1, completed: true },
          { task: 2, completed: false },
          { task: 3, completed: true },
          { task: 4, completed: true },
        ],
      };

      const result = service.calcProgress(detail);

      expect(result.tasks.total).toBe(4);
      expect(result.tasks.completed).toBe(3);
    });

    it('handles missing acceptanceCriteria array', () => {
      const detail = {
        tasks: [{ task: 1, completed: true }],
      };

      const result = service.calcProgress(detail);

      expect(result.acs.total).toBe(0);
      expect(result.acs.completed).toBe(0);
      expect(result.tasks.total).toBe(1);
      expect(result.tasks.completed).toBe(1);
    });

    it('handles missing tasks array', () => {
      const detail = {
        acceptanceCriteria: [{ ac: 1, completed: true }],
      };

      const result = service.calcProgress(detail);

      expect(result.acs.total).toBe(1);
      expect(result.acs.completed).toBe(1);
      expect(result.tasks.total).toBe(0);
      expect(result.tasks.completed).toBe(0);
    });

    it('handles empty arrays', () => {
      const detail = {
        acceptanceCriteria: [],
        tasks: [],
      };

      const result = service.calcProgress(detail);

      expect(result.acs.total).toBe(0);
      expect(result.acs.completed).toBe(0);
      expect(result.tasks.total).toBe(0);
      expect(result.tasks.completed).toBe(0);
    });
  });

  describe('invalidateCache', () => {
    it('clears cache and cacheTime', () => {
      service.cache = { features: [], index: { phases: [], recentlyCompleted: [] } };
      service.cacheTime = Date.now();

      service.invalidateCache();

      expect(service.cache).toBeNull();
      expect(service.cacheTime).toBe(0);
    });

    it('is safe to call when cache already empty', () => {
      service.cache = null;
      service.cacheTime = 0;

      service.invalidateCache();

      expect(service.cache).toBeNull();
      expect(service.cacheTime).toBe(0);
    });
  });

  describe('getAllFeatures - integration scenarios', () => {
    it('enriches features with detail data (type, progress, dependencies)', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Phase 1',
            layers: [
              {
                name: 'Layer 1',
                features: [
                  { id: '100', status: '[WIP]', name: 'Feature 100', dependsOn: '', link: '' },
                ],
              },
            ],
          },
        ],
        recentlyCompleted: [],
      };
      const mockFeatureData = {
        id: '100',
        type: 'kojo',
        acceptanceCriteria: [
          { ac: 1, completed: true },
          { ac: 2, completed: false },
        ],
        tasks: [{ task: 1, completed: true }],
        dependencies: [{ type: 'Feature', id: 'F99', description: 'Dependency', status: '[DONE]' }],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue(mockFeatureData);

      const result = service.getAllFeatures();

      expect(result.features).toHaveLength(1);
      const f = result.features[0];
      expect(f.type).toBe('kojo');
      expect(f.progress.acs.total).toBe(2);
      expect(f.progress.acs.completed).toBe(1);
      expect(f.progress.tasks.total).toBe(1);
      expect(f.progress.tasks.completed).toBe(1);
      expect(f.dependencies).toHaveLength(1);
      expect(f.dependencies[0].type).toBe('Feature');
    });

    it('handles feature file not found (getFeature returns null)', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Phase 1',
            layers: [
              {
                name: 'Layer 1',
                features: [
                  {
                    id: '999',
                    status: '[PROPOSED]',
                    name: 'Missing Feature',
                    dependsOn: '',
                    link: '',
                  },
                ],
              },
            ],
          },
        ],
        recentlyCompleted: [],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = service.getAllFeatures();

      expect(result.features).toHaveLength(1);
      const f = result.features[0];
      expect(f.type).toBe('');
      expect(f.progress).toBeNull();
      expect(f.dependencies).toEqual([]);
    });

    it('treats features not in index as completed (archived/historical)', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Phase 1',
            layers: [
              {
                name: 'Layer 1',
                features: [
                  // F100 depends on F50, which is not in the index (archived)
                  { id: '100', status: '[WIP]', name: 'F100', dependsOn: 'F50', link: '' },
                ],
              },
            ],
          },
        ],
        recentlyCompleted: [],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue({
        id: '100',
        type: 'engine',
        acceptanceCriteria: [],
        tasks: [],
        dependencies: [],
      });

      const result = service.getAllFeatures();

      const f100 = result.features.find((f) => f.id === '100');
      // F50 not in index → treated as completed → pendingDeps should be empty
      expect(f100.pendingDeps).toBe('');
    });

    it('handles multiple layers in a phase', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Phase 1',
            layers: [
              {
                name: 'Layer A',
                features: [{ id: '100', status: '[WIP]', name: 'F100', dependsOn: '', link: '' }],
              },
              {
                name: 'Layer B',
                features: [{ id: '101', status: '[WIP]', name: 'F101', dependsOn: '', link: '' }],
              },
            ],
          },
        ],
        recentlyCompleted: [],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue({
        id: '100',
        type: 'engine',
        acceptanceCriteria: [],
        tasks: [],
        dependencies: [],
      });

      const result = service.getAllFeatures();

      expect(result.features).toHaveLength(2);
      expect(result.features[0].layer).toBe('Layer A');
      expect(result.features[1].layer).toBe('Layer B');
    });

    it('handles multiple phases', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Phase 1',
            layers: [
              {
                name: 'Layer 1',
                features: [{ id: '100', status: '[WIP]', name: 'F100', dependsOn: '', link: '' }],
              },
            ],
          },
          {
            number: 2,
            name: 'Phase 2',
            layers: [
              {
                name: 'Layer 2',
                features: [{ id: '200', status: '[WIP]', name: 'F200', dependsOn: '', link: '' }],
              },
            ],
          },
        ],
        recentlyCompleted: [],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue({
        id: '100',
        type: 'engine',
        acceptanceCriteria: [],
        tasks: [],
        dependencies: [],
      });

      const result = service.getAllFeatures();

      expect(result.features).toHaveLength(2);
      expect(result.features[0].phase).toBe('Phase 1');
      expect(result.features[1].phase).toBe('Phase 2');
    });
  });

  describe('dependency resolution edge cases', () => {
    it('handles whitespace in dependsOn list', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Phase 1',
            layers: [
              {
                name: 'Layer 1',
                features: [
                  {
                    id: '100',
                    status: '[WIP]',
                    name: 'F100',
                    dependsOn: '  F101 ,  F102  ',
                    link: '',
                  },
                  { id: '101', status: '[WIP]', name: 'F101', dependsOn: '', link: '' },
                  { id: '102', status: '[DONE]', name: 'F102', dependsOn: '', link: '' },
                ],
              },
            ],
          },
        ],
        recentlyCompleted: [],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue({
        id: '100',
        type: 'engine',
        acceptanceCriteria: [],
        tasks: [],
        dependencies: [],
      });

      const result = service.getAllFeatures();

      const f100 = result.features.find((f) => f.id === '100');
      // F101=[WIP] (pending), F102=[DONE] (resolved)
      expect(f100.pendingDeps).toBe('F101');
    });

    it('handles empty dependsOn gracefully', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Phase 1',
            layers: [
              {
                name: 'Layer 1',
                features: [{ id: '100', status: '[WIP]', name: 'F100', dependsOn: '', link: '' }],
              },
            ],
          },
        ],
        recentlyCompleted: [],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue({
        id: '100',
        type: 'engine',
        acceptanceCriteria: [],
        tasks: [],
        dependencies: [],
      });

      const result = service.getAllFeatures();

      const f100 = result.features.find((f) => f.id === '100');
      expect(f100.pendingDeps).toBe('');
    });

    it('checks recentlyCompleted for dependency status', () => {
      const mockIndexData = {
        phases: [
          {
            number: 1,
            name: 'Phase 1',
            layers: [
              {
                name: 'Layer 1',
                features: [
                  { id: '100', status: '[WIP]', name: 'F100', dependsOn: 'F200', link: '' },
                ],
              },
            ],
          },
        ],
        recentlyCompleted: [{ id: '200', status: '[DONE]', name: 'F200', dependsOn: '', link: '' }],
      };

      mockIndexParser.parse.mockReturnValue(mockIndexData);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockFeatureParser.parse.mockReturnValue({
        id: '100',
        type: 'engine',
        acceptanceCriteria: [],
        tasks: [],
        dependencies: [],
      });

      const result = service.getAllFeatures();

      const f100 = result.features.find((f) => f.id === '100');
      // F200 is in recentlyCompleted → treated as [DONE]
      expect(f100.pendingDeps).toBe('');
    });
  });
});
