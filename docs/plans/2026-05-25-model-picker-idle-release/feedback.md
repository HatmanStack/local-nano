# Feedback Log

This file is the channel between the Plan Reviewer and the Planning Architect.
Reviewer entries are tagged `PLAN_REVIEW`. The architect resolves each item,
moves it to Resolved with a short note on what changed, and the implementer
treats Resolved items as binding context.

## Active Feedback

_None._

## Resolved Feedback

### PLAN_REVIEW 2026-05-25 (resolved 2026-05-25)

1. **Critical, unvetted-WebGPU contradiction (Qwen3.5-0.8B).** RESOLVED by
   gating Qwen3.5-0.8B and dropping it from the non-gated/live set. `docs/models.md`
   shows it has no clean preferred WebGPU tier (numerical breakdown on
   `webgpu/q4f16`; SIGILL-caveated `webgpu/q4` the project abandoned in
   CHANGELOG 0.2.4; `GatherBlockQuantized` failures on WASM quantized variants),
   so it cannot be a live default. Changes:
   - ADR-P2 rewritten and retitled "A model is non-gated only with a clean
     docs/models.md-vetted tier; everything unvetted is gated, off." It now names
     the only two non-gated live entries (gemma-4-E2B `webgpu/q4f16`,
     Qwen2.5-0.5B `wasm/q8`) and adds a `QWEN3_08B_ENABLED = false` gate for
     Qwen3.5-0.8B alongside `LARGER_MODEL_ENABLED`. It explicitly states no entry
     is called "already-vetted" on WebGPU unless `docs/models.md` marks a clean
     cell working, and Qwen3.5-0.8B does not.
   - Phase-1 Task 1.1 rewritten: the only non-gated smaller entry is Qwen2.5-0.5B
     with a single `wasm/q8` tier; Qwen3.5-0.8B is a gated entry encoding only
     the slow vetted per-component WASM path with no clean-WebGPU claim. New
     `QWEN3_08B_ENABLED` / `isQwen3_08bEnabled()` seam; `listCatalog`/
     `findCatalogEntry` take a `qwen3Enabled` option. Verification checklist now
     asserts no non-gated entry encodes `webgpu/q4` or any failing/caveated cell.
   - Phase-1 Phase Goal, known-limitations, and commit template updated;
     downstream Phase-2 (Task 2.2 test seeds a non-gated model) and Phase-3
     (Task 3.2 lists production = 2 rows; gated tests spy both seams) updated;
     Phase-0 manual-smoke matrix step 6 now requires a clean SIGILL-free tier
     before flipping either gate; README out-of-scope updated.
1. **Suggestion: note/downloadSize reflect the guide's real cells.** RESOLVED.
   Phase-1 Task 1.1 now specifies the non-gated Qwen2.5-0.5B `note` and
   `downloadSize` from the guide's real cell (`'smallest that answers; CPU/WASM
   only, ~1-3 tok/s'`, `'~0.5 GB'`) and the gated Qwen3.5-0.8B `note` reflects
   its reality (`'WebGPU-quirky; WASM only via slow per-component path; unvetted
   on WebGPU'`), not an optimistic paraphrase.
1. **Suggestion: commit to a touch-idle listener placement.** RESOLVED. Phase-4
   Task 4.5 now commits to extending the existing `installEnsureListener` with a
   third touch-idle branch (no sibling install function), reusing the single
   `chrome.runtime.onMessage` registration and the MV3 channel-race discipline;
   `background.ts` adds only `chrome.alarms.onAlarm.addListener(handleAlarm)`.
   Commit template updated to match.

## Phase Approvals

### Phase 4 CODE_REVIEW 2026-05-25 PHASE_APPROVED

Idle resource release. Reviewed against Phase-0 (ADR-P8 through P11, constraints
1, 2, 3) and Phase-4 Tasks 4.1 through 4.7. All load-bearing MV3 invariants
verified against actual code.

1. Tooling green: `npm run typecheck` clean; `npm test` 554 passed across 24
   files; `npm run build` produces `dist/` (background/content/offscreen);
   `npm run lint:ci` no fixes on 64 files; `npm run coverage` above thresholds
   (95.54 lines, 88.79 branches, 98.36 funcs) with `idle-policy.ts` at 100
   percent (Phase Verification requirement), `dispatch.ts`/`model-pref.ts`/
   `failure.ts` at 100, `src/background/offscreen.ts` at 92.54 (uncovered lines
   are the SW-devtools `streamPrompt`/`sendPrompt` wrappers, not idle logic).
1. Alarms-not-setTimeout: `manifest.json` permissions are
   `["storage", "offscreen", "alarms"]`; `tests/setup.ts` mocks
   `chrome.alarms` (create/clear/onAlarm) with a `_fireAlarm` helper and resets
   in `beforeEach`; no `setTimeout`/`setInterval` in the SW/idle path.
1. HARD release by the SW only: `handleAlarm` calls the existing
   `closeOffscreen()` (resets sticky `documentReady`); `offscreen.ts` has no
   `window.close`/`closeDocument`/self-teardown; `handleIsBusy` only reports
   `generationGate.busy`.
1. Verify-idle real: `queryOffscreenBusy()` round-trips `IS_BUSY_REQUEST` and
   defaults to not-busy on malformed/absent/lastError/throw; the busy ->
   reschedule and idle -> close paths route through the pure `decideIdleAction`
   and are unit-tested in `tests/background-offscreen.test.ts` (close-once,
   busy-reschedule with `when` math, malformed-safe-close, gone-doc-safe-close,
   Never-clears).
1. Touch-idle wiring: a third `isTouchIdleRequest` branch lives INSIDE the
   existing `installEnsureListener` (not a sibling install); `background.ts`
   adds only `chrome.alarms.onAlarm.addListener(handleAlarm)`.
1. Send-path recovery bounded to one retry via the existing `classifyFailure`
   `=== 'terminal'` seam and the serialized `reloadModel`/`ensureWarm` lock
   (`reWarmInFlight`); only one `LanguageModel.create` in the tree (offscreen.ts);
   non-terminal errors do not re-warm. Tested: single-retry, no-rewarm-on-
   non-terminal, bounded-second-failure, proactive-rewarm.
1. touch-idle fires on generation start and completion in `runStreamTurn`, NOT
   on the panel-open toggle (which calls only `ensureWarm`); both assertions
   covered in `tests/session.test.ts`.
1. New protocol guards (touch-idle, is-busy) follow the existing discipline;
   `isIsBusyResponse` requires a boolean `busy` on the ok branch; all four
   constants/guards tested with valid/missing/wrong-type/foreign cases.
1. Seven atomic conventional commits (`chore(idle)` + six `feat(idle)`), no
   Co-Authored-By/Generated-By trailers; `tests/offscreen-idle-policy.test.ts`
   listed in `docs/testing.md` (drift guard satisfied).

WebGPU/real-VRAM idle-release-then-return is manual-smoke-only per Phase-0,
correctly not gated on CI tests.
