# Phase 4: Stream-lifecycle Extraction and Storage Hardening [IMPLEMENTER]

## Phase Goal

Eliminate the byte-for-byte duplication across `sendChat`/`sendAsk`/
`sendRewrite` in `src/session.ts` by extracting the shared stream-render-finalize
lifecycle into one helper, so a bugfix lands once instead of three times
(`health` HIGH-2). Then harden persistence: validate stored history per-element
on load (`eval` Type Rigor / Defensiveness; `health` finding 5 context) and
surface `chrome.storage.local` quota failures instead of silently dropping them
(`health` finding 5).

Success criteria: the three send paths share a single lifecycle helper while
preserving their per-path differences (first-turn/warmup hint and page-context
prefix in chat; ask-mode reset; rewrite chunk application + Undo/Accept bar;
the differing `recordSentTurn` gating); `loadHistory` drops malformed entries;
`saveHistory` reports quota errors to the caller; all tests pass and the suite
gains coverage for the new validation.

Estimated tokens: ~22k.

## Prerequisites

- Phases 1-3 complete (`finalize` removed, `BUTTON_CSS` extracted, logging
  gated, offscreen consolidated).
- Re-read `src/session.ts:291-472` (the three functions) and `src/history.ts`.

## Tasks

### Task 4.1: Extract the shared stream lifecycle helper

**Goal:** Factor the common scaffold out of `sendChat` (`:291-353`), `sendAsk`
(`:356-408`), and `sendRewrite` (`:410-472`): create the response bubble + typing
indicator, set up `activeAbort` + `setGeneratingState`, the identical
first-chunk `onChunk` reset, the identical `try/catch` (AbortError vs message),
and the identical `finally` (remove indicator, empty-response fallback, push
model entry + persist, `setIdleState`, clear `activeAbort`, `i.focus()`).

**Design constraint (ADR-R2):** This is a within-module DRY extraction inside
`session.ts`. It is NOT the reverted `src/heavy.ts` cross-module extraction and
does not touch the single-shared-session design. Keep the helper in
`session.ts` (or a new `src/session-stream.ts` if cleaner) so the closure-bound
state (`messages`, `actionBtn`, `i`, `pushEntry`, `persist`, `activeAbort`)
stays accessible.

**Files to Modify/Create:**

- `src/session.ts` (and optionally a new `src/session-stream.ts` for the pure
  parts).

**Prerequisites:** none beyond Phase-3.

**Implementation Steps:**

1. Define a single internal async runner, e.g.
   `runStreamTurn(opts)` where `opts` carries:
   - `prompt: string` (already built by the caller).
   - `onChunk?: (chunk: string) => void` extra per-chunk hook (rewrite uses it
     to call `rewrite.applyChunk(chunk)`; chat uses it for the first-token
     debug log + first-turn-hint removal; ask/rewrite have none beyond the
     shared reset).
   - `onSuccess?: (modelText: string, promptLen: number) => void` for the
     per-path success tail (chat: always `recordSentTurn`; ask: `recordSentTurn`
     only when it succeeded; rewrite: `attachRewriteActions` +
     `recordSentTurn`). Model the differing `recordSentTurn` gating here so the
     three behaviors are explicit, not accidental.
   - `preHint?` / `cleanupHint?` for the chat first-turn warmup hint.
1. The runner owns: building `responseEl` + indicator, `activeAbort = new
   AbortController()`, `setGeneratingState`, the shared `firstChunk` reset, the
   shared `try { await streamPrompt(prompt, { signal, onChunk }); } catch
   (AbortError → '[stopped]'; else → message)`, and the shared `finally`
   (indicator removal, empty fallback, push+persist model entry, `setIdleState`,
   `activeAbort = null`, `i.focus()`). The empty-response fallback string and
   the `[stopped]` wording must stay byte-identical.
1. Rewrite `sendChat`: build the page-context-prefixed prompt and the first-turn
   hint, then delegate to the runner with the chat `onChunk` (first-token log
   via `debugLog`, hint removal) and `onSuccess = recordSentTurn`.
   Preserve `wasFirstTurn`/`modelReady` logic and `isFirstTurn = false`.
1. Rewrite `sendAsk`: build the ask prompt, delegate with no extra `onChunk`,
   `onSuccess` gated on success, plus the ask-mode reset (`askMode = false;
   updatePlaceholder();`) which must run in the finally tail regardless of
   success (today it is unconditional in the `finally`). Keep that placement.
1. Rewrite `sendRewrite`: keep the pre-stream `countTokens` soft-cap math and
   the `streamRewriteIntoRange(snap)` setup, delegate with `onChunk =
   rewrite.applyChunk`, and `onSuccess` = `attachRewriteActions(responseEl,
   snap)` + `recordSentTurn` (only when `modelText.length > 0`). Note
   `finalize()` is already gone (Phase-1).
1. Carefully preserve the three subtle differences the audit calls out:
   chat's first-turn/warmup hint, ask's `askMode` reset, and the differing
   `recordSentTurn` gating (`always` vs `askSucceeded` vs `succeeded`). Encode
   each as an explicit option, not a hidden branch.

**Verification Checklist:**

- `sendChat`, `sendAsk`, `sendRewrite` no longer each contain a copy of the
  `try/catch (AbortError)/finally` scaffold; the scaffold exists once in the
  runner.
- The empty-response fallback text, the `[stopped]` suffix logic, indicator
  removal, push+persist, `setIdleState`, `activeAbort` reset, and `i.focus()`
  all occur exactly once (in the runner) and on every path.
- `recordSentTurn` is called: always for chat, only-on-success for ask, and
  only-on-nonempty for rewrite — matching today.
- `npm run typecheck` exits 0; `npm run lint:ci` clean.
- All `tests/session.test.ts` cases pass unchanged (streaming, abort, toggle,
  concurrency, history-pressure, Clear, warmup-degrades-silently).

**Testing Instructions:** Run `npm run coverage`. The existing 1200-line
`session.test.ts` is the behavior contract; it must pass without edits. If a
test references an internal detail that the extraction renames, prefer adjusting
the test to assert observable behavior (bubble text, persisted entries, button
state) rather than internals. Do not weaken any assertion.

**Commit Message Template:**

```text
refactor(session): extract shared stream-turn lifecycle

sendChat/sendAsk/sendRewrite duplicated the bubble+indicator setup, the
AbortError/finally scaffold, and the push-persist tail. One runStreamTurn
helper holds the shared scaffold; per-path differences (first-turn hint,
ask-mode reset, recordSentTurn gating) are explicit options.
```

### Task 4.2: Validate persisted history per-element on load

**Goal:** `loadHistory` (`src/history.ts:8-12`) trusts `chrome.storage` shape
with a bare `Array.isArray` cast. Validate each entry has a valid `role ∈
{user, model, system}` and a string `text`, dropping malformed entries, mirroring
how the wire protocol validates messages (`eval` Type Rigor; Defensiveness
also references this).

**Files to Modify/Create:**

- `src/history.ts`
- `tests/history.test.ts`

**Prerequisites:** none.

**Implementation Steps:**

1. Add a private predicate in `history.ts`:
   `isEntry(value: unknown): value is Entry` checking
   `typeof value === 'object' && value !== null`, `role` is one of the three
   `Role` values, and `typeof text === 'string'`.
1. In `loadHistory`, after the `Array.isArray(stored)` check, `filter` the
   array through `isEntry` and return the filtered, typed array. A non-array
   stored value still returns `[]` as today.
1. Keep `Role`/`Entry` exports unchanged. Do not alter `saveHistory`'s trimming
   here (Task 4.3 handles quota).

**Verification Checklist:**

- A storage blob containing a mix of valid entries and malformed ones
  (`{role:'bogus'}`, `{text:123}`, `null`, `42`, `{}`) returns only the valid
  `Entry` objects, in order.
- An entirely malformed/non-array blob returns `[]`.
- `npm run typecheck` exits 0.

**Testing Instructions:** Add cases to `tests/history.test.ts`: seed
`chromeMock.storage.local.store[key]` with a mixed array and assert
`loadHistory(key)` drops the bad entries; seed a non-array and assert `[]`. Use
the existing `setup.ts` mock.

**Commit Message Template:**

```text
fix(history): validate persisted entries per-element on load

loadHistory cast storage blindly with Array.isArray. A corrupted or
schema-drifted blob could render a malformed bubble. Each entry is now
checked for a valid role and string text; bad entries are dropped.
```

### Task 4.3: Surface storage-quota failures on save

**Goal:** `saveHistory` writes to `chrome.storage.local` with no handling for
`QUOTA_BYTES`. A failed write currently only reaches `persist()`'s
`console.error`, so history can silently stop persisting on pages with large
turns (`health` finding 5). Make the failure observable to the caller and, where
cheap, mitigate by trimming.

**Files to Modify/Create:**

- `src/history.ts`
- `src/session.ts` (the `persist()` catch handler)
- `tests/history.test.ts`, `tests/session.test.ts`

**Prerequisites:** Task 4.2 (same file) and Task 4.1 (session helper exists).

**Implementation Steps:**

1. `saveHistory` already trims to `MAX_HISTORY` entries. Keep that. The quota
   risk is per-entry byte size, not entry count. Do NOT add a complex
   `getBytesInUse` accounting loop (YAGNI); instead make the rejection visible:
   `saveHistory` already returns the `chrome.storage.local.set(...)` promise, so
   a quota rejection already propagates to `persist()`'s `.catch`. The fix is in
   the caller's handling.
1. In `session.ts` `persist()`, change the `.catch` so a quota error (detect via
   the error message containing `QUOTA` / `quota`, or the
   `chrome.runtime.lastError` shape) surfaces a one-time, non-blocking system
   bubble (reuse the `addMessage('system', ...)` path with a short message like
   "History is full for this page and stopped saving. Clear the conversation to
   resume saving.") rather than only `console.error`. Guard with a
   `warnedAboutStorageQuota` boolean so it fires once, mirroring the existing
   `warnedAboutHistory` pattern. Non-quota errors keep the existing
   `console.error`.
1. Do not block the turn on a failed persist; the model output is already
   rendered. This is advisory only.

**Verification Checklist:**

- A `saveHistory` rejection whose message looks like a quota error triggers
  exactly one system bubble; subsequent rejections in the same session do not
  re-bubble.
- A non-quota rejection still `console.error`s and does not bubble.
- `npm run typecheck` exits 0; `npm run lint:ci` clean.

**Testing Instructions:** In `tests/session.test.ts`, override
`chromeMock.storage.local.set` to reject with a quota-like error for one turn
and assert a single system bubble with the quota wording appears, and that a
second failing turn does not add a second bubble. In `tests/history.test.ts`,
assert `saveHistory` still resolves on success and rejects (propagates) on a
rejecting `set`.

**Commit Message Template:**

```text
fix(session): surface storage-quota failures instead of swallowing them

A chrome.storage.local quota rejection only hit console.error, so history
could silently stop persisting on large-turn pages. persist() now shows a
one-time advisory bubble on a quota error; non-quota errors still log.
```

## Phase Verification

- The stream scaffold exists once; the three send paths delegate to it with
  explicit per-path options; observable behavior is unchanged (the existing
  `session.test.ts` passes).
- `loadHistory` is per-element validated; `saveHistory` quota failures are
  surfaced once per session.
- `npm run typecheck`, `npm run lint:ci`, `npm run coverage`, `npm run build`
  pass; coverage stays at or above 75/80.

Integration points: Phase-5 edits the same `session.ts` (isFirstTurn re-seed,
pageContext call site) and the offscreen stream handler; landing 4.1 first keeps
those edits small.

Known limitations: quota handling is advisory (no byte-accounting eviction);
that is intentional (YAGNI) given `MAX_HISTORY` already bounds entry count.
