/**
 * Pure download-progress parser (ADR-R10).
 *
 * The offscreen document forwards each polyfill `downloadprogress`
 * ProgressEvent's `loaded`/`total` over the progress port as a
 * `ProgressFrame` (framed in `protocol.ts`). This module turns the raw
 * numeric fields into a clamped, monotonic 0-100 integer percent plus the
 * text the panel renders. It takes the numeric fields (not the framed type)
 * so it stays a pure `src/` seam with no Chrome/protocol dependency and is
 * unit-testable without WebGPU.
 *
 * Phase split (the spec's deliberate seam): only the weights DOWNLOAD has a
 * real percentage. The GPU compile/upload phase is indeterminate. This parser
 * only reports the download percent. The panel decides when to switch to the
 * `'gpu-loading'` text: it shows `GPU_LOADING_TEXT` once the last download
 * frame hit 100 while the warmup promise is still pending. The parser never
 * parks a bar at 100 as the terminal state; it just reports the percent.
 */

/**
 * The two phases the panel renders. `'downloading'` is driven by the real
 * percent below; `'gpu-loading'` is the indeterminate phase the panel enters
 * after the percent reaches 100 but the warmup promise has not yet resolved.
 */
export type LoadPhase = 'downloading' | 'gpu-loading';

/** The reducer's carried state: the last reported (monotonic) percent. */
export interface ProgressState {
  percent: number;
}

/** Raw numeric fields from a `downloadprogress` ProgressEvent. */
export interface ProgressInput {
  loaded: number;
  total: number;
}

function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

/**
 * Pure reducer: fold one progress frame into the carried state.
 *
 * - `percent = clamp(round((loaded / total) * 100), 0, 100)` when `total > 0`
 *   and both fields are finite; otherwise hold the previous percent.
 * - Never decreases the reported percent. The polyfill already rounds and
 *   enforces monotonicity (`prompt-api-polyfill.js` `dispatchProgress`), but
 *   the port can reorder frames, so defend here too.
 */
export function nextProgress(state: ProgressState, frame: ProgressInput): ProgressState {
  const { loaded, total } = frame;
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) {
    return { percent: state.percent };
  }
  const computed = clampPercent((loaded / total) * 100);
  // Monotonic: never report a lower percent than already shown.
  return { percent: Math.max(state.percent, computed) };
}

/** The text shown during the indeterminate GPU compile/upload phase. */
export const GPU_LOADING_TEXT = 'Loading into GPU…';

/** Render the downloading-phase hint, e.g. `Downloading model 42%`. */
export function formatProgressText(percent: number): string {
  return `Downloading model ${percent}%`;
}
