# Plan: Model Picker + Idle Resource Release

## Overview

`local-nano` runs one shared `LanguageModel` session in a hidden offscreen
document, shared across tabs. Today the model is fixed (`.env.json` pins
`onnx-community/gemma-4-E2B-it-ONNX`; the fallback ladder in
`src/offscreen/ladder.ts` auto-walks dtype/device tiers within it), and the
session is never freed once warmed: closing the panel only hides it, and the
offscreen document is torn down only on a tier switch or a manual Retry. The
result is a multi-GB WebGPU allocation held for the entire browser session, the
historical memory-pressure risk this project is most sensitive to (the v0.2.0
OOM).

This plan ships two features that ride the same single-shared-session lifecycle
and the same teardown + re-warm machinery. The **model picker** adds a
gear/settings popover in the panel header that lets the user choose a model from
a curated catalog (smaller and larger than the gemma-4-E2B default), persisted
under a preference key that survives extension updates. The user picks a model
only; the existing capability classifier and fallback ladder still auto-step
dtype/device within the chosen model. Switching is select-then-explicit-Load so
a multi-GB reload never happens on a stray click. **Idle resource release**
frees the model by closing the whole offscreen document after an inactivity
timeout measured from the last generation, driven by `chrome.alarms` so it
survives service-worker eviction, with the timeout configurable in the same
popover (default 15 min, "Never" opt-out).

Both features collapse onto one teardown + re-warm operation guarded by one
lock: a model switch and an idle release are the same act (close the document,
re-warm against the resolved model/tier). They reuse the existing
`recreateOffscreen()` + `ensureWarm()` path. Re-warm must be recoverable from
the send path, not just panel-open, because an idle release can fire while a
backgrounded content script is still alive.

## Prerequisites

- Node version pinned in `.nvmrc` (currently 20). Run `nvm use` before any
  command.
- `npm ci` from a clean clone. The project uses npm; `package-lock.json` is
  authoritative.
- Familiarity with the offscreen-document architecture. Read `offscreen.ts`
  (repo root), `src/session.ts`, `src/background/offscreen.ts`, `background.ts`,
  `content.ts`, and every module under `src/offscreen/` (`ladder`, `capability`,
  `capability-store`, `client`, `protocol`, `dispatch`, `failure`, `progress`,
  `diagnostic`, `busy-gate`, `stream-client`) before starting.
- `npm run typecheck`, `npm test -- --run`, `npm run build`, and
  `npm run lint:ci` must pass clean on a fresh clone before any plan work begins.
  If they do not, stop and report.
- Read `Phase-0.md` in full first. It is the law for every later phase.

## Phase Summary

| Phase | Goal | Token Estimate |
| ----- | ---- | -------------- |
| 0 | Foundation: ADRs, conventions, polyfill/MV3 constraints, testing strategy | ~10,000 |
| 1 | Curated model catalog + model-preference persistence (pure seams, no UI) | ~30,000 |
| 2 | Chosen-model ladder assembly + serialized teardown/re-warm switch | ~35,000 |
| 3 | Gear popover UI: model picker + idle-timeout selector + Load control | ~35,000 |
| 4 | Idle resource release: alarm scheduling, verify-idle close, send-path re-warm | ~45,000 |

Each phase leaves the build green and the extension usable. Phases 1 and 2 are
pure-seam and wiring work behind no new visible UI. Phase 3 surfaces the popover.
Phase 4 adds the SW-owned idle teardown.

## Phase Sequencing Rationale

- **Phase 1 first.** The catalog and the preference store are pure modules with
  no Chrome-load dependency, so they are fully unit-testable and unblock every
  later phase. No behavior changes for users (default = today's auto-pick).
- **Phase 2 next.** Wiring the chosen model into ladder assembly and building the
  single serialized teardown/re-warm primitive depends on the catalog and the
  preference store from Phase 1. Still no visible UI; the switch primitive is
  driven by a test seam until Phase 3 mounts the control.
- **Phase 3** mounts the gear popover (model list + idle-timeout selector + Load
  button) into the panel header, reusing the existing header-mount pattern. The
  Load button calls the Phase 2 switch primitive.
- **Phase 4** adds the idle-release half: a pure idle-policy module, the
  `chrome.alarms` scheduling/reset on each generation, the SW-owned verify-idle
  close, and send-path re-warm recovery. It reuses the Phase 2 teardown/re-warm
  lock so an alarm and a user Load cannot race.

## What is out of scope

- No dtype/device picker UI. Dtype stays automatic via the existing ladder.
- No arbitrary Hugging Face model IDs. Catalog only.
- No model shipped live without a clean `docs/models.md`-vetted tier. The only
  non-gated live entries are gemma-4-E2B (`webgpu/q4f16`) and Qwen2.5-0.5B
  (`wasm/q8`). Qwen3.5-0.8B (no clean preferred WebGPU tier) and any larger model
  ship gated off (`QWEN3_08B_ENABLED`, `LARGER_MODEL_ENABLED`) until a manual
  WebGPU smoke pass, mirroring `SMALLER_MODEL_ENABLED`.
- No per-site / per-URL model selection. Selection is global.
- No last-panel-close or tab-close release trigger. Inactivity-from-last-
  generation is the only release trigger this build.
- No soft release (keep-doc, destroy-session-only). Hard close only.
- No change to the primary default model or to the per-device known-good/known-
  bad persistence semantics.
- No crash handling. A full browser/GPU/Dawn crash is not catchable by the
  extension.
- No patching of the vendored polyfill.

## Navigation

- [Phase-0](./Phase-0.md) — Foundation, ADRs, conventions
- [Phase-1](./Phase-1.md) — Curated catalog + model-preference persistence
- [Phase-2](./Phase-2.md) — Chosen-model ladder assembly + switch primitive
- [Phase-3](./Phase-3.md) — Gear popover UI
- [Phase-4](./Phase-4.md) — Idle resource release
- [feedback.md](./feedback.md) — Reviewer feedback log
- [brainstorm.md](./brainstorm.md) — Source brainstorm
