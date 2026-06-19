# Feature: Model-Load Resilience

Covers ROADMAP workstreams #1–#5: graceful failure, automatic dtype/device fallback
ladder, first-run download progress, capability-based model selection, and a
privacy-preserving diagnostic. This is the release gate for a wide Chrome Web Store
audience — the cluster that makes the on-device model load survive contact with the
full diversity of GPUs/CPUs/Chrome builds, or fail legibly when it can't.

## Overview

`local-nano` loads one `LanguageModel` session in an offscreen document and shares it
across tabs. Today that load path has three release-blocking gaps. First, it can die
silently: the service worker caches a sticky `documentReady` boolean
(`src/background/offscreen.ts:30,46`) and never re-checks `hasDocument()` once set, so
when the offscreen document hard-crashes (e.g. the `q4` WebAssembly SIGILL described in
the seed), `ensureOffscreen()` no-ops forever and every subsequent message black-holes.
Second, warmup failures are swallowed by design (`src/session.ts:732-742` only logs and
resets `warmStarted`), so the user first learns of trouble as a raw error bubble on
send. Third, the only load feedback is an elapsed-seconds counter — no real progress, no
recovery, no capability awareness.

This feature reshapes the load path into a resilient state machine. On a model-LOAD
failure it auto-walks a fallback ladder (dtype/device tiers within the chosen model,
then a smaller model, then a graceful stop). The model itself is chosen up front by
device capability so weak devices never download a model they can't run. First-run load
shows phased progress (a real percentage during the weights download, then an
indeterminate "loading into GPU" phase). When the ladder is fully exhausted the panel
proactively shows an actionable terminal message with a manual Retry that force-recreates
the crashed offscreen document. A rich, copy-only diagnostic is always available and is
embedded in failure messages so remote bug reports are actionable.

The hard line from the seed is preserved: automatic recovery happens only at LOAD time.
A mid-stream or terminal runtime crash never triggers an automatic rebuild (the churny
zero-chunk auto-rebuild guard was removed for worsening OOM on constrained GPUs and stays
removed). Recovery there is manual only.

## Decisions

1. **Scope = ROADMAP #1–#5** (feature-shaped work). Process/release items #6 (test
   matrix), #7 (repo audit + release hygiene), #8 (store compliance) are excluded — they
   are not feature-shaped and get their own vehicles. Rationale: one `brainstorm.md` →
   one `/pipeline`; mixing process work makes the spec unwieldy.
1. **Recovery policy: auto on load, manual on stream.** Model-load failure auto-walks the
   ladder; a mid-stream/terminal crash shows a message + manual Retry and never
   auto-rebuilds. Rationale: seed lesson 3 — session churn worsened OOM; the removed
   mid-stream guard must not return. `offscreen.ts:381-386` already keeps the session
   alive on stream error; that stays.
1. **Recovery ladder shape.** Capability picks the model first; then the dtype/device
   ladder `q4f16 → q8 → fp16 → wasm` runs within that model; if all tiers fail, drop to
   the smaller model and run its own ladder; if that also exhausts, give up gracefully
   (terminal message + Retry + diagnostic). Rationale: maximum resilience for a wide
   audience; the double multi-GB download only happens in the genuine worst case.
1. **Capability-based upfront model pick (#4).** Use `getGpuInfo`
   (`src/offscreen/client.ts:193`, returns device/isFallback/maxBufferSize) at first load
   to choose the model: capable → `onnx-community/gemma-4-E2B-it-ONNX`, weak → a smaller
   model. Rationale: avoids downloading the heavy model on devices that can't run it
   (better than loading-then-failing).
1. **Persist the resolved tier per device (#1/#2).** Record the known-good and known-bad
   model+dtype+device tier in `chrome.storage.local` under a new global key (distinct
   from the per-URL history keys). Cold start skips straight to the known-good tier; a
   reset/re-detect control re-walks from the top. Rationale: a SIGILL-class crash is
   deterministic per device — re-trying the top tier every launch would crash every
   launch.
1. **Ladder state machine lives panel/SW-side.** Because a SIGILL kills the offscreen
   document before it can report which tier failed, the orchestration (which tier to try,
   recording failures, driving the force-recreate) must run in a context that survives the
   crash — the panel (`src/session.ts`) and/or the SW (`src/background/offscreen.ts`),
   with state in `chrome.storage`.
1. **Force-recreate on Retry.** Retry must reset the sticky `documentReady`
   (`src/background/offscreen.ts`) and recreate the offscreen document — `closeOffscreen()`
   then `ensureOffscreen()`, or a new dedicated SW "recreate" message. Rationale:
   `rebuildSession` only rebuilds the polyfill session inside a *live* document; it cannot
   recover a document that itself crashed.
1. **Phased progress (#3).** Pass a `monitor` into the polyfill's `create()` (it emits
   `downloadprogress` ProgressEvents — see `vendor/prompt-api-polyfill/prompt-api-polyfill.js:437-475`)
   and relay progress from the offscreen document to the panel. UI: "Downloading model
   NN%" (real percentage) → "Loading into GPU…" (indeterminate, elapsed counter) → ready.
   Rationale: only the download phase exposes a real percentage; a single bar would park
   at 100% during compile/upload and look hung.
1. **Distinct network/HF failure handling (#3).** A weights-download/network failure gets
   its own retryable message ("couldn't download the model — check your connection"),
   separate from a device-incapability terminal message.
1. **Proactive failure surfacing at warmup (#1).** When the ladder is fully exhausted
   during the panel-open warmup, show the terminal message + Retry immediately — do not
   wait for a send. Replaces today's silent degrade-to-lazy (`src/session.ts:732-742`).
   Rationale: "never a silent dead panel."
1. **Rich, always-available, copy-only diagnostic (#5).** Contents: device (webgpu/wasm),
   isFallback, maxBufferSize, chosen model + active dtype tier, the ladder path taken,
   error class + message, extension version, Chrome/UA version. Embedded in failure
   messages and reachable any time via a small panel affordance; copy-to-clipboard only.
   Rationale: zero telemetry made remote diagnosis brutal; nothing leaves the device
   automatically (hard privacy constraint).
1. **Vendored polyfill is upstream — no patching.** All of the above works through the
   polyfill's public surface (`create()` options incl. `monitor`, `promptStreaming`,
   `measureContextUsage`, `destroy`). Rationale: standing constraint; avoid further
   divergence from upstream.

## Scope: In

- Terminal-crash detection on the client side (port disconnect / message-channel-closed /
  warmup rejection), classified as terminal vs transient.
- Force-recreate recovery path (reset sticky `documentReady`, recreate offscreen doc) and
  a manual Retry control.
- Automatic dtype/device fallback ladder on load failure, with a smaller-model rung.
- Capability-based upfront model selection via `getGpuInfo`.
- Per-device persistence of the resolved tier + a reset/re-detect control.
- Phased first-run progress (download % → indeterminate GPU-load), relayed offscreen→panel.
- Distinct network/HF download-failure messaging with retry.
- Proactive terminal "couldn't load on this device" message at warmup on ladder exhaustion.
- Rich, copy-only diagnostic, always available and embedded in failure messages.

## Scope: Out

- ROADMAP #6 (manual cross-env test matrix), #7 (repo audit + release hygiene, stable-vs-dev
  ORT decision, version bump/tag/package), #8 (store compliance: screenshots, store-name
  decision, `<all_urls>` justification). Separate vehicles after this lands.
- Any automatic rebuild/recovery after a mid-stream or terminal RUNTIME crash (manual only).
- Patching the vendored polyfill internals.
- Image input/output (text-only build).
- More than one concurrent `LanguageModel` session.
- Final selection + vetting of the specific smaller model (build the hook + a candidate;
  the actual model is an open question pending manual WebGPU vetting — see below).

## Open Questions

1. **Which smaller model?** The polyfill's default `onnx-community/gemma-3-1b-it-ONNX-GQA`
   is flagged in `docs/models.md` as a WASM trap. The planner should pick a candidate and
   gate it on manual WebGPU smoke vetting (CI cannot exercise WebGPU). Until vetted, the
   smaller-model rung may need to ship behind a flag or as a follow-up.
1. **Capability thresholds.** Exact `maxBufferSize` cutoffs (and isFallback handling) that
   classify a device as "capable" vs "weak", and the smaller model's own dtype ladder.
1. **Crashed-doc detection.** Does `chrome.offscreen.hasDocument()` reliably report a
   *crashed* offscreen document as gone, or does it still report it present? The
   force-recreate design must not depend on `hasDocument()` being accurate — resolve via
   testing; favor an explicit reset on Retry regardless.
1. **Persistence schema.** The `chrome.storage.local` key/shape for the per-device tier +
   capability record (and how/when it invalidates — e.g. on extension version change).
1. **Progress relay transport.** Whether to relay `downloadprogress` over a dedicated
   long-lived port or `chrome.runtime` messages from offscreen to the panel (the existing
   warmup path is a one-shot count-tokens `sendMessage`, which has no push channel).

## Relevant Codebase Context

- `offscreen.ts` — offscreen entry. `loadHeavy` (72-98, dynamic-imports transformers +
  polyfill, sets `window.TRANSFORMERS_CONFIG` from the static `.env.json` import at :83),
  `ensureSession` (116-132, `LanguageModel.create({...initialPrompts})` — does NOT pass a
  `monitor` today), `rebuildSession` (141-150), `collectGpuInfo` (157-222), the stream
  port handler (300-407, keeps session alive on error at 381-386). Changing dtype/device
  at runtime means re-setting `TRANSFORMERS_CONFIG` and recreating the session here.
- `src/background/offscreen.ts` — SW-side lifecycle. `offscreenAlreadyExists` (29-43,
  sticky `documentReady`), `ensureOffscreen` (45-64), `closeOffscreen` (66-73, the only
  reset), `installEnsureListener` (81-101, fields `ENSURE_OFFSCREEN_REQUEST`).
- `src/offscreen/client.ts` — content-script client. `warmupSession` (163-175, no-timeout
  load probe, throws on `ok:false`), `getGpuInfo` (193-225, conservative shape on failure),
  `countTokens` (79-128), `rebuildSession` (232-244).
- `src/offscreen/stream-client.ts` — port transport. `streamOverPort` rejects on
  `port.onDisconnect` with "offscreen port disconnected: <lastError>" (107-112) — the
  existing terminal-detection hook.
- `src/session.ts` — panel logic. `preflightWarning` (100, under-spec advisory),
  `deriveHistoryThreshold`, `runStreamTurn` (365-443, error → raw `err.message` bubble),
  `ensureWarm` (689-751, the elapsed counter + silent failure swallow at 732-742),
  `clearConversation` (605+, calls `rebuildSession`).
- `vendor/prompt-api-polyfill/prompt-api-polyfill.js` — `create()` accepts `options.monitor`
  → dispatches `downloadprogress` ProgressEvents (437-475); `contextWindow` getter and the
  create()-time guards (LOCAL DELTA, 131072). Treat as upstream.
- `.env.json` / `.env.example.json` — static config (`modelName`, `device`, `dtype`,
  `historyTokenWarnThreshold`); imported at build time. Runtime tier changes must override
  this in-memory, not by editing the file.
- Tests: Vitest + jsdom with mocked Chrome APIs (`tests/setup.ts`: `FakePort`,
  `FakeStorageArea`, `chromeMock`). The polyfill and transformers are never loaded under
  test, so the ladder/progress/recovery logic must be testable through extracted seams
  (cf. `src/offscreen/dispatch.ts`, `src/offscreen/busy-gate.ts`); the real WebGPU load is
  verified only by manual smoke.

## Technical Constraints

- 100% on-device/private; only network use is the one-time HF weights download. Diagnostic
  is copy-only — nothing auto-sent.
- Single shared offscreen `LanguageModel` session; never load two concurrently (v0.2.0 was
  reverted for `VK_ERROR_OUT_OF_DEVICE_MEMORY` from a second session). The fallback ladder
  must `destroy()` the prior session before creating the next tier, never overlap loads.
- Vendored polyfill is upstream — public surface only, no patches.
- Text-in/text-out only.
- A model load can HARD-CRASH the offscreen document (not a catchable throw); JS cannot
  catch a page crash. Detection must be client-side (port/message death); recovery must
  recreate the document.
- `onnxruntime-web` is pinned to a dev build (`1.26.0-dev…`) that transformers@4.2.0
  bundles; stable did not fix the SIGILL. Dev-runtime risk is real (relevant to #7's
  stable-vs-dev decision, out of scope here but noted).
- CI cannot exercise WebGPU; gate the WebGPU-dependent behavior on the manual matrix (#6).
