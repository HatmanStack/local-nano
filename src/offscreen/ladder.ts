/**
 * Pure fallback-ladder state machine (ADR-R6).
 *
 * On a model-LOAD failure the panel auto-walks an ordered list of tiers
 * (dtype/device combinations within the primary model). This module owns the
 * tier type, the primary model's ordered ladder (data), and a pure reducer that
 * decides the next action given the current ladder position and the last
 * attempt outcome. It also owns the small pure helper that maps a tier onto a
 * `TRANSFORMERS_CONFIG` shape (ADR-R2) so the `offscreen.ts` override logic has
 * a unit-testable core (offscreen.ts is not in the coverage set).
 *
 * No Chrome, polyfill, or timer dependency: tier list is data, the reducer is a
 * function. The panel (`src/session.ts`) wires this to the real transport
 * (warmup, recreate, persistence).
 */

import type { DeviceCapability } from './capability.js';

export interface Tier {
  modelName: string;
  device: 'webgpu' | 'wasm';
  dtype: string;
}

/** Stable equality/persistence key for a tier. */
export function tierKey(t: Tier): string {
  return `${t.modelName}|${t.device}|${t.dtype}`;
}

/**
 * The primary model. Unchanged by this plan (ADR-R8); matches the
 * `.env.json` default.
 */
export const PRIMARY_MODEL = 'onnx-community/gemma-4-E2B-it-ONNX';

/**
 * The ordered dtype/device ladder for the primary model (ADR-R7). Tier 0 must
 * equal the `.env.json` base (webgpu/q4f16). The list is built from a single
 * concat so Phase 3 can append the smaller-model ladder without rewriting this
 * module: `[...primaryLadder, ...optionalSmallerLadder]`.
 */
// `webgpu/fp16` was REMOVED from between webgpu/q8 and wasm/q8. fp16 is ~2x q8
// for this model, so on any device where q8 fails for memory it cannot succeed
// either — it only downloads/allocates multi-GB weights that never fit and
// churns, starving the wasm last resort. WebGPU implements GatherBlockQuantized
// (docs/models.md), so fp16 carried no op-compat justification here. gemma is
// now an opt-in pick (0.4.7); when it IS chosen and can't fit, this fails fast
// to wasm or the terminal bubble instead of hanging.
const primaryLadder: Tier[] = [
  { modelName: PRIMARY_MODEL, device: 'webgpu', dtype: 'q4f16' },
  { modelName: PRIMARY_MODEL, device: 'webgpu', dtype: 'q8' },
  { modelName: PRIMARY_MODEL, device: 'wasm', dtype: 'q8' },
];

export const PRIMARY_LADDER: Tier[] = [...primaryLadder];

/**
 * Build-time flag gating the smaller-model fallback rung (ADR-R8). DEFAULT OFF.
 *
 * WARNING: enabling this ships a live second model. It must NOT be flipped to
 * true until the candidate below has been manually smoke-vetted on WebGPU at
 * each of its tiers (CI cannot exercise WebGPU; see the manual WebGPU smoke
 * matrix, ROADMAP #6). The candidate is vetted on WASM only (see
 * `docs/models.md`, "Smaller-model fallback rung (gated)"). While off, the
 * capability classifier and `assembleLadder` are still built and unit-tested,
 * but `assembleLadder` returns the primary ladder unchanged, so live behavior
 * is identical to the primary-model-only path.
 */
export const SMALLER_MODEL_ENABLED = false;

/**
 * Read the smaller-model flag through a function seam so the panel can be
 * exercised with the rung both on and off in tests (`vi.spyOn`) without
 * flipping the production constant. Production always returns
 * `SMALLER_MODEL_ENABLED` (false).
 */
export function isSmallerModelEnabled(): boolean {
  return SMALLER_MODEL_ENABLED;
}

/**
 * The smaller-model fallback ladder (ADR-R8), held behind
 * `SMALLER_MODEL_ENABLED`. The candidate is `onnx-community/Qwen2.5-0.5B-Instruct`,
 * the smallest model `docs/models.md` reports as actually answering questions.
 * Tier 0 (wasm/q8) is the only combination `docs/models.md` confirms working for
 * this model. The webgpu/q4f16 rung is UNVETTED on WebGPU (the whole reason the
 * flag stays off) and is listed so the manual vetting task has a concrete target;
 * it must not ship live until that smoke vetting passes.
 */
export const SMALLER_MODEL_CANDIDATE: Tier[] = [
  // Vetted on WASM in docs/models.md ("Smallest model that actually answers").
  { modelName: 'onnx-community/Qwen2.5-0.5B-Instruct', device: 'wasm', dtype: 'q8' },
  // UNVETTED on WebGPU. Present only as the manual-vetting target (ROADMAP #6).
  { modelName: 'onnx-community/Qwen2.5-0.5B-Instruct', device: 'webgpu', dtype: 'q4f16' },
];

/**
 * Assemble the full tier ladder for a device (ADR-R8). The smaller-model rung
 * is gated: when disabled, the result is `PRIMARY_LADDER` unchanged regardless
 * of capability, so live behavior matches the primary-only path. When enabled,
 * the order depends on capability:
 *
 * - `weak`: the smaller ladder runs FIRST (a weak device should try the small
 *   model before the heavier primary), with the primary appended as a last
 *   resort so a weak device that can somehow run the primary still has a path.
 * - `capable`: the primary ladder runs first, the smaller ladder is appended as
 *   the final fallback (so a capable device that exhausts the whole primary
 *   ladder still drops to the small model).
 *
 * Pure: it only composes arrays. `nextAction`/`firstTierIndex` operate on any
 * `Tier[]`, so the assembled ladder feeds the existing reducer unchanged.
 */
export function assembleLadder(opts: {
  capability: DeviceCapability;
  smallerEnabled?: boolean;
}): Tier[] {
  const smallerEnabled = opts.smallerEnabled ?? SMALLER_MODEL_ENABLED;
  if (!smallerEnabled) return [...PRIMARY_LADDER];
  if (opts.capability === 'weak') {
    return [...SMALLER_MODEL_CANDIDATE, ...PRIMARY_LADDER];
  }
  return [...PRIMARY_LADDER, ...SMALLER_MODEL_CANDIDATE];
}

/**
 * Assemble the tier ladder for a CHOSEN catalog model (ADR-P1, P4, P5). The
 * picked model heads the walk so the existing reducer steps its dtypes/devices
 * first; the existing assembled ladder is appended as a last-resort fallback so
 * a chosen model that fails entirely still drops back to the working default.
 *
 * `entry` is the resolved catalog entry, passed structurally as `{ tiers }` so
 * this module needs no `catalog.ts` import and the two modules stay decoupled
 * (the caller in `session.ts` resolves the entry via `findCatalogEntry`).
 *
 * - `entry === null` (no preference / unknown id): returns exactly
 *   `assembleLadder({ capability, smallerEnabled })`, today's behavior (ADR-P4).
 * - `entry` whose tiers ARE the default ladder: the dedupe below collapses the
 *   appended duplicate, so the result equals the no-preference path. The
 *   explicit default and the no-preference path therefore produce the same
 *   ladder.
 * - a non-default `entry`: the chosen tiers come FIRST, then the assembled
 *   ladder, deduped by `tierKey` so no tier is listed twice.
 *
 * Pure: it only composes arrays. `nextAction`/`firstTierIndex` walk whatever
 * `Tier[]` they are handed, so the reducer is unchanged.
 */
export function assembleLadderForModel(opts: {
  entry: { tiers: Tier[] } | null;
  capability: DeviceCapability;
  smallerEnabled?: boolean;
}): Tier[] {
  const base = assembleLadder({
    capability: opts.capability,
    smallerEnabled: opts.smallerEnabled,
  });
  if (opts.entry === null) return base;

  // Chosen tiers head the walk; the assembled ladder follows as a last resort.
  // Dedupe by tierKey so the default model is not listed twice when the chosen
  // model overlaps the default ladder (the chosen-first ordering is preserved).
  const seen = new Set<string>();
  const ladder: Tier[] = [];
  for (const tier of [...opts.entry.tiers, ...base]) {
    const key = tierKey(tier);
    if (seen.has(key)) continue;
    seen.add(key);
    ladder.push(tier);
  }
  return ladder;
}

/** The outcome of a single tier load attempt (reducer input). */
export type LadderOutcome = 'success' | 'load-failure';

/** The next action the panel should take (reducer output). */
export type LadderAction =
  | { kind: 'load'; tier: Tier }
  | { kind: 'done'; tier: Tier }
  | { kind: 'exhausted' };

/**
 * Find the first index at or after `from` whose tier key is not known-bad.
 * Returns -1 when no such tier exists.
 */
function nextNonBadIndex(ladder: Tier[], from: number, knownBadKeys: ReadonlySet<string>): number {
  for (let i = from; i < ladder.length; i++) {
    if (!knownBadKeys.has(tierKey(ladder[i]))) return i;
  }
  return -1;
}

/**
 * Pure ladder reducer. Given the current position and the last attempt outcome,
 * return the next action.
 *
 * - Start (`attemptedIndex` and `outcome` both null): load the first
 *   non-known-bad tier, else `exhausted`.
 * - `success`: `done` with the attempted tier.
 * - `load-failure`: advance to the next non-known-bad tier after the attempted
 *   index, else `exhausted`.
 */
export function nextAction(args: {
  ladder: Tier[];
  attemptedIndex: number | null;
  outcome: LadderOutcome | null;
  knownBadKeys: ReadonlySet<string>;
}): LadderAction {
  const { ladder, attemptedIndex, outcome, knownBadKeys } = args;

  if (attemptedIndex === null && outcome === null) {
    const idx = nextNonBadIndex(ladder, 0, knownBadKeys);
    return idx === -1 ? { kind: 'exhausted' } : { kind: 'load', tier: ladder[idx] };
  }

  if (outcome === 'success') {
    // A success short-circuits with the attempted tier. attemptedIndex is
    // non-null on this branch (a success follows a load).
    const tier = ladder[attemptedIndex as number];
    return { kind: 'done', tier };
  }

  // load-failure: advance past the attempted index.
  const from = (attemptedIndex as number) + 1;
  const idx = nextNonBadIndex(ladder, from, knownBadKeys);
  return idx === -1 ? { kind: 'exhausted' } : { kind: 'load', tier: ladder[idx] };
}

/**
 * Resolve the starting index for a cold-start walk. With a persisted known-good
 * key present in the ladder, return that index so the walk skips straight to
 * the working tier. Otherwise return the first non-known-bad index, else -1
 * (exhausted). Pure.
 */
export function firstTierIndex(
  ladder: Tier[],
  knownGoodKey: string | null,
  knownBadKeys: ReadonlySet<string>,
): number {
  if (knownGoodKey !== null) {
    for (let i = 0; i < ladder.length; i++) {
      if (tierKey(ladder[i]) === knownGoodKey) return i;
    }
  }
  return nextNonBadIndex(ladder, 0, knownBadKeys);
}

/**
 * Map a tier onto a runtime `TRANSFORMERS_CONFIG` object (ADR-R2). Spreads the
 * base config (preserving `apiKey` and any other fields) and overrides
 * `modelName`, `device`, and `dtype` from the tier. Pure so the offscreen
 * override logic has a unit-testable core.
 */
export function applyTierToConfig(
  base: Record<string, unknown>,
  tier: Tier,
): Record<string, unknown> {
  return {
    ...base,
    modelName: tier.modelName,
    device: tier.device,
    dtype: tier.dtype,
  };
}
