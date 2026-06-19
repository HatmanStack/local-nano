# Phase 3: Capability-Based Model Selection and Smaller-Model Rung

## Phase Goal

Add capability-based upfront model selection and a smaller-model ladder rung,
both built and unit-tested, with the ACTUAL smaller-model identity held behind a
clearly-marked, default-off flag pending manual WebGPU vetting. Capability
classification picks the starting model so a weak device never downloads a model
it cannot run; the smaller model's own short ladder runs after the primary
model's tiers are exhausted (only when the flag is on). Success criteria: the
capability classifier and the extended ladder are fully unit-tested; with the
flag off, behavior is identical to Phase 2 (primary model only); the hook is
ready to enable after manual vetting; build/tests/lint/coverage stay green.
Estimated tokens: ~50,000.

## Prerequisites

- Phase 2 merged (ladder reducer, runtime tier override, persistence, panel
  ladder loop).
- ADR-R8 (flagged smaller model, primary unchanged), ADR-R9 (capability
  thresholds) govern this phase.
- Baseline green.
- Re-read `src/session.ts` `preflightWarning` (lines 100-110, the existing 1 GiB
  boundary), `getGpuInfo` usage in `ensureWarm`, and `src/offscreen/ladder.ts`
  from Phase 2.

## Task 3.1: Capability classifier (pure)

### Goal

A pure function mapping a `GpuInfoSnapshot` to `'capable' | 'weak'` per the
ADR-R9 thresholds, reusing the existing capability boundary.

### Files to Modify/Create

- Create `src/offscreen/capability.ts`.
- Create `tests/capability.test.ts`.
- Modify `docs/testing.md`.

### Prerequisites

None beyond Phase 0/2.

### Implementation Steps

1. Import the `GpuInfoSnapshot` type from `protocol.js`.
1. Export `type DeviceCapability = 'capable' | 'weak'` and
   `classifyCapability(info: GpuInfoSnapshot): DeviceCapability` implementing
   ADR-R9 exactly:
   - `device === 'wasm'` → `weak`.
   - `device === 'webgpu'` and `isFallback` → `weak`.
   - `device === 'webgpu'`, not fallback, `maxBufferSize !== null` and
     `maxBufferSize < 1024 * 1024 * 1024` → `weak`.
   - otherwise → `capable`.
1. Export the boundary constant `CAPABLE_MIN_BUFFER_BYTES = 1024 * 1024 * 1024`
   and reference it in both `classifyCapability` and (in a later refactor, not
   required) `preflightWarning`, so the codebase has ONE capability boundary.
   For this phase, define it here and import it into `src/session.ts`'s
   `preflightWarning` to replace the inline `1024 * 1024 * 1024` literal (a
   pure, behavior-preserving change; keep a test asserting `preflightWarning`
   still returns the same advisory for a sub-1-GiB buffer).

### Verification Checklist

- `classifyCapability({ device: 'wasm', … })` → `weak`.
- `isFallback: true` on webgpu → `weak`.
- webgpu, not fallback, `maxBufferSize` 512 MiB → `weak`; 2 GiB → `capable`;
  `null` → `capable`.
- `preflightWarning` behavior is unchanged after the constant swap.
- `npm run typecheck`, `npm run lint:ci` pass.

### Testing Instructions

Pure unit tests in `tests/capability.test.ts` covering each branch and the
boundary value exactly at 1 GiB (which must be `capable`, since the cutoff is
strict less-than). Keep an assertion in `tests/session.test.ts` (or
capability.test) that the shared constant equals the old literal so the
preflight wording does not silently drift.

### Commit Message Template

```text
feat(resilience): add pure device-capability classifier

src/offscreen/capability.ts maps a GpuInfoSnapshot to capable/weak using
the existing 1 GiB max-buffer boundary (now a single shared constant
also consumed by preflightWarning). No behavior change while the
smaller-model rung stays disabled.
```

## Task 3.2: Smaller-model rung and capability-aware ladder assembly

### Goal

Extend the ladder module to optionally append a smaller model's own short ladder
and to assemble the full ladder given device capability, all behind the
default-off flag. No live model identity change.

### Files to Modify/Create

- Modify `src/offscreen/ladder.ts` (smaller-model constants, flag, assembly
  function).
- Modify `tests/offscreen-ladder.test.ts`.

### Prerequisites

Task 3.1.

### Implementation Steps

1. Add the build-time flag `export const SMALLER_MODEL_ENABLED = false;` with a
   prominent comment: enabling requires manual WebGPU smoke vetting (CI cannot
   test WebGPU); see the manual-vetting task 3.4 and `docs/models.md`.
1. Add the candidate constant `export const SMALLER_MODEL_CANDIDATE: Tier[]`
   documenting the vetted-on-WASM candidate from `docs/models.md`:
   `onnx-community/Qwen2.5-0.5B-Instruct`. Define its short ladder as
   wasm/q8 first (the only combination `docs/models.md` reports as actually
   working for this model), optionally a webgpu/q4f16 rung marked UNVETTED in a
   comment. Keep the array small and clearly annotated. Do NOT change
   `.env.json`, `.env.example.json`, or `docs/configuration.md`'s default model
   (ADR-R8; keeps `tests/docs-config.test.ts` green).
1. Add `export function assembleLadder(opts: { capability: DeviceCapability;
   smallerEnabled?: boolean }): Tier[]` that:
   - When `smallerEnabled` is false (default, reading `SMALLER_MODEL_ENABLED`):
     return `PRIMARY_LADDER` unchanged regardless of capability (the live
     behavior; primary model only).
   - When `smallerEnabled` is true and `capability === 'weak'`: return the
     smaller model's ladder FIRST, then the primary ladder as a last resort (a
     weak device should try the small model first), OR return only the smaller
     ladder if the primary is known too heavy. Document the chosen order
     (recommend: smaller-first, primary appended) so a weak device that can
     somehow run the primary still has a path.
   - When `smallerEnabled` is true and `capability === 'capable'`: return
     `PRIMARY_LADDER` then the smaller ladder appended as the final fallback
     (so a capable device that still fails the whole primary ladder drops to the
     small model).
1. Keep `nextAction`/`firstTierIndex` unchanged; they already operate on any
   `Tier[]`. The assembly just produces the array.

### Verification Checklist

- With the flag off, `assembleLadder` returns exactly `PRIMARY_LADDER` for both
  capabilities.
- With `smallerEnabled: true`, a `weak` device gets the smaller ladder first,
  then primary; a `capable` device gets primary first, then smaller.
- The smaller candidate tier list contains the documented model and its
  vetted-on-WASM combination.
- `npm run typecheck`, `npm run lint:ci`, `npm test -- --run` pass.

### Testing Instructions

Extend `tests/offscreen-ladder.test.ts` to cover `assembleLadder` for all four
(capability x flag) combinations, asserting tier order and that the flag-off
path equals `PRIMARY_LADDER`. Also assert `nextAction` walks an assembled
smaller-enabled ladder to `exhausted` correctly.

### Commit Message Template

```text
feat(resilience): add flagged smaller-model rung to the ladder

Ladder gains a default-off SMALLER_MODEL_ENABLED flag, a documented
smaller-model candidate (Qwen2.5-0.5B-Instruct, vetted on WASM in
docs/models.md), and assembleLadder() that composes primary plus smaller
tiers by capability. Flag-off behavior is unchanged (primary only).
```

## Task 3.3: Wire capability selection into the panel

### Goal

Have the panel classify capability from the `getGpuInfo` snapshot it already
fetches and assemble the ladder accordingly, with the flag off keeping behavior
identical to Phase 2.

### Files to Modify/Create

- Modify `src/session.ts` (`ensureWarm`: classify capability, assemble the
  ladder, record the capability in the persisted record and diagnostic).
- Modify `tests/session.test.ts`.

### Prerequisites

Tasks 3.1, 3.2.

### Implementation Steps

1. In `ensureWarm`, after the existing preflight `getGpuInfo()` snapshot, call
   `classifyCapability(info)` and `assembleLadder({ capability })` (which reads
   `SMALLER_MODEL_ENABLED` internally; pass it through if a test needs to force
   it on). Use the assembled ladder in place of `PRIMARY_LADDER` for the loop
   and for `firstTierIndex`.
1. Pass the `capability` snapshot through to `recordKnownGood`/`recordKnownBad`
   so the persisted `capability` field reflects the live device (it already
   accepts a capability argument from Phase 2).
1. With the flag off, `assembleLadder` returns `PRIMARY_LADDER`, so the loop is
   behaviorally identical to Phase 2. Add a test that forces the flag on (by
   passing `smallerEnabled: true` to `assembleLadder` via a seam, or by mocking
   the constant) to prove the weak-device path would try the smaller model
   first.
1. Do NOT enable the flag. Leave `SMALLER_MODEL_ENABLED = false`.

### Verification Checklist

- Flag off: a weak-classified device still walks only the primary ladder
  (behavior unchanged from Phase 2).
- With the flag forced on in a test, a weak device's first `warmupSession` tier
  is the smaller model's first tier.
- The persisted record's `capability` reflects the classified snapshot.
- All five commands pass.

### Testing Instructions

Extend `tests/session.test.ts`. Use the existing `getGpuInfo` mock to return a
weak snapshot (`isFallback: true` or a small `maxBufferSize`) and assert the
ladder used. To exercise the flag-on path without flipping the production
constant, prefer giving `ensureWarm` a seam (e.g. read
`SMALLER_MODEL_ENABLED` through a function `isSmallerModelEnabled()` that the
test can `vi.spyOn`), or test `assembleLadder` directly with `smallerEnabled:
true` and assert the panel passes the assembled ladder through. Keep the
production default off.

### Commit Message Template

```text
feat(resilience): pick the starting ladder by device capability

ensureWarm classifies the queried GPU snapshot and assembles the ladder
accordingly, persisting the capability in the per-device record. With
the smaller-model flag off, a weak device still walks only the primary
ladder, so live behavior is unchanged.
```

## Task 3.4: Manual-vetting task marker and docs

### Goal

Make the path to enabling the smaller model explicit and safe, and keep docs
accurate. This task lands NO live behavior change.

### Files to Modify/Create

- Modify `docs/models.md` (add a short note that the smaller-model rung exists
  in code behind `SMALLER_MODEL_ENABLED`, defaulting off, and what manual
  vetting is required to enable it).
- Modify `docs/testing.md` (add `tests/capability.test.ts`; confirm
  `offscreen-ladder` and others already listed).
- Optionally add a `docs/plans/2026-05-24-model-load-resilience/` note is not
  needed; keep the marker in code comments and `docs/models.md`.

### Prerequisites

Tasks 3.1-3.3.

### Implementation Steps

1. In `docs/models.md`, add a subsection "Smaller-model fallback rung (gated)"
   stating: the ladder can append a smaller model behind `SMALLER_MODEL_ENABLED`
   (default false); the candidate is `onnx-community/Qwen2.5-0.5B-Instruct`,
   vetted on WASM here but NOT yet vetted on WebGPU; enabling requires running
   the manual WebGPU smoke matrix (#6) against the candidate at each tier and
   confirming it loads and answers coherently; CI cannot do this. Cross-link the
   existing "Models we tried" table.
1. Add the `tests/capability.test.ts` row to `docs/testing.md`'s table and run
   the drift guard.
1. Add a code comment at `SMALLER_MODEL_ENABLED` pointing to this doc note.
1. Keep markdown lint clean.

### Verification Checklist

- `npx vitest run tests/docs-config.test.ts` passes (testing.md drift guard).
- `docs/models.md` and `docs/configuration.md` still reference the unchanged
  default model (no `.env*` change), so the configuration cross-reference test
  stays green.
- `npm run lint:ci` passes.

### Testing Instructions

Run the docs-config drift guard. No new test code.

### Commit Message Template

```text
docs(models): document the gated smaller-model fallback rung

Note the default-off SMALLER_MODEL_ENABLED hook, the WASM-vetted but
WebGPU-unvetted candidate, and the manual WebGPU smoke vetting required
to enable it. List the new capability test in testing.md.
```

## Phase Verification

- Full green across all five commands.
- Integration points: `getGpuInfo` snapshot to `classifyCapability` to
  `assembleLadder` to the Phase 2 ladder loop; capability persisted in the
  per-device record.
- Manual smoke (WebGPU, not CI; this is the gate to enabling the flag): only
  after this lands and the #6 matrix has vetted the candidate on WebGPU at each
  tier should a follow-up flip `SMALLER_MODEL_ENABLED` to true. Until then the
  rung is dormant.
- Known limitations carried into Phase 4: there is still no real download
  progress (the elapsed counter only); the smaller model is not live.
