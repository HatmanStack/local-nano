import { describe, expect, it } from 'vitest';
import {
  applyTierToConfig,
  firstTierIndex,
  type LadderAction,
  nextAction,
  PRIMARY_LADDER,
  PRIMARY_MODEL,
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
      { modelName: PRIMARY_MODEL, device: 'webgpu', dtype: 'fp16' },
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
