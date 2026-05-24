/**
 * Pure device-capability classifier (ADR-R9).
 *
 * Maps a `GpuInfoSnapshot` (the same snapshot the panel already queries via
 * `getGpuInfo`) to a coarse `'capable' | 'weak'` verdict so a weak device never
 * downloads a model it cannot run. The thresholds reuse the existing 1 GiB
 * max-buffer boundary from `preflightWarning` (`src/session.ts`), so the
 * codebase has ONE capability boundary rather than two that can drift apart.
 *
 * No Chrome, polyfill, or timer dependency: it takes a plain snapshot and
 * returns an enum, so it is unit-tested directly. While the smaller-model rung
 * stays disabled (ADR-R8) this verdict has no behavioral effect beyond the
 * diagnostic; it still selects the starting tier once the flag is enabled.
 */

import type { GpuInfoSnapshot } from './protocol.js';

/** Coarse device verdict driving starting-tier selection (ADR-R9). */
export type DeviceCapability = 'capable' | 'weak';

/**
 * The single capability boundary for the codebase: a non-fallback WebGPU
 * adapter whose max single-buffer allocation is below this is classified weak.
 * Equals 1 GiB, the same threshold `preflightWarning` uses, so the two stay in
 * lockstep.
 */
export const CAPABLE_MIN_BUFFER_BYTES = 1024 * 1024 * 1024;

/**
 * Classify a GPU snapshot per ADR-R9:
 *
 * - `wasm` device → `weak` (CPU path).
 * - `webgpu` with a software fallback adapter → `weak` (heavily constrained).
 * - `webgpu`, not fallback, a known `maxBufferSize` below 1 GiB → `weak`.
 * - otherwise → `capable` (including a `null` buffer on a real adapter, treated
 *   optimistically because the ladder will catch a genuine failure).
 */
export function classifyCapability(info: GpuInfoSnapshot): DeviceCapability {
  if (info.device === 'wasm') return 'weak';
  if (info.isFallback) return 'weak';
  if (info.maxBufferSize !== null && info.maxBufferSize < CAPABLE_MIN_BUFFER_BYTES) {
    return 'weak';
  }
  return 'capable';
}
