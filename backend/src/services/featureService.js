import fs from 'fs';
import path from 'path';
import { IndexParser } from '../parsers/indexParser.js';
import { FeatureParser } from '../parsers/featureParser.js';
import { FEATURE_CACHE_MS } from '../config.js';

export class FeatureService {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.featuresDir = path.join(projectRoot, 'pm', 'features');
    this.indexParser = new IndexParser();
    this.featureParser = new FeatureParser();
    this.cache = null;
    this.cacheTime = 0;
  }

  getIndex() {
    const indexPath = path.join(this.projectRoot, 'pm', 'index-features.md');
    return this.indexParser.parse(indexPath);
  }

  getFeature(id) {
    const filePath = path.join(this.featuresDir, `feature-${id}.md`);
    if (!fs.existsSync(filePath)) return null;
    return this.featureParser.parse(filePath);
  }

  getAllFeatures() {
    const now = Date.now();
    // Cache for FEATURE_CACHE_MS
    if (this.cache && now - this.cacheTime < FEATURE_CACHE_MS) {
      return this.cache;
    }

    const index = this.getIndex();
    const features = [];

    // Collect all feature IDs from index
    for (const phase of index.phases) {
      for (const layer of phase.layers) {
        for (const f of layer.features) {
          const detail = this.getFeature(f.id);
          features.push({
            ...f,
            phase: phase.number != null ? `Phase ${phase.number}` : phase.name,
            phaseName: phase.number != null ? phase.name : '',
            layer: layer.name,
            type: detail?.type || '',
            progress: detail ? this.calcProgress(detail) : null,
            dependencies: detail?.dependencies || [],
          });
        }
      }
    }

    // Add recently completed
    for (const f of index.recentlyCompleted) {
      features.push({
        ...f,
        phase: 'Recently Completed',
        phaseName: '',
        layer: '',
        type: '',
        progress: null,
        dependencies: [],
      });
    }

    // Resolve dependsOn: remove completed dependencies
    const statusById = new Map();
    for (const f of features) {
      statusById.set(f.id, f.status);
    }
    // Also check recently completed (all are DONE)
    for (const f of index.recentlyCompleted) {
      statusById.set(f.id, '[DONE]');
    }
    for (const f of features) {
      if (f.dependsOn) {
        const deps = f.dependsOn
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean);
        const pending = deps.filter((dep) => {
          const depId = dep.replace(/\D/g, '');
          const depStatus = statusById.get(depId);
          // If not in index at all, treat as completed (archived/historical)
          if (!depStatus) return false;
          return depStatus !== '[DONE]' && depStatus !== '[CANCELLED]';
        });
        f.pendingDeps = pending.join(', ');
      } else {
        f.pendingDeps = '';
      }
    }

    this.cache = { features, index };
    this.cacheTime = now;
    return { features, index };
  }

  calcProgress(detail) {
    const acs = detail.acceptanceCriteria || [];
    const tasks = detail.tasks || [];
    return {
      acs: {
        total: acs.length,
        completed: acs.filter((a) => a.completed).length,
      },
      tasks: {
        total: tasks.length,
        completed: tasks.filter((t) => t.completed).length,
      },
    };
  }

  invalidateCache() {
    this.cache = null;
    this.cacheTime = 0;
  }
}
