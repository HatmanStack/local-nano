# Phase 1: Authoritative Zero-Chunk Detection (Layer C)

## Phase Goal

Convert the silent "stream resolves with zero chunks" failure mode into a typed
terminal failure that the existing reactive recovery path in `src/session.ts`
handles. After this phase, the offscreen stream handler is the authoritative
detector of an empty stream, and the panel learns about it through
`STREAM_DONE { ok: false }` rather than guessing from the return value.

The 0.4.2 panel-side empty-success retry stays in place as the outermost
safety net for any path that still produces an empty stream without setting
`ok: false`.

### Success criteria

- The offscreen stream handler in `offscreen.ts` tracks chunk count across the
  read loop (it already does for the debug log; this phase makes the value
  load-bearing).
- On natural completion (NOT aborted) with `chunkCount === 0`, the handler
  emits `STREAM_DONE { id, ok: false, error: 'no tokens emitted; session may
  be poisoned' }` instead of `STREAM_DONE { id, ok: true }`.
- The exact error string `'no tokens emitted; session may be poisoned'` is a
  new TERMINAL signal in `src/offscreen/failure.ts` so `classifyFailure`
  returns `'terminal'` for it, and the existing reactive recovery in
  `src/session.ts` (around line 588, the `classifyFailure(err) === 'terminal'`
  branch) re-warms via the serialized primitive and retries the prompt once.
- The zero-chunk detection logic is extracted into a pure helper module under
  `src/offscreen/` so the decision is unit-testable without loading the
  offscreen entry.
- All existing tests still pass. New tests cover (a) the pure helper, (b) the
  `classifyFailure` extension, and (c) an integration test in
  `tests/session.test.ts` that drives the panel through the new failure
  string and asserts the serialized re-warm + single retry runs.
- Estimated tokens: ~22,000.

## Prerequisites

- Phase 0 is in place; read it.
- `npm ci && npm run typecheck && npx vitest run && npm run lint:ci && npm run
  build` is green on a fresh clone.

## Tasks

### Task 1.1: Extract pure zero-chunk decision helper

#### Goal

Move the "decide what `StreamDone` to send when the read loop ends" logic
into a pure function under `src/offscreen/` so the policy is unit-testable
and the offscreen handler stays a thin wrapper around it.

#### Files to Modify/Create

- **Create** `src/offscreen/stream-finalize.ts` — a new pure module that
  exports one function `finalizeStreamDone(args: { id: string; aborted:
  boolean; chunkCount: number }): StreamDone`. Returns `StreamDone` with
  `ok: false, error: 'aborted'` when `aborted` is true; otherwise
  `ok: false, error: POISONED_STREAM_ERROR` when `chunkCount === 0`;
  otherwise `ok: true`. Exports a const `POISONED_STREAM_ERROR = 'no tokens
  emitted; session may be poisoned'` that other modules (`failure.ts`,
  tests) import for parity.

#### Prerequisites

None inside this phase.

#### Implementation Steps

1. Create `src/offscreen/stream-finalize.ts`. Imports the `StreamDone` type
   and the `STREAM_DONE` constant from `./protocol.js`. Defines and exports
   `POISONED_STREAM_ERROR`. Defines and exports `finalizeStreamDone`.
1. Document the rationale in a module docstring: the chunk count is the
   authoritative signal for "the polyfill yielded zero tokens because ORT
   threw inside its WASM and Transformers.js swallowed it"; an aborted
   stream is NOT a poisoned-session signal because abort is user-initiated.

#### Verification Checklist

- `src/offscreen/stream-finalize.ts` exists.
- `npm run typecheck` passes.
- `npm run lint:ci` passes.

#### Testing Instructions

- **Create** `tests/offscreen-stream-finalize.test.ts`. Test cases:
  1. `finalizeStreamDone({ id: 'x', aborted: true, chunkCount: 0 })` returns
     `{ type: STREAM_DONE, id: 'x', ok: false, error: 'aborted' }`.
  1. `finalizeStreamDone({ id: 'x', aborted: true, chunkCount: 3 })` returns
     the same aborted shape (an aborted stream that happened to deliver
     chunks before the abort still surfaces as `aborted`).
  1. `finalizeStreamDone({ id: 'x', aborted: false, chunkCount: 0 })`
     returns `{ type: STREAM_DONE, id: 'x', ok: false, error: POISONED_STREAM_ERROR }`.
  1. `finalizeStreamDone({ id: 'x', aborted: false, chunkCount: 1 })`
     returns `{ type: STREAM_DONE, id: 'x', ok: true }`.
  1. `POISONED_STREAM_ERROR` is the exact string `'no tokens emitted;
     session may be poisoned'`.
- **Update** `docs/testing.md` — add the new test file to the test-file
  table with a one-line "Covers" description. Required by
  `tests/docs-config.test.ts`.
- Run `npx vitest run tests/offscreen-stream-finalize.test.ts` directly,
  then `npx vitest run` to confirm the full suite still passes.

#### Commit Message Template

```text
refactor(offscreen): extract pure stream-finalize helper

The "what StreamDone to send when the read loop ends" decision was
inline in the offscreen stream handler closure. Extract it into a pure
module so the policy is unit-testable and the next commit can extend
the zero-chunk case to set ok: false without growing the closure.

POISONED_STREAM_ERROR is exported as a named constant so the
classifyFailure extension and any future caller share one source.
```

### Task 1.2: Wire the helper into the offscreen stream handler

#### Goal

Replace the inline finalize branch (around `offscreen.ts:580-587`) with a
call into `finalizeStreamDone`. After this task, the offscreen handler
emits the new `ok: false` payload for a natural zero-chunk completion.

#### Files to Modify/Create

- **Modify** `offscreen.ts` — import `finalizeStreamDone` from
  `./src/offscreen/stream-finalize.js`. Replace the existing ternary at the
  end of the success path (the `const done: StreamDone = controller.signal.aborted
  ? { type: STREAM_DONE, id, ok: false, error: 'aborted' } : { type:
  STREAM_DONE, id, ok: true };` block around `offscreen.ts:580`) with a
  single `const done: StreamDone = finalizeStreamDone({ id, aborted:
  controller.signal.aborted, chunkCount });`.

#### Prerequisites

- Task 1.1 complete (the helper exists).

#### Implementation Steps

1. Read `offscreen.ts` around the stream `onConnect` handler (the read loop
   block currently at lines 547-609; the aborted/ok branch is around
   580-587).
1. Replace the ternary with the helper call. Leave the existing
   `chunkCount++` and `totalChars += value.length` inside the read loop
   exactly as-is; do not touch the debugLog line; do not touch the catch
   block (the error path still uses `STREAM_DONE { ok: false, error: errMsg }`
   directly because the error is real, not derived).
1. Keep the existing comment about not destroying the session on error.

#### Verification Checklist

- `git diff offscreen.ts` shows ONE deleted ternary and ONE added
  `finalizeStreamDone(...)` call (plus the import).
- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npm run build` passes.

#### Testing Instructions

- This change is exercised end-to-end by the integration test added in
  Task 1.4. There are no additional unit tests in this task; the helper
  unit tests already prove the decision logic, and the call site is now a
  one-liner.
- Run `npx vitest run` to confirm no existing test regresses (in
  particular `tests/background-offscreen.test.ts` and any
  `streamOverPort`-flavored test in `tests/stream-client.test.ts`).

#### Commit Message Template

```text
fix(offscreen): treat zero-chunk natural completion as poisoned

The offscreen stream handler previously emitted STREAM_DONE { ok: true }
when the read loop drained without an error, even if zero tokens were
produced. On a poisoned WebGPU session (device.lost in the background),
ORT throws inside its WASM and Transformers.js swallows it; the read
loop sees no chunks and an undefined done flag, then exits cleanly. The
panel saw a "successful" empty stream and rendered "(no response)".

Wire finalizeStreamDone into the success-tail of the handler. Non-zero
chunk counts still ok: true; a zero-chunk natural completion now
ok: false with the POISONED_STREAM_ERROR wire string. The next commit
classes that string as terminal so the panel's existing reactive
recovery runs.

An aborted stream still ok: false with 'aborted', unchanged.
```

### Task 1.3: Extend `classifyFailure` with the new terminal signal

#### Goal

Add `'no tokens emitted'` (or the full constant, see below) to the
`TERMINAL_SIGNALS` list in `src/offscreen/failure.ts` so the panel's
existing reactive recovery path catches the new wire string.

#### Files to Modify/Create

- **Modify** `src/offscreen/failure.ts` — extend the `TERMINAL_SIGNALS`
  readonly array with the substring `'no tokens emitted'`. The full wire
  string is `'no tokens emitted; session may be poisoned'`; matching on
  the prefix is more resilient if the suffix wording is later refined.
- **Modify** `tests/offscreen-failure.test.ts` — add cases that assert
  `classifyFailure(new Error(POISONED_STREAM_ERROR))` returns `'terminal'`.

#### Prerequisites

- Task 1.1 complete (the constant exists to import from the test).

#### Implementation Steps

1. Open `src/offscreen/failure.ts`. The `TERMINAL_SIGNALS` array is around
   line 70. Add a new entry `'no tokens emitted'` to the array. Document
   the rationale in a leading comment block (one or two sentences: the
   offscreen handler's authoritative zero-chunk detector emits a string
   starting with this prefix; classing it as terminal routes it through
   the existing serialized re-warm primitive).
1. Add a similar entry to `tests/offscreen-failure.test.ts`. Import the
   constant from `src/offscreen/stream-finalize.ts` so the test reads from
   the same source of truth as the offscreen handler.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npx vitest run tests/offscreen-failure.test.ts` passes with the new
  cases.

#### Testing Instructions

- The unit test cases described above.
- Run `npx vitest run` to confirm nothing else regresses.

#### Commit Message Template

```text
fix(failure): class the poisoned-stream wire string as terminal

The offscreen handler now emits STREAM_DONE { ok: false, error: 'no
tokens emitted; session may be poisoned' } on a zero-chunk natural
completion. The panel's reactive recovery in src/session.ts runs only
when classifyFailure returns 'terminal'. Add the new prefix to
TERMINAL_SIGNALS so the panel re-warms via the serialized primitive
and retries the prompt once.

Cross-source the wire string with src/offscreen/stream-finalize.ts so
the matcher and the producer cannot drift.
```

### Task 1.4: Panel-side integration test for the new failure path

#### Goal

Prove end-to-end (within jsdom) that a `STREAM_DONE { ok: false, error: 'no
tokens emitted; session may be poisoned' }` from the offscreen mock drives
the existing reactive recovery in `src/session.ts` (re-warm via
`reloadModel`, retry the prompt once, render the appropriate UI on a
second failure).

#### Files to Modify/Create

- **Modify** `tests/session.test.ts` — add a new `it` block inside the
  same `describe` that hosts the existing "re-warms and retries the same
  prompt once on a terminal/closed-document stream failure" test (around
  line 1532 of `tests/session.test.ts`). The new case rejects the first
  stream with `new Error(POISONED_STREAM_ERROR)` and asserts the same
  recreate-then-retry sequence the existing test asserts for the closed-
  document case. A second case asserts that a successful first stream with
  a non-empty result followed by an immediate second user send is NOT
  affected (no regression on the happy path).

#### Prerequisites

- Tasks 1.1 and 1.3 complete.

#### Implementation Steps

1. Read the existing "re-warms and retries" test in `tests/session.test.ts`
   at the line where it currently rejects with `new Error('Could not
   establish connection. Receiving end does not exist.')`. Mirror its
   structure with the new poisoned-stream string.
1. Import `POISONED_STREAM_ERROR` from `src/offscreen/stream-finalize.ts`
   into the test file. Use it directly so a future rewording of the
   constant updates the test in lockstep.
1. The existing `recreateOffscreenMock` and `pending` queue plumbing in
   the test file already supports this shape; no new mocks are required.
1. Add a comment in the test block tying it to Phase 1's brainstorm
   decision 1c.

#### Verification Checklist

- `npx vitest run tests/session.test.ts` passes with the new cases.
- `npm run coverage` keeps `src/**/*.ts` at or above the configured
  thresholds (75% lines/statements/functions, 80% branches).

#### Testing Instructions

- Run `npx vitest run tests/session.test.ts` first, then `npx vitest run`
  to confirm no regression.
- Optional: `npm run coverage` and skim the HTML report at
  `coverage/index.html` for the `src/offscreen/failure.ts` file to confirm
  the new TERMINAL_SIGNAL branch is exercised.

#### Commit Message Template

```text
test(session): cover poisoned-stream reactive recovery end-to-end

A STREAM_DONE { ok: false, error: 'no tokens emitted; session may be
poisoned' } from the offscreen mock now drives the panel through the
reactive re-warm + single retry path the closed-document case already
exercises. Imports POISONED_STREAM_ERROR from
src/offscreen/stream-finalize so the wire string is sourced from one
place.

Adds a second case proving the happy-path send is unaffected (no
regression on a non-empty success).
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

All five must pass. `git log --oneline` since the phase started should show
four commits in the order of the four tasks above (refactor extract; fix
wire-in; fix classifier; test integration). No commit may include the
`Co-Authored-By` trailer.

### Integration points checked

- `src/offscreen/stream-finalize.ts` is imported by `offscreen.ts`
  (Task 1.2) and `tests/offscreen-failure.test.ts` (Task 1.3) and
  `tests/session.test.ts` (Task 1.4).
- `src/offscreen/failure.ts` `TERMINAL_SIGNALS` contains the new prefix.
- `offscreen.ts` no longer contains the inline ternary at the success tail
  of the stream `onConnect` handler.
- The 0.4.2 empty-success retry path in `src/session.ts` (around lines
  627-663, the `if (succeeded && !streamResult && !alreadyRetried)` block)
  is UNTOUCHED. It remains the outermost safety net.

### Known limits / tech debt accepted by this phase

- The new helper sits next to `BusyGate` in `src/offscreen/`. It is a
  single-function module, consistent with existing seams. If a Phase 2
  task wants to extend it (e.g. carry a poisoned-state flag back to the
  caller), do so in Phase 2.
- The wire string `'no tokens emitted; session may be poisoned'` is
  prefix-matched in the classifier. If a future error message starts the
  same way for a non-poisoned reason, the classifier would misroute it.
  This is YAGNI today; the prefix is intentionally specific.
- An aborted stream's `chunkCount` could be non-zero and the abort wins —
  Task 1.1's tests cover this. The offscreen handler still uses the
  `aborted` field on the controller, not chunk count, to detect abort.
