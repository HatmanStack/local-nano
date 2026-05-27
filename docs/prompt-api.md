# Prompt API polyfill

`local-nano` is built around the **Prompt API** — an early-stage W3C explainer for a browser-native `LanguageModel` interface that lets pages run on-device LLMs without writing a model runtime themselves. Chrome ships an experimental implementation on Chromebook Plus hardware (gated behind a feature flag); other browsers don't have it yet. Until that situation changes, we provide the same `LanguageModel` global via a polyfill backed by Transformers.js + ONNX Runtime Web.

The upshot is that the application code in the offscreen document (`offscreen.ts`) looks like it's calling a browser API, and the day a browser actually ships one this extension can switch to it with minimal changes.

## Upstream project

- **Polyfill repo:** [GoogleChromeLabs/web-ai-demos/prompt-api-polyfill](https://github.com/GoogleChromeLabs/web-ai-demos/tree/main/prompt-api-polyfill) (Apache-2.0, © Google LLC)
- **Proposal:** [webmachinelearning/prompt-api](https://github.com/webmachinelearning/prompt-api)
- **Chrome's developer guide:** [developer.chrome.com/docs/ai/prompt-api](https://developer.chrome.com/docs/ai/prompt-api)

## Why vendor instead of `npm install`

A pruned copy lives at [`vendor/prompt-api-polyfill/`](../vendor/prompt-api-polyfill/). It's checked into this repo rather than pulled from npm because:

1. The published npm package (`prompt-api-polyfill@0.1.0`) ships only the Firebase backend. The Transformers.js backend we need only exists on `main` in the upstream GitHub repo at the time of writing.
2. We modify the polyfill in ways an npm dep can't accommodate (stripping unused backends, removing iframe-injection code). Vendoring keeps those edits visible in this repo.

## What we changed

When pulling from upstream, these edits need to carry forward:

- **`backends-registry.js`** — slimmed to the Transformers.js backend only. Firebase / Gemini / OpenAI / WebLLM backends are removed so esbuild doesn't chase their transitive deps and so there's no code path that could reach a cloud LLM provider (a privacy-story claim — see [`docs/privacy.md`](privacy.md)).
- **`backends/` directory** — only `base.js`, `defaults.js`, and `transformers.js` are kept on disk; the others are deleted, not just unregistered.
- **`prompt-api-polyfill.js`** — the iframe-injection block was removed. Upstream patches `HTMLIFrameElement.prototype.contentWindow` and installs a `MutationObserver` on `documentElement` to inject itself into iframes. In the offscreen-document context that's unnecessary and was very expensive on SPAs with frequent DOM mutations — every page mutation woke the observer.
- **`prompt-api-polyfill.js`** — `get contextWindow()` returns `131072` (the gemma-4-E2B-it-ONNX ~128K window), not the upstream `1000000`. The upstream literal was so far above the real model limit that the built-in overflow guard never fired near the true boundary. See `prompt-api-polyfill.js:103-112`.
- **`prompt-api-polyfill.js`** — `promptStreaming` threads the caller's `options.signal` into `generateContentStream(requestContents, signal)` (`prompt-api-polyfill.js:949-955`) so Stop halts ONNX decoding, not just the consumer loop. Additive and degrade-safe.
- **`backends/transformers.js`** — `generateContentStream(contents, signal)` accepts the abort signal and attaches it as a `stopping_criteria` to the `generator(...)` call (`transformers.js:21-33,227-272`). Guarded: if `StoppingCriteria` is unavailable it returns null and behavior degrades to upstream; the no-signal options object is byte-identical to upstream.
- **`backends/transformers.js`** — `max_new_tokens` raised from 1024 to 2048. See [`docs/models.md`](models.md#on-max_new_tokens) for the tradeoff.

## Resync procedure

When pulling a new upstream commit of the polyfill:

1. Download `prompt-api-polyfill.js` from upstream into the vendor tree:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/GoogleChromeLabs/web-ai-demos/main/prompt-api-polyfill/prompt-api-polyfill.js \
     -o vendor/prompt-api-polyfill/prompt-api-polyfill.js
   ```

1. Check the header comment (lines 1–30) for new backends; keep only the Transformers.js backend listing.

1. Search for `HTMLIFrameElement.prototype` or `MutationObserver` near the top; delete the iframe-injection block if present (removed to prevent SPA performance regressions — see ADR in `docs/architecture.md`).

1. Re-apply the `get contextWindow()` delta: set the return to `131072` (was `1000000` upstream) so the built-in `contextoverflow` guard fires near the real model boundary.

1. Re-apply the abort-signal delta in `promptStreaming`: pass the caller's `options.signal` into the backend call (`generateContentStream(requestContents, signal)`).

1. Download `backends/transformers.js` from upstream:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/GoogleChromeLabs/web-ai-demos/main/prompt-api-polyfill/backends/transformers.js \
     -o vendor/prompt-api-polyfill/backends/transformers.js
   ```

1. In `backends/transformers.js`, verify `max_new_tokens` is 2048; raise it if the upstream reset it to 1024.

1. Re-apply the abort-signal delta in `backends/transformers.js`: make `generateContentStream` accept a second `signal` argument and attach it as a `stopping_criteria` (guarded so a transformers.js version without `StoppingCriteria` degrades to current behavior, never throws).

1. Verify `backends-registry.js` still only registers the `'transformers'` backend.

1. Run `npm run build` and smoke-test the extension in Chrome. Confirm `[local-nano/offscreen] heavy modules loaded` appears in the offscreen document's console.

## How it's wired in

[`offscreen.ts`](../offscreen.ts) lazy-imports the polyfill alongside `@huggingface/transformers` on the first stream request (`offscreen.ts:127-128`):

```ts
const [tfMod, polyfillMod] = await Promise.all([
  import('@huggingface/transformers'),
  import('./vendor/prompt-api-polyfill/prompt-api-polyfill.js'),
]);
```

The content script never loads these modules; it streams to the offscreen session over a `chrome.runtime.Port`.

The polyfill installs itself onto `globalThis.LanguageModel` at module load. We use the `LanguageModel` class exported directly from the module — not the global — so we never accidentally pick up a gated native implementation on hardware where it exists but doesn't actually run.

Configuration flows through the polyfill via `window.TRANSFORMERS_CONFIG`, which the offscreen document populates: `offscreen.ts:21` does `import transformersConfig from './.env.json'` and `offscreen.ts:133` assigns it to `window.TRANSFORMERS_CONFIG`. The polyfill's Transformers backend reads `device`, `dtype`, and `modelName` from there. The content script does not touch the config.

The session itself is created once (`ensureSession`) and reused across every conversation turn and every tab:

- `expectedInputs` / `expectedOutputs` advertise text-only English to the polyfill.
- `initialPrompts` seeds a system turn with the hardcoded literal in `offscreen.ts:81` — `'You are a helpful assistant. Answer concisely and directly.'` — followed by any restored history turns (`buildInitialPrompts`, `offscreen.ts:150`). The polyfill normalizes the system role across model families — for Gemma (which has no native system role) it merges the content into the first user turn.
- A `monitor` IS wired in (ADR-R10, shipped 0.3.0): when the session is created with progress reporting, `offscreen.ts` passes a `monitor` into `LanguageModel.create()` whose `downloadprogress` events are relayed by `broadcastProgress` over the `STREAM_PROGRESS` port to the panel. The panel renders progress in phases: the real download percent as `'Downloading model NN%'`, then an indeterminate `'Loading into GPU…'` once the percent reaches 100 while the warmup is still pending, and — when no progress frame has arrived yet — a live elapsed-seconds counter starting at `'Loading model… 0s'` (`src/session.ts:1273`) that ticks up and, after ~45s, appends "taking longer than usual" remedies (`elapsedHint`, `src/session.ts:1286`). This matches the "Phased first-run download progress" entry in the 0.3.0 changelog. The percent/text parser lives in `src/offscreen/progress.ts`.

Every turn calls `session.promptStreaming(input, { signal })` in the offscreen document, returning a `ReadableStream` of string chunks that are posted over the port and appended to the DOM in real time. The `AbortController` wired to the Stop button cancels mid-generation; the signal is threaded into the offscreen generator so decoding actually halts.

## When native lands

The polyfill's install guard skips globalThis assignment when a native `LanguageModel` is already present. This extension bypasses that guard entirely — the offscreen document imports and uses the module-exported `LanguageModel` directly, so behavior is identical on Chromebook Plus and on every other Chrome. That's deliberate — a consistent model across machines is more valuable for now than a marginal performance win on a narrow hardware tier.

Once native is widely available, the natural change is to gate the polyfill load behind a real availability check:

```ts
const native = 'LanguageModel' in globalThis
  ? await (globalThis as any).LanguageModel.availability({/* … */})
  : 'unavailable';

if (native === 'available') {
  // use globalThis.LanguageModel directly — skip the polyfill import
} else {
  await loadHeavy(); // existing path: polyfill + Transformers.js
}
```

The application code calling `session.promptStreaming(...)` would not change.
