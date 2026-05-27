# Roadmap: hardening for a wide Web Store release

Goal: make `local-nano` behave acceptably across the full diversity of GPUs, CPUs,
and Chrome versions a public Web Store audience brings — and when it genuinely
cannot run, tell the user clearly with a manual recovery instead of dying silently.

This is a program of 8 workstreams, not one feature. They are not peers: some are
feature-shaped (design via `/brainstorm` then build via `/pipeline`), and some are
process/release work (a checklist, an `/audit`, a manual test matrix). Sequence and
vehicle below.

## Status (updated 2026-05-26)

Workstreams 1-5 shipped in **v0.3.0** (model-load resilience: graceful failure,
fallback ladder, capability-based model selection, phased download progress,
copy-only diagnostic). #6/#7/#8 (manual smoke, release hygiene, store listing) are
done; v0.3.0 is on the Web Store.

**v0.4.0** (in progress) adds the user model picker (gear popover, curated
catalog, select-then-Load, update-surviving preference), idle resource release
(`chrome.alarms` inactivity timer, SW-owned hard close, send-path re-warm), and
reasoning-model `<think>` stripping. The shipped catalog (3 live models):
gemma-4-E2B (`webgpu/q4f16`, capable default), Qwen2.5-0.5B (`wasm/q8`, light),
and Qwen3-0.6B (`webgpu/q4f16`, small WebGPU option). Catalog smoke findings
(see `docs/models.md`): Qwen2.5-0.5B is WASM-only (WebGPU parrots — a WebGPU-EP
correctness issue for that model, not precision); Qwen3.5-0.8B is vision-language
(rejected); `Qwen3.5-0.8B-Text` failed to load (the `qwen3_5_text` arch is not
implemented by transformers@4.2.0); Qwen3-1.7B's WebGPU load-failed on a 4 GiB
integrated GPU (only the unusable `wasm/fp16` loaded). The sections below are kept
as the design record for the v0.3.0 effort.

## Next priority (post-0.4.0): cancel an in-flight model load

A model load cannot be interrupted today. While a load is in flight the action
button sits in the disabled "Loading…" state and the popover Load button is either
disabled (during a switch) or merely queues behind the current load (during the
initial panel-open warm, via `reloadModel`'s `await warmInFlight`). There is no way
to abandon a slow or wrong load and start a different model — you wait it out. (See
the model-picker code in `src/session.ts`: `ensureWarm`/`runWarm`, `reloadModel`,
`refreshLoadControl`, `applyPendingModel`.)

Approach: a "Cancel" / "Stop loading" affordance shown during warming that signals
the in-flight ladder walk to stop CLEANLY (return to idle, not render a
terminal/network failure bubble), plus `recreateOffscreen()` to actually kill the
pending `LanguageModel.create()` (transformers.js loads are not directly
abortable). The new load then serializes behind the cancelled one through the
existing `warmInFlight`/`reWarmInFlight` locks.

Caveats:

1. Touches the single-shared-session / offscreen load lifecycle — the most fragile,
   OOM-prone area (the v0.2.0 OOM). `runWarm`'s catch must distinguish "cancelled"
   from "load failed" so a cancel never advances the ladder or shows a crash
   bubble, and the new load must not start until the cancelled one fully unwinds
   (no two concurrent loads).
1. Not unit-testable end to end: needs a manual WebGPU smoke pass (CI can't
   exercise real model loads).

Vehicle: `/brainstorm` then `/pipeline`. Medium lift, high review/smoke overhead.

## Sequencing

| # | Workstream | Cluster | Vehicle | Depends on |
|---|------------|---------|---------|------------|
| 1 | Graceful failure (detect terminal load crash, actionable message, manual retry) | Load lifecycle | brainstorm to pipeline | none (release gate) |
| 2 | Automatic dtype/device fallback ladder (q4f16 to q8/fp16 to wasm) | Load lifecycle | brainstorm to pipeline | 1 |
| 3 | First-run UX (real download progress, network/HF failure handling, disclosure) | Load lifecycle | brainstorm to pipeline | 1 |
| 5 | Observability (in-panel copyable diagnostic; nothing auto-leaves device) | Cross-cutting | brainstorm to pipeline | none (enabler) |
| 4 | Model strategy for low-end devices (smaller default and/or capability-based pick) | Model strategy | brainstorm to pipeline | 1, 2 |
| 6 | Cross-env manual test matrix (WebGPU on/off, buffer class, wasm, Chrome variants) | Release | doc/checklist | 1, 2, 3 |
| 7 | Repo audit and release hygiene (lineage check, stable-vs-dev ORT decision, bump/tag/package) | Release | `/audit` + manual | 1-4 |
| 8 | Store compliance (screenshots, store-name decision, justify `<all_urls>`) | Release | checklist | 6, 7 |

## The load-lifecycle cluster (1, 2, 3)

Workstreams 1-3 all live on the same path — `loadHeavy` to `ensureSession`
(`offscreen.ts`), `ensureWarm` (`src/session.ts`), and the SW ensure path
(`src/background/offscreen.ts`). Designing item 1 in isolation will keep surfacing
item 2 (the recovery *action*) and item 3 (load feedback). Recommend brainstorming
item 1 with items 2 and 3 explicitly in view, even if they ship as separate pipeline
runs.

## Workstream 1 grounding (verified against current code)

Current failure mode, confirmed by reading the code:

1. Sticky-flag silent death. `src/background/offscreen.ts:30,46` — `ensureOffscreen()`
   returns a cached `documentReady` boolean and never re-checks `hasDocument()` once
   set. A crashed offscreen document stays "alive" in the SW's view, so ensure
   no-ops and every subsequent message black-holes. `closeOffscreen()` resets the
   flag but nothing calls it on failure.
1. Warmup swallows failures by design. `src/session.ts:732-742` — `ensureWarm`'s
   catch only logs and resets `warmStarted`; there is no failure UI. The user first
   learns of trouble on send, as a raw error-message bubble.
1. Detection hook already exists. `src/offscreen/stream-client.ts:107-112` rejects
   with "offscreen port disconnected: <reason>" on disconnect — but it is not
   classified as terminal-vs-transient, has no recovery, and renders as a raw error.
1. No force-recreate path. `rebuildSession` only rebuilds the polyfill session inside
   a live document; it cannot recover a document that itself crashed. A manual Retry
   needs a SW path that resets `documentReady` and recreates the document.

What graceful failure must add (design questions for the brainstorm):

1. Reliable terminal-state detection (port disconnect with a crash-shaped reason,
   warmup/ensure rejection, message-channel-closed) distinguished from transient.
1. A user-initiated Retry that force-recreates the offscreen document — single-shot
   and manual. This is NOT the removed churny auto-rebuild (`offscreen.ts:381-386`
   keeps the session alive on stream error on purpose; do not reintroduce auto-churn).
1. A clear, actionable in-panel message ("couldn't load the model on this device —
   try X") replacing the silent dead panel.
1. First brainstorm question: does the SW reliably detect a crashed document, or does
   the sticky `documentReady` cache need to drop / verify liveness before Retry can work?

## Standing constraints (carry into every workstream)

1. 100% on-device and private. Only network use is the one-time HF model-weights download.
1. Single shared offscreen `LanguageModel` session. Never load two concurrently
   (v0.2.0 was reverted for `VK_ERROR_OUT_OF_DEVICE_MEMORY` from a second session).
1. Treat the vendored polyfill (`vendor/prompt-api-polyfill/`) as upstream — work
   through its public surface (e.g. the `monitor`/`downloadprogress` events for #3),
   do not patch it.
1. Text-in/text-out only. Image input/output are out of scope this build.
1. CI cannot exercise WebGPU. Model load is verifiable only by manual smoke test; gate
   releases on the #6 matrix.

## Recommended next step

The load-lifecycle program (#1-#5) shipped in v0.3.0. The next step is the
**idle resource release** described under "Next priority" above: `/brainstorm` it
(triggers, inactivity timeout, interaction with the shared cross-tab session and
the ladder), then `/pipeline`, targeting 0.3.1 / 0.4.0.
