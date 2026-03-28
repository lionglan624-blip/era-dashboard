import fs from 'fs';
import path from 'path';

// =============================================================================
// Auto-DR Snapshot Utilities (exported for testing)
// =============================================================================

/**
 * Check if startup cooldown is active and compute remaining time.
 * @param {number} startupTime - Process startup timestamp (ms)
 * @param {number} cooldownMs - Cooldown duration (ms)
 * @param {number} [nowMs=Date.now()] - Current time for testing
 * @returns {{ defer: boolean, remaining: number }}
 */
export function shouldDeferDuringCooldown(startupTime, cooldownMs, nowMs = Date.now()) {
  const elapsed = nowMs - startupTime;
  if (elapsed < cooldownMs) {
    return { defer: true, remaining: Math.max(0, cooldownMs - elapsed) };
  }
  return { defer: false, remaining: 0 };
}

/**
 * Save mtime snapshot of watched source files.
 * @param {string} srcDir - Source directory to scan (e.g., backend/src)
 * @param {string} serverJsPath - Path to server.js
 * @param {string} snapshotPath - Where to save the snapshot JSON
 */
export function saveAutoDRSnapshot(srcDir, serverJsPath, snapshotPath) {
  const files = {};
  const collectMtimes = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectMtimes(full);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        try {
          files[full] = fs.statSync(full).mtimeMs;
        } catch {
          // File disappeared between readdir and stat — skip
        }
      }
    }
  };
  collectMtimes(srcDir);
  try {
    files[serverJsPath] = fs.statSync(serverJsPath).mtimeMs;
  } catch {
    // server.js missing — unusual but don't crash
  }

  const dir = path.dirname(snapshotPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(snapshotPath, JSON.stringify(files));
}

/**
 * Compare current file mtimes against a saved snapshot.
 * Deletes the snapshot file after comparison.
 * @param {string} snapshotPath - Path to snapshot JSON
 * @returns {boolean} true if any file changed since snapshot
 */
export function compareAutoDRSnapshot(snapshotPath) {
  if (!fs.existsSync(snapshotPath)) return false;

  let changed = false;
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    for (const [filePath, savedMtime] of Object.entries(snapshot)) {
      try {
        const currentMtime = fs.statSync(filePath).mtimeMs;
        if (currentMtime !== savedMtime) {
          changed = true;
          break;
        }
      } catch {
        // File deleted or inaccessible — treat as changed
        changed = true;
        break;
      }
    }
  } catch {
    // Corrupt snapshot — treat as changed to trigger DR
    changed = true;
  }

  // Always clean up snapshot
  try {
    fs.unlinkSync(snapshotPath);
  } catch {
    // ignore
  }

  return changed;
}
