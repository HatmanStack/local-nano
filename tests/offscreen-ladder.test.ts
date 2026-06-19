import { describe, expect, it } from 'vitest';
import {
  applyTierToConfig,
  assembleLadder,
  assembleLadderForModel,
  firstTierIndex,
  type LadderAction,
  nextAction,
  PRIMARY_LADDER,
  PRIMARY_MODEL,
  SMALLER_MODEL_CANDIDATE,
  SMALLER_MODEL_ENABLED,
  type Tier,
  tierKey,
} from '../src/offscreen/ladder.js';

const EMPTY: ReadonlySet<string> = new Set<string>();

describe('Tier / tierKey', () => {
  it('builds a stable model|device|dtype key', () => {
    const t: Tier = { modelName: 'org/model', device: 'webgpu', dtype: 'q4f16' };
    expect(tierKey(t)).toBe('org/model|webgpu|q4f16');
  });

  it('distinguishes tiers that differ only by dtype or device', () => {
    const a: Tier = { modelName: 'm', device: 'webgpu', dtype: 'q4f16' };
    const b: Tier = { modelName: 'm', device: 'webgpu', dtype: 'q8' };
    const c: Tier = { modelName: 'm', device: 'wasm', dtype: 'q8' };
    expect(tierKey(a)).not.toBe(tierKey(b));
    expect(tierKey(b)).not.toBe(tierKey(c));
  });
});

describe('PRIMARY_LADDER', () => {
  it('lists the ADR-R7 tiers in order, tier 0 = the .env.json base', () => {
    expect(PRIMARY_LADDER).toEqual([
      { modelName: PRIMARY_MODEL, device: 'webgpu', dtype: 'q4f16' },
      { modelName: PRIMARY_MODEL, device: 'webgpu', dtype: 'q8' },
      { modelName: PRIMARY_MODEL, device: 'wasm', dtype: 'q8' },
    ]);
  });

  it('uses the unchanged primary model identity', () => {
    expect(PRIMARY_MODEL).toBe('onnx-community/gemma-4-E2B-it-ONNX');
  });
});

describe('nextAction', () => {
  it('starts by loading tier 0 with an empty known-bad set', () => {
    const action = nextAction({
      ladder: PRIMARY_LADDER,
      attemptedIndex: null,
      outcome: null,
      knownBadKeys: EMPTY,
    });
    expect(action).toEqual({ kind: 'load', tier: PRIMARY_LADDER[0] });
  });

  it('skips a known-bad tier 0 at start and loads tier 1', () => {
    const knownBad = new Set([tierKey(PRIMARY_LADDER[0])]);
    const action = nextAction({
      ladder: PRIMARY_LADDER,
      attemptedIndex: null,
      outcome: null,
      knownBadKeys: knownBad,
    });
    expect(action).toEqual({ kind: 'load', tier: PRIMARY_LADDER[1] });
  });

  it('returns exhausted at start when every tier is known-bad', () => {
    const knownBad = new Set(PRIMARY_LADDER.map(tierKey));
    const action = nextAction({
      ladder: PRIMARY_LADDER,
      attemptedIndex: null,
      outcome: null,
      knownBadKeys: knownBad,
    });
    expect(action).toEqual({ kind: 'exhausted' });
  });

  it('short-circuits to done with the attempted tier on success', () => {
    const action = nextAction({
      ladder: PRIMARY_LADDER,
      attemptedIndex: 2,
      outcome: 'success',
      knownBadKeys: EMPTY,
    });
    expect(action).toEqual({ kind: 'done', tier: PRIMARY_LADDER[2] });
  });

  it('advances index 0 -> load index 1 on load-failure', () => {
    const action = nextAction({
      ladder: PRIMARY_LADDER,
      attemptedIndex: 0,
      outcome: 'load-failure',
      knownBadKeys: EMPTY,
    });
    expect(action).toEqual({ kind: 'load', tier: PRIMARY_LADDER[1] });
  });

  it('reports exhausted on a load-failure of the last tier', () => {
    const last = PRIMARY_LADDER.length - 1;
    const action = nextAction({
      ladder: PRIMARY_LADDER,
      attemptedIndex: last,
      outcome: 'load-failure',
      knownBadKeys: EMPTY,
    });
    expect(action).toEqual({ kind: 'exhausted' });
  });

  it('skips a known-bad next tier when advancing on load-failure', () => {
    // Tier 1 is known-bad; a failure on tier 0 jumps to tier 2.
    const knownBad = new Set([tierKey(PRIMARY_LADDER[1])]);
    const action = nextAction({
      ladder: PRIMARY_LADDER,
      attemptedIndex: 0,
      outcome: 'load-failure',
      knownBadKeys: knownBad,
    });
    expect(action).toEqual({ kind: 'load', tier: PRIMARY_LADDER[2] });
  });

  it('walks a full failure sequence down to exhausted', () => {
    let attemptedIndex: number | null = null;
    let outcome: 'success' | 'load-failure' | null = null;
    const loaded: Tier[] = [];
    for (let guard = 0; guard < 20; guard++) {
      const action: LadderAction = nextAction({
        ladder: PRIMARY_LADDER,
        attemptedIndex,
        outcome,
        knownBadKeys: EMPTY,
      });
      if (action.kind === 'exhausted') break;
      if (action.kind === 'done') throw new Error('unexpected done in all-fail walk');
      loaded.push(action.tier);
      attemptedIndex = PRIMARY_LADDER.indexOf(action.tier);
      outcome = 'load-failure';
    }
    expect(loaded).toEqual(PRIMARY_LADDER);
  });
});

describe('firstTierIndex', () => {
  it('returns the known-good index when the key is present', () => {
    const knownGoodKey = tierKey(PRIMARY_LADDER[2]);
    expect(firstTierIndex(PRIMARY_LADDER, knownGoodKey, EMPTY)).toBe(2);
  });

  it('returns the first non-bad index when there is no known-good', () => {
    expect(firstTierIndex(PRIMARY_LADDER, null, EMPTY)).toBe(0);
    const knownBad = new Set([tierKey(PRIMARY_LADDER[0]), tierKey(PRIMARY_LADDER[1])]);
    expect(firstTierIndex(PRIMARY_LADDER, null, knownBad)).toBe(2);
  });

  it('returns -1 when there is no known-good and every tier is known-bad', () => {
    const knownBad = new Set(PRIMARY_LADDER.map(tierKey));
    expect(firstTierIndex(PRIMARY_LADDER, null, knownBad)).toBe(-1);
  });

  it('falls back to the first non-bad index when the known-good key is not in the ladder', () => {
    expect(firstTierIndex(PRIMARY_LADDER, 'org/other|webgpu|q4f16', EMPTY)).toBe(0);
  });
});

describe('SMALLER_MODEL_ENABLED', () => {
  it('ships default-off (the live rung is dormant pending manual WebGPU vetting)', () => {
    expect(SMALLER_MODEL_ENABLED).toBe(false);
  });
});

describe('SMALLER_MODEL_CANDIDATE', () => {
  it('is the WASM-vetted candidate from docs/models.md at wasm/q8', () => {
    expect(SMALLER_MODEL_CANDIDATE[0]).toEqual({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
      device: 'wasm',
      dtype: 'q8',
    });
  });

  it('only names the documented candidate model across every rung', () => {
    for (const tier of SMALLER_MODEL_CANDIDATE) {
      expect(tier.modelName).toBe('onnx-community/Qwen2.5-0.5B-Instruct');
    }
  });
});

describe('assembleLadder', () => {
  it('returns exactly PRIMARY_LADDER when the flag is off, for a capable device', () => {
    expect(assembleLadder({ capability: 'capable', smallerEnabled: false })).toEqual(
      PRIMARY_LADDER,
    );
  });

  it('returns exactly PRIMARY_LADDER when the flag is off, for a weak device', () => {
    expect(assembleLadder({ capability: 'weak', smallerEnabled: false })).toEqual(PRIMARY_LADDER);
  });

  it('defaults to the production flag (off) when smallerEnabled is omitted', () => {
    // SMALLER_MODEL_ENABLED is false, so the default path is primary-only.
    expect(assembleLadder({ capability: 'weak' })).toEqual(PRIMARY_LADDER);
    expect(assembleLadder({ capability: 'capable' })).toEqual(PRIMARY_LADDER);
  });

  it('puts the smaller ladder FIRST for a weak device when the flag is on', () => {
    const ladder = assembleLadder({ capability: 'weak', smallerEnabled: true });
    expect(ladder).toEqual([...SMALLER_MODEL_CANDIDATE, ...PRIMARY_LADDER]);
  });

  it('appends the smaller ladder LAST for a capable device when the flag is on', () => {
    const ladder = assembleLadder({ capability: 'capable', smallerEnabled: true });
    expect(ladder).toEqual([...PRIMARY_LADDER, ...SMALLER_MODEL_CANDIDATE]);
  });

  it('produces a ladder nextAction walks to exhausted across all rungs', () => {
    const ladder = assembleLadder({ capability: 'weak', smallerEnabled: true });
    let attemptedIndex: number | null = null;
    let outcome: 'success' | 'load-failure' | null = null;
    const loaded: Tier[] = [];
    for (let guard = 0; guard < 50; guard++) {
      const action: LadderAction = nextAction({
        ladder,
        attemptedIndex,
        outcome,
        knownBadKeys: EMPTY,
      });
      if (action.kind === 'exhausted') break;
      if (action.kind === 'done') throw new Error('unexpected done in all-fail walk');
      loaded.push(action.tier);
      attemptedIndex = ladder.indexOf(action.tier);
      outcome = 'load-failure';
    }
    expect(loaded).toEqual(ladder);
  });
});

describe('assembleLadderForModel', () => {
  // The non-default chosen model used across these cases: Qwen2.5-0.5B at the
  // single wasm/q8 cell the catalog vets (a non-default entry's tier shape).
  const CHOSEN: Tier[] = [
    { modelName: 'onnx-community/Qwen2.5-0.5B-Instruct', device: 'wasm', dtype: 'q8' },
  ];

  it('a null entry returns exactly assembleLadder (no preference, ADR-P4)', () => {
    expect(assembleLadderForModel({ entry: null, capability: 'capable' })).toEqual(
      assembleLadder({ capability: 'capable' }),
    );
    expect(assembleLadderForModel({ entry: null, capability: 'weak' })).toEqual(
      assembleLadder({ capability: 'weak' }),
    );
  });

  it('a null entry honors smallerEnabled exactly like assembleLadder', () => {
    expect(
      assembleLadderForModel({ entry: null, capability: 'weak', smallerEnabled: true }),
    ).toEqual(assembleLadder({ capability: 'weak', smallerEnabled: true }));
  });

  it('the default entry produces the same ladder as the no-preference path', () => {
    const defaultEntry = { tiers: PRIMARY_LADDER };
    expect(assembleLadderForModel({ entry: defaultEntry, capability: 'capable' })).toEqual(
      assembleLadder({ capability: 'capable' }),
    );
  });

  it('a non-default entry heads the ladder with its first tier', () => {
    const ladder = assembleLadderForModel({ entry: { tiers: CHOSEN }, capability: 'capable' });
    expect(ladder[0]).toEqual(CHOSEN[0]);
  });

  it('appends the existing assembled ladder after the chosen tiers (last-resort fallback)', () => {
    const ladder = assembleLadderForModel({ entry: { tiers: CHOSEN }, capability: 'capable' });
    expect(ladder).toEqual([...CHOSEN, ...PRIMARY_LADDER]);
  });

  it('dedupes by tierKey so an overlapping default tier is not listed twice', () => {
    // A chosen entry whose first tier equals PRIMARY_LADDER[0]: the appended
    // primary ladder must not re-list that tier.
    const overlap: Tier[] = [PRIMARY_LADDER[0]];
    const ladder = assembleLadderForModel({ entry: { tiers: overlap }, capability: 'capable' });
    const keys = ladder.map(tierKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ladder).toEqual(PRIMARY_LADDER);
  });

  it('produces a ladder nextAction walks to exhausted across every rung', () => {
    const ladder = assembleLadderForModel({ entry: { tiers: CHOSEN }, capability: 'capable' });
    let attemptedIndex: number | null = null;
    let outcome: 'success' | 'load-failure' | null = null;
    const loaded: Tier[] = [];
    for (let guard = 0; guard < 50; guard++) {
      const action: LadderAction = nextAction({
        ladder,
        attemptedIndex,
        outcome,
        knownBadKeys: EMPTY,
      });
      if (action.kind === 'exhausted') break;
      if (action.kind === 'done') throw new Error('unexpected done in all-fail walk');
      loaded.push(action.tier);
      attemptedIndex = ladder.indexOf(action.tier);
      outcome = 'load-failure';
    }
    expect(loaded).toEqual(ladder);
  });
});

describe('applyTierToConfig', () => {
  it('overrides model/device/dtype while preserving the base apiKey', () => {
    const base = { apiKey: 'dummy', device: 'webgpu', dtype: 'q4f16', modelName: PRIMARY_MODEL };
    const tier: Tier = { modelName: PRIMARY_MODEL, device: 'wasm', dtype: 'q8' };
    expect(applyTierToConfig(base, tier)).toEqual({
      apiKey: 'dummy',
      modelName: PRIMARY_MODEL,
      device: 'wasm',
      dtype: 'q8',
    });
  });

  it('does not mutate the base object', () => {
    const base = { apiKey: 'dummy', device: 'webgpu', dtype: 'q4f16', modelName: PRIMARY_MODEL };
    applyTierToConfig(base, { modelName: PRIMARY_MODEL, device: 'wasm', dtype: 'q8' });
    expect(base.device).toBe('webgpu');
    expect(base.dtype).toBe('q4f16');
  });

  it('preserves extra base fields (e.g. historyTokenWarnThreshold)', () => {
    const base = {
      apiKey: 'dummy',
      device: 'webgpu',
      dtype: 'q4f16',
      modelName: PRIMARY_MODEL,
      historyTokenWarnThreshold: 1500,
    };
    const result = applyTierToConfig(base, {
      modelName: PRIMARY_MODEL,
      device: 'webgpu',
      dtype: 'q8',
    });
    expect(result.historyTokenWarnThreshold).toBe(1500);
    expect(result.dtype).toBe('q8');
  });
});
