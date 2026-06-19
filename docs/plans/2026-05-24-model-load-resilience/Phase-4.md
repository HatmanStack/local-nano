# Phase 4: Phased First-Run Progress

## Phase Goal

Replace the bare elapsed-seconds counter during first load with phased progress:
a real "Downloading model NN%" percentage during the weights download, then an
indeterminate "Loading into GPU…" phase (elapsed counter) once the download
completes but the session has not yet resolved. Relay `downloadprogress` from
the offscreen document to the panel over a dedicated long-lived port, and give a
weights-download/network failure its own retryable message distinct from a
device-incapability terminal message. Success criteria: the progress-parsing
seam is fully unit-tested; the offscreen side passes a `monitor` into the
polyfill `create()` and forwards events; the panel renders the phased text;
network failures get a distinct retryable message; build/tests/lint/coverage
stay green. Estimated tokens: ~50,000.

## Prerequisites

- Phases 1-3 merged.
- ADR-R10 (dedicated progress port, monitor option, pure progress parser)
  governs this phase. Constraint 3 (no patching the polyfill) is critical: the
  `monitor` is a public option.
- Baseline green.
- Re-read the polyfill `create()` monitor path (`prompt-api-polyfill.js` lines
  439-503) and the transformers backend `#ensureGenerator` progress aggregation
  (`backends/transformers.js` lines 92-149). Re-read `ensureSession` in
  `offscreen.ts` (lines 116-132, which does NOT pass a monitor today) and the
  `ensureWarm` elapsed-counter block in `src/session.ts` (lines 689-751).

## Task 4.1: Progress parser (pure)

### Goal

A pure module that maps a `downloadprogress` ProgressEvent's `loaded`/`total`
into a clamped, monotonic 0-100 integer percent and a phase label, with the
indeterminate-phase transition encoded.

### Files to Modify/Create

- Create `src/offscreen/progress.ts`.
- Create `tests/offscreen-progress.test.ts`.
- Modify `docs/testing.md`.

### Prerequisites

None beyond Phase 0.

### Implementation Steps

1. Define `interface ProgressFrame { type: typeof STREAM_PROGRESS; loaded:
   number; total: number }` (the constant lives in protocol.ts, Task 4.2; import
   it, or define the parser to take raw `{ loaded, total }` and keep the framed
   type in protocol.ts to avoid a cycle — prefer the parser taking
   `{ loaded: number; total: number }` and leaving framing to the transport).
1. Export `type LoadPhase = 'downloading' | 'gpu-loading'` and a small reducer
   `class ProgressTracker` (or a pure `nextProgress(state, frame)` function) that
   keeps the last percent and enforces monotonicity:
   - `percent = clamp(round((loaded / total) * 100), 0, 100)` when `total > 0`,
     else hold the previous percent.
   - Never decrease the reported percent (the polyfill already rounds and
     enforces monotonicity, but defend against reordering over the port).
   - Phase is `'downloading'` while `percent < 100`; once `percent` reaches 100
     (download done) but the session has not resolved, the panel switches to
     `'gpu-loading'` (indeterminate). The parser exposes the percent and the
     derived phase; the actual "session resolved" signal comes from the warmup
     promise resolving, not from progress, so the parser only reports
     `downloading`/percent and the panel decides when to show `gpu-loading`
     (i.e. after the last progress hit 100 OR after warmup is still pending past
     the final event). Document this split clearly.
1. Export a formatting helper `formatProgressText(percent: number): string`
   returning e.g. `Downloading model 42%` for the downloading phase, and a
   separate constant/string for the GPU-loading phase used by the panel.

### Verification Checklist

- `loaded: 0.5, total: 1` → 50 percent.
- A lower subsequent `loaded` does not decrease the reported percent.
- `total: 0` holds the previous percent.
- `percent` clamps to 0-100.
- `formatProgressText(42)` contains `42%`.
- `npm run typecheck`, `npm run lint:ci` pass.

### Testing Instructions

Pure unit tests in `tests/offscreen-progress.test.ts`: monotonicity, clamping,
zero-total hold, fraction-to-percent, and the formatter. No Chrome.

### Commit Message Template

```text
feat(resilience): add pure download-progress parser

src/offscreen/progress.ts maps polyfill downloadprogress loaded/total
into a clamped, monotonic 0-100 percent and a download/gpu-loading phase
split, plus a text formatter. Pure and unit-tested.
```

## Task 4.2: Progress port protocol and offscreen monitor wiring

### Goal

Add a dedicated long-lived port for progress, pass a `monitor` into the polyfill
`create()` in the offscreen document, and forward each `downloadprogress` event
as a frame to any connected progress port.

### Files to Modify/Create

- Modify `src/offscreen/protocol.ts` (progress port name, frame type, guard).
- Modify `offscreen.ts` (open a progress port listener; pass `monitor` to
  `ensureSession`'s `create()`; forward events).
- Modify `tests/offscreen-protocol.test.ts`.

### Prerequisites

Task 4.1.

### Implementation Steps

1. In `protocol.ts`, add `STREAM_PROGRESS_PORT = 'offscreen-progress'`,
   `STREAM_PROGRESS = 'stream/progress'`, the `ProgressFrame` interface
   (`{ type: typeof STREAM_PROGRESS; loaded: number; total: number }`), and an
   `isProgressFrame` guard (finite `loaded`/`total`). The parser in Task 4.1
   can import `ProgressFrame` from here; keep the parser pure by having it
   accept the numeric fields.
1. In `offscreen.ts`, add a `chrome.runtime.onConnect` branch for
   `STREAM_PROGRESS_PORT` (mirroring the existing stream-port branch at lines
   300-301). Track the connected progress port(s) in a module-scoped set; on
   disconnect, remove. There is at most one panel warming at a time in practice,
   but tolerate zero or one cleanly.
1. Modify `ensureSession` to accept an optional `onProgress?: (loaded: number,
   total: number) => void` and pass a `monitor` into `LanguageModel.create({…,
   monitor })`. The polyfill calls `monitor(monitorTarget)` where
   `monitorTarget` is an `EventTarget`; add a `downloadprogress` listener that
   reads `event.loaded`/`event.total` and calls `onProgress`. Reference: the
   polyfill dispatches `new ProgressEvent('downloadprogress', { loaded, total,
   lengthComputable })` (lines 462-470, and the backend at lines 107-114).
1. Wire `handleWarmup` (Phase 2) to pass an `onProgress` into `ensureSession`
   that posts a `ProgressFrame` to every connected progress port. Wrap the
   `postMessage` in try/catch (a disconnected panel must not break the load).
1. Keep the single-session and no-overlap invariants. The monitor is per
   `create()`; a recreated document opens a fresh progress port.

### Verification Checklist

- The protocol guard accepts a well-formed `ProgressFrame` and rejects malformed
  ones.
- (Offscreen logic is in the non-covered root file; verify by inspection plus
  the pure parser tests. Do not assert WebGPU.)
- `npm run typecheck`, `npm run lint:ci`, `npm test -- --run`, `npm run build`
  pass.

### Testing Instructions

`tests/offscreen-protocol.test.ts`: cover `isProgressFrame`. The
`offscreen.ts` monitor wiring is not in the coverage set; keep its logic thin
and delegate the parsing to the tested `progress.ts`. If any non-trivial
decision lands in `offscreen.ts`, extract it into a pure helper under `src/`
and test it there.

### Commit Message Template

```text
feat(resilience): forward polyfill download progress over a port

New STREAM_PROGRESS_PORT and ProgressFrame; offscreen ensureSession now
passes a monitor into LanguageModel.create() and forwards each
downloadprogress event to the connected progress port. Works through the
polyfill's public monitor option (no patching).
```

## Task 4.3: Panel progress client and phased UI

### Goal

Open the progress port from the panel during warmup, render "Downloading model
NN%" while the download runs, then "Loading into GPU…" (elapsed counter) once it
completes, falling back to the elapsed counter if no progress events arrive.

### Files to Modify/Create

- Modify `src/offscreen/client.ts` (a progress-port subscribe helper).
- Modify `src/session.ts` (`ensureWarm`: subscribe to progress, drive the
  phased hint text via the parser).
- Modify `tests/offscreen-client.test.ts`, `tests/session.test.ts`.

### Prerequisites

Tasks 4.1, 4.2.

### Implementation Steps

1. In `client.ts`, add `subscribeProgress(onFrame: (loaded: number, total:
   number) => void): () => void` that calls `ensureViaServiceWorker()`, opens a
   port named `STREAM_PROGRESS_PORT` via `chrome.runtime.connect`, listens for
   `isProgressFrame` messages and calls `onFrame`, and returns an unsubscribe
   function that disconnects the port. Mirror the port discipline in
   `stream-client.ts` (cleanup, swallow disconnect). This is a fire-and-forget
   subscription; it does not reject on disconnect.
1. In `ensureWarm`, before `attemptTier(tier)` for the FIRST tier (or each
   tier; first is enough since the download only happens once for a given model
   cache), subscribe to progress. Feed frames through the Task 4.1 parser; on
   each update, set the warm hint text to `formatProgressText(percent)` while
   `percent < 100`. When `percent` reaches 100, switch the hint to "Loading into
   GPU…" and let the existing elapsed counter resume (the warmup promise is
   still pending until the GPU upload/compile finishes). Unsubscribe in the
   `finally`.
1. Keep the existing elapsed-counter behavior as the FALLBACK: if no progress
   frame ever arrives (e.g. fully cached load, or a transport hiccup), the hint
   stays on the elapsed counter exactly as today. Do not break the
   slow-notice wording at `WARMUP_SLOW_NOTICE_MS`.
1. Ensure the progress subscription is per warmup invocation and cleaned up on
   success, failure, and Retry, so a recreated document's new port is used after
   a force-recreate.

### Verification Checklist

- With progress frames driven through the mocked port, the hint shows
  `Downloading model NN%` and advances; at 100 it shows the GPU-loading text.
- With no progress frames, the elapsed counter behaves exactly as before.
- The subscription is unsubscribed on success, failure, and Retry.
- All five commands pass.

### Testing Instructions

- `tests/offscreen-client.test.ts`: use the `FakePort` from setup; assert
  `subscribeProgress` opens a `STREAM_PROGRESS_PORT`, forwards
  `_emit`-ted frames, and the returned unsubscribe disconnects.
- `tests/session.test.ts`: make the mocked `subscribeProgress` capture the
  `onFrame` callback so the test can push frames, then assert the hint text
  transitions (`Downloading model …%` then the GPU-loading text). Add the
  `subscribeProgress` mock to the existing client `vi.mock` factory. Assert the
  no-progress fallback path still shows the elapsed counter.

### Commit Message Template

```text
feat(resilience): show phased download progress in the panel

ensureWarm subscribes to the progress port and renders Downloading model
NN% during the weights download, then Loading into GPU on completion,
falling back to the elapsed counter when no progress arrives.
```

## Task 4.4: Distinct network/download-failure messaging

### Goal

Classify a weights-download/network failure distinctly from a
device-incapability terminal failure, and show it its own retryable message
("couldn't download the model, check your connection") with a Retry that does
NOT walk the ladder (the device is fine; the network failed).

### Files to Modify/Create

- Modify `src/offscreen/failure.ts` (add a network classification).
- Modify `src/session.ts` (`ensureWarm` failure branch: branch on network vs
  terminal).
- Modify `tests/offscreen-failure.test.ts`, `tests/session.test.ts`.

### Prerequisites

Tasks 4.1-4.3 and Phase 1's `failure.ts`.

### Implementation Steps

1. Extend `classifyFailure` (or add a sibling `classifyLoadFailure`) to return a
   third class `'network'` when the message matches download/network signals:
   `failed to fetch`, `networkerror`, `network error`, `err_internet`,
   `load model`/`download` plus `failed`, `huggingface`/`hf` plus a fetch-shaped
   error, or a non-200 status string from the HF fetch. Keep the existing
   terminal/transient classes. Document each signal's origin.
1. In `ensureWarm`'s ladder loop, when a tier's `attemptTier` rejects, classify:
   - `'network'` → do NOT record the tier as known-bad (the device is capable;
     the network failed), do NOT advance the ladder, and show a distinct
     retryable bubble: a short message ("Couldn't download the model. Check your
     connection and try again.") with a Retry button that re-attempts the SAME
     tier (no recreate needed unless the failure was also terminal). Break the
     ladder loop after showing it.
   - terminal/transient (load failure) → existing Phase 2 behavior (record
     known-bad, recreate, advance).
1. Keep the network Retry single-shot and manual (constraint 2). The network
   bubble's Retry resets `warmStarted`/`modelReady` and re-runs `ensureWarm`.
1. Embed the diagnostic in the network message too (it is cheap and useful), but
   keep the headline clearly network-flavored.

### Verification Checklist

- `classifyFailure(new Error('Failed to fetch'))` returns `'network'`.
- A network failure shows the connection message, does NOT record known-bad, and
  does NOT advance the ladder (assert `warmupSession` is not called for the next
  tier and `recordKnownBad` is not called).
- A device-incapability failure still advances the ladder as in Phase 2.
- The network Retry re-runs warmup for the same tier.
- All five commands pass.

### Testing Instructions

- `tests/offscreen-failure.test.ts`: cover the new network signals and that
  terminal/transient cases are unaffected.
- `tests/session.test.ts`: reject `warmupSession` with a `Failed to fetch`
  error; assert the connection bubble, no ladder advance, no known-bad write;
  then resolve on Retry and assert recovery.

### Commit Message Template

```text
feat(resilience): distinguish network failures from device failures

A weights-download/network failure now classifies as 'network' and shows
a retryable connection message that retries the same tier without
recording a known-bad tier or walking the ladder, since the device is
capable and only the download failed.
```

## Phase Verification

- Full green across all five commands.
- Integration points: offscreen `monitor` to progress port to panel parser to
  phased hint; failure classifier's network branch to the distinct retryable
  message; both coexisting with the Phase 2 ladder.
- Manual smoke (WebGPU/network, not CI): on a first run, confirm the percentage
  advances during download then flips to "Loading into GPU…"; throttle/offline
  the network mid-download and confirm the connection message and its Retry;
  confirm a cached load still shows a sensible counter (no stuck 0%).
- Known limitations carried into Phase 5: the diagnostic still lacks the
  structured ladder path and Chrome/UA fields, and there is no always-available
  diagnostic affordance yet (failure-embedded only).
