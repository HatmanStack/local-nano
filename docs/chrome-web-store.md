# Chrome Web Store submission

Working notes and copy for publishing this extension. Build the upload with `npm run package` → `web-store/local-nano-v<version>.zip`.

## Listing fields

- **Name:** `Local Nano` (manifest `name` and the in-panel window header), matching the repo and hero-art branding.
- **Summary (≤132 chars):** On-device AI: ask about any page or rewrite selected text in place. A local LLM runs in your browser — nothing leaves your device.
- **Category:** Productivity (alt: Developer Tools).
- **Language:** English.
- **Privacy policy URL:** <https://privacy.hatstack.fun>

### Detailed description (draft)

> Local Nano is a private AI assistant that lives one click away on every page. The language model runs entirely inside your browser. No account, no API key, no servers, no data collection, and no remote code. Everything that runs ships inside the package.
>
> How to open it
>
> Click the Local Nano icon next to the address bar.
>
> Or press Ctrl+Shift+K (Cmd+Shift+K on Mac). On a fresh install the shortcut may need to be bound once at chrome://extensions/shortcuts. The icon's tooltip shows the current binding, and the icon works without one.
>
> What you can do
>
> Ask about the page you're on. Your question is answered using the page's visible text as context. The chat is DOM aware.
>
> Rewrite selected text in place. Highlight a sentence, tell Local Nano how to change it, and the rewrite streams directly back into the page. One click Undo restores the original.
>
> Choose your model. A gear popover offers a curated catalog of on-device models. Pick one, click Load to switch. Your choice persists across sessions.
>
> Reclaim memory when you walk away. After a configurable idle period (5, 15, 60 minutes, or Never) the model is released from VRAM. The next use re-warms automatically.
>
> How it stays private
>
> All inference runs locally via WebGPU, with an automatic CPU/WASM fallback. The runtime is Transformers.js and ONNX Runtime Web, both bundled inside the extension. The only network request Local Nano ever makes is the one-time download of the open model weights from Hugging Face, which are cached on your device afterward. Your page content, prompts, and chat history never leave your machine. No telemetry. No analytics. No remote scripts.
>
> What to expect
>
> The first run downloads the model (a few GB) with a real-time percentage indicator and takes roughly 30 to 90 seconds. After that it loads from cache. A modern GPU with a few GB of memory is recommended. If the model can't load at full quality, Local Nano automatically tries lighter precision and CPU modes. If your device can't run it at all, it tells you clearly and gives you a copyable diagnostic. Nothing in the diagnostic leaves your device automatically.
>
> Open and on-device. For anyone who wants a quick AI helper on the pages they're reading without handing their browsing or their text to a cloud service.

## Data-use disclosures (dashboard "Privacy practices" tab)

- **Single purpose:** "An on-device AI assistant for the current web page: answer questions about the page and rewrite user-selected text in place, with all inference running locally."
- **Data collected:** none. The extension does not collect, transmit, or sell any user data. Page content and prompts are processed locally and never sent to a remote server.
- **Remote code:** none. All executable code (content script, service worker, offscreen document, ONNX Runtime WASM under `dist/ort/`) ships inside the package. The Hugging Face requests fetch **model weight data**, not code, which is fed to the locally-bundled inference engine.

## Permission justifications

Paste one per permission in the dashboard.

- **`storage`** — Persists per-URL chat history locally via `chrome.storage.local` so a conversation survives navigation and reload. Never synced or transmitted.
- **`offscreen`** — Hosts the long-lived LLM session in an offscreen document so the model loads once and is shared across tabs instead of reloading on every navigation. WebGPU/WASM inference cannot run in the service worker.
- **`alarms`** — Schedules an inactivity timer that releases the in-memory model and closes the offscreen document to reclaim memory after a configurable idle period. Backed by `chrome.alarms` so it survives MV3 service-worker eviction; the alarm fires only a local check and accesses no network.
- **Host permission `https://huggingface.co/*`, `https://*.huggingface.co/*`, `https://cdn-lfs.huggingface.co/*`** — One-time download of the open model weights, cached locally thereafter. This is the extension's only outbound network access. No other hosts are contacted.
- **Content script on `<all_urls>`** — The assistant panel must be injectable on any page the user opens it on (it's a general-purpose page assistant), and reads the current page's visible text to answer questions about it / applies the user's requested in-place rewrites. Reading happens only within the page's own context; nothing is exfiltrated.

Note: `activeTab` and `scripting` were removed — the declarative `<all_urls>` content script grants the page access the extension actually uses, and nothing calls the `chrome.scripting` API.

## CSP note

`content_security_policy.extension_pages` includes `'wasm-unsafe-eval'`, required by ONNX Runtime Web to instantiate its WebAssembly module. This is permitted under MV3; justification if asked: "WebAssembly execution for on-device machine-learning inference."

## Asset checklist

- [x] Icon — `icons/icon{16,32,48,128}.png`, generated from `icons/icon-source.png` via ffmpeg in `scripts/make-icons.mjs` (`npm run icons`). There is no `icons/icon.svg`. Wired into `manifest.json`.
- [ ] **Screenshots** — 1280×800 (or 640×400) PNG/JPG, at least one. Capture the panel open on a real page: (1) asking a question about the page, (2) a highlighted-text rewrite mid-stream with the Undo/Accept bar. Requires running the unpacked extension in Chrome.
- [x] **Small promo tile** (440×280) — `web-store/promo-tile-440x280.png`, generated from `well_done.jpg` hero art via ffmpeg (scale-to-cover + center-crop).
- [x] Store name decision — **Local Nano** (manifest `name`, in-panel window header, and listing all aligned).

## Pre-submit smoke test

CI cannot exercise WebGPU. Before uploading, load the unpacked extension and confirm: panel opens on Ctrl+Shift+K, a chat answer streams, a highlighted-text rewrite applies in place, Undo restores it. See `docs/transform.md#verification-status`.

## Build and upload

1. `npm run package` — produces `web-store/local-nano-v<version>.zip` (manifest + `dist/` + `icons/`; ~19 MB, mostly the ONNX WASM runtime).
1. Upload the zip in the Developer Dashboard, fill the listing fields and privacy practices above, attach screenshots, submit for review.
1. Bump `version` in both `manifest.json` and `package.json` for each subsequent upload (the store rejects duplicate version numbers).
