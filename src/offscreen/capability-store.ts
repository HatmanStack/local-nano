/**
 * Per-device capability/tier persistence (ADR-R7).
 *
 * A single `chrome.storage.local` record, distinct from the per-URL history
 * keys, records the resolved known-good tier, the known-bad tiers, and a
 * capability snapshot so a cold start can skip straight to a working tier and
 * avoid a deterministically crashing one. The record is invalidated (treated as
 * absent) on a schema-version or extension-version mismatch, so a runtime or
 * model change re-walks the ladder from the top, which is the safe default.
 *
 * Storage access goes through the promisified `chrome.storage.local` (matching
 * `history.ts`). The read path validates the shape with the same guard
 * discipline as `history.ts` so a drifted or corrupt blob is ignored rather
 * than trusted.
 */

import { type Tier, tierKey } from './ladder.js';

/** Single storage key for the per-device record. Distinct from history keys. */
export const CAPABILITY_KEY = 'local-nano:capability:v1';

/** Bumped only when the record shape changes; a mismatch invalidates the record. */
export const SCHEMA_VERSION = 1;

export interface CapabilitySnapshot {
  device: 'webgpu' | 'wasm';
  isFallback: boolean;
  maxBufferSize: number | null;
}

export interface CapabilityRecord {
  schemaVersion: number;
  extensionVersion: string;
  knownGood: Tier | null;
  knownBad: Tier[];
  capability: CapabilitySnapshot;
}

function isTier(value: unknown): value is Tier {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.modelName !== 'string') return false;
  if (v.device !== 'webgpu' && v.device !== 'wasm') return false;
  return typeof v.dtype === 'string';
}

function isCapabilitySnapshot(value: unknown): value is CapabilitySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.device !== 'webgpu' && v.device !== 'wasm') return false;
  if (typeof v.isFallback !== 'boolean') return false;
  return v.maxBufferSize === null || typeof v.maxBufferSize === 'number';
}

function isCapabilityRecord(value: unknown): value is CapabilityRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.schemaVersion !== 'number') return false;
  if (typeof v.extensionVersion !== 'string') return false;
  if (v.knownGood !== null && !isTier(v.knownGood)) return false;
  if (!Array.isArray(v.knownBad) || !v.knownBad.every(isTier)) return false;
  return isCapabilitySnapshot(v.capability);
}

/**
 * Read the per-device record. Returns null (treat as absent) when the key is
 * missing, the shape is invalid, the schema version does not match the current
 * code constant, or the stored extension version does not match the live
 * extension version (ADR-R7 invalidation).
 */
export async function loadCapabilityRecord(
  extensionVersion: string,
): Promise<CapabilityRecord | null> {
  const data = await chrome.storage.local.get(CAPABILITY_KEY);
  const stored = data?.[CAPABILITY_KEY];
  if (!isCapabilityRecord(stored)) return null;
  if (stored.schemaVersion !== SCHEMA_VERSION) return null;
  if (stored.extensionVersion !== extensionVersion) return null;
  return stored;
}

/**
 * Read the current record (or a fresh empty one for this extension version),
 * apply `mutate`, and write it back. Always stamps the current schema and
 * extension version so a write also re-validates a stale record.
 */
async function readModifyWrite(
  extensionVersion: string,
  capability: CapabilitySnapshot,
  mutate: (record: CapabilityRecord) => void,
): Promise<void> {
  const current = await loadCapabilityRecord(extensionVersion);
  const record: CapabilityRecord = current ?? {
    schemaVersion: SCHEMA_VERSION,
    extensionVersion,
    knownGood: null,
    knownBad: [],
    capability,
  };
  // Always refresh the version stamps and the capability snapshot.
  record.schemaVersion = SCHEMA_VERSION;
  record.extensionVersion = extensionVersion;
  record.capability = capability;
  mutate(record);
  await chrome.storage.local.set({ [CAPABILITY_KEY]: record });
}

/**
 * Record a tier as known-good: set it as `knownGood` and drop it from
 * `knownBad` if it had previously been recorded bad (it now works).
 */
export async function recordKnownGood(
  extensionVersion: string,
  tier: Tier,
  capability: CapabilitySnapshot,
): Promise<void> {
  const key = tierKey(tier);
  await readModifyWrite(extensionVersion, capability, (record) => {
    record.knownGood = tier;
    record.knownBad = record.knownBad.filter((t) => tierKey(t) !== key);
  });
}

/**
 * Record a tier as known-bad, deduping by `tierKey`. If the bad tier was the
 * current `knownGood`, clear `knownGood` (it no longer works).
 */
export async function recordKnownBad(
  extensionVersion: string,
  tier: Tier,
  capability: CapabilitySnapshot,
): Promise<void> {
  const key = tierKey(tier);
  await readModifyWrite(extensionVersion, capability, (record) => {
    if (!record.knownBad.some((t) => tierKey(t) === key)) {
      record.knownBad.push(tier);
    }
    if (record.knownGood && tierKey(record.knownGood) === key) {
      record.knownGood = null;
    }
  });
}

/** Remove the record entirely so the next cold start re-detects from tier 0. */
export async function clearCapabilityRecord(): Promise<void> {
  await chrome.storage.local.remove(CAPABILITY_KEY);
}
