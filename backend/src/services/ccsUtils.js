/**
 * CCS (Claude Code Switch) Utilities
 *
 * Functions for reading and managing CCS profile configuration.
 */

import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { claudeLog } from '../utils/logger.js';
import { CCS_CONFIG_PATH } from '../config.js';

/**
 * Read CCS default profile from config.yaml (called on each spawn to track changes)
 * @returns {string|null} The default profile name, or null if not configured
 *
 * Limitations (simple regex-based parser):
 * - Expects `default:` at line start (ignores indented keys)
 * - Handles quoted ("profile") and unquoted (profile) values
 * - Does NOT handle: YAML anchors, multi-line values, or complex nesting
 * For this use case (single top-level key), regex is sufficient and avoids
 * adding a YAML parser dependency.
 */
export function getCcsDefaultProfile() {
  try {
    if (existsSync(CCS_CONFIG_PATH)) {
      const content = readFileSync(CCS_CONFIG_PATH, 'utf8');
      // Match: default: value, default: "value", or default: 'value'
      // ^default: ensures it's a top-level key (not indented)
      // Handles optional quotes and trailing whitespace/comments
      const match = content.match(/^default:\s*["']?([^"'\s#\n]+)["']?/m);
      return match?.[1] || null;
    }
  } catch (err) {
    claudeLog.error(`[CCS] Failed to read config.yaml: ${err.message}`);
  }
  return null;
}

/**
 * Get list of available CCS profiles from `ccs auth list`
 * @returns {string[]} Array of valid profile names (status [OK]), or empty array on error
 */
export function getCcsProfiles() {
  try {
    const output = execSync('ccs auth list', {
      encoding: 'utf8',
      timeout: 5000,
      shell: true,
      windowsHide: true,
    });

    // Strip ANSI escape codes
    const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, '');

    // Parse rows with [OK] status and extract profile names (first column)
    const profiles = [];
    const lines = cleanOutput.split('\n');

    for (const line of lines) {
      const match = line.match(/│\s+(\S+)\s+│.*\[OK\]/);
      if (match) {
        profiles.push(match[1]);
      }
    }

    return profiles;
  } catch (err) {
    claudeLog.error(`[CCS] Failed to run 'ccs auth list': ${err.message}`);
    return [];
  }
}
