# Chrome Web Store submission

Working notes and copy for publishing this extension. Build the upload with `npm run package` → `web-store/local-nano-v<version>.zip`.

## Listing fields

- **Name:** `Local Nano` (manifest `name` and the in-panel window header), matching the repo and hero-art branding.
- **Summary (≤132 chars):** On-device AI assistant. Ask about any page or rewrite highlighted text in place — runs a local LLM in your browser, nothing leaves your device.
- **Category:** Productivity (alt: Developer Tools).
- **Language:** English.
- **Privacy policy URL:** <https://privacy.hatstack.fun>

### Detailed description (draft)

> Local Nano puts a private AI assistant one keypress away on every page — and it runs the model entirely in your browser. No account, no API key, no data sent to a server.
>
> Press Ctrl+Shift+K (Cmd+Shift+K on Mac) to open the panel. Ask a question about the page you're on, or highlight a sentence and tell it how to rewrite it — the rewrite streams directly back into the page.
>
> How it stays private: inference runs locally via WebGPU (with a CPU fallback) using Transformers.js and ONNX Runtime Web. The only network request the extension makes is a one-time download of the open model weights from Hugging Face, which are then cached on your device. Your page content, prompts, and chat history never leave your machine.
>
> First run downloads the model (a few GB) and takes 30–90 seconds; after that it loads from cache. A modern GPU with a few GB of VRAM is recommended; low-memory machines can switch to CPU mode.

## Data-use disclosures (dashboard "Privacy practices" tab)

- **Single purpose:** "An on-device AI assistant for the current web page: answer questions about the page and rewrite user-selected text in place, with all inference running locally."
- **Data collected:** none. The extension does not collect, transmit, or sell any user data. Page content and prompts are processed locally and never sent to a remote server.
- **Remote code:** none. All executable code (content script, service worker, offscreen document, ONNX Runtime WASM under `dist/ort/`) ships inside the package. The Hugging Face requests fetch **model weight data**, not code, which is fed to the locally-bundled inference engine.

## Permission justifications

Paste one per permission in the dashboard.

- **`storage`** — Persists per-URL chat history locally via `chrome.storage.local` so a conversation survives navigation and reload. Never synced or transmitted.
- **`offscreen`** — Hosts the long-lived LLM session in an offscreen document so the model loads once and is shared across tabs instead of reloading on every navigation. WebGPU/WASM inference cannot run in the service worker.
- **Host permission `https://huggingface.co/*`, `https://*.huggingface.co/*`, `https://cdn-lfs.huggingface.co/*`** — One-time download of the open model weights, cached locally thereafter. This is the extension's only outbound network access. No other hosts are contacted.
- **Content script on `<all_urls>`** — The assistant panel must be injectable on any page the user opens it on (it's a general-purpose page assistant), and reads the current page's visible text to answer questions about it / applies the user's requested in-place rewrites. Reading happens only within the page's own context; nothing is exfiltrated.

Note: `activeTab` and `scripting` were removed — the declarative `<all_urls>` content script grants the page access the extension actually uses, and nothing calls the `chrome.scripting` API.

## CSP note

`content_security_policy.extension_pages` includes `'wasm-unsafe-eval'`, required by ONNX Runtime Web to instantiate its WebAssembly module. This is permitted under MV3; justification if asked: "WebAssembly execution for on-device machine-learning inference."

## Asset checklist

- [x] Icon — `icons/icon{16,32,48,128}.png`, generated from `icons/icon-source.png` via ffmpeg in `scripts/make-icons.mjs` (`npm run icons`). There is no `icons/icon.svg`. Wired into `manifest.json`.
- [ ] **Screenshots** — 1280×800 (or 640×400) PNG/JPG, at least one. Capture the panel open on a real page: (1) asking a question about the page, (2) a highlighted-text rewrite mid-stream with the Undo/Accept bar. Requires running the unpacked extension in Chrome.
- [ ] **Small promo tile** (optional, 440×280) — only needed for featuring.
- [x] Store name decision — **Local Nano** (manifest `name`, in-panel window header, and listing all aligned).

## Pre-submit smoke test

CI cannot exercise WebGPU. Before uploading, load the unpacked extension and confirm: panel opens on Ctrl+Shift+K, a chat answer streams, a highlighted-text rewrite applies in place, Undo restores it. See `docs/transform.md#verification-status`.

## Build and upload

1. `npm run package` — produces `web-store/local-nano-v<version>.zip` (manifest + `dist/` + `icons/`; ~19 MB, mostly the ONNX WASM runtime).
1. Upload the zip in the Developer Dashboard, fill the listing fields and privacy practices above, attach screenshots, submit for review.
1. Bump `version` in both `manifest.json` and `package.json` for each subsequent upload (the store rejects duplicate version numbers).
