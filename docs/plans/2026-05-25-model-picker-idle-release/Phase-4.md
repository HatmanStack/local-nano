# Phase 4: Idle Resource Release

## Phase Goal

Free the model after inactivity. On each generation the panel tells the service
worker to (re)schedule a single `chrome.alarms` alarm to `now + timeout`; when it
fires, the SW verifies no generation is in flight and, if idle, closes the whole
offscreen document (hard release), resetting the sticky `documentReady`. A
subsequent send from a still-alive content script re-warms through the Phase 2
serialized primitive rather than erroring into a closed document. The idle alarm
and a user Load can never race because the re-warm they share is serialized.

Success criteria: the `alarms` permission is added; a pure idle-policy module
decides close-vs-reschedule and computes alarm times; the SW schedules/reschedules
on a touch-idle signal and on a busy verify; the offscreen document answers a
busy probe (it never closes itself); the send path recovers after a release; the
"Never" option disables release; and all Chrome-touching paths are unit-tested
with a new `chrome.alarms` mock. The end-to-end cycle on hardware is manual-smoke.

Estimated tokens: ~45,000.

## Prerequisites

- Phases 0, 1, 2, 3 complete and green. ADR-P8, P9, P10, P11 govern this phase.
- Read `src/background/offscreen.ts` (the `ensureOffscreen`/`closeOffscreen`/
  `recreateOffscreen`/`installEnsureListener` lifecycle and the sticky
  `documentReady`), `background.ts` (top-level SW wiring), `offscreen.ts` (the
  `generationGate` and the per-port `activeAborts` busy state, the `onMessage`
  dispatcher, `classifyOffscreenMessage`), `src/offscreen/protocol.ts` (the
  request/response + guard pattern to copy), `src/offscreen/dispatch.ts`, and the
  send path in `src/session.ts` (`runStreamTurn`, `sendChat`/`sendAsk`/
  `sendRewrite`, `streamPrompt`).
- Confirm `manifest.json` permissions are currently `["storage", "offscreen"]`.

## Tasks

> **Task 4.1: Add the alarms permission and a chrome.alarms test mock**
>
> **Goal:** Grant the `alarms` permission and make `chrome.alarms` available
> under test, since CI has no real alarms API (ADR-P8).
>
> **Files to Modify/Create:**
>
> - `manifest.json` (modify) - Add `"alarms"` to `permissions`.
> - `tests/setup.ts` (modify) - Add a `chrome.alarms` mock with a `_fire` helper.
>
> **Implementation Steps:**
>
> - In `manifest.json`, change `permissions` from `["storage", "offscreen"]` to
>   `["storage", "offscreen", "alarms"]`. Leave everything else unchanged.
> - In `tests/setup.ts`, add an `alarms` object to `chromeMock` with
>   `create: vi.fn()`, `clear: vi.fn(async () => true)`, and
>   `onAlarm: { addListener: vi.fn() }`, plus a test helper to fire the
>   registered listener with a named-alarm payload (e.g. capture the listener and
>   expose `_fireAlarm(name)` analogous to how `FakePort._emit` works). Reset all
>   alarm spies in the `beforeEach` block alongside the existing resets.
>
> **Verification Checklist:**
>
> - [x] `manifest.json` lists `alarms` in `permissions` and is valid JSON.
> - [x] `chromeMock.alarms.create/clear/onAlarm.addListener` exist and reset in
>       `beforeEach`.
> - [x] A test can register the SW alarm listener and fire it by name.
> - [x] `npm run build` still produces `dist/` (manifest is not bundled; confirm
>       no build breakage).
>
> **Testing Instructions:**
>
> - This task adds infrastructure; its assertions land in 4.3/4.5 tests. Confirm
>   the existing suite still passes with the new mock present
>   (`npm test -- --run`).
>
> **Commit Message Template:**
>
> ```text
> chore(idle): add alarms permission and a chrome.alarms test mock
>
> - manifest.json permissions: add "alarms"
> - tests/setup.ts: chrome.alarms mock (create/clear/onAlarm) with _fireAlarm
> ```

---

> **Task 4.2: Pure idle-policy module**
>
> **Goal:** Isolate the close-vs-reschedule decision and the alarm-time math as a
> pure, unit-testable seam with no Chrome dependency (ADR-P9, P11).
>
> **Files to Modify/Create:**
>
> - `src/offscreen/idle-policy.ts` (new) - The pure decision and time helpers.
>
> **Implementation Steps:**
>
> - Export `IDLE_ALARM_NAME = 'local-nano:idle-release'` (the single named alarm).
> - Export `alarmWhen(nowMs: number, timeoutMinutes: number): number` returning
>   `nowMs + timeoutMinutes * 60_000`. Pure.
> - Export `decideIdleAction(input: { busy: boolean; timeoutMinutes: number |
>   null }): { kind: 'close' } | { kind: 'reschedule'; delayMinutes: number } |
>   { kind: 'noop' }`. Logic: if `timeoutMinutes` is null ("Never"), return
>   `noop` (release disabled, should not have been scheduled, but defend). If
>   `busy`, return `reschedule` with `delayMinutes = timeoutMinutes`. Otherwise
>   return `close`. Pure.
> - Export `shouldScheduleOnTouch(timeoutMinutes: number | null): boolean`
>   returning `timeoutMinutes !== null` so the SW skips scheduling when the user
>   chose "Never". Pure.
> - No Chrome, polyfill, or timer import. The SW supplies `Date.now()` and the
>   stored timeout; this module only computes.
>
> **Verification Checklist:**
>
> - [x] `alarmWhen(1000, 5)` equals `1000 + 300000`.
> - [x] `decideIdleAction({ busy: true, timeoutMinutes: 15 })` is reschedule(15).
> - [x] `decideIdleAction({ busy: false, timeoutMinutes: 15 })` is close.
> - [x] `decideIdleAction({ busy: false, timeoutMinutes: null })` is noop.
> - [x] `shouldScheduleOnTouch(null)` is false; `shouldScheduleOnTouch(5)` true.
> - [x] No Chrome/polyfill/timer import.
>
> **Testing Instructions:**
>
> - New file `tests/offscreen-idle-policy.test.ts`. Pure assertions on each
>   exported function. Add it to the test-file table in `docs/testing.md` in the
>   SAME commit.
> - Run `npx vitest run tests/offscreen-idle-policy.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(idle): add pure idle-policy decision and alarm-time module
>
> - src/offscreen/idle-policy.ts: IDLE_ALARM_NAME, alarmWhen,
>   decideIdleAction (close/reschedule/noop), shouldScheduleOnTouch
> - no Chrome dependency; unit-tested
> - docs/testing.md: list tests/offscreen-idle-policy.test.ts
> ```

---

> **Task 4.3: Protocol additions for touch-idle and busy-probe**
>
> **Goal:** Add two new wire channels: a content-script-to-SW "touch idle" signal
> (reset the alarm) and an SW-to-offscreen "are you busy?" probe (verify-idle),
> following the existing protocol guard pattern (ADR-P8, P9).
>
> **Files to Modify/Create:**
>
> - `src/offscreen/protocol.ts` (modify) - Add the two request/response pairs and
>   their type guards.
>
> **Prerequisites:**
>
> - Read the existing `ENSURE_OFFSCREEN_REQUEST` / `GPU_INFO_REQUEST` shapes and
>   their `is…Request`/`is…Response` guards. Copy that exact discipline.
>
> **Implementation Steps:**
>
> - Add `TOUCH_IDLE_REQUEST = 'idle/touch-request'` and
>   `TOUCH_IDLE_RESPONSE = 'idle/touch-response'`. The request carries no payload
>   (the SW reads the configured timeout from storage itself, since the SW may be
>   freshly woken). Response is `{ ok: true }` / `{ ok: false; error }`. Add
>   `isTouchIdleRequest` and `isTouchIdleResponse` guards.
> - Add `IS_BUSY_REQUEST = 'idle/is-busy-request'` and
>   `IS_BUSY_RESPONSE = 'idle/is-busy-response'`. The response carries
>   `{ ok: true; busy: boolean }` / `{ ok: false; error }`. Add `isIsBusyRequest`
>   and `isIsBusyResponse` guards validating the boolean.
> - These follow the `sendMessage` round-trip pattern (not ports). The touch-idle
>   request goes content-script-to-SW; the is-busy request goes SW-to-offscreen.
>
> **Verification Checklist:**
>
> - [x] All four constants and their guards exist and follow the existing shape.
> - [x] `isIsBusyResponse` requires `busy` to be a boolean on the ok branch.
> - [x] Guards reject mismatched/foreign messages.
>
> **Testing Instructions:**
>
> - Extend `tests/offscreen-protocol.test.ts` with guard cases for the four new
>   message types (valid, missing field, wrong type, foreign message), matching
>   the existing protocol-test style.
> - Run `npx vitest run tests/offscreen-protocol.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(idle): add touch-idle and is-busy wire protocol
>
> - protocol.ts: TOUCH_IDLE_* (content->SW) and IS_BUSY_* (SW->offscreen)
> - typed guards matching the existing request/response discipline
> ```

---

> **Task 4.4: Offscreen answers the busy probe (never self-closes)**
>
> **Goal:** Make the offscreen document report whether a generation is in flight,
> so the SW can verify-idle. The offscreen document NEVER closes itself
> (constraint 3, ADR-P8/P9).
>
> **Files to Modify/Create:**
>
> - `offscreen.ts` (modify) - Handle `IS_BUSY_REQUEST` from the busy state.
> - `src/offscreen/dispatch.ts` (modify) - Route the new message kind.
>
> **Prerequisites:**
>
> - The busy signal source: `generationGate.busy` (the `BusyGate` exposes a
>   `busy` getter) and/or whether any per-port `activeAborts` is non-empty. The
>   single shared `generationGate` is the authoritative one-at-a-time signal.
>
> **Implementation Steps:**
>
> - In `src/offscreen/dispatch.ts`, extend `OffscreenRequestKind` with
>   `'is-busy'` and have `classifyOffscreenMessage` return it for
>   `isIsBusyRequest(msg)`.
> - In `offscreen.ts`, add `handleIsBusy(sendResponse)` that replies
>   `{ type: IS_BUSY_RESPONSE, ok: true, busy: generationGate.busy }`. Wire it
>   into the existing `onMessage` switch returning `true` (async reply) for the
>   `'is-busy'` case.
> - Do NOT add any self-close logic to the offscreen document. It only reports
>   state; the SW decides and closes.
>
> **Verification Checklist:**
>
> - [x] `classifyOffscreenMessage` returns `'is-busy'` for an is-busy request and
>       null for foreign messages.
> - [x] The offscreen handler replies `busy: true` while the gate is held and
>       `busy: false` otherwise.
> - [x] No `closeDocument`/`window.close`/self-teardown is added to
>       `offscreen.ts`.
>
> **Testing Instructions:**
>
> - Extend `tests/offscreen-dispatch.test.ts` with the `is-busy` routing case.
>   (The `offscreen.ts` handler itself is not in the coverage set; the routing
>   seam and the protocol guard carry the unit coverage. Note the
>   handler-not-self-closing as a manual-smoke check.)
> - Run `npx vitest run tests/offscreen-dispatch.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(idle): offscreen reports busy state for verify-idle
>
> - dispatch.ts: route is-busy to the offscreen handler
> - offscreen.ts: handleIsBusy replies generationGate.busy; never self-closes
> ```

---

> **Task 4.5: SW-side idle scheduler and verify-idle close**
>
> **Goal:** The service worker schedules/reschedules the single idle alarm on a
> touch-idle signal (reading the configured timeout from storage), and on alarm
> fire it probes the offscreen busy state and either closes the document or
> reschedules (ADR-P8, P9).
>
> **Files to Modify/Create:**
>
> - `src/background/offscreen.ts` (modify) - Add the touch-idle handler, the
>   alarm scheduler, the alarm listener, and the verify-idle close. Reuse the
>   existing `closeOffscreen()`.
> - `background.ts` (modify) - Register the alarm listener and the touch-idle
>   message handling at top level (idempotent across SW restarts).
> - `src/offscreen/client.ts` (modify) - Add a `touchIdle()` content-script
>   client that sends `TOUCH_IDLE_REQUEST` to the SW.
>
> **Prerequisites:**
>
> - `loadModelPref` (Phase 1) to read `idleTimeoutMinutes`; `idle-policy.ts`
>   (Task 4.2); the `IS_BUSY_REQUEST` round-trip (Task 4.3); `closeOffscreen`.
>
> **Implementation Steps:**
>
> - In `src/background/offscreen.ts`, add `scheduleIdleAlarm(): Promise<void>`:
>   read `loadModelPref()`; if `shouldScheduleOnTouch(timeout)` is false
>   (`Never`), call `chrome.alarms.clear(IDLE_ALARM_NAME)` and return (so a
>   prior alarm is cancelled when the user picks Never). Otherwise
>   `chrome.alarms.create(IDLE_ALARM_NAME, { when: alarmWhen(Date.now(),
>   timeout) })`. Creating an alarm with the same name replaces the existing one,
>   which is the reset-on-each-generation behavior (decision 11). Note the
>   `chrome.alarms` ~1 min minimum; the shortest option (5 min) clears it.
> - Add `handleAlarm(alarm): Promise<void>` (the listener body): if
>   `alarm.name !== IDLE_ALARM_NAME` return. Read `loadModelPref()` for the
>   current timeout. Probe the offscreen busy state via the new
>   `IS_BUSY_REQUEST` round-trip (a helper `queryOffscreenBusy(): Promise<boolean>`
>   that sends the message and returns `reply.busy`, defaulting to `false` on a
>   malformed/absent reply so a gone document is treated as idle-and-closable
>   safely). Feed `decideIdleAction({ busy, timeoutMinutes })`:
>   - `close`: `await closeOffscreen()` (resets `documentReady`); do not
>     reschedule (the next generation re-schedules via touch-idle).
>   - `reschedule`: `chrome.alarms.create(IDLE_ALARM_NAME, { when:
>     alarmWhen(Date.now(), delayMinutes) })`.
>   - `noop`: clear the alarm.
> - Add the touch-idle branch INSIDE the existing `installEnsureListener`
>   listener body in `src/background/offscreen.ts` (do NOT add a sibling install
>   function). It already fields ensure and recreate from one
>   `chrome.runtime.onMessage` registration and is called once from
>   `background.ts`; add a third `if (isTouchIdleRequest(msg)) { … return true; }`
>   branch ahead of the final `return false`, calling `scheduleIdleAlarm()` and
>   replying ok/err, keeping the channel open (return true). This reuses the one
>   registration and the established MV3 channel-race discipline (each branch
>   returns true only for its owned message, false otherwise). Follow the exact
>   ensure/recreate branch pattern already there.
> - In `background.ts`, the only addition is
>   `chrome.alarms.onAlarm.addListener(handleAlarm)` at top level (idempotent:
>   Chrome dedupes by function reference, like the existing
>   `chrome.commands.onCommand.addListener`). The touch-idle message listener is
>   already covered by the existing `installEnsureListener()` call (extended
>   above), so no new install function is registered.
> - In `src/offscreen/client.ts`, add `touchIdle(): Promise<void>` that sends
>   `TOUCH_IDLE_REQUEST` via `chrome.runtime.sendMessage`, validates the reply
>   with `isTouchIdleResponse`, and resolves quietly on success. It must NEVER
>   throw into the generation path: on any error (lastError, malformed reply,
>   `ok:false`) it logs at warn and resolves, because failing to schedule a
>   release must not break a send. Add a `_resetForTests` extension if module
>   state is added (none expected beyond the existing).
>
> **Verification Checklist:**
>
> - [x] A touch-idle request with a 15-min preference calls
>       `chrome.alarms.create(IDLE_ALARM_NAME, { when: now + 900000 })`.
> - [x] A touch-idle with a "Never" (null) preference calls
>       `chrome.alarms.clear(IDLE_ALARM_NAME)` and does not create.
> - [x] Firing the alarm while the busy probe returns false calls
>       `closeOffscreen()` exactly once and does not reschedule.
> - [x] Firing the alarm while busy reschedules and does NOT close.
> - [x] A malformed/absent busy reply is treated as not-busy (safe to close).
> - [x] `touchIdle()` resolves (never throws) on a lastError/malformed reply.
> - [x] Repeated touch-idle calls keep replacing the single named alarm (reset
>       semantics), asserted by repeated `create` with the same name.
>
> **Testing Instructions:**
>
> - Extend `tests/background-offscreen.test.ts`: use the `chrome.alarms` mock.
>   Drive `scheduleIdleAlarm` after seeding `chromeMock.storage.local.store` with
>   each timeout (5/15/60/null) and assert the `create`/`clear` calls and `when`.
>   Register the alarm listener (via `background.ts` import or by calling the
>   exported `handleAlarm`), set `chromeMock.runtime.sendMessage` to return a
>   busy/idle `IS_BUSY_RESPONSE`, fire the alarm, and assert close vs reschedule.
>   Add a touch-idle listener test mirroring the existing ensure-listener tests.
> - New file `tests/offscreen-client.test.ts` already exists; extend it with a
>   `touchIdle()` case (success, lastError-resolves, malformed-resolves). If a
>   separate file is cleaner, add `tests/background-idle.test.ts` and list it in
>   `docs/testing.md`.
> - Run the affected test files.
>
> **Commit Message Template:**
>
> ```text
> feat(idle): SW idle alarm scheduling and verify-idle hard close
>
> - scheduleIdleAlarm reads model-pref timeout; resets the single named
>   alarm on touch; clears it when Never
> - handleAlarm probes offscreen busy, then closeOffscreen or reschedule
> - touch-idle branch added to installEnsureListener; touchIdle() never throws
> - background.ts registers chrome.alarms.onAlarm(handleAlarm) at top level
> ```

---

> **Task 4.6: Touch idle on each generation**
>
> **Goal:** Fire the touch-idle signal from the panel on each generation so the
> alarm is measured from the last generation, not panel-open (decision 9).
>
> **Files to Modify/Create:**
>
> - `src/session.ts` (modify) - Call `touchIdle()` on each generation.
>
> **Prerequisites:**
>
> - `touchIdle` from Task 4.5; the `runStreamTurn` lifecycle that wraps every
>   send path (chat/ask/rewrite).
>
> **Implementation Steps:**
>
> - In `runStreamTurn` (the shared stream lifecycle for all three send paths),
>   fire `void touchIdle()` when a generation STARTS (right where `activeAbort`
>   is set and `setGeneratingState` runs), and again on completion in the
>   `finally`, so the alarm window opens fresh after the last token (so an idle
>   countdown starts from the END of generation). Fire-and-forget (`void`); never
>   await it in the hot path; `touchIdle` already swallows its own errors.
> - Do not touch idle on mere panel-open: the spec measures from generation, not
>   panel-open (decision 9). The panel-open `ensureWarm` stays as-is for warmup.
> - If a generation is in flight when the alarm would fire, the SW's verify-idle
>   reschedules (Task 4.5), so a long stream is safe; the post-completion touch
>   then re-arms the window.
>
> **Verification Checklist:**
>
> - [x] A completed generation results in at least one `touchIdle` (TOUCH_IDLE
>       sendMessage) call.
> - [x] Panel-open alone (toggle) does NOT fire touch-idle.
> - [x] `touchIdle` failures do not affect the stream outcome (it is voided and
>       self-swallowing).
>
> **Testing Instructions:**
>
> - Extend `tests/session.test.ts`: run a mocked stream turn to completion and
>   assert a `TOUCH_IDLE_REQUEST` was sent (inspect
>   `chromeMock.runtime.sendMessage` calls). Assert a bare toggle-open does not
>   send one.
> - Run `npx vitest run tests/session.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(idle): reset the idle window on each generation
>
> - runStreamTurn fires touchIdle on start and completion (fire-and-forget)
> - measured from last generation, not panel-open; failures are swallowed
> ```

---

> **Task 4.7: Re-warm recoverable from the send path**
>
> **Goal:** After a hard release, a send from a still-alive content script must
> re-warm and retry rather than erroring into a closed document (ADR-P10,
> decision 12).
>
> **Files to Modify/Create:**
>
> - `src/session.ts` (modify) - Make the send path re-warm-aware.
>
> **Prerequisites:**
>
> - `reloadModel`/`ensureWarm` and the `warmStarted`/`modelReady` flags; the
>   `classifyFailure`/`classifyLoadFailure` seam (terminal/network classes); the
>   `streamPrompt` call inside `runStreamTurn`.
>
> **Implementation Steps:**
>
> - Two recovery points, both routed through the existing serialized re-warm so
>   no second load can overlap (ADR-P6):
>   1. Proactive: at the top of `send()` (or `runStreamTurn`), if `!modelReady`
>      and no re-warm is in flight, run `ensureWarm()` first (it resets warm
>      flags and walks the ladder for the resolved model). This covers the common
>      case where the panel knows the doc was released (the panel can learn this
>      by resetting `modelReady` when it initiates a release, but the panel does
>      not own the release; see point 2 for the authoritative recovery).
>   1. Reactive: wrap the `streamPrompt` call so that if it rejects with a
>      terminal/closed-document signal (classified via `classifyFailure` ===
>      `'terminal'`, e.g. "receiving end does not exist" / "port disconnected"
>      from a closed offscreen document), the panel runs the serialized re-warm
>      once and then retries the send exactly once. A second failure surfaces the
>      normal error UI (no retry loop). This is the authoritative path because the
>      SW owns the close and the panel cannot always know the doc was released in
>      advance.
> - The single-retry must be bounded (one retry, then give up) to avoid a loop on
>   a genuinely dead device. Use a local `alreadyRetried` flag in the send scope.
> - The retry re-sends the SAME prompt. The offscreen session is rebuilt fresh by
>   `ensureWarm` (no seeded history beyond what `restore()` re-seeds on the next
>   panel lifecycle); this matches today's behavior after a recreate, and the
>   ROADMAP explicitly accepts the one-time reload-on-return. Do not attempt to
>   replay multi-turn history here beyond what already exists.
> - Reset `modelReady`/`warmStarted` appropriately so the re-warm actually
>   re-walks (mirror how the terminal Retry resets them).
>
> **Verification Checklist:**
>
> - [ ] A send while `modelReady` is false triggers `ensureWarm` before the
>       stream (proactive path), without overlapping loads.
> - [ ] A `streamPrompt` rejection classified terminal triggers exactly one
>       re-warm + one retry of the same prompt.
> - [ ] A second consecutive failure surfaces the normal error UI and does NOT
>       retry again (bounded).
> - [ ] A non-terminal stream error (e.g. busy, ordinary generation error) does
>       NOT trigger a re-warm (preserves the "no churny auto-rebuild" rule from
>       the ROADMAP and the prior plan).
> - [ ] The re-warm goes through the serialized primitive (no two concurrent
>       loads).
>
> **Testing Instructions:**
>
> - Extend `tests/session.test.ts`: mock `streamPrompt` to reject once with a
>   terminal-shaped error then resolve, run a send, assert one re-warm
>   (`recreateOffscreen` + warmup) and a second `streamPrompt` with the same
>   prompt, and a final success. Assert a non-terminal stream error does NOT
>   re-warm. Assert the bounded single-retry (reject twice -> error UI, not a
>   loop).
> - Run `npx vitest run tests/session.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(idle): re-warm and retry once from the send path after release
>
> - send re-warms via the serialized primitive when modelReady is false
> - a terminal/closed-doc stream failure re-warms once then retries the
>   same prompt; bounded to one retry; non-terminal errors do not re-warm
> - reuses classifyFailure; no churny auto-rebuild reintroduced
> ```

## Phase Verification

- `npm run typecheck`, `npm test -- --run`, `npm run build`, `npm run lint:ci`,
  `npm run coverage` all green; `idle-policy.ts` at 100 percent.
- The SW schedules a single named alarm on each generation (touch-idle), resets
  it on the next generation, reschedules on a busy verify, and closes the
  document on an idle verify. "Never" clears the alarm and disables release.
- The offscreen document only REPORTS busy state and never closes itself
  (constraint 3); only the SW closes via `closeOffscreen()`, which resets the
  sticky `documentReady`.
- The send path recovers after a release through the serialized re-warm (ADR-P6)
  with a bounded single retry; the model switch (Phase 3) and the idle re-warm
  share that one lock and cannot race.
- No vendor edits; no second `LanguageModel.create`; single shared session
  preserved; no mid-stream auto-rebuild reintroduced.

### Integration points to verify

- `runStreamTurn` -> `touchIdle` -> SW `scheduleIdleAlarm` -> `chrome.alarms`.
- `chrome.alarms.onAlarm` -> `handleAlarm` -> busy probe -> `closeOffscreen` or
  reschedule.
- Send-path terminal failure -> serialized `reloadModel` -> retry once.

### Known limitations / manual-smoke only (Phase-0 matrix)

- Real VRAM reclamation after `closeOffscreen` (matrix step 3), the
  release-then-return re-warm on hardware (step 4), and the "Never" no-release
  confirmation (step 5) are manual-smoke only; CI cannot exercise WebGPU.
- The alarm's real minimum-period behavior and SW eviction/restart timing are
  Chrome-runtime facts verified by manual smoke, not unit tests.
- A full browser/GPU/Dawn crash remains uncatchable by the extension; idle
  release reduces sustained memory pressure but does not handle a crash. On
  recurrence, capture the Copy diagnostic and `chrome://gpu` per the ROADMAP.
