# Phase 0 — Architecture Decisions, Conventions, and Strategy

This phase is read-only. Every implementer should internalize it before
opening Phase-1. It captures the project conventions inherited from the
existing v0.1.x tree, the architectural decisions for the v0.2 DOM-aware
work, the testing strategy, and the commit format.

## Project Conventions

### Package Manager and Runtime

- **Package manager:** npm (lockfile: `package-lock.json`). Do **not** use
  yarn or pnpm.
- **Node version:** 20 (pinned via `.nvmrc`). CI uses `actions/setup-node@v4`
  with `node-version: 20`.
- **TypeScript:** 5.6+, `"strict": true`, `"target": "ES2022"`,
  `"module": "ESNext"`, `"moduleResolution": "bundler"`.
- **Chrome target:** 120+ (`esbuild target: 'chrome120'`).
- **Extension type:** Chrome MV3 content script + background service worker.

### Key Scripts

```bash
npm run build      # esbuild one-shot bundle + ORT wasm copy into dist/
npm run watch      # esbuild watch mode
npm run typecheck  # tsc --noEmit over *.ts and src/**/*.ts and tests/**/*.ts
npm test           # vitest run (unit tests)
npm run test:watch # vitest watch
npm run coverage   # vitest run --coverage (thresholds enforced)
npm run lint       # biome check --write . (auto-fix)
npm run lint:ci    # biome check . (no-write, CI gate)
```

All new files must pass `npm run lint:ci`. Do not commit code that fails
Biome 2.4.15 with the project config.

### Architecture Overview (post v0.2)

```text
                    chrome.contextMenus.onClicked            chrome.tabs.sendMessage
background.ts ───────────────────────────────────────────────────────────────▶ content.ts
   │                                                                                │
   │  chrome.commands.onCommand                                                     │
   ├──────────────────────────────────────────────────────────────────────────▶ content.ts
   │                                                                                │
   ├─ src/background/handler.ts (toggle + new action commands)                      │
   ├─ src/background/menus.ts (NEW: context-menu registration + click router)       │
   │                                                                                │
   │                                                                                ▼
   │                                                  content.ts (per tab, all_urls)
   │                                                  ├─ panel DOM (existing)
   │                                                  ├─ initSession(deps) (existing)
   │                                                  ├─ initDomActions(deps) (NEW)
   │                                                  │   ├─ snapshot Range on
   │                                                  │   │   contextmenu/keydown
   │                                                  │   ├─ dispatch action from
   │                                                  │   │   background message
   │                                                  │   └─ render preview UI
   │                                                  │
   │                                                  ├─ src/dom-actions.ts (NEW)
   │                                                  │   ├─ Selection snapshot
   │                                                  │   ├─ Action dispatch
   │                                                  │   └─ Apply layer integration
   │                                                  │
   │                                                  ├─ src/dom-apply.ts (NEW)
   │                                                  │   └─ applyToRange(target, text)
   │                                                  │
   │                                                  ├─ src/transform.ts (NEW)
   │                                                  │   └─ runTransform({ action,
   │                                                  │                     sourceText,
   │                                                  │                     signal })
   │                                                  │
   │                                                  ├─ src/transform-prompts.ts (NEW)
   │                                                  │   └─ action id → system prompt
   │                                                  │
   │                                                  └─ src/ui/preview.ts (NEW)
   │                                                      └─ stacked preview component
   │                                                          (original + streamed result)
   │
   └─ lazy import on first chat / first transform ──▶ @huggingface/transformers
                                                  ──▶ vendor/prompt-api-polyfill/
```

- The lazy `loadHeavy()` cache currently lives inside the `initSession`
  closure. Phase-1 extends it so a sibling `runTransform` path can reuse it
  without instantiating the heavy modules twice. The two consumers must
  share the same memoized promise.
- The long-lived chat `session` instance stays inside `initSession`'s
  closure. `runTransform` creates a *fresh* `LanguageModel` session per
  call with an action-specific system prompt.
- MV3 content scripts cannot register global keyboard shortcuts or
  `chrome.contextMenus`. Both must live in the background service worker.
- MV3 service workers are non-persistent: context-menu items must be
  registered on `chrome.runtime.onInstalled` and on `chrome.runtime.onStartup`
  to survive worker termination.

### Testing Stack

- **Runner:** Vitest 2 + jsdom.
- **Setup file:** `tests/setup.ts` installs a `chrome` global. Phase-2 extends
  it with `chrome.contextMenus.create`, `chrome.contextMenus.removeAll`,
  `chrome.contextMenus.onClicked.addListener`, and `chrome.runtime.onInstalled`
  / `chrome.runtime.onStartup` mocks.
- **Coverage provider:** v8.
- **Coverage scope:** `src/**/*.ts` only (the IIFE entry files `content.ts` and
  `background.ts` are excluded by `vitest.config.ts`'s `coverage.include`).
- **Coverage thresholds:** `lines/statements/functions >= 75`,
  `branches >= 80`. These are enforced — do not lower them.
- **Mocks for the heavy modules:** Follow the existing pattern from
  `tests/session.test.ts` — `vi.mock('@huggingface/transformers', …)` and
  `vi.mock('../vendor/prompt-api-polyfill/prompt-api-polyfill.js', …)`. Use the
  same `makeStream(chunks)` helper for streaming tests.

### Commit Format

All commits in this plan must use [Conventional Commits](https://www.conventionalcommits.org/):

```text
type(scope): brief description

- Detail 1
- Detail 2
```

Allowed types: `fix`, `feat`, `refactor`, `test`, `chore`, `docs`, `ci`.
Allowed scopes (examples): `transform`, `prompts`, `menus`, `background`,
`dom-actions`, `apply`, `preview`, `content`, `manifest`, `docs`, `ci`.

One logical change per commit. Do not batch unrelated changes. Each task in
this plan ends with a `Commit Message Template` block — use it verbatim
unless review feedback requires adjustment.

### Markdown Lint Rules (for any `docs/*.md` you touch)

All `.md` files outside `docs/plans/` are linted by `markdownlint-cli2` in CI.
Follow these rules:

- Fenced code blocks must have a language tag: ` ```text `, ` ```bash `,
  ` ```json `, ` ```ts `, ` ```markdown `. Never use bare ` ``` `.
- Headings must not end with punctuation.
- Code spans must not have leading or trailing spaces inside the backticks.
- Blank lines required before and after headings, code blocks, and lists.

`docs/plans/**` is excluded from markdownlint via `.markdownlintignore`, so
the plan files themselves do not need to satisfy the production-doc rules,
but the new `docs/dom-actions.md` does.

## Architecture Decision Records (ADRs)

### ADR-005: Preview-then-Apply for All Write-Side Actions

**Decision:** Write-side actions (rewrite, in-place transform) stream into a
new Preview component inside the chat panel. The Preview shows the original
selection on top and the streamed model output below, with Apply / Discard
buttons. Apply replaces the captured `Range` in the page DOM; Discard clears
the preview and leaves the page untouched.

**Rationale:**

- Safest UX: nothing mutates the page until the user explicitly approves it.
- Reviewable: the user sees the original and the rewrite side-by-side before
  committing.
- Reject cleanly: Discard is one click.
- Avoids streaming directly into the page, which is hard to undo and
  unfriendly when the model produces an obviously bad result.

**Alternative considered:** Stream the result directly into the editable
field with native browser undo. Rejected for v0.2 because it conflicts with
the "reviewable" property and because every framework (Notion, Google Docs)
intercepts native edits differently.

### ADR-006: Ephemeral `LanguageModel` Sessions for Transforms

**Decision:** Each write-side action (rewrite, translate, simplify,
summarize-in-place) calls `LanguageModel.create({ initialPrompts: [{ role: 'system', content: <action-specific prompt> }] })`
to produce a fresh session. The chat session in `initSession` is untouched.
Transforms do not write to chat history.

**Rationale:**

- Task-specific system prompts don't fight the general-assistant chat prompt.
- Transforms are commits, not conversations — they do not belong in the
  chat scroll.
- The heavy modules (`@huggingface/transformers`, polyfill, ORT wasm) are
  cached by `loadHeavy()`; only the per-action session is fresh. Setup cost
  is paid once per page lifetime.

### ADR-007: Selection Snapshot via `Range.cloneRange()` (with input/textarea Branch)

**Decision:** On `contextmenu` (and on the matching hotkey `keydown`), the
content script snapshots the current selection into a module-level "pending
action" slot. The snapshot is either:

- A cloned `Range` (`window.getSelection().getRangeAt(0).cloneRange()`) for
  regular DOM selections, plus the selection text.
- A `{ element, selectionStart, selectionEnd, text }` tuple if the active
  element is an `<input>` or `<textarea>` (those do not produce DOM Ranges).

The snapshot survives the user clicking into the panel. If the page mutates
between snapshot and Apply, the captured Range may point to changed
content — this is an accepted edge case for v0.2.

**Rationale:**

- DOM Ranges live-update when their containing text changes, but they do
  *not* survive selection clear (which happens when the user clicks the
  panel). Cloning preserves the boundary points.
- `<input>` and `<textarea>` selections live in the shadow DOM of the form
  control and are not exposed as `Range` objects — they require a separate
  branch.

### ADR-008: Hotkey Selection for v0.2

**Decision:** Chrome's manifest caps `commands` at 4. One slot is already
used by `toggle_ai_palette`. The remaining three slots are assigned to:

| Command id | Suggested default | Description |
|------------|-------------------|-------------|
| `toggle_ai_palette` | `Ctrl+Shift+K` / `Cmd+Shift+K` | Toggle AI Palette (existing) |
| `ask_about_selection` | `Ctrl+Shift+L` / `Cmd+Shift+L` | Ask local-nano about the current selection |
| `rewrite_selection` | `Ctrl+Shift+I` / `Cmd+Shift+I` | Rewrite the current selection (Improve writing) |
| `translate_selection` | `Ctrl+Shift+U` / `Cmd+Shift+U` | Translate the current selection to English |

Users can rebind these at `chrome://extensions/shortcuts` without rebuilding.
The remaining sub-actions (other rewrite variants, ES / FR translation,
simplify, summarize-in-place) are reachable only via the context menu in
v0.2.

**Rationale:** The brainstorm's "Open Questions" suggestion. `ask_about_selection`
is the most-used read-side action, `rewrite_selection` is the most-used
write-side action, and `translate_selection` is the most-used in-place
transform.

### ADR-009: `Summarize this page` Is a Synthetic Chat Turn

**Decision:** `Summarize this page` is *not* an ephemeral-session transform.
Instead, the content script focuses the input, programmatically sets its
value to `Summarize this page.`, and triggers the existing send path. The
existing `isFirstTurn` logic auto-prepends the page excerpt; the chat
session retains the conversation so the user can ask follow-ups about the
summary.

**Rationale:**

- Reuses the existing send path; no new code in `session.ts`.
- The result becomes part of chat history naturally, so the user can ask
  follow-ups (`make it shorter`, `who is the protagonist?`) without
  re-providing context.
- The brainstorm's "Open Questions" lists this as one of two viable options;
  this one keeps the v0.2 surface smaller.

**Consequence:** If the user invokes `Summarize this page` mid-conversation
(after `isFirstTurn` has flipped to `false`), the page context is *not*
re-prepended. This is the existing chat behavior and matches user
expectation that asking "summarize the page" after a long chat is just
another question.

### ADR-010: Selection Length Cap

**Decision:** Selection text passed to a transform is capped at 1500
characters (same as `PAGE_CONTEXT_BODY_LIMIT`). If the captured selection is
longer, the preview renders an error message ("Selection too long. Maximum
1500 characters.") instead of starting the model. The same cap applies to
`Ask about this` selection context.

**Rationale:**

- Matches the existing page-context cap, so users get a consistent token
  budget mental model.
- Surfaces the limit *before* the stream starts, avoiding mid-stream
  truncation that produces confusing output.
- The threshold is exported as a named constant (`SELECTION_LIMIT`) so v0.3
  can lift it without grep-and-replace.

### ADR-011: XSS Hygiene in the Apply Layer

**Decision:** The DOM apply layer never uses `innerHTML`. Three subcases:

1. `<input>` and `<textarea>`: `element.setRangeText(newText, start, end, 'end')`.
1. `contenteditable`: `document.execCommand('insertText', false, newText)` to
   preserve browser-native undo. Fallback for browsers without `execCommand`
   support: `range.deleteContents()` + `range.insertNode(document.createTextNode(newText))`.
1. Read-only prose: `range.deleteContents()` + `range.insertNode(document.createTextNode(newText))`.

Every path constructs a text node — model output is never interpreted as
HTML. This is enforced by code review and by unit tests in Phase-3 that
inject `<script>` payloads and verify the resulting node is a `Text` node.

### ADR-012: One Transform at a Time

**Decision:** Only one transform may stream at a time. Triggering a new
transform while one is in flight aborts the in-flight one
(`activeTransformAbort.abort()`) and starts the new one. The Preview UI
shows the new transform from `pending` → `streaming` → `complete`. Discard
during streaming also aborts.

**Rationale:** Matches the existing chat Send / Stop semantics. Simpler than
queueing, and the user usually wants the latest action.

## Module Inventory (New Files in v0.2)

| File | Purpose | Phase |
|------|---------|-------|
| `src/transform-prompts.ts` | `ACTION_ID` enum-like + `actionToPrompt(actionId)` mapping | Phase-1 |
| `src/transform.ts` | `runTransform({ action, sourceText, signal })` returning `ReadableStream<string>` | Phase-1 |
| `src/background/menus.ts` | Context-menu registration + `onClicked` routing | Phase-2 |
| `src/dom-actions.ts` | Selection snapshot, action dispatch, integration with `initSession` and `runTransform` | Phase-3 |
| `src/dom-apply.ts` | `applyToTarget(target, newText)` — three branches | Phase-3 |
| `src/ui/preview.ts` | Stacked preview component with Apply / Discard buttons | Phase-3 |
| `tests/transform-prompts.test.ts` | Tests for the action→prompt mapping | Phase-1 |
| `tests/transform.test.ts` | Tests for `runTransform` (mocked `LanguageModel.create`) | Phase-1 |
| `tests/background-menus.test.ts` | Tests for `registerMenus` and `onClicked` routing | Phase-2 |
| `tests/dom-actions.test.ts` | Tests for selection snapshot and action dispatch | Phase-3 |
| `tests/dom-apply.test.ts` | Tests for `applyToTarget` across all three DOM branches | Phase-3 |
| `tests/ui-preview.test.ts` | Tests for the Preview component state machine | Phase-3 |
| `docs/dom-actions.md` | Public-facing doc for the v0.2 feature | Phase-4 |

## Existing Files Modified

| File | Why | Phase |
|------|-----|-------|
| `manifest.json` | Add `contextMenus` permission; add 3 new `commands`; bump `version` to `0.2.0` | Phase-2, Phase-4 |
| `package.json` | Bump `version` to `0.2.0` | Phase-4 |
| `background.ts` | Wire `chrome.contextMenus.onClicked` + `chrome.runtime.onInstalled` + `chrome.runtime.onStartup` to call `registerMenus` and route clicks | Phase-2 |
| `src/background/handler.ts` | Extend `handleCommand` to forward new action commands to the active tab | Phase-2 |
| `src/session.ts` | Export `loadHeavy()` (or refactor into a shared module-level cache) so `runTransform` can reuse it; add `requestAction(action, payload)` and `setPreviewMode(boolean)` to the `initSession` return surface | Phase-1, Phase-3 |
| `content.ts` | Add `initDomActions(deps)` call after `initSession(deps)`; pass through any shared state | Phase-3 |
| `tests/setup.ts` | Add `contextMenus`, `runtime.onInstalled`, `runtime.onStartup` mocks | Phase-2 |
| `README.md` | Highlights section gains a "DOM-aware actions" bullet; nav adds DOM-actions link | Phase-4 |
| `docs/privacy.md` | "What stays on your machine" gains selection text; menu permission row added | Phase-4 |
| `docs/architecture.md` | Section on context-menu wiring and `runTransform` path; ADR-005..ADR-012 references | Phase-4 |
| `CHANGELOG.md` | New `[0.2.0]` section | Phase-4 |

## Action Schema

A single canonical schema is shared between background, content script, and
the transform module. Defined in `src/transform-prompts.ts` (Phase-1):

```ts
export type ActionId =
  // Read-side (no preview; feed into chat)
  | 'ask_about_selection'
  | 'summarize_page'
  // Write-side, editable target (preview + apply)
  | 'rewrite_improve'
  | 'rewrite_shorter'
  | 'rewrite_formal'
  | 'rewrite_grammar'
  // Write-side, read-only prose target (preview + apply)
  | 'translate_en'
  | 'translate_es'
  | 'translate_fr'
  | 'simplify_in_place'
  | 'summarize_in_place';

export type ActionKind = 'chat' | 'page-chat' | 'transform-editable' | 'transform-readonly';

export interface ActionDescriptor {
  id: ActionId;
  kind: ActionKind;
  label: string; // Menu label — see the id-to-label table in Phase-1 Task 1.2
  parentLabel?: string; // Literal submenu title string (omitted = top-level)
  systemPrompt: string | null; // null for chat / page-chat actions
}
```

The `label` field is the user-visible text in the right-click menu; the
canonical `id → label` mapping for all 11 actions is defined in Phase-1
Task 1.2 (the `ACTION_DESCRIPTORS` array) and is also reproduced in the
`docs/dom-actions.md` table built in Phase-4 Task 4.1.

The `parentLabel` field is the literal submenu title string Chrome renders
(e.g., `'Rewrite'` or `'Translate / Simplify / Summarize in place'`), not
the `ActionId` of another descriptor. Descriptors with the same
`parentLabel` group into one submenu; descriptors that omit it are
registered as top-level menu items. The grouping rule is enforced in
`src/background/menus.ts` (Phase-2 Task 2.2).

The menu structure is derived from this table at registration time. Hotkey
bindings reference the same `ActionId` values.

## Data Flow (End-to-End)

### Read-side: `Ask local-nano about this`

```text
1. User selects text, right-clicks.
2. content.ts contextmenu listener snapshots the Range / input offsets.
3. User picks "Ask local-nano about this" in the native menu.
4. background.ts onClicked handler sends { action: 'ask_about_selection' }
   to the active tab via chrome.tabs.sendMessage.
5. content.ts onMessage listener resolves the pending snapshot, packages
   selection text as `Selection: "${text}"\n\n`, prefills the chat input,
   opens the panel, focuses the input. (Does NOT auto-send.)
6. User types their follow-up question and hits Enter. The existing send()
   path takes over.
```

The selection-context-packaging happens at the moment of dispatch, not at
snapshot time. The format is `Selection: "${text}"\n\nAsk: ` so the user's
follow-up is visually distinct from the selection.

### Read-side: `Summarize this page`

```text
1. User right-clicks anywhere on the page (no selection required).
2. User picks "Summarize this page".
3. background.ts sends { action: 'summarize_page' } to the active tab.
4. content.ts opens the panel, sets input.value to 'Summarize this page.',
   triggers send programmatically.
5. Existing chat send() path uses isFirstTurn page context auto-prepend if
   this is the first turn; otherwise sends just the literal user message.
```

### Write-side: `Rewrite ▸ Improve writing` (or any rewrite variant)

```text
1. User selects text inside <input> / <textarea> / contenteditable, right-clicks.
2. contextmenu listener snapshots the selection (input/textarea branch).
3. User picks "Rewrite ▸ Improve writing".
4. background.ts sends { action: 'rewrite_improve' } to the active tab.
5. content.ts resolves the snapshot, opens the panel, switches the panel
   into Preview mode via setPreviewMode(true).
6. Preview UI renders: top = original selection text, bottom = streaming
   placeholder. Apply button disabled, Discard enabled.
7. runTransform({ action: 'rewrite_improve', sourceText, signal }) is called.
   The result stream pipes into the bottom of the preview.
8. On stream completion, Apply becomes enabled.
9. User clicks Apply: applyToTarget(snapshot, modelText) replaces the
   selection in the page DOM. Panel returns to chat mode.
10. User clicks Discard (any time): the in-flight stream is aborted, the
    preview clears, panel returns to chat mode. No DOM mutation.
```

### Write-side: `Translate / Simplify / Summarize in place ▸ <variant>`

Identical to the rewrite path except the target is read-only prose. The
Apply branch uses `range.deleteContents()` + `range.insertNode(textNode)`
instead of `setRangeText` / `execCommand('insertText')`.

## Testing Strategy

- **Mocking heavy modules:** Reuse the pattern from `tests/session.test.ts`.
  `vi.mock('../vendor/prompt-api-polyfill/prompt-api-polyfill.js', () => ({
  LanguageModel: { create: vi.fn() } }))`.
- **Mocking chrome APIs:** Extend `tests/setup.ts` with the new chrome
  surfaces (`contextMenus.create`, `contextMenus.removeAll`,
  `contextMenus.onClicked.addListener`, `runtime.onInstalled.addListener`,
  `runtime.onStartup.addListener`). Follow the existing `vi.fn()` spy
  pattern.
- **No live cloud:** No test may import the real polyfill or
  `@huggingface/transformers`. The CI workflow has no GPU.
- **Coverage:** Every new `src/` file must come with a tests/ file. Aim for
  >= 85% statements/lines/functions and >= 80% branches per new file
  (matches the elevated bar set in v0.1.1).
- **End-to-end-ish jsdom flow:** `tests/dom-actions.test.ts` simulates a
  `contextmenu` event, then dispatches the resulting background message,
  and asserts the right action runs. Apply path is verified by inspecting
  the resulting DOM.
- **No real `chrome.tabs.sendMessage` calls in tests:** Background tests
  invoke the handler directly with synthesized message objects, exactly as
  `tests/background-handler.test.ts` does today.

## Backward Compatibility

The v0.1.x test suite (53 tests) must continue to pass unchanged. Specifically:

- `tests/session.test.ts` — all 24 existing assertions stay green. The
  `initSession` deps surface may *gain* fields but must not *remove* any.
- Toggle hotkey behavior is unchanged.
- Per-URL chat history persistence is unchanged.
- `pageContext` cap and format are unchanged.

## Bundle Size Note

The new v0.2 code is pure JS / DOM. No new npm dependencies. Bundle delta
should be < 20 KB. If `dist/content.js` grows by more than 100 KB, audit
which dependency leaked in.

## Privacy Invariant

The selection text and the chat input both become part of prompts to the
on-device model. They do **not** leave the device. This must be explicitly
stated in `docs/dom-actions.md` and reinforced in `docs/privacy.md` (Phase-4).
The new `contextMenus` permission is purely a chrome API permission and
grants no additional network access.

## Pre-Implementation Smoke Test

Before opening Phase-1, the implementer must:

1. Run `npm install` and confirm exit 0.
1. Run `npm run lint:ci && npm run typecheck && npm test && npm run build`
   on the starting commit and confirm exit 0 on every step.
1. Confirm `.env.json` exists at repo root (copy from `.env.example.json`
   if not).
1. Load `local-nano/` as an unpacked extension and confirm the v0.1
   toggle hotkey still works.

If any of these fail, fix it before starting Phase-1.
