import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { shouldDeferDuringCooldown, saveAutoDRSnapshot, compareAutoDRSnapshot } from './autoDR.js';

describe('Auto-DR utilities', () => {
  describe('shouldDeferDuringCooldown', () => {
    it('returns defer=true during cooldown with remaining time', () => {
      const startupTime = 1000;
      const cooldownMs = 10000;
      const nowMs = 5000; // 4s elapsed, 6s remaining
      const result = shouldDeferDuringCooldown(startupTime, cooldownMs, nowMs);
      expect(result.defer).toBe(true);
      expect(result.remaining).toBe(6000);
    });

    it('returns defer=false after cooldown expires', () => {
      const startupTime = 1000;
      const cooldownMs = 10000;
      const nowMs = 15000; // 14s elapsed
      const result = shouldDeferDuringCooldown(startupTime, cooldownMs, nowMs);
      expect(result.defer).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('remaining is never negative', () => {
      const startupTime = 1000;
      const cooldownMs = 10000;
      const nowMs = 10999; // Just under cooldown end
      const result = shouldDeferDuringCooldown(startupTime, cooldownMs, nowMs);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });

    it('returns defer=false at exact cooldown boundary', () => {
      const startupTime = 1000;
      const cooldownMs = 10000;
      const nowMs = 11000; // Exactly at boundary
      const result = shouldDeferDuringCooldown(startupTime, cooldownMs, nowMs);
      expect(result.defer).toBe(false);
    });
  });

  describe('saveAutoDRSnapshot', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodr-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('saves mtimes of .js files excluding test files', () => {
      // Create test structure
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'app.js'), 'code');
      fs.writeFileSync(path.join(srcDir, 'app.test.js'), 'test');
      const serverJs = path.join(tmpDir, 'server.js');
      fs.writeFileSync(serverJs, 'server');
      const snapshotPath = path.join(tmpDir, 'snapshot.json');

      saveAutoDRSnapshot(srcDir, serverJs, snapshotPath);

      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      const keys = Object.keys(snapshot);
      expect(keys.some((k) => k.endsWith('app.js'))).toBe(true);
      expect(keys.some((k) => k.endsWith('app.test.js'))).toBe(false);
      expect(keys.some((k) => k.endsWith('server.js'))).toBe(true);
    });

    it('excludes node_modules', () => {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir);
      fs.mkdirSync(path.join(srcDir, 'node_modules'));
      fs.writeFileSync(path.join(srcDir, 'node_modules', 'dep.js'), 'dep');
      fs.writeFileSync(path.join(srcDir, 'real.js'), 'real');
      const serverJs = path.join(tmpDir, 'server.js');
      fs.writeFileSync(serverJs, 'server');
      const snapshotPath = path.join(tmpDir, 'snapshot.json');

      saveAutoDRSnapshot(srcDir, serverJs, snapshotPath);

      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      const keys = Object.keys(snapshot);
      expect(keys.some((k) => k.includes('node_modules'))).toBe(false);
      expect(keys.some((k) => k.endsWith('real.js'))).toBe(true);
    });

    it('handles missing directory gracefully', () => {
      const snapshotPath = path.join(tmpDir, 'snapshot.json');
      const serverJs = path.join(tmpDir, 'server.js');
      fs.writeFileSync(serverJs, 'server');

      // srcDir doesn't exist
      expect(() => {
        saveAutoDRSnapshot(path.join(tmpDir, 'nonexistent'), serverJs, snapshotPath);
      }).not.toThrow();
    });

    it('includes server.js in snapshot', () => {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir);
      const serverJs = path.join(tmpDir, 'server.js');
      fs.writeFileSync(serverJs, 'server code');
      const snapshotPath = path.join(tmpDir, 'snapshot.json');

      saveAutoDRSnapshot(srcDir, serverJs, snapshotPath);

      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      expect(snapshot[serverJs]).toBeDefined();
      expect(typeof snapshot[serverJs]).toBe('number');
    });
  });

  describe('compareAutoDRSnapshot', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodr-cmp-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns true when mtime differs', () => {
      const filePath = path.join(tmpDir, 'file.js');
      fs.writeFileSync(filePath, 'original');
      const snapshotPath = path.join(tmpDir, 'snapshot.json');

      // Save snapshot with old mtime
      const snapshot = { [filePath]: fs.statSync(filePath).mtimeMs - 1000 };
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));

      expect(compareAutoDRSnapshot(snapshotPath)).toBe(true);
    });

    it('returns false when all mtimes match', () => {
      const filePath = path.join(tmpDir, 'file.js');
      fs.writeFileSync(filePath, 'content');
      const snapshotPath = path.join(tmpDir, 'snapshot.json');

      const snapshot = { [filePath]: fs.statSync(filePath).mtimeMs };
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));

      expect(compareAutoDRSnapshot(snapshotPath)).toBe(false);
    });

    it('returns false when snapshot file missing (no previous DR)', () => {
      const snapshotPath = path.join(tmpDir, 'nonexistent.json');
      expect(compareAutoDRSnapshot(snapshotPath)).toBe(false);
    });

    it('deletes snapshot after comparison', () => {
      const filePath = path.join(tmpDir, 'file.js');
      fs.writeFileSync(filePath, 'content');
      const snapshotPath = path.join(tmpDir, 'snapshot.json');

      const snapshot = { [filePath]: fs.statSync(filePath).mtimeMs };
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));

      compareAutoDRSnapshot(snapshotPath);
      expect(fs.existsSync(snapshotPath)).toBe(false);
    });

    it('returns true when a file was deleted since snapshot', () => {
      const snapshotPath = path.join(tmpDir, 'snapshot.json');
      const snapshot = { [path.join(tmpDir, 'deleted.js')]: 12345 };
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));

      expect(compareAutoDRSnapshot(snapshotPath)).toBe(true);
    });
  });
});
