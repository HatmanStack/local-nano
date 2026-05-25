# Roadmap: hardening for a wide Web Store release

Goal: make `local-nano` behave acceptably across the full diversity of GPUs, CPUs,
and Chrome versions a public Web Store audience brings — and when it genuinely
cannot run, tell the user clearly with a manual recovery instead of dying silently.

This is a program of 8 workstreams, not one feature. They are not peers: some are
feature-shaped (design via `/brainstorm` then build via `/pipeline`), and some are
process/release work (a checklist, an `/audit`, a manual test matrix). Sequence and
vehicle below.

## Status (updated 2026-05-24)

Workstreams 1-5 shipped in **v0.3.0** (model-load resilience: graceful failure,
fallback ladder, capability-based model selection, phased download progress,
copy-only diagnostic). #7 (release hygiene) is done; #8 (store listing) is
submitted; #6 (manual smoke) passed a first real-device run. The sections below
are kept as the design record for that effort.

## Next priority (post-0.3.0): idle resource release

The model is never released after use. Once warmed, the offscreen document holds
the multi-GB WebGPU session for the entire browser session: the close button only
hides the panel, and the session is destroyed only on a tier switch or manual
Retry (`offscreen.ts:215,371`); `closeOffscreen()` runs only via Retry/tests.
There is no idle teardown, no release when the last panel closes, and no tab-close
hook. (Audit found no classic accumulating leak — timers, ports, and listeners are
cleaned up; this is one large, never-released allocation.)

Why it's next: memory is the historical killer for this project (the v0.2.0 OOM),
a wide audience includes weak machines, and a persistent multi-GB GPU allocation is
a plausible memory-pressure contributor — a Chrome crash was observed 2026-05-24,
though one crash is not yet conclusive (could be a Dawn/driver/kernel fault).

Approach: free the model (close the offscreen document) after a period of
inactivity OR when the last panel closes, and re-warm on next use. This is
explicitly NOT the removed churny per-stream-error auto-rebuild (do not reintroduce
that) — idle-release frees memory only when genuinely unused, trading a one-time
reload when the user returns.

Caveats:

1. Touches the single-shared-session / offscreen lifecycle — handle with care (the
   v0.2.0 OOM and the removed guard both came from this area).
1. Not unit-testable: needs a cross-device manual smoke pass (CI can't exercise WebGPU).
1. A full browser/tab crash is not catchable by the extension; idle-release reduces
   pressure, it does not "gracefully handle" a crash.

Evidence to gather first: on recurrence, capture the Copy diagnostic (device /
adapter / buffer size) and `chrome://gpu` to distinguish memory pressure from a
driver/kernel crash.

Vehicle: `/brainstorm` then `/pipeline`, targeting 0.3.1 / 0.4.0.

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
