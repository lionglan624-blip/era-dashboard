/**
 * Input Wait Patterns
 *
 * Patterns that indicate the Claude CLI is waiting for user input.
 * Used to trigger Auto Handoff to terminal.
 */

// Patterns that indicate waiting for user input (y/n, Enter, etc.)
export const INPUT_WAIT_PATTERNS = [
  { pattern: /\(y\/n\)/i, description: 'y/n prompt' },
  { pattern: /\[y\/N\]/i, description: 'y/N prompt' },
  { pattern: /\[Y\/n\]/i, description: 'Y/n prompt' },
  { pattern: /Continue\?/i, description: 'Continue prompt' },
  { pattern: /Press Enter/i, description: 'Enter prompt' },
  { pattern: /Proceed\?/i, description: 'Proceed prompt' },
  { pattern: /\(yes\/no\)/i, description: 'yes/no prompt' },
];
