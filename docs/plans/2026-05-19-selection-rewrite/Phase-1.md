# Phase 1: Implementation

Estimated tokens: ~45,000.

## Phase Goal

Ship selection-driven in-place rewrite as v0.2.3. Highlighting text on a page
plus typing an instruction into the existing chat input streams a model
rewrite directly into the captured DOM range, with a single-level Undo
button on the resulting chat bubble. Esc inside the input toggles to "Ask
about selection" mode that quotes the selection into a normal chat prompt
without mutating the DOM. The whole feature reuses the offscreen
`LanguageModel` session created in v0.2.2 and never spawns a second one.

### Success Criteria

- A user can highlight prose on a public page, click into the panel, type
  "make this more concise", press Enter, and watch the selected text
  rewrite in place as tokens stream in.
- An "Undo" button on the resulting model bubble restores the original
  selection text.
- With a selection active, pressing Esc inside the input switches the
  placeholder to Ask mode; pressing Esc again switches back.
- `npm run typecheck`, `npm test -- --run`, `npm run build`, and
  `npm run lint:ci` all pass clean.
- No new call to `LanguageModel.create()` exists anywhere in the diff.
  `git grep -n "LanguageModel.create" -- ':!vendor' ':!node_modules' ':!dist'`
  still matches only `offscreen.ts`.
- The v0.2.0 module names listed in Phase-0 do not reappear in the diff.

## Prerequisites

- Phase-0 read and internalized.
- Clean working tree on a feature branch. Verify with
  `git status` and `git branch --show-current`.
- Baseline checks pass on the starting commit:
  - `npm ci`
  - `npm run typecheck`
  - `npm test -- --run`
  - `npm run lint:ci`
  - `npm run build`

If any baseline check fails, stop and report. Do not patch over a broken
baseline.

## Module Layout

Files created in Phase-1:

```text
src/selection-rewrite.ts        - main module: snapshot, prompt, stream, undo
src/offscreen/protocol.ts        - extended with COUNT_TOKENS_* channel
src/offscreen/client.ts          - extended with countTokens() export
offscreen.ts                     - extended with count handler
src/session.ts                   - extended with selection-mode logic
content.ts                       - extended with selectionchange listener
docs/transform.md                - user/dev facing doc
CHANGELOG.md                     - v0.2.3 entry
manifest.json                    - version bump 0.2.2 -> 0.2.3
package.json                     - version bump 0.2.2 -> 0.2.3
tests/selection-rewrite.test.ts  - new
tests/offscreen-protocol.test.ts - extended
tests/offscreen-client.test.ts   - extended
tests/session.test.ts            - extended
```

No other source files change.

## Tasks

### Task 1: Extend the offscreen protocol with a count-tokens channel

**Goal:** Add a request/response pair that lets any extension context ask
the offscreen polyfill session to tokenize a string and return the count.
The shape mirrors `REBUILD_SESSION_*` (request via
`chrome.runtime.sendMessage`, single response, no port).

**Files to Modify/Create:**

- `src/offscreen/protocol.ts` — add `COUNT_TOKENS_REQUEST`,
  `COUNT_TOKENS_RESPONSE`, the matching request/response types, and the
  type guards.

**Prerequisites:** none.

**Implementation Steps:**

- Append the new constants and types after the rebuild-session section,
  before the streaming section. Follow the exact pattern already used by
  `REBUILD_SESSION_*`.
- The request carries a single field, `text: string`, plus the discriminator.
- The success response carries `ok: true` and `count: number`.
- The failure response carries `ok: false` and `error: string`.
- Provide `isCountTokensRequest` and `isCountTokensResponse` guards.
  `count` must be validated as `typeof v.count === 'number'` and
  `Number.isFinite(v.count)`.

**Verification Checklist:**

- [x] `npm run typecheck` passes.
- [x] `npm run lint:ci` passes.
- [x] New guards exported from `src/offscreen/protocol.ts`.
- [x] No existing exports renamed or removed.

**Testing Instructions:**

Extend `tests/offscreen-protocol.test.ts` to add a constants-stable test
asserting `COUNT_TOKENS_REQUEST === 'offscreen/count-tokens-request'` and
`COUNT_TOKENS_RESPONSE === 'offscreen/count-tokens-response'`, plus
`describe` blocks for `isCountTokensRequest` and `isCountTokensResponse`.
Mirror the existing rebuild-session shape: accept well-formed messages,
reject null, reject wrong discriminator, reject missing fields, reject
wrong field types (especially non-numeric `count` and non-finite `count`
like `NaN` / `Infinity`).

Run `npm test -- --run tests/offscreen-protocol.test.ts`.

**Commit Message Template:**

```text
feat(offscreen): add count-tokens protocol channel

- New COUNT_TOKENS_REQUEST/RESPONSE constants and type guards.
- Mirrors the rebuild-session shape: single send/reply, not port-streamed.
- Used by the selection-rewrite feature to compute per-call output caps.
```

---

### Task 2: Implement the count handler in the offscreen document

**Goal:** Field `COUNT_TOKENS_REQUEST` in `offscreen.ts`. Resolve to a
number via the polyfill session's `measureContextUsage(text)`.

**Files to Modify/Create:**

- `offscreen.ts` — add the new `chrome.runtime.onMessage` branch.

**Prerequisites:** Task 1.

**Implementation Steps:**

- Either register a second `chrome.runtime.onMessage` listener for the
  count channel, or extend the existing rebuild-session listener with a
  second `if` branch. Both patterns work; the existing rebuild listener
  already returns `false` for unrecognized messages, so adding a second
  listener does not break dispatch. Pick whichever reads more cleanly
  alongside the surrounding code; the plan does not prefer one over the
  other. Whichever you pick, the handler:
- Checks `isCountTokensRequest(msg)`, ensures the session via the existing
  `ensureSession()`, then calls `session.measureContextUsage(text)`.
- The polyfill type interface in `offscreen.ts` currently only declares
  `promptStreaming` and `destroy`. Add a `measureContextUsage(input: string):
  Promise<number>` member to the `LanguageModelSession` interface in this
  file. This is a local type widening; the polyfill exposes the method at
  runtime.
- Wrap the call in try/catch. On success, send
  `{ type: COUNT_TOKENS_RESPONSE, ok: true, count }`. On failure, send
  `{ ok: false, error: errMsg }`.
- Return `true` from the listener so the channel stays open for the async
  reply (same as the rebuild-session listener).
- Do not destroy or rebuild the session on a count failure. Counting is
  best-effort; the client has a fallback.

**Verification Checklist:**

- [x] `npm run typecheck` passes.
- [x] `npm run lint:ci` passes.
- [x] Listener returns `true` so `sendResponse` works asynchronously.
- [x] Failures do not poison `sessionPromise`.

**Testing Instructions:**

The offscreen document itself runs only inside Chrome and is not unit
tested today. There is no `tests/offscreen.test.ts`. The wire contract is
covered by the protocol guard tests (Task 1) and the client tests
(Task 3). No new test file is needed for Task 2. Document this gap in the
commit message body.

**Commit Message Template:**

```text
feat(offscreen): handle count-tokens requests

- New onMessage branch resolves via session.measureContextUsage.
- Failures are reported back to the client but do not tear down the
  session; counting is best-effort and the client has a fallback.
- Not unit-tested directly (offscreen.ts is integration territory);
  protocol guards and the client cover the contract.
```

---

### Task 3: Expose `countTokens` from the offscreen client

**Goal:** Add a `countTokens(text: string, opts?: { timeoutMs?: number }):
Promise<number>` export to `src/offscreen/client.ts`. It performs the
ensure-offscreen handshake, sends the request, races against a timeout, and
on timeout (or any error) returns a heuristic count
`Math.ceil(text.length / 3)`.

**Files to Modify/Create:**

- `src/offscreen/client.ts` — add the new export.

**Prerequisites:** Task 1.

**Implementation Steps:**

- Default `timeoutMs` to `100`.
- Use the same `ensureViaServiceWorker()` helper that `streamPrompt` /
  `rebuildSession` use.
- Construct the request `{ type: COUNT_TOKENS_REQUEST, text }` and send via
  `chrome.runtime.sendMessage`.
- Race the send against `new Promise<number>((resolve) => setTimeout(() =>
  resolve(Math.ceil(text.length / 3)), timeoutMs))`. Whichever resolves
  first wins.
- If the send resolves with a malformed reply or `ok: false`, fall back to
  the heuristic. Do not throw from `countTokens`. The whole point is a
  predictable number for downstream math.
- If `chrome.runtime.lastError` is set after the send, fall back to the
  heuristic and log a single `console.warn`.
- If the polyfill reply arrives after the timeout but before the caller
  has consumed the resolved promise, ignore it (the heuristic has already
  resolved).

**Verification Checklist:**

- [x] `npm run typecheck` passes.
- [x] `npm run lint:ci` passes.
- [x] `countTokens` is exported and re-exported (if applicable) consistently
      with `streamPrompt`, `sendPrompt`, `rebuildSession`.
- [x] On any error condition, `countTokens` resolves (never rejects).

**Testing Instructions:**

Extend `tests/offscreen-client.test.ts` with a new `describe('countTokens')`
block. Tests to write:

- Sends `ENSURE_OFFSCREEN_REQUEST` then `COUNT_TOKENS_REQUEST` with the
  text payload, returns the polyfill count on a well-formed reply.
- Falls back to the heuristic when the reply is `ok: false`.
- Falls back to the heuristic when `chrome.runtime.lastError` is set.
- Falls back to the heuristic when the reply is malformed.
- Falls back to the heuristic when the send takes longer than
  `timeoutMs`. Use `vi.useFakeTimers()` and have the mocked `sendMessage`
  return a promise that never resolves; advance timers past `timeoutMs`.
- Heuristic value is `Math.ceil(text.length / 3)`.

Run `npm test -- --run tests/offscreen-client.test.ts`.

**Commit Message Template:**

```text
feat(offscreen): expose countTokens with heuristic fallback

- New client export races the polyfill round-trip against a 100ms timer.
- On timeout or error, returns Math.ceil(text.length / 3) so callers
  always get a usable number.
- Used by the selection-rewrite soft cap; the brainstorm flagged that
  countTokens may add real latency on Gemma-4, so the fallback is the
  default UX guarantee.
```

---

### Task 4: Create `src/selection-rewrite.ts`

**Goal:** New module owning the selection snapshot type, the prompt
builder, the in-place streaming logic, and the undo implementation. This
is the single module Phase-1 introduces under `src/`.

**Files to Modify/Create:**

- `src/selection-rewrite.ts` — the new module.

**Prerequisites:** Tasks 1, 3.

**Design notes (read in full before coding):**

Module exports:

```text
MIN_OUTPUT_TOKENS = 256                    // soft cap floor (tokens)
MAX_OUTPUT_MULTIPLIER = 2                  // soft cap multiplier of input
CONTEXT_CHARS_BEFORE = 200                 // chars captured before selection
CONTEXT_CHARS_AFTER = 200                  // chars captured after selection
MAX_SELECTION_CHARS = 700                  // hard cap on selection text
TRANSFORM_SYSTEM_HINT = '<string literal>' // prepended to user instruction

interface SelectionSnapshot {
  text: string                  // the selected text
  before: string                // up to CONTEXT_CHARS_BEFORE chars
  after: string                 // up to CONTEXT_CHARS_AFTER chars
  range: Range                  // live range; used at send time
  // serialized coordinates used for undo
  undoAnchor: {
    startContainer: Node
    startOffset: number
    endContainer: Node
    endOffset: number
    originalText: string
  }
}

function isSupportedSelection(sel: Selection | null): boolean
function snapshotSelection(sel: Selection): SelectionSnapshot | null
function decideSnapshot(args: {
  activeEl: Element | null
  inputEl: Element
  selection: Selection | null
}): SelectionSnapshot | null
function buildRewritePrompt(snap: SelectionSnapshot, instruction: string,
                            softCapTokens: number): string
function buildAskPrompt(snap: SelectionSnapshot, instruction: string): string
function streamRewriteIntoRange(snap: SelectionSnapshot,
                                onChunk: (chunk: string) => void): {
  // called per chunk in the SAME order session.ts already uses for chat;
  // on first chunk, deletes range contents and inserts an empty text node;
  // appends subsequent chunks to that text node.
  applyChunk: (chunk: string) => void
  finalize: () => void  // marks the rewrite committed; freezes undoAnchor
}
function undoRewrite(snap: SelectionSnapshot): { ok: boolean; reason?: string }
```

**Implementation Steps:**

1. **isSupportedSelection.** Returns `false` if selection is null, empty,
   collapsed, or has more than one range. Walks ancestors from the range's
   `commonAncestorContainer` (or the element parent of a text node). Any
   ancestor with `tagName === 'INPUT'`, `tagName === 'TEXTAREA'`, or
   `isContentEditable === true` disqualifies the selection. Return `true`
   only when the selection has at least one non-whitespace character.

2. **decideSnapshot.** Pure function wrapping the input-focus suppression
   rule from ADR-007:
   - If `args.activeEl === args.inputEl`, return `null` without consulting
     the selection. This is the load-bearing rule: clicking into the chat
     input fires `selectionchange` with an empty page selection, and we
     do not want to clobber the previously captured snapshot.
   - Otherwise return `snapshotSelection(args.selection)`.
   - Extracted as its own export so `tests/selection-rewrite.test.ts` can
     drive the suppression rule directly without standing up a full
     `content.ts`-style panel. The `selectionchange` handler in
     `content.ts` becomes a one-liner that forwards
     `decideSnapshot({ activeEl: document.activeElement, inputEl: input,
     selection: window.getSelection() })` to the session callback.

3. **snapshotSelection.** Returns `null` for unsupported selections.
   Otherwise:
   - Clone the live `Range` with `range.cloneRange()`.
   - Read `range.toString()` and truncate to `MAX_SELECTION_CHARS` (slice
     from the start; the selection survives but the prompt payload is
     bounded). Note: the live range is not mutated; only the prompt-side
     `text` is truncated.
   - Compute `before` by walking up to `CONTEXT_CHARS_BEFORE` chars
     backwards from the range's start. Use a TreeWalker on text nodes
     starting from the common ancestor's nearest block-level container (or
     `document.body` if none); collect text content until the budget is
     met. Reverse-iterate so the closest text is included first.
   - Compute `after` similarly from the range's end, forward, up to
     `CONTEXT_CHARS_AFTER` chars.
   - Capture `undoAnchor` fields from the cloned range plus `originalText
     = range.toString()` (untruncated; undo must restore exactly what was
     there).
   - Return the snapshot.

4. **buildRewritePrompt.** Constructs a prompt of the shape:

   ```text
   You are rewriting a piece of text in place. Respond with only the
   rewritten text. No commentary, no quotes, no preamble. Match the style
   of the surrounding context. Aim for roughly {softCapTokens} tokens.

   Context before the selection:
   {snap.before}

   Context after the selection:
   {snap.after}

   Selection to rewrite:
   {snap.text}

   Instruction:
   {instruction}
   ```

   Both `before` and `after` are stripped of leading/trailing whitespace and
   substituted as plain text (no escaping; the polyfill template handles
   the rest). The literal exact wording is fixed; do not paraphrase.

5. **buildAskPrompt.** Constructs:

   ```text
   The user has selected this text on the page:
   {snap.text}

   Their question:
   {instruction}

   Answer concisely. Do not rewrite the text; just answer.
   ```

6. **streamRewriteIntoRange.**
   - Use a closure-scoped `Text` node and a `boolean` `firstChunk` flag.
   - `applyChunk(chunk)`:
     - On the first non-empty chunk, call
       `snap.range.deleteContents()`, then create a `Text` node via
       `document.createTextNode('')` and insert via
       `snap.range.insertNode(textNode)`. Save the text node.
     - Append `chunk` to the text node's `data`.
     - Set `firstChunk = false`.
     - The caller is responsible for also calling `onChunk(chunk)` (for
       symmetry with the chat flow; the chunk also feeds the model bubble's
       text). Pass `onChunk` from session.ts; this module does not own the
       chat bubble.
   - `finalize()`: no-op today. Reserved for future commit-or-rollback
     behaviour.

7. **undoRewrite.**
   - Walk to `undoAnchor.startContainer` and `endContainer`. If either is
     no longer in the document (`!startContainer.isConnected`), return
     `{ ok: false, reason: 'snapshot detached' }`.
   - If both are connected, create a new `Range` with the saved offsets.
     Replace its contents with a text node carrying `originalText`.
     Catch any DOM exception and return `{ ok: false, reason: msg }`.
   - On success, return `{ ok: true }`. Subsequent calls return
     `{ ok: false, reason: 'already undone' }` (track via a module-private
     `WeakSet<SelectionSnapshot>`).

**Verification Checklist:**

- [x] No import of `vendor/prompt-api-polyfill`.
- [x] No call to `LanguageModel.create()`.
- [x] All five constants exported.
- [x] `isSupportedSelection` rejects `<input>`, `<textarea>`, and
      `contenteditable` ancestors.
- [x] Prompt builders return strings; no side effects.
- [x] `streamRewriteIntoRange.applyChunk` is idempotent for first-chunk
      detection (calling it multiple times with empty strings does not
      delete the range twice).

**Testing Instructions:**

Create `tests/selection-rewrite.test.ts`. Use jsdom to build a small DOM
fragment, manipulate ranges directly, and assert against the resulting
text content. Mock nothing in this file; the module has no external
dependencies.

Test cases:

- `isSupportedSelection`:
  - returns false for null, collapsed, empty selections.
  - returns false when ancestor is `<input>`.
  - returns false when ancestor is `<textarea>`.
  - returns false when an ancestor has `contentEditable = 'true'`.
  - returns true for a selection inside `<p>` text.
- `snapshotSelection`:
  - returns null when unsupported.
  - captures the selected text verbatim.
  - truncates the prompt-side `text` to `MAX_SELECTION_CHARS`.
  - captures `before` up to `CONTEXT_CHARS_BEFORE` from preceding text
    nodes.
  - captures `after` up to `CONTEXT_CHARS_AFTER` from following text nodes.
  - captures `undoAnchor.originalText` as the full (untruncated) selection.
- `decideSnapshot`:
  - returns `null` when `activeEl === inputEl`, even when the selection
    would otherwise be supported. This is the snapshot-survival rule from
    ADR-007 and is the only place CI can prove that clicking into the
    input does not clobber the snapshot.
  - returns the same value as `snapshotSelection(selection)` when
    `activeEl !== inputEl`.
  - returns `null` when `selection` is null regardless of `activeEl`.
- `buildRewritePrompt`:
  - includes the instruction, selection, before, and after in the
    documented order.
  - mentions the soft-cap token count.
- `buildAskPrompt`:
  - quotes the selection and the instruction.
  - does not include "rewrite" language.
- `streamRewriteIntoRange`:
  - deletes the range on the first non-empty chunk.
  - subsequent chunks append to the same text node.
  - resulting DOM has the concatenated chunk text at the original
    selection position.
- `undoRewrite`:
  - restores `originalText` to the range coordinates.
  - returns `ok:false, reason:'snapshot detached'` when the container is
    removed from the document.
  - returns `ok:false, reason:'already undone'` on the second call.

Run `npm test -- --run tests/selection-rewrite.test.ts`.

**Commit Message Template:**

```text
feat(transform): add selection-rewrite module

- New src/selection-rewrite.ts owns the selection snapshot, the rewrite
  and ask prompt builders, the in-place streaming DOM mutation, and the
  single-level undo restoration.
- Reuses the offscreen LanguageModel session; the module has no polyfill
  or LanguageModel imports.
- Selection payload bounded at 700 chars (selection + ~200 chars of
  before/after context).
- Soft output cap exposed as MIN_OUTPUT_TOKENS / MAX_OUTPUT_MULTIPLIER
  module-level constants; the polyfill backend bakes 2048 as the hard
  ceiling, which we cannot override per-call without a vendor patch.
```

---

### Task 5: Wire the selection-rewrite module into the session

**Goal:** Teach `src/session.ts` about selection mode. Add a placeholder
swap, an Esc handler that toggles Ask mode, a send path that builds the
rewrite prompt, calls `countTokens` to compute the soft cap, passes the
prompt through `streamPrompt`, and streams chunks into the DOM via
`streamRewriteIntoRange` while also showing the model bubble. Add an
"Undo" button to the model bubble for rewrite turns.

**Files to Modify/Create:**

- `src/session.ts` — add selection mode logic.
- `content.ts` — register the `selectionchange` listener and pass its
  output into the session via a new dependency.

**Prerequisites:** Tasks 1-4.

**Implementation Steps:**

1. **Extend `SessionDeps`:**

   Add an `onSelectionChange` callback registration:

   ```text
   onSelectionChange: (cb: (snap: SelectionSnapshot | null) => void) => void
   ```

   `content.ts` provides an implementation that wires up
   `document.addEventListener('selectionchange', …)` and computes the
   snapshot each time, skipping updates when
   `document.activeElement === input` (see ADR-007).

2. **Session-state additions in `initSession`:**

   - `let currentSelection: SelectionSnapshot | null = null;`
   - `let askMode = false;` — only meaningful when `currentSelection`
     exists.

3. **Placeholder management:**

   Extract a tiny `updatePlaceholder()` helper inside `initSession`:

   - No selection: placeholder reads
     `Ask anything about this page (Enter)`.
   - Selection present, not askMode:
     `Edit selection… (Esc to switch to Ask)`.
   - Selection present, askMode:
     `Ask about selection… (Esc to switch back to Edit)`.

   Call it from the selection-change callback and from the Esc handler.

4. **Esc handler:**

   On `keydown` inside the input:

   - If `e.key === 'Escape'` and `currentSelection`:
     - Toggle `askMode`.
     - Call `updatePlaceholder()`.
     - `e.preventDefault()`.
   - Otherwise leave the existing Enter handler unchanged.

5. **Send path:**

   Branch in `send()` based on `currentSelection` and `askMode`:

   - **No selection:** existing chat path, unchanged.
   - **Selection + askMode:** build the ask prompt via `buildAskPrompt`,
     send it through `streamPrompt`, render to a model bubble exactly like
     the chat path. After send, reset `askMode = false` and call
     `updatePlaceholder()`. The DOM is not mutated.
   - **Selection + not askMode (rewrite):**
     1. Read `instruction = i.value.trim()`. Empty falls through (no-op).
     2. Snapshot is `currentSelection` (already captured in state). Clear
        `currentSelection` so a subsequent selection change does not
        clobber the in-flight rewrite's anchor.
     3. Compute the soft cap. Count tokens on the content payload only,
        not on the framed prompt, so the count is independent of the cap
        digit we are about to compute and substitute. The payload is:

        ```text
        ${snap.before}\n${snap.text}\n${snap.after}\n${instruction}
        ```

        Then:
        - `inputTokens = await countTokens(payload)`
        - `softCap = Math.max(MIN_OUTPUT_TOKENS, inputTokens * MAX_OUTPUT_MULTIPLIER)`
        - `const prompt = buildRewritePrompt(snap, instruction, softCap)`

        Rationale: counting the framed prompt would create a chicken-and-
        egg (the framing text contains the cap number whose digit count
        affects the token count). Counting the content payload keeps the
        math clean. The framing template is short and constant; the
        difference is well inside the soft-cap's margin.
     4. Render a user bubble with `instruction` text (treated as a normal
        user turn; persists to history).
     5. Render an empty model bubble plus typing indicator (same as chat).
     6. Attach the streaming hook:

        ```text
        const rewrite = streamRewriteIntoRange(snap, onChunk)
        const onChunk = (chunk) => {
          rewrite.applyChunk(chunk)
          // and the chat-bubble update logic from the chat path
        }
        ```

     7. Call `streamPrompt(prompt, { signal, onChunk })`. The chat path's
        first-chunk-removes-indicator, abort, error, and device-loss-retry
        logic all apply unchanged. The device-loss retry recomputes the
        prompt from the same snapshot.
     8. On success (modelText non-empty), call `rewrite.finalize()` and
        append an Undo button to the model bubble. Clicking the button:
        - Calls `undoRewrite(snap)`.
        - If `ok`, disables the button (text changes to "Undone") and
          logs a console line.
        - If `!ok`, disables the button (text changes to "Undo failed")
          and logs `reason` as `console.warn`.
     9. On error (including abort), do **not** add an Undo button. Partial
        text already in the DOM stays in place (brainstorm decision: the
        Undo button is the escape hatch, but it requires a finalized
        rewrite).

6. **Selection-change wiring:**

   Subscribe via `deps.onSelectionChange((snap) => { currentSelection =
   snap; if (!snap) askMode = false; updatePlaceholder(); })`.

   The active-element check (skip updates when the input is focused) lives
   in `content.ts`, not the session. The session simply receives whatever
   the dep emits.

7. **Selection preview chip:**

   When `currentSelection` is non-null, render a compact chip above the
   input showing a one-line preview of the selection text (truncated to
   60 chars with an ellipsis). The chip uses the existing panel palette:
   `background: #333; color: #eee; padding: 2px 8px;` so it reads as part
   of the panel (matches the header background at `content.ts:38`).
   Hidden by default (`style.display = 'none'`); shown on selection,
   hidden on clear. The chip's text is the snapshot's `text` truncated to
   60 chars.

   Add a `selectionChip: HTMLElement` to `SessionDeps` so `content.ts`
   owns the DOM element creation. The session only manages its content
   and visibility.

**Verification Checklist:**

- [x] Placeholder updates correctly across all three states.
- [x] Esc toggles ask mode only when a selection is present.
- [x] Rewrite send does not run when `instruction` is empty.
- [x] Rewrite send writes both the user instruction and the model output
      to history (existing path covers this; verify nothing was bypassed).
- [x] Undo button appears only on successful rewrites.
- [x] Undo button restores original text on click.
- [x] No `LanguageModel.create()` calls in the diff (grep check).
- [x] None of the removed-at-v0.2.1 filenames reappear (grep check).

**Testing Instructions:**

Extend `tests/session.test.ts` with a new `describe('initSession —
selection mode')` block. The existing `streamPrompt` mock pattern works
unchanged. Add a `countTokens` mock in the same `vi.mock(...)` factory:
`countTokens: vi.fn(async (text: string) => Math.ceil(text.length / 3))`.

Extend `makeDeps()` to include a `selectionChip` div and an
`onSelectionChange(cb)` that captures the callback. Tests drive selection
state by calling that captured callback with a manually constructed
snapshot.

Test cases (all using the existing pending-stream pattern):

- placeholder swaps to "Edit selection…" when a snapshot arrives.
- placeholder swaps back to chat default when snapshot becomes null.
- Esc toggles ask mode; placeholder swaps to "Ask about selection…".
- Esc with no selection is a no-op (the existing chat default stays).
- Rewrite send: prompt sent to `streamPrompt` includes the selection text,
  the instruction, and the soft-cap number.
- Rewrite send: streaming chunks land both in the chat bubble and in the
  Range (assert against the test DOM container holding the range).
- Rewrite send on success: model bubble has an Undo button.
- **Rewrite send on success persists both turns to `chrome.storage.local`
  under the per-URL key.** After the stream resolves, read
  `chromeMock.storage.local.store['local-nano:history:https://example.com/page']`
  and assert it contains a `{ role: 'user', text: <instruction> }` entry
  followed by a `{ role: 'model', text: <rewritten text> }` entry.
  Mirror the existing chat-path coverage at
  `tests/session.test.ts:248-266` ("persists model entry to history after
  a successful stream") so brainstorm decision Q4/A (transforms are
  normal chat turns in storage and history) is verified by the suite, not
  just by reading code.
- Undo click: original text restored at the range location.
- Undo click after the container is removed from the document: button
  text changes to "Undo failed".
- Ask-mode send: prompt is the ask shape, not the rewrite shape; DOM is
  not mutated.
- Ask-mode resets to rewrite after the turn completes (placeholder back to
  "Edit selection…").
- Empty selection chip is hidden; non-null snapshot shows the chip with
  truncated text.

Run the full session suite with `npm test -- --run tests/session.test.ts`.

**Commit Message Template:**

```text
feat(transform): wire selection-rewrite into the chat session

- Adds selection-aware mode flip on the chat input: placeholder swap, an
  inline selection preview chip, and an Esc toggle to ask-about-selection
  mode.
- Rewrite path streams chunks into both the chat model bubble and the
  captured DOM range; undo button on the bubble restores the original
  text from a JS-memory snapshot.
- Reuses the offscreen LanguageModel session; transforms persist as
  ordinary user/model turns under the existing per-URL storage key.
- Soft output cap is computed via the new countTokens helper with a
  heuristic fallback when the polyfill round-trip exceeds 100ms.
```

---

### Task 6: Bootstrap the selection listener and chip in `content.ts`

**Goal:** Add the selection-change listener and the chip element, then
hand both to `initSession` through the extended `SessionDeps`.

**Files to Modify/Create:**

- `content.ts` — register listener and chip element.

**Prerequisites:** Task 5.

**Implementation Steps:**

- Create the chip element inline (same `document.createElement('div')`
  pattern as the existing panel layout). Insert it just above
  `inputWrap`. Default `style.display = 'none'`.
- Register the `selectionchange` listener on `document` from inside
  `content.ts`. The handler is a one-liner that delegates to the pure
  `decideSnapshot` helper from `src/selection-rewrite.ts`:

  ```text
  document.addEventListener('selectionchange', () => {
    cb(decideSnapshot({
      activeEl: document.activeElement,
      inputEl: input,
      selection: window.getSelection(),
    }))
  })
  ```

  The `activeElement === input` check lives inside `decideSnapshot` so it
  is unit-tested in `tests/selection-rewrite.test.ts` (see Task 4). The
  content-script side has no branching of its own.
- Pass an `onSelectionChange(cb)` shim into `initSession` that simply
  captures the callback and is invoked by the listener.
- Pass `selectionChip: chipEl` into `initSession`.
- Do **not** alter the panel layout otherwise. Do not change the existing
  drag, close, or toggle wiring.

**Verification Checklist:**

- [x] `selectionchange` listener installed at module load.
- [x] Listener body is the single `cb(decideSnapshot(...))` call; the
      suppression rule is not duplicated here.
- [x] Chip is appended above the input wrap.
- [x] `npm run build` produces a working `dist/content.js`.

**Testing Instructions:**

`content.ts` is still the DOM bootstrap layer with no unit-test file.
The load-bearing snapshot-decision logic (ADR-007's
`activeElement === input` suppression) is covered by the `decideSnapshot`
unit tests in Task 4, not here. The remaining `content.ts` content is
glue: `document.addEventListener('selectionchange', …)`, chip element
creation, and passing both into `initSession`. That glue is verified by
typecheck, lint, and the Task 9 manual smoke test.

**Commit Message Template:**

```text
feat(transform): bootstrap selection listener and preview chip

- content.ts now installs the document selectionchange listener and
  passes the snapshot (or null) into the session.
- Snapshot updates are suppressed while the chat input is focused, so
  clicking into the input does not clobber the snapshot.
- New chip element above the input is owned by content.ts; the session
  manages its content and visibility.
```

---

### Task 7: Write `docs/transform.md`

**Goal:** Document the feature for users and contributors.

**Files to Modify/Create:**

- `docs/transform.md` — new.

**Prerequisites:** Tasks 4-6 in concept; the doc can be written before the
final commit and updated to match shipped behaviour.

**Required sections:**

1. **Overview.** One paragraph describing the user flow.
2. **How to use.** Step-by-step: highlight, click into the panel, type
   instruction, press Enter. Note the Esc toggle for Ask mode.
3. **Undo.** Single-level, JS-memory, lost on navigation.
4. **What's supported.** Plain DOM only. `<input>` / `<textarea>` /
   `contenteditable` not supported yet (queued for v0.3.0).
5. **Architecture constraints inherited from v0.2.0.** Brief recap of the
   memory-budget story, including:
   - Single offscreen `LanguageModel` session shared with chat.
   - Soft cap formula and the polyfill's 2048 hard ceiling.
   - Bounded selection payload.
6. **v0.3.0 follow-ups.** What's deferred:
   - `contenteditable` / input / textarea support.
   - Multi-level undo.
   - Structural edits (lists, headings, blockquotes).
7. **Privacy.** Selection text never leaves the device; it's processed by
   the same offscreen session as chat.

Use the existing doc style (see `docs/architecture.md`). Headings without
trailing punctuation. Fenced code blocks tagged (`text`, `bash`,
`markdown`, etc.).

**Verification Checklist:**

- [ ] `markdownlint` passes (run via `npm run lint:ci` if the project
      wires markdown lint into the script; otherwise run
      `npx markdownlint-cli2 docs/transform.md`).
- [ ] No emojis, no em dashes, no AI-isms.
- [ ] Cross-link added in `docs/architecture.md` if appropriate
      (consider it, do not force it).

**Testing Instructions:**

Doc only. No tests beyond markdownlint.

**Commit Message Template:**

```text
docs(transform): document the selection-rewrite feature

- New docs/transform.md covers user flow, undo behavior, supported
  selection contexts, the architectural constraints inherited from the
  v0.2.0 post-mortem, and the v0.3.0 follow-up scope.
```

---

### Task 8: Bump version, update CHANGELOG, smoke-test the build

**Goal:** Cut the v0.2.3 release artifacts.

**Files to Modify/Create:**

- `package.json` — bump `version` from `0.2.2` to `0.2.3`.
- `manifest.json` — bump `version` from `0.2.2` to `0.2.3`.
- `CHANGELOG.md` — prepend a `## [0.2.3]` section.

**Prerequisites:** Tasks 1-7 merged on the feature branch.

**CHANGELOG section structure:**

```markdown
## [0.2.3] - YYYY-MM-DD

Restores selection-driven in-place rewrite, designed against the memory
budget that killed v0.2.0. Highlight prose, type an instruction into the
chat input, and the model rewrites the selection in place while tokens
stream. A single-level Undo button on the resulting chat bubble restores
the original text. Pressing Esc inside the input toggles to "Ask about
selection" mode, which quotes the selection into a normal chat prompt
without mutating the DOM.

The feature reuses the v0.2.2 offscreen `LanguageModel` session; no
second model is loaded into WebGPU. Selection payload is hard-capped at
~700 chars. The polyfill's 2048-token output ceiling is unchanged; a
prompt-side soft cap computed from the input token count keeps real-world
rewrite outputs bounded.

### Added

- `src/selection-rewrite.ts` — snapshot capture, prompt builders,
  in-place streaming into the captured `Range`, single-level undo.
- New `count` channel in the offscreen protocol
  (`src/offscreen/protocol.ts`) and `countTokens()` export in
  `src/offscreen/client.ts`, racing the polyfill round-trip against a
  100ms timeout with a `chars/3` heuristic fallback.
- Esc-toggled "Ask about selection" mode that quotes the selection
  without mutating the DOM.
- `docs/transform.md`.
- New tests: `tests/selection-rewrite.test.ts`; extensions to
  `tests/offscreen-protocol.test.ts`, `tests/offscreen-client.test.ts`,
  and `tests/session.test.ts`.

### Changed

- `src/session.ts` — selection-aware placeholder swap, Esc handler,
  rewrite send path, undo button on the model bubble.
- `content.ts` — installs the `selectionchange` listener and the
  selection-preview chip.
- `package.json` and `manifest.json` version bumped 0.2.2 → 0.2.3.

### Notes

- The chat session and selection-rewrite share one `LanguageModel`
  instance by design; the v0.2.0 OOM root cause is foreclosed by
  construction.
- `<input>`, `<textarea>`, and `contenteditable` regions are still
  unsupported. Queued for v0.3.0.
```

**Implementation Steps:**

- Edit the three files.
- Run the full local check sequence:
  - `npm run lint:ci`
  - `npm run typecheck`
  - `npm test -- --run`
  - `npm run build`
- Load `dist/` as an unpacked extension in Chrome and run the manual
  smoke test (Task 9) before committing.

**Verification Checklist:**

- [ ] `package.json` and `manifest.json` both show `0.2.3`.
- [ ] CHANGELOG entry placed above the existing `## [0.2.2]` block.
- [ ] All local checks green.

**Testing Instructions:**

Extend `tests/docs-config.test.ts` only if it asserts a specific version
number (read it first; today it only cross-checks `.env.example.json`
against `docs/configuration.md`, so no update is needed). Otherwise the
existing test suite covers the diff.

**Commit Message Template:**

```text
chore(release): bump to v0.2.3 with selection-rewrite changelog

- package.json and manifest.json now match at 0.2.3.
- CHANGELOG entry summarizes the feature and the architectural
  constraints inherited from the v0.2.0 post-mortem.
```

---

### Task 9: Manual smoke test

**Goal:** Verify the feature on a real page before considering Phase-1
done. CI cannot exercise WebGPU; this is the only check that proves the
happy path.

**Prerequisites:** Tasks 1-8.

**Implementation Steps:**

1. `npm run build` clean.
2. In Chrome, open `chrome://extensions`, enable Developer Mode, click
   "Load unpacked", and select the `dist/` directory.
3. Open any prose-heavy page (e.g. a Wikipedia article).
4. Toggle the panel with `Ctrl+Shift+K` and wait for the model to load.
5. Confirm baseline chat works (one turn).
6. Highlight a sentence in the article. The chip should appear above the
   input and the placeholder should swap to "Edit selection…".
7. Click into the input. Confirm the chip and placeholder still show
   selection mode (ADR-007 in action).
8. Type "make this more formal" and press Enter. Observe tokens stream
   into the page in place of the original text.
9. After completion, click "Undo" on the model bubble. The original
   sentence should reappear.
10. Highlight a new sentence, press Esc inside the input, confirm
    placeholder swaps to "Ask about selection…". Type "what does this
    mean?" and Enter. Observe the model answer in a normal chat bubble;
    the page DOM is unchanged.
11. Highlight text inside a Google Docs / Gmail / Twitter compose box
    (contenteditable). Confirm the chip does not appear and the input
    behaves as plain chat.

**Verification Checklist:**

- [ ] Tokens stream into the DOM in place.
- [ ] Undo restores the original text.
- [ ] Ask mode does not mutate the DOM.
- [ ] Contenteditable selections do not trigger mode flip.
- [ ] No WebGPU OOM in the console after 10+ rewrites.
- [ ] No second `LanguageModel.create()` log line from the offscreen
      document.

**Testing Instructions:**

This is a manual test. Record the outcome in the PR body when opening it.
No automation.

**Commit Message Template:**

n/a (no code change). The smoke test is a gate, not a commit.

---

## Phase Verification

Phase-1 is complete when:

- All nine tasks are done.
- All commits land on the feature branch with conventional-commit messages
  and no `Co-Authored-By` line.
- `npm run lint:ci`, `npm run typecheck`, `npm test -- --run`, and
  `npm run build` all pass.
- Manual smoke test passes on at least one prose-heavy public page.
- A PR is opened to `main` summarizing the feature and linking the
  changelog entry. Do not merge; the user opens the merge commit.

## Integration Points to Test

- Chat-only behaviour with no selection (regression).
- Selection mode → rewrite → undo round-trip.
- Selection mode → Esc → ask → DOM unchanged.
- Device-loss retry mid-rewrite (force by switching tabs during streaming).
- Long selection (>700 chars) is truncated on the prompt side but undo
  restores the full original.

## Known Limitations / Technical Debt

- The polyfill's 2048-token `max_new_tokens` ceiling is unchanged. The
  soft cap is advisory, not enforced. A future patch to the polyfill could
  thread per-call caps through the backend; today the bounded selection
  size and prompt-side hint keep us safely under the ceiling.
- Undo is JS-memory only and lost on navigation. v0.3.0 may explore
  persisted undo, but the brainstorm explicitly defers it.
- `<input>` / `<textarea>` / `contenteditable` are not supported. The
  brainstorm scopes these to v0.3.0.
- The `countTokens` call inflates startup latency by one polyfill
  round-trip per rewrite. The 100ms fallback bounds the worst case at
  100ms, but in practice the round-trip is usually faster.
- No multi-tab transform coordination. The shared offscreen session
  naturally serializes; the existing `activeAbort` guard handles per-tab
  concurrency.
