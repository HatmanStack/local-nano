# Phase 1: Curated Catalog + Model-Preference Persistence

## Phase Goal

Build the two data foundations the picker needs, both as testable `src/` seams
with no visible UI and no behavior change for users: a curated model catalog
(`src/offscreen/catalog.ts`) listing each supported model with display metadata
and its ordered tiers, where only models with a clean `docs/models.md`-vetted
tier are non-gated and every unvetted model sits behind an off-by-default gate;
and a model-preference store (`src/offscreen/model-pref.ts`) that persists the
chosen model id and idle timeout under a new key that survives extension-version
bumps.

Success criteria: both modules exist with focused unit tests at 100 percent
coverage, every unvetted-on-WebGPU model gate ships off (so the only live entries
are gemma-4-E2B at `webgpu/q4f16` and Qwen2.5-0.5B at `wasm/q8`), the
no-preference path resolves to today's behavior, and
`typecheck`/`test`/`build`/`lint:ci`/`coverage` are green. Nothing the user sees
changes in this phase.

Estimated tokens: ~30,000.

## Prerequisites

- Phase 0 read in full. ADR-P1, P2, P3, P4, P5, P11, P12 govern this phase.
- `offscreen.ts`, `src/offscreen/ladder.ts`, `src/offscreen/capability-store.ts`,
  `src/history.ts`, and `docs/models.md` read in full.
- A green baseline (`npm run typecheck && npm test -- --run && npm run build &&
  npm run lint:ci`).

## Tasks

> **Task 1.1: Curated model catalog module**
>
> **Goal:** Provide the curated list of supported models with display metadata
> and per-model tier ladders. A model is non-gated (live, always listed) ONLY
> when `docs/models.md` confirms a clean working tier; everything unvetted is
> gated behind an off-by-default flag (ADR-P1, P2, P12).
>
> **Files to Modify/Create:**
>
> - `src/offscreen/catalog.ts` (new) - The catalog data, the gate flags, and pure
>   accessors.
>
> **Prerequisites:**
>
> - Read `src/offscreen/ladder.ts` for the `Tier` type, `PRIMARY_MODEL`,
>   `PRIMARY_LADDER`, `SMALLER_MODEL_CANDIDATE`, and the
>   `SMALLER_MODEL_ENABLED` / `isSmallerModelEnabled()` precedent to mirror.
> - Read the `docs/models.md` "TL;DR picks", "Models we tried", and
>   "Smaller-model fallback rung (gated)" sections for the vetted cells and the
>   per-model notes that source the catalog metadata. Note that the Qwen3.5-0.8B
>   rows there are all failures or caveated (numerical breakdown on `webgpu/q4f16`,
>   SIGILL-caveated `webgpu/q4`, `GatherBlockQuantized` failures on WASM quantized
>   variants); it has NO clean preferred WebGPU tier, so it is gated (ADR-P2).
>
> **Implementation Steps:**
>
> - Define a `CatalogEntry` interface: `id: string` (the canonical model name,
>   identical to the string used in `Tier.modelName`), `displayName: string`,
>   `downloadSize: string` (descriptive, e.g. `'~1.5 GB'`), `note: string`
>   (one line sourced from `docs/models.md`), `tiers: Tier[]` (the ordered
>   dtype/device ladder for this model), and a boolean `gated` (true when the
>   entry requires an off-by-default gate flag; gated entries are never live).
> - Import the `Tier` type from `./ladder.js`. Do not import Chrome, the
>   polyfill, or any timer. This is a pure data module.
> - Define the default entry for `PRIMARY_MODEL` (gemma-4-E2B) reusing
>   `PRIMARY_LADDER` for its tiers, so the default entry's ladder is identical
>   to today's primary ladder (do not duplicate the tier literals; reference
>   `PRIMARY_LADDER`). `gated: false`. `downloadSize: '~1.5 GB'` and a note
>   sourced from `docs/models.md` (e.g. `'default; WebGPU, ~5-15 tok/s on Iris
>   Xe'`).
> - Define the ONE non-gated smaller entry from `docs/models.md`:
>   `onnx-community/Qwen2.5-0.5B-Instruct`, `gated: false`, with `tiers` of
>   exactly `[{ modelName, device: 'wasm', dtype: 'q8' }]` (the only cell
>   `docs/models.md` confirms working for it; the same model `ladder.ts` names as
>   `SMALLER_MODEL_CANDIDATE`). Its `note` must reflect the guide's real cell, not
>   an optimistic paraphrase: source it from `docs/models.md` (e.g. `'smallest
>   that answers; CPU/WASM only, ~1-3 tok/s'`). Set `downloadSize` to the guide's
>   figure (e.g. `'~0.5 GB'`, matching "~500 MB for a 0.5B model" at q8). Do NOT
>   give it a WebGPU tier (the guide does not vet one).
> - Define `QWEN3_08B_ENABLED = false` as an exported build-time constant and
>   `isQwen3_08bEnabled(): boolean` returning it, plus a gated entry for
>   `onnx-community/Qwen3.5-0.8B-ONNX` (`gated: true`). Its `tiers` and `note`
>   must NOT claim a clean WebGPU tier: encode only the slow vetted
>   per-component WASM path as documented (note it requires the
>   `{embed_tokens: 'fp16', decoder_model_merged: 'q8'}` per-component dtype and
>   is slow, ~50s TTFT), and mark the entry's note as a manual-smoke target. The
>   `note` reflects the guide's reality (e.g. `'WebGPU-quirky; WASM only via slow
>   per-component path; unvetted on WebGPU'`). Document in a block comment that
>   this entry is gated because `docs/models.md` shows no clean preferred WebGPU
>   tier (numerical breakdown on q4f16; SIGILL-caveated q4 the project abandoned),
>   and that flipping `QWEN3_08B_ENABLED` is a manual WebGPU-smoke follow-up, not a
>   CI change.
> - Define `LARGER_MODEL_ENABLED = false` as an exported build-time constant and
>   `isLargerModelEnabled(): boolean` returning it, both mirroring the
>   `SMALLER_MODEL_ENABLED` / `isSmallerModelEnabled()` seam so the picker can be
>   exercised with gated entries on and off in tests via `vi.spyOn` without
>   flipping a production constant.
> - Add a placeholder larger entry (`gated: true`) for the smoke-vetting target.
>   The exact model id is an open question; use a clearly-labeled placeholder
>   constant whose presence is harmless while the gate is off (e.g. a
>   `LARGER_MODEL_CANDIDATE` entry documented as unvetted, mirroring how
>   `SMALLER_MODEL_CANDIDATE` documents its unvetted WebGPU tier). Document in a
>   block comment that flipping the flag is a manual WebGPU-smoke follow-up, not
>   a CI change, and that the candidate id is finalized at vetting time.
> - Export `listCatalog(opts?: { largerEnabled?: boolean; qwen3Enabled?: boolean
>   }): CatalogEntry[]`: returns the non-gated entries always (the default +
>   Qwen2.5-0.5B), and includes a gated entry only when its gate is on
>   (`largerEnabled` defaulting to `isLargerModelEnabled()`, `qwen3Enabled`
>   defaulting to `isQwen3_08bEnabled()`). The list order is smallest to largest
>   with the default in its size position, matching the both-directions spectrum
>   in the brainstorm.
> - Export `findCatalogEntry(id: string, opts?: { largerEnabled?: boolean;
>   qwen3Enabled?: boolean }): CatalogEntry | null`: returns the entry with that
>   id from the visible catalog, or null for an unknown/gated-while-disabled id
>   (so a stale stored preference resolves to null, which the caller treats as
>   "no preference").
> - Export `DEFAULT_MODEL_ID = PRIMARY_MODEL` so the picker can mark the default.
>
> **Verification Checklist:**
>
> - [x] `listCatalog()` with all gates off returns exactly the default + the
>       single non-gated smaller entry (Qwen2.5-0.5B) and excludes every `gated`
>       entry (both Qwen3.5-0.8B and the larger placeholder).
> - [x] `listCatalog({ qwen3Enabled: true })` includes Qwen3.5-0.8B;
>       `listCatalog({ largerEnabled: true })` includes the larger entry.
> - [x] `findCatalogEntry(PRIMARY_MODEL)` returns the default entry whose tiers
>       are content-equal to `PRIMARY_LADDER`.
> - [x] The non-gated Qwen2.5-0.5B entry's only tier is `wasm/q8`; it has no
>       WebGPU tier.
> - [x] No non-gated entry encodes a `webgpu/q4` tier or any cell
>       `docs/models.md` marks as failing/caveated.
> - [x] `findCatalogEntry('made-up/model')` returns null.
> - [x] `findCatalogEntry('onnx-community/Qwen3.5-0.8B-ONNX')` returns null with
>       `QWEN3_08B_ENABLED` off and the entry with it on.
> - [x] Every NON-GATED entry's `tiers` use only dtype/device cells
>       `docs/models.md` confirms working (default `webgpu/q4f16`; Qwen2.5-0.5B
>       `wasm/q8`).
> - [x] No Chrome/polyfill/timer import in `catalog.ts`.
>
> **Testing Instructions:**
>
> - New file `tests/offscreen-catalog.test.ts`. Unit-test `listCatalog`
>   (each gate on/off), `findCatalogEntry` (known/unknown/gated), that the default
>   entry's tiers match `PRIMARY_LADDER`, and that the non-gated smaller entry has
>   exactly the `wasm/q8` tier and no WebGPU tier. Use `vi.spyOn` on
>   `isLargerModelEnabled` and `isQwen3_08bEnabled` to exercise gate states
>   without touching the production constants, the same way `tests/session.test.ts`
>   spies `isSmallerModelEnabled`.
> - Add `tests/offscreen-catalog.test.ts` to the test-file table in
>   `docs/testing.md` in the SAME commit (docs-drift guard).
> - Run `npx vitest run tests/offscreen-catalog.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(picker): add curated model catalog; gate every unvetted model
>
> - New pure src/offscreen/catalog.ts: CatalogEntry data + per-model tiers
> - Non-gated live entries: gemma-4-E2B (webgpu/q4f16) + Qwen2.5-0.5B
>   (wasm/q8), the only cells docs/models.md confirms working
> - QWEN3_08B_ENABLED + LARGER_MODEL_ENABLED flags (both default off) gate
>   Qwen3.5-0.8B and larger candidates pending manual WebGPU smoke vetting
> - listCatalog/findCatalogEntry accessors, unit-tested each gate state
> - docs/testing.md: list tests/offscreen-catalog.test.ts
> ```

---

> **Task 1.2: Model-preference persistence store**
>
> **Goal:** Persist the chosen model id and idle timeout under a new
> `chrome.storage.local` key that survives extension-version bumps, with shape
> validation and a no-preference fallback (ADR-P3, P11).
>
> **Files to Modify/Create:**
>
> - `src/offscreen/model-pref.ts` (new) - The preference record, its key, shape
>   guard, read/write functions, and the idle-timeout value mapping.
>
> **Prerequisites:**
>
> - Read `src/offscreen/capability-store.ts` for the storage access pattern
>   (`chrome.storage.local.get/set`, the `isCapabilityRecord` guard discipline)
>   and `src/history.ts` for the same conventions.
>
> **Implementation Steps:**
>
> - Define `MODEL_PREF_KEY = 'local-nano:model-pref:v1'`. The `:v1` suffix is
>   frozen and is NOT an invalidation mechanism; unlike `CapabilityRecord` this
>   record is NEVER invalidated on an extension-version bump (ADR-P3).
> - Define the idle-timeout value type. Store the timeout as
>   `idleTimeoutMinutes: number | null`, where `null` means "Never" (release
>   disabled). The supported minute values are `5`, `15`, `60`; the default is
>   `15`. Export these as a frozen `IDLE_TIMEOUT_OPTIONS` list of
>   `{ minutes: number | null; label: string }` (e.g. `5 min`, `15 min`,
>   `60 min`, `Never`) and `DEFAULT_IDLE_TIMEOUT_MINUTES = 15` for the UI.
> - Define `ModelPref { modelId: string | null; idleTimeoutMinutes: number |
>   null }`. `modelId === null` means "no preference" (today's auto-pick,
>   ADR-P4).
> - Write `isModelPref(value: unknown): value is ModelPref` validating the shape:
>   `modelId` is a string or null; `idleTimeoutMinutes` is null or one of the
>   supported minute values. A drifted/corrupt blob fails the guard and is
>   ignored (matching `isCapabilityRecord`).
> - Write `loadModelPref(): Promise<ModelPref>`: reads `MODEL_PREF_KEY`, returns
>   the validated record, or a default record `{ modelId: null,
>   idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES }` when the key is missing
>   or invalid. Do NOT gate on extension version.
> - Write `saveModelPref(pref: ModelPref): Promise<void>`: validates then writes
>   the full record under the key. Provide focused mutators that load-modify-
>   write so callers do not clobber the other field: `setModelId(id: string |
>   null)` and `setIdleTimeoutMinutes(minutes: number | null)`. (Document the
>   non-atomic read-modify-write the same way `capability-store.ts` does; the
>   only writers are user clicks, which do not overlap.)
> - Write a pure helper `resolveModelId(pref: ModelPref): string | null` that
>   returns `pref.modelId` (null stays null). Keep catalog validity checks in the
>   caller (Phase 2 uses `findCatalogEntry`), so this module stays free of a
>   catalog import and the two pure modules do not couple.
>
> **Verification Checklist:**
>
> - [ ] `loadModelPref()` on an empty store returns
>       `{ modelId: null, idleTimeoutMinutes: 15 }`.
> - [ ] A stored valid record round-trips through save/load unchanged.
> - [ ] A stored record with a bumped extension version is still returned (NOT
>       invalidated), unlike `CapabilityRecord`.
> - [ ] A corrupt/drifted stored blob is ignored and the default returned.
> - [ ] `setModelId` preserves `idleTimeoutMinutes` and vice versa.
> - [ ] `idleTimeoutMinutes: null` ("Never") validates and round-trips.
> - [ ] An out-of-range timeout (e.g. `7`) fails the guard.
>
> **Testing Instructions:**
>
> - New file `tests/offscreen-model-pref.test.ts`. Use `chromeMock.storage.local`
>   from `tests/setup.ts` exactly like `tests/capability-store.test.ts`. Cover:
>   empty-store default, round-trip, version-bump-survives (set
>   `chromeMock.runtime.getManifest` to a different version and assert the record
>   still loads), corrupt-blob ignored, each mutator preserving the other field,
>   and the "Never" (null) timeout.
> - Add `tests/offscreen-model-pref.test.ts` to the test-file table in
>   `docs/testing.md` in the SAME commit.
> - Run `npx vitest run tests/offscreen-model-pref.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(picker): add model-preference store surviving version bumps
>
> - New src/offscreen/model-pref.ts: local-nano:model-pref:v1 key
> - Persists modelId + idleTimeoutMinutes; null modelId = auto-pick
> - Not version-gated (preference, not device fact); shape-validated
> - IDLE_TIMEOUT_OPTIONS (5/15/60/Never), default 15 min
> - docs/testing.md: list tests/offscreen-model-pref.test.ts
> ```

## Phase Verification

- `npm run typecheck`, `npm test -- --run`, `npm run build`, `npm run lint:ci`
  all green.
- `npm run coverage` green; `catalog.ts` and `model-pref.ts` at 100 percent.
- `git diff --name-only` shows only the two new `src/` modules, their two test
  files, and `docs/testing.md`. No change to `offscreen.ts`, `ladder.ts`,
  `session.ts`, `.env.json`, `manifest.json`, or any vendor file.
- No live behavior change: nothing reads the catalog or the preference yet
  (Phase 2 wires them), so the running extension is byte-for-byte identical in
  behavior to before this phase.

### Known limitations carried forward

- The catalog and preference exist but are not yet consulted by the ladder or
  any UI. Phase 2 wires the preference into ladder assembly; Phase 3 surfaces the
  popover.
- Qwen3.5-0.8B is present only as a gated entry (`QWEN3_08B_ENABLED` off) pending
  a manual WebGPU smoke pass that confirms a clean, SIGILL-free tier; until then
  it is never live (ADR-P2). The exact gated larger-model id is a placeholder
  pending vetting (`LARGER_MODEL_ENABLED` off, ADR-P2, open question 1). Both
  gates are off, so both are inert.
