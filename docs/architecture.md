# Architecture

`local-nano` is a Chrome Manifest V3 extension with three moving pieces:

1. A **background service worker** that listens for the keyboard shortcut.
2. A **content script** injected into every page; it owns the chat UI and runs the model.
3. A vendored **Prompt API polyfill** that exposes the W3C-proposed `LanguageModel` interface backed by Transformers.js + ONNX Runtime Web.

```text
                ┌──────────────────────┐         ┌──────────────────────────┐
   Ctrl+Shift+K │ background.ts        │ message │ content.ts (per tab)     │
  ───────────▶  │  chrome.commands     │ ──────▶ │  toggles panel           │
                │  onCommand listener  │ {a:'…'} │  lazy-loads heavy modules│
                └──────────────────────┘         │  builds Prompt API session│
                                                 │  streams tokens to DOM    │
                                                 └──────────────────────────┘
                                                            │
                                                            │ imports
                                                            ▼
                                          ┌─────────────────────────────────┐
                                          │ vendor/prompt-api-polyfill/     │
                                          │   LanguageModel                 │
                                          │     └─ TransformersBackend      │
                                          │          └─ @huggingface/       │
                                          │             transformers + ORT  │
                                          └─────────────────────────────────┘
```

## Background service worker (`background.ts`)

Tiny. It registers a `chrome.commands.onCommand` listener that, on the `toggle_ai_palette` command, looks up the active tab and sends a `{ a: 'toggle' }` message to the content script. The handler logic lives in [`src/background/handler.ts`](../src/background/handler.ts) so it can be unit-tested.

## Content script (`content.ts`)

Loaded on `<all_urls>`. On import it:

1. Inserts a `<style>` element for the typing-indicator animation.
2. Builds the chat panel DOM (hidden by default), with a draggable header, message list, input, and Send/Stop button.
3. Restores prior history for this URL from `chrome.storage.local`.
4. Subscribes to `chrome.runtime.onMessage` for the toggle ping.

It does **not** load the model on startup. The first time you toggle the panel, `loadHeavy()` dynamically imports `@huggingface/transformers` and the polyfill, sets the ONNX wasm path, and creates a `LanguageModel` session. Subsequent toggles reuse the same session.

When you send a message:

- On the **first turn**, the prompt is prefixed with `pageContext()` — the page title, URL, and a body excerpt (capped at 1500 chars).
- Subsequent turns send only the user's text; conversation continuity is the polyfill session's responsibility.
- Responses come back via `promptStreaming()`. Tokens append to the rendered message as they arrive. An `AbortController` lets the Stop button cancel mid-stream.

## Prompt API polyfill

`vendor/prompt-api-polyfill/` is a slimmed copy of Google's polyfill. We strip every backend except Transformers.js (in `backends-registry.js`), remove the upstream iframe-injection block from `prompt-api-polyfill.js` (a `MutationObserver` over `documentElement` that was a meaningful perf cost on SPA-style host pages), and raise `max_new_tokens` from 1024 to 2048 in the Transformers backend. See [docs/prompt-api.md](prompt-api.md) for the full inventory of modifications and the resync procedure.

`TransformersBackend` (in `vendor/prompt-api-polyfill/backends/transformers.js`) wraps `@huggingface/transformers`'s `pipeline()` and `TextStreamer`. Configuration comes from `window.TRANSFORMERS_CONFIG`, which `content.ts` populates from `.env.json` (model name, device, dtype).

## Why two scripts?

MV3 doesn't let content scripts register global keyboard shortcuts. Only the background service worker can. The split — background owns the hotkey, content owns the UI and the model — is the standard MV3 shape.

## Build pipeline

[`build.mjs`](../build.mjs) uses esbuild to bundle:

- `content.ts` → `dist/content.js` (IIFE — content scripts can't be ESM modules).
- `background.ts` → `dist/background.js` (ESM — the manifest declares `"type": "module"` for the worker).

Before building it copies the ONNX runtime `.wasm` / `.mjs` files into `dist/ort/`. Transformers.js would otherwise try to fetch them from jsdelivr at runtime, which the MV3 content-script CSP forbids.

## What lives where

| Concern                      | File                                          |
| ---------------------------- | --------------------------------------------- |
| Keyboard shortcut            | `background.ts` + `src/background/handler.ts` |
| Panel DOM + dragging         | `content.ts`                                  |
| Session lifecycle            | `src/session.ts`                              |
| Message rendering            | `src/ui/messages.ts`                          |
| Send/Stop button             | `src/ui/state.ts`                             |
| Page context prompt          | `src/pageContext.ts`                          |
| System instruction           | `src/system.ts`                               |
| History persistence          | `src/history.ts`                              |
| Action schema and prompts    | `src/transform-prompts.ts`                    |
| Per-action transform         | `src/transform.ts`                            |
| Heavy module loader          | `src/heavy.ts`                                |
| Context-menu registration    | `src/background/menus.ts`                     |
| Selection capture & dispatch | `src/dom-actions.ts`                          |
| DOM apply layer              | `src/dom-apply.ts`                            |
| Preview component            | `src/ui/preview.ts`                           |
| Polyfill + backend           | `vendor/prompt-api-polyfill/`                 |
| Build                        | `build.mjs`                                   |
| Manifest                     | `manifest.json`                               |

## Session Lifecycle (post-extraction)

After the Phase-3 refactor, session state lives entirely inside the closure
returned by `initSession()` in `src/session.ts`. Key variables:

| Variable | Type | Description |
|----------|------|-------------|
| `session` | `LanguageModelSession \| null` | The active polyfill session; null before first successful `ensureSession()` call |
| `creating` | `boolean` | Guards against concurrent `ensureSession()` calls |
| `isFirstTurn` | `boolean` | True until the first `send()` in a session |
| `heavyLoadPromise` | `Promise \| null` | Memoizes the dynamic import; reset to null on failure to allow retry |
| `activeAbort` | `AbortController \| null` | Non-null while a stream is in progress |
| `history` | `Entry[]` | In-memory history array, persisted on every user/model turn |

### Known Lifecycle Limitations

**`isFirstTurn` and page reload (M7):** When a page is reloaded, `restore()`
re-renders prior history entries from `chrome.storage.local` into the message
list. However, `isFirstTurn` stays `true` — the new polyfill session has no
knowledge of those restored entries. Sending a follow-up message after reload
will include the page context prefix again (as if it were the first turn) and
the model will respond without memory of the prior conversation.

The correct fix is to replay the restored history into `LanguageModel.create`'s
`initialPrompts`. This requires the polyfill to accept user/model turns in
`initialPrompts`, which it does — but replaying could be expensive for long
histories and is deferred pending user feedback on whether continuity across
reloads is a desired feature.

## DOM-Aware Actions (v0.2)

v0.2 layers a right-click menu and three new hotkeys on top of the v0.1
chat panel. The architecture is intentionally additive — the long-lived
chat session and its history are untouched. The session lifecycle now
also includes short-lived, ephemeral transform sessions that share the
heavy-module cache but otherwise live and die per right-click.

- **Menu and command surface.** `chrome.contextMenus` is registered
  from the background service worker (`src/background/menus.ts`) on
  `chrome.runtime.onInstalled` and `chrome.runtime.onStartup` so the
  menu survives worker termination. `chrome.runtime.onMessage`
  delivers an `ActionMessage` from the background to the per-tab
  content script.
- **Selection capture and dispatch.** `src/dom-actions.ts` snapshots
  the current selection on `contextmenu` / `keydown` and stores it in
  a module-level "pending action" slot. The snapshot is either a
  cloned `Range` (for regular DOM selections) or a
  `{ element, selectionStart, selectionEnd, text }` tuple for
  `<input>` / `<textarea>` targets. When the action message arrives,
  `dispatchAction` routes it by descriptor `kind`
  (`chat`, `page-chat`, `transform-editable`, `transform-readonly`).
- **Per-action ephemeral sessions.** `src/transform.ts` exports
  `runTransform({ action, sourceText, signal })`. Each call creates a
  fresh `LanguageModel` session with a task-specific system prompt
  (defined in `src/transform-prompts.ts`) and returns a streaming
  result. The heavy modules (`@huggingface/transformers` + polyfill)
  are loaded once per page via the module-scoped cache in
  `src/heavy.ts`, shared with the chat session.
- **Preview component.** `src/ui/preview.ts` mounts inside the chat
  panel and replaces the messages list while a transform is active.
  It renders the original selection on top and the streamed result
  below, with Apply / Discard buttons and Escape-to-discard.
- **DOM apply layer.** `src/dom-apply.ts` handles the three target
  branches: `setRangeText` for `<input>` / `<textarea>` (plus a
  synthetic `input` event so React/Vue see the change),
  `execCommand('insertText')` for `contenteditable` (preserving
  native undo, with a `Range`-mutation fallback), and
  `deleteContents` + `insertNode(createTextNode)` for read-only
  prose. No `innerHTML` is used anywhere in the apply path.

## Architecture Decision Records

### ADR-001: Why `content.ts` compiles as IIFE

MV3 content scripts cannot be ESM modules — they are injected into host pages
that may not be module-aware. `build.mjs` sets `format: 'iife'` for
`content.ts`. The `src/` modules are bundled in by esbuild at build time.
`background.ts` uses `format: 'esm'` because service workers support ESM.

### ADR-002: Why ORT wasm files are copied to `dist/ort/`

MV3 content-script CSP forbids `eval()` and remote dynamic imports. Transformers.js
normally fetches ONNX Runtime Web wasm files from `jsdelivr.net` at runtime.
Bundling them locally and serving via `chrome.runtime.getURL` is the only
compliant path. The `web_accessible_resources` entry in `manifest.json` exposes
`dist/ort/*` to the content script's page context.

### ADR-003: Why the polyfill is vendored instead of npm-installed

The published `prompt-api-polyfill@0.1.0` npm package ships only the Firebase
backend. The Transformers.js backend only exists on `main` in the upstream
GitHub repo. Additionally, we modify the polyfill (strip unused backends, remove
iframe-injection observer, raise max_new_tokens) in ways incompatible with
version-locked npm deps. Vendoring keeps the diffs visible in this repo.

### ADR-004: Why `heavyLoadPromise` is reset to null on failure

If `loadHeavy()` or `LanguageModel.create()` fails, the rejected promise must
not be cached. Without resetting, every subsequent `ensureSession()` call
returns the same rejected promise and the extension is permanently broken in
that tab without a page reload. Resetting to null allows the next panel open to
retry the full load sequence.

### ADR-005: Preview-then-apply for all write-side actions

Rewrite, translate, simplify, and summarize-in-place stream into a stacked
Preview component (original on top, model output below) with Apply / Discard
buttons. Apply replaces the captured `Range` in the page DOM; Discard leaves
the page untouched. Streaming directly into the page was rejected — every
contenteditable framework intercepts native edits differently and bad model
output is hard to undo cleanly.

### ADR-006: Ephemeral `LanguageModel` sessions for transforms

Each write-side action creates a fresh `LanguageModel` session via
`LanguageModel.create({ initialPrompts: [{ role: 'system', content: <prompt> }] })`.
The long-lived chat session is untouched. Transforms are commits, not
conversations — they do not write to chat history. The heavy modules are
shared via `src/heavy.ts`, so setup cost is paid once per page lifetime.

### ADR-007: Selection snapshot via `Range.cloneRange` (with input/textarea branch)

The content script snapshots the current selection on `contextmenu` and on
the matching `keydown`. For regular DOM selections the snapshot is a cloned
`Range` plus the selection text; for `<input>` and `<textarea>` it is a
`{ element, selectionStart, selectionEnd, text }` tuple. The snapshot
survives the user clicking into the panel.

### ADR-008: Hotkey selection for v0.2

Chrome's manifest caps `commands` at 4. The slot already used by
`toggle_ai_palette` plus three new commands fill the budget:
`ask_about_selection` (Ctrl+Shift+L), `rewrite_selection` (Ctrl+Shift+I),
and `translate_selection` (Ctrl+Shift+U). All other action variants are
reachable only through the right-click menu in v0.2. Users may rebind any
chord at `chrome://extensions/shortcuts`.

### ADR-009: `Summarize this page` is a synthetic chat turn

`Summarize this page` reuses the existing chat send path rather than running
through `runTransform`. The content script focuses the input, sets its value
to `Summarize this page.`, and triggers the existing send pipeline so the
existing `isFirstTurn` logic auto-prepends the page excerpt. The result is
part of chat history, so the user can ask follow-ups naturally.

### ADR-010: Selection length cap

Selection text passed to a transform — or used as `Ask` context — is capped
at 1500 characters, matching `PAGE_CONTEXT_BODY_LIMIT`. If the selection
exceeds the cap, the Preview displays an error message instead of starting
the model. The threshold is exported as a named `SELECTION_LIMIT` constant
so a future release can lift it without grep-and-replace.

### ADR-011: XSS hygiene in the apply layer

The apply layer never uses `innerHTML`. The three branches are
`setRangeText` for `<input>` / `<textarea>`,
`execCommand('insertText')` for `contenteditable` (with a `Range`-mutation
fallback), and `range.deleteContents()` + `range.insertNode(createTextNode)`
for read-only prose. Every path constructs a text node, so model output is
never interpreted as HTML. Unit tests assert the resulting node is a `Text`
node when given `<script>` payloads.

### ADR-012: One transform at a time

Only one transform may stream at a time. Triggering a new transform while
one is in flight aborts the in-flight one
(`activeTransformAbort.abort()`) and starts the new one. Discard during
streaming also aborts. This matches the chat panel's Send/Stop semantics
and is simpler than queueing.
