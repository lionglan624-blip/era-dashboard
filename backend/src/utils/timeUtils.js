/**
 * Time Utility Functions
 *
 * Shared time formatting utilities used across services.
 */

/**
 * Get current time formatted as JST string: "YYYY/MM/DD HH:mm:ss JST"
 * @returns {string} JST formatted timestamp
 */
export function nowJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const min = String(jst.getUTCMinutes()).padStart(2, '0');
  const s = String(jst.getUTCSeconds()).padStart(2, '0');
  return `${y}/${m}/${d} ${h}:${min}:${s} JST`;
}

/**
 * Convert a Date (or current time) to ISO 8601 string with JST offset (+09:00).
 * Output: "2026-03-21T18:44:00.123+09:00"
 * Safe for new Date() parsing — epoch is preserved.
 * @param {Date} [date] - Date to convert (defaults to new Date())
 * @returns {string} ISO 8601 with +09:00 suffix
 */
export function toJSTISO(date) {
  const d = date || new Date();
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

/** Current time as JST ISO 8601 string. */
export function nowJSTISO() {
  return toJSTISO(new Date(Date.now()));
}

/** Convert epoch ms to JST ISO 8601 string. */
export function msToJSTISO(ms) {
  return toJSTISO(new Date(ms));
}
