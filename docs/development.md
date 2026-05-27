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

## Dependency advisories

`npm audit` reports moderate advisories (6 as of 2026-05-27), all confined to the dev/CI-only `vitest → vite → esbuild` chain. Production exposure is zero — `npm audit --omit=dev` reports 0 vulnerabilities, and none of these packages ship in the extension bundle.

Remediation is deferred because the fix requires a Vitest major upgrade (a breaking change to the test toolchain). This is a tracked follow-up, not accepted production risk — revisit when bumping Vitest is otherwise warranted.

## Debugging

- **Content script logs.** Open DevTools on the page itself. The extension prefixes everything with `[local-nano]`.
- **Service worker logs.** Click the **service worker** link on the extension's card at `chrome://extensions`. That opens a dedicated DevTools for the worker.
- **Offscreen document logs.** The model runs in a hidden offscreen document. Its logs (prefixed `[local-nano/offscreen]`, including `heavy modules loaded`) appear in the offscreen document's own DevTools, reachable from `chrome://extensions` → the extension's **Inspect views** list (look for `offscreen.html`).
- **Storage.** Inspect persisted chat history at DevTools → Application → Storage → Extension Storage.
- **Model load progress.** While the model loads the panel shows a live elapsed-seconds counter (`Loading model… Ns`), not a percentage; after ~45s it appends "taking longer than usual" remedies. If you see a permission error, the host permissions in `manifest.json` are the place to look — Transformers.js fetches from `huggingface.co` and `cdn-lfs.huggingface.co`.

## Project layout

```text
.
├── background.ts          # MV3 service worker entry
├── content.ts             # Content script entry — chat UI / DOM glue
├── offscreen.ts           # Offscreen document entry — hosts the model session
├── offscreen.html         # Offscreen document shell
├── src/
│   ├── background/
│   │   ├── handler.ts
│   │   └── offscreen.ts   # Service-worker side of the offscreen lifecycle
│   ├── offscreen/         # client, protocol, stream-client, dispatch, busy-gate
│   ├── selection-rewrite.ts
│   ├── session.ts         # Content-script chat session lifecycle
│   ├── history.ts
│   ├── pageContext.ts
│   └── ui/
│       ├── messages.ts
│       └── state.ts
├── tests/                 # Vitest unit tests
├── vendor/                # Vendored Prompt API polyfill
├── build.mjs              # esbuild driver
├── manifest.json          # MV3 manifest
└── .env.example.json      # Template for .env.json
```

(Representative, not exhaustive.)

## A word on the bundle size

`dist/offscreen.js` is ~1.5 MB because it inlines the Transformers.js runtime — the model now runs in the offscreen document, so that is where the heavy code lands. `dist/content.js` is thin (~41 KB), the per-page chat-UI script. That split is expected. The model weights themselves are much larger and are fetched at runtime from Hugging Face, not bundled.
