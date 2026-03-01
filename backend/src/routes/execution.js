import { Router } from 'express';
import { serverLog } from '../utils/logger.js';

/**
 * Sanitize user input strings to prevent injection attacks
 * - Strip control characters (except \n, \r, \t which are allowed for formatting)
 * - Truncate to max 10000 characters
 */
function sanitizeInput(input, maxLength = 10000) {
  if (typeof input !== 'string') return input;
  // Remove control characters except newline, carriage return, tab
  const sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return sanitized.substring(0, maxLength);
}

export function createExecutionRouter(claudeService) {
  const router = Router();

  // Validate :id param as UUID format
  router.param('id', (req, res, next, id) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid execution ID format' });
    }
    next();
  });

  // POST /api/execution/fl - Start FL execution
  router.post('/fl', (req, res) => {
    const { featureId, chain } = req.body;
    if (!featureId) {
      return res.status(400).json({ error: 'featureId is required' });
    }

    try {
      const executionId = claudeService.executeCommand(featureId, 'fl', { chain: !!chain });
      const exec = claudeService.getExecution(executionId);
      res.json(exec);
    } catch (err) {
      serverLog.error(`Error starting FL for ${featureId}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/execution/fc - Start /fc execution
  router.post('/fc', (req, res) => {
    const { featureId, chain } = req.body;
    if (!featureId) {
      return res.status(400).json({ error: 'featureId is required' });
    }

    try {
      const executionId = claudeService.executeCommand(featureId, 'fc', { chain: !!chain });
      const exec = claudeService.getExecution(executionId);
      res.json(exec);
    } catch (err) {
      serverLog.error(`Error starting fc for ${featureId}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/execution/run - Start /run execution
  router.post('/run', (req, res) => {
    const { featureId, chain } = req.body;
    if (!featureId) {
      return res.status(400).json({ error: 'featureId is required' });
    }

    try {
      const executionId = claudeService.executeCommand(featureId, 'run', { chain: !!chain });
      const exec = claudeService.getExecution(executionId);
      res.json(exec);
    } catch (err) {
      serverLog.error(`Error starting run for ${featureId}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/execution/terminal - Open interactive terminal tab
  router.post('/terminal', (req, res) => {
    const { featureId, command } = req.body;
    if (!featureId || !command) {
      return res.status(400).json({ error: 'featureId and command are required' });
    }

    try {
      const result = claudeService.openTerminal(featureId, command);
      res.json(result);
    } catch (err) {
      serverLog.error(`Error opening terminal for ${featureId}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/execution/shell - Run a shell command (cs, dr, upd)
  // When command === 'cs' and profile is provided, directly switches to that profile.
  // When command === 'cs' without profile, runs cs.bat as before (smart switch).
  router.post('/shell', (req, res) => {
    const { command, profile } = req.body;
    if (!command) {
      return res.status(400).json({ error: 'command is required' });
    }
    const allowedShell = ['cs', 'dr', 'upd'];
    if (!allowedShell.includes(command)) {
      return res
        .status(400)
        .json({
          error: `Invalid shell command: ${command}. Must be one of: ${allowedShell.join(', ')}`,
        });
    }
    if (command === 'cs' && profile !== undefined) {
      // Profile validation: simple lowercase letters only
      if (!/^[a-z]+$/.test(profile)) {
        return res
          .status(400)
          .json({ error: `Invalid profile name: ${profile}. Must match /^[a-z]+$/` });
      }
      try {
        const result = claudeService.switchProfile(profile);
        return res.json(result);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    try {
      const result = claudeService.runShellCommand(command);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/execution/slash - Execute slash command via -p mode
  router.post('/slash', (req, res) => {
    const { command } = req.body;
    if (!command) {
      return res.status(400).json({ error: 'command is required' });
    }
    const allowedSlash = ['commit', 'sync-deps'];
    if (!allowedSlash.includes(command)) {
      return res
        .status(400)
        .json({
          error: `Invalid slash command: ${command}. Must be one of: ${allowedSlash.join(', ')}`,
        });
    }
    try {
      const executionId = claudeService.executeSlashCommand(command);
      const exec = claudeService.getExecution(executionId);
      res.json(exec);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/execution/queue - Queue status
  router.get('/queue', (req, res) => {
    res.json(claudeService.getQueueStatus());
  });

  // POST /api/execution/queue/clear - Clear queued items
  router.post('/queue/clear', (req, res) => {
    const cleared = claudeService.clearQueue();
    res.json({ cleared: cleared.length, ids: cleared });
  });

  // GET /api/execution - List all executions
  router.get('/', (req, res) => {
    res.json(claudeService.listExecutions());
  });

  // GET /api/execution/:id - Execution status
  router.get('/:id', (req, res) => {
    const exec = claudeService.getExecution(req.params.id);
    if (!exec) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    res.json(exec);
  });

  // GET /api/execution/:id/logs - Execution logs with offset
  router.get('/:id/logs', (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const logs = claudeService.getExecutionLogs(req.params.id, offset);
    if (!logs) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    res.json({ logs, offset, total: offset + logs.length });
  });

  // POST /api/execution/:id/resume/browser - Resume in browser with log capture
  router.post('/:id/resume/browser', (req, res) => {
    const { prompt } = req.body;
    const sanitizedPrompt = prompt ? sanitizeInput(prompt) : 'continue';
    try {
      const result = claudeService.resumeInBrowser(req.params.id, sanitizedPrompt);
      if (result.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      serverLog.error(`Error resuming execution ${req.params.id}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/execution/:id/resume/terminal - Resume in terminal (interactive)
  router.post('/:id/resume/terminal', (req, res) => {
    try {
      const result = claudeService.resumeInTerminal(req.params.id);
      if (result.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      serverLog.error(`Error opening terminal for resume ${req.params.id}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/execution/:id - Kill execution
  router.delete('/:id', (req, res) => {
    const killed = claudeService.killExecution(req.params.id);
    if (!killed) {
      return res.status(404).json({ error: 'Execution not found or not running' });
    }
    res.json({ success: true });
  });

  return router;
}
