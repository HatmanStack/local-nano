# Phase 1 — Transform Module and Action Schema

## Phase Goal

Build the data-plane for write-side actions: the canonical action schema,
the action→prompt mapping, and the `runTransform` function that creates
ephemeral `LanguageModel` sessions and returns a chunk stream. None of this
code touches the DOM or the chat panel — it is pure, testable plumbing that
Phase-3 wires into the content script.

After this phase the test suite can drive `runTransform` end-to-end with
mocked polyfill modules. No user-visible behavior changes yet (no manifest
changes, no menu entries, no content-script wiring).

**Success criteria:**

- `src/transform-prompts.ts` exports the `ActionId` type, `ACTION_DESCRIPTORS`
  table, and an `actionToPrompt(actionId)` helper.
- `src/transform.ts` exports `runTransform({ action, sourceText, signal })`
  returning a `ReadableStream<string>`.
- `src/session.ts` exposes the shared `loadHeavy()` cache to sibling modules
  (extraction strategy below) without breaking any existing test.
- `SELECTION_LIMIT` is exported as a named constant.
- `tests/transform-prompts.test.ts` and `tests/transform.test.ts` together
  cover all `ActionId` values and the four `runTransform` scenarios listed
  in the task table.
- `npm run lint:ci`, `npm run typecheck`, `npm run coverage`, and
  `npm run build` all exit 0.

**Estimated tokens:** ~28k

## Prerequisites

- Phase-0 read in full.
- Pre-implementation smoke test (Phase-0) passing.

## Tasks

### Task 1.1 — Extract `loadHeavy` into a Shared Module-Level Cache

**Goal:** The lazy heavy-module loader currently lives inside the
`initSession` closure (`src/session.ts`). The new `runTransform` path must
share that cache so the user pays the multi-MB Transformers.js init exactly
once per page lifetime. Extract `loadHeavy` into a sibling module that both
`session.ts` and `transform.ts` can import.

**Files to Modify/Create:**

- `src/heavy.ts` (new) — exports `loadHeavy(transformersConfig)` and the
  `LanguageModelSession` interface (moved from `src/session.ts`).
- `src/session.ts` (modify) — import `loadHeavy` from `./heavy.js`; delete
  the local copy; re-export `LanguageModelSession` for callers that still
  import it from `./session.js`.

**Prerequisites:** none

**Implementation Steps:**

- Create `src/heavy.ts`. Move the `LanguageModelSession` interface from
  `src/session.ts` into it (Phase-3 will import it from `src/heavy.js`,
  too).
- Move the `OnnxWasmEnv` type and the `loadHeavy` function body into
  `src/heavy.ts`. Make `loadHeavy` accept the transformers config as a
  parameter (it currently closes over `transformersConfig` from
  `initSession`'s `deps`). Signature:

  ```ts
  export interface LoadedHeavy {
    LanguageModel: { create: (opts: unknown) => Promise<LanguageModelSession> };
  }

  export function loadHeavy(transformersConfig: unknown): Promise<LoadedHeavy>;
  ```

- The memoization is module-level: a top-level `let heavyLoadPromise: Promise<LoadedHeavy> | null = null;`
  inside `src/heavy.ts`. The first call kicks off the dynamic imports and
  caches the promise. Subsequent calls return the cached promise.
- Mirror the existing `heavyLoadPromise = null` reset on failure
  (the catch block clears the cache so the next call retries).
- Export a `resetHeavyCache()` test helper (only for tests; document the
  reason in a JSDoc).
- Update `src/session.ts`:
  - Replace the local `loadHeavy` function with `import { loadHeavy, type LanguageModelSession } from './heavy.js';`
  - In `ensureSession`, call `loadHeavy(transformersConfig)` instead of
    closing over the deps.
  - Re-export `LanguageModelSession` (for any external importer):
    `export type { LanguageModelSession } from './heavy.js';`
- Confirm `tests/session.test.ts` still passes without modification (the
  `vi.mock(...)` calls for `@huggingface/transformers` and the polyfill
  must still take effect — they do, because the mocks are matched by the
  resolved module path inside the dynamic `import()` calls regardless of
  which file invokes them). If anything in `tests/session.test.ts` breaks,
  update it minimally (e.g. clear the heavy cache between tests by calling
  `resetHeavyCache()` in `beforeEach`).

**Verification Checklist:**

- [x] `src/heavy.ts` exists with `loadHeavy(transformersConfig)` and
      `LanguageModelSession` exports
- [x] `src/session.ts` imports `loadHeavy` from `./heavy.js`; no local
      heavy-module code remains
- [x] `npm run typecheck` exits 0
- [x] All existing `tests/session.test.ts` tests still pass
- [x] `npm run coverage` exits 0 with thresholds met

**Testing Instructions:**

- Existing `tests/session.test.ts` is the regression suite for this task.
  Do not add new tests yet — Task 1.3 covers `transform.ts` and a
  side-effect test of `loadHeavy` reuse.
- Run `npx vitest run tests/session.test.ts` to confirm zero regressions.

**Commit Message Template:**

```text
refactor(session): extract loadHeavy into shared src/heavy.ts

- Move the heavy module loader and LanguageModelSession interface out of
  initSession's closure into a module-level cache
- Adds resetHeavyCache() test helper for test isolation
- No behavior change; session.ts continues to call loadHeavy with the same
  transformersConfig it received via deps
```

---

### Task 1.2 — Define the Action Schema and Prompt Mapping

**Goal:** Create the single source of truth for v0.2 actions: the `ActionId`
union, the `ACTION_DESCRIPTORS` table, and the `actionToPrompt` helper. The
background module (Phase-2) will iterate the descriptors to register the
context menu; `runTransform` (Task 1.3) will look up the system prompt;
Phase-3 will use the `kind` field to decide whether to enter Preview mode
or chat mode.

**Files to Modify/Create:**

- `src/transform-prompts.ts` (new)
- `tests/transform-prompts.test.ts` (new)

**Prerequisites:** Task 1.1 complete (not strictly required for this task
but kept linear).

**Implementation Steps:**

- Create `src/transform-prompts.ts` with the schema from Phase-0:

  ```ts
  export const SELECTION_LIMIT = 1500;

  export type ActionId =
    | 'ask_about_selection'
    | 'summarize_page'
    | 'rewrite_improve'
    | 'rewrite_shorter'
    | 'rewrite_formal'
    | 'rewrite_grammar'
    | 'translate_en'
    | 'translate_es'
    | 'translate_fr'
    | 'simplify_in_place'
    | 'summarize_in_place';

  export type ActionKind =
    | 'chat'
    | 'page-chat'
    | 'transform-editable'
    | 'transform-readonly';

  export interface ActionDescriptor {
    id: ActionId;
    kind: ActionKind;
    label: string;
    parentLabel?: string; // literal submenu title string; omitted = top-level
    systemPrompt: string | null;
  }
  ```

- Use **exactly** the following `id → label → parentLabel → kind` mapping
  when building `ACTION_DESCRIPTORS`. These label strings are the single
  source of truth for the menu UI, the Phase-3 manual smoke test, and the
  `docs/dom-actions.md` table in Phase-4. Do not paraphrase them.

  ```text
  | id                  | label                       | parentLabel                                  | kind                |
  | ------------------- | --------------------------- | -------------------------------------------- | ------------------- |
  | ask_about_selection | Ask local-nano about this   | (none — top-level)                           | chat                |
  | summarize_page      | Summarize this page         | (none — top-level)                           | page-chat           |
  | rewrite_improve     | Improve writing             | Rewrite                                      | transform-editable  |
  | rewrite_shorter     | Make shorter                | Rewrite                                      | transform-editable  |
  | rewrite_formal      | Make formal                 | Rewrite                                      | transform-editable  |
  | rewrite_grammar     | Fix grammar                 | Rewrite                                      | transform-editable  |
  | translate_en        | To English                  | Translate / Simplify / Summarize in place    | transform-readonly  |
  | translate_es        | To Spanish                  | Translate / Simplify / Summarize in place    | transform-readonly  |
  | translate_fr        | To French                   | Translate / Simplify / Summarize in place    | transform-readonly  |
  | simplify_in_place   | Simplify                    | Translate / Simplify / Summarize in place    | transform-readonly  |
  | summarize_in_place  | Summarize                   | Translate / Simplify / Summarize in place    | transform-readonly  |
  ```

  These labels are also referenced from Phase-0's `ActionDescriptor`
  section (as the canonical source) and reproduced in the
  `docs/dom-actions.md` menu table emitted by Phase-4 Task 4.1.

- Author the system prompts so they emit *only* the rewritten/translated
  text — no preamble, no explanation, no quoting. Examples (use these
  verbatim or refine; refinements are fine but they must remain strict
  output-only prompts):

  ```text
  rewrite_improve:
  You are a writing assistant. Rewrite the user's text to improve clarity,
  flow, and word choice while preserving meaning, tone, and approximate
  length. Output ONLY the rewritten text. Do not include any preamble,
  commentary, quotation marks, or labels.

  rewrite_shorter:
  You are a writing assistant. Rewrite the user's text to be shorter while
  preserving its meaning and core message. Output ONLY the shortened text.
  Do not include any preamble, commentary, quotation marks, or labels.

  rewrite_formal:
  You are a writing assistant. Rewrite the user's text in a more formal,
  professional register while preserving its meaning. Output ONLY the
  rewritten text. Do not include any preamble, commentary, quotation marks,
  or labels.

  rewrite_grammar:
  You are a proofreader. Fix grammar, spelling, and punctuation errors in
  the user's text while preserving meaning, tone, and style. If the text is
  already correct, return it unchanged. Output ONLY the corrected text. Do
  not include any preamble, commentary, quotation marks, labels, or list of
  changes.

  translate_en:
  You are a translator. Translate the user's text into English. If the text
  is already in English, return it unchanged. Output ONLY the translation.
  Do not include any preamble, commentary, quotation marks, labels, or
  source-language text.

  translate_es:
  (same shape, target Spanish)

  translate_fr:
  (same shape, target French)

  simplify_in_place:
  You are a writing assistant. Rewrite the user's text in simpler language
  suitable for a general audience. Preserve the meaning. Output ONLY the
  simplified text. Do not include any preamble, commentary, quotation
  marks, or labels.

  summarize_in_place:
  You are a writing assistant. Summarize the user's text in 1-3 sentences,
  preserving the core meaning. Output ONLY the summary. Do not include any
  preamble, commentary, quotation marks, labels, or bullet lists.

  ask_about_selection:
  (systemPrompt is null — handled by chat path)

  summarize_page:
  (systemPrompt is null — handled by page-chat path)
  ```

- Define `ACTION_DESCRIPTORS: ActionDescriptor[]` as a frozen array (use
  `as const` or `Object.freeze` so the table is treated as immutable). The
  entries must use the `id`, `label`, `parentLabel`, and `kind` values from
  the table above; `systemPrompt` is the matching system-prompt string
  defined below (or `null` for `ask_about_selection` and `summarize_page`).
- Export `actionToPrompt(actionId: ActionId): string`. Throws
  `Error(\`Unknown action: ${actionId}\`)` when called with a value whose
  descriptor has `systemPrompt: null`, or when no descriptor matches.
- Export `actionToDescriptor(actionId: ActionId): ActionDescriptor`.
  Throws on unknown id.

- Create `tests/transform-prompts.test.ts` with at least:
  - Every `ActionId` in the union is present in `ACTION_DESCRIPTORS` (use
    a literal list of expected ids and assert set equality).
  - `actionToPrompt` returns a non-empty string for every transform-* id.
  - `actionToPrompt` throws for `ask_about_selection` and
    `summarize_page` (their prompts are null).
  - System prompts do not contain Markdown formatting hints (no `**`,
    no leading `# `) — defensive against the model echoing the system
    prompt.
  - Every transform prompt contains "Output ONLY" or equivalent
    phrasing (defensive regex check).
  - `actionToDescriptor` returns a descriptor with the right `kind` per
    id family.
  - Every `id` in `ACTION_DESCRIPTORS` has the exact `label` and
    `parentLabel` from the table above (use a literal expected object
    keyed by id and assert deep equality on the relevant fields). This is
    the regression guard that the menu UI, smoke test, and docs all stay
    consistent.

**Verification Checklist:**

- [x] `src/transform-prompts.ts` exists with all 11 `ActionId` values
- [x] All transform prompts emit text-only (verified by unit test)
- [x] `actionToPrompt` and `actionToDescriptor` behave per the table
- [x] `tests/transform-prompts.test.ts` has at least 7 tests, all passing
      (the schema sweep plus the new label/parentLabel regression test)
- [x] `npm run lint:ci` exits 0
- [x] `npm run typecheck` exits 0

**Testing Instructions:**

- `npx vitest run tests/transform-prompts.test.ts` — confirm all green.
- `npm run coverage` — confirm the new file is at >= 90% statements.

**Commit Message Template:**

```text
feat(prompts): add action schema and system prompts for v0.2 transforms

- ActionId union: ask_about_selection, summarize_page, four rewrite_*,
  three translate_*, simplify_in_place, summarize_in_place
- ACTION_DESCRIPTORS table is the single source of truth for menu
  registration and prompt lookup
- System prompts enforce text-only output (no preamble or labels)
- SELECTION_LIMIT exported alongside (1500 chars, matches pageContext cap)
```

---

### Task 1.3 — Implement `runTransform`

**Goal:** Provide the function that, given an action id and selection text,
creates a fresh ephemeral `LanguageModel` session with the action-specific
system prompt and returns a chunk stream. This is what the Preview UI
consumes in Phase-3.

**Files to Modify/Create:**

- `src/transform.ts` (new)
- `tests/transform.test.ts` (new)

**Prerequisites:** Task 1.1 and Task 1.2 complete.

**Implementation Steps:**

- Export the following signature:

  ```ts
  import type { LanguageModelSession } from './heavy.js';
  import type { ActionId } from './transform-prompts.js';

  export interface RunTransformArgs {
    action: ActionId;
    sourceText: string;
    signal?: AbortSignal;
    transformersConfig: unknown;
  }

  export interface RunTransformResult {
    stream: ReadableStream<string>;
    /** Resolves when the underlying ephemeral session is destroyed. */
    done: Promise<void>;
  }

  export function runTransform(args: RunTransformArgs): Promise<RunTransformResult>;
  ```

- Behavior:
  - Validate inputs: throw `Error('Selection text required')` if
    `sourceText.trim()` is empty. Throw `Error('Selection too long')` if
    `sourceText.length > SELECTION_LIMIT`. Use the `SELECTION_LIMIT`
    constant from `./transform-prompts.js`. (Callers can also pre-check;
    the function is defense-in-depth.)
  - Look up the system prompt via `actionToPrompt(action)`. If
    `actionToPrompt` throws (action id is a chat or page-chat kind), let
    the throw propagate — it indicates a programming error in the caller.
  - Call `loadHeavy(transformersConfig)` to get `{ LanguageModel }`. Reuse
    the cached promise from `src/heavy.ts`.
  - Create a fresh ephemeral session:

    ```ts
    const session = await LanguageModel.create({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
      initialPrompts: [{ role: 'system', content: systemPrompt }],
    });
    ```

  - Call `session.promptStreaming(sourceText, { signal })`. Return its
    `ReadableStream<string>` as `result.stream`.
  - Build `result.done`: a promise that resolves when the stream closes
    or rejects with the stream's error. After the stream settles (either
    finishes or errors or is aborted), call `session.destroy()` in a
    `finally` block to free model context. Implementation pattern:

    ```ts
    const stream = session.promptStreaming(sourceText, { signal });
    const [a, b] = stream.tee();
    const done = (async () => {
      try {
        const reader = b.getReader();
        try {
          while (!(await reader.read()).done) {
            // drain — caller consumes 'a'
          }
        } finally {
          reader.releaseLock();
        }
      } finally {
        session.destroy();
      }
    })();
    return { stream: a, done };
    ```

    Note: `.tee()` creates two independent readers; the consumer reads
    `a`, the `done` tracker drains `b` and disposes the session. This is
    necessary because we cannot call `session.destroy()` from inside the
    consumer's read loop without coupling the two concerns.

  - Surface AbortError: if the consumer aborts via `signal`, the
    `promptStreaming` will reject the read loop. The internal drain
    handles AbortError by treating it as a normal end-of-stream and still
    calls `session.destroy()`. The consumer sees the AbortError on its
    own reader.

- Add JSDoc to the function explaining the lifecycle (caller is
  responsible for awaiting `done` to know when the session is freed; for
  most call sites this is fire-and-forget).

- Create `tests/transform.test.ts`. Mirror the mocking pattern from
  `tests/session.test.ts`:

  ```ts
  vi.mock('@huggingface/transformers', () => ({ env: { backends: { onnx: { wasm: { wasmPaths: '', numThreads: 0 } } } } }));
  vi.mock('../vendor/prompt-api-polyfill/prompt-api-polyfill.js', () => ({ LanguageModel: { create: vi.fn() } }));
  ```

  Plus import `resetHeavyCache` from `src/heavy.js` and call it in
  `beforeEach` so each test starts with a fresh module cache.

  Required tests (at least 8):
  1. Returns a stream that yields the same chunks the underlying
     `promptStreaming` produces.
  1. Calls `LanguageModel.create` with `initialPrompts: [{ role: 'system', content: <expected prompt> }]`
     for `rewrite_improve` (assert the system prompt matches
     `actionToPrompt('rewrite_improve')`).
  1. Throws `Error('Selection text required')` for empty `sourceText`.
  1. Throws `Error('Selection too long')` for `sourceText.length === SELECTION_LIMIT + 1`.
  1. Throws (propagates) when called with `action: 'ask_about_selection'`
     (`actionToPrompt` throws for chat kinds).
  1. Calls `session.destroy()` after the stream completes naturally.
  1. Calls `session.destroy()` after the stream errors.
  1. Calls `session.destroy()` after the signal is aborted mid-stream.
  1. The second call to `runTransform` reuses the cached `loadHeavy`
     result instead of re-loading the heavy modules. Assert this by
     calling `loadHeavy(...)` directly from the test twice and verifying
     both calls return the same object reference (`expect(a).toBe(b)`).
     `LanguageModel.create` is still called once per `runTransform`
     invocation (one fresh ephemeral session per call) — only the
     `loadHeavy` promise is memoized.

**Verification Checklist:**

- [x] `src/transform.ts` exists and exports `runTransform`
- [x] Returns `{ stream, done }`; `done` resolves after `session.destroy()`
- [x] `tests/transform.test.ts` has >= 8 tests, all passing
- [x] `session.destroy()` is called in all three terminal cases (complete,
      error, abort)
- [x] `npm run coverage` shows `src/transform.ts` at >= 85% statements,
      >= 80% branches
- [x] `npm run lint:ci` and `npm run typecheck` exit 0

**Testing Instructions:**

- `npx vitest run tests/transform.test.ts`
- Pay close attention to the abort-mid-stream test: it must verify that
  `session.destroy()` is still called even when the stream rejects with
  AbortError. The `.tee()` drain side must handle the abort gracefully.

**Commit Message Template:**

```text
feat(transform): add runTransform for ephemeral per-action sessions

- Creates a fresh LanguageModel session per call with the action's system
  prompt; reuses the shared loadHeavy cache so heavy modules initialize
  once per page lifetime
- Returns { stream, done }; done settles after session.destroy() runs so
  callers can await session cleanup
- Validates inputs against SELECTION_LIMIT (1500 chars); empty or
  oversized inputs throw before any model work
- Covered by tests/transform.test.ts (stream pipe-through, system-prompt
  passing, destroy on complete/error/abort, heavy-cache reuse)
```

---

### Task 1.4 — Add Selection-Length Pre-Check Helper

**Goal:** A pure helper that callers (the Preview UI in Phase-3, the chat
context packager) can use to surface "selection too long" errors *before*
dispatching the transform. Lives alongside the schema so the limit and the
check ride together.

**Files to Modify/Create:**

- `src/transform-prompts.ts` (modify — add helpers)
- `tests/transform-prompts.test.ts` (modify — add helper tests)

**Prerequisites:** Task 1.2 complete.

**Implementation Steps:**

- Add to `src/transform-prompts.ts`:

  ```ts
  export interface SelectionCheck {
    ok: boolean;
    /** Error message suitable for surfacing to the user. */
    error?: string;
  }

  export function checkSelection(text: string): SelectionCheck {
    const trimmed = text.trim();
    if (trimmed.length === 0) return { ok: false, error: 'No selection.' };
    if (text.length > SELECTION_LIMIT) {
      return {
        ok: false,
        error: `Selection too long. Maximum ${SELECTION_LIMIT} characters.`,
      };
    }
    return { ok: true };
  }

  /**
   * Build the chat-context wrapper text used by ask_about_selection.
   * Returns the exact string prefilled into the chat input.
   */
  export function selectionChatPrefill(text: string): string {
    return `Selection: "${text}"\n\nAsk: `;
  }
  ```

- Extend `tests/transform-prompts.test.ts` with:
  - `checkSelection('')` returns `{ ok: false, error: 'No selection.' }`.
  - `checkSelection('   ')` returns `{ ok: false, ... }`.
  - `checkSelection('hello')` returns `{ ok: true }`.
  - `checkSelection('x'.repeat(SELECTION_LIMIT))` returns `{ ok: true }`.
  - `checkSelection('x'.repeat(SELECTION_LIMIT + 1))` returns
    `{ ok: false, error: <contains 1500> }`.
  - `selectionChatPrefill('foo')` returns `'Selection: "foo"\n\nAsk: '`.
  - `selectionChatPrefill` does not escape quotes — that is acceptable
    because the input is passed to the model, not rendered as HTML.

**Verification Checklist:**

- [x] `checkSelection` and `selectionChatPrefill` exported
- [x] Test count on `tests/transform-prompts.test.ts` increases by at
      least 5
- [x] `npm run coverage` exits 0

**Testing Instructions:**

- `npx vitest run tests/transform-prompts.test.ts`

**Commit Message Template:**

```text
feat(prompts): add checkSelection and selectionChatPrefill helpers

- checkSelection: pure pre-flight against SELECTION_LIMIT; returns an
  ok flag plus user-facing error message
- selectionChatPrefill: formats the chat-input prefill for the
  ask_about_selection action
- Tests cover empty, whitespace-only, exactly-1500, over-1500 cases
```

---

## Phase Verification

Run the full quality gate from the repo root:

```bash
npm run lint:ci && npm run typecheck && npm run coverage && npm run build
```

All four must exit 0. Additionally:

- `tests/transform-prompts.test.ts` has >= 12 tests (7 schema + 5 helper).
- `tests/transform.test.ts` has >= 8 tests.
- The existing `tests/session.test.ts` (24 tests) still passes with zero
  modifications beyond the optional `resetHeavyCache()` call in
  `beforeEach`.
- `npm run coverage` shows `src/transform.ts`, `src/transform-prompts.ts`,
  and `src/heavy.ts` at >= 85% statements and >= 80% branches each.
- No `console.log` in production code.
- No unused exports from `src/transform.ts` or `src/transform-prompts.ts`
  (everything is consumed by Phase-2 or Phase-3, but verify by grep).
- `src/heavy.ts` does not import from `src/session.ts` or `src/ui/*`
  (clean dependency direction).

## Known Limitations Entering Phase-2

- `runTransform` exists and is tested, but no caller invokes it yet. No
  user-visible behavior change.
- Manifest still declares 1 command. The context menu does not exist yet.
- The chat session still owns the only DOM panel state.

These are addressed in Phase-2 (background wiring) and Phase-3 (content
script + UI).
