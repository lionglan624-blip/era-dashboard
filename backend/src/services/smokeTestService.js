import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';
import {
  SMOKE_TEST_OVERALL_TIMEOUT_MS,
  SMOKE_CLI_TIMEOUT_MS,
  SMOKE_STREAM_TIMEOUT_MS,
  SMOKE_PTY_TIMEOUT_MS,
  SMOKE_RATE_LIMIT_SKIP_STREAM,
  SMOKE_RATE_LIMIT_SKIP_PTY,
  CCS_INSTANCES_DIR,
} from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SmokeTestService {
  constructor({ emailService, logStreamer, rateLimitService, claudeService } = {}) {
    this.emailService = emailService;
    this.logStreamer = logStreamer;
    this.rateLimitService = rateLimitService;
    this.claudeService = claudeService;
    this.logger = createLogger('smoke-test');
    this._running = false;
    this._lastResult = null;
    this._activeProcesses = [];
  }

  async runAll({ trigger, version } = {}) {
    if (this._running) {
      return { error: 'already_running' };
    }
    this._running = true;

    const runTests = async () => {
      const startTime = Date.now();
      const results = [];

      // Rate limit pre-check
      let maxPercent = 0;
      try {
        const cached = await this.rateLimitService?.getCached?.();
        if (cached && typeof cached === 'object') {
          for (const profileKey of Object.keys(cached)) {
            const entry = cached[profileKey];
            const data = entry?.data || entry;
            if (data) {
              const weekly = data.weekly?.percent ?? 0;
              const session = data.session?.percent ?? 0;
              maxPercent = Math.max(maxPercent, weekly, session);
            }
          }
        }
      } catch (err) {
        this.logger.warn(`Rate limit pre-check failed: ${err.message}`);
      }

      // Test 1: cli-binary (always runs)
      results.push(await this._testCliBinary());

      // Test 2: stream-json (skip if rate limit high)
      if (maxPercent > SMOKE_RATE_LIMIT_SKIP_STREAM) {
        results.push({
          name: 'stream-json',
          status: 'skipped',
          reason: 'rate_limit_high',
        });
      } else {
        results.push(await this._testStreamJson());
      }

      // Test 3: pty-usage (skip if rate limit very high)
      if (maxPercent > SMOKE_RATE_LIMIT_SKIP_PTY) {
        results.push({
          name: 'pty-usage',
          status: 'skipped',
          reason: 'rate_limit_high',
        });
      } else {
        results.push(await this._testPtyUsage());
      }

      const passed = results.filter((r) => r.status === 'pass');
      const failed = results.filter((r) => r.status === 'fail');
      const duration = Date.now() - startTime;

      const result = {
        passed,
        failed,
        results,
        duration,
        trigger: trigger || 'manual',
        version: version || null,
        timestamp: new Date().toISOString(),
      };

      // Persist result to file
      try {
        const projectRoot =
          process.env.PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
        const outDir = path.join(projectRoot, '_out', 'tmp', 'dashboard');
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(
          path.join(outDir, 'smoke-test-latest.json'),
          JSON.stringify(result, null, 2),
          'utf8',
        );
      } catch (err) {
        this.logger.error(`Failed to persist smoke test result: ${err.message}`);
      }

      // Alert on failure
      if (failed.length > 0) {
        this._sendAlert(result);
      }

      // Log summary
      this.logger.info(
        `Smoke test complete: ${passed.length} passed, ${failed.length} failed, ` +
          `${results.filter((r) => r.status === 'skipped').length} skipped (${duration}ms)`,
      );

      this._lastResult = result;
      this._running = false;

      return result;
    };

    try {
      return await Promise.race([
        runTests(),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(`Smoke test suite timed out after ${SMOKE_TEST_OVERALL_TIMEOUT_MS}ms`),
              ),
            SMOKE_TEST_OVERALL_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      this._running = false;
      this.logger.error(`Smoke test suite error: ${err.message}`);
      return {
        passed: [],
        failed: [],
        results: [],
        duration: 0,
        trigger: trigger || 'manual',
        version: version || null,
        timestamp: new Date().toISOString(),
        error: err.message,
      };
    }
  }

  async _testCliBinary() {
    const name = 'cli-binary';
    try {
      const result = await this._spawnWithTimeout(
        process.env.CLAUDE_PATH || 'claude',
        ['--version'],
        SMOKE_CLI_TIMEOUT_MS,
      );
      const versionMatch = result.stdout.match(/\d+\.\d+\.\d+/);
      if (result.exitCode === 0 && versionMatch) {
        return { name, status: 'pass', version: versionMatch[0], duration: result.duration };
      }
      return {
        name,
        status: 'fail',
        error: `exit=${result.exitCode}, output=${result.stdout.slice(0, 200)}`,
        duration: result.duration,
      };
    } catch (err) {
      return { name, status: 'fail', error: err.message };
    }
  }

  async _testStreamJson() {
    const name = 'stream-json';
    try {
      const profile = this.claudeService?.getCcsProfile();
      const env = { ...process.env, FORCE_COLOR: '0' };
      if (profile) {
        env.CLAUDE_CONFIG_DIR = path.join(CCS_INSTANCES_DIR, profile);
      }
      const claudePath = process.env.CLAUDE_PATH || 'claude';
      const result = await this._spawnWithTimeout(
        claudePath,
        ['-p', 'ok', '--output-format', 'stream-json', '--max-turns', '1'],
        SMOKE_STREAM_TIMEOUT_MS,
        env,
      );

      // Parse stream-json events (newline-delimited JSON)
      const events = result.stdout
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const hasSystem = events.some((e) => e.type === 'system' && e.session_id);
      const hasAssistant = events.some((e) => e.type === 'assistant');
      const hasResult = events.some((e) => e.type === 'result' && 'subtype' in e);

      if (hasSystem && hasAssistant && hasResult) {
        return { name, status: 'pass', eventCount: events.length, duration: result.duration };
      }
      return {
        name,
        status: 'fail',
        error: `Missing events: system=${hasSystem} assistant=${hasAssistant} result=${hasResult}`,
        eventTypes: events.map((e) => e.type),
        duration: result.duration,
      };
    } catch (err) {
      return { name, status: 'fail', error: err.message };
    }
  }

  async _testPtyUsage() {
    const name = 'pty-usage';
    try {
      if (!this.rateLimitService) {
        return { name, status: 'fail', error: 'rateLimitService not available' };
      }

      const startTime = Date.now();
      const result = await Promise.race([
        this.rateLimitService.capture({ forceRefresh: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), SMOKE_PTY_TIMEOUT_MS),
        ),
      ]);
      const duration = Date.now() - startTime;

      // Check if any profile returned non-null data with expected fields
      if (result && typeof result === 'object') {
        const profiles = Object.keys(result);
        const hasValidData = profiles.some((p) => {
          const d = result[p]?.data || result[p];
          return d && (d.session || d.weekly);
        });
        if (hasValidData) {
          return { name, status: 'pass', profiles: profiles.length, duration };
        }
      }
      return { name, status: 'fail', error: 'No valid rate limit data captured', duration };
    } catch (err) {
      return { name, status: 'fail', error: err.message };
    }
  }

  _spawnWithTimeout(command, args, timeoutMs, env) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const child = spawn(command, args, {
        env: env || process.env,
        windowsHide: true,
        shell: true,
      });

      this._activeProcesses.push(child);

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        this._activeProcesses = this._activeProcesses.filter((p) => p !== child);
        resolve({ stdout, stderr, exitCode: code, duration: Date.now() - startTime });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this._activeProcesses = this._activeProcesses.filter((p) => p !== child);
        reject(err);
      });
    });
  }

  _sendAlert(result) {
    const { failed, version } = result;
    const failCount = failed.length;

    // Email
    if (this.emailService) {
      const recommendations = {
        'cli-binary': 'claude.exe パス破損、再インストール必要',
        'stream-json': 'APIフォーマット変更、streamParser.js 要更新',
        'pty-usage': 'trust promptまたはTUI変更、PTYキャプチャコード要更新',
      };

      const rows = failed
        .map(
          (f) =>
            `<tr><td>${f.name}</td><td style="color:red">FAIL</td><td>${f.error || ''}</td><td>${recommendations[f.name] || ''}</td></tr>`,
        )
        .join('');

      const html = [
        `<h2>Smoke Test Failed</h2>`,
        `<p>Version: ${version || 'unknown'}, Trigger: ${result.trigger || 'manual'}, Duration: ${Math.round(result.duration / 1000)}s</p>`,
        `<table border="1" cellpadding="4"><tr><th>Test</th><th>Status</th><th>Error</th><th>Action</th></tr>${rows}</table>`,
        `<p style="color:#999;font-size:12px">${new Date().toISOString()}</p>`,
      ].join('\n');

      this.emailService
        .sendHtml(`[SMOKE FAIL] Claude Code ${version || '?'} - ${failCount} test(s) failed`, html)
        .catch((err) => this.logger.error(`Alert email failed: ${err.message}`));
    }

    // WebSocket broadcast
    if (this.logStreamer) {
      this.logStreamer.broadcastAll({
        type: 'smoke-test-fail',
        version,
        failCount,
        failed: failed.map((f) => ({ name: f.name, error: f.error })),
        timestamp: new Date().toISOString(),
      });
    }

    // Run Claude analysis (same pattern as changelog analysis in updateWatcherService)
    if (this.claudeService) {
      const prompt = this._buildAnalysisPrompt(result);
      this.claudeService.executeUpdateAnalysis(prompt, (execution, exitCode) => {
        const analysis = exitCode === 0 ? execution.lastAssistantText : null;
        if (analysis && this.emailService) {
          this.emailService
            .sendHtml(
              `[SMOKE ANALYSIS] Claude Code ${version || '?'} - diagnosis`,
              this._buildAnalysisHtml(result, analysis),
            )
            .catch((err) => this.logger.error(`Analysis email failed: ${err.message}`));
        }
        this.logger.info(`Smoke test analysis complete: exit=${exitCode}`);
      });
    }
  }

  _buildAnalysisPrompt(result) {
    const { failed, version, trigger } = result;
    const failDetails = failed.map((f) => `- ${f.name}: ${f.error || 'unknown error'}`).join('\n');

    return `Claude Code ${version || '不明'} のスモークテストが失敗しました (trigger: ${trigger})。
以下の失敗を分析し、原因と対処法を報告してください。

## 失敗したテスト
${failDetails}

## テストの意味
- cli-binary: claude --version の実行確認（バイナリ存在・パス）
- stream-json: claude -p "ok" --output-format stream-json の出力形式確認（system/assistant/result イベント順序）
- pty-usage: PTY経由の /usage TUI キャプチャ確認（trust prompt、TUI変更検出）

## Dashboard コードベースへの影響
失敗したテストに関連する dashboard コードを特定し、修正が必要な箇所を具体的に指摘してください:
- stream-json 失敗 → backend/src/services/streamParser.js のパーサー
- pty-usage 失敗 → backend/src/services/workers/ptyCapture.js, ratelimitService.js のPTYキャプチャ
- cli-binary 失敗 → claude.exe パス設定、環境変数

回答形式:
- ROOT_CAUSE: 推定原因
- AFFECTED_FILES: 修正が必要なファイルリスト
- RECOMMENDED_FIX: 具体的な修正手順
- URGENCY: CRITICAL / HIGH / MEDIUM / LOW`;
  }

  _buildAnalysisHtml(result, analysis) {
    const escape = (s) =>
      (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return [
      `<h2>Smoke Test Failure Analysis</h2>`,
      `<p>Version: ${escape(result.version || 'unknown')}, Trigger: ${escape(result.trigger || 'manual')}</p>`,
      `<h3>Analysis</h3>`,
      `<pre style="white-space:pre-wrap">${escape(analysis)}</pre>`,
      `<p style="color:#999;font-size:12px">${new Date().toISOString()}</p>`,
    ].join('\n');
  }

  isRunning() {
    return this._running;
  }

  getLastResult() {
    return this._lastResult;
  }

  stop() {
    // Kill only directly-owned child processes (cli-binary spawn, stream-json spawn)
    // pty-usage delegates to rateLimitService.capture() which has its own cleanup
    for (const proc of this._activeProcesses) {
      try {
        proc.kill();
      } catch {}
    }
    this._activeProcesses = [];
  }
}
