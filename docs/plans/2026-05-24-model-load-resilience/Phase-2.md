# Phase 2: Fallback Ladder and Tier Persistence

## Phase Goal

On a model-load failure, automatically walk a dtype/device fallback ladder
within the primary model (q4f16 to q8 to fp16 to wasm), recreating the offscreen
document between rungs so a crashed/poisoned document never blocks the next
attempt. Persist the resolved known-good and known-bad tiers per device so cold
start skips straight to a working tier, and add a reset/re-detect control.
Success criteria: the pure ladder reducer is fully unit-tested; the offscreen
document loads a tier dictated by the panel via a runtime config override; the
panel auto-advances the ladder on load failure and persists the outcome; the
build/tests/lint/coverage stay green. Estimated tokens: ~60,000.

## Prerequisites

- Phase 1 merged (force-recreate path, failure classifier, diagnostic builder).
- ADR-R1 (panel-side orchestration), ADR-R2 (runtime override via
  `TRANSFORMERS_CONFIG`), ADR-R3 (destroy does not free the generator; recreate
  between rungs), ADR-R6 (ladder reducer), ADR-R7 (tier and persistence schema)
  govern this phase.
- Baseline green.
- Re-read `offscreen.ts` (`loadHeavy` lines 72-98, `ensureSession` lines
  116-132, the static `transformersConfig` import at line 20 and its use at line
  83), `src/offscreen/protocol.ts`, `src/session.ts` `ensureWarm`.

## Task 2.1: Ladder reducer (pure state machine)

### Goal

A pure module defining the tier type, the primary model's ordered ladder, and a
reducer that, given the current position and the last attempt outcome, returns
the next action.

### Files to Modify/Create

- Create `src/offscreen/ladder.ts`.
- Create `tests/offscreen-ladder.test.ts`.
- Modify `docs/testing.md`.

### Prerequisites

None beyond Phase 0/1.

### Implementation Steps

1. Define and export `interface Tier { modelName: string; device: 'webgpu' |
   'wasm'; dtype: string }` and a `tierKey(t: Tier): string` helper returning
   `` `${modelName}|${device}|${dtype}` `` for equality/persistence.
1. Define the primary model constant `PRIMARY_MODEL =
   'onnx-community/gemma-4-E2B-it-ONNX'` and export `PRIMARY_LADDER: Tier[]` in
   the ADR-R7 order: webgpu/q4f16, webgpu/q8, webgpu/fp16, wasm/q8. Tier 0 must
   equal the `.env.json` base (`gemma-4-E2B-it-ONNX` / webgpu / q4f16). Note the
   smaller-model rung is appended in Phase 3; keep the array buildable from a
   `[primaryLadder, ...optionalSmallerLadder]` concat so Phase 3 extends it
   without rewriting this module.
1. Define `type LadderOutcome = 'success' | 'load-failure'` (input) and
   `type LadderAction = { kind: 'load'; tier: Tier } | { kind: 'done'; tier:
   Tier } | { kind: 'exhausted' }` (output).
1. Export a pure `nextAction(args: { ladder: Tier[]; attemptedIndex: number |
   null; outcome: LadderOutcome | null; knownBadKeys: ReadonlySet<string> }):
   LadderAction`:
   - When `attemptedIndex` is `null` and `outcome` is `null` (start), return
     `load` for the first ladder tier whose key is not in `knownBadKeys`; if all
     are known-bad, return `exhausted`.
   - When `outcome` is `success`, return `done` with the attempted tier.
   - When `outcome` is `load-failure`, advance to the next ladder tier after
     `attemptedIndex` whose key is not in `knownBadKeys`; if none remain, return
     `exhausted`.
1. Export a `firstTierIndex(ladder, knownGoodKey: string | null, knownBadKeys):
   number` helper that, given a persisted known-good key, returns the index of
   that tier (so cold start can skip straight to it), else the first
   non-known-bad index, else `-1` (exhausted). Keep it pure.
1. No Chrome, no timers, no polyfill. Tier list is data.

### Verification Checklist

- Start with empty `knownBad` returns `load` of tier 0.
- `success` returns `done` of the attempted tier.
- `load-failure` on index 0 returns `load` of index 1; on the last index returns
  `exhausted`.
- A `knownBadKeys` set containing tier 0's key makes start return `load` of tier
  1.
- `firstTierIndex` returns the known-good index when present, else the first
  non-bad index, else `-1`.
- `npm run typecheck`, `npm run lint:ci` pass.

### Testing Instructions

Pure unit tests in `tests/offscreen-ladder.test.ts`. Walk a full failure
sequence to `exhausted`; cover known-bad skipping; cover the success short
circuit; cover `firstTierIndex` with and without a known-good. No mocks.

### Commit Message Template

```text
feat(resilience): add pure fallback-ladder reducer

src/offscreen/ladder.ts defines the Tier type, the primary model's
ordered dtype/device ladder (q4f16, q8, fp16, wasm/q8), and a pure
nextAction reducer that advances on load-failure, short-circuits on
success, skips known-bad tiers, and reports exhaustion.
```

## Task 2.2: Runtime tier override in the offscreen document

### Goal

Let the panel tell the offscreen document which tier to load. The offscreen
document overrides `window.TRANSFORMERS_CONFIG` with the requested tier before
`LanguageModel.create()`, so each load uses the dictated model/device/dtype.

### Files to Modify/Create

- Modify `src/offscreen/protocol.ts` (carry an optional `tier` on the
  warmup/ensure-session request, or add a `SET_TIER` message; see steps).
- Modify `offscreen.ts` (apply the tier override before `ensureSession`; clear
  `sessionPromise` and `heavyPromise`-safe re-config on tier change).
- Modify `src/offscreen/client.ts` (pass the tier through `warmupSession`).
- Modify `tests/offscreen-protocol.test.ts`, `tests/offscreen-client.test.ts`.

### Prerequisites

Task 2.1 (the `Tier` type).

### Implementation Steps

1. Decide the transport: extend the existing warmup channel rather than add a
   new one. The warmup uses a `CountTokensRequest` with `text: ''`
   (`client.ts` lines 163-175 to `offscreen.ts` `handleCountTokens`). Add an
   OPTIONAL `tier?: { modelName: string; device: 'webgpu' | 'wasm'; dtype:
   string }` field to a NEW dedicated `WARMUP_REQUEST` message instead of
   overloading count-tokens (count-tokens is also used mid-session for the soft
   cap and must not carry tier semantics). Add `WARMUP_REQUEST =
   'offscreen/warmup-request'` / `WARMUP_RESPONSE` constants, the request
   interface with the optional `tier`, the ok/error response union, and
   `isWarmupRequest` / `isWarmupResponse` guards.
1. In `offscreen.ts`, add the `warmup` kind to `classifyOffscreenMessage`
   (extend `src/offscreen/dispatch.ts` and its test) and a `handleWarmup`
   handler that:
   - If `msg.tier` is present, sets `window.TRANSFORMERS_CONFIG` to a new object
     spreading the base `transformersConfig` and overriding `modelName`,
     `device`, `dtype` from the tier (ADR-R2). Keep `apiKey` from the base.
   - If the requested tier differs from the currently-loaded tier, the panel is
     expected to have force-recreated the document first (ADR-R3/R4), so the
     offscreen module is freshly loaded and `sessionPromise` is null. As a
     safety net, if `sessionPromise` is already set AND a different tier is
     requested, destroy the prior session and null `sessionPromise` before
     creating (do NOT overlap; ADR-R1/R3). Track the active tier in a
     module-scoped `activeTier` variable for the diagnostic and this guard.
   - Awaits `ensureSession()` (which now creates with the overridden config) and
     replies ok, or replies `ok:false` with the error message on a catchable
     failure. A hard crash will instead drop the port/channel (handled
     client-side).
1. In `client.ts`, change `warmupSession()` to accept an optional `tier?: Tier`
   argument, send the new `WARMUP_REQUEST` (carrying the tier when provided),
   and validate the new response. Keep the no-timeout semantics and the
   `ok:false` to throw mapping (lines 163-175). Keep `ensureViaServiceWorker()`
   first.
1. Record the active tier in `collectGpuInfo`/the gpu-info reply so the
   diagnostic can report it later (optional; can also be carried panel-side).
   Prefer panel-side tracking to avoid widening the gpu-info contract; the panel
   knows the tier it requested.

### Verification Checklist

- `warmupSession(tier)` sends a `WARMUP_REQUEST` whose `tier` matches; without a
  tier, sends no `tier` field.
- The protocol guards accept a well-formed warmup request with and without
  `tier`, and reject malformed ones (bad device enum, missing modelName).
- `classifyOffscreenMessage` returns `'warmup'` for the new request and still
  routes the existing three kinds.
- `npm run typecheck`, `npm run lint:ci`, `npm test -- --run` pass.

### Testing Instructions

- `tests/offscreen-protocol.test.ts`: cover `isWarmupRequest`/`isWarmupResponse`
  with/without tier and malformed inputs.
- `tests/offscreen-dispatch.test.ts`: assert the new `'warmup'` routing and that
  existing kinds are unchanged.
- `tests/offscreen-client.test.ts`: mock `sendMessage`; assert the tier is
  forwarded and ok/error mapping holds.
- The `offscreen.ts` `handleWarmup` tier-override logic touches `window` and the
  polyfill; the pure parts (deciding the override object) should be extracted
  into a small pure helper `applyTierToConfig(base, tier)` in
  `src/offscreen/ladder.ts` (or a new `src/offscreen/tier-config.ts`) and
  unit-tested there, since `offscreen.ts` is not in the coverage set. Test that
  `applyTierToConfig` produces the right `{ apiKey, modelName, device, dtype }`.

### Commit Message Template

```text
feat(resilience): let the panel dictate the load tier to offscreen

New warmup protocol message carries an optional tier; the offscreen doc
overrides window.TRANSFORMERS_CONFIG (model/device/dtype) before
LanguageModel.create(), destroying any prior session first so loads
never overlap. Pure applyTierToConfig helper is unit-tested.
```

## Task 2.3: Capability/tier persistence store

### Goal

A pure-ish persistence module over `chrome.storage.local` for the per-device
record (ADR-R7): known-good tier, known-bad tiers, capability snapshot, with
schema/version invalidation.

### Files to Modify/Create

- Create `src/offscreen/capability-store.ts`.
- Create `tests/capability-store.test.ts`.
- Modify `docs/testing.md`.

### Prerequisites

Tasks 2.1 (Tier/tierKey).

### Implementation Steps

1. Define the storage key constant `CAPABILITY_KEY = 'local-nano:capability:v1'`
   and `SCHEMA_VERSION = 1`, plus the `CapabilityRecord` interface from ADR-R7
   (`schemaVersion`, `extensionVersion`, `knownGood: Tier | null`, `knownBad:
   Tier[]`, `capability: { device; isFallback; maxBufferSize }`).
1. Export `async loadCapabilityRecord(extensionVersion: string):
   Promise<CapabilityRecord | null>`: read the key via `chrome.storage.local.get`,
   validate the shape (mirror the `isEntry` guard discipline in `history.ts`),
   and return `null` (treat as absent) when `schemaVersion !== SCHEMA_VERSION`
   or `extensionVersion` mismatches (invalidation per ADR-R7).
1. Export `async recordKnownGood(extensionVersion, tier, capability):
   Promise<void>` and `async recordKnownBad(extensionVersion, tier, capability):
   Promise<void>` that read-modify-write the record (dedupe known-bad by
   `tierKey`; clear a tier from known-bad if it later becomes known-good). Both
   set `schemaVersion` and `extensionVersion`.
1. Export `async clearCapabilityRecord(): Promise<void>` that removes the key
   (set the key to `undefined` is not enough; use `chrome.storage.local.remove`
   if available, else overwrite with a cleared record). Note `FakeStorageArea`
   in `tests/setup.ts` has `get`/`set`/`clear` but no `remove`; add a `remove`
   to the fake in `tests/setup.ts` (mirroring the real API) and use it, OR
   implement clear by writing a record with empty `knownBad`/null `knownGood`.
   Prefer adding `remove` to the fake so the real `remove` path is exercised;
   keep the fake change minimal and reset it in `beforeEach`.
1. Keep all storage access through the promisified `chrome.storage.local`
   (matches `history.ts`). No direct Chrome typing leaks beyond the existing
   pattern.

### Verification Checklist

- A fresh store returns `null` from `loadCapabilityRecord`.
- After `recordKnownGood`, `loadCapabilityRecord` returns the tier as
  `knownGood`.
- `recordKnownBad` accumulates and dedupes by `tierKey`.
- A record with a mismatched `schemaVersion` or `extensionVersion` is treated as
  absent.
- `clearCapabilityRecord` removes the record.
- `npm run typecheck`, `npm run lint:ci`, `npm test -- --run` pass.

### Testing Instructions

`tests/capability-store.test.ts` drives the real module against the
`FakeStorageArea` from `tests/setup.ts`. Cover load/record/clear, dedupe,
known-bad accumulation, known-good clearing a prior known-bad, and both
invalidation paths. If you add `remove` to the fake, reset it in `beforeEach`
alongside the other mocks.

### Commit Message Template

```text
feat(resilience): persist per-device known-good/known-bad tiers

src/offscreen/capability-store.ts read-modify-writes a single
local-nano:capability:v1 record (known-good, known-bad, capability
snapshot) with schema- and extension-version invalidation, over the
existing chrome.storage.local pattern.
```

## Task 2.4: Wire the ladder into the panel warmup

### Goal

Make `ensureWarm` drive the ladder: on cold start, load the persisted known-good
tier (or tier 0); on a load failure, record the known-bad tier, force-recreate
the document, advance the ladder, and retry the next tier; on exhaustion, show
the Phase 1 terminal message (now with the real ladder path and active tier in
the diagnostic). Add a reset/re-detect control.

### Files to Modify/Create

- Modify `src/session.ts` (`ensureWarm`: ladder loop, persistence, reset
  control; feed the real `activeTier` and ladder path into the diagnostic).
- Modify `tests/session.test.ts`.
- Modify `docs/configuration.md` (document the automatic ladder and the
  reset/re-detect control).

### Prerequisites

Tasks 2.1, 2.2, 2.3.

### Implementation Steps

1. Import `PRIMARY_LADDER`, `Tier`, `tierKey`, `nextAction`, `firstTierIndex`
   from `ladder.js`; `loadCapabilityRecord`, `recordKnownGood`, `recordKnownBad`,
   `clearCapabilityRecord` from `capability-store.js`; `recreateOffscreen`
   from `client.js`; `classifyFailure` from `failure.js`.
1. Refactor `ensureWarm` into a ladder loop (extract the warmup-attempt body
   into a helper `attemptTier(tier)` that calls `warmupSession(tier)` and
   resolves/throws). The loop:
   - On entry, read the capability record via
     `loadCapabilityRecord(chrome.runtime.getManifest().version)`; compute the
     starting index via `firstTierIndex(PRIMARY_LADDER, knownGood key,
     knownBad keys)`.
   - Track `attemptedIndex` and a `path: Tier[]` list (the tiers tried, for the
     diagnostic).
   - For each `load` action from `nextAction`: set the active tier, call
     `attemptTier(tier)`. On success: `recordKnownGood`, set `modelReady`,
     remove the elapsed hint, break. On failure: classify via `classifyFailure`;
     `recordKnownBad(tier)`; if the next action is another `load`, call
     `recreateOffscreen()` BEFORE the next attempt (ADR-R3/R4: never overlap;
     the prior generator's memory is only freed by recreating the document);
     continue the loop. If `nextAction` returns `exhausted`, break to the
     terminal branch.
   - Keep the elapsed counter ticking across the whole ladder walk (it is
     proof-of-life; the user does not need to know about tier internals). Per-tier
     re-entry should NOT reset the elapsed clock; keep a single `startedAt`.
1. On exhaustion, render the Phase 1 terminal bubble, now passing the real
   `activeTier` (the last attempted tier) and including the ladder `path` in the
   diagnostic input (the diagnostic builder gains a `ladderPath` field in Phase
   5; for Phase 2 include the path in the message text via a simple join, and
   defer the structured field to Phase 5). The Retry button now calls
   `recreateOffscreen()` then re-runs the ladder from `firstTierIndex` after
   optionally clearing known-bad (decide: Retry should NOT clear known-bad by
   default, so it does not re-crash on the same tier; instead Retry re-walks
   skipping known-bad, which will immediately reach exhaustion unless something
   changed — so Retry's value after full exhaustion is limited). Therefore make
   the terminal bubble offer TWO controls: "Retry" (re-walk, skip known-bad) and
   "Reset and re-detect" (call `clearCapabilityRecord()` then re-walk from the
   top). Document this in configuration.md.
1. Add the "Reset and re-detect" control as a small always-available affordance
   is NOT required here (Phase 5 owns the always-available diagnostic
   affordance); for Phase 2 the reset control lives on the terminal bubble only.
1. Preserve constraint 2: the ladder walk is the LOAD-time auto-recovery. The
   stream/runtime path is untouched.

### Verification Checklist

- Cold start with no record loads tier 0; on success it persists known-good.
- A tier-0 load failure records known-bad tier 0, calls `recreateOffscreen`,
  and attempts tier 1; success there persists tier 1 as known-good.
- Full failure across all tiers reaches the terminal bubble with Retry and
  Reset-and-re-detect controls.
- A subsequent cold start with a persisted known-good skips straight to that
  tier (assert `warmupSession` is called first with that tier).
- "Reset and re-detect" clears the record and re-walks from tier 0.
- `recreateOffscreen` is called BETWEEN failed rungs, never overlapping loads.
- All five checks (`typecheck`, `test`, `build`, `lint:ci`, `coverage`) pass.

### Testing Instructions

Extend `tests/session.test.ts`. The mocked `client.js` already returns
`warmupSession`; make it tier-aware (`vi.fn((tier?) => …)`) so a test can reject
the first N calls and resolve a later one, asserting the tier argument
sequence and `recreateOffscreen` interleaving. Use the `FakeStorageArea` to
assert the persisted record after success and after reset. Drive the terminal
path by rejecting all tiers and assert both controls render and behave. Flush
microtasks between rungs with the existing loop pattern.

### Commit Message Template

```text
feat(resilience): auto-walk the dtype/device ladder on load failure

ensureWarm now drives the pure ladder reducer: cold start uses the
persisted known-good tier (else tier 0), a load failure records the
known-bad tier and force-recreates the document before the next rung,
and exhaustion shows the terminal bubble with Retry and
Reset-and-re-detect. Loads never overlap.
```

## Phase Verification

- Full green across all five commands.
- Integration points: panel ladder loop to `warmupSession(tier)` to offscreen
  tier override to polyfill `create()`; failure to `recordKnownBad` plus
  `recreateOffscreen` to next rung; exhaustion to the Phase 1 terminal UI;
  persistence to skip-to-known-good on the next cold start.
- Manual smoke (WebGPU, not CI): on a device where q4f16 fails but q8/fp16/wasm
  succeeds, confirm the ladder advances, recreates the document between rungs,
  loads a working tier, and the next launch starts at that tier. Confirm no
  `VK_ERROR_OUT_OF_DEVICE_MEMORY` from overlapping loads (it must recreate, not
  stack sessions).
- Known limitations carried into Phase 3: the ladder has only the PRIMARY
  model's tiers; there is no smaller-model rung yet and no capability-based
  starting model. The diagnostic carries the ladder path as text, not yet a
  structured field.
