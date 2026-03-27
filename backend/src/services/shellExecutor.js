/**
 * ShellExecutor — Extracted shell/debug command logic from ClaudeService.
 *
 * Handles shell commands (cs, dr, upd), slash commands (/commit, /sync-deps),
 * debug prompts, update analysis, and shell state persistence.
 *
 * Uses DI pattern (same as RetryManager/ResumeManager): constructor receives deps object
 * with callbacks to ClaudeService methods.
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { claudeLog } from '../utils/logger.js';
import { nowJSTISO } from '../utils/timeUtils.js';
import { SHELL_STATE_TTL_MS } from '../config.js';

export class ShellExecutor {
  /**
   * @param {Object} deps - Dependency injection
   * @param {string} deps.tmpDir - Temp directory path
   * @param {string} deps.projectRoot - Project root path
   * @param {Function} deps.createExecution - (opts) => execution object
   * @param {Map} deps.executions - Shared executions Map reference
   * @param {Function} deps.startExecution - (exec) => void
   * @param {Function} deps.canStartNow - (exec) => boolean
   * @param {Array} deps.queue - Shared queue array reference
   * @param {Function} deps.broadcastAll - (msg) => void
   * @param {Function} deps.broadcastQueueUpdate - () => void
   * @param {Function} deps.pushLog - (exec, entry) => void
   * @param {Function} deps.getCcsProfile - () => string
   * @param {Function} deps.exitForRestart - () => void (delegates to ClaudeService._exitForRestart for testability)
   */
  constructor(deps) {
    this.deps = deps;
    this._shellStatesPath = path.join(deps.tmpDir, 'shell-states.json');
    this.shellStates = this._loadShellStates();
  }

  /** Load shell states from disk (survives restart) */
  _loadShellStates() {
    try {
      if (existsSync(this._shellStatesPath)) {
        const data = JSON.parse(readFileSync(this._shellStatesPath, 'utf8'));
        const map = new Map();
        const now = Date.now();
        for (const [cmd, state] of Object.entries(data)) {
          // Only load entries within TTL
          if (now - new Date(state.timestamp).getTime() < SHELL_STATE_TTL_MS) {
            map.set(cmd, state);
          }
        }
        return map;
      }
    } catch (err) {
      claudeLog.debug(`[ShellExecutor] Failed to load shell-states.json: ${err.message}`);
    }
    return new Map();
  }

  /** Set a shell command state and persist to disk */
  setShellState(command, success) {
    this.shellStates.set(command, { success, timestamp: nowJSTISO() });
    this._persistShellStates();
  }

  /** Persist shell states to disk */
  _persistShellStates() {
    try {
      const obj = Object.fromEntries(this.shellStates);
      writeFileSync(this._shellStatesPath, JSON.stringify(obj, null, 2));
    } catch (err) {
      claudeLog.debug(`[ShellExecutor] Failed to save shell-states.json: ${err.message}`);
    }
  }

  /** Get current CCS version */
  _getCcsVersion() {
    try {
      const result = spawnSync('ccs', ['--version'], {
        timeout: 5000,
        encoding: 'utf8',
        windowsHide: true,
        shell: true,
      });
      const firstLine = result.stdout?.split('\n')[0]?.trim();
      if (!firstLine) return null;
      // Extract version from "CCS (Claude Code Switch) v7.37.1"
      const match = firstLine.match(/v([\d.]+)/);
      return match ? match[1] : firstLine;
    } catch {
      return null;
    }
  }

  /** Run a shell command (cs, dr, upd) */
  runShellCommand(command) {
    // Validate: only allow 'cs', 'dr', and 'upd'
    const allowed = ['cs', 'dr', 'upd'];
    if (!allowed.includes(command)) {
      throw new Error(`Invalid shell command: ${command}`);
    }

    claudeLog.info(`[ShellExecutor] Running shell command: ${command}`);

    if (command === 'dr') {
      // Special handling: 'dr' restarts the dashboard backend via pm2.
      // Only restart backend — frontend uses HMR, proxy is a shared long-lived process.
      // Using 'restart all' caused proxy crash loops and prolonged EADDRINUSE conflicts.
      this.deps.broadcastAll({
        type: 'shell-complete',
        command,
        success: true,
        timestamp: nowJSTISO(),
      });
      this.setShellState(command, true);
      // Let PM2 handle restart via autorestart + restart_delay (5s).
      // Detached spawn approaches (pm2 restart / pm2 stop+start) all cause cascade issues:
      // orphan detached processes survive parent death and keep issuing restart commands.
      // process.exit() is clean — PM2 waits restart_delay, port releases, no race conditions.
      setTimeout(() => {
        claudeLog.info('[DR] Exiting for PM2 autorestart (restart_delay: 5s)');
        this.deps.exitForRestart();
      }, 500);
    } else if (command === 'upd') {
      // Special handling: 'upd' updates CCS itself with version tracking
      const oldVersion = this._getCcsVersion();
      const proc = spawn('npm', ['update', '-g', '@kaitranntt/ccs'], {
        cwd: this.deps.projectRoot,
        stdio: 'ignore',
        shell: true,
        windowsHide: true,
      });
      proc.on('close', (code) => {
        const newVersion = this._getCcsVersion();
        claudeLog.info(`[ShellExecutor] Update complete: ${oldVersion} -> ${newVersion}`);
        this.deps.broadcastAll({
          type: 'upd-complete',
          oldVersion,
          newVersion,
          timestamp: nowJSTISO(),
        });
        this.deps.broadcastAll({
          type: 'shell-complete',
          command,
          success: code === 0,
          timestamp: nowJSTISO(),
        });
        this.setShellState(command, code === 0);
      });
    } else {
      const proc = spawn('cmd', ['/c', command], {
        cwd: this.deps.projectRoot,
        stdio: 'ignore',
        windowsHide: true,
      });
      proc.on('close', (code) => {
        this.deps.broadcastAll({
          type: 'shell-complete',
          command,
          success: code === 0,
          timestamp: nowJSTISO(),
        });
        this.setShellState(command, code === 0);
      });
      proc.unref();
    }

    return { command, status: 'launched' };
  }

  /** Get shell states (TTL-filtered) */
  getShellStates() {
    const now = Date.now();
    const result = {};
    for (const [cmd, state] of this.shellStates) {
      if (now - new Date(state.timestamp).getTime() < SHELL_STATE_TTL_MS) {
        result[cmd] = state;
      }
    }
    return result;
  }

  /** Execute slash command via -p mode (no featureId) */
  executeSlashCommand(slashCommand, onComplete = null) {
    // Validate: only allow specific slash commands
    const allowed = ['commit', 'sync-deps', 'patch-cc'];
    if (!allowed.includes(slashCommand)) {
      throw new Error(
        `Invalid slash command: ${slashCommand}. Must be one of: ${allowed.join(', ')}`,
      );
    }

    const execution = this.deps.createExecution({ command: slashCommand });
    const executionId = execution.id;

    if (onComplete) execution._onComplete = onComplete;

    this.deps.executions.set(executionId, execution);

    // Notify frontend so it subscribes to this execution (needed for API-spawned commands)
    this.deps.broadcastAll({
      type: 'execution-started',
      executionId,
      command: slashCommand,
    });

    // Slash commands (commit, sync-deps) bypass queue limit — lightweight, non-feature ops
    this.deps.startExecution(execution);

    return executionId;
  }

  /** Execute arbitrary prompt for debugging (requires .debug-enabled file, 30-min TTL) */
  executeDebugPrompt(prompt) {
    const enableFile = path.join(this.deps.tmpDir, '.debug-enabled');
    if (!existsSync(enableFile)) {
      throw new Error(
        'Debug endpoint not enabled. Create _out/tmp/dashboard/.debug-enabled to activate.',
      );
    }
    const ageMs = Date.now() - statSync(enableFile).mtimeMs;
    if (ageMs > 30 * 60 * 1000) {
      unlinkSync(enableFile);
      throw new Error('Debug token expired (30-min TTL). Re-create .debug-enabled to activate.');
    }

    const execution = this.deps.createExecution({ command: 'debug' });
    execution._debugPrompt = prompt;
    const executionId = execution.id;

    this.deps.executions.set(executionId, execution);

    // Notify frontend so it subscribes
    this.deps.broadcastAll({
      type: 'execution-started',
      executionId,
      command: 'debug',
    });

    if (this.deps.canStartNow(execution)) {
      this.deps.startExecution(execution);
    } else {
      this.deps.queue.push(executionId);
      this.deps.pushLog(execution, {
        line: `Queued (position ${this.deps.queue.length}). Waiting for slot...`,
        timestamp: nowJSTISO(),
        level: 'info',
      });
      this.deps.broadcastQueueUpdate();
    }

    return executionId;
  }

  /**
   * Execute an update analysis prompt (used by updateWatcherService).
   * Similar to executeDebugPrompt but without .debug-enabled gate.
   * @param {string} prompt - The analysis prompt
   * @param {Function} [onComplete] - Optional callback(execution, exitCode) on completion
   * @returns {string} executionId
   */
  executeUpdateAnalysis(prompt, onComplete = null) {
    const execution = this.deps.createExecution({ command: 'update-analysis' });
    execution._debugPrompt = prompt;
    if (onComplete) execution._onComplete = onComplete;
    const executionId = execution.id;

    this.deps.executions.set(executionId, execution);

    this.deps.broadcastAll({
      type: 'execution-started',
      executionId,
      command: 'update-analysis',
    });

    this.deps.startExecution(execution);

    return executionId;
  }
}
