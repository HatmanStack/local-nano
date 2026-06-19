# Phase 1: Lifecycle Gate (Release Gate)

## Phase Goal

Remove the silent-death failure mode. Detect a terminal offscreen-document
crash client-side, recover via a force-recreate of the offscreen document, and
proactively surface an actionable terminal message with a manual Retry at
warmup instead of degrading silently to lazy loading. Ship a minimal copy-only
diagnostic embedded in the failure message. Success criteria: a load failure at
warmup shows a terminal bubble with a working Retry button (no silent dead
panel); Retry resets the sticky `documentReady` and recreates the document; the
build, types, tests, lint, and coverage all stay green. Independently
shippable. Estimated tokens: ~55,000.

## Prerequisites

- Phase 0 read and internalized. ADR-R4 (force-recreate), ADR-R5 (classification
  seam), ADR-R11 (diagnostic builder) govern this phase.
- Baseline green: `npm run typecheck`, `npm test -- --run`, `npm run build`,
  `npm run lint:ci` all pass on a clean tree before starting.
- Read `src/background/offscreen.ts`, `src/offscreen/protocol.ts`,
  `src/offscreen/client.ts`, `src/offscreen/stream-client.ts`,
  `src/session.ts` (the `ensureWarm` block, lines 689-751), and
  `tests/background-offscreen.test.ts`, `tests/session.test.ts`.

## Task 1.1: Terminal-vs-transient classification seam

### Goal

A pure, exported function that classifies a load/warmup/stream failure as
terminal (document likely dead, recreate required) or transient (retryable in
place). No Chrome dependency.

### Files to Modify/Create

- Create `src/offscreen/failure.ts`.
- Create `tests/offscreen-failure.test.ts`.
- Modify `docs/testing.md` (add the new test file to the table).

### Prerequisites

None beyond Phase 0.

### Implementation Steps

1. Define an exported enum-like union type `FailureClass = 'terminal' |
   'transient'` and an exported function
   `classifyFailure(error: unknown): FailureClass`.
1. Normalize the input to a lowercase message string: if `error` is an `Error`
   use `error.message`; otherwise `String(error)`.
1. Classify as `terminal` when the message matches any crash-shaped signal:
   `port disconnected`, `message channel closed`, `the message port closed`,
   `receiving end does not exist`, `document` plus `crash`, or an empty/unknown
   disconnect reason from `streamOverPort` (its
   `offscreen port disconnected: unknown reason` form). These indicate the
   document or its message channel died.
1. Classify as `transient` otherwise. This default keeps an ordinary in-session
   error (e.g. a generation error reported via `StreamDone ok:false`) out of the
   recreate path; only crash-shaped failures recreate.
1. Add a second exported helper `isTerminalFailure(error: unknown): boolean`
   returning `classifyFailure(error) === 'terminal'` for call-site readability.
1. Document each matched signal with a one-line comment citing where it
   originates (stream-client disconnect reason, runtime sendMessage closed
   channel).

### Verification Checklist

- `classifyFailure(new Error('offscreen port disconnected: unknown reason'))`
  returns `'terminal'`.
- `classifyFailure(new Error('The message channel closed before a response'))`
  returns `'terminal'`.
- `classifyFailure(new Error('busy: another generation is in progress'))`
  returns `'transient'`.
- `classifyFailure('some generic model error')` returns `'transient'`.
- `npm run typecheck` and `npm run lint:ci` pass.

### Testing Instructions

Unit test `tests/offscreen-failure.test.ts` with no Chrome usage. Cover each
terminal signal string, a couple of transient cases, non-Error inputs (string,
number, `undefined`), and the `isTerminalFailure` wrapper. No mocks needed.

### Commit Message Template

```text
feat(resilience): add terminal-vs-transient failure classifier

Pure seam (src/offscreen/failure.ts) that maps a load/warmup/stream
error to terminal (document died, recreate required) or transient
(retryable in place). Consumed by the recovery path in later commits.
```

## Task 1.2: SW recreate path (force-recreate the offscreen document)

### Goal

A service-worker path that force-recreates the offscreen document by resetting
the sticky `documentReady` and creating a fresh document, reachable from the
content-script client.

### Files to Modify/Create

- Modify `src/offscreen/protocol.ts` (add the recreate request/response
  messages and guards).
- Modify `src/background/offscreen.ts` (add `recreateOffscreen` and field the
  new message in `installEnsureListener`, or a dedicated listener).
- Modify `src/offscreen/client.ts` (add `recreateOffscreen` client helper).
- Modify `tests/background-offscreen.test.ts` (cover the recreate path).
- Modify `tests/offscreen-protocol.test.ts` (cover the new guards).
- Modify `tests/offscreen-client.test.ts` (cover the client helper).

### Prerequisites

Task 1.1 not required; can proceed in parallel.

### Implementation Steps

1. In `protocol.ts`, add `RECREATE_OFFSCREEN_REQUEST =
   'offscreen/recreate-request'` and `RECREATE_OFFSCREEN_RESPONSE =
   'offscreen/recreate-response'` constants, an `interface
   RecreateOffscreenRequest { type: typeof RECREATE_OFFSCREEN_REQUEST }`, a
   `RecreateOffscreenResponse` ok/error union mirroring
   `EnsureOffscreenResponse`, and `isRecreateOffscreenRequest` /
   `isRecreateOffscreenResponse` guards following the existing ensure-guard
   pattern (lines 34-46).
1. In `src/background/offscreen.ts`, add an exported
   `recreateOffscreen(): Promise<void>` that:
   - Calls `closeOffscreen()` inside a `try/catch` that swallows the rejection
     (a crashed/absent document can make `closeDocument()` reject; ADR-R4). The
     point is the `finally` in `closeOffscreen` already resets `documentReady`
     and `createInFlight`.
   - Then awaits `ensureOffscreen()` to build a fresh document.
   - Do NOT rely on `hasDocument()` to decide whether to recreate; always reset
     then create (ADR-R4, open question 3).
1. Extend `installEnsureListener` to also field `RECREATE_OFFSCREEN_REQUEST`:
   on match, call `recreateOffscreen()` and reply ok/error exactly as the
   ensure branch does. Keep returning `true` only for owned messages and
   `false` otherwise (the existing MV3 channel-race discipline). If extending
   the existing listener complicates the guards, add a sibling listener that
   returns `false` for non-owned messages; match whichever keeps the code
   clearest, but preserve the return-true-only-when-owned rule.
1. Export `recreateOffscreen` from `background.ts`'s re-export block and the
   `Object.assign(globalThis, …)` devtools block (mirroring `closeOffscreen`).
1. In `src/offscreen/client.ts`, add `recreateOffscreen(): Promise<void>` that
   sends `RECREATE_OFFSCREEN_REQUEST` via `chrome.runtime.sendMessage`, checks
   `chrome.runtime.lastError`, validates the reply with
   `isRecreateOffscreenResponse`, and throws on `ok:false` (mirror
   `rebuildSession` in client.ts lines 232-244).

### Verification Checklist

- `recreateOffscreen()` calls `closeDocument` then `createDocument` exactly once
  each, and a subsequent `ensureOffscreen()` no-ops (document is ready again).
- `recreateOffscreen()` still calls `createDocument` even when `closeDocument`
  rejects (the rejection is swallowed).
- The SW listener replies `{ ok: true }` after `recreateOffscreen` resolves and
  `{ ok: false, error }` when it rejects.
- The client `recreateOffscreen` throws with the SW's error message on
  `ok:false` and on `lastError`.
- `npm run typecheck`, `npm run lint:ci`, `npm test -- --run` pass.

### Testing Instructions

- `tests/background-offscreen.test.ts`: after `_resetForTests()`, drive
  `recreateOffscreen()`; assert `closeDocument` and `createDocument` call counts
  via `chromeMock.offscreen`. Add a case where `closeDocument` rejects and
  assert `createDocument` is still called. Add a listener case (capture the
  registered listener as the existing tests do) asserting the ok/error replies.
- `tests/offscreen-protocol.test.ts`: assert the new guards accept well-formed
  messages and reject malformed ones.
- `tests/offscreen-client.test.ts`: mock `chrome.runtime.sendMessage` to return
  ok and error shapes; assert resolve/throw. Follow the existing client tests'
  structure.

### Commit Message Template

```text
feat(resilience): add force-recreate path for a crashed offscreen doc

New SW recreateOffscreen() resets the sticky documentReady via
closeOffscreen() (swallowing a crashed-doc closeDocument rejection) then
ensureOffscreen(), exposed over a new recreate protocol message and a
client helper. rebuildSession only rebuilds inside a live document; this
recovers a document that itself crashed.
```

## Task 1.3: Minimal copy-only diagnostic builder

### Goal

A pure builder that renders a minimal diagnostic string from a typed input,
ready to embed in the terminal failure message.

### Files to Modify/Create

- Create `src/offscreen/diagnostic.ts`.
- Create `tests/offscreen-diagnostic.test.ts`.
- Modify `docs/testing.md` (add the new test file).

### Prerequisites

None beyond Phase 0.

### Implementation Steps

1. Define an exported `DiagnosticInput` interface with the Phase 1 fields:
   `device: 'webgpu' | 'wasm'`, `isFallback: boolean`,
   `maxBufferSize: number | null`, `activeTier: { modelName: string; device:
   string; dtype: string } | null`, `errorClass: string` (e.g. the error's
   `name` or `'Error'`), `errorMessage: string`, `extensionVersion: string`.
   Mark fields that Phase 5 will add as not-yet-present (do not add them now).
1. Export `buildDiagnostic(input: DiagnosticInput): string` that renders a
   stable, human-readable, multi-line `key: value` block. Format
   `maxBufferSize` as MiB when present, `n/a` when null. Render `activeTier` as
   `model/device/dtype` or `n/a`. Keep it copy-paste friendly (no trailing
   whitespace, deterministic field order).
1. Add `errorInfo(error: unknown): { errorClass: string; errorMessage: string }`
   helper so call sites can extract class/message uniformly.

### Verification Checklist

- `buildDiagnostic` output contains every input field with a stable label.
- Null `maxBufferSize` renders `n/a`; a numeric one renders an MiB figure.
- `errorInfo(new TypeError('x'))` returns `{ errorClass: 'TypeError',
  errorMessage: 'x' }`; `errorInfo('plain')` returns
  `{ errorClass: 'Error', errorMessage: 'plain' }`.
- `npm run typecheck`, `npm run lint:ci` pass.

### Testing Instructions

Unit test in `tests/offscreen-diagnostic.test.ts`; pure, no Chrome. Snapshot or
substring-assert each field; cover null vs numeric buffer size and the
`errorInfo` branches.

### Commit Message Template

```text
feat(resilience): add minimal copy-only diagnostic builder

Pure buildDiagnostic() renders a stable key:value block (device,
fallback, buffer size, active tier, error class+message, extension
version) for embedding in failure messages. Enriched in a later phase.
```

## Task 1.4: Proactive terminal failure UI plus manual Retry at warmup

### Goal

Replace the silent degrade-to-lazy in `ensureWarm` (`src/session.ts` lines
732-742) with a proactive terminal message and a Retry button that
force-recreates the document and re-runs the warmup. Embed the minimal
diagnostic in the message.

### Files to Modify/Create

- Modify `src/session.ts` (`ensureWarm` failure handling; add a Retry/terminal
  helper; wire `getGpuInfo` snapshot into the diagnostic).
- Modify `src/offscreen/client.ts` only if a re-export of `recreateOffscreen` is
  needed by `session.ts` (it imports from `client.js`).
- Modify `tests/session.test.ts` (cover the terminal message, Retry wiring, and
  the success-on-retry path).

### Prerequisites

Tasks 1.1, 1.2, 1.3.

### Implementation Steps

1. Import `recreateOffscreen` from `src/offscreen/client.js`, `classifyFailure`
   from `src/offscreen/failure.js`, and `buildDiagnostic` plus `errorInfo` from
   `src/offscreen/diagnostic.js` into `src/session.ts`.
1. Capture the `getGpuInfo()` snapshot already fetched in the `ensureWarm`
   preflight (lines 718-728) into a variable in the `ensureWarm` closure
   (`lastGpuInfo`) so the failure path can feed it to the diagnostic. It is
   fetched before `warmupSession()`, so it is available on failure. If the
   preflight `getGpuInfo` itself threw, fall back to a conservative snapshot
   (`device: 'webgpu', isFallback: false, maxBufferSize: null`).
1. In the `ensureWarm` catch block, REPLACE the current silent behavior
   (console.warn plus `warmStarted = false`) with:
   - Remove the `warmHint` (the elapsed counter) as today.
   - Build the diagnostic via `buildDiagnostic` using `lastGpuInfo`, a null
     `activeTier` (tiers arrive in Phase 2; pass `null` for now), and
     `errorInfo(err)`, plus `chrome.runtime.getManifest().version` for
     `extensionVersion`.
   - Render a terminal system bubble via `addMessage('system', …)` with an
     actionable message: a short headline ("Couldn't load the model on this
     device."), one line of guidance ("Try Retry below; if it keeps failing,
     set \"device\": \"wasm\" in .env.json for a slower CPU fallback."), and the
     diagnostic appended in a copy-friendly block.
   - Append a Retry button to that bubble (reuse the `BUTTON_CSS` and
     `makeActionButton`-style pattern; the history-pressure bubble at lines
     600-614 is the template). On click: disable the button, remove the
     terminal bubble, reset `warmStarted = false` and `modelReady = false`, call
     `await recreateOffscreen()`, then `await ensureWarm()` again. Guard the
     retry handler so a thrown `recreateOffscreen` re-renders the terminal
     message rather than leaving a dead button.
   - Keep `warmStarted = false` so a later panel toggle can also retry, matching
     today's reset semantics, but do NOT silently swallow: the bubble stays
     until the user acts.
1. Do NOT auto-retry. Retry is manual only (constraint 2). Do not add a timer.
1. Keep the `finally` interval cleanup intact (lines 743-750); the terminal path
   still runs through it.
1. Leave the slow-notice elapsed counter wording (lines 704-710) unchanged; this
   phase only changes the FAILURE branch, not the in-progress branch.

### Verification Checklist

- When `warmupSession()` rejects, a system bubble appears containing the
  headline, the guidance line, and the diagnostic block (assert substrings).
- The bubble has a Retry button; clicking it calls the mocked
  `recreateOffscreen` then re-invokes warmup, and on a now-resolving
  `warmupSession` the terminal bubble is gone and `modelReady` is true (assert
  via the Send button returning to idle and a successful subsequent send).
- A Retry whose `recreateOffscreen` rejects re-renders a terminal bubble rather
  than leaving the panel dead.
- The in-progress elapsed counter and the success path are unchanged.
- `npm run typecheck`, `npm run lint:ci`, `npm test -- --run`, `npm run build`,
  `npm run coverage` all pass.

### Testing Instructions

In `tests/session.test.ts`, extend the existing `initSession` harness (mocked
`../src/offscreen/client.js`). Add `recreateOffscreen: vi.fn(() =>
Promise.resolve())` to the existing `vi.mock` factory for the client module.
Drive the toggle to open the panel (fires `ensureWarm`), make
`warmupSession` reject, flush microtasks, and assert the terminal bubble plus
Retry button render. Then make `warmupSession` resolve, click Retry, flush, and
assert recovery (terminal bubble removed, `recreateOffscreen` called once). Add
a case where `recreateOffscreen` rejects on Retry and assert a terminal bubble
is shown again. Use the existing helpers (`makeDeps`, the pending-stream queue,
microtask flush loops) as the pattern.

### Commit Message Template

```text
feat(resilience): surface terminal load failure with manual Retry

ensureWarm no longer degrades silently on warmup failure. It now renders
an actionable terminal bubble with the copy-only diagnostic embedded and
a Retry button that force-recreates the offscreen document and re-runs
warmup. Recovery stays manual (no auto-retry, no timer).
```

## Task 1.5: Phase docs touch-up

### Goal

Keep `docs/testing.md` accurate (drift guard) and note the new lifecycle
behavior where the docs describe the load path. No `.env*` or model changes.

### Files to Modify/Create

- Modify `docs/testing.md` (confirm the three new test files are listed:
  `offscreen-failure`, `offscreen-diagnostic`, and any added in 1.2 — note 1.2
  extends existing test files, so only the two new files need rows; the drift
  guard test enforces this).
- Modify `docs/configuration.md` only if the terminal-failure/Retry behavior
  belongs alongside the existing preflight advisory section (lines 43-45);
  add a short paragraph describing the manual Retry and copy diagnostic.

### Prerequisites

Tasks 1.1-1.4 (so the test-file list is final).

### Implementation Steps

1. Add rows to the `docs/testing.md` test-file table for
   `tests/offscreen-failure.test.ts` and `tests/offscreen-diagnostic.test.ts`
   with short "Covers" descriptions. Run `npx vitest run
   tests/docs-config.test.ts` to confirm the drift guard passes.
1. In `docs/configuration.md`, add a short subsection (after the preflight
   advisory) describing that a failed load now shows a terminal message with a
   manual Retry and a copyable diagnostic, and that recovery is manual.
1. Keep markdown lint clean (language-tagged fences, blank lines around
   headings/lists).

### Verification Checklist

- `npx vitest run tests/docs-config.test.ts` passes.
- `npm run lint:ci` passes (Biome ignores `docs/` content for code rules but
  the repo's markdownlint config applies; keep fences tagged).

### Testing Instructions

Run the docs-config test directly; it is the drift guard. No new test code.

### Commit Message Template

```text
docs(testing): list new resilience test files; note manual Retry

Add offscreen-failure and offscreen-diagnostic rows to the testing.md
test-file table (drift guard) and document the terminal-failure manual
Retry plus copyable diagnostic in configuration.md.
```

## Phase Verification

- Full green: `npm run typecheck`, `npm test -- --run`, `npm run build`,
  `npm run lint:ci`, `npm run coverage` all pass on a clean tree.
- Integration point: the panel's `ensureWarm` now consumes
  `recreateOffscreen` (client to SW to offscreen lifecycle), `classifyFailure`,
  and `buildDiagnostic`. The SW recreate path resets the sticky
  `documentReady` so a fresh document is created on Retry.
- Manual smoke (WebGPU, not CI-coverable, document for the manual matrix #6):
  with a deliberately broken load (e.g. set `.env.json` `dtype` to a value the
  device cannot run, or force a crash), open the panel, confirm the terminal
  bubble plus Retry appear, click Retry, and confirm the document is recreated
  and warmup re-runs. Confirm the diagnostic block copies cleanly.
- Known limitations carried into Phase 2: `activeTier` in the diagnostic is
  `null` (no tier concept yet); there is no automatic ladder, only manual Retry
  of the SAME tier; `classifyFailure` is wired into the warmup path but
  `stream-client.ts` still returns its raw disconnect reason (the stream/runtime
  path stays manual per constraint 2, so no auto-recovery is added there — only
  the warmup path gains the terminal UI in this phase).
