# Architecture

`local-nano` is a Chrome Manifest V3 extension with three moving pieces:

1. A **background service worker** that listens for the keyboard shortcut.
2. A **content script** injected into every page; it owns the chat UI and runs the model.
3. A vendored **Prompt API polyfill** that exposes the W3C-proposed `LanguageModel` interface backed by Transformers.js + ONNX Runtime Web.

```
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

| Concern              | File                                  |
| -------------------- | ------------------------------------- |
| Keyboard shortcut    | `background.ts` + `src/background/handler.ts` |
| Panel DOM + dragging | `content.ts`                          |
| Session lifecycle    | `src/session.ts`                      |
| Message rendering    | `src/ui/messages.ts`                  |
| Send/Stop button     | `src/ui/state.ts`                     |
| Page context prompt  | `src/pageContext.ts`                  |
| System instruction   | `src/system.ts`                       |
| History persistence  | `src/history.ts`                      |
| Polyfill + backend   | `vendor/prompt-api-polyfill/`         |
| Build                | `build.mjs`                           |
| Manifest             | `manifest.json`                       |

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
