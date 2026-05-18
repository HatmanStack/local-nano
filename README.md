<p align="center">
  <img src="well_done.jpg" alt="local-nano" width="700">
</p>

<p align="center">
  <a href="https://github.com/HatmanStack/local-nano/actions/workflows/ci.yml"><img src="https://github.com/HatmanStack/local-nano/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
  <img src="https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome MV3">
  <img src="https://img.shields.io/badge/Runs-100%25%20local-success" alt="Runs 100% local">
  <img src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white" alt="Tested with Vitest">
</p>

<p align="center">
  <a href="docs/architecture.md">Architecture</a> · <a href="docs/configuration.md">Configuration</a> · <a href="docs/models.md">Models</a> · <a href="docs/privacy.md">Privacy</a>
</p>

A Chrome extension that puts a small, **fully local** AI assistant on every page you visit. Press a keyboard shortcut, a chat panel slides in, and an in-browser language model answers questions about the page you're reading — no API keys, no servers, no data leaving your machine after the model is downloaded.

> Status: experimental. Tested in Chrome 120+ on desktop. Performance depends heavily on your GPU and the model you pick.

## Highlights

- **Runs in the browser, not the cloud.** Inference happens on-device via [Transformers.js](https://huggingface.co/docs/transformers.js) and the [ONNX Runtime Web](https://onnxruntime.ai/) WebAssembly/WebGPU backend.
- **Built on the proposed Prompt API.** Uses Google's [`prompt-api-polyfill`](https://github.com/webmachinelearning/prompt-api) so the same code can target a native `LanguageModel` once browsers ship it.
- **Per-tab chat history.** Conversations are scoped per URL and persisted in `chrome.storage.local`.
- **Streaming + stop.** Tokens stream in as they're generated; you can interrupt mid-response.
- **Page-aware first turn.** The model gets the page's title, URL, and a body excerpt on the first question of a conversation.

## Install (from source)

This isn't on the Chrome Web Store. To try it:

```bash
git clone https://github.com/HatmanStack/local-nano.git
cd local-nano
npm install
cp .env.example.json .env.json   # adjust the model / dtype / device if you like
npm run build
```

Then in Chrome:

1. Visit `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and pick this repository's root directory.
4. (Optional) bind the keyboard shortcut at `chrome://extensions/shortcuts`. Default is **Ctrl + Shift + K** (Cmd + Shift + K on macOS).

Open any page, press the shortcut, and ask away. The first time you toggle the panel the model downloads (hundreds of MB to a few GB depending on which one you chose) — subsequent loads are cached.

## Configuration

Configuration lives in `.env.json` at the repo root. See [`.env.example.json`](.env.example.json) for the defaults:

```json
{
  "apiKey": "dummy",
  "device": "webgpu",
  "dtype": "q4",
  "modelName": "onnx-community/Qwen3.5-0.8B-ONNX"
}
```

Details and tradeoffs are in [docs/configuration.md](docs/configuration.md).

## Development

```bash
npm run watch       # esbuild in watch mode
npm run typecheck   # tsc --noEmit
npm test            # vitest, unit tests
npm run coverage    # tests + coverage report (thresholds enforced)
```

More in [docs/development.md](docs/development.md).

## Privacy

The model weights are fetched from Hugging Face's CDN on first run. After that, prompts, page content, and responses stay in your browser — they are not sent anywhere by this extension. See [docs/privacy.md](docs/privacy.md) for the full picture.

## Documentation

- [Architecture](docs/architecture.md) — components and data flow
- [Development](docs/development.md) — local setup, build, debugging
- [Configuration](docs/configuration.md) — model, device, dtype
- [Models & runtime notes](docs/models.md) — picking a model, running without WebGPU, ONNX op gotchas
- [Prompt API polyfill](docs/prompt-api.md) — what we vendor and how it's wired in
- [Privacy](docs/privacy.md) — what leaves your machine and what doesn't
- [Testing](docs/testing.md) — how the test suite is structured
- [Contributing](docs/contributing.md) — how to propose changes

## License

Apache-2.0 — see [LICENSE](LICENSE). The vendored polyfill under `vendor/prompt-api-polyfill/` is also Apache-2.0, copyright Google LLC.
