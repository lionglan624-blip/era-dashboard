/**
 * Input Validation Functions
 *
 * Validation utilities to prevent command injection and ensure type safety.
 */

/**
 * Validate featureId to prevent command injection
 * @param {string|number} featureId - The feature ID to validate
 * @returns {string} - The validated feature ID as string
 * @throws {Error} - If featureId is invalid
 */
export function validateFeatureId(featureId) {
  const id = String(featureId);
  if (!/^\d+$/.test(id)) {
    throw new Error(`Invalid featureId: ${featureId}. Must be numeric.`);
  }
  return id;
}

/**
 * Validate command to prevent injection
 * @param {string} command - The command to validate (fc, fl, run)
 * @returns {string} - The validated command
 * @throws {Error} - If command is invalid
 */
export function validateCommand(command) {
  const allowed = ['fc', 'fl', 'run'];
  const cmd = String(command).toLowerCase();
  if (!allowed.includes(cmd)) {
    throw new Error(`Invalid command: ${command}. Must be one of: ${allowed.join(', ')}`);
  }
  return cmd;
}
