/**
 * Chain Execution Module
 *
 * Manages automatic fc→fl→run chain progression for feature development workflow.
 * When one command completes successfully, the next command in the chain is
 * automatically triggered based on the feature's new status.
 *
 * Chain flow:
 *   [DRAFT] → fc → [PROPOSED] → fl → [REVIEWED] → run → [DONE]
 */

import { claudeLog } from '../utils/logger.js';

/**
 * @typedef {Object} ChainWaiter
 * @property {string} executionId - The execution ID that registered this waiter
 * @property {number} registeredAt - Timestamp when waiter was registered
 */

/**
 * @typedef {Object} ChainProgressEvent
 * @property {'chain-progress'} type - Event type
 * @property {string} featureId - Feature being processed
 * @property {string} previousCommand - Command that just completed
 * @property {string} nextCommand - Command being started
 * @property {string|null} oldStatus - Previous feature status
 * @property {string} newStatus - New feature status
 * @property {string} oldExecutionId - Execution ID that completed
 * @property {string} newExecutionId - New execution ID
 * @property {string} timestamp - ISO timestamp
 */

/**
 * Status-to-command mapping for chain progression
 * @type {Record<string, string>}
 */
const STATUS_TO_COMMAND = {
  '[PROPOSED]': 'fl', // FC done → start FL
  '[REVIEWED]': 'run', // FL done → start Run
};

/**
 * Expected status after each command completes
 * @type {Record<string, string>}
 */
const EXPECTED_STATUS_AFTER_COMMAND = {
  fc: '[PROPOSED]', // fc → [PROPOSED]
  fl: '[REVIEWED]', // fl → [REVIEWED]
};

/**
 * Determine next command in chain based on feature status
 * @param {string} status - Current feature status (e.g., '[PROPOSED]')
 * @returns {string|null} Next command to execute, or null if chain is complete
 */
export function getNextChainCommand(status) {
  return STATUS_TO_COMMAND[status] || null;
}

/**
 * Check if status is the expected result of a command
 * @param {string} command - Command that was executed (fc, fl, run)
 * @param {string} status - Current feature status
 * @returns {boolean} True if status matches expected outcome
 */
export function isExpectedStatusAfterCommand(command, status) {
  return EXPECTED_STATUS_AFTER_COMMAND[command] === status;
}

/**
 * Chain Executor - manages chain waiter registration and status change handling
 *
 * @example
 * const chainExecutor = new ChainExecutor({
 *   getExecution: (id) => this.executions.get(id),
 *   executeCommand: (fid, cmd, opts) => this.executeCommand(fid, cmd, opts),
 *   pushLog: (exec, entry) => this._pushLog(exec, entry),
 *   broadcastAll: (msg) => this.logStreamer?.broadcastAll(msg),
 *   getStatusFromCache: (fid) => this.fileWatcher?.statusCache.get(fid),
 * });
 */
export class ChainExecutor {
  /**
   * @param {Object} deps - Dependencies injected from ClaudeService
   * @param {function(string): Object|undefined} deps.getExecution - Get execution by ID
   * @param {function(string, string, Object): string} deps.executeCommand - Execute a command, returns new execution ID
   * @param {function(Object, Object): void} deps.pushLog - Push log entry to execution
   * @param {function(Object): void} deps.broadcastAll - Broadcast WebSocket message to all clients
   * @param {function(string): string|undefined} deps.getStatusFromCache - Get status from FileWatcher cache
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, ChainWaiter>} */
    this.chainWaiters = new Map();
  }

  /**
   * Register a chain waiter for an execution
   * Called when a chain-enabled execution completes successfully
   *
   * @param {Object} execution - The execution that just completed
   * @param {string} execution.id - Execution ID
   * @param {string} execution.featureId - Feature ID
   * @param {string} execution.command - Command that completed
   * @param {string|null} execution.chainParentId - Parent chain execution ID
   */
  registerWaiter(execution) {
    claudeLog.info(
      `[Chain] Registered waiter for F${execution.featureId} after ${execution.command} (exec: ${execution.id})`,
    );

    // Check if status already changed (race condition: fileWatcher may have detected change before process exit)
    // If current status already warrants next command, trigger immediately
    const currentStatus = this.deps.getStatusFromCache?.(execution.featureId);
    if (currentStatus) {
      const nextCommand = getNextChainCommand(currentStatus);
      if (nextCommand && isExpectedStatusAfterCommand(execution.command, currentStatus)) {
        claudeLog.info(
          `[Chain] F${execution.featureId}: Status already ${currentStatus}, immediately starting ${nextCommand}`,
        );

        this.deps.pushLog(execution, {
          line: `[Chain] Status already ${currentStatus}, immediately starting ${nextCommand}...`,
          timestamp: new Date().toISOString(),
          level: 'info',
        });

        const updatedHistory = [
          ...(execution.chain?.history || []),
          { command: execution.command, result: 'ok' },
        ];
        const newExecId = this.deps.executeCommand(execution.featureId, nextCommand, {
          chain: true,
          chainParentId: execution.chainParentId || execution.id,
          chainHistory: updatedHistory,
        });

        this._broadcastChainProgress({
          featureId: execution.featureId,
          previousCommand: execution.command,
          nextCommand,
          oldStatus: null,
          newStatus: currentStatus,
          oldExecutionId: execution.id,
          newExecutionId: newExecId,
        });

        return true; // Don't register waiter, already triggered
      }
    }

    this.chainWaiters.set(execution.featureId, {
      executionId: execution.id,
      registeredAt: Date.now(),
    });

    this.deps.pushLog(execution, {
      line: `[Chain] Waiting for feature status change to trigger next step...`,
      timestamp: new Date().toISOString(),
      level: 'info',
    });
  }

  /**
   * Handle feature status change from FileWatcher
   * Triggers next command if a waiter is registered for this feature
   *
   * @param {string} featureId - Feature that changed
   * @param {string} oldStatus - Previous status
   * @param {string} newStatus - New status
   */
  handleStatusChanged(featureId, oldStatus, newStatus) {
    const waiter = this.chainWaiters.get(featureId);
    if (!waiter) return;

    this.chainWaiters.delete(featureId);
    const execution = this.deps.getExecution(waiter.executionId);
    if (!execution) return;

    const nextCommand = getNextChainCommand(newStatus);
    if (!nextCommand) {
      claudeLog.info(
        `[Chain] F${featureId}: ${oldStatus} → ${newStatus}, no next command (chain complete)`,
      );
      return;
    }

    claudeLog.info(
      `[Chain] F${featureId}: ${oldStatus} → ${newStatus}, auto-starting ${nextCommand}`,
    );

    const updatedHistory = [
      ...(execution.chain?.history || []),
      { command: execution.command, result: 'ok' },
    ];
    const newExecId = this.deps.executeCommand(featureId, nextCommand, {
      chain: true,
      chainParentId: execution.chainParentId || execution.id,
      chainHistory: updatedHistory,
    });

    this._broadcastChainProgress({
      featureId,
      previousCommand: execution.command,
      nextCommand,
      oldStatus,
      newStatus,
      oldExecutionId: execution.id,
      newExecutionId: newExecId,
    });
  }

  /**
   * Check if a waiter exists for a feature
   * @param {string} featureId - Feature ID to check
   * @returns {boolean} True if waiter exists
   */
  hasWaiter(featureId) {
    return this.chainWaiters.has(featureId);
  }

  /**
   * Get waiter info for a feature
   * @param {string} featureId - Feature ID
   * @returns {ChainWaiter|undefined} Waiter info or undefined
   */
  getWaiter(featureId) {
    return this.chainWaiters.get(featureId);
  }

  /**
   * Delete a waiter for a feature
   * @param {string} featureId - Feature ID
   * @returns {boolean} True if waiter was deleted
   */
  deleteWaiter(featureId) {
    return this.chainWaiters.delete(featureId);
  }

  /**
   * Get all waiters (for cleanup operations)
   * @returns {Map<string, ChainWaiter>} Map of all waiters
   */
  getAllWaiters() {
    return this.chainWaiters;
  }

  /**
   * Broadcast chain progress event
   * @param {Omit<ChainProgressEvent, 'type' | 'timestamp'>} data - Event data
   * @private
   */
  _broadcastChainProgress(data) {
    this.deps.broadcastAll?.({
      type: 'chain-progress',
      ...data,
      timestamp: new Date().toISOString(),
    });
  }
}
