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
const primaryLadder: Tier[] = [
  { modelName: PRIMARY_MODEL, device: 'webgpu', dtype: 'q4f16' },
  { modelName: PRIMARY_MODEL, device: 'webgpu', dtype: 'q8' },
  { modelName: PRIMARY_MODEL, device: 'webgpu', dtype: 'fp16' },
  { modelName: PRIMARY_MODEL, device: 'wasm', dtype: 'q8' },
];

export const PRIMARY_LADDER: Tier[] = [...primaryLadder];

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
