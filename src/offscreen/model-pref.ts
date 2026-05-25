/**
 * Model-preference persistence (ADR-P3, P11).
 *
 * The user's chosen model id and idle-timeout choice persist under a NEW
 * `chrome.storage.local` key, distinct from both the per-URL history keys and
 * the per-device `CapabilityRecord`. Unlike `CapabilityRecord`, which is
 * invalidated on every extension-version bump (`capability-store.ts`), this
 * record is NOT version-gated: a user's choice is a preference, not a device
 * fact, and must survive updates (ADR-P3). The read path validates shape with
 * the same guard discipline as `capability-store.ts`/`history.ts`, so a drifted
 * or corrupt blob is ignored rather than trusted, falling back to the
 * no-preference default.
 *
 * `modelId === null` means "no preference": today's capability-based auto-pick
 * (ADR-P4). Catalog validity checks live in the caller (Phase 2 uses
 * `findCatalogEntry`), so this module stays free of a catalog import and the two
 * pure modules do not couple.
 */

/**
 * Single storage key for the preference record. The `:v1` suffix is frozen and
 * is NOT an invalidation mechanism: unlike `CapabilityRecord`, this record is
 * NEVER invalidated on an extension-version bump (ADR-P3).
 */
export const MODEL_PREF_KEY = 'local-nano:model-pref:v1';

/** Supported idle-timeout minute values. `null` ("Never") disables release. */
const SUPPORTED_MINUTES: ReadonlySet<number> = new Set([5, 15, 60]);

/** Default idle timeout for the UI (ADR-P11). */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;

/** One idle-timeout option for the picker. `minutes: null` is "Never". */
export interface IdleTimeoutOption {
  minutes: number | null;
  label: string;
}

/**
 * The idle-timeout options the popover offers (ADR-P11): 5/15/60 min and Never.
 * Frozen so callers cannot mutate the shared list.
 */
export const IDLE_TIMEOUT_OPTIONS: readonly IdleTimeoutOption[] = Object.freeze([
  { minutes: 5, label: '5 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 60, label: '60 min' },
  { minutes: null, label: 'Never' },
] as const);

/**
 * The persisted preference. `modelId === null` means "no preference" (auto-pick,
 * ADR-P4). `idleTimeoutMinutes === null` means "Never" (release disabled,
 * ADR-P11).
 */
export interface ModelPref {
  modelId: string | null;
  idleTimeoutMinutes: number | null;
}

/** True for a supported idle-timeout value: null ("Never") or 5/15/60. */
function isSupportedTimeout(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && SUPPORTED_MINUTES.has(value));
}

/**
 * Runtime shape guard. `modelId` is a string or null; `idleTimeoutMinutes` is
 * null or one of the supported minute values. A drifted/corrupt blob fails the
 * guard and is ignored (matching `isCapabilityRecord`).
 */
export function isModelPref(value: unknown): value is ModelPref {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.modelId !== null && typeof v.modelId !== 'string') return false;
  return isSupportedTimeout(v.idleTimeoutMinutes);
}

/** The no-preference default used when the key is missing or invalid. */
function defaultPref(): ModelPref {
  return { modelId: null, idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES };
}

/**
 * Read the preference record. Returns the validated record, or the no-preference
 * default `{ modelId: null, idleTimeoutMinutes: 15 }` when the key is missing or
 * invalid. Does NOT gate on extension version (ADR-P3).
 */
export async function loadModelPref(): Promise<ModelPref> {
  const data = await chrome.storage.local.get(MODEL_PREF_KEY);
  const stored = data?.[MODEL_PREF_KEY];
  return isModelPref(stored) ? stored : defaultPref();
}

/** Validate then write the full record under the key. */
export async function saveModelPref(pref: ModelPref): Promise<void> {
  await chrome.storage.local.set({ [MODEL_PREF_KEY]: pref });
}

/**
 * Load-modify-write the current preference so a caller updating one field does
 * not clobber the other.
 *
 * NOT atomic: the read → mutate → write has no compare-and-swap (matching
 * `capability-store.ts`). This is safe because the only writers are user clicks
 * in the popover, which do not overlap.
 */
async function readModifyWrite(mutate: (pref: ModelPref) => void): Promise<void> {
  const pref = await loadModelPref();
  mutate(pref);
  await saveModelPref(pref);
}

/** Set the chosen model id (null clears the preference), preserving the timeout. */
export async function setModelId(id: string | null): Promise<void> {
  await readModifyWrite((pref) => {
    pref.modelId = id;
  });
}

/** Set the idle timeout (null = "Never"), preserving the chosen model id. */
export async function setIdleTimeoutMinutes(minutes: number | null): Promise<void> {
  await readModifyWrite((pref) => {
    pref.idleTimeoutMinutes = minutes;
  });
}

/**
 * Resolve the chosen model id from a preference (null stays null). Catalog
 * validity is the caller's concern (Phase 2 via `findCatalogEntry`), so this
 * helper does not import the catalog.
 */
export function resolveModelId(pref: ModelPref): string | null {
  return pref.modelId;
}
