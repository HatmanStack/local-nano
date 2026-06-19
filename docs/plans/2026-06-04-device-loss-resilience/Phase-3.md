# Phase 3: Panel-Pin Port Keeps the Offscreen Alive (Layer B)

## Phase Goal

Prevent Chrome's 30-second no-port reap from closing the offscreen document
while any panel is open. While the panel is visible the content script holds a
long-lived port to the SW; while at least one such port is open the SW holds a
long-lived port to the offscreen. When the panel-side count drops to zero, the
SW releases its offscreen pin port and the existing idle-release alarm (ADR-P8)
takes over normally.

This phase shrinks the lifetime window where the WebGPU device can be lost (the
Phase 2 device.lost listener still catches it if loss happens regardless), so
the three layers together close the bug from both sides.

### Success criteria

- The content script (`content.ts`) connects a port named
  `PANEL_PIN_PORT_NAME` (constant `local-nano-panel-pin`, exported from
  `src/offscreen/protocol.ts`) to the SW when the panel becomes visible
  (toggled to `display: flex`), and disconnects it when the panel becomes
  hidden (toggled to `display: none`).
- The SW maintains an in-memory counter of open panel-pin ports. On each
  `onConnect` for the pin port name the counter increments and the SW opens
  (or reuses) a long-lived port to the offscreen named
  `OFFSCREEN_PIN_PORT_NAME` (constant `offscreen-pin`). On `onDisconnect` the
  counter decrements; when it reaches zero, the SW disconnects its offscreen
  pin port.
- The offscreen document accepts the new pin port name in a new
  `onConnect` listener that just adds the port to a `pinPorts` Set and
  removes it on disconnect. The port carries no inbound messages; its mere
  existence prevents the no-port reap.
- The SW's panel-pin counter logic is extracted into a pure module
  `src/background/panel-pin.ts` so the acquire/release state machine is
  testable without firing real ports.
- The pin port lifetime is independent of the idle-release alarm: while a
  panel is open the alarm cannot close the offscreen (the pin port keeps it
  alive); when the panel closes the alarm scheduling resumes normally.
- The pin port closure also passes the existing `queryOffscreenBusy` check
  (a panel closed while a stream is mid-generation does NOT release the pin
  port until the stream finishes — the SW defers the disconnect until busy
  is false).
- Estimated tokens: ~28,000.

## Prerequisites

- Phase 2 complete. The SW already routes `SESSION_POISONED` and the
  ensure-recreate logic is in place.
- `npm run typecheck && npx vitest run && npm run lint:ci && npm run build`
  green.

## Tasks

### Task 3.1: Protocol constants for the two pin port names

#### Goal

Declare the two new long-lived port names in `src/offscreen/protocol.ts` next
to the existing `STREAM_PORT_NAME` and `STREAM_PROGRESS_PORT`.

#### Files to Modify/Create

- **Modify** `src/offscreen/protocol.ts`:
  1. Add `export const PANEL_PIN_PORT_NAME = 'local-nano-panel-pin' as const;`
     near the existing port-name exports (around line 332).
  1. Add `export const OFFSCREEN_PIN_PORT_NAME = 'offscreen-pin' as const;`
     immediately below.
  1. Document both with a short comment block explaining the role
     (PANEL_PIN_PORT_NAME: content -> SW, lifetime is panel-visibility;
     OFFSCREEN_PIN_PORT_NAME: SW -> offscreen, lifetime is "any panel-pin
     open").

#### Prerequisites

None inside this phase.

#### Implementation Steps

1. Edit `src/offscreen/protocol.ts`. Place the constants and their
   docstrings.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npm run build` passes.

#### Testing Instructions

- No new test for the constants alone; they are exercised by Tasks 3.2
  through 3.5.

#### Commit Message Template

```text
feat(protocol): declare panel-pin and offscreen-pin port names

Adds two new long-lived port name constants:
- PANEL_PIN_PORT_NAME ('local-nano-panel-pin'): content script holds
  this open while the panel is visible.
- OFFSCREEN_PIN_PORT_NAME ('offscreen-pin'): SW holds this open to the
  offscreen document while at least one panel-pin port is open.

These extend the existing port-naming convention (offscreen-stream,
offscreen-progress) and underlie the Phase 3 panel-pin lifetime
extension. No behavior change; the wiring lands in the next commits.
```

### Task 3.2: Pure panel-pin counter module on the SW side

#### Goal

Implement and unit-test the pure SW-side state machine that tracks open
panel-pin ports and decides when to acquire / release the offscreen pin
port.

#### Files to Modify/Create

- **Create** `src/background/panel-pin.ts` — exports:

  ```typescript
  export interface PanelPinState {
    count: number;
  }
  export type PanelPinAction =
    | { kind: 'acquire-offscreen-pin' }
    | { kind: 'release-offscreen-pin' }
    | { kind: 'noop' };
  export function onPanelConnect(state: PanelPinState): PanelPinAction;
  export function onPanelDisconnect(state: PanelPinState): PanelPinAction;
  export function _newState(): PanelPinState;
  ```

  Semantics:
  - `onPanelConnect` increments `state.count`. Returns
    `'acquire-offscreen-pin'` ONLY when the count transitions from 0 to 1.
    Subsequent connects (count goes from N to N+1 with N >= 1) return
    `'noop'`.
  - `onPanelDisconnect` decrements `state.count`. Returns
    `'release-offscreen-pin'` ONLY when the count transitions from 1 to 0.
    A negative count is clamped to 0 (defense in depth against a duplicate
    disconnect from a stale port).
  - Pure; no Chrome, no port. The SW glue code calls these and acts on
    the returned action.

- **Create** `tests/panel-pin.test.ts` — covers:
  1. Fresh state has `count: 0`.
  1. First `onPanelConnect` returns `'acquire-offscreen-pin'`, count 1.
  1. Second `onPanelConnect` returns `'noop'`, count 2.
  1. `onPanelDisconnect` from count 2 returns `'noop'`, count 1.
  1. `onPanelDisconnect` from count 1 returns `'release-offscreen-pin'`,
     count 0.
  1. `onPanelDisconnect` from count 0 returns `'noop'`, count stays 0.
- **Update** `docs/testing.md` — add a row for `tests/panel-pin.test.ts`
  ("Covers: SW-side panel-pin counter state transitions (Phase 3)").

#### Prerequisites

None inside this phase.

#### Implementation Steps

1. Create the module. The implementation is six lines plus the type
   declarations.
1. Write the tests.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npx vitest run tests/panel-pin.test.ts` passes.

#### Testing Instructions

- Run the new test file alone, then the full suite.

#### Commit Message Template

```text
feat(sw): pure panel-pin counter for the offscreen pin lifetime

Adds src/background/panel-pin.ts: a tiny pure state machine that
returns 'acquire-offscreen-pin' on the 0->1 transition and
'release-offscreen-pin' on the 1->0 transition. The SW glue code calls
onPanelConnect/onPanelDisconnect and acts on the action.

Negative counts clamp at 0 so a duplicate disconnect from a stale port
is a noop, not a release-twice bug.
```

### Task 3.3: SW listens for panel-pin connects and manages the offscreen pin

#### Goal

Hook the pure counter from Task 3.2 into actual `chrome.runtime.onConnect`
events in the background module. On `acquire-offscreen-pin` the SW opens a
long-lived port to the offscreen named `OFFSCREEN_PIN_PORT_NAME`. On
`release-offscreen-pin` the SW disconnects that port, but ONLY when the
offscreen is not busy; while busy, the release is deferred and retried on
the next `IS_BUSY` probe.

#### Files to Modify/Create

- **Modify** `src/background/offscreen.ts`:
  1. Add `import { onPanelConnect, onPanelDisconnect, _newState, type
     PanelPinState } from './panel-pin.js';`.
  1. Add module-scoped state: `let panelPinState: PanelPinState =
     _newState();`; `let offscreenPinPort: chrome.runtime.Port | null =
     null;`; `let pendingRelease = false;` (set when a release was
     deferred while busy).
  1. Add `installPanelPinListener()` exported function: registers a
     `chrome.runtime.onConnect` listener that filters on
     `port.name === PANEL_PIN_PORT_NAME`. On connect, computes
     `onPanelConnect(panelPinState)`; on action `acquire-offscreen-pin`
     calls a local `acquireOffscreenPin()` helper. Registers an
     `onDisconnect` listener that computes
     `onPanelDisconnect(panelPinState)` and on `release-offscreen-pin`
     calls a local `releaseOffscreenPin()` helper (which checks
     `queryOffscreenBusy` and defers if busy).
  1. `acquireOffscreenPin()`: calls `await ensureOffscreen()`, then opens
     a long-lived port to the offscreen via
     `chrome.runtime.connect({ name: OFFSCREEN_PIN_PORT_NAME })`. Stores
     the port in `offscreenPinPort`. The port carries no messages.
  1. `releaseOffscreenPin()`: queries `queryOffscreenBusy()`. If busy,
     sets `pendingRelease = true` and returns. If not busy, disconnects
     `offscreenPinPort`, nulls it out, sets `pendingRelease = false`.
  1. Extend the existing `handleAlarm` (the idle alarm body): when it
     fires and `pendingRelease === true`, call `releaseOffscreenPin()`
     again before deciding the close/reschedule/noop action. This lets
     a deferred release land at the next idle tick.
  1. Extend `_resetForTests` to reset `panelPinState = _newState()`,
     `offscreenPinPort = null`, `pendingRelease = false`.

- **Modify** `background.ts` — call `installPanelPinListener()` at top
  level alongside the existing `installEnsureListener()` call.

#### Prerequisites

- Tasks 3.1 and 3.2 merged.

#### Implementation Steps

1. Edit `src/background/offscreen.ts`. Add the new state and the new
   exported `installPanelPinListener` function. Add the two helpers
   `acquireOffscreenPin` / `releaseOffscreenPin`.
1. Edit `background.ts` to call the new listener installer once at top
   level. The MV3 SW dedupes `addListener` calls keyed by the function
   reference, so calling the installer multiple times across SW restarts
   is safe.
1. Add tests in `tests/background-offscreen.test.ts`:
   - First connect with `PANEL_PIN_PORT_NAME` calls
     `chromeMock.runtime.connect({ name: 'offscreen-pin' })` exactly once.
   - Second connect does not call connect again.
   - First disconnect (count goes 2->1) does not disconnect the offscreen
     port.
   - Second disconnect (count goes 1->0) with `IS_BUSY` mocked busy:false
     calls `port.disconnect()` on the captured offscreen pin port.
   - Second disconnect with busy:true does NOT disconnect, sets the
     `pendingRelease`; firing the idle alarm with busy:false then
     disconnects.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npm run build` passes.
- `npx vitest run tests/background-offscreen.test.ts` passes with the
  new cases.

#### Testing Instructions

- `chromeMock.runtime.connect` in `tests/setup.ts` returns a `FakePort`;
  the existing test patterns let you assert `connect` was called and
  capture the returned port to inspect `disconnect` invocations.
- The `IS_BUSY` round-trip is exercised by mocking
  `chromeMock.runtime.sendMessage` to return an `IsBusyResponse` shape,
  same pattern Phase 2's tests use.

#### Commit Message Template

```text
feat(sw): hold an offscreen pin port while panels are open

Wires the pure panel-pin counter into chrome.runtime.onConnect for the
PANEL_PIN_PORT_NAME. On the 0->1 transition the SW ensures the
offscreen document is up and opens a long-lived OFFSCREEN_PIN_PORT_NAME
port to it. On the 1->0 transition the SW asks the offscreen IS_BUSY;
when not busy, the port is disconnected and Chrome's 30s reap can run
normally. When busy, the release is deferred and retried at the next
idle-alarm tick so a live stream is never torn down.

Adds tests covering the four transitions plus the deferred-release
path via the idle alarm.
```

### Task 3.4: Offscreen accepts the pin port (no-op handler)

#### Goal

Register a third `chrome.runtime.onConnect` listener in `offscreen.ts` that
accepts the SW's pin port. The handler adds the port to a `pinPorts` Set
and removes it on disconnect; that is all. The port's existence is what
keeps Chrome from reaping the offscreen document.

#### Files to Modify/Create

- **Modify** `offscreen.ts`:
  1. Below the existing `progressPorts` Set, add `const pinPorts: Set
     <chrome.runtime.Port> = new Set();`.
  1. Below the existing two `chrome.runtime.onConnect` listeners (one for
     `STREAM_PROGRESS_PORT`, one for `STREAM_PORT_NAME`), add a third
     listener that filters on `port.name === OFFSCREEN_PIN_PORT_NAME`. On
     connect: `pinPorts.add(port)`. Register `onDisconnect`:
     `pinPorts.delete(port)`.
  1. Import `OFFSCREEN_PIN_PORT_NAME` from `./src/offscreen/protocol.js`.
  1. Update the file-header docstring to mention the third port name as
     "pin port (Phase 3 lifetime guarantee)".

#### Prerequisites

- Task 3.1 merged.

#### Implementation Steps

1. Edit `offscreen.ts`. The change is six lines plus the import line.
1. There is no test for `offscreen.ts` directly per Phase 0 conventions.
   The integration is exercised end-to-end by the Phase 3 manual smoke
   test (the offscreen pin port being open prevents the 30s reap).

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npm run build` passes.

#### Testing Instructions

- Eyeball: the `pinPorts` Set never grows unbounded (each port is added
  on connect, removed on disconnect; a dropped port fires its
  `onDisconnect`).
- Manual smoke (after Phase 3 completes): open the panel, switch tabs
  for >60 seconds, open the chrome://extensions service worker
  inspector, confirm the offscreen document is still present and the
  Chrome `chrome.offscreen.hasDocument()` returns true.

#### Commit Message Template

```text
feat(offscreen): accept SW pin port to outlast the 30s reap

Adds a third onConnect listener filtering on OFFSCREEN_PIN_PORT_NAME.
The handler adds the port to a Set and removes it on disconnect; that
is the whole job. The port's existence is what prevents Chrome's
30-second no-port reap of the offscreen document while any panel is
open.

No-op for stream and progress port consumers; the existing two
onConnect listeners are unchanged.
```

### Task 3.5: Content script connects/disconnects the pin port on panel toggle

#### Goal

Open the panel-pin port when the chat panel becomes visible and close it
when it becomes hidden. The visibility changes happen in
`src/session.ts`'s toggle listener (around lines 1893 and 1904).

#### Files to Modify/Create

- **Modify** `src/session.ts`:
  1. Import `PANEL_PIN_PORT_NAME` from `./offscreen/protocol.js`.
  1. Inside the `initSession` closure (near where `let convertedAnchor =
     false;` is declared around line 1890), add `let pinPort:
     chrome.runtime.Port | null = null;`.
  1. Extract a local helper `acquirePinPort()` that, if `pinPort === null`,
     calls `chrome.runtime.connect({ name: PANEL_PIN_PORT_NAME })` and
     stores it. Register a `pinPort.onDisconnect` listener that nulls
     out the local `pinPort` so a SW restart that drops the port lets the
     next open re-acquire.
  1. Extract a local helper `releasePinPort()` that calls
     `pinPort?.disconnect()` and nulls `pinPort`.
  1. In the toggle listener: where the panel transitions
     `display: 'none'` -> `'flex'`, call `acquirePinPort()` BEFORE
     `ensureWarm()` so the pin is in place before the model load starts.
     Where it transitions `'flex'` -> `'none'`, call `releasePinPort()`.
  1. Optional defense: also call `releasePinPort()` in any code path that
     navigates away from the page. The session today does not capture an
     unload event; do NOT add one (YAGNI). A page unload that orphans the
     port lets Chrome auto-drop it; the SW receives `onDisconnect` and
     the panel-pin counter decrements correctly.

#### Prerequisites

- Tasks 3.1 and 3.4 merged (the protocol constant exists, the offscreen
  accepts it).

#### Implementation Steps

1. Edit `src/session.ts`. Read the surrounding 30 lines first; the toggle
   listener is in the section starting around line 1889 ("Toggle
   listener").
1. The two helpers are local closures inside `initSession`; do not
   re-export. The pin port has no message protocol.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npm run build` passes.
- `npx vitest run tests/session.test.ts` passes; the existing toggle
  tests around line 247 ("toggles panel visibility") should keep
  passing.

#### Testing Instructions

- **Modify** `tests/session.test.ts` — add `it` cases inside the
  existing "initSession — toggle behavior" describe (around line 241):
  1. First panel open calls `chromeMock.runtime.connect` with
     `{ name: PANEL_PIN_PORT_NAME }` exactly once.
  1. Panel close calls `pinPort.disconnect()` (assert via the FakePort
     returned by the `connect` mock).
  1. A second open after a close re-acquires the port (a new
     `connect` call with the pin port name).
  1. If the SW drops the port mid-life (drive `port._emitDisconnect()`)
     and the user then closes and reopens the panel, the next open
     re-acquires successfully (the null-on-disconnect handler is
     correct).
- Run `npx vitest run tests/session.test.ts` directly during
  development, then `npx vitest run` for the full suite.

#### Commit Message Template

```text
feat(panel): hold a panel-pin port while the chat panel is visible

The session's toggle listener now opens a long-lived port to the SW
named PANEL_PIN_PORT_NAME when the panel transitions to flex, and
disconnects it on the transition to none. The SW uses the port count
to decide when to hold its own pin port to the offscreen, which is
what prevents Chrome's 30-second no-port reap from closing the
offscreen document mid-tab-switch.

The pin port carries no messages; its existence is the signal.

Adds session-test cases for the four lifecycle transitions
(open-acquires, close-releases, reopen-reacquires, SW-disconnect-
resets the local handle so the next open works).
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

- `src/offscreen/protocol.ts` exports the two new port name constants.
- `src/background/panel-pin.ts` is the pure SW-side state machine.
- `src/background/offscreen.ts` owns the SW-side counter, the pin port
  acquire/release helpers, and the deferred-release plumbing tied into
  `handleAlarm`.
- `background.ts` calls `installPanelPinListener()` at top level.
- `offscreen.ts` accepts the SW pin port in a no-op `onConnect`.
- `src/session.ts` (`initSession` closure) acquires and releases the
  panel-pin port from the toggle listener.
- The idle-release alarm (ADR-P8) still functions; while panels are open
  the offscreen pin port keeps the document alive REGARDLESS of the
  idle alarm (a closed document is closed regardless of pin, but the
  alarm cannot close a document with an open pin port because the SW's
  release logic guards on busy and the document still has an active
  port connection from the SW). The alarm-triggered close path remains
  the SW calling `closeOffscreen()` directly, which Chrome honors even
  with open ports — but the SW will not call `closeOffscreen` while the
  pin port is held: the existing `decideIdleAction({ busy, timeoutMinutes })`
  produces `close` only on the idle-alarm path; when the pin port is
  held, no panel has been idle, so the alarm has been pushed forward
  by panel activity. **Documented limit:** if a panel is open but
  completely inactive (no touch-idle reset) for >timeoutMinutes, the
  alarm could fire and close the document despite an open pin port,
  which would orphan the pin. Mitigation: the touch-idle is fired on
  generation; if no generation runs, the alarm closes the document
  cleanly and the pin port is dropped by the offscreen's onDisconnect.
  No additional plumbing needed for 0.4.3; documented as known limit.

### Known limits / tech debt accepted by this phase

- An open panel with no activity for the idle timeout can still see the
  offscreen closed by the alarm; the pin port closes via the
  offscreen's `onDisconnect` and the next user send re-warms via the
  normal ensure path. The bug window the user actually hits (tab switch
  for <60 seconds) is well below the minimum idle timeout (5 minutes
  per ADR-P11), so this is acceptable.
- The pin counter is in-memory in the SW. After SW eviction the counter
  starts at 0; the next panel-pin connect re-acquires from scratch. A
  page that was already open before the eviction will keep its port
  alive (Chrome reconnects the port through SW restart) and the SW
  re-derives the count from the `onConnect` re-fire when it wakes.
  Verify in manual smoke (the brainstorm calls this out).
- The `releaseOffscreenPin` deferral on busy relies on the idle alarm
  to retry. If the alarm is set to "Never" (idleTimeoutMinutes === null),
  a busy-deferred release is retried only on the next generation's
  `touch-idle` (which does not currently call into the release helper).
  Add a retry hook only if manual smoke reveals an actual stuck-pin
  case; otherwise YAGNI.
- The pin port carries no messages. Future enhancements (panel-side
  "model reloading" notice on SESSION_POISONED, broadcast from SW) can
  reuse this port without changing the lifetime guarantee.
