# Phase 3 — Content Script: Selection Capture, Preview UI, and DOM Apply

## Phase Goal

Make the v0.2 actions work end-to-end on the page side: snapshot selections
at right-click / hotkey time, dispatch the background-delivered action,
render a Preview component for write-side actions, and apply the result to
the DOM. This is the largest phase because it touches the content script,
the session deps surface, and adds three new `src/` modules plus their
tests.

After this phase, every action in the v0.2 menu produces user-visible
behavior. The chat session is untouched; transforms run through
`runTransform` and never write to chat history.

**Success criteria:**

- `src/dom-actions.ts` exports `initDomActions(deps)` that wires
  `contextmenu`, `keydown` selection snapshots, and `chrome.runtime.onMessage`
  action dispatch.
- `src/dom-apply.ts` exports `applyToTarget(target, newText)` covering all
  three DOM branches.
- `src/ui/preview.ts` exports a Preview component with Apply / Discard
  state machine.
- `src/session.ts` exposes a small surface (`requestPreviewSlot`,
  `prefillAndSend`, `setPanelVisible`) so `dom-actions.ts` can drive the
  panel without owning its DOM.
- `content.ts` is updated to call `initDomActions(deps)` after
  `initSession(deps)`.
- New test files for each new module; existing 53 tests still pass.
- Manual smoke checklist (below) passes on a real Chrome install.
- `npm run lint:ci && npm run typecheck && npm run coverage && npm run build`
  all exit 0.

**Estimated tokens:** ~42k

## Prerequisites

- Phases 1 and 2 complete.
- The action message protocol (`ACTION_MESSAGE_KIND`, `ActionMessage`) is
  exported from `src/background/handler.ts`.
- `runTransform`, `actionToDescriptor`, `actionToPrompt`, `checkSelection`,
  `selectionChatPrefill`, and `SELECTION_LIMIT` are available from
  `src/transform.ts` / `src/transform-prompts.ts`.

## Module Order Within the Phase

1. Task 3.1 — Selection snapshot type and capture helpers (no DOM mutation).
1. Task 3.2 — DOM apply layer (`src/dom-apply.ts`).
1. Task 3.3 — Preview component (`src/ui/preview.ts`).
1. Task 3.4 — Session surface extension (`src/session.ts` minor additions).
1. Task 3.5 — Action dispatch (`src/dom-actions.ts`) wiring everything
   together.
1. Task 3.6 — `content.ts` integration and manual smoke test.

## Tasks

### Task 3.1 — Selection Snapshot: Type and Capture

**Goal:** A pure helper that, given a `Document`, returns either a
`RangeSnapshot` (for normal DOM selections) or an `InputSnapshot` (for
`<input>` and `<textarea>`), or `null` if there is no selection. The
capture must be synchronous at `contextmenu` time so the selection survives
the user clicking the panel.

**Files to Modify/Create:**

- `src/dom-actions.ts` (new — selection capture and the snapshot types
  live here; the dispatch logic is added in Task 3.5)
- `tests/dom-actions.test.ts` (new — selection-capture tests only at this
  point)

**Prerequisites:** none

**Implementation Steps:**

- Add to `src/dom-actions.ts`:

  ```ts
  export interface RangeSnapshot {
    kind: 'range';
    range: Range;
    text: string;
    /**
     * If the selection sits inside a contentEditable, this is that element
     * (used by the apply layer to prefer execCommand('insertText')). Null
     * otherwise.
     */
    contentEditable: HTMLElement | null;
  }

  export interface InputSnapshot {
    kind: 'input';
    element: HTMLInputElement | HTMLTextAreaElement;
    selectionStart: number;
    selectionEnd: number;
    text: string;
  }

  export type SelectionSnapshot = RangeSnapshot | InputSnapshot;

  /**
   * Capture the current selection. Call from a contextmenu listener (or
   * the hotkey keydown handler) BEFORE the panel steals focus.
   * Returns null if there is no selection.
   */
  export function captureSelection(doc: Document): SelectionSnapshot | null {
    const active = doc.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (start != null && end != null && start !== end) {
        return {
          kind: 'input',
          element: active,
          selectionStart: start,
          selectionEnd: end,
          text: active.value.slice(start, end),
        };
      }
    }
    const sel = doc.defaultView?.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0).cloneRange();
    const text = sel.toString();
    if (text.length === 0) return null;
    // Find an ancestor contentEditable for the apply hint.
    let ce: HTMLElement | null = null;
    let node: Node | null = range.commonAncestorContainer;
    while (node) {
      if (node instanceof HTMLElement && node.isContentEditable) {
        ce = node;
        break;
      }
      node = node.parentNode;
    }
    return { kind: 'range', range, text, contentEditable: ce };
  }
  ```

- Create `tests/dom-actions.test.ts` with the capture tests:
  1. `captureSelection(document)` returns `null` when no selection exists.
  1. With an `<input>` containing `'hello world'` and
     `selectionStart=0`, `selectionEnd=5` and `document.activeElement`
     set to the input, returns `{ kind: 'input', text: 'hello', ... }`.
     (Build via jsdom: `input.focus(); input.setSelectionRange(0, 5);`.)
  1. Same for `<textarea>`.
  1. With `<input>` selection where start === end, returns `null`.
  1. With a regular DOM selection (use `document.createRange()` +
     `selection.addRange()` to set up), returns
     `{ kind: 'range', text: <expected>, contentEditable: null }`.
  1. When the range is inside a `contenteditable="true"` element, the
     `contentEditable` field is set to that element.
  1. When `sel.isCollapsed` is true (cursor only, no selection), returns
     `null`.

  Note on jsdom Selection support: jsdom implements `Range` and a partial
  `Selection`. If a particular assertion is awkward, the test can build
  the snapshot by directly constructing the `Range` and stubbing
  `getSelection` via `Object.defineProperty(window, 'getSelection', { value: () => fakeSelection })`.
  Document the workaround in a code comment in the test if used.

**Verification Checklist:**

- [x] `src/dom-actions.ts` exports `SelectionSnapshot` union and
      `captureSelection`
- [x] `tests/dom-actions.test.ts` has >= 7 tests for capture
- [x] `npm run typecheck` exits 0
- [x] `npm run lint:ci` exits 0

**Testing Instructions:**

- `npx vitest run tests/dom-actions.test.ts`

**Commit Message Template:**

```text
feat(dom-actions): add captureSelection with input/textarea branch

- RangeSnapshot for DOM selections; InputSnapshot for <input>/<textarea>
- Detects contentEditable ancestors to inform the apply layer
- Returns null for empty / collapsed selections
- Tests cover all snapshot variants in jsdom
```

---

### Task 3.2 — DOM Apply Layer

**Goal:** Replace the selection in the page DOM with new text. Branches
based on the snapshot kind and on whether the range sits inside a
contentEditable. Uses only safe text-node primitives — never `innerHTML`.

**Files to Modify/Create:**

- `src/dom-apply.ts` (new)
- `tests/dom-apply.test.ts` (new)

**Prerequisites:** Task 3.1 complete (`SelectionSnapshot` type available).

**Implementation Steps:**

- Add to `src/dom-apply.ts`:

  ```ts
  import type { SelectionSnapshot } from './dom-actions.js';

  /**
   * Replace the selection captured in `snapshot` with `newText`.
   * Three branches:
   *   - input/textarea: setRangeText with 'end' selection mode
   *   - contentEditable inside a Range snapshot: execCommand('insertText')
   *     so native browser undo works; falls back to Range mutation if
   *     execCommand is unavailable or returns false
   *   - regular DOM Range: deleteContents + insertNode(textNode)
   * Returns true on success, false if the apply could not be performed
   * (e.g. the element was removed from the DOM).
   */
  export function applyToTarget(snapshot: SelectionSnapshot, newText: string): boolean {
    if (snapshot.kind === 'input') {
      const el = snapshot.element;
      if (!el.isConnected) return false;
      el.setRangeText(newText, snapshot.selectionStart, snapshot.selectionEnd, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    // kind === 'range'
    const range = snapshot.range;
    const ce = snapshot.contentEditable;
    if (ce && ce.isConnected) {
      // Restore the selection to the captured range, then attempt
      // execCommand('insertText'). Restoring is required because the user
      // clicking the panel cleared the original selection.
      const sel = ce.ownerDocument.defaultView?.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
        const ok = ce.ownerDocument.execCommand('insertText', false, newText);
        if (ok) {
          // execCommand returned true; nothing else to do.
          return true;
        }
        // Fall through to Range mutation.
      }
    }
    // Read-only prose OR contentEditable fallback.
    try {
      range.deleteContents();
      const doc = range.startContainer.ownerDocument ?? document;
      const textNode = doc.createTextNode(newText);
      range.insertNode(textNode);
      return true;
    } catch {
      return false;
    }
  }
  ```

  Notes on each branch:
  - `setRangeText(... 'end')` places the caret at the end of the inserted
    text — matches what the user expects after an Apply.
  - The synthetic `input` event matches what frameworks (React, Vue)
    listen for to update controlled-component state. Without this, a
    React `<textarea>` would show the inserted text in the DOM but the
    component state would not update, and the next render could revert
    it. The event is `bubbles: true` so framework root listeners catch it.
  - `execCommand('insertText')` is deprecated but still implemented in
    every Chromium browser as of 2026 and is the only way to mutate
    contenteditable while preserving browser-native undo. If it returns
    `false`, we fall back to direct Range mutation.
  - `createTextNode` is the XSS guard: model output is never interpreted
    as HTML.

- Create `tests/dom-apply.test.ts`. At minimum:
  1. `<input>` apply: build an input with `value = 'hello world'`,
     snapshot start=0 end=5, call `applyToTarget(snap, 'goodbye')`,
     assert `input.value === 'goodbye world'`.
  1. `<input>` apply dispatches an `input` event. Assert via an event
     listener spy.
  1. `<textarea>` apply: same as above for a textarea.
  1. Input where `isConnected === false` (element removed from DOM)
     returns `false` and does not mutate.
  1. Range apply on read-only prose: build a `<p>foo bar baz</p>`,
     create a Range covering `'bar'`, snapshot it, apply `'BAR'`,
     assert `p.textContent === 'foo BAR baz'`.
  1. Range apply produces a `Text` node (not an element). Insert a
     `<script>` payload and assert the inserted node is `Node.TEXT_NODE`
     and `nodeValue === '<script>alert(1)</script>'`.
  1. Range apply on contenteditable: jsdom may not implement
     `execCommand('insertText')` faithfully. Stub
     `document.execCommand` to return `true` and assert it was called
     with `('insertText', false, '<new>')`. Then test the fallback path:
     stub `execCommand` to return `false`, assert the Range mutation
     branch took over.
  1. Range apply returns `false` and does not throw when
     `range.deleteContents()` throws (simulate via a frozen container or
     a non-Document range — use a try/catch in the test setup if needed).

**Verification Checklist:**

- [x] `src/dom-apply.ts` exports `applyToTarget`
- [x] `tests/dom-apply.test.ts` has >= 8 tests covering all branches
- [x] No `innerHTML` reference in `src/dom-apply.ts`
- [x] `npm run coverage` shows `src/dom-apply.ts` at >= 85% statements,
      >= 80% branches
- [x] `npm run lint:ci` exits 0

**Testing Instructions:**

- `npx vitest run tests/dom-apply.test.ts`
- Pay attention to the XSS test (point 6 above) — it is the security
  invariant of the entire apply layer.

**Commit Message Template:**

```text
feat(apply): add applyToTarget with three DOM branches

- <input>/<textarea>: setRangeText('end') + synthetic input event so
  framework-controlled components update
- contenteditable: execCommand('insertText') to keep native undo;
  falls back to Range mutation when execCommand returns false
- Read-only prose: deleteContents + insertNode(createTextNode) — never
  innerHTML
- Returns false when the target element is disconnected or the mutation
  fails; callers can surface this as a user-visible error
- XSS test verifies model output is always a Text node
```

---

### Task 3.3 — Preview Component

**Goal:** A self-contained UI module that builds the stacked Preview DOM
(original on top, streamed result on the bottom) and manages a
`pending → streaming → complete | aborted` state machine. The Preview is
owned by the chat panel container; the existing chat list is hidden while
the Preview is active.

**Files to Modify/Create:**

- `src/ui/preview.ts` (new)
- `tests/ui-preview.test.ts` (new)

**Prerequisites:** Task 3.2 complete (so the Preview can call into
`applyToTarget` for the Apply button, though the wiring happens in
Task 3.5).

**Implementation Steps:**

- Export the Preview surface:

  ```ts
  export type PreviewState = 'pending' | 'streaming' | 'complete' | 'aborted' | 'error';

  export interface PreviewHandle {
    /** Root element to be appended inside the panel. */
    root: HTMLElement;
    /** Replace the original-selection text shown on top. */
    setOriginal(text: string): void;
    /** Append a chunk to the streamed result; transitions state to 'streaming'. */
    appendChunk(chunk: string): void;
    /** Transition to 'complete'; enable Apply, disable streaming UI. */
    complete(): void;
    /** Transition to 'aborted'; disable Apply, show "Stopped." */
    abort(): void;
    /** Transition to 'error'; disable Apply, show the given error message. */
    error(message: string): void;
    /** Reset to 'pending'. Clears the streamed text. */
    reset(): void;
    /** Remove the Preview root from the DOM. */
    destroy(): void;
    /** Current streamed text (used by the Apply handler to feed applyToTarget). */
    getResultText(): string;
  }

  export interface PreviewCallbacks {
    onApply(): void;
    onDiscard(): void;
  }

  export function makePreview(
    callbacks: PreviewCallbacks,
    doc: Document = document,
  ): PreviewHandle;
  ```

- Build the DOM in `makePreview` using the project's `createElement` +
  inline-style pattern (consistent with `src/ui/messages.ts`). Layout:

  ```text
  ┌─────────────────────────────────────────────┐
  │ Original                                    │
  │ ┌─────────────────────────────────────────┐ │
  │ │ <scrollable, max-height ~120px>         │ │
  │ └─────────────────────────────────────────┘ │
  │ Result                                      │
  │ ┌─────────────────────────────────────────┐ │
  │ │ <scrollable, grows as stream arrives>   │ │
  │ └─────────────────────────────────────────┘ │
  │            [ Discard ]   [ Apply ]          │
  └─────────────────────────────────────────────┘
  ```

  Use `textContent` (never `innerHTML`) for both panes — the original is
  user content, the result is model output; both are untrusted.

- State machine rules:
  - On `makePreview`: state = `pending`. Apply disabled (greyed). Discard
    enabled. Result pane shows a typing indicator (reuse
    `makeTypingIndicator` from `src/ui/messages.ts`).
  - First `appendChunk`: state = `streaming`, indicator removed, result
    pane shows the chunk. Apply still disabled.
  - `complete`: state = `complete`. Apply enabled. Indicator removed if
    still present.
  - `abort`: state = `aborted`. Apply disabled. Result pane gains
    "\n\n[stopped]" suffix (matches chat behavior).
  - `error`: state = `error`. Apply disabled. Result pane replaced with
    the error message.
  - `reset`: back to `pending`. Clears result text.

- Apply button click → calls `callbacks.onApply()`. The callback is
  responsible for invoking `applyToTarget` and for tearing down the
  Preview (`destroy()`).
- Discard button click → calls `callbacks.onDiscard()`. The callback is
  responsible for aborting any in-flight transform stream and for tearing
  down the Preview.
- Pressing Escape while the Preview is mounted triggers the Discard
  callback. Wire via a `keydown` listener on the Preview root with
  `event.key === 'Escape'`.

- Style requirements (match the existing panel look):
  - Background `#222`, headers `#888`, panes `#1a1a1a`.
  - Apply button: green `#1f8a3a` when enabled, grey when disabled.
  - Discard button: matches the existing `BUSY_BG` red `#a32222` from
    `src/ui/state.ts`.
  - 8px gap between panes; 6px padding inside panes.
  - Inherit panel font (no font declaration).

- Create `tests/ui-preview.test.ts`. At minimum:
  1. `makePreview({ onApply, onDiscard })` returns a handle whose `root`
     is an `HTMLElement` not yet attached to the document.
  1. Initial state is `pending`; Apply button is `disabled`; result pane
     contains the typing indicator (find `.ln-dot` x3).
  1. `setOriginal('foo')` sets the original pane `textContent` to `'foo'`
     and does **not** parse HTML (test with `'<b>x</b>'`).
  1. First `appendChunk('hello')` removes the typing indicator, sets
     result text to `'hello'`, state is `streaming`, Apply still disabled.
  1. Subsequent `appendChunk('world')` appends; result is `'helloworld'`.
  1. `complete()` enables the Apply button and removes the typing
     indicator if still present.
  1. `abort()` disables Apply and result text ends with `'[stopped]'`.
  1. `error('boom')` disables Apply and result text is exactly `'boom'`
     (no `[stopped]` suffix).
  1. `reset()` clears the result and restores the typing indicator.
  1. Apply click invokes the callback exactly once.
  1. Discard click invokes the callback exactly once.
  1. Escape keydown on the root invokes the Discard callback exactly once.
  1. `getResultText()` returns the accumulated chunks (independent of any
     `[stopped]` suffix added by `abort`).
  1. `destroy()` removes the root from any parent.

**Verification Checklist:**

- [x] `src/ui/preview.ts` exports `PreviewState`, `PreviewHandle`,
      `PreviewCallbacks`, and `makePreview`
- [x] State transitions enforced (e.g. `complete` after `abort` is a
      no-op; document this in JSDoc and test for it)
- [x] No `innerHTML` reference
- [x] `tests/ui-preview.test.ts` has >= 14 tests
- [x] `npm run coverage` shows `src/ui/preview.ts` at >= 85% statements,
      >= 80% branches
- [x] `npm run lint:ci` exits 0

**Testing Instructions:**

- `npx vitest run tests/ui-preview.test.ts`

**Commit Message Template:**

```text
feat(preview): add stacked Preview component with Apply/Discard

- pending → streaming → complete | aborted | error state machine
- Apply enabled only on complete; Discard always enabled; Escape triggers
  Discard
- textContent only — model output and original text are never parsed as
  HTML
- Reuses makeTypingIndicator for the pending pane
- Callbacks (onApply, onDiscard) let the dispatch layer wire applyToTarget
  and AbortController without coupling Preview to those modules
```

---

### Task 3.4 — Extend the Session Surface

**Goal:** `src/dom-actions.ts` needs three small affordances from the chat
panel that `initSession` owns: ability to show the panel, ability to
prefill the input and trigger a send (used by `Summarize this page`), and
ability to swap the messages list for the Preview component (used by every
write-side action). Add a minimal surface to `initSession` rather than
exposing internals.

**Files to Modify/Create:**

- `src/session.ts` (modify)
- `tests/session.test.ts` (modify — extend existing tests for the new
  return shape; add tests for the new methods)

**Prerequisites:** Tasks 3.1 - 3.3 complete (Preview component is the
shape that `setPreviewSlot` will host).

**Implementation Steps:**

- Change `initSession` to return a handle:

  ```ts
  export interface SessionHandle {
    /** Show the panel (hidden by default) and focus the input. */
    openPanel(): void;
    /** Hide the panel. */
    closePanel(): void;
    /** Whether the panel is currently visible. */
    isPanelOpen(): boolean;
    /**
     * Prefill the input with `text` and trigger send synchronously.
     * Used by the Summarize-this-page action and the
     * ask_about_selection action.
     * If `autoSend === false`, only prefill — the user must press Enter.
     */
    prefillAndSend(text: string, autoSend: boolean): void;
    /**
     * Replace the messages list with the given Preview element. Returns
     * a teardown function that restores the messages list. Only one
     * Preview can be active at a time; calling this while another
     * Preview is mounted invokes the previous Preview's onDiscard via
     * the returned teardown function before mounting the new one.
     */
    mountPreview(previewRoot: HTMLElement): () => void;
  }

  export function initSession(deps: SessionDeps): SessionHandle;
  ```

- Inside `initSession`:
  - `openPanel`: extract the toggle-listener's show branch (set
    `root.style.display = 'flex'`, do the right-anchor conversion if
    needed, focus the input, kick off `ensureSession`).
  - `closePanel`: set `root.style.display = 'none'`.
  - `isPanelOpen`: `root.style.display !== 'none'`.
  - `prefillAndSend`: `input.value = text; if (autoSend) void send();`
    The current `send()` is closed over inside `initSession`; expose it
    via the handle by routing through `prefillAndSend`.
  - `mountPreview`: maintain a module-local `currentPreviewTeardown:
    (() => void) | null = null`. On mount, call the previous teardown
    (if any) — this should trigger the previous Preview's discard path
    via the callback chain Phase-3.5 sets up. Then hide
    `messages` (set `display: 'none'`) and append `previewRoot` to the
    panel between `header` and `inputWrap`. Return a teardown that
    removes `previewRoot` and shows `messages` again. The teardown
    clears `currentPreviewTeardown` only if it still equals itself
    (idempotent).

- The toggle listener inside `initSession` continues to handle the
  existing toggle hotkey — its show / hide logic is now duplicated by
  `openPanel` / `closePanel`. Refactor it to call them.

- Update `content.ts` to receive the handle (Task 3.6 wires it through).

- Update `tests/session.test.ts`:
  - The current assertions still pass because the toggle handler still
    works. Verify by running the full file unchanged first.
  - Add a `describe('initSession — handle surface')` block:
    - `initSession(deps).openPanel()` makes the root visible and calls
      `ensureSession`.
    - `closePanel()` hides the root; subsequent `openPanel()` shows it
      again.
    - `isPanelOpen()` reflects the current display state.
    - `prefillAndSend('hello', false)` sets `input.value = 'hello'`,
      does not call `promptStreaming`.
    - `prefillAndSend('hello', true)` sets `input.value`, calls
      `promptStreaming` once with prompt that includes the page context
      prefix (first turn behavior).
    - `mountPreview(el)` appends `el` to the panel and hides the
      messages list; returned teardown restores the messages list and
      removes `el`.
    - Calling `mountPreview` twice in sequence calls the previous
      teardown before mounting the new Preview.

**Verification Checklist:**

- [x] `initSession` returns a `SessionHandle`
- [x] All four handle methods implemented and exported
- [x] Existing `tests/session.test.ts` tests pass unchanged
- [x] New handle-surface tests added (>= 7 new tests)
- [x] `npm run coverage` shows `src/session.ts` at >= 85% statements,
      >= 80% branches (was 91% pre-change; should not drop materially)
- [x] `npm run typecheck` exits 0

**Testing Instructions:**

- `npx vitest run tests/session.test.ts`
- The handle is consumed by Task 3.5; verify the contract via the test
  suite before continuing.

**Commit Message Template:**

```text
feat(session): expose SessionHandle for dom-actions integration

- initSession now returns { openPanel, closePanel, isPanelOpen,
  prefillAndSend, mountPreview }
- Existing toggle behavior preserved; openPanel/closePanel share its
  internals
- mountPreview swaps the messages list for a Preview root and returns
  a teardown; calling it twice tears down the previous Preview first
- Tests cover all five handle methods plus the existing 24 session
  scenarios
```

---

### Task 3.5 — Action Dispatch (`initDomActions`)

**Goal:** Wire everything together. The content script imports
`initDomActions(deps)`, which installs the `contextmenu` and `keydown`
selection-snapshot listeners and the `chrome.runtime.onMessage` listener
that dispatches incoming `ActionMessage`s to the right handler.

**Files to Modify/Create:**

- `src/dom-actions.ts` (modify — add the dispatch logic)
- `tests/dom-actions.test.ts` (modify — add dispatch tests)

**Prerequisites:** Tasks 3.1 - 3.4 complete.

**Implementation Steps:**

- Add the dispatch surface to `src/dom-actions.ts`:

  ```ts
  import { ACTION_MESSAGE_KIND, type ActionMessage } from './background/handler.js';
  import { applyToTarget } from './dom-apply.js';
  import type { SessionHandle } from './session.js';
  import { runTransform } from './transform.js';
  import {
    actionToDescriptor,
    checkSelection,
    selectionChatPrefill,
  } from './transform-prompts.js';
  import { makePreview, type PreviewHandle } from './ui/preview.js';

  export interface DomActionsDeps {
    document: Document;
    session: SessionHandle;
    transformersConfig: unknown;
  }

  export function initDomActions(deps: DomActionsDeps): void {
    const { document, session, transformersConfig } = deps;

    // Module-local pending snapshot, captured at contextmenu/hotkey time.
    let pendingSnapshot: SelectionSnapshot | null = null;

    // Track the active Preview so a new action can replace it.
    let activePreview: PreviewHandle | null = null;
    let activeAbort: AbortController | null = null;
    let activePreviewTeardown: (() => void) | null = null;

    const captureToPending = () => {
      pendingSnapshot = captureSelection(document);
    };

    document.addEventListener('contextmenu', captureToPending, true);
    document.addEventListener('keydown', (e) => {
      // Snapshot eagerly on any modifier+key combo that matches our
      // hotkeys. Chrome delivers the command via chrome.commands so
      // we don't need to know the exact chord; this is just to ensure
      // the selection is captured before the panel takes focus.
      if (e.ctrlKey || e.metaKey) captureToPending();
    }, true);

    function tearDownPreview() {
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }
      if (activePreviewTeardown) {
        activePreviewTeardown();
        activePreviewTeardown = null;
      }
      activePreview = null;
    }

    async function runTransformAction(actionId: ActionId, snapshot: SelectionSnapshot) {
      const check = checkSelection(snapshot.text);
      session.openPanel();
      const preview = makePreview(
        {
          onApply: () => {
            const text = preview.getResultText();
            applyToTarget(snapshot, text);
            tearDownPreview();
          },
          onDiscard: () => {
            tearDownPreview();
          },
        },
        document,
      );
      preview.setOriginal(snapshot.text);
      activePreview = preview;
      const teardown = session.mountPreview(preview.root);
      activePreviewTeardown = () => {
        teardown();
        preview.destroy();
      };

      if (!check.ok) {
        preview.error(check.error ?? 'Selection unavailable.');
        return;
      }

      const abort = new AbortController();
      activeAbort = abort;
      try {
        const { stream } = await runTransform({
          action: actionId,
          sourceText: snapshot.text,
          signal: abort.signal,
          transformersConfig,
        });
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            preview.appendChunk(value);
          }
          preview.complete();
        } finally {
          reader.releaseLock();
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          preview.abort();
        } else {
          preview.error(err instanceof Error ? err.message : String(err));
        }
      } finally {
        activeAbort = null;
      }
    }

    function dispatchAction(actionId: ActionId) {
      const descriptor = actionToDescriptor(actionId);
      switch (descriptor.kind) {
        case 'chat': {
          // ask_about_selection
          const snap = pendingSnapshot;
          if (!snap || !checkSelection(snap.text).ok) {
            // No selection or too long. Open the panel for graceful
            // degradation; do not prefill.
            session.openPanel();
            return;
          }
          session.openPanel();
          session.prefillAndSend(selectionChatPrefill(snap.text), false);
          return;
        }
        case 'page-chat': {
          // summarize_page
          session.openPanel();
          session.prefillAndSend('Summarize this page.', true);
          return;
        }
        case 'transform-editable':
        case 'transform-readonly': {
          const snap = pendingSnapshot;
          if (!snap) {
            session.openPanel();
            return;
          }
          // For transform-editable, require an input or contenteditable
          // target. For transform-readonly, accept any range.
          if (descriptor.kind === 'transform-editable') {
            const isEditable =
              snap.kind === 'input' || (snap.kind === 'range' && snap.contentEditable !== null);
            if (!isEditable) {
              session.openPanel();
              return;
            }
          }
          // Tear down any previous preview before starting a new one
          tearDownPreview();
          void runTransformAction(actionId, snap);
          return;
        }
      }
    }

    chrome.runtime.onMessage.addListener((msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as Partial<ActionMessage>;
      if (m.a !== ACTION_MESSAGE_KIND) return;
      if (typeof m.id !== 'string') return;
      // Defensive: verify id is a known ActionId before dispatching.
      try {
        dispatchAction(m.id as ActionId);
      } catch (err) {
        console.error('[local-nano] dispatchAction failed:', err);
      }
    });
  }
  ```

  Important notes for the implementer:
  - The `contextmenu` listener uses capture phase (`true`) so it fires
    before any host-page handler can stop propagation. The `keydown`
    listener does the same.
  - Snapshot is overwritten on every event — the listener does not
    accumulate. This is intentional: the most recent selection is the
    one the user means.
  - The `ask_about_selection` flow uses `autoSend: false` because the
    user typically wants to add their question to the prefilled context.
  - The `transform-editable` guard rejects snapshots that don't have an
    editable target (because the menu entries are already scoped by
    `contexts: ['editable']`, this should rarely trigger; the guard
    protects against hotkey invocation with the wrong selection).

- Extend `tests/dom-actions.test.ts` with dispatch tests. Pattern: stub
  the `chrome.runtime.onMessage.addListener` capture (already mocked in
  `tests/setup.ts`), call `initDomActions(deps)`, then directly invoke
  the captured listener with a synthetic `ActionMessage` and assert the
  expected calls on a stub `SessionHandle` and stub `runTransform`
  (via `vi.mock('../src/transform.js', () => ({ runTransform: vi.fn() }))`).

  Required tests (at least 15):
  1. `initDomActions` registers a `chrome.runtime.onMessage` listener.
  1. Dispatching `{ a: 'action', id: 'ask_about_selection' }` with no
     pending snapshot calls `session.openPanel()` and not
     `prefillAndSend`.
  1. Dispatching `ask_about_selection` with a Range snapshot of text
     `'hello'` calls `session.prefillAndSend('Selection: "hello"\n\nAsk: ', false)`.
  1. Dispatching `summarize_page` calls
     `prefillAndSend('Summarize this page.', true)` regardless of
     snapshot presence.
  1. Dispatching `rewrite_improve` with no pending snapshot calls
     `openPanel()` and does not call `runTransform`.
  1. Dispatching `rewrite_improve` with a contenteditable Range snapshot
     calls `runTransform` with `{ action: 'rewrite_improve', sourceText: <text>, signal: <AbortSignal> }`.
  1. Dispatching `rewrite_improve` with a plain (non-editable) Range
     snapshot calls `openPanel` and does *not* call `runTransform`.
  1. Dispatching `translate_en` with a plain Range snapshot calls
     `runTransform` (transform-readonly accepts any range).
  1. While a transform is streaming, dispatching another transform
     aborts the first (`activeAbort.abort()` was called) and starts the
     new one (a second `runTransform` call).
  1. The Preview's `onApply` callback invokes `applyToTarget(snapshot, resultText)`.
     Verify by spying on `applyToTarget` (import the real one, stub via
     `vi.spyOn`).
  1. The Preview's `onDiscard` callback aborts the in-flight transform
     and tears down the preview (session.mountPreview's teardown was
     invoked).
  1. A `runTransform` call that throws a non-AbortError causes
     `preview.error()` to be called with the error message.
  1. A `runTransform` call whose stream throws AbortError causes
     `preview.abort()` to be called.
  1. Messages with `a !== 'action'` are ignored (no `openPanel` call).
  1. Messages with `id` of unknown ActionId throw inside `dispatchAction`
     but the throw is caught and logged (no crash; verify console.error
     was called).

**Verification Checklist:**

- [x] `src/dom-actions.ts` exports `initDomActions`
- [x] `tests/dom-actions.test.ts` has >= 22 tests total (7 capture + 15
      dispatch)
- [x] Concurrent-transform abort path verified by a test
- [x] `npm run coverage` shows `src/dom-actions.ts` at >= 80% statements,
      >= 75% branches
- [x] `npm run typecheck` exits 0
- [x] `npm run lint:ci` exits 0

**Testing Instructions:**

- `npx vitest run tests/dom-actions.test.ts`
- The dispatch tests are the most intricate in this phase — spend extra
  time on the concurrent-transform abort scenario.

**Commit Message Template:**

```text
feat(dom-actions): wire selection capture and action dispatch

- contextmenu and modifier-keydown capture snapshot into pendingSnapshot
  before the panel steals focus
- chrome.runtime.onMessage dispatches ActionMessage by descriptor kind:
  chat → prefill input, page-chat → prefill+send, transform-* → spin up
  Preview and runTransform
- transform-editable requires an editable target; otherwise opens the
  panel as graceful degradation
- Concurrent transforms abort the in-flight one before starting the new
- Apply invokes applyToTarget; Discard aborts and tears down
- AbortError shows [stopped] via preview.abort; other errors show
  preview.error(message)
```

---

### Task 3.6 — `content.ts` Integration and Manual Smoke Test

**Goal:** The last wiring step. `content.ts` calls `initDomActions(deps)`
after `initSession(deps)`, passing the session handle through. Then run
the manual smoke test on a real Chrome install.

**Files to Modify/Create:**

- `content.ts` (modify)

**Prerequisites:** Tasks 3.1 - 3.5 complete.

**Implementation Steps:**

- Update `content.ts`:

  ```ts
  import { initDomActions } from './src/dom-actions.js';
  import { initSession } from './src/session.js';

  // ... existing DOM construction unchanged ...

  const session = initSession({
    root,
    messages,
    input,
    actionBtn,
    transformersConfig,
    location,
    document,
  });

  initDomActions({
    document,
    session,
    transformersConfig,
  });
  ```

- Run the manual smoke test on Chrome:
  1. `npm run build`
  1. Reload the unpacked extension at `chrome://extensions`.
  1. Open a content-rich page (e.g., a Wikipedia article).
  1. Press `Ctrl+Shift+K` — confirm the panel opens (existing behavior).
  1. Right-click on the page (no selection) — confirm
     `Summarize this page` appears. Click it. Confirm the input
     prefills `Summarize this page.` and a summary streams in the chat.
  1. Select a paragraph; right-click; confirm
     `Ask local-nano about this` appears under the selection. Click it.
     Confirm the input prefills with the selection text wrapped in
     `Selection: "..."\n\nAsk: ` and the panel opens with the cursor
     after `Ask: `.
  1. Select more text; right-click; confirm
     `Translate / Simplify / Summarize in place ▸` submenu shows three
     translate options + Simplify + Summarize. Click
     `Translate to Spanish`. Confirm the Preview component appears with
     the original on top and a streaming Spanish translation below.
     Click Apply. Confirm the selection on the page is replaced with the
     Spanish text.
  1. Open a Google Docs / Notion-like editable surface (or just a plain
     `<textarea>` test page). Select some text. Right-click. Confirm
     `Rewrite ▸ Improve writing` and other rewrite options appear. Click
     `Make shorter`. Confirm the Preview component shows the rewrite
     streaming. Click Apply. Confirm the textarea content updates and
     `Ctrl+Z` can undo the change (native undo).
  1. Trigger two transforms in rapid succession (right-click → Translate
     → quickly right-click → Translate again before the first finishes).
     Confirm the first stream is cancelled and the second starts.
  1. Trigger a transform; click Discard before completion. Confirm the
     stream is cancelled, the Preview disappears, and the page DOM is
     unchanged.
  1. Press `Ctrl+Shift+L` (the `ask_about_selection` hotkey) with a
     selection — confirm same behavior as the menu entry. Without a
     selection, confirm the panel just opens (graceful degradation).
  1. Press `Ctrl+Shift+I` (`rewrite_selection`) in an editable field
     with a selection — confirm same behavior as
     `Rewrite ▸ Improve writing` from the menu.
  1. Press `Ctrl+Shift+U` (`translate_selection`) on any selection —
     confirm same behavior as `Translate to English` from the menu.
  1. Verify no errors in the service-worker console.
  1. Verify no errors in the page DevTools console.

- If any smoke step fails, file the failure as feedback in
  `feedback.md` and address before declaring Phase-3 complete.

**Verification Checklist:**

- [x] `content.ts` calls `initDomActions(deps)` after `initSession(deps)`
- [ ] All 14 manual smoke steps above pass (deferred — requires a human
      at a real Chrome install; documented in the phase verification
      report; carried into Phase-4 Task 4.x smoke checklist)
- [x] `npm run build` exits 0
- [x] `npm run lint:ci && npm run typecheck && npm run coverage` exits 0

**Testing Instructions:**

- No new automated tests in this task — the unit tests live in Tasks 3.1
  - 3.5. The manual smoke test is the integration check.

**Commit Message Template:**

```text
feat(content): wire initDomActions into the content script

- content.ts now calls initDomActions after initSession, passing the
  SessionHandle and transformersConfig through
- No other changes to content.ts (panel DOM construction and drag/close
  logic unchanged)
- Manual smoke pass: chat, ask, summarize-page, all four rewrites, all
  three translations, simplify-in-place, summarize-in-place, hotkeys
```

---

## Phase Verification

Run the full automated gate:

```bash
npm run lint:ci && npm run typecheck && npm run coverage && npm run build
```

All four must exit 0. Additionally:

- Test counts:
  - `tests/dom-actions.test.ts` >= 19 tests
  - `tests/dom-apply.test.ts` >= 8 tests
  - `tests/ui-preview.test.ts` >= 14 tests
  - `tests/session.test.ts` >= 31 tests (24 existing + 7 new for the
    handle surface)
  - All prior test files unchanged

- Coverage targets (per file, on `src/**/*.ts`):
  - `src/dom-actions.ts` >= 80% statements, >= 75% branches
  - `src/dom-apply.ts` >= 85% statements, >= 80% branches
  - `src/ui/preview.ts` >= 85% statements, >= 80% branches
  - `src/session.ts` >= 85% statements (was 91%; should not drop by
    more than 10%)
  - Overall thresholds (75% / 80%) still met

- Manual smoke test from Task 3.6 fully completed.

- No `innerHTML` anywhere in `src/**/*.ts` (`grep -r innerHTML src/`
  returns empty).

- No `console.log` in production code paths (the existing stream-timing
  logs in `src/session.ts` are acceptable; new code should not add more).

## Known Limitations Entering Phase-4

- Documentation does not yet describe v0.2.
- `manifest.json` and `package.json` are still on version `0.1.1`.
- `CHANGELOG.md` has no `[0.2.0]` section.
- `docs/privacy.md` does not mention selection text yet.

Phase-4 closes all of these.
