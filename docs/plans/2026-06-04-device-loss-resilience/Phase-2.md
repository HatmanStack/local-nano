# Phase 2: GPUDevice Capture and Lazy Recovery (Layer A)

## Phase Goal

Capture the live `GPUDevice` handle as it flows through the polyfill's
`LanguageModel.create()` path, listen for its `lost` event, and propagate a
poisoned-state signal to the service worker so the next
`ENSURE_OFFSCREEN_REQUEST` triggers `recreateOffscreen` before the user's send
is dispatched.

The capture happens through a transparent `navigator.gpu` monkey-patch
installed at the top of `offscreen.ts` (ADR-0). The poisoned-state propagation
is push-based via a new `SESSION_POISONED` message (ADR-1). The recovery
respects the existing single-load invariant (the SW uses the existing
serialized `recreateOffscreen`) and the never-tear-down-a-live-stream
invariant (the SW queries `IS_BUSY` before recreating, same pattern the idle
alarm already uses).

### Success criteria

- A transparent `navigator.gpu` monkey-patch is installed at module load in
  `offscreen.ts`. The patch wraps the original `requestAdapter` and the
  adapter's `requestDevice`, calls through, and captures the resulting
  `GPUDevice` into a module-scoped variable.
- The captured `GPUDevice` has a `.lost.then(handleDeviceLost)` chain
  attached exactly once per device handle.
- `handleDeviceLost` sets `sessionPoisoned = true`, records
  `lastDeviceLostAt = new Date().toISOString()`, and sends a
  `SESSION_POISONED` message to the SW via `chrome.runtime.sendMessage`
  (fire-and-forget).
- The SW's `installEnsureListener` fields `SESSION_POISONED`, flips a
  module-scoped sticky boolean `sessionPoisoned`, and acks `ok: true`.
- The SW's `ENSURE_OFFSCREEN_REQUEST` branch checks `sessionPoisoned`. When
  set, it queries `queryOffscreenBusy()`; on `false`, it calls
  `recreateOffscreen()` and resets the flag before replying `ok: true`. On
  `true`, the flag stays set and the ensure replies `ok: true` (do not recreate
  while busy; the next ensure tries again).
- The existing `collectGpuInfo` path (the `gpu-info` request) STILL WORKS
  unchanged after the monkey-patch is installed (transparency).
- The pure capture logic lives in a new module
  `src/offscreen/gpu-capture.ts` and is unit-testable with a programmable
  `navigator.gpu` mock added to `tests/setup.ts`.
- Estimated tokens: ~38,000.

## Prerequisites

- Phase 1 complete and merged. The integration test in Phase 2 leans on
  Phase 1's `POISONED_STREAM_ERROR` as a complementary signal.
- `npm run typecheck && npx vitest run && npm run lint:ci && npm run build`
  green.

## Tasks

### Task 2.1: Add a programmable `navigator.gpu` mock to tests/setup.ts

#### Goal

Stand up the test-side mock plumbing before any source code changes so the
later tasks can be TDD'd. The mock must support adapter/device capture and
a programmable `device.lost` Promise.

#### Files to Modify/Create

- **Modify** `tests/setup.ts` — add a programmable `navigator.gpu` mock
  attached to `globalThis.navigator.gpu`. Shape:

  ```typescript
  interface FakeGpuDevice {
    lost: Promise<{ reason: string; message: string }>;
    _fireLost(reason: string, message: string): void;
  }
  interface FakeGpuAdapter {
    isFallbackAdapter: boolean;
    limits: { maxBufferSize: number | null };
    requestDevice(): Promise<FakeGpuDevice>;
  }
  interface FakeGpu {
    requestAdapter(): Promise<FakeGpuAdapter | null>;
    _setAdapter(adapter: FakeGpuAdapter | null): void;
    _resetCaptures(): void;
    _lastAdapter(): FakeGpuAdapter | null;
    _lastDevice(): FakeGpuDevice | null;
  }
  ```

  Default behavior: `requestAdapter` resolves to a non-fallback adapter
  with `maxBufferSize: 268435456` (256 MiB) and a settable `requestDevice`
  that yields a device whose `lost` Promise is pending until
  `_fireLost(reason, message)` resolves it. The mock is attached in a
  `beforeEach` reset, same pattern as `chromeMock`.

- **Update** `docs/testing.md` — no new test file is being added here yet,
  so the table need not change. Just confirm the existing entry for
  `tests/setup.ts` (if any) still reads accurately.

#### Prerequisites

None.

#### Implementation Steps

1. Read `tests/setup.ts` end to end.
1. Add the `navigator.gpu` mock below the existing `chromeMock`. Use the
   same `vi.fn` patterns. Export the constructor helpers
   (`makeFakeAdapter`, `makeFakeDevice`) for tests that want to override
   defaults per-case.
1. Attach `(globalThis as any).navigator.gpu = …` inside the existing
   setup block, and reset between tests in the `beforeEach`. Note: jsdom
   provides `navigator` already, so the assignment is onto an existing
   object; preserve other navigator properties.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npx vitest run` passes (no test references the new mock yet; this task
  only stages it).

#### Testing Instructions

- The mock itself has no separate test; it is exercised by Tasks 2.2 and
  2.3.
- Run `npx vitest run tests/offscreen-client.test.ts` and `npx vitest run
  tests/session.test.ts` to confirm the existing tests are not broken by
  the new `navigator.gpu` shape. The existing `getGpuInfoMock` in
  `tests/session.test.ts` mocks the CLIENT boundary (`getGpuInfo` from
  `src/offscreen/client.ts`), not `navigator.gpu`, so it remains
  independent.

#### Commit Message Template

```text
test(setup): add programmable navigator.gpu mock

Adds a FakeGpu shape attached to globalThis.navigator.gpu with a
settable adapter and a device whose .lost Promise is fired by a test
helper. Wires it into the existing beforeEach reset alongside
chromeMock.

This stages the mock for Phase 2 of the device-loss resilience plan;
no production code reads it yet. Existing tests still pass because the
client-boundary getGpuInfoMock is independent of this surface.
```

### Task 2.2: Pure GPU-capture module with device.lost wiring

#### Goal

Implement and unit-test the pure logic that installs the `navigator.gpu`
monkey-patch, captures the `GPUDevice`, attaches the `lost` listener, and
fires a caller-supplied callback. No Chrome API calls; the callback is
injected so the test can assert on it.

#### Files to Modify/Create

- **Create** `src/offscreen/gpu-capture.ts` — exports:

  ```typescript
  export interface CapturedDevice {
    device: unknown;
    capturedAt: string;
  }
  export interface DeviceLostInfo {
    reason: string;
    message: string;
    at: string;
  }
  export interface InstallGpuCaptureOptions {
    onDeviceLost: (info: DeviceLostInfo) => void;
    onDeviceCaptured?: (captured: CapturedDevice) => void;
  }
  export function installGpuCapture(opts: InstallGpuCaptureOptions): void;
  export function _resetForTests(): void;
  ```

  Behavior:
  1. Looks up `(globalThis as { navigator?: { gpu?: ... } }).navigator?.gpu`.
     If absent, returns (no-op). The offscreen document under jsdom or a
     non-WebGPU build has no gpu; this branch is the safe fallback.
  1. Idempotent: if a marker symbol on `navigator.gpu` is already set
     (`(gpu as any)[INSTALLED_SYMBOL] === true`), the function returns
     without re-wrapping. Set the marker on first install.
  1. Wraps `gpu.requestAdapter`: stores the original, replaces with a
     function that calls through, and on a non-null resolution wraps the
     adapter's `requestDevice` the same way (store original, replace with a
     function that calls through, captures the resolved device,
     `onDeviceCaptured` fires, and attaches `device.lost.then(info =>
     onDeviceLost({ reason: info.reason, message: info.message, at: new
     Date().toISOString() }))`).
  1. The same device is captured at most once: track captured devices in a
     `WeakSet` so a single `.lost` chain is attached per handle. A second
     `requestDevice` call that returns a different device installs its own
     listener.

- **Create** `tests/offscreen-gpu-capture.test.ts` — covers:
  1. Returns silently when `navigator.gpu` is undefined.
  1. After `installGpuCapture`, calling `navigator.gpu.requestAdapter()`
     resolves to the original adapter unchanged (transparency).
  1. After capture, calling `adapter.requestDevice()` resolves to the
     original device unchanged.
  1. Firing `_fireLost('destroyed', 'GPU device was lost')` invokes
     `onDeviceLost` with `{ reason: 'destroyed', message: 'GPU device was
     lost', at: <ISO string> }`.
  1. Calling `installGpuCapture` twice does not double-wrap (assert
     `requestAdapter` reference is unchanged on second install, or that
     the listener fires only once per `device.lost`).
  1. A second `requestDevice` returning a different device attaches its
     own listener.
  1. `onDeviceCaptured` fires once per unique captured device.

#### Prerequisites

- Task 2.1 (mock plumbing) merged.

#### Implementation Steps

1. Create `src/offscreen/gpu-capture.ts`. The implementation is small (one
   wrap function applied to `requestAdapter`, one nested wrap applied to
   `requestDevice` on the returned adapter). Keep TypeScript strict by
   shaping the unknown gpu surface through `unknown` casts (same pattern
   as the existing offscreen code).
1. Use a module-private `WeakSet<object>` for device-dedup. Use a module
   private symbol for the install marker.
1. Export `_resetForTests` that resets the WeakSet AND restores the
   original `requestAdapter` reference, so the test file can
   `beforeEach(_resetForTests)`.
1. Write the tests against the new `navigator.gpu` mock from Task 2.1.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npx vitest run tests/offscreen-gpu-capture.test.ts` passes.
- `npm run coverage` keeps thresholds.
- `docs/testing.md` test-file table has a new row for
  `tests/offscreen-gpu-capture.test.ts` ("Covers: navigator.gpu monkey-
  patch and device.lost listener wiring (Phase 2)"). Required by the
  docs-config drift guard.

#### Testing Instructions

- `npx vitest run tests/offscreen-gpu-capture.test.ts` directly during
  development.
- `npx vitest run` for the full suite at the end.

#### Commit Message Template

```text
feat(offscreen): pure navigator.gpu capture with device.lost listener

Adds src/offscreen/gpu-capture.ts: a transparent navigator.gpu monkey-
patch that wraps requestAdapter and the adapter's requestDevice,
captures the resolved GPUDevice (via WeakSet for dedup), attaches a
.lost.then handler, and fires a caller-supplied callback with the
loss reason and an ISO timestamp.

The module is idempotent: a second install is a no-op. Pure; no
Chrome calls. Phase 2 of the device-loss resilience plan wires it into
offscreen.ts in the next commit.
```

### Task 2.3: Wire the GPU capture into the offscreen document

#### Goal

Install `gpu-capture` at module top in `offscreen.ts`. The `onDeviceLost`
callback sets the new module-scoped state (`sessionPoisoned: boolean`,
`lastDeviceLostAt: string | null`) and sends a `SESSION_POISONED` message
to the SW.

#### Files to Modify/Create

- **Modify** `src/offscreen/protocol.ts` — add a new request/response pair:

  ```typescript
  export const SESSION_POISONED_REQUEST = 'offscreen/session-poisoned-request' as const;
  export const SESSION_POISONED_RESPONSE = 'offscreen/session-poisoned-response' as const;
  export interface SessionPoisonedRequest {
    type: typeof SESSION_POISONED_REQUEST;
    at: string;
    reason: string;
    message: string;
  }
  export type SessionPoisonedResponse =
    | { type: typeof SESSION_POISONED_RESPONSE; ok: true }
    | { type: typeof SESSION_POISONED_RESPONSE; ok: false; error: string };
  export function isSessionPoisonedRequest(value: unknown): value is SessionPoisonedRequest;
  export function isSessionPoisonedResponse(value: unknown): value is SessionPoisonedResponse;
  ```

  The shape matches the existing protocol types. Validators check
  `at`/`reason`/`message` are strings.

- **Modify** `offscreen.ts` — add the new state declarations and the
  capture install:
  1. Below the existing module-scoped state (`heavyPromise`,
     `sessionPromise`, `activeTier`, `generationGate`, `progressPorts`),
     add `let sessionPoisoned = false;` and `let lastDeviceLostAt: string |
     null = null;`.
  1. Below all imports, before any other top-level code that runs,
     `installGpuCapture({ onDeviceLost: handleDeviceLost });` where
     `handleDeviceLost` is a new local function.
  1. `handleDeviceLost(info: DeviceLostInfo)` sets `sessionPoisoned = true`,
     `lastDeviceLostAt = info.at`, and dispatches
     `chrome.runtime.sendMessage({ type: SESSION_POISONED_REQUEST, at:
     info.at, reason: info.reason, message: info.message })`. Wrap in
     try/catch so an absent SW (evicted at that instant) does not throw
     into the global.
  1. Extend `rebuildSession` (already exists, around line 215) to reset
     `sessionPoisoned = false` and (already does) `activeTier = null`.
     Leave `lastDeviceLostAt` populated; it is the historical record.

- Also handle the `_resetForTests` export shape: if any new module-scoped
  state is added that tests should reset, expose a top-level reset (the
  existing offscreen.ts has none today; do NOT add one — `offscreen.ts`
  itself is not unit-tested directly per Phase 0 conventions, so reset
  belongs in the pure modules).

#### Prerequisites

- Tasks 2.1 and 2.2 merged.

#### Implementation Steps

1. Edit `src/offscreen/protocol.ts`. Add the new constants and types
   adjacent to the existing `IS_BUSY_REQUEST` block (similar shape).
   Export the runtime validators.
1. Edit `offscreen.ts`. Add the imports for `installGpuCapture` and the
   new protocol constants. Add the state declarations. Add the
   `handleDeviceLost` function. Call `installGpuCapture(...)` at module
   top, immediately after the imports block.
1. Confirm `collectGpuInfo` (around line 236) still calls the wrapped
   `navigator.gpu.requestAdapter`. Because the wrap is transparent, no
   change is needed; the test asserts this.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npm run build` passes.
- `npx vitest run tests/offscreen-protocol.test.ts` covers the new type
  guards (add cases below).

#### Testing Instructions

- **Modify** `tests/offscreen-protocol.test.ts` — add cases for
  `isSessionPoisonedRequest` and `isSessionPoisonedResponse` mirroring
  the existing guard tests (well-formed shape passes; missing `at` /
  `reason` / `message` fails; wrong `type` fails; `ok: false` with no
  `error` fails).
- The end-to-end "device.lost fires -> SW recreates on next ensure" is
  covered in Tasks 2.4 and 2.5; this task is the wiring.

#### Commit Message Template

```text
feat(offscreen): install gpu capture and SESSION_POISONED protocol

Installs installGpuCapture at the top of offscreen.ts so the
device-lost listener attaches before any consumer (loadHeavy, gpu-info,
warmup) runs. The handler flips module-scoped sessionPoisoned, records
lastDeviceLostAt, and sends SESSION_POISONED to the SW via
chrome.runtime.sendMessage (fire-and-forget; an evicted SW drops the
message and the outermost 0.4.2 retry is the safety net).

Adds the SESSION_POISONED request/response pair to protocol.ts with
runtime validators. The SW-side handler lands in the next commit.

Rebuilds (rebuildSession) reset sessionPoisoned. lastDeviceLostAt
stays populated so the Phase 4 diagnostic reports the historical loss.
```

### Task 2.4: SW-side `SESSION_POISONED` listener + ensure-time recovery

#### Goal

Field the new `SESSION_POISONED` message in `installEnsureListener`
(`src/background/offscreen.ts`). On the next `ENSURE_OFFSCREEN_REQUEST`,
when the sticky `sessionPoisoned` flag is set and the offscreen is not
busy, call `recreateOffscreen` and clear the flag before replying. When
busy, leave the flag set and reply `ok: true` so the ensure does not block
the panel; the next ensure tries again.

#### Files to Modify/Create

- **Modify** `src/background/offscreen.ts`:
  1. Add `let sessionPoisoned = false;` to the module-scoped state at the
     top (next to `documentReady`, `createInFlight`).
  1. Extend `_resetForTests` to reset `sessionPoisoned = false`.
  1. Extend `installEnsureListener` with a new branch for
     `isSessionPoisonedRequest`: set `sessionPoisoned = true`, reply
     `{ type: SESSION_POISONED_RESPONSE, ok: true }`. (The offscreen does
     not actually await this reply, per ADR-1; the ack is for protocol
     uniformity and test observability.)
  1. Modify the `isEnsureOffscreenRequest` branch:
     - Compute `wasPoisoned = sessionPoisoned`.
     - If `wasPoisoned`, query `await queryOffscreenBusy()`. If `!busy`,
       call `await recreateOffscreen()` and set `sessionPoisoned = false`
       BEFORE replying ok. If `busy`, leave `sessionPoisoned = true` and
       skip the recreate (the next ensure tries again, the in-flight
       generation will eventually finish or abort).
     - Then call `await ensureOffscreen()` and reply as before.

- **Modify** `tests/background-offscreen.test.ts` — add `describe` blocks
  covering:
  1. `SESSION_POISONED_REQUEST` flips the SW's poisoned flag.
  1. `ENSURE_OFFSCREEN_REQUEST` after a `SESSION_POISONED` and with the
     `IS_BUSY` round-trip mocked to `busy: false` calls
     `recreateOffscreen` (assert via `chromeMock.offscreen.closeDocument`
     and `createDocument` counts) and clears the flag (next ensure does
     NOT recreate).
  1. `ENSURE_OFFSCREEN_REQUEST` after a `SESSION_POISONED` with `IS_BUSY`
     mocked to `busy: true` does NOT recreate, leaves the flag set
     (next ensure with `busy: false` then recreates).
  1. `ENSURE_OFFSCREEN_REQUEST` with no prior poison does not recreate.

#### Prerequisites

- Task 2.3 merged (the protocol constants exist).

#### Implementation Steps

1. Edit `src/background/offscreen.ts`. Read it end to end before changing;
   the changes are surgical (one new state var, one new branch, one
   modification to the ensure branch).
1. The new branch must reply through the same async `sendResponse`
   pattern as the existing branches: return `true` to keep the channel
   open for the async reply.
1. The ensure branch already returns `true`; the new logic slots inside
   the existing `ensureOffscreen().then(...)` chain. The recreate happens
   BEFORE `ensureOffscreen()` because a recreate already includes an
   ensure; structure as: `if (wasPoisoned && !busy) await recreate else
   await ensure`. Use a small helper inside the listener body if it
   improves readability.
1. Wire the tests against the existing `chromeMock` plumbing in
   `tests/background-offscreen.test.ts`. The IS_BUSY mock is driven by
   making `chromeMock.runtime.sendMessage` return a mocked
   `IsBusyResponse` shape; the SW's `queryOffscreenBusy` already reads it
   via `isIsBusyResponse`.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npx vitest run tests/background-offscreen.test.ts` passes with the new
  cases.
- `npm run coverage` keeps thresholds.

#### Testing Instructions

- The full suite via `npx vitest run`.
- Manual eyeball check: the new branch must not weaken the sender-id
  guard at the top of `installEnsureListener`.

#### Commit Message Template

```text
feat(sw): recreate offscreen on next ensure after SESSION_POISONED

The offscreen document pushes SESSION_POISONED the moment device.lost
fires. The SW now fields it: flips a sticky module-scoped flag and
acks. On the next ENSURE_OFFSCREEN_REQUEST the SW checks the flag and,
if the offscreen is not busy (IS_BUSY probe via the existing
queryOffscreenBusy), calls recreateOffscreen and clears the flag. When
busy, the flag stays set and the recreate is deferred to the next
ensure so a live stream is never torn down mid-generation (ADR-P7).

Adds tests for the four states: SESSION_POISONED handler, busy=false
recreate, busy=true defer, no-prior-poison no-op.
```

### Task 2.5: Integration test — device.lost fires, SW recreates on next ensure

#### Goal

Glue the pieces together in a single behavioral test that drives the
offscreen-capture seam, fires `device.lost`, exercises the SW
`SESSION_POISONED` handler, and asserts the next `ENSURE_OFFSCREEN_REQUEST`
triggers `recreateOffscreen` exactly once.

#### Files to Modify/Create

- **Create** `tests/device-loss-recovery.test.ts` — a new test file that
  imports:
  - The new `installGpuCapture` and `handleDeviceLost`-style callback
    pattern (via a small fixture: install capture in the test with the
    callback the test wants, then fire `_fireLost`).
  - The SW-side `installEnsureListener` from
    `src/background/offscreen.ts` plus the `_resetForTests` reset.
  - `SESSION_POISONED_REQUEST`, `ENSURE_OFFSCREEN_REQUEST` constants from
    `src/offscreen/protocol.ts`.
  - The `chromeMock` from `tests/setup.ts` plus the new
    `navigator.gpu` mock.

  The test:
  1. Resets the SW state, installs `installEnsureListener`, installs
     `installGpuCapture` against the `navigator.gpu` mock with a callback
     that just calls
     `chrome.runtime.sendMessage(SESSION_POISONED_REQUEST_PAYLOAD)`
     (mirroring what the offscreen `handleDeviceLost` does).
  1. Drives the chrome-side: `navigator.gpu.requestAdapter()` then
     `adapter.requestDevice()`, asserting the device is the original
     handle (transparency).
  1. Mocks `chromeMock.runtime.sendMessage` to dispatch the
     `SESSION_POISONED` message INTO the registered SW listener (the
     mock's `addListener` calls were captured in `setup.ts`), then
     fires `device._fireLost('destroyed', 'GPU device was lost')`.
  1. Asserts the SW poisoned flag is set (by sending an
     `ENSURE_OFFSCREEN_REQUEST` with `IS_BUSY` mocked busy:false and
     asserting `chromeMock.offscreen.closeDocument` + `createDocument` ran
     in the recreate order). A second ensure does not call recreate
     again.
- **Update** `docs/testing.md` — add a new row for
  `tests/device-loss-recovery.test.ts` ("Covers: device.lost end-to-end
  recovery wiring across offscreen and SW (Phase 2)").

#### Prerequisites

- Tasks 2.1 through 2.4 merged.

#### Implementation Steps

1. The test file is the only place where ALL the new pieces (capture,
   push, SW listener, recreate) meet without loading the real
   `offscreen.ts` entry. The pure modules and the SW module are imported
   directly.
1. The hardest part is making the test's `chrome.runtime.sendMessage`
   route into the SW listener. The existing
   `tests/background-offscreen.test.ts` already does this; mirror that
   pattern: capture the listener via
   `chromeMock.runtime.onMessage.addListener.mock.calls[0][0]` after
   `installEnsureListener()` runs, then invoke it directly with the
   message + a fake `sender = { id: chrome.runtime.id }`.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npx vitest run tests/device-loss-recovery.test.ts` passes.
- `npm run coverage` keeps thresholds.

#### Testing Instructions

- Run the new test file alone, then `npx vitest run` for the full suite.

#### Commit Message Template

```text
test(device-loss): end-to-end recovery wiring across offscreen and SW

A new integration test installs gpu-capture against the navigator.gpu
mock, fires device.lost, dispatches SESSION_POISONED through the SW
listener captured during installEnsureListener, then sends an
ENSURE_OFFSCREEN_REQUEST and asserts recreateOffscreen ran. A second
ensure does not recreate again (the flag was cleared).

Documents the new test file in docs/testing.md per the docs-config
drift guard.
```

## Phase Verification

### How to verify the whole phase is complete

Run, in this order, directly (no pipes to `tail`):

```bash
npm run lint:ci
npm run typecheck
npx vitest run
npm run build
npx markdownlint-cli2 docs/plans/2026-06-04-device-loss-resilience/**/*.md
```

All five must pass. `git log --oneline` since the phase started should
show five commits in the order of the five tasks above.

### Integration points checked

- `src/offscreen/gpu-capture.ts` is imported by `offscreen.ts` only.
- `src/offscreen/protocol.ts` exports the new
  `SESSION_POISONED_REQUEST`/`RESPONSE` constants and validators.
- `offscreen.ts` installs the capture at module top; `handleDeviceLost`
  flips `sessionPoisoned` and pushes `SESSION_POISONED` to the SW.
- `src/background/offscreen.ts` owns the SW-side `sessionPoisoned` flag;
  the ensure branch consults it.
- `recreateOffscreen` is called from the ensure branch when (a) the
  poisoned flag is set AND (b) `queryOffscreenBusy()` returns `false`.
- `tests/setup.ts` exposes the programmable `navigator.gpu` mock used by
  Tasks 2.2 and 2.5.
- `tests/offscreen-protocol.test.ts` covers the new validators.
- `tests/background-offscreen.test.ts` covers the SW-side flag and
  ensure-recreate logic.
- `tests/device-loss-recovery.test.ts` covers the full wire.

### Known limits / tech debt accepted by this phase

- The push is fire-and-forget. If the SW is evicted at the instant the
  push fires, the SW never learns of the loss and the next ensure does
  not recreate. The outermost 0.4.2 empty-success retry catches the next
  generation; Phase 3's pin port reduces this window substantially.
- The `sessionPoisoned` flag in the SW is module-scoped and does NOT
  survive SW eviction. This is intentional: a fresh SW after eviction
  has no live offscreen anyway (the offscreen was reaped with it) and
  the next ensure recreates a clean document. There is nothing to
  recover.
- The `device.lost` listener fires once per device handle. If a device is
  replaced (uncommon — the polyfill calls `LanguageModel.create` once per
  session), the new handle gets its own listener through the same
  capture path.
- The `IS_BUSY` round-trip on every ensure adds one
  `chrome.runtime.sendMessage` per ensure when the poisoned flag is set.
  This is bounded (the flag is per-loss, not per-ensure), so the round-
  trip overhead is acceptable.
- Manual smoke verification (the ChromeOS repro from the brainstorm) is
  required after Phases 2 and 3 land; CI cannot exercise a real
  `device.lost` event.
