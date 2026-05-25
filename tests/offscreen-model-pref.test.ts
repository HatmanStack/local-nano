import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  IDLE_TIMEOUT_OPTIONS,
  isModelPref,
  loadModelPref,
  MODEL_PREF_KEY,
  type ModelPref,
  resolveModelId,
  saveModelPref,
  setIdleTimeoutMinutes,
  setModelId,
} from '../src/offscreen/model-pref.js';
import { chromeMock } from './setup.js';

describe('model-pref constants', () => {
  it('exposes the frozen v1 key', () => {
    expect(MODEL_PREF_KEY).toBe('local-nano:model-pref:v1');
  });

  it('default idle timeout is 15 minutes', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MINUTES).toBe(15);
  });

  it('IDLE_TIMEOUT_OPTIONS lists 5/15/60/Never and is frozen', () => {
    expect(IDLE_TIMEOUT_OPTIONS.map((o) => o.minutes)).toEqual([5, 15, 60, null]);
    expect(IDLE_TIMEOUT_OPTIONS.every((o) => typeof o.label === 'string')).toBe(true);
    expect(Object.isFrozen(IDLE_TIMEOUT_OPTIONS)).toBe(true);
  });
});

describe('isModelPref', () => {
  it('accepts a valid record with a string modelId and a supported minute value', () => {
    expect(isModelPref({ modelId: 'org/model', idleTimeoutMinutes: 15 })).toBe(true);
  });

  it('accepts null modelId ("no preference")', () => {
    expect(isModelPref({ modelId: null, idleTimeoutMinutes: 60 })).toBe(true);
  });

  it('accepts null idleTimeoutMinutes ("Never")', () => {
    expect(isModelPref({ modelId: 'org/model', idleTimeoutMinutes: null })).toBe(true);
  });

  it('accepts every supported minute value', () => {
    for (const minutes of [5, 15, 60, null]) {
      expect(isModelPref({ modelId: null, idleTimeoutMinutes: minutes })).toBe(true);
    }
  });

  it('rejects an out-of-range timeout (e.g. 7)', () => {
    expect(isModelPref({ modelId: null, idleTimeoutMinutes: 7 })).toBe(false);
  });

  it('rejects a non-string, non-null modelId', () => {
    expect(isModelPref({ modelId: 42, idleTimeoutMinutes: 15 })).toBe(false);
  });

  it('rejects non-object and malformed blobs', () => {
    expect(isModelPref(null)).toBe(false);
    expect(isModelPref('nope')).toBe(false);
    expect(isModelPref({ junk: true })).toBe(false);
    expect(isModelPref({ modelId: 'x' })).toBe(false);
  });
});

describe('loadModelPref', () => {
  it('returns the no-preference default on an empty store', async () => {
    await expect(loadModelPref()).resolves.toEqual({
      modelId: null,
      idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
    });
  });

  it('round-trips a valid stored record unchanged', async () => {
    const pref: ModelPref = { modelId: 'onnx-community/X', idleTimeoutMinutes: 60 };
    await saveModelPref(pref);
    await expect(loadModelPref()).resolves.toEqual(pref);
  });

  it('returns a stored record even across an extension-version bump (not invalidated)', async () => {
    const pref: ModelPref = { modelId: 'org/model', idleTimeoutMinutes: 5 };
    await saveModelPref(pref);
    // A new extension version must NOT invalidate the preference (unlike
    // CapabilityRecord).
    chromeMock.runtime.getManifest.mockImplementation(() => ({ version: '99.0.0' }));
    await expect(loadModelPref()).resolves.toEqual(pref);
  });

  it('ignores a corrupt/drifted stored blob and returns the default', async () => {
    chromeMock.storage.local.store[MODEL_PREF_KEY] = { modelId: 7, idleTimeoutMinutes: 'soon' };
    await expect(loadModelPref()).resolves.toEqual({
      modelId: null,
      idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
    });
  });

  it('round-trips the "Never" (null) timeout', async () => {
    const pref: ModelPref = { modelId: 'org/model', idleTimeoutMinutes: null };
    await saveModelPref(pref);
    await expect(loadModelPref()).resolves.toEqual(pref);
  });
});

describe('mutators', () => {
  it('setModelId preserves the existing idleTimeoutMinutes', async () => {
    await saveModelPref({ modelId: null, idleTimeoutMinutes: 60 });
    await setModelId('org/chosen');
    await expect(loadModelPref()).resolves.toEqual({
      modelId: 'org/chosen',
      idleTimeoutMinutes: 60,
    });
  });

  it('setModelId(null) clears the preference but keeps the timeout', async () => {
    await saveModelPref({ modelId: 'org/chosen', idleTimeoutMinutes: 5 });
    await setModelId(null);
    await expect(loadModelPref()).resolves.toEqual({ modelId: null, idleTimeoutMinutes: 5 });
  });

  it('setIdleTimeoutMinutes preserves the existing modelId', async () => {
    await saveModelPref({ modelId: 'org/chosen', idleTimeoutMinutes: 15 });
    await setIdleTimeoutMinutes(60);
    await expect(loadModelPref()).resolves.toEqual({
      modelId: 'org/chosen',
      idleTimeoutMinutes: 60,
    });
  });

  it('setIdleTimeoutMinutes(null) sets "Never" and preserves the modelId', async () => {
    await saveModelPref({ modelId: 'org/chosen', idleTimeoutMinutes: 15 });
    await setIdleTimeoutMinutes(null);
    await expect(loadModelPref()).resolves.toEqual({
      modelId: 'org/chosen',
      idleTimeoutMinutes: null,
    });
  });

  it('a mutator on an empty store starts from the no-preference default', async () => {
    await setModelId('org/first');
    await expect(loadModelPref()).resolves.toEqual({
      modelId: 'org/first',
      idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
    });
  });
});

describe('resolveModelId', () => {
  it('returns the stored modelId', () => {
    expect(resolveModelId({ modelId: 'org/model', idleTimeoutMinutes: 15 })).toBe('org/model');
  });

  it('returns null when no preference is set', () => {
    expect(resolveModelId({ modelId: null, idleTimeoutMinutes: 15 })).toBeNull();
  });
});
