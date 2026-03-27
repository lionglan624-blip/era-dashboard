import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import { createLogger } from '../utils/logger.js';
import { nowJST, nowJSTISO } from '../utils/timeUtils.js';

const DEVKIT_ROOT = process.env.DEVKIT_ROOT || 'C:\\Era\\devkit';

export class UpdateWatcherService {
  constructor({ emailService, logStreamer, claudeService, smokeTestService } = {}) {
    this.logger = createLogger('update-watcher');
    this.emailService = emailService;
    this.logStreamer = logStreamer;
    this.claudeService = claudeService;
    this.smokeTestService = smokeTestService;

    this._lastVersion = null;
    this._analyzing = false;
    this._patching = false;
    this._patchingTimeout = null;
    this._lastExecutionId = null;
  }

  async handleRelease(version, releaseUrl, rawSource) {
    if (this._lastVersion === version) {
      this.logger.info(`Duplicate version ${version}, skipping`);
      return;
    }

    if (this._analyzing) {
      this.logger.warn(`Already analyzing, skipping ${version}`);
      return;
    }

    this._lastVersion = version;
    this.logger.info(`Processing release ${version}`);

    const changelog = this._extractChangelog(rawSource);
    if (!changelog) {
      this.logger.warn(`No changelog found for ${version}, sending URL-only notification`);
      await this._notifyNoChangelog(version);
      return;
    }

    const prompt = this._buildAnalysisPrompt(version, changelog);

    this._analyzing = true;

    if (!this.claudeService) {
      this.logger.error('claudeService not available, cannot analyze');
      this._analyzing = false;
      await this._notifyNoChangelog(version);
      return;
    }

    const executionId = this.claudeService.executeUpdateAnalysis(prompt, (execution, exitCode) => {
      this._analyzing = false;
      const analysis = exitCode === 0 ? execution.lastAssistantText : null;
      if (exitCode !== 0) {
        this.logger.error(`Analysis execution failed for ${version} (exit ${exitCode})`);
      }
      this._sendEmail(version, changelog, analysis);
      if (this.smokeTestService) {
        this.smokeTestService.runAll({ trigger: 'update', version }).catch((err) => {
          this.logger.error(`Smoke test failed: ${err.message}`);
        });
      }
      // Auto-trigger /patch-cc to generate binary patch script
      this._triggerAndApplyPatch(version);
    });

    this._lastExecutionId = executionId;
    this.logger.info(`Analysis execution started: ${executionId}`);
  }

  _extractChangelog(rawSource) {
    if (!rawSource) return null;

    const raw = typeof rawSource === 'string' ? rawSource : rawSource.toString('utf8');

    // Find text/plain part or use entire body
    let body = raw;
    const bodyStart = raw.indexOf('\r\n\r\n');
    if (bodyStart !== -1) {
      body = raw.substring(bodyStart + 4);
    }

    // Decode quoted-printable (soft line breaks =\r\n, then =XX byte sequences)
    body = body.replace(/=\r?\n/g, '');
    // Collect =XX sequences into byte arrays and decode as UTF-8
    body = body.replace(/((?:=[0-9A-Fa-f]{2})+)/g, (match) => {
      const bytes = [];
      for (const m of match.matchAll(/=([0-9A-Fa-f]{2})/g)) {
        bytes.push(parseInt(m[1], 16));
      }
      return Buffer.from(bytes).toString('utf8');
    });

    // Extract "What's changed" section
    // Try multiple heading patterns GitHub uses
    const patterns = [
      /##\s*What['\u2019]?s?\s*changed/i,
      /\*\*What['\u2019]?s?\s*changed\*\*/i,
      /What['\u2019]?s?\s*changed/i,
    ];

    let startIdx = -1;
    for (const pattern of patterns) {
      const match = body.search(pattern);
      if (match !== -1) {
        startIdx = match;
        break;
      }
    }

    if (startIdx === -1) {
      // No "What's changed" section found, use full body as changelog
      const cleaned = body
        .replace(/--[\s\S]*$/, '') // Strip email signature
        .replace(/Content-Type:.*$/gim, '')
        .replace(/Content-Transfer-Encoding:.*$/gim, '')
        .replace(/--[a-zA-Z0-9_\-.]+(--)?/g, '')
        .trim();
      return cleaned || null;
    }

    let section = body.substring(startIdx);

    // End at signature or next major section
    const endPatterns = [
      /\r?\n--\s*\r?\n/,
      /\r?\nYou are receiving this/,
      /\r?\nReply to this email/,
    ];
    for (const pattern of endPatterns) {
      const endMatch = section.search(pattern);
      if (endMatch !== -1) {
        section = section.substring(0, endMatch);
      }
    }

    return section.trim() || null;
  }

  _buildAnalysisPrompt(version, changelog) {
    return `Claude Code ${version} がリリースされました。以下の changelog を分析し、
3つの観点から影響を報告してください。

## 必須: 事前調査

分析の前に、以下のファイルを必ず Read ツールで読んでください。
読まずに推測で回答することは禁止です。

1. **HANDOFF.md** (必須): C:\\Era\\dashboard\\HANDOFF.md — Dashboard の全体仕様・アーキテクチャ・実装詳細。
   これを読まずに Dashboard 影響を判断することはできません。全文読んでください。
2. **streamParser.js**: C:\\Era\\dashboard\\backend\\src\\utils\\streamParser.js — stream-json パース実装
3. **claudeService.js**: C:\\Era\\dashboard\\backend\\src\\services\\claudeService.js — Claude CLI 呼び出し・実行管理
4. **Skills ディレクトリ**: C:\\Era\\devkit\\.claude\\skills/ 配下の SKILL.md — 現行スキル定義
5. **agent-registry.md**: C:\\Era\\devkit\\.claude\\reference\\agent-registry.md — サブエージェント定義・モデルテーブル

changelog の各項目について、上記の実コードを確認した上で影響の有無を判断してください。
「影響なし」と判断する場合も、該当コードのどの部分を確認して判断したか明記してください。

## A. Dashboard 影響 (feature-dashboard: Claude Code 自動化ダッシュボード)

重点チェック項目:
1. stream-json 出力フォーマットの変更 (streamParser.js でパース)
2. --resume / --output-format / -p CLI フラグの変更
3. AskUserQuestion / tool_use 検出の変更
4. 終了コード挙動の変更
5. レート制限 / コンテキストウィンドウの変更
6. 破壊的変更

## B. devkit プロジェクト影響 (ワークフロー・設定・開発環境)

重点チェック項目:
1. モデル廃止・追加・ID変更 (agent-registry.md のモデルテーブル)
2. Skill / Plugin システムの変更 (読み込み、frontmatter、検索)
3. Subagent / Task / Agent ツールの挙動変更
4. auto-memory / CLAUDE.md / .claude/ 設定の変更
5. Windows / Git Bash / WSL 固有の修正・変更
6. Bash ツール / ToolSearch / Read / Edit 等の組み込みツール変更
7. git 操作・hook・commit 関連の変更
8. compaction / context window 管理の変更
9. CJK / 日本語テキスト処理の変更

## C. 新機能の活用機会

追加された新機能・新コマンド・新設定のうち、このプロジェクトで活用できるものを提案してください:
- ワークフロー効率化（新コマンド、新設定オプション）
- Dashboard 機能拡張に使える新API・新イベント
- 開発体験改善（エディタ連携、デバッグ、パフォーマンス）
- subagent/skill/plugin の新しい使い方

Changelog:
${changelog}

回答形式:
- DASHBOARD_IMPACT: HIGH / MEDIUM / LOW / NONE
- PROJECT_IMPACT: HIGH / MEDIUM / LOW / NONE
- IMPACT: HIGH / MEDIUM / LOW / NONE (総合)
- [Dashboard] 関連する変更のリスト（各項目に影響の説明と、確認した実コード箇所）
- [Project] 関連する変更のリスト（各項目に影響の説明と、確認した実コード箇所）
- [活用提案] 新機能の具体的な活用案（各項目に効果の説明）
- 推奨アクション（あれば）`;
  }

  async _notifyNoChangelog(version) {
    if (this.emailService) {
      const html = this._buildEmailHtml(version, 'UNKNOWN', null, null);
      try {
        await this.emailService.sendHtml(`Claude Code ${version} update (UNKNOWN impact)`, html);
      } catch (err) {
        this.logger.error(`Email notification failed: ${err.message}`);
      }
    }
    if (this.logStreamer) {
      this.logStreamer.broadcastAll({
        type: 'claude-code-update',
        version,
        impact: 'UNKNOWN',
        summary: 'Changelog extraction failed',
        timestamp: nowJSTISO(),
      });
    }
    // No changelog = higher risk of undocumented changes — run smoke test
    if (this.smokeTestService) {
      this.smokeTestService.runAll({ trigger: 'update-no-changelog', version }).catch((err) => {
        this.logger.error(`Smoke test failed: ${err.message}`);
      });
    }
    // Auto-trigger /patch-cc regardless of changelog availability
    this._triggerAndApplyPatch(version);
  }

  _sendEmail(version, changelog, analysis) {
    if (!this.emailService) return;

    const impacts = this._extractDetailedImpact(analysis);
    const subject = `Claude Code ${version} update (D:${impacts.dashboard} P:${impacts.project})`;
    const html = this._buildEmailHtml(version, impacts.overall, changelog, analysis, impacts);

    this.emailService.sendHtml(subject, html).catch((err) => {
      this.logger.error(`Email notification failed: ${err.message}`);
    });

    this.logger.info(
      `Release ${version} processed: dashboard=${impacts.dashboard} project=${impacts.project}`,
    );
  }

  _extractImpact(analysis) {
    if (!analysis) return 'UNKNOWN';
    // Prefer overall IMPACT (not prefixed by DASHBOARD_ or PROJECT_)
    const overall = analysis.match(/(?<![A-Z_])IMPACT:\s*(HIGH|MEDIUM|LOW|NONE)/i);
    return overall ? overall[1].toUpperCase() : 'UNKNOWN';
  }

  _extractDetailedImpact(analysis) {
    if (!analysis) return { dashboard: 'UNKNOWN', project: 'UNKNOWN', overall: 'UNKNOWN' };
    const dash = analysis.match(/DASHBOARD_IMPACT:\s*(HIGH|MEDIUM|LOW|NONE)/i);
    const proj = analysis.match(/PROJECT_IMPACT:\s*(HIGH|MEDIUM|LOW|NONE)/i);
    const overall = this._extractImpact(analysis);
    return {
      dashboard: dash ? dash[1].toUpperCase() : 'UNKNOWN',
      project: proj ? proj[1].toUpperCase() : 'UNKNOWN',
      overall,
    };
  }

  _buildEmailHtml(version, impact, changelog, analysis, impacts) {
    const impactColors = {
      HIGH: '#dc3545',
      MEDIUM: '#fd7e14',
      LOW: '#28a745',
      NONE: '#6c757d',
      UNKNOWN: '#6c757d',
    };
    const color = impactColors[impact] || impactColors.UNKNOWN;

    const escape = (s) =>
      (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const badge = (label, level) => {
      const c = impactColors[level] || impactColors.UNKNOWN;
      return `<span style="background:${c};color:white;padding:2px 8px;border-radius:4px;font-weight:bold;margin-right:6px">${label}: ${level}</span>`;
    };

    const parts = [`<h2>Claude Code ${escape(version)}</h2>`];

    if (impacts && impacts.dashboard) {
      parts.push(
        `<p>${badge('Dashboard', impacts.dashboard)}${badge('Project', impacts.project)}</p>`,
      );
    } else {
      parts.push(
        `<p><span style="background:${color};color:white;padding:2px 8px;border-radius:4px;font-weight:bold">${impact}</span></p>`,
      );
    }

    if (analysis) {
      parts.push(`<h3>Analysis</h3><pre style="white-space:pre-wrap">${escape(analysis)}</pre>`);
    } else {
      parts.push(`<p><em>Analysis unavailable (timeout or extraction failure)</em></p>`);
    }

    if (changelog) {
      parts.push(`<h3>Changelog</h3><pre style="white-space:pre-wrap">${escape(changelog)}</pre>`);
    }

    parts.push(`<p style="color:#999;font-size:12px">${nowJST()}</p>`);

    return parts.join('\n');
  }

  /** Auto-trigger /patch-cc and apply the generated script */
  _triggerAndApplyPatch(version) {
    if (!this.claudeService) {
      this.logger.warn('claudeService not available, cannot trigger patch-cc');
      return;
    }
    if (this._patching) {
      this.logger.warn(`Already patching, skipping patch for ${version}`);
      return;
    }
    this._patching = true;
    this._patchingTimeout = setTimeout(
      () => {
        if (this._patching) {
          this.logger.warn('_patching safety timeout reached (10m), resetting');
          this._patching = false;
        }
      },
      10 * 60 * 1000,
    );

    try {
      const executionId = this.claudeService.executeSlashCommand(
        'patch-cc',
        (execution, exitCode) => {
          this._patching = false;
          clearTimeout(this._patchingTimeout);

          if (exitCode !== 0) {
            this.logger.warn(`patch-cc exited ${exitCode} for ${version}, skipping apply`);
            return;
          }

          const scriptPath = path.join(DEVKIT_ROOT, '_out', 'tmp', `patch-claude-${version}.py`);
          if (!fs.existsSync(scriptPath)) {
            this.logger.warn(`Patch script not found: ${scriptPath}`);
            return;
          }

          // Dry-run first
          exec(
            `python "${scriptPath}" --dry-run`,
            { timeout: 60000, cwd: DEVKIT_ROOT },
            (err, stdout, stderr) => {
              if (err) {
                this.logger.error(`patch dry-run failed for ${version}: ${stderr || err.message}`);
                return;
              }
              this.logger.info(`patch dry-run OK for ${version}: ${stdout.trim()}`);

              // Apply
              exec(
                `python "${scriptPath}"`,
                { timeout: 60000, cwd: DEVKIT_ROOT },
                (applyErr, applyOut, applyStderr) => {
                  if (applyErr) {
                    this.logger.error(
                      `patch apply failed for ${version}: ${applyStderr || applyErr.message}`,
                    );
                    return;
                  }
                  this.logger.info(`patch applied for ${version}: ${applyOut.trim()}`);

                  if (this.logStreamer) {
                    this.logStreamer.broadcastAll({
                      type: 'patch-applied',
                      version,
                      executionId,
                      timestamp: nowJSTISO(),
                    });
                  }
                },
              );
            },
          );
        },
      );

      this.logger.info(`patch-cc triggered for ${version}: ${executionId}`);
      if (this.logStreamer) {
        this.logStreamer.broadcastAll({
          type: 'patch-cc-triggered',
          version,
          executionId,
          timestamp: nowJSTISO(),
        });
      }
    } catch (err) {
      this._patching = false;
      clearTimeout(this._patchingTimeout);
      this.logger.error(`patch-cc trigger failed: ${err.message}`);
    }
  }

  getLastUpdate() {
    return {
      version: this._lastVersion,
      analyzing: this._analyzing,
      executionId: this._lastExecutionId,
    };
  }

  isAnalyzing() {
    return this._analyzing;
  }
}
