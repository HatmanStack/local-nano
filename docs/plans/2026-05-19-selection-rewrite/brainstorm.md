# Feature: Selection-driven in-place rewrite

## Overview

Bring back the v0.2.0 capability of editing highlighted portions of the live webpage with the on-device model, but redesigned against the memory budget that killed that release. The user highlights prose on the page, types an editing instruction into the existing chat input, and the model rewrites the selection in place — tokens stream directly into the DOM, replacing the original text as they arrive.

The architecture differs from v0.2.0 in three load-bearing ways: (1) it reuses the single offscreen `LanguageModel` session that already powers chat (no parallel `LanguageModel.create()` call — that was the v0.2.0 OOM cause), (2) selection payload is hard-capped at ~700 chars (selection plus ~200 chars of surrounding context on each side), and (3) `max_new_tokens` is bounded per call to a small multiple of the input token count, not the polyfill's session-wide 2048 ceiling.

Transforms are treated as normal turns in the same conversation thread used for chat — the instruction and rewritten text both land in the polyfill history and in `chrome.storage.local`, rendered as user/model bubbles in the panel. The bubble for a transform carries a single "Undo" button that snapshots the original DOM range, giving the user one-level rollback without any preview-then-apply UI. The feature does not introduce a new model session, a new context menu, a new keyboard command, or a new floating UI surface — it extends the existing chat panel and reuses the offscreen-doc streaming path shipped in v0.2.2.

## Decisions

1. **Trigger model — visual mode flip (Q1/B).** When a non-empty `window.getSelection()` exists, the chat input's placeholder swaps to "Edit selection… (Esc to switch to Ask)" and a compact selection preview appears above the input. With no selection, the panel behaves as normal chat. Mode is unambiguous and reuses the existing input field — no new buttons, no context menus.

2. **Selection payload — selection + fixed-size context (Q2/B).** Send selection text + ~200 chars before + ~200 chars after, all plain text (no HTML tags). Hard ceiling on per-call tokens regardless of where the user is on the page. Gives the model enough context for "match the surrounding style" without bloating tokens. Structural edits (turn this into a list) are out of scope for v0.2.3.

3. **Apply mode — stream in-place into the DOM (Q3/A).** Tokens from `streamPrompt` replace the captured `Range` as they arrive. No preview component, no Apply button. The model's response *is* the page mutation. Confidence in the result is backed by the Undo affordance (decision 5).

4. **Session strategy — transforms are normal chat turns (Q4/A).** Reuse the existing offscreen `LanguageModel` session. The user's transform instruction and the resulting rewritten text both flow through the same `streamPrompt` path as chat, are recorded in the polyfill's `#history`, and are persisted to `chrome.storage.local` under the existing per-URL key. The chat panel renders them as user/model bubbles. No second `LanguageModel.create()` call anywhere in the codebase.

5. **Undo — single-level snapshot on the chat bubble (Q5/A).** Before the rewrite starts, snapshot the original `Range`'s text content + a serializable reference to its position (parent node + start/end offsets). Attach those to the transform's model bubble as a JS-memory-only undo slot, surfaced as a small "Undo" button next to the bubble. Clicking restores the original text by replacing whatever is currently at that range. Snapshot expires when the tab navigates or the content script reloads (we do not persist undo state across sessions).

6. **Token cap — `max(MIN_OUTPUT_TOKENS, inputTokenCount * MAX_OUTPUT_MULTIPLIER)` (Q6/B + tweakable).** Both constants live at the top of the transform module as named exports so the cap is discoverable and trivially adjustable without code-archeology. Starting values: `MIN_OUTPUT_TOKENS = 256`, `MAX_OUTPUT_MULTIPLIER = 2`. The polyfill exposes `session.countTokens()`, which we'll route through a new `count` channel in the offscreen protocol.

7. **Supported selection environments — plain DOM only (Q7/A).** Single contiguous `Range` inside ordinary text-bearing elements (`<p>`, `<div>`, `<li>`, `<span>`, etc.). Explicitly out of scope: `<input>` / `<textarea>` (different selection API) and `contenteditable` regions (page owns its own undo stack and IME). v0.3.0 can add `contenteditable` once v0.2.3 is rock-solid on read-mode prose.

8. **Mode escape — Esc to switch to Ask mode (Q8/A).** With a selection active, pressing Esc inside the input toggles to "Ask about selection… (Esc to switch back to Edit)" mode. In Ask mode the selection is preserved (we do not call `selection.removeAllRanges()`) and quoted into a normal chat prompt at send time. After the turn, mode resets to the default for the current selection state.

## Scope: In

- Capture the user's selection at the right moment (on input focus) and hold a stable reference to its `Range` across the panel-interaction lifecycle.
- Visual mode flip on the chat input: placeholder swap, compact selection preview chip, mode-aware Send behavior.
- A new module named `src/selection-rewrite.ts` (deliberately **not** `src/transform.ts` — that name is on the forbidden v0.2.0 list below) that:
  - Owns `MIN_OUTPUT_TOKENS` / `MAX_OUTPUT_MULTIPLIER` constants.
  - Builds the rewrite prompt (selection + context window + user instruction).
  - Routes through `streamPrompt` with the per-call token cap.
  - Streams chunks into the live `Range` (deleting on first chunk, appending text-node content as chunks arrive). It mutates the DOM directly and does not return the rewritten text to the caller.
- A small `count` channel in `src/offscreen/protocol.ts` so the content script can ask the polyfill for token counts before sending (used to compute the cap).
- Undo bookkeeping: snapshot before mutation, button on the model bubble, restore on click.
- Esc-toggled Ask mode that quotes the selection into a normal chat prompt.
- Tests:
  - Protocol guards for the new `count` channel.
  - Mode-flip logic in `src/session.ts` (selection present → edit mode placeholder; Esc → ask mode; no selection → chat mode).
  - Transform module: prompt construction, token cap math, in-place streaming into a mock `Range`, undo restoration.
- A `docs/transform.md` describing the user-facing flow, the architectural constraints inherited from the v0.2 post-mortem, and the v0.3.0 follow-up scope.

## Scope: Out

- **No second `LanguageModel` session.** The whole feature must route through the existing offscreen session. Any design proposal that calls `LanguageModel.create()` is rejected outright.
- **No context menu, no new hotkey.** The existing `Ctrl/Cmd+Shift+K` panel toggle remains the only keybinding the extension owns. Triggering is selection-presence + Send.
- **No preview-then-apply UI.** No floating overlay, no separate Preview component, no Apply button on the bubble (the bubble has Undo, not Apply — the mutation already happened). The v0.2.0 `src/ui/preview.ts` pattern does not return.
- **No `contenteditable` / `<input>` / `<textarea>` support.** Selection capture for those is fundamentally different and pulls in per-site quirks (Gmail, Docs, Notion, ChatGPT all have idiosyncratic composers). Queued for v0.3.0.
- **No structural edits.** "Turn this into a bulleted list," "add a heading above this," "wrap in a blockquote" — out of scope. Output is always plain text replacing the selection's plain text.
- **No multi-level undo, no persisted undo.** One slot in JS memory per active transform; lost on tab navigation or content-script reload.
- **No predefined transform commands** (rewrite, translate, simplify, formalize buttons). The user's typed instruction is the entire transform vocabulary. v0.2.0's `src/transform-prompts.ts` does not return.
- **No cross-tab transform coordination.** A transform issued in tab A blocks tab A's chat (existing `activeAbort` guard already handles this); the shared offscreen session naturally serializes across tabs at the polyfill layer, so tab B will wait. No new queueing logic.
- **No model selection / multi-model routing.** Same Gemma-4 / WebGPU stack as chat.

## Open Questions

- **Selection survival across input focus.** When the user clicks into the chat input, `window.getSelection()` typically clears. The planned approach is to snapshot the live `Range` in a `focus` handler on the input and hold it in session state, but the exact event timing (focus vs mousedown vs selectionchange) needs validation against real browsers. The planner should prototype against Chrome's behavior before committing to a specific event.
- **DOM range stability across content-script reloads / navigations.** The captured `Range` may become invalid if the page mutates between selection time and stream-start time (e.g., a SPA router fires mid-transform). Probably acceptable to detect "range is detached" and surface a friendly error rather than try to recover.
- **Token counting cost.** `session.countTokens()` runs the chat template + tokenizer over the whole conversation, which is non-trivial on Gemma-4. If it adds >100ms to every transform send, the planner may need to budget that into the UX or use a heuristic (e.g., `chars / 3`) for the cap calculation instead of a real count.
- **System-prompt swap for transform turns.** The current offscreen session has a chat-style system instruction ("You are a helpful assistant. Answer concisely and directly."). For rewrites, the model would do better with a transform-style instruction ("Rewrite the user-supplied text according to their instruction. Respond with only the rewritten text, no commentary."). Open question whether to inject this as a per-turn prefix on the user prompt, or to leave it to the natural prompt structure. v0.2.0 used per-prompt templates; preserving that idea without the parallel-session mistake is fine.

## Relevant Codebase Context

- **`offscreen.ts`** — Hidden offscreen document hosting the shared `LanguageModel` session. The new `count` channel handler goes here, parallel to the existing stream handler. The session itself is *not* swapped or augmented; transforms route through the same `session.promptStreaming` call as chat.

- **`src/offscreen/protocol.ts`** — Wire types for `ENSURE_OFFSCREEN_*`, `STREAM_*`, `REBUILD_SESSION_*`. The new `COUNT_TOKENS_REQUEST` / `COUNT_TOKENS_RESPONSE` constants + type guards go here, following the same pattern.

- **`src/offscreen/client.ts`** — Content-script-facing client. Adds a `countTokens(text)` export alongside `streamPrompt` / `sendPrompt` / `rebuildSession`. The retry-on-device-loss path established in v0.2.2 is inherited automatically.

- **`src/session.ts`** — Current `initSession` owns the chat input, the typing indicator, the model-bubble rendering, the abort controller, and the device-loss retry path. The selection-mode-aware Send logic, the Esc handler, and the placeholder swap all hook in here. The transform-specific prompt construction and DOM mutation will live in a new sibling module imported by `session.ts`.

- **`src/history.ts`** — `Entry = { role, text }`, `MAX_HISTORY = 200`, per-URL keyed storage. Transform turns persist through the existing path with no schema change; the model bubble's Undo button is a UI affordance only, not a stored field.

- **`src/ui/messages.ts`** — `renderMessage` and `makeTypingIndicator`. The transform bubble reuses the existing model-bubble renderer but gets an Undo button appended after the stream ends.

- **`src/ui/state.ts`** — `setIdleState` / `setGeneratingState` for the Send button. No changes; the same generating state covers in-flight transforms.

- **`content.ts`** — Injects the panel, owns the `document` / `location` references handed to `initSession`. Already wired with `window` access for `getSelection()` once the transform module needs it. The mode-flip selectionchange listener (`document.addEventListener('selectionchange', …)`) is registered here and pushed into session state via the existing `SessionDeps`.

- **Removed-but-referenced v0.2.0 surface** — `src/transform.ts`, `src/transform-prompts.ts`, `src/dom-apply.ts`, `src/dom-actions.ts`, `src/ui/preview.ts`, `src/background/menus.ts`, `src/heavy.ts` were all deleted at v0.2.1. The brainstorm explicitly does not bring any of them back — none of those module names should reappear in the implementation plan even if a fresh module covers conceptually similar ground.

- **Test infrastructure** — Vitest + jsdom, `tests/setup.ts` provides `chromeMock` and `FakePort`. The `streamPrompt` mock pattern in `tests/session.test.ts` is the reference for adding transform tests (mock the offscreen client, drive chunks/done synthetically).

- **Build pipeline** — `build.mjs` already builds `content.ts` / `background.ts` / `offscreen.ts` in parallel. The transform module is bundled into `content.ts` automatically by virtue of being imported from `src/session.ts`. No build-config changes expected.

## Technical Constraints

- **Memory budget is the load-bearing constraint.** v0.2.0 reverted because of WebGPU OOM caused by a second `LanguageModel.create()` for transforms on top of the chat session. The single-session reuse rule is non-negotiable for v0.2.3.

- **Polyfill is treated as upstream code.** `vendor/prompt-api-polyfill/` is not patched. Anything we need from the polyfill must go through its public surface (`promptStreaming`, `countTokens`, `destroy`, `initialPrompts` on `create`).

- **Per-call `max_new_tokens` must be set explicitly.** The polyfill's transformers backend (`vendor/prompt-api-polyfill/backends/transformers.js`) bakes the cap into `generationConfig` at `createSession` time at 2048; we cannot override that ceiling per-call through the current API surface. The polyfill *does* accept `responseConstraint` etc. per call, but not `max_new_tokens`. **This is a known limitation.** The planner has two options: (a) accept that 2048 is the hard ceiling and rely on instruction-prompt hints + observed model behavior to keep outputs short, or (b) propose a tiny addition to the polyfill's `promptStreaming` signature to thread a per-call cap through to the backend. Option (b) is allowed only if the patch is mechanical, well-isolated, and documented; otherwise (a) is the path.

- **WebGPU device loss is expected.** The v0.2.2 retry path handles GPU-loss recovery for chat turns by rebuilding the session with persisted history. Transform turns inherit that path for free *because they are normal turns*. No new recovery logic is needed.

- **Selection capture must happen before input focus.** Clicking into the chat input clears the page's `Selection`. The planner needs an input-focus or panel-focus listener that snapshots the `Range` immediately, before the focus shift propagates. The snapshot is held in session-level state and used at send time.

- **Range mutation must be undoable from a single snapshot.** The implementation must capture `range.startContainer`, `range.startOffset`, `range.endContainer`, `range.endOffset`, and the original text content before issuing `range.deleteContents()`. Undo restores by walking to the same container nodes and re-inserting the original text. If the page mutates the container nodes in the meantime, undo fails gracefully (logged + button greyed out) rather than crashing.

- **Token cap math runs on the content-script side.** Token counting requires a round-trip to the offscreen polyfill (new `count` channel). The planner should evaluate whether to gate the send on the count round-trip (correct but slower) or to use a character-based heuristic for the cap (faster but imprecise). Recommend the round-trip with a 100ms timeout fallback to heuristic — best of both.

- **Streaming-into-DOM is racy with abort.** If the user clicks Stop mid-stream, partial replacement text is already in the DOM. Two valid behaviors: (a) leave the partial text in place (model produced some valid words, treat it as committed), or (b) restore the original (atomic transform). Recommend (a) for simplicity; the Undo button is the escape hatch either way.
