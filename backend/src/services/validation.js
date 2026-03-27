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
 * @param {string} command - The command to validate (fc, fl, run, imp)
 * @returns {string} - The validated command
 * @throws {Error} - If command is invalid
 */
export function validateCommand(command) {
  const allowed = ['fc', 'fl', 'run', 'imp'];
  const cmd = String(command).toLowerCase();
  if (!allowed.includes(cmd)) {
    throw new Error(`Invalid command: ${command}. Must be one of: ${allowed.join(', ')}`);
  }
  return cmd;
}

/**
 * Validate sessionId to ensure UUID format
 * @param {string} sessionId - The session ID to validate
 * @returns {string} - The validated session ID as string
 * @throws {Error} - If sessionId is not UUID format
 */
export function validateSessionId(sessionId) {
  const id = String(sessionId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Invalid sessionId: ${sessionId}. Must be UUID format.`);
  }
  return id;
}
