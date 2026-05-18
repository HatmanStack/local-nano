# Development

## Requirements

- Node.js 20+
- Chrome 120+ (for WebGPU and MV3 service worker support)
- ~10 GB free disk if you want to try a few different model variants — the Hugging Face cache adds up

## Setup

```bash
git clone https://github.com/HatmanStack/local-nano.git
cd local-nano
npm install
cp .env.example.json .env.json
npm run build
```

Then load `local-nano/` as an unpacked extension at `chrome://extensions` (Developer mode → Load unpacked).

## Iteration loop

```bash
npm run watch
```

This runs esbuild in watch mode. After each save, refresh the extension at `chrome://extensions` (the reload arrow on the extension card) and reload the page where you're testing. The content script doesn't hot-reload — you have to refresh the tab to re-inject the new bundle.

## Scripts

| Command              | What it does                                                  |
| -------------------- | ------------------------------------------------------------- |
| `npm run build`      | One-shot esbuild bundle into `dist/`, plus ORT wasm copy      |
| `npm run watch`      | Same but in watch mode                                        |
| `npm run typecheck`  | `tsc --noEmit` over `*.ts` and `src/**/*.ts`                  |
| `npm test`           | Run the Vitest unit suite once                                |
| `npm run test:watch` | Vitest in watch mode                                          |
| `npm run coverage`   | Vitest run + v8 coverage report, enforcing the thresholds set in `vitest.config.ts` |

## Debugging

- **Content script logs.** Open DevTools on the page itself. The extension prefixes everything with `[local-nano]`.
- **Service worker logs.** Click the **service worker** link on the extension's card at `chrome://extensions`. That opens a dedicated DevTools for the worker.
- **Storage.** Inspect persisted chat history at DevTools → Application → Storage → Extension Storage.
- **Model download progress.** The panel shows `Loading model… NN%` while weights are coming down. If you see a permission error, the host permissions in `manifest.json` are the place to look — Transformers.js fetches from `huggingface.co` and `cdn-lfs.huggingface.co`.

## Project layout

```
.
├── background.ts          # MV3 service worker entry
├── content.ts             # Content script entry — DOM + session glue
├── src/
│   ├── background/handler.ts
│   ├── history.ts
│   ├── pageContext.ts
│   ├── system.ts
│   └── ui/
│       ├── messages.ts
│       └── state.ts
├── tests/                 # Vitest unit tests
├── vendor/                # Vendored Prompt API polyfill
├── build.mjs              # esbuild driver
├── manifest.json          # MV3 manifest
└── .env.example.json      # Template for .env.json
```

## A word on the bundle size

`dist/content.js` is ~1.5 MB because it inlines the Transformers.js runtime. That's expected. The model weights themselves are much larger and are fetched at runtime from Hugging Face, not bundled.
