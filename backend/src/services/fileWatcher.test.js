import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileWatcher } from './fileWatcher.js';

// Mock chokidar to avoid real filesystem watchers
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
    })),
  },
}));

// Mock fs/promises for async extractStatus and initializeCache
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(() => Promise.resolve([])),
}));

function createWatcher() {
  const featureService = { invalidateCache: vi.fn() };
  const logStreamer = { broadcastAll: vi.fn() };
  const watcher = new FileWatcher('C:\\test\\project', featureService, logStreamer);
  return { watcher, featureService, logStreamer };
}

describe('FileWatcher', () => {
  describe('_parseStatus', () => {
    it('parses status from content', () => {
      const { watcher } = createWatcher();
      expect(watcher._parseStatus('# Feature\n## Status: [PROPOSED]\nSome content')).toBe(
        '[PROPOSED]',
      );
    });

    it('returns null for content without status', () => {
      const { watcher } = createWatcher();
      expect(watcher._parseStatus('No status here')).toBeNull();
    });
  });

  describe('initializeCache', () => {
    it('populates cache from feature files', async () => {
      const { readdir, readFile } = await import('fs/promises');
      readdir.mockResolvedValue(['feature-100.md', 'feature-200.md', 'index-features.md']);
      readFile.mockImplementation((filePath) => {
        if (filePath.includes('feature-100')) return Promise.resolve('## Status: [PROPOSED]');
        if (filePath.includes('feature-200')) return Promise.resolve('## Status: [DONE]');
        return Promise.resolve('');
      });

      const { watcher } = createWatcher();
      await watcher.initializeCache();

      expect(watcher.statusCache.get('100')).toBe('[PROPOSED]');
      expect(watcher.statusCache.get('200')).toBe('[DONE]');
      expect(watcher.statusCache.size).toBe(2);
    });

    it('handles empty directory', async () => {
      const { readdir } = await import('fs/promises');
      readdir.mockResolvedValue([]);

      const { watcher } = createWatcher();
      await watcher.initializeCache();

      expect(watcher.statusCache.size).toBe(0);
    });

    it('handles readdir error gracefully', async () => {
      const { readdir } = await import('fs/promises');
      readdir.mockRejectedValue(new Error('ENOENT'));

      const { watcher } = createWatcher();
      await watcher.initializeCache();

      expect(watcher.statusCache.size).toBe(0);
    });
  });

  describe('extractStatus (async)', () => {
    it('extracts status from feature file', async () => {
      const { readFile } = await import('fs/promises');
      readFile.mockResolvedValue('# Feature\n## Status: [REVIEWED]\nSome content');

      const { watcher } = createWatcher();
      const status = await watcher.extractStatus('feature-100.md');
      expect(status).toBe('[REVIEWED]');
    });

    it('extracts various statuses', async () => {
      const { readFile } = await import('fs/promises');

      const statuses = ['DRAFT', 'PROPOSED', 'REVIEWED', 'WIP', 'BLOCKED', 'DONE', 'CANCELLED'];
      for (const s of statuses) {
        readFile.mockResolvedValue(`## Status: [${s}]`);
        const { watcher } = createWatcher();
        expect(await watcher.extractStatus('test.md')).toBe(`[${s}]`);
      }
    });

    it('returns null for files without status', async () => {
      const { readFile } = await import('fs/promises');
      readFile.mockResolvedValue('No status here');

      const { watcher } = createWatcher();
      expect(await watcher.extractStatus('test.md')).toBeNull();
    });

    it('returns null on read error', async () => {
      const { readFile } = await import('fs/promises');
      readFile.mockRejectedValue(new Error('ENOENT'));

      const { watcher } = createWatcher();
      expect(await watcher.extractStatus('nonexistent.md')).toBeNull();
    });
  });

  describe('checkStatusChange', () => {
    it('detects status changes', async () => {
      const { readFile } = await import('fs/promises');
      readFile.mockResolvedValue('## Status: [REVIEWED]');

      const { watcher } = createWatcher();
      watcher.statusCache.set('100', '[PROPOSED]');

      await watcher.checkStatusChange('C:\\test\\project\\pm\\features\\feature-100.md');

      expect(watcher.pendingStatusChanges.has('100')).toBe(true);
      const change = watcher.pendingStatusChanges.get('100');
      expect(change.oldStatus).toBe('[PROPOSED]');
      expect(change.newStatus).toBe('[REVIEWED]');
    });

    it('ignores unchanged status', async () => {
      const { readFile } = await import('fs/promises');
      readFile.mockResolvedValue('## Status: [PROPOSED]');

      const { watcher } = createWatcher();
      watcher.statusCache.set('100', '[PROPOSED]');

      await watcher.checkStatusChange('C:\\test\\project\\pm\\features\\feature-100.md');

      expect(watcher.pendingStatusChanges.has('100')).toBe(false);
    });

    it('ignores non-feature files', async () => {
      const { watcher } = createWatcher();
      await watcher.checkStatusChange('C:\\test\\project\\pm\\features\\index-features.md');
      expect(watcher.pendingStatusChanges.size).toBe(0);
    });

    it('updates status cache', async () => {
      const { readFile } = await import('fs/promises');
      readFile.mockResolvedValue('## Status: [WIP]');

      const { watcher } = createWatcher();
      watcher.statusCache.set('100', '[REVIEWED]');

      await watcher.checkStatusChange('C:\\test\\project\\pm\\features\\feature-100.md');

      expect(watcher.statusCache.get('100')).toBe('[WIP]');
    });
  });

  describe('debouncedStatusBroadcast', () => {
    it('broadcasts pending changes after debounce', async () => {
      vi.useFakeTimers();
      const { watcher, logStreamer } = createWatcher();
      const onStatusChanged = vi.fn();
      watcher.onStatusChanged = onStatusChanged;

      watcher.pendingStatusChanges.set('100', { oldStatus: '[PROPOSED]', newStatus: '[REVIEWED]' });
      watcher.debouncedStatusBroadcast();

      // Not yet fired
      expect(logStreamer.broadcastAll).not.toHaveBeenCalled();

      // After 300ms debounce
      vi.advanceTimersByTime(300);

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status-changed',
          featureId: '100',
          oldStatus: '[PROPOSED]',
          newStatus: '[REVIEWED]',
        }),
      );
      expect(onStatusChanged).toHaveBeenCalledWith('100', '[PROPOSED]', '[REVIEWED]');
      expect(watcher.pendingStatusChanges.size).toBe(0);

      vi.useRealTimers();
    });
  });

  describe('stop', () => {
    it('closes the watcher', () => {
      const { watcher } = createWatcher();
      const mockClose = vi.fn();
      watcher.watcher = { close: mockClose };
      watcher.stop();
      expect(mockClose).toHaveBeenCalled();
    });

    it('handles missing watcher gracefully', () => {
      const { watcher } = createWatcher();
      watcher.watcher = null;
      expect(() => watcher.stop()).not.toThrow();
    });

    it('clears pendingStatusChanges and statusCache', async () => {
      const { watcher } = createWatcher();
      watcher.watcher = { close: vi.fn() };
      watcher.statusCache.set('100', '[PROPOSED]');
      watcher.pendingStatusChanges.set('100', { oldStatus: '[PROPOSED]', newStatus: '[REVIEWED]' });

      await watcher.stop();

      expect(watcher.statusCache.size).toBe(0);
      expect(watcher.pendingStatusChanges.size).toBe(0);
    });

    it('clears debounce timers', () => {
      vi.useFakeTimers();
      const { watcher } = createWatcher();
      watcher.watcher = { close: vi.fn() };
      watcher.debounceTimer = setTimeout(() => {}, 1000);
      watcher.statusDebounceTimer = setTimeout(() => {}, 1000);

      watcher.stop();

      expect(watcher.debounceTimer).toBeNull();
      expect(watcher.statusDebounceTimer).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('_parseStatus edge cases', () => {
    it('handles uppercase filename pattern (feature-100.MD) - file content still valid', () => {
      const { watcher } = createWatcher();
      // The regex pattern matches content, not filename
      expect(watcher._parseStatus('## Status: [PROPOSED]')).toBe('[PROPOSED]');
    });

    it('handles content with BOM character', () => {
      const { watcher } = createWatcher();
      const bomContent = '\uFEFF## Status: [PROPOSED]';
      // BOM at start doesn't affect status extraction
      expect(watcher._parseStatus(bomContent)).toBe('[PROPOSED]');
    });

    it('handles status with extra whitespace', () => {
      const { watcher } = createWatcher();
      expect(watcher._parseStatus('## Status:   [PROPOSED]')).toBe('[PROPOSED]');
    });

    it('returns null for malformed status (missing bracket)', () => {
      const { watcher } = createWatcher();
      expect(watcher._parseStatus('## Status: PROPOSED')).toBeNull();
    });

    it('returns null for h1 header level (# Status)', () => {
      const { watcher } = createWatcher();
      // h1 (#) doesn't match ## pattern
      expect(watcher._parseStatus('# Status: [PROPOSED]')).toBeNull();
    });

    it('matches h3 header level (### contains ##)', () => {
      const { watcher } = createWatcher();
      // h3 (###) contains ## so it still matches - this is acceptable
      // as feature files always use h2 for status
      expect(watcher._parseStatus('### Status: [PROPOSED]')).toBe('[PROPOSED]');
    });
  });

  describe('checkStatusChange edge cases', () => {
    it('clears cache on read failure', async () => {
      const { readFile } = await import('fs/promises');
      readFile.mockRejectedValue(new Error('ENOENT'));

      const { watcher } = createWatcher();
      watcher.statusCache.set('100', '[PROPOSED]');

      await watcher.checkStatusChange('C:\\test\\project\\pm\\features\\feature-100.md');

      expect(watcher.statusCache.has('100')).toBe(false);
    });

    it('handles first status detection (no old status)', async () => {
      const { readFile } = await import('fs/promises');
      readFile.mockResolvedValue('## Status: [PROPOSED]');

      const { watcher } = createWatcher();
      // No status in cache

      await watcher.checkStatusChange('C:\\test\\project\\pm\\features\\feature-100.md');

      // Should update cache but not trigger change (no old status)
      expect(watcher.statusCache.get('100')).toBe('[PROPOSED]');
      expect(watcher.pendingStatusChanges.has('100')).toBe(false);
    });

    it('ignores feature-like filenames that do not match pattern', async () => {
      const { watcher } = createWatcher();

      // These should not match feature-{ID}.md pattern
      await watcher.checkStatusChange('C:\\test\\project\\pm\\features\\feature-abc.md');
      await watcher.checkStatusChange('C:\\test\\project\\pm\\features\\feature-.md');
      await watcher.checkStatusChange('C:\\test\\project\\pm\\features\\feature-100-backup.md');

      expect(watcher.pendingStatusChanges.size).toBe(0);
    });
  });

  describe('debouncedStatusBroadcast edge cases', () => {
    it('handles multiple rapid status changes (last wins)', async () => {
      vi.useFakeTimers();
      const { watcher, logStreamer } = createWatcher();

      watcher.pendingStatusChanges.set('100', { oldStatus: '[DRAFT]', newStatus: '[PROPOSED]' });
      watcher.debouncedStatusBroadcast();

      // New change before debounce fires
      vi.advanceTimersByTime(100);
      watcher.pendingStatusChanges.set('100', { oldStatus: '[PROPOSED]', newStatus: '[REVIEWED]' });
      watcher.debouncedStatusBroadcast();

      // After full debounce
      vi.advanceTimersByTime(300);

      // Only the latest status should be broadcast
      expect(logStreamer.broadcastAll).toHaveBeenCalledTimes(1);
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          oldStatus: '[PROPOSED]',
          newStatus: '[REVIEWED]',
        }),
      );

      vi.useRealTimers();
    });

    it('broadcasts multiple features in single debounce', async () => {
      vi.useFakeTimers();
      const { watcher, logStreamer } = createWatcher();

      watcher.pendingStatusChanges.set('100', { oldStatus: '[DRAFT]', newStatus: '[PROPOSED]' });
      watcher.pendingStatusChanges.set('200', { oldStatus: '[PROPOSED]', newStatus: '[REVIEWED]' });
      watcher.debouncedStatusBroadcast();

      vi.advanceTimersByTime(300);

      expect(logStreamer.broadcastAll).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('handles null logStreamer gracefully', async () => {
      vi.useFakeTimers();
      const featureService = { invalidateCache: vi.fn() };
      const watcher = new FileWatcher('C:\\test\\project', featureService, null);

      watcher.pendingStatusChanges.set('100', { oldStatus: '[DRAFT]', newStatus: '[PROPOSED]' });

      expect(() => {
        watcher.debouncedStatusBroadcast();
        vi.advanceTimersByTime(300);
      }).not.toThrow();

      vi.useRealTimers();
    });
  });

  describe('debouncedUpdate', () => {
    it('invalidates cache and broadcasts update', async () => {
      vi.useFakeTimers();
      const { watcher, featureService, logStreamer } = createWatcher();

      watcher.debouncedUpdate();
      vi.advanceTimersByTime(500);

      expect(featureService.invalidateCache).toHaveBeenCalled();
      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'features-updated' }),
      );

      vi.useRealTimers();
    });

    it('debounces multiple rapid calls', async () => {
      vi.useFakeTimers();
      const { watcher, featureService } = createWatcher();

      watcher.debouncedUpdate();
      vi.advanceTimersByTime(200);
      watcher.debouncedUpdate();
      vi.advanceTimersByTime(200);
      watcher.debouncedUpdate();
      vi.advanceTimersByTime(500);

      // Only called once after final debounce
      expect(featureService.invalidateCache).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });
});
