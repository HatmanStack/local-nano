# Prompt API polyfill

`local-nano` is built around the **Prompt API** — an early-stage W3C explainer for a browser-native `LanguageModel` interface that lets pages run on-device LLMs without writing a model runtime themselves. Chrome ships an experimental implementation on Chromebook Plus hardware (gated behind a feature flag); other browsers don't have it yet. Until that situation changes, we provide the same `LanguageModel` global via a polyfill backed by Transformers.js + ONNX Runtime Web.

The upshot is that the application code in `content.ts` looks like it's calling a browser API, and the day a browser actually ships one this extension can switch to it with minimal changes.

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
- **`prompt-api-polyfill.js`** — the iframe-injection block was removed. Upstream patches `HTMLIFrameElement.prototype.contentWindow` and installs a `MutationObserver` on `documentElement` to inject itself into iframes. In a content-script context that's unnecessary (the extension can be configured to inject directly into iframes via the manifest) and very expensive on SPAs with frequent DOM mutations — every page mutation woke the observer.
- **`backends/transformers.js`** — `max_new_tokens` raised from 1024 to 2048. See [`docs/models.md`](models.md#on-max_new_tokens) for the tradeoff.

## How it's wired in

[`content.ts`](../content.ts) lazy-imports the polyfill alongside `@huggingface/transformers` on first hotkey toggle:

```ts
const [tfMod, polyfillMod] = await Promise.all([
  import('@huggingface/transformers'),
  import('./vendor/prompt-api-polyfill/prompt-api-polyfill.js'),
]);
```

The polyfill installs itself onto `globalThis.LanguageModel` at module load. We use the `LanguageModel` class exported directly from the module — not the global — so we never accidentally pick up a gated native implementation on hardware where it exists but doesn't actually run.

Configuration flows through the polyfill via `window.TRANSFORMERS_CONFIG`, which `content.ts` populates from [`.env.json`](../.env.example.json). The polyfill's Transformers backend reads `device`, `dtype`, and `modelName` from there.

The session itself is created once on first toggle and reused across every conversation turn:

- `expectedInputs` / `expectedOutputs` advertise text-only English to the polyfill.
- `initialPrompts: [{ role: 'system', content: SYSTEM_INSTRUCTION }]` seeds the system instruction from [`src/system.ts`](../src/system.ts). The polyfill normalizes the system role across model families — for Gemma (which has no native system role) it merges the content into the first user turn.
- `monitor(target)` receives `downloadprogress` events while weights stream in. The polyfill normalizes `e.loaded` to a 0–1 fraction; that's what drives the `Loading model… NN%` status.

Every user turn calls `session.promptStreaming(input, { signal })`, returning a `ReadableStream` of string chunks that we append to the DOM in real time. The `AbortController` wired to the Stop button cancels mid-generation.

## When native lands

The polyfill installs over the native binding when both exist, so today the extension behaves identically on Chromebook Plus and on every other Chrome. That's deliberate — a consistent model across machines is more valuable for now than a marginal performance win on a narrow hardware tier.

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
