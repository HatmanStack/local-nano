# Phase 2: Chosen-Model Ladder Assembly + Switch Primitive

## Phase Goal

Wire the chosen model into ladder assembly so the picked model heads the ladder
(the existing auto-fallback then steps its dtypes/devices), and build the single
serialized teardown + re-warm primitive that both the model switch and (later)
the idle re-warm share. Still no visible UI: the switch primitive is exercised
through an exported/internal test seam until Phase 3 mounts the Load control.

Success criteria: `assembleLadder` (or a thin wrapper) accepts the chosen model
and produces a ladder headed by that model's tiers; the panel exposes one
serialized re-warm operation guarded by a single in-flight lock; the
no-preference path is behaviorally identical to today; and all checks are green.

Estimated tokens: ~35,000.

## Prerequisites

- Phases 0 and 1 complete and green. ADR-P1, P4, P5, P6, P7 govern this phase.
- `src/offscreen/ladder.ts`, `src/session.ts` (especially `ensureWarm` and the
  `renderTerminalFailure` re-walk driver), and `src/offscreen/client.ts` read in
  full.

## Tasks

> **Task 2.1: Resolve the chosen model into a model-headed ladder**
>
> **Goal:** Given the model preference and the device capability, produce the
> tier ladder that puts the chosen model's tiers first so the existing reducer
> walks them, falling back to today's behavior when there is no preference
> (ADR-P1, P4, P5).
>
> **Files to Modify/Create:**
>
> - `src/offscreen/ladder.ts` (modify) - Add a chosen-model assembly path that
>   composes the chosen catalog entry's tiers with the existing ladder, keeping
>   the reducer untouched.
> - `src/offscreen/catalog.ts` (modify if needed) - Expose whatever the assembly
>   path needs (the entry's `tiers`).
>
> **Prerequisites:**
>
> - Read `assembleLadder` and `PRIMARY_LADDER`/`SMALLER_MODEL_CANDIDATE` in
>   `ladder.ts`. The existing `assembleLadder({ capability, smallerEnabled })`
>   must keep working unchanged for the no-preference path.
>
> **Implementation Steps:**
>
> - Add `assembleLadderForModel(opts: { entry: CatalogEntry | null; capability:
>   DeviceCapability; smallerEnabled?: boolean }): Tier[]`. When `entry` is null
>   (no preference / unknown id), it returns exactly
>   `assembleLadder({ capability, smallerEnabled })` (today's behavior, ADR-P4).
>   When `entry` is the default (gemma-4-E2B) it also returns the existing
>   assembly (so the explicit default and the no-preference path produce the same
>   ladder). When `entry` is a non-default model, the returned ladder is the
>   chosen entry's `tiers` FIRST (so the chosen model heads the walk), and the
>   existing primary/smaller ladder may be appended as a last-resort fallback (so
>   a chosen model that fails entirely still drops back to the working default).
>   Confirm the append order against ADR-P1 and keep it minimal: chosen tiers,
>   then the existing assembled ladder, deduped by `tierKey` so the default model
>   is not listed twice when the chosen model IS the default.
> - To avoid a circular import (`catalog.ts` imports `Tier` from `ladder.ts`),
>   put `assembleLadderForModel` in `ladder.ts` and have it accept the already-
>   resolved `CatalogEntry` (the caller in `session.ts` resolves the entry via
>   `findCatalogEntry`). `ladder.ts` then imports only the `CatalogEntry` TYPE
>   from `catalog.ts` (type-only import keeps it a pure type dependency). If a
>   type-only import still risks a cycle, define `CatalogEntry`'s `tiers` access
>   via a structural parameter (`{ tiers: Tier[] } | null`) so `ladder.ts` needs
>   no `catalog.ts` import at all. Choose the structural-parameter form to keep
>   the modules decoupled.
> - The reducer (`nextAction`, `firstTierIndex`) is unchanged; it walks whatever
>   `Tier[]` it is given.
>
> **Verification Checklist:**
>
> - [x] `assembleLadderForModel({ entry: null, capability: 'capable' })` equals
>       `assembleLadder({ capability: 'capable' })` exactly.
> - [x] The default entry produces the same ladder as the no-preference path.
> - [x] A non-default entry produces a ladder whose first tier is the chosen
>       model's first tier.
> - [x] The fallback append is deduped by `tierKey` (no duplicate tiers when the
>       chosen model overlaps the default ladder).
> - [x] `ladder.ts` gains no Chrome/polyfill/timer import.
>
> **Testing Instructions:**
>
> - Extend `tests/offscreen-ladder.test.ts` with `assembleLadderForModel` cases:
>   null entry equals `assembleLadder`, default entry equals it, non-default
>   entry heads the ladder, dedupe holds. Pure assertions, no Chrome.
> - Run `npx vitest run tests/offscreen-ladder.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(picker): assemble a chosen-model-headed fallback ladder
>
> - assembleLadderForModel composes a chosen model's tiers ahead of the
>   existing assembled ladder, deduped by tierKey
> - null/default entry returns today's assembleLadder result unchanged
> - reducer untouched; pure, no new imports
> ```

---

> **Task 2.2: Read the preference in ensureWarm**
>
> **Goal:** Make the warmup ladder walk resolve the chosen model from the stored
> preference, so a future Load (Phase 3) takes effect, while the no-preference
> path stays identical to today (ADR-P4, P5).
>
> **Files to Modify/Create:**
>
> - `src/session.ts` (modify) - In `ensureWarm`, load the model preference,
>   resolve the catalog entry, and assemble the ladder for it.
>
> **Prerequisites:**
>
> - Read the `ensureWarm` body in `src/session.ts`, especially where it calls
>   `classifyCapability` and `assembleLadder` and sets `chosenModel`.
>
> **Implementation Steps:**
>
> - Near the start of the `ensureWarm` ladder-assembly block, after the GPU
>   preflight and `classifyCapability`, load the preference via `loadModelPref()`
>   and resolve the entry via `findCatalogEntry(pref.modelId, …)` (null when no
>   preference or unknown id).
> - Replace the existing `assembleLadder({ capability, smallerEnabled })` call
>   with `assembleLadderForModel({ entry, capability, smallerEnabled:
>   isSmallerModelEnabled() })`. With no preference this is identical to the
>   current call (ADR-P4), so existing behavior and tests hold.
> - Keep `chosenModel = ladder.length > 0 ? ladder[0].modelName : null` as the
>   diagnostic's chosen-model field; it now reflects the picked model.
> - Do NOT change the `handleWarmup` ordering or the recreate-between-rungs logic
>   (constraint 4, ADR-R2/R3/R4). The chosen model only changes which tiers the
>   walk contains, not how a tier is loaded.
>
> **Verification Checklist:**
>
> - [ ] With an empty preference store, `ensureWarm` walks the same ladder as
>       before (existing session tests still pass).
> - [ ] With a stored non-default model id matching a catalog entry, the first
>       attempted tier is the chosen model's first tier.
> - [ ] With a stored unknown model id, the walk falls back to the no-preference
>       ladder (no crash, no empty ladder).
> - [ ] `chosenModel` in the diagnostic reflects the resolved model.
>
> **Testing Instructions:**
>
> - Extend `tests/session.test.ts`. Seed `chromeMock.storage.local.store` with a
>   `local-nano:model-pref:v1` record for a known NON-GATED catalog model
>   (Qwen2.5-0.5B, whose only tier is `wasm/q8`) and assert the first
>   `warmupSession` tier is that model's first tier (the offscreen client is
>   already `vi.mock`-ed there). Assert the empty-store case is unchanged. Use
>   `vi.spyOn` on `isQwen3_08bEnabled` / `isLargerModelEnabled` if a gated model
>   is needed in a test.
> - Run `npx vitest run tests/session.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(picker): resolve the stored model preference in ensureWarm
>
> - ensureWarm loads model-pref, resolves the catalog entry, and walks
>   assembleLadderForModel; empty preference is identical to today
> - chosenModel diagnostic field reflects the picked model
> - no change to handleWarmup ordering or recreate-between-rungs
> ```

---

> **Task 2.3: Single serialized teardown + re-warm primitive**
>
> **Goal:** Extract the existing recreate + ensureWarm sequence into one
> serialized panel operation guarded by a single in-flight lock, so a model
> switch (and, in Phase 4, an idle re-warm and a send-path recovery) all share
> one path and can never overlap two loads (ADR-P6, constraint 1).
>
> **Files to Modify/Create:**
>
> - `src/session.ts` (modify) - Add the serialized re-warm primitive; route the
>   existing terminal-failure Retry/Reset re-walk through it (DRY).
>
> **Prerequisites:**
>
> - Read the `rewalk` closure inside `renderTerminalFailure` in `src/session.ts`
>   (it already does `recreateOffscreen()` then `ensureWarm()`). That is the
>   pattern this primitive generalizes.
>
> **Implementation Steps:**
>
> - Add a module-or-closure-scoped `let reWarmInFlight: Promise<void> | null =
>   null;` in `initSession`.
> - Add `async function reloadModel(opts?: { resetCapability?: boolean }):
>   Promise<void>`: if `reWarmInFlight` is set, return it (coalesce concurrent
>   callers onto one operation). Otherwise set it to an async IIFE that:
>   resets `warmStarted`/`modelReady` to false; optionally
>   `await clearCapabilityRecord()` when `resetCapability`; `await
>   recreateOffscreen()`; `await ensureWarm()`; and in a `finally` clears
>   `reWarmInFlight = null`. Return that promise.
> - Refactor the `rewalk` closure in `renderTerminalFailure` to call
>   `reloadModel({ resetCapability: resetFirst })` instead of inlining
>   recreate+ensureWarm, so the terminal Retry/Reset and the future switch share
>   one serialized path. Preserve the existing button-disable and bubble-removal
>   behavior around the call.
> - Guard against overlapping a live GENERATION: `reloadModel` must not start
>   while `activeAbort` is set (a stream is in flight). Per ADR-P7 the switch
>   waits, so the caller (Phase 3 Load button) is responsible for blocking while
>   `activeAbort` is set; `reloadModel` itself documents the precondition and may
>   assert it (e.g. early-return or await a small idle check) but must never abort
>   the active stream. Keep the precondition in the caller per ADR-P7; document
>   it here.
> - Do NOT introduce a second `LanguageModel.create`; the offscreen side already
>   destroys the prior session before creating (constraint 1, ADR-R3). The
>   recreate in `reloadModel` tears the whole document down first.
>
> **Verification Checklist:**
>
> - [ ] Two concurrent `reloadModel()` calls share one promise: exactly one
>       `recreateOffscreen` and one ladder walk run (assert call counts).
> - [ ] `reloadModel({ resetCapability: true })` clears the capability record
>       before recreating.
> - [ ] After `reloadModel` resolves, `reWarmInFlight` is null (a later call
>       runs a fresh operation).
> - [ ] The terminal-failure Retry and Reset still work (existing tests pass)
>       and now route through `reloadModel`.
> - [ ] No path starts a recreate while `activeAbort` is set.
>
> **Testing Instructions:**
>
> - Extend `tests/session.test.ts`. Drive `reloadModel` (via the seam Phase 3
>   will use, or via the existing Retry button which now calls it) and assert the
>   coalescing (mock `recreateOffscreen` to a deferred promise, fire two reloads,
>   resolve, assert one recreate). Assert the existing Retry/Reset terminal tests
>   still pass against the refactor.
> - Run `npx vitest run tests/session.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> refactor(picker): one serialized teardown+re-warm primitive
>
> - reloadModel() coalesces concurrent callers onto one in-flight promise
> - recreateOffscreen + ensureWarm, optional capability reset
> - terminal Retry/Reset re-walk now routes through reloadModel (DRY)
> - never overlaps two loads; never starts while a stream is in flight
> ```

## Phase Verification

- `npm run typecheck`, `npm test -- --run`, `npm run build`, `npm run lint:ci`,
  `npm run coverage` all green.
- The no-preference path is behaviorally identical to today: with an empty
  preference store the ladder, the recreate-between-rungs logic, and the terminal
  UI are unchanged. Existing `tests/session.test.ts` cases pass without
  contract-rewrites except where a test now seeds a preference on purpose.
- A stored preference for a known catalog model changes only WHICH tiers the walk
  contains; loading a tier is unchanged.
- `reloadModel` is the single serialized re-warm path; the terminal Retry/Reset
  routes through it.

### Integration points to verify

- `ensureWarm` reads the preference and assembles the chosen-model ladder.
- `reloadModel` wraps recreate + ensureWarm under one lock and is reused by the
  terminal failure controls.

### Known limitations carried forward

- No UI yet calls `reloadModel` for a switch; Phase 3 adds the Load button.
- Idle release and send-path re-warm recovery are Phase 4; `reloadModel` is the
  primitive they will reuse.
- The chosen-model switch and re-warm are WebGPU-load dependent end-to-end and
  are manual-smoke only (Phase-0 matrix steps 1, 2).
