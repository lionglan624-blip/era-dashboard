/**
 * File Watcher Module
 *
 * Monitors feature markdown files for changes and broadcasts status updates.
 * Used to trigger chain execution when feature status changes (e.g., [DRAFT] → [PROPOSED]).
 */

import chokidar from 'chokidar';
import path from 'path';
import { readdir, readFile } from 'fs/promises';
import { watcherLog } from '../utils/logger.js';
import { STATUS_DEBOUNCE_MS, FEATURE_UPDATE_DEBOUNCE_MS } from '../config.js';

/**
 * @typedef {Object} StatusChange
 * @property {string} oldStatus - Previous status (e.g., '[DRAFT]')
 * @property {string} newStatus - New status (e.g., '[PROPOSED]')
 */

/**
 * @callback OnStatusChangedCallback
 * @param {string} featureId - Feature ID that changed
 * @param {string} oldStatus - Previous status
 * @param {string} newStatus - New status
 * @returns {void}
 */

/**
 * Watches feature files for changes and broadcasts updates via WebSocket.
 * Monitors pm/features/*.md files for status changes to trigger chain execution.
 */
export class FileWatcher {
  /**
   * Create a FileWatcher instance
   * @param {string} projectRoot - Project root directory
   * @param {import('./featureService.js').FeatureService} featureService - Feature service for cache invalidation
   * @param {import('../websocket/logStreamer.js').LogStreamer|null} logStreamer - WebSocket broadcaster (nullable)
   */
  constructor(projectRoot, featureService, logStreamer) {
    /** @type {string} */
    this.projectRoot = projectRoot;
    /** @type {import('./featureService.js').FeatureService} */
    this.featureService = featureService;
    /** @type {import('../websocket/logStreamer.js').LogStreamer|null} */
    this.logStreamer = logStreamer;
    /** @type {import('chokidar').FSWatcher|null} */
    this.watcher = null;
    /** @type {NodeJS.Timeout|null} */
    this.debounceTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this.statusDebounceTimer = null;
    /** @type {Map<string, StatusChange>} featureId -> { oldStatus, newStatus } */
    this.pendingStatusChanges = new Map();
    /** @type {Map<string, string>} featureId -> status */
    this.statusCache = new Map();
    /** @type {OnStatusChangedCallback|null} */
    this.onStatusChanged = null;
  }

  /**
   * Extract status from feature file content using regex
   * @param {string} content - File content to parse
   * @returns {string|null} Status string (e.g., '[PROPOSED]') or null if not found
   * @private
   */
  _parseStatus(content) {
    const match = content.match(/## Status:\s*\[([\w-]+)\]/);
    return match ? `[${match[1]}]` : null;
  }

  /**
   * Extract status from feature file asynchronously
   * @param {string} filePath - Path to feature file
   * @returns {Promise<string|null>} Status string or null on error/not found
   */
  async extractStatus(filePath) {
    try {
      const content = await readFile(filePath, 'utf-8');
      return this._parseStatus(content);
    } catch (err) {
      watcherLog.debug(`Failed to extract status from ${path.basename(filePath)}: ${err.message}`);
      return null;
    }
  }

  /**
   * Initialize status cache from existing feature files
   * Called before starting the watcher to establish baseline status for each feature
   * @returns {Promise<void>}
   */
  async initializeCache() {
    const featuresDir = path.join(this.projectRoot, 'pm', 'features');
    try {
      const files = await readdir(featuresDir);
      for (const file of files) {
        const match = file.match(/^feature-(\d+)\.md$/);
        if (match) {
          const filePath = path.join(featuresDir, file);
          const status = await this.extractStatus(filePath);
          if (status) {
            this.statusCache.set(match[1], status);
          }
        }
      }
      watcherLog.info(`Cached status for ${this.statusCache.size} features`);
    } catch (err) {
      watcherLog.error(`Failed to initialize cache: ${err.message}`);
    }
  }

  /**
   * Start watching for file changes
   * Initializes cache and sets up chokidar watcher on pm/features/
   * @returns {Promise<void>}
   */
  async start() {
    const watchPath = path.join(this.projectRoot, 'pm', 'features');

    // Initialize status cache before starting watch
    await this.initializeCache();

    this.watcher = chokidar.watch(watchPath, {
      ignored: /(^|[/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
      depth: 0, // only watch top-level files
    });

    this.watcher.on('change', (filePath) => {
      if (filePath.endsWith('.md')) {
        this.checkStatusChange(filePath).catch((err) => {
          watcherLog.error(`Status check failed for ${path.basename(filePath)}: ${err.message}`);
        });
        this.debouncedUpdate();
      }
    });

    this.watcher.on('add', async (filePath) => {
      if (filePath.endsWith('.md')) {
        watcherLog.info(`New file detected: ${path.basename(filePath)}`);
        // Cache status for new feature files so first status change is detected
        const match = path.basename(filePath).match(/^feature-(\d+)\.md$/);
        if (match) {
          const status = await this.extractStatus(filePath);
          if (status) {
            this.statusCache.set(match[1], status);
          }
        }
        this.debouncedUpdate();
      }
    });

    this.watcher.on('error', (err) => {
      watcherLog.error(`Watcher error: ${err.message}`);
    });

    watcherLog.info(`Watching for changes in ${watchPath}`);
  }

  /**
   * Check if feature status changed and queue for debounced notification
   * @param {string} filePath - Path to the changed feature file
   * @returns {Promise<void>}
   */
  async checkStatusChange(filePath) {
    const match = path.basename(filePath).match(/^feature-(\d+)\.md$/);
    if (!match) return;

    const featureId = match[1];
    const newStatus = await this.extractStatus(filePath);
    if (!newStatus) {
      // Read failed or no status found: clear cache to avoid stale comparison on next change
      this.statusCache.delete(featureId);
      return;
    }

    const oldStatus = this.statusCache.get(featureId);
    if (oldStatus && oldStatus !== newStatus) {
      // Queue the status change (overwrites previous pending change for same feature)
      this.pendingStatusChanges.set(featureId, { oldStatus, newStatus });
      this.debouncedStatusBroadcast();
    }
    this.statusCache.set(featureId, newStatus);
  }

  /**
   * Debounced broadcast of pending status changes
   * Waits STATUS_DEBOUNCE_MS before broadcasting to coalesce rapid changes
   * @returns {void}
   */
  debouncedStatusBroadcast() {
    clearTimeout(this.statusDebounceTimer);
    this.statusDebounceTimer = setTimeout(() => {
      for (const [featureId, { oldStatus, newStatus }] of this.pendingStatusChanges) {
        watcherLog.info(`F${featureId} status: ${oldStatus} → ${newStatus}`);
        this.logStreamer?.broadcastAll({
          type: 'status-changed',
          featureId,
          oldStatus,
          newStatus,
          timestamp: new Date().toISOString(),
        });
        // Notify chain controller for auto-progression
        this.onStatusChanged?.(featureId, oldStatus, newStatus);
      }
      this.pendingStatusChanges.clear();
    }, STATUS_DEBOUNCE_MS);
  }

  /**
   * Debounced update notification for feature file changes
   * Invalidates cache and broadcasts features-updated event
   * @returns {void}
   */
  debouncedUpdate() {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.featureService.invalidateCache();
      this.logStreamer?.broadcastAll({
        type: 'features-updated',
        timestamp: new Date().toISOString(),
      });
    }, FEATURE_UPDATE_DEBOUNCE_MS);
  }

  /**
   * Stop watching and clean up resources
   * Clears timers, closes watcher, and clears caches
   * @returns {void}
   */
  stop() {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.statusDebounceTimer);
    this.debounceTimer = null;
    this.statusDebounceTimer = null;
    if (this.watcher) {
      this.watcher.close();
      watcherLog.info('File watcher stopped');
    }
    // Clear caches to prevent memory leaks
    this.statusCache.clear();
    this.pendingStatusChanges.clear();
  }
}
