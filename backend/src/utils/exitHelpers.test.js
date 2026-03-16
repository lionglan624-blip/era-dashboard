import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock logger before importing exitHelpers
vi.mock('./logger.js', () => ({
  serverLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process
const mockSpawn = vi.fn(() => ({ unref: vi.fn() }));
vi.mock('child_process', () => ({
  spawn: (...args) => mockSpawn(...args),
}));

// Import after mocks
const { exitWithPm2Update, setPm2UpdatePending, PM2_UPDATE_PENDING_PATH } =
  await import('./exitHelpers.js');
const { serverLog } = await import('./logger.js');

describe('exitHelpers', () => {
  let mockExit;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
  });

  describe('exitWithPm2Update', () => {
    it('calls process.exit without spawn when no pending flag', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      exitWithPm2Update(0);

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it('spawns detached pm2 update and deletes flag when pending', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

      exitWithPm2Update(0);

      expect(mockSpawn).toHaveBeenCalledWith(
        'cmd',
        ['/c', 'timeout /t 3 /nobreak >nul && pm2 update'],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
          shell: true,
          windowsHide: true,
        }),
      );
      expect(unlinkSpy).toHaveBeenCalledWith(PM2_UPDATE_PENDING_PATH);
      expect(mockExit).toHaveBeenCalledWith(0);

      unlinkSpy.mockRestore();
    });

    it('passes through exit code', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      exitWithPm2Update(1);

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('still exits on error', () => {
      vi.spyOn(fs, 'existsSync').mockImplementation(() => {
        throw new Error('disk error');
      });

      exitWithPm2Update(0);

      expect(serverLog.error).toHaveBeenCalledWith(expect.stringContaining('disk error'));
      expect(mockExit).toHaveBeenCalledWith(0);
    });
  });

  describe('setPm2UpdatePending', () => {
    it('writes flag file with expected version', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      setPm2UpdatePending('5.4.0');

      expect(mkdirSpy).toHaveBeenCalledWith(path.dirname(PM2_UPDATE_PENDING_PATH), {
        recursive: true,
      });
      expect(writeSpy).toHaveBeenCalledWith(
        PM2_UPDATE_PENDING_PATH,
        expect.stringContaining('"expectedVersion":"5.4.0"'),
      );

      mkdirSpy.mockRestore();
      writeSpy.mockRestore();
    });
  });
});
