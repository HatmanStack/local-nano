/**
 * Pure finalize-decision for the offscreen stream read loop (Layer C).
 *
 * When the offscreen stream handler's read loop ends, it must decide which
 * `StreamDone` frame to post back to the caller. There are three outcomes:
 *
 * 1. The stream was aborted (user pressed Stop, or the caller port dropped and
 *    the handler aborted its controller). Abort is user/transport initiated, so
 *    it is reported as `ok: false, error: 'aborted'` regardless of how many
 *    chunks were delivered first. An aborted stream is NOT a poisoned-session
 *    signal.
 * 2. The stream completed naturally but yielded ZERO chunks. The chunk count is
 *    the authoritative signal for a poisoned WebGPU session: ORT throws inside
 *    its WASM and Transformers.js swallows the throw, so the read loop sees no
 *    chunks and an undefined done flag, then exits cleanly. Without this signal
 *    the panel saw a "successful" empty stream and rendered "(no response)".
 *    Report it as `ok: false, error: POISONED_STREAM_ERROR` so the panel-side
 *    `classifyFailure` routes it through the existing reactive recovery path.
 * 3. The stream completed naturally and produced at least one chunk: `ok: true`.
 *
 * Extracted from `offscreen.ts` so the policy is unit-testable without loading
 * the offscreen entry (same seam pattern as `BusyGate`).
 */

import { STREAM_DONE, type StreamDone } from './protocol.js';

/**
 * Wire string emitted on a natural zero-chunk completion. Exported as a named
 * constant so `failure.ts`'s `TERMINAL_SIGNALS` matcher and any future caller
 * share one source of truth with the producer here.
 */
export const POISONED_STREAM_ERROR = 'no tokens emitted; session may be poisoned' as const;

/**
 * Decide the `StreamDone` frame to post when the read loop ends.
 *
 * - `aborted` true: `ok: false, error: 'aborted'` (chunk count ignored).
 * - otherwise `chunkCount === 0`: `ok: false, error: POISONED_STREAM_ERROR`.
 * - otherwise: `ok: true`.
 */
export function finalizeStreamDone(args: {
  id: string;
  aborted: boolean;
  chunkCount: number;
}): StreamDone {
  const { id, aborted, chunkCount } = args;
  if (aborted) {
    return { type: STREAM_DONE, id, ok: false, error: 'aborted' };
  }
  if (chunkCount === 0) {
    return { type: STREAM_DONE, id, ok: false, error: POISONED_STREAM_ERROR };
  }
  return { type: STREAM_DONE, id, ok: true };
}
