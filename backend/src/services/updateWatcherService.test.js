import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    exec: vi.fn(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync: vi.fn(actual.existsSync ?? actual.default?.existsSync),
    },
    existsSync: vi.fn(actual.existsSync),
  };
});

import { exec } from 'child_process';
import fs from 'fs';
import { UpdateWatcherService } from './updateWatcherService.js';

function makeMockEmailService() {
  return {
    sendHtml: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockLogStreamer() {
  return {
    broadcastAll: vi.fn(),
  };
}

function makeMockClaudeService(
  exitCode = 0,
  lastAssistantText = 'DASHBOARD_IMPACT: LOW\nPROJECT_IMPACT: LOW\nIMPACT: LOW\n- No breaking changes',
) {
  return {
    executeUpdateAnalysis: vi.fn((prompt, onComplete) => {
      const executionId = 'exec-123';
      // Simulate async completion
      process.nextTick(() => {
        onComplete({ lastAssistantText, sessionId: 'sess-abc' }, exitCode);
      });
      return executionId;
    }),
  };
}

const SAMPLE_RAW_SOURCE = [
  'From: notifications@github.com\r\n',
  'Subject: [anthropics/claude-code] Release v1.2.3 - v1.2.3\r\n',
  'Content-Transfer-Encoding: quoted-printable\r\n',
  '\r\n',
  '## What=E2=80=99s changed\r\n',
  '\r\n',
  '* Fixed stream-json output format\r\n',
  '* Added new --verbose flag\r\n',
  '\r\n',
  '--\r\n',
  'You are receiving this because you are subscribed.\r\n',
].join('');

describe('UpdateWatcherService', () => {
  let emailService;
  let logStreamer;
  let claudeService;

  beforeEach(() => {
    emailService = makeMockEmailService();
    logStreamer = makeMockLogStreamer();
    claudeService = makeMockClaudeService();
  });

  describe('_extractChangelog', () => {
    it('extracts "What\'s changed" section from quoted-printable email', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const changelog = service._extractChangelog(SAMPLE_RAW_SOURCE);

      expect(changelog).toContain('What');
      expect(changelog).toContain('Fixed stream-json output format');
      expect(changelog).toContain('Added new --verbose flag');
      expect(changelog).not.toContain('You are receiving this');
    });

    it('decodes quoted-printable =XX sequences', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const raw = 'Subject: test\r\n\r\n## What=E2=80=99s changed\r\n\r\n* Item\r\n';
      const changelog = service._extractChangelog(raw);

      // =E2=80=99 is UTF-8 for right single quote
      expect(changelog).toContain('\u2019s changed');
    });

    it('handles soft line breaks in quoted-printable', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const raw =
        "Subject: test\r\n\r\n## What's changed\r\n\r\n* Long line that is =\r\ncontinued here\r\n";
      const changelog = service._extractChangelog(raw);

      expect(changelog).toContain('Long line that is continued here');
    });

    it('returns null for null/empty input', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });

      expect(service._extractChangelog(null)).toBeNull();
      expect(service._extractChangelog('')).toBeNull();
    });

    it('returns body content when no "What\'s changed" heading found', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const raw = 'Subject: test\r\n\r\nSome release notes here\r\n';
      const changelog = service._extractChangelog(raw);

      expect(changelog).toBe('Some release notes here');
    });

    it('handles Buffer input', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const changelog = service._extractChangelog(Buffer.from(SAMPLE_RAW_SOURCE));

      expect(changelog).toContain('Fixed stream-json output format');
    });
  });

  describe('_extractImpact', () => {
    it('extracts HIGH impact', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      expect(service._extractImpact('IMPACT: HIGH\nSome details')).toBe('HIGH');
    });

    it('extracts LOW impact case-insensitive', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      expect(service._extractImpact('impact: low')).toBe('LOW');
    });

    it('returns UNKNOWN for missing analysis', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      expect(service._extractImpact(null)).toBe('UNKNOWN');
    });

    it('returns UNKNOWN when no IMPACT line found', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      expect(service._extractImpact('No impact line here')).toBe('UNKNOWN');
    });
  });

  describe('handleRelease', () => {
    it('delegates analysis to claudeService.executeUpdateAnalysis', async () => {
      const service = new UpdateWatcherService({ emailService, logStreamer, claudeService });

      await service.handleRelease('v1.2.3', 'https://github.com/...', SAMPLE_RAW_SOURCE);

      expect(claudeService.executeUpdateAnalysis).toHaveBeenCalledWith(
        expect.stringContaining('v1.2.3'),
        expect.any(Function),
      );
      expect(service._lastExecutionId).toBe('exec-123');
    });

    it('sends email via onComplete callback after analysis', async () => {
      const service = new UpdateWatcherService({ emailService, logStreamer, claudeService });

      await service.handleRelease('v1.2.3', 'url', SAMPLE_RAW_SOURCE);
      // Wait for nextTick callback
      await new Promise((r) => setTimeout(r, 10));

      expect(emailService.sendHtml).toHaveBeenCalledWith(
        expect.stringContaining('D:LOW'),
        expect.any(String),
      );
    });

    it('clears _analyzing flag on completion', async () => {
      const service = new UpdateWatcherService({ emailService, logStreamer, claudeService });

      await service.handleRelease('v1.2.3', 'url', SAMPLE_RAW_SOURCE);
      expect(service._analyzing).toBe(true); // still analyzing before callback

      await new Promise((r) => setTimeout(r, 10));
      expect(service._analyzing).toBe(false);
    });

    it('skips duplicate version', async () => {
      const service = new UpdateWatcherService({ emailService, logStreamer, claudeService });

      await service.handleRelease('v1.2.3', 'url', SAMPLE_RAW_SOURCE);
      claudeService.executeUpdateAnalysis.mockClear();

      await service.handleRelease('v1.2.3', 'url', SAMPLE_RAW_SOURCE);

      expect(claudeService.executeUpdateAnalysis).not.toHaveBeenCalled();
    });

    it('sends URL-only notification when changelog extraction fails', async () => {
      const service = new UpdateWatcherService({ emailService, logStreamer, claudeService });

      await service.handleRelease('v1.2.3', 'url', null);

      expect(emailService.sendHtml).toHaveBeenCalledWith(
        expect.stringContaining('UNKNOWN'),
        expect.any(String),
      );
      expect(claudeService.executeUpdateAnalysis).not.toHaveBeenCalled();
    });

    it('sends email with UNKNOWN impact when analysis fails (non-zero exit)', async () => {
      const failingClaude = makeMockClaudeService(1, '');
      const service = new UpdateWatcherService({
        emailService,
        logStreamer,
        claudeService: failingClaude,
      });

      await service.handleRelease('v1.2.3', 'url', SAMPLE_RAW_SOURCE);
      await new Promise((r) => setTimeout(r, 10));

      expect(emailService.sendHtml).toHaveBeenCalledWith(
        expect.stringContaining('D:UNKNOWN'),
        expect.stringContaining('Analysis unavailable'),
      );
    });

    it('guards against concurrent analysis', async () => {
      // Create a claude service that never calls back
      const hangingClaude = {
        executeUpdateAnalysis: vi.fn(() => 'exec-hang'),
      };
      const service = new UpdateWatcherService({
        emailService,
        logStreamer,
        claudeService: hangingClaude,
      });

      await service.handleRelease('v1.0.0', 'url', SAMPLE_RAW_SOURCE);
      expect(service._analyzing).toBe(true);

      // Try second release while first is analyzing
      await service.handleRelease('v2.0.0', 'url', SAMPLE_RAW_SOURCE);

      expect(hangingClaude.executeUpdateAnalysis).toHaveBeenCalledTimes(1);
      expect(service._lastVersion).toBe('v1.0.0'); // v2.0.0 was skipped
    });

    it('handles missing claudeService gracefully', async () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });

      await service.handleRelease('v1.2.3', 'url', SAMPLE_RAW_SOURCE);

      // Falls back to URL-only notification
      expect(emailService.sendHtml).toHaveBeenCalled();
      expect(service._analyzing).toBe(false);
    });
  });

  describe('getLastUpdate / isAnalyzing', () => {
    it('returns initial state', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });

      expect(service.getLastUpdate()).toEqual({
        version: null,
        binaryVersion: null,
        analyzing: false,
        executionId: null,
      });
      expect(service.isAnalyzing()).toBe(false);
    });

    it('returns version and executionId after processing', async () => {
      const service = new UpdateWatcherService({ emailService, logStreamer, claudeService });

      await service.handleRelease('v1.2.3', 'url', SAMPLE_RAW_SOURCE);
      await new Promise((r) => setTimeout(r, 10));

      const update = service.getLastUpdate();
      expect(update.version).toBe('v1.2.3');
      expect(update.executionId).toBe('exec-123');
      expect(update.analyzing).toBe(false);
    });
  });

  describe('_extractDetailedImpact', () => {
    it('extracts all three impact levels', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const result = service._extractDetailedImpact(
        'DASHBOARD_IMPACT: HIGH\nPROJECT_IMPACT: MEDIUM\nIMPACT: HIGH\nDetails',
      );

      expect(result).toEqual({ dashboard: 'HIGH', project: 'MEDIUM', overall: 'HIGH' });
    });

    it('returns UNKNOWN for missing analysis', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const result = service._extractDetailedImpact(null);

      expect(result).toEqual({ dashboard: 'UNKNOWN', project: 'UNKNOWN', overall: 'UNKNOWN' });
    });

    it('handles partial impact lines', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const result = service._extractDetailedImpact('DASHBOARD_IMPACT: LOW\nIMPACT: LOW');

      expect(result.dashboard).toBe('LOW');
      expect(result.project).toBe('UNKNOWN');
      expect(result.overall).toBe('LOW');
    });
  });

  describe('_buildEmailHtml', () => {
    it('includes version, impact badges, analysis and changelog', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const impacts = { dashboard: 'HIGH', project: 'LOW', overall: 'HIGH' };
      const html = service._buildEmailHtml(
        'v1.2.3',
        'HIGH',
        '* changes',
        'IMPACT: HIGH\nDetails',
        impacts,
      );

      expect(html).toContain('v1.2.3');
      expect(html).toContain('Dashboard: HIGH');
      expect(html).toContain('Project: LOW');
      expect(html).toContain('#dc3545'); // HIGH color
      expect(html).toContain('Details');
      expect(html).toContain('* changes');
    });

    it('falls back to single badge when impacts not provided', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const html = service._buildEmailHtml('v1.2.3', 'UNKNOWN', '* changes', null);

      expect(html).toContain('UNKNOWN');
      expect(html).toContain('Analysis unavailable');
    });

    it('escapes HTML in content', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const html = service._buildEmailHtml('v1.2.3', 'LOW', '* <script>alert(1)</script>', 'safe');

      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  describe('_buildAnalysisPrompt', () => {
    it('includes version and changelog in prompt', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const prompt = service._buildAnalysisPrompt('v1.2.3', '* Fixed bug');

      expect(prompt).toContain('v1.2.3');
      expect(prompt).toContain('* Fixed bug');
      expect(prompt).toContain('stream-json');
      expect(prompt).toContain('DASHBOARD_IMPACT');
      expect(prompt).toContain('PROJECT_IMPACT');
    });

    it('includes project-level check items', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const prompt = service._buildAnalysisPrompt('v1.2.3', '* Changes');

      expect(prompt).toContain('agent-registry.md');
      expect(prompt).toContain('Skill / Plugin');
      expect(prompt).toContain('Windows / Git Bash / WSL');
      expect(prompt).toContain('CJK');
    });

    it('includes new feature adoption section', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      const prompt = service._buildAnalysisPrompt('v1.2.3', '* Changes');

      expect(prompt).toContain('活用機会');
      expect(prompt).toContain('活用提案');
    });
  });

  describe('start() / stop()', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('start() creates interval and stop() clears it', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      service._pollBinaryVersion = vi.fn();

      service.start();

      expect(service._versionPollInterval).not.toBeNull();
      expect(service._pollBinaryVersion).toHaveBeenCalledWith(true);

      vi.advanceTimersByTime(300000);
      expect(service._pollBinaryVersion).toHaveBeenCalledWith(false);

      service.stop();
      expect(service._versionPollInterval).toBeNull();
    });

    it('stop() clears _patchingTimeout if set', () => {
      const service = new UpdateWatcherService({ emailService, logStreamer });
      service._pollBinaryVersion = vi.fn();
      service.start();

      service._patchingTimeout = setTimeout(() => {}, 999999);

      service.stop();
      expect(service._versionPollInterval).toBeNull();
      expect(service._patchingTimeout).toBeNull();
    });
  });

  describe('_pollBinaryVersion', () => {
    beforeEach(() => {
      vi.mocked(exec).mockReset();
    });

    it('on version change: broadcasts event and calls _applyExistingPatch', async () => {
      vi.mocked(exec).mockImplementation((cmd, opts, cb) => {
        cb(null, '2.1.88 (Claude Code)', '');
      });

      const service = new UpdateWatcherService({ emailService, logStreamer });
      service._cachedBinaryVersion = '2.1.87';
      service._applyExistingPatch = vi.fn().mockReturnValue(true);

      await new Promise((resolve) => {
        service._pollBinaryVersion(false);
        process.nextTick(resolve);
      });

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'binary-version-changed',
          previous: '2.1.87',
          current: '2.1.88',
        }),
      );
      expect(service._cachedBinaryVersion).toBe('2.1.88');
      expect(service._applyExistingPatch).toHaveBeenCalledWith('2.1.88');
    });

    it('initial run caches version without triggering patch', async () => {
      vi.mocked(exec).mockImplementation((cmd, opts, cb) => {
        cb(null, '2.1.87 (Claude Code)', '');
      });

      const service = new UpdateWatcherService({ emailService, logStreamer });
      service._applyExistingPatch = vi.fn();
      service._triggerAndApplyPatch = vi.fn();

      await new Promise((resolve) => {
        service._pollBinaryVersion(true);
        process.nextTick(resolve);
      });

      expect(service._cachedBinaryVersion).toBe('2.1.87');
      expect(service._applyExistingPatch).not.toHaveBeenCalled();
      expect(service._triggerAndApplyPatch).not.toHaveBeenCalled();
      expect(logStreamer.broadcastAll).not.toHaveBeenCalled();
    });
  });

  describe('_applyExistingPatch', () => {
    beforeEach(() => {
      vi.mocked(exec).mockReset();
      vi.mocked(fs.existsSync).mockReset();
    });

    it('returns false when patch script does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const service = new UpdateWatcherService({ emailService, logStreamer });
      const result = service._applyExistingPatch('2.1.87');

      expect(result).toBe(false);
    });

    it('returns true and applies patch when script exists (dry-run OK)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(exec).mockImplementation((cmd, opts, cb) => {
        cb(null, 'dry-run OK', '');
      });

      const service = new UpdateWatcherService({ emailService, logStreamer });

      const result = service._applyExistingPatch('2.1.87');
      expect(result).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(logStreamer.broadcastAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'patch-applied',
          version: 'v2.1.87',
          executionId: null,
          source: 'binary-poll',
        }),
      );
    });

    it('falls back to _triggerAndApplyPatch when dry-run fails', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(exec).mockImplementation((cmd, opts, cb) => {
        cb(new Error('patch mismatch'), '', 'pattern not found');
      });

      const service = new UpdateWatcherService({ emailService, logStreamer });
      service._triggerAndApplyPatch = vi.fn();

      service._applyExistingPatch('2.1.87');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(service._triggerAndApplyPatch).toHaveBeenCalledWith('v2.1.87');
      expect(service._patching).toBe(false);
    });

    it('_patching guard prevents concurrent apply, returns true', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const service = new UpdateWatcherService({ emailService, logStreamer });
      service._patching = true;

      const result = service._applyExistingPatch('2.1.87');

      expect(result).toBe(true);
      expect(service._patching).toBe(true);
    });
  });
});
