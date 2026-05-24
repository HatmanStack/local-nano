/**
 * Single compile-time gate for diagnostic logging.
 *
 * Per-turn diagnostics (prompt/response lengths, timings, threshold
 * sizing) are useful while debugging but leak into the shared host-page
 * console on every turn in a normal build. Route them through `debugLog`
 * so a release build is quiet. `DEBUG` is a compile-time `const false`,
 * so esbuild tree-shakes the `console.log` branch out of production.
 *
 * Genuine failures stay on `console.error` / `console.warn` (always on)
 * and high-frequency selection diagnostics stay on `console.debug`.
 */
const DEBUG = false;

export function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}
