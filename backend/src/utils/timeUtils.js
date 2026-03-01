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
