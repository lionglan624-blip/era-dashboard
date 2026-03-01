import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs module with importOriginal to keep other exports
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Mock child_process module
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

// Import mocked fs and child_process
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

// Import after mocking
import { getCcsDefaultProfile, getCcsProfiles } from './ccsUtils.js';

describe('getCcsDefaultProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('config file existence', () => {
    it('returns null when config file does not exist', () => {
      existsSync.mockReturnValue(false);

      expect(getCcsDefaultProfile()).toBeNull();
      expect(readFileSync).not.toHaveBeenCalled();
    });

    it('reads config file when it exists', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: my-profile');

      getCcsDefaultProfile();

      expect(readFileSync).toHaveBeenCalled();
    });
  });

  describe('parsing unquoted values', () => {
    it('parses simple unquoted value', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: my-profile');

      expect(getCcsDefaultProfile()).toBe('my-profile');
    });

    it('parses value with hyphen', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: my-profile-name');

      expect(getCcsDefaultProfile()).toBe('my-profile-name');
    });

    it('parses value with underscore', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: my_profile');

      expect(getCcsDefaultProfile()).toBe('my_profile');
    });

    it('handles trailing whitespace', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: my-profile   ');

      expect(getCcsDefaultProfile()).toBe('my-profile');
    });

    it('handles tabs after value', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: my-profile\t\t');

      expect(getCcsDefaultProfile()).toBe('my-profile');
    });
  });

  describe('parsing quoted values', () => {
    it('parses double-quoted value', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: "my-profile"');

      expect(getCcsDefaultProfile()).toBe('my-profile');
    });

    it('parses single-quoted value', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue("default: 'my-profile'");

      expect(getCcsDefaultProfile()).toBe('my-profile');
    });

    it('handles quoted value with trailing whitespace', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: "my-profile"   ');

      expect(getCcsDefaultProfile()).toBe('my-profile');
    });
  });

  describe('parsing with comments', () => {
    it('handles trailing comment after value', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: my-profile # this is a comment');

      expect(getCcsDefaultProfile()).toBe('my-profile');
    });

    it('handles trailing comment after quoted value', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: "my-profile" # comment');

      expect(getCcsDefaultProfile()).toBe('my-profile');
    });
  });

  describe('multiline config', () => {
    it('extracts default from multiline config', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(`# CCS Configuration
profiles:
  - name: dev
  - name: prod
default: my-profile
other: value`);

      expect(getCcsDefaultProfile()).toBe('my-profile');
    });

    it('ignores indented default key', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(`profiles:
  default: nested-value
default: top-level`);

      expect(getCcsDefaultProfile()).toBe('top-level');
    });
  });

  describe('missing or invalid default key', () => {
    it('returns null when no default key exists', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(`profiles:
  - dev
  - prod`);

      expect(getCcsDefaultProfile()).toBeNull();
    });

    it('returns null for empty config file', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('');

      expect(getCcsDefaultProfile()).toBeNull();
    });

    it('returns null when default has no value', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default:');

      expect(getCcsDefaultProfile()).toBeNull();
    });

    it('returns null when default value is empty quoted string', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: ""');

      expect(getCcsDefaultProfile()).toBeNull();
    });
  });

  describe('error handling', () => {
    it('returns null on read error (ENOENT)', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation(() => {
        const error = new Error('ENOENT: no such file or directory');
        error.code = 'ENOENT';
        throw error;
      });

      expect(getCcsDefaultProfile()).toBeNull();
    });

    it('returns null on read error (EACCES)', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation(() => {
        const error = new Error('EACCES: permission denied');
        error.code = 'EACCES';
        throw error;
      });

      expect(getCcsDefaultProfile()).toBeNull();
    });

    it('returns null on generic read error', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation(() => {
        throw new Error('Unknown error');
      });

      expect(getCcsDefaultProfile()).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles Windows line endings (CRLF)', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('other: value\r\ndefault: my-profile\r\n');

      expect(getCcsDefaultProfile()).toBe('my-profile');
    });

    it('handles numeric profile name', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: 12345');

      expect(getCcsDefaultProfile()).toBe('12345');
    });

    it('handles profile name with dots', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('default: profile.v1');

      expect(getCcsDefaultProfile()).toBe('profile.v1');
    });
  });
});

describe('getCcsProfiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns profiles from ccs auth list output with [OK] status', () => {
    const mockOutput = `┌──────────┬─────────┬──────────┐
│ Profile  │ Account │ Status   │
├──────────┼─────────┼──────────┤
│ apple    │ user1   │ [OK]     │
│ google   │ user2   │ [OK]     │
└──────────┴─────────┴──────────┘`;
    execSync.mockReturnValue(mockOutput);

    const result = getCcsProfiles();

    expect(result).toEqual(['apple', 'google']);
  });

  it('filters out profiles without [OK] status', () => {
    const mockOutput = `┌──────────┬─────────┬──────────┐
│ Profile  │ Account │ Status   │
├──────────┼─────────┼──────────┤
│ apple    │ user1   │ [OK]     │
│ stale    │ user2   │ [EXPIRED]│
│ google   │ user3   │ [OK]     │
└──────────┴─────────┴──────────┘`;
    execSync.mockReturnValue(mockOutput);

    const result = getCcsProfiles();

    expect(result).toEqual(['apple', 'google']);
  });

  it('returns empty array on execSync error (command not found)', () => {
    execSync.mockImplementation(() => {
      throw new Error('Command not found: ccs');
    });

    const result = getCcsProfiles();

    expect(result).toEqual([]);
  });

  it('returns empty array when no profiles have [OK] status', () => {
    const mockOutput = `┌──────────┬─────────┬──────────┐
│ Profile  │ Account │ Status   │
├──────────┼─────────┼──────────┤
│ stale1   │ user1   │ [EXPIRED]│
│ stale2   │ user2   │ [EXPIRED]│
└──────────┴─────────┴──────────┘`;
    execSync.mockReturnValue(mockOutput);

    const result = getCcsProfiles();

    expect(result).toEqual([]);
  });

  it('strips ANSI escape codes from output', () => {
    const mockOutput = `┌──────────┬─────────┬──────────┐
│ Profile  │ Account │ Status   │
├──────────┼─────────┼──────────┤
│ apple    │ user1   │ \x1b[32m[OK]\x1b[0m     │
│ google   │ user2   │ \x1b[32m[OK]\x1b[0m     │
└──────────┴─────────┴──────────┘`;
    execSync.mockReturnValue(mockOutput);

    const result = getCcsProfiles();

    expect(result).toEqual(['apple', 'google']);
  });
});
