/**
 * Phase Detection Utilities
 *
 * Functions for detecting and describing execution phases from log content.
 */

/**
 * Detect phase from log content
 * @param {string} content - Log content to analyze
 * @returns {{ phase: number, name: string } | null}
 */
export function detectPhase(content) {
  const patterns = [
    /PHASE[- ]?(\d+)[:\s-]*([^\n\r]*)/i,
    /Phase\s+(\d+)[:\s-]*([^\n\r]*)/i,
    /## Phase (\d+)[:\s-]*([^\n\r]*)/i,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      const phase = parseInt(match[1]);
      const name = (match[2] || '')
        .trim()
        .replace(/^[-:\s]+/, '')
        .trim();
      return { phase, name: name || getDefaultPhaseName(phase) };
    }
  }
  return null;
}

/**
 * Detect iteration from log content (e.g., "Iteration 3/10")
 * @param {string} content - Log content to analyze
 * @returns {number | null}
 */
export function detectIteration(content) {
  const pattern = /Iteration\s*(\d+)\s*\/\s*\d+/i;
  const match = content.match(pattern);
  if (match) {
    return parseInt(match[1]);
  }
  return null;
}

/**
 * Total phases per command (hardcoded, phases rarely change)
 * @param {string} command - Command name (run, fc, fl)
 * @returns {number | null}
 */
export function getTotalPhases(command) {
  const totals = { run: 10, fc: 7, fl: 8 };
  return totals[command] || null;
}

/**
 * Default phase names
 * @param {number} phase - Phase number
 * @returns {string}
 */
export function getDefaultPhaseName(phase) {
  const names = {
    0: 'Dependency Check',
    1: 'Investigation',
    2: 'Design',
    3: 'Implementation',
    4: 'Testing',
    5: 'Debugging',
    6: 'Verification',
    7: 'Post-Review',
  };
  return names[phase] || `Phase ${phase}`;
}
