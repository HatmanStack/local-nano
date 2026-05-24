import { beforeEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_KEY,
  type CapabilitySnapshot,
  clearCapabilityRecord,
  loadCapabilityRecord,
  recordKnownBad,
  recordKnownGood,
  SCHEMA_VERSION,
} from '../src/offscreen/capability-store.js';
import type { Tier } from '../src/offscreen/ladder.js';
import { chromeMock } from './setup.js';

const VERSION = '0.2.4';

const CAP: CapabilitySnapshot = {
  device: 'webgpu',
  isFallback: false,
  maxBufferSize: 4294967296,
};

const TIER_0: Tier = { modelName: 'org/model', device: 'webgpu', dtype: 'q4f16' };
const TIER_1: Tier = { modelName: 'org/model', device: 'webgpu', dtype: 'q8' };
const TIER_WASM: Tier = { modelName: 'org/model', device: 'wasm', dtype: 'q8' };

describe('capability-store', () => {
  beforeEach(() => {
    // setup.ts resets local.store and the mock spies (including remove).
  });

  it('returns null from a fresh store', async () => {
    await expect(loadCapabilityRecord(VERSION)).resolves.toBeNull();
  });

  it('records a known-good tier and reads it back', async () => {
    await recordKnownGood(VERSION, TIER_0, CAP);
    const record = await loadCapabilityRecord(VERSION);
    expect(record).not.toBeNull();
    expect(record?.knownGood).toEqual(TIER_0);
    expect(record?.knownBad).toEqual([]);
    expect(record?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(record?.extensionVersion).toBe(VERSION);
    expect(record?.capability).toEqual(CAP);
  });

  it('accumulates and dedupes known-bad tiers by tierKey', async () => {
    await recordKnownBad(VERSION, TIER_0, CAP);
    await recordKnownBad(VERSION, TIER_1, CAP);
    // Re-record TIER_0 — should not duplicate.
    await recordKnownBad(VERSION, TIER_0, CAP);
    const record = await loadCapabilityRecord(VERSION);
    expect(record?.knownBad).toEqual([TIER_0, TIER_1]);
  });

  it('clears a tier from known-bad when it later becomes known-good', async () => {
    await recordKnownBad(VERSION, TIER_0, CAP);
    await recordKnownBad(VERSION, TIER_1, CAP);
    await recordKnownGood(VERSION, TIER_0, CAP);
    const record = await loadCapabilityRecord(VERSION);
    expect(record?.knownGood).toEqual(TIER_0);
    // TIER_0 dropped from known-bad; TIER_1 remains.
    expect(record?.knownBad).toEqual([TIER_1]);
  });

  it('clears known-good when that tier is later recorded bad', async () => {
    await recordKnownGood(VERSION, TIER_0, CAP);
    await recordKnownBad(VERSION, TIER_0, CAP);
    const record = await loadCapabilityRecord(VERSION);
    expect(record?.knownGood).toBeNull();
    expect(record?.knownBad).toEqual([TIER_0]);
  });

  it('treats a record with a mismatched schemaVersion as absent', async () => {
    chromeMock.storage.local.store[CAPABILITY_KEY] = {
      schemaVersion: SCHEMA_VERSION + 1,
      extensionVersion: VERSION,
      knownGood: TIER_0,
      knownBad: [],
      capability: CAP,
    };
    await expect(loadCapabilityRecord(VERSION)).resolves.toBeNull();
  });

  it('treats a record with a mismatched extensionVersion as absent', async () => {
    chromeMock.storage.local.store[CAPABILITY_KEY] = {
      schemaVersion: SCHEMA_VERSION,
      extensionVersion: '0.2.3',
      knownGood: TIER_0,
      knownBad: [],
      capability: CAP,
    };
    await expect(loadCapabilityRecord(VERSION)).resolves.toBeNull();
  });

  it('treats a malformed blob as absent', async () => {
    chromeMock.storage.local.store[CAPABILITY_KEY] = { junk: true };
    await expect(loadCapabilityRecord(VERSION)).resolves.toBeNull();
  });

  it('rejects a record whose capability.maxBufferSize is non-finite', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      chromeMock.storage.local.store[CAPABILITY_KEY] = {
        schemaVersion: SCHEMA_VERSION,
        extensionVersion: VERSION,
        knownGood: TIER_0,
        knownBad: [],
        capability: { device: 'webgpu', isFallback: false, maxBufferSize: bad },
      };
      await expect(loadCapabilityRecord(VERSION)).resolves.toBeNull();
    }
  });

  it('clearCapabilityRecord removes the record via storage.remove', async () => {
    await recordKnownGood(VERSION, TIER_WASM, CAP);
    expect(chromeMock.storage.local.store[CAPABILITY_KEY]).toBeTruthy();
    await clearCapabilityRecord();
    expect(chromeMock.storage.local.remove).toHaveBeenCalledWith(CAPABILITY_KEY);
    expect(chromeMock.storage.local.store[CAPABILITY_KEY]).toBeUndefined();
    await expect(loadCapabilityRecord(VERSION)).resolves.toBeNull();
  });

  it('a write after an invalidated record re-stamps the current versions', async () => {
    // A stale record under a different extension version.
    chromeMock.storage.local.store[CAPABILITY_KEY] = {
      schemaVersion: SCHEMA_VERSION,
      extensionVersion: '0.2.3',
      knownGood: TIER_1,
      knownBad: [TIER_0],
      capability: CAP,
    };
    // Recording under the live version starts fresh (the stale record is absent)
    // and stamps the current version.
    await recordKnownGood(VERSION, TIER_0, CAP);
    const record = await loadCapabilityRecord(VERSION);
    expect(record?.extensionVersion).toBe(VERSION);
    expect(record?.knownGood).toEqual(TIER_0);
    // The stale known-bad is not carried over (the prior record was invalid).
    expect(record?.knownBad).toEqual([]);
  });
});
