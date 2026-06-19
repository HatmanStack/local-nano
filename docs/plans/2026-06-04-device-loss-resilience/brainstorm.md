# Feature: 0.4.3 root-cause WebGPU device-loss resilience

## Overview

A user-reported ChromeOS repro surfaced a "no response" failure that 0.4.2
catches reactively but does not actually prevent: switch tabs, reopen the
panel, send a message, see "Loading model..." for ~10 seconds, then watch
every send produce an empty response. Console shows ORT throwing inside
its WASM (`Cannot read properties of undefined (reading 'destroy')` at
`xc` in `ort-wasm-simd-threaded.asyncify.mjs`), Transformers.js swallowing
the throw with a console-only `Generation error`, and the stream
completing with zero tokens. 0.4.2 papered over the symptom by retrying
the stream once and rendering a "Generation failed" message when the
retry also came back empty. It did not stop the underlying device from
being lost.

0.4.3 attacks the root cause across three layers: a `GPUDevice.lost`
listener installed via a `navigator.gpu` monkey-patch in the offscreen
document (catches the actual cause at the moment it happens), a
service-worker-pinned offscreen port that prevents the 30-second no-port
reap while any panel is open (eliminates the lifetime window where the
device can be lost in the first place), and authoritative zero-chunk
detection inside the offscreen stream handler that propagates the failure
through `STREAM_DONE { ok: false }` instead of relying on the panel side
to guess from the return value. 0.4.2's empty-output retry stays in
place as the outermost last-resort safety net so any unforeseen path
that produces an empty stream still surfaces a clear "Generation failed"
to the user rather than the silent `(no response)` fallback.

Recovery on `device.lost` is intentionally lazy: the session is marked
poisoned, and the next `ENSURE_OFFSCREEN_REQUEST` from a panel triggers
the rebuild before the user's send is dispatched. Background rebuild was
rejected because the device was often lost because of GPU pressure in
the first place, and competing for the same scarce resource immediately
is more likely to fail than succeed.

## Decisions

1. **Three-layer attack.** Ship (a) `GPUDevice.lost` listener, (b)
   SW-pinned offscreen port while any panel is open, and (c) offscreen-
   side zero-chunk detection in the same release. The three are
   complementary: (b) prevents the lifetime window where the device
   gets lost, (a) catches the device loss if it still happens, (c) is
   the catch-all if the device-lost event itself is delayed or missing.
1. **Lazy recovery on `device.lost`.** Mark the session poisoned and
   rebuild on the next `ENSURE_OFFSCREEN_REQUEST` from a panel.
   Rejected: proactive background rebuild (could fight the GPU pressure
   that caused the loss) and broadcast-to-open-panels with a "model
   state lost, reloading" notice (UX win but enlarges the protocol
   surface for a rare event).
1. **SW-pin scope: panel-open-counted.** The SW holds a long-lived
   offscreen port while any content-script panel has a port to the SW.
   When the panel count drops to zero, the SW releases the offscreen
   port and Chrome's 30s reap and the existing idle-release alarm can
   run normally. Rejected: always-pinned (would hold VRAM until browser
   close when idle-release is set to Never) and SW-only-pinned (does
   not protect across SW eviction, which is the exact ChromeOS case).
1. **Keep 0.4.2 as the outermost safety net.** The panel-side empty-
   return-value retry and the "Generation failed" message stay. The
   new layers should catch known failure modes; 0.4.2 catches anything
   that slips through, at zero cost when the new layers work.
1. **Vendored polyfill untouched.** `vendor/prompt-api-polyfill/` is
   treated as upstream. The GPUDevice handle is captured by monkey-
   patching `navigator.gpu` before `loadHeavy` runs, NOT by passing a
   custom device into the polyfill or modifying its session creation.
1. **Whole-offscreen rebuild path reused.** When the session is poisoned,
   recovery uses the existing `reloadModel` / `recreateOffscreen`
   primitive that 0.3.0 already ships. No in-place ORT session rebuild.
1. **Diagnostic capture.** The Copy diagnostic should record device-lost
   events (timestamp + reason if provided) so future bug reports include
   them. Currently the diagnostic only captures load-time errors
   (`errorClass: none` even after the user hit the runtime failure).

## Scope: In

- Monkey-patch `navigator.gpu.requestAdapter` (and the adapter's
  `requestDevice`) at the top of `offscreen.ts` before `loadHeavy` runs,
  to capture the `GPUAdapter` and `GPUDevice` handles on the way through.
- Attach a `.lost.then(...)` handler on the captured `GPUDevice` that
  marks the offscreen session poisoned (a module-scoped boolean flag,
  same shape as the existing `activeTier` / `sessionPromise` state).
- Propagate the poisoned state to the SW so the next
  `ENSURE_OFFSCREEN_REQUEST` triggers `recreateOffscreen` before the
  client gets `ok: true`. Either the offscreen broadcasts a "poisoned"
  signal to the SW, or the SW asks the offscreen on each ensure call.
- Add an SW-side panel-open counter. Content scripts open a dedicated
  long-lived port to the SW on panel mount and close it on panel unmount.
  While the count is `>= 1`, the SW holds a port to the offscreen open;
  when it drops to `0`, the SW closes its offscreen port.
- In the offscreen stream handler (`offscreen.ts:560-573`), detect
  `chunkCount === 0` at stream end and propagate as
  `STREAM_DONE { id, ok: false, error: 'no tokens emitted; session may be poisoned' }`.
  Treat that error class as `terminal` in `classifyFailure` so the
  existing reactive recovery path handles it cleanly.
- Surface device-lost events in the Copy diagnostic (under a new
  `deviceLostAt` or `runtimeErrors` field).
- Tests in `tests/setup.ts` extending the chrome mock with a minimal
  `navigator.gpu` mock that supports adapter/device capture and a
  programmable `device.lost` Promise so the listener path is unit-
  testable in jsdom.

## Scope: Out

- Modifying `vendor/prompt-api-polyfill/*` (hard constraint).
- Passing a custom `GPUDevice` into ORT or Transformers.js (would
  require polyfill changes).
- Proactive background rebuild on `device.lost`. Rejected per
  decision 2.
- "Always pinned" offscreen lifetime. Rejected per decision 3.
- In-place ORT session rebuild without recreating the offscreen
  document. The existing whole-document recreate primitive is
  battle-tested; this fix reuses it.
- Removing the 0.4.2 panel-side empty-return retry. Rejected per
  decision 4.
- Broadcasting a "model reloading" notice to open panels on
  `device.lost`. Out of scope for 0.4.3; could be added later.
- A new "Cancel an in-flight model load" affordance (separately on
  the ROADMAP, distinct work).
- WebGPU-only smoke testing. CI cannot exercise WebGPU; on-device
  validation remains manual-smoke (the ChromeOS repro is the only
  known reliable trigger).

## Open Questions

- **SW <-> offscreen poisoned-state propagation.** Two viable shapes:
  the offscreen broadcasts a `SESSION_POISONED` message to the SW the
  moment `device.lost` fires (push), OR the SW asks the offscreen
  `is-session-poisoned?` on each ensure (pull). Push is lower latency
  but adds protocol surface; pull is simpler but adds a round-trip on
  every ensure. The planner should pick the shape that fits the
  existing `chrome.runtime.onMessage` and offscreen-dispatch patterns.
- **Panel-pin port name and protocol.** A new long-lived port name
  (e.g. `local-nano:panel-pin`) versus reusing a flag on the existing
  stream port. A dedicated port is cleaner; the planner should confirm
  it does not conflict with the existing port-naming convention in
  `src/offscreen/stream-client.ts` and `src/offscreen/client.ts`.
- **Adapter capture without breaking shared `navigator.gpu`.** The
  monkey-patch must wrap the original `requestAdapter` so any other
  consumer (none today, but future) still works, and must be installed
  exactly once. The planner should decide whether to install the patch
  at module load in `offscreen.ts` or inside `loadHeavy` (lazy but
  guaranteed before model load).
- **Diagnostic field naming.** New field on the Copy diagnostic for
  device-lost events: `deviceLostAt`, `runtimeErrors`, or extend the
  existing `errorClass` / `errorMessage` pair. Planner picks.

## Relevant Codebase Context

- `src/background/offscreen.ts:38-79` declares `OFFSCREEN_URL`,
  `OFFSCREEN_REASONS = ['WORKERS']`, and the `ensureOffscreen` /
  `closeOffscreen` lifecycle. Changing the `reasons` value was
  considered (other reasons may give longer lifetimes) but ruled out
  for now in favor of the SW-pinned-port approach.
- `src/background/offscreen.ts:200-220` is `installEnsureListener` which
  fields `ENSURE_OFFSCREEN_REQUEST`, `RECREATE_OFFSCREEN_REQUEST`, and
  `TOUCH_IDLE_REQUEST` from content scripts. The poisoned-state pull
  logic (if push is not chosen) would slot in next to the ensure handler.
- `offscreen.ts:122-200` is `loadHeavy` (the dynamic `import('@huggingface/transformers')`
  call) and the `ensureSession` / `LanguageModel.create` path. The
  `navigator.gpu` monkey-patch must run before `loadHeavy` ever resolves.
- `offscreen.ts:255-290` already has GPU adapter inspection code (the
  `gpu-info` path) that calls `navigator.gpu.requestAdapter()` directly.
  The monkey-patch must be transparent to this call too.
- `offscreen.ts:466-510` is the offscreen-side `chrome.runtime.onMessage`
  listener with the sender-id guard from 0.4.1. Any new `SESSION_POISONED`
  or `IS_SESSION_POISONED` message routes through here.
- `offscreen.ts:547-609` is the stream-request handler. Decision 1c
  edits the inside of the read loop (line 560-573) to track `chunkCount`
  and the bottom of the success path (line 580-587) to emit
  `STREAM_DONE { ok: false }` when `chunkCount === 0`.
- `src/offscreen/protocol.ts:336-360` defines `STREAM_DONE` and
  `StreamDone`. No change needed to the type (it already supports
  `ok: false` with an error string).
- `src/offscreen/failure.ts:49-124` is `classifyFailure`. The new
  `'no tokens emitted; session may be poisoned'` error string needs to
  classify as `'terminal'` so the existing reactive recovery in
  `src/session.ts:575-617` runs.
- `src/session.ts:575-617` is the existing terminal-failure reactive
  recovery (re-warm via `reloadModel` and retry once). It already
  handles `terminal`-classified errors; the planner extends nothing
  here, just leans on it.
- `src/session.ts:631-666` (post-0.4.2) is the empty-success retry path
  added in `f18926c`. It stays as the outermost safety net.
- `src/offscreen/diagnostic.ts` (referenced by the Copy button) is
  where the new `deviceLostAt` field goes.
- `tests/setup.ts` declares `chromeMock` and `getGpuInfoMock`. A new
  `navigator.gpu` mock with programmable `requestAdapter` and
  `device.lost` Promise goes here. Existing test pattern in
  `tests/session.test.ts:1532` and `tests/background-offscreen.test.ts`
  shows how to drive port/runtime mocks.

## Technical Constraints

- **Never two concurrent model loads.** The v0.2.0 OOM
  (`VK_ERROR_OUT_OF_DEVICE_MEMORY`) came from concurrent sessions. The
  recovery path must reuse the existing serialized `reloadModel` /
  `warmInFlight` / `reWarmInFlight` lock, not a parallel path. The
  poisoned-state propagation must NOT trigger a rebuild while a load
  or stream is already in flight.
- **Never tear down a live stream (ADR-P7).** Same discipline as
  0.4.2's Pragmatism fix: the `generationGate.busy` check must guard
  the recreate-on-poisoned path so a poisoned-marked session that
  still has a generation in flight does not get torn down mid-stream.
  The rebuild waits for the active generation to finish (or abort) and
  then recreates.
- **Vendored polyfill stays upstream.** `vendor/prompt-api-polyfill/`
  is not edited. The monkey-patch on `navigator.gpu` is the only seam.
- **CI cannot exercise WebGPU.** The `device.lost` listener cannot be
  end-to-end tested in CI. Unit tests via mocked `navigator.gpu` cover
  the listener wiring; the real-device behavior is verified by manual
  smoke on the ChromeOS repro (switch tabs, reopen, send).
- **MV3 service-worker eviction.** The SW can be evicted after ~30s of
  inactivity. The panel-pin port must survive SW restart: when the SW
  wakes up via an `ENSURE_OFFSCREEN_REQUEST` or stream connect, it must
  re-establish any active pin. The simplest model is to rebuild the
  pin state from observed port connections, not persist a count.
- **No remote code, no eval.** The `navigator.gpu` monkey-patch must
  use bundled local code only (Enhanced Safe Browsing posture from
  0.4.1 batch).
- **Conventional commits, no `Co-Authored-By` trailer.** Established
  release convention.
- **Validation discipline.** `npm run lint:ci`, `npm run typecheck`,
  `npx vitest run`, `npm run build`, and `npx markdownlint-cli2` are
  run directly. NEVER piped to `tail` (masks non-zero exit; the same
  mistake that let a biome format error reach CI once).
