import { createLogger } from '../utils/logger.js';
import {
  CLAUDE_STATUS_POLL_INTERVAL_MS,
  CLAUDE_STATUS_URL,
  CLAUDE_STATUS_TIMEOUT_MS,
  CLAUDE_STATUS_COMPONENT_IDS,
} from '../config.js';

const STATUS_SEVERITY = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
};

export class ClaudeStatusService {
  constructor({ fetchFn = fetch, componentIds = CLAUDE_STATUS_COMPONENT_IDS } = {}) {
    this.logger = createLogger('claude-status');
    this._fetchFn = fetchFn;
    this._componentIds = componentIds;
    this._cache = null;
    this._interval = null;
  }

  start() {
    this._poll().catch((err) => this.logger.error('Initial poll failed:', err.message));
    this._interval = setInterval(() => {
      this._poll().catch((err) => this.logger.error('Periodic poll failed:', err.message));
    }, CLAUDE_STATUS_POLL_INTERVAL_MS);
    this.logger.info('Claude status monitoring started', {
      intervalMs: CLAUDE_STATUS_POLL_INTERVAL_MS,
      components: this._componentIds.length,
    });
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
      this.logger.info('Claude status monitoring stopped');
    }
  }

  refresh() {
    this._poll().catch((err) => this.logger.error('Refresh poll failed:', err.message));
  }

  async _poll() {
    try {
      const response = await this._fetchFn(CLAUDE_STATUS_URL, {
        signal: AbortSignal.timeout(CLAUDE_STATUS_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn(`Status API returned ${response.status}`);
        return;
      }

      const data = await response.json();
      const components = (data.components || [])
        .filter((c) => this._componentIds.includes(c.id))
        .map((c) => ({ id: c.id, name: c.name, status: c.status }));

      const worst = this._worstStatus(components);

      this._cache = {
        components,
        updatedAt: new Date().toISOString(),
        worst,
      };

      if (worst !== 'operational') {
        this.logger.warn(`Claude status: ${worst}`, { components });
      }
    } catch (err) {
      this.logger.error('Status fetch failed:', err.message);
      // Preserve existing cache on failure
    }
  }

  _worstStatus(components) {
    if (components.length === 0) return 'unknown';
    let worst = 'operational';
    let worstSeverity = 0;
    for (const c of components) {
      const severity = STATUS_SEVERITY[c.status] ?? 0;
      if (severity > worstSeverity) {
        worstSeverity = severity;
        worst = c.status;
      }
    }
    return worst;
  }

  getCached() {
    return this._cache;
  }
}
