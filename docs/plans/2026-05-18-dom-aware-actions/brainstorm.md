---
type: feature
date: 2026-05-18
slug: dom-aware-actions
target_release: v0.2.0
---

# Feature: DOM-Aware Actions

## Overview

v0.1.x is a chat panel that opens with a hotkey and reads the page body as a single excerpt prepended to the first turn. v0.2 makes the extension *DOM-aware*: it gains a right-click context menu, captures the user's text selection at click time, and offers actions that either feed the selection into the chat or transform it in place.

This is the feature set that turns local-nano from "a chat sidebar that knows the page URL" into a tool that does meaningful work against specific content the user points at — without ever shipping that content to a cloud provider. The privacy moat of running locally is most valuable when the action is selection-scoped (a paragraph from a contract, a snippet from a draft email, a chunk of source code on a code-review page), because cloud equivalents would have to stream that content off the device on every interaction.

Mechanically, v0.2 adds:

- A `chrome.contextMenus` integration registered from the background service worker, plus a small set of hotkeys (capped by Chrome's 4-command manifest limit).
- A selection-capture layer in the content script that snapshots the active `Range` at right-click time and persists it until Apply or Discard.
- A preview / apply UX in the chat panel for write-side actions: original + streamed rewrite side-by-side with explicit commit buttons.
- A second code path in `session.ts` that creates ephemeral `LanguageModel` sessions per transform action with task-specific system prompts, leaving the existing chat session untouched.

## Decisions

1. **Scope: all four sub-features in.** Selection-aware chat (read), right-click context menu (read), inline rewrite in editable fields (write), in-place transform on read-only prose (write). Rationale: the user wanted a meaningful v0.2 demoable; shipping all four together gives a coherent "DOM-aware" story.
2. **Trigger model: right-click primary, hotkeys secondary.** Right-click is the discoverable surface (precedent: Grammarly, 1Password). Hotkeys are added for the most-used actions, bounded by Chrome's 4-command limit. Rationale: discoverability + power-user efficiency in one pass.
3. **Menu actions (curated submenus):**
   - `Ask local-nano about this` — contexts: `selection`
   - `Summarize this page` — contexts: `page`
   - `Rewrite ▸` — contexts: `editable`, items: *Improve writing*, *Make shorter*, *Make formal*, *Fix grammar*
   - `Translate / Simplify / Summarize in place ▸` — contexts: `selection` (read-only): *Translate to English*, *Translate to Spanish*, *Translate to French*, *Simplify*, *Summarize*
4. **Apply UX: preview in panel, one-click apply.** Write-side actions stream into the panel showing original + rewritten. Buttons: **Apply** (replace the captured `Range` in page DOM), **Discard** (clear preview, page untouched). Rationale: safest, reviewable, accepts rejection cleanly. No streaming directly into the page in v0.2.
5. **Session model: independent ephemeral sessions for transforms.** Each write-side action calls `LanguageModel.create({ initialPrompts: [{ role: 'system', content: <action-specific prompt> }] })`. The heavy Transformers.js + polyfill modules stay cached across calls (`loadHeavy()` already memoizes). Read-side `Ask about this` feeds the existing long-lived chat session as a normal turn. Rationale: task-specific system prompts don't fight the chat's general-assistant prompt; transforms don't pollute chat history.
6. **Translation default set: English, Spanish, French.** Hardcoded in v0.2. Configurable via `.env.json` in v0.3.
7. **`Ask about this` integrates with chat history.** Treated as a normal user turn in the existing per-URL chat session. The selection becomes the contextual frame for the user's follow-up question.
8. **Transforms do not write to chat history.** They're commits, not conversations. The chat scroll stays focused on actual chat content.
9. **Selection capture via `Range.cloneRange()`.** Snapshot at right-click time so the selection survives the user clicking into the panel. If the user mutates the page between right-click and Apply, accept whatever the captured Range now points to (out-of-scope: smart re-anchoring).

## Scope: In

- **Manifest changes**
  - Add `contextMenus` to `permissions`.
  - Register up to 3 new entries in the `commands` block (one slot reserved for the existing `toggle_ai_palette`).

- **Background service worker (`background.ts` + `src/background/handler.ts`)**
  - Register context-menu items on install / startup via `chrome.contextMenus.create`.
  - Wire `chrome.contextMenus.onClicked` to forward action metadata (action id, page tab) to the active content script.
  - Extend `handleCommand` to handle new keyboard commands and route them to the same action dispatch.

- **Content script (`content.ts` + new `src/dom-actions.ts`)**
  - On right-click in any context, snapshot `window.getSelection().getRangeAt(0).cloneRange()` (if any) into a module-level "pending action" slot before the menu fires.
  - On message from background, look up the pending Range, the action id, and dispatch to one of:
    - **Ask action** → push the selection text as context into the existing chat session, open panel, focus input.
    - **Summarize-page action** → open panel, kick off a synthetic user turn ("Summarize this page.") that uses the existing `pageContext()` plumbing.
    - **Rewrite / transform action** → open a new "Preview" UI in the panel; create ephemeral session with the action's system prompt; stream the result; expose Apply/Discard.

- **Session module (`src/session.ts` extensions or sibling `src/transform.ts`)**
  - New `runTransform({ action, sourceText, signal })` returns a `ReadableStream<string>` from an ephemeral `LanguageModel.create()`. Heavy modules reused via the existing `loadHeavy()` cache.
  - Mapping table: `action id → system prompt string`. System prompts must strictly output only the rewritten/translated text (no preamble). Lives in a new `src/transform-prompts.ts` so it's testable in isolation.

- **Preview UI (`src/ui/preview.ts` or extension to `src/ui/messages.ts`)**
  - A stacked preview component: top section shows the original selection (clipped + scrollable if long), bottom section streams the model output. Apply/Discard buttons. Replaces the indicator/streaming render for transform turns.
  - State machine: `pending` → `streaming` → `complete` (Apply/Discard enabled) | `aborted` (Discard only).

- **DOM apply layer (`src/dom-apply.ts`)**
  - `applyToRange(range, newText)` — replaces the contents of a cloned `Range`. Three subcases:
    - **Editable field (`<input>`, `<textarea>`):** use `setRangeText` for `<input>`/`<textarea>`; for `contenteditable`, replace via `document.execCommand('insertText', false, newText)` to keep undo working, with a fallback to `range.deleteContents()` + `range.insertNode(document.createTextNode(newText))`.
    - **Read-only prose:** `range.deleteContents()` + `range.insertNode(textNode)`. No HTML interpretation; always `createTextNode` to avoid XSS.

- **Tests**
  - Unit tests for `runTransform` (mocked `LanguageModel.create`), the action→prompt mapping, the dispatch routing, the preview component state machine, and `applyToRange` across the three DOM subcases.
  - End-to-end-ish jsdom flow: simulate a contextmenu click, verify the right action runs, verify Apply mutates the DOM.

- **Docs**
  - New `docs/dom-actions.md` covering the menu structure, the privacy implications (selection is processed on-device, never sent), and how to add a new action.
  - Update `README.md` highlights and `docs/privacy.md` (selection text joins prompts in the "stays on your machine" list).
  - `CHANGELOG.md` entry under `## [Unreleased]` or a new `## [0.2.0]` section, depending on release timing.

## Scope: Out

- **Configurable translation languages.** Hardcoded EN/ES/FR for v0.2. `.env.json`-driven set comes in v0.3.
- **Floating action button next to selection.** Context menu and hotkeys cover discoverability for v0.2.
- **Streaming directly into the page.** Preview-then-apply is the only write path in v0.2.
- **Multi-step transforms / chained actions.** No "rewrite then translate" flow; each action is one-shot.
- **Explicit undo after Apply.** Rely on the browser's native undo for `<input>`/`<textarea>`/`contenteditable` (via `execCommand('insertText')`); no custom undo stack for read-only prose mutations.
- **Re-anchoring after DOM mutation between right-click and Apply.** If the user edits the page between snapshot and Apply, the captured Range may point to changed content — accepted as a known edge case.
- **Multiple concurrent transforms.** One in-flight transform at a time. Triggering a new transform while one is running cancels the in-flight one (consistent with the existing chat Send/Stop behavior).
- **Right-click on images / links / non-text contexts.** Selection-based only. Image/link actions are a separate future feature.
- **Voice or non-text input.** Out of scope; text only.
- **Agentic / multi-step DOM manipulation.** Form fill, autoclick, scroll-and-decide: deferred indefinitely.
- **Custom user prompts per action.** All system prompts are baked in for v0.2.

## Open Questions

- **Hotkey assignment.** Chrome caps a manifest at 4 commands. `toggle_ai_palette` takes one. Which three of the new actions earn the remaining slots? Suggested: `ask_about_selection`, `rewrite_in_place`, `translate_default`. Planner should confirm and document the default chords for each platform.
- **`Summarize this page` and the existing first-turn page-context auto-prepend.** Today `session.ts` auto-prepends the body excerpt on the first chat turn. If `Summarize this page` becomes a synthetic first turn, it will get the page excerpt for free — but the action's prompt should be specific enough to not duplicate context. Planner: decide whether `Summarize this page` uses an ephemeral session (consistent with other transforms but loses chat history of the summary) or fires a synthetic user turn into the chat session.
- **Behavior when no selection exists for selection-required actions.** If the user binds the `ask_about_selection` hotkey and presses it without a selection, what's the fallback? Suggested: open the panel and focus the input with no prefilled context (graceful degradation to the existing toggle behavior).
- **Long selections.** What's the cap on selection size we pass to the model? Current `pageContext` truncates body to 1500 chars; a selection might be larger. Planner: choose a sensible cap (suggested: same 1500 or slightly higher for transforms) and decide whether to warn the user when truncating.
- **Aborting a preview-in-progress.** Should Discard while streaming also abort the underlying `AbortController`? Yes — Discard should mean "stop and revert," not "wait for completion then drop."
- **Preview visibility for `Ask about this`.** That action doesn't need a preview (it's just chat); confirm UI doesn't show Apply/Discard for read-side actions.

## Relevant Codebase Context

- `content.ts` — single-file content script that injects the panel DOM and wires drag/resize/close. New right-click capture logic and Range snapshot live here (or a new `src/dom-actions.ts` imported from it).
- `src/session.ts` — owns the chat session, the `loadHeavy()` cache, history persistence, and Send/Stop. `runTransform` should reuse `loadHeavy()` but not the long-lived `session` instance.
- `src/pageContext.ts` — builds `Page: …\nURL: …\n\n<body excerpt>`. Selection text should be packaged similarly when feeding `Ask about this`.
- `src/system.ts` — current chat system prompt. New `src/transform-prompts.ts` mirrors this for the per-action prompts.
- `src/background/handler.ts` — current command dispatch (toggle only). Extend with action-id handling routed from the new context-menu listener.
- `src/ui/messages.ts` — `renderMessage` and `makeTypingIndicator`. The preview component is a peer; should follow the same XSS-safe `createElement` + `textContent` pattern (no `innerHTML`).
- `src/ui/state.ts` — Send/Stop button state. Preview Apply/Discard reuses the same idle/busy idioms.
- `manifest.json` — currently declares `permissions: [activeTab, scripting, storage]`. Add `contextMenus`. The `commands` block at the bottom needs new entries; respect the 4-command total.
- `tests/setup.ts` — installs the `chrome` mock. New mocks needed for `chrome.contextMenus.create`, `chrome.contextMenus.onClicked`. Follow the existing `vi.fn()` spy pattern.
- `tests/session.test.ts` — pattern for testing `initSession` with mocked `LanguageModel.create`. Mirror for `runTransform`.
- `.biome.json` / Biome 2.4.15 — formatting and import-order. New files must pass `npm run lint:ci`.
- `vitest.config.ts` — coverage thresholds: lines/statements/functions ≥ 75%, branches ≥ 80%. New modules must come with tests.
- `tsconfig.json` — strict mode is on; `tests/**/*.ts` is in the typecheck include. New files type-check end-to-end.

## Technical Constraints

- **Manifest V3 service worker lifecycle.** Background is non-persistent; context-menu items must be re-registered on every `chrome.runtime.onInstalled` (and ideally `onStartup`) to survive worker termination.
- **Chrome `commands` cap.** A manifest can declare at most 4 commands. One is already used by toggle; three remain for hotkey actions.
- **MV3 message-passing.** Background → content-script communication goes via `chrome.tabs.sendMessage`. The content script must already be loaded (which it is, due to `matches: ["<all_urls>"]`).
- **`<input>` / `<textarea>` selections** do not produce DOM Ranges. They report `selectionStart` / `selectionEnd`. Selection capture must branch: if the active element is an `<input>` or `<textarea>`, snapshot those offsets and the element reference instead of a Range. The apply layer mirrors the same branch.
- **`contenteditable` quirks.** Some sites wrap content in their own widgets (Notion, Google Docs); `execCommand('insertText')` may be intercepted or behave unexpectedly. Document this as a known limitation in `docs/dom-actions.md` rather than trying to handle every framework.
- **Cross-origin iframes.** Content scripts run per-frame; selections inside an iframe belong to that frame. v0.2 only handles selections in the top frame. Document this.
- **XSS hygiene.** Apply always uses `createTextNode` / `setRangeText` / `execCommand('insertText')`. Never `innerHTML`. Reinforce in code review and add a lint rule comment in the apply module if needed.
- **Token budget.** The model's input context is bounded. Long selections + a system prompt can push past it. Planner should add a selection-length pre-check with a clear "selection too long" error rendered in the preview UI rather than failing silently in the stream.
- **Privacy invariant.** The selection text is part of the prompt going to the on-device model; that's fine. The selection must never leave the device. `docs/privacy.md` and the new `docs/dom-actions.md` should state this explicitly.
- **Backward compatibility.** Existing chat behavior (toggle, send, stop, history) must continue to work unchanged. Tests for v0.1.x behavior remain green.
- **Bundle size.** Heavy modules already pay a one-time hit; new code is pure JS / DOM. No new heavy deps.
