# Architecture

`local-nano` is a Chrome Manifest V3 extension with four moving pieces:

1. A **background service worker** (`background.ts`) that listens for the keyboard shortcut and ensures the offscreen document exists.
1. A **content script** (`content.ts`) injected into every page; it owns the chat UI. It does NOT run the model — it streams to the offscreen session over a `chrome.runtime.Port`.
1. An **offscreen document** (`offscreen.ts`) that hosts the single long-lived `LanguageModel` session. This is the actual model host: it loads the heavy modules and runs inference.
1. A vendored **Prompt API polyfill** that exposes the W3C-proposed `LanguageModel` interface backed by Transformers.js + ONNX Runtime Web. It loads inside the offscreen document.

```text
                ┌──────────────────────┐         ┌──────────────────────────┐
   Ctrl+Shift+K │ background.ts        │ message │ content.ts (per tab)     │
  ───────────▶  │  chrome.commands     │ ──────▶ │  owns the chat UI / DOM  │
                │  onCommand listener  │ {a:'…'} │  streams tokens to DOM   │
                │  ensures offscreen   │         └──────────────────────────┘
                │  (src/background/    │                    │
                │   offscreen.ts)      │                    │ chrome.runtime.Port
                └──────────────────────┘                    │ (src/offscreen/client.ts)
                          │                                  ▼
                          │ createDocument       ┌──────────────────────────┐
                          ▼                      │ offscreen.ts             │
              ┌──────────────────────┐           │  loadHeavy / ensureSession│
              │ chrome.offscreen     │ ────────▶ │  hosts the single shared  │
              │  (hidden document)   │           │  LanguageModel session    │
              └──────────────────────┘           │  runs the model           │
                                                 └──────────────────────────┘
                                                            │
                                                            │ imports
                                                            ▼
                                          ┌─────────────────────────────────┐
                                          │ vendor/prompt-api-polyfill/      │
                                          │   LanguageModel                  │
                                          │     └─ TransformersBackend       │
                                          │          └─ @huggingface/        │
                                          │             transformers + ORT   │
                                          └─────────────────────────────────┘
```

## Background service worker (`background.ts`)

Tiny. It registers a `chrome.commands.onCommand` listener that, on the `toggle_ai_palette` command, looks up the active tab and sends a `{ a: 'toggle' }` message to the content script. The handler logic lives in [`src/background/handler.ts`](../src/background/handler.ts) so it can be unit-tested. It also installs the offscreen-ensure listener from [`src/background/offscreen.ts`](../src/background/offscreen.ts): content scripts cannot call `chrome.offscreen.*`, so they ask the worker to create the offscreen document via `chrome.offscreen.createDocument`.

## Content script (`content.ts`)

Loaded on `<all_urls>`. On import it:

1. Inserts a `<style>` element for the typing-indicator animation.
1. Builds the chat panel DOM (hidden by default), with a draggable header, message list, input, and Send/Stop button.
1. Restores prior history for this URL from `chrome.storage.local`.
1. Subscribes to `chrome.runtime.onMessage` for the toggle ping.

It does **not** load or run the model. `content.ts` imports only `src/selection-rewrite.js`, `src/session.js`, and `src/ui/state.js`. The model lives in the offscreen document; the content script streams to it over a `chrome.runtime.Port` opened by [`src/offscreen/client.ts`](../src/offscreen/client.ts). The first time you toggle the panel, the session layer asks the service worker to ensure the offscreen document exists and warms the offscreen session; subsequent toggles reuse the same shared session.

When you send a message:

- On the **first turn** per URL, the prompt is prefixed with `pageContext()` — the page title, URL, and a body excerpt (capped at 1500 chars).
- Subsequent turns send only the user's text; conversation continuity is the offscreen polyfill session's responsibility.
- Responses stream back over the port: the offscreen document calls `promptStreaming()` and posts `StreamChunk` frames, which the content script appends to the rendered message. An `AbortController` lets the Stop button cancel mid-stream (the abort is threaded into the offscreen generator).

## Offscreen document (`offscreen.ts`)

The offscreen document is the actual model host. The service worker creates it once via `chrome.offscreen.createDocument` and never tears it down — keeping the model warm is the whole point. On the first stream request it calls `loadHeavy()`, which dynamically imports `@huggingface/transformers` and the polyfill (`offscreen.ts:64-67`), sets the ONNX wasm path to the bundled `dist/ort/` copy, and injects the config (see below). `ensureSession()` then creates the single long-lived `LanguageModel` session, shared across all tabs and URLs. A second concurrent stream on the shared session is rejected with a busy error rather than queued (`src/offscreen/busy-gate.ts`).

## Prompt API polyfill

`vendor/prompt-api-polyfill/` is a slimmed copy of Google's polyfill, loaded inside the offscreen document. We strip every backend except Transformers.js (in `backends-registry.js`), remove the upstream iframe-injection block from `prompt-api-polyfill.js` (a `MutationObserver` over `documentElement` that was a meaningful perf cost on SPA-style host pages), and raise `max_new_tokens` from 1024 to 2048 in the Transformers backend. See [docs/prompt-api.md](prompt-api.md) for the full inventory of modifications and the resync procedure.

`TransformersBackend` (in `vendor/prompt-api-polyfill/backends/transformers.js`) wraps `@huggingface/transformers`'s `pipeline()` and `TextStreamer`. Configuration comes from `window.TRANSFORMERS_CONFIG`, which the offscreen document populates: `offscreen.ts:20` does `import transformersConfig from './.env.json'` and `offscreen.ts:71` assigns it to `window.TRANSFORMERS_CONFIG` (model name, device, dtype). The content script never touches the config.

## Why a service worker, a content script, and an offscreen document?

MV3 doesn't let content scripts register global keyboard shortcuts — only the background service worker can. MV3 service workers are also short-lived and have no DOM, so they cannot host a long-lived WebGPU/ONNX session. The offscreen document is a persistent, DOM-bearing context the model can live in. The split — background owns the hotkey and the offscreen lifecycle, content owns the UI, the offscreen document owns the model — is the standard MV3 shape for on-device inference.

## Build pipeline

[`build.mjs`](../build.mjs) uses esbuild to bundle:

- `content.ts` → `dist/content.js` (IIFE — content scripts can't be ESM modules).
- `background.ts` → `dist/background.js` (ESM — the manifest declares `"type": "module"` for the worker).
- `offscreen.ts` → `dist/offscreen.js` (the heavy bundle that inlines Transformers.js).

Before building it copies the ONNX runtime `.wasm` / `.mjs` files into `dist/ort/`. Transformers.js would otherwise try to fetch them from jsdelivr at runtime, which the extension-page CSP forbids.

## What lives where

| Concern              | File                                  |
| -------------------- | ------------------------------------- |
| Keyboard shortcut    | `background.ts` + `src/background/handler.ts` |
| Offscreen lifecycle  | `src/background/offscreen.ts`         |
| Panel DOM + dragging | `content.ts`                          |
| Chat session lifecycle | `src/session.ts`                    |
| Model host + session | `offscreen.ts`                        |
| Offscreen client/protocol | `src/offscreen/`                 |
| Message rendering    | `src/ui/messages.ts`                  |
| Send/Stop button     | `src/ui/state.ts`                     |
| Page context prompt  | `src/pageContext.ts`                  |
| System instruction   | `offscreen.ts` (the seeded literal)   |
| History persistence  | `src/history.ts`                      |
| Polyfill + backend   | `vendor/prompt-api-polyfill/`         |
| Build                | `build.mjs`                           |
| Manifest             | `manifest.json`                       |

## Session Lifecycle

The lifecycle spans two contexts. The model session lives in the offscreen
document; the content-script chat layer holds per-page UI and history state in
the closure returned by `initSession()` in `src/session.ts`.

Offscreen state (`offscreen.ts`, module-scoped, shared across all tabs):

| Variable | Type | Description |
|----------|------|-------------|
| `heavyPromise` | `Promise \| null` | Memoizes the dynamic import of transformers + polyfill; nulled on failure to allow retry (`offscreen.ts:93`) |
| `sessionPromise` | `Promise \| null` | Memoizes the single shared `LanguageModel` session; nulled on failure to allow retry (`offscreen.ts:127`) |
| `generationGate` | `BusyGate` | Serializes the shared session: a second concurrent stream is rejected as busy |

Chat-layer state (`src/session.ts`, per content-script closure):

| Variable | Type | Description |
|----------|------|-------------|
| `history` | `Entry[]` | In-memory history array, persisted on every user/model turn |
| `activeAbort` | `AbortController \| null` | Non-null while a stream is in progress |
| `isFirstTurn` | `boolean` | True until the first `send()`; gates the page-context prefix (once per URL) |
| `warmStarted` | `boolean` | True once the warmup/preload has begun; reset on warmup failure to allow retry |
| `modelReady` | `boolean` | True after a successful warmup |
| `historyThreshold` | `number` | Token threshold for the history-pressure warning, derived from the queried GPU adapter |
| `cumulativeSentChars` | `number` | Running char count of prompts/responses actually sent, used to estimate token pressure |
| `warnedAboutHistory` | `boolean` | True once the one-time history-pressure advisory has shown |

### Lifecycle notes

**`isFirstTurn` and page reload:** When a page is reloaded, `restore()`
re-renders prior history entries from `chrome.storage.local` into the message
list and re-seeds the single shared offscreen session with this URL's restored
user/model turns via `rebuildSession` (system entries are dropped). So a
follow-up after reload does have conversational context. `isFirstTurn` is left
`true` deliberately: the first new turn still prefixes the **current** page's
context block so the model is grounded in the page in front of the user. The
page-context prefix is therefore sent once per content-script lifetime per URL,
which is the intended grounding behavior.

## Architecture Decision Records

### ADR-001: Why `content.ts` compiles as IIFE

MV3 content scripts cannot be ESM modules — they are injected into host pages
that may not be module-aware. `build.mjs` sets `format: 'iife'` for
`content.ts`. The `src/` modules are bundled in by esbuild at build time.
`background.ts` uses `format: 'esm'` because service workers support ESM.

### ADR-002: Why ORT wasm files are copied to `dist/ort/`

The MV3 extension-page CSP forbids `eval()` and remote dynamic imports.
Transformers.js normally fetches ONNX Runtime Web wasm files from `jsdelivr.net`
at runtime. Bundling them locally and serving via `chrome.runtime.getURL` is the
only compliant path. The offscreen document (where the runtime loads) reads them
through `chrome.runtime.getURL('dist/ort/')`; the `web_accessible_resources`
entry in `manifest.json` exposes `dist/ort/*`.

### ADR-003: Why the polyfill is vendored instead of npm-installed

The published `prompt-api-polyfill@0.1.0` npm package ships only the Firebase
backend. The Transformers.js backend only exists on `main` in the upstream
GitHub repo. Additionally, we modify the polyfill (strip unused backends, remove
iframe-injection observer, raise max_new_tokens) in ways incompatible with
version-locked npm deps. Vendoring keeps the diffs visible in this repo.

### ADR-004: Why the offscreen load promises are nulled on failure

If `loadHeavy()` or `LanguageModel.create()` fails, the rejected promise must
not be cached. `offscreen.ts` nulls `heavyPromise` (`offscreen.ts:93`) and
`sessionPromise` (`offscreen.ts:127`) in their respective `catch` blocks.
Without this, every subsequent `loadHeavy()` / `ensureSession()` call would
return the same rejected promise and the model would be permanently unloadable
until the offscreen document is recreated. Nulling on failure lets the next
warmup or stream request retry the full load sequence. (Before the 0.2.2
offscreen refactor this was a `heavyLoadPromise` closure variable inside
`src/session.ts`; the behavior moved with the model.)
