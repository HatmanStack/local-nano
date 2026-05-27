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
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="docs/transform.md">Selection rewrite</a> ·
  <a href="docs/configuration.md">Configuration</a> ·
  <a href="docs/models.md">Models</a> ·
  <a href="docs/privacy.md">Privacy</a> ·
  <a href="docs/development.md">Development</a> ·
  <a href="docs/prompt-api.md">Prompt API</a> ·
  <a href="docs/testing.md">Testing</a> ·
  <a href="docs/contributing.md">Contributing</a>
</p>

A Chrome extension with a small, **fully local** AI assistant that **edits the page you're on**. Highlight any text, tell it how to change it, and an in-browser language model rewrites it in place — the new text streams straight into the page. It also answers questions about the page from the same panel. No API keys, no servers, no data leaving your machine after the model is downloaded.

> Status: experimental. Tested in Chrome 120+ on desktop. Runs on WebGPU when available and falls back to WASM CPU — see [docs/models.md](docs/models.md) for model and dtype tradeoffs in each mode.

## Highlights

- **Edits the live page.** Highlight text, type an instruction ("make this concise", "translate to French", "fix the grammar"), and the model rewrites it directly in the page — the tokens replace your selection in the DOM as they stream. Each edit gets Undo / Accept. Press `Esc` to ask *about* the selection instead of changing it. This is the core of the app; the chat is the complement.
- **Text in, text out.** It reads the page's text and writes text back — rewrites, edits, and answers. It does **not** read images on the page or generate any. The Gemma family is multimodal-capable upstream, but this build wires the model text-only; "rewrite this paragraph" works, "describe this photo" or "make me an image" do not.
- **Runs in the browser, not the cloud.** Inference happens on-device via [Transformers.js](https://huggingface.co/docs/transformers.js) and the [ONNX Runtime Web](https://onnxruntime.ai/) WebAssembly/WebGPU backend.
- **One model, shared across tabs.** The model loads once into a background (offscreen) document and is reused on every page instead of reloading on each navigation. It preloads the moment you open the panel.
- **Pick your model.** A gear popover in the panel header lists a curated catalog of on-device models; select one and click Load to switch. Your choice persists and survives extension updates.
- **Releases memory when idle.** After a configurable period of inactivity (5 / 15 / 60 minutes or Never, default 15) the offscreen model is released to reclaim its multi-GB WebGPU allocation, then re-warmed automatically on your next use.
- **Resilient on small GPUs.** On a model-LOAD failure it walks a dtype/device fallback ladder, warns before the conversation outgrows your VRAM, and offers a one-click Clear conversation; if every tier fails it surfaces a clear message with manual Retry / Reset. See [docs/transform.md](docs/transform.md).
- **Built on the proposed Prompt API.** Uses Google's [`prompt-api-polyfill`](https://github.com/GoogleChromeLabs/web-ai-demos/tree/main/prompt-api-polyfill) so the same code can target a native `LanguageModel` once browsers ship it.
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

Open any page, press the shortcut, and ask away. The first time you toggle the panel the model downloads (hundreds of MB to a few GB depending on which one you chose) and loads — subsequent loads are cached and start in the background as soon as the panel opens.

## Using it

- **Chat about the page.** Open the panel and type. The first turn includes the page's title, URL, and a body excerpt as context.
- **Rewrite a selection.** Highlight text on the page, then open the panel — the input switches to "Edit selection…" and a preview chip appears. Type an instruction ("make this concise", "translate to French") and press Enter; the rewrite streams into the page. Use **Undo** to revert or **Accept** to commit and move on.
- **Ask about a selection.** With text highlighted, press `Esc` in the input to flip to "Ask about selection…" — sending now answers a question about the text instead of editing it, leaving the page untouched.
- **Pick a model.** Click the gear in the panel header to open a settings popover listing a curated model catalog. Selecting a row marks your choice; clicking **Load** commits it — the model switches and the panel re-walks its fallback ladder headed by the chosen model. The choice persists in `chrome.storage.local` and is **not** reset on an extension update. With no choice made, the panel auto-picks `onnx-community/gemma-4-E2B-it-ONNX`.
- **Idle release.** The same popover sets an idle timeout — **5 / 15 / 60 minutes or Never** (default 15). After that long without a generation, the model is released to free its WebGPU memory; the next message re-warms it automatically.
- **Manage memory.** On a small GPU the panel warns when the conversation grows large enough to risk an out-of-memory error and offers **Clear conversation** to start fresh. If a model fails to LOAD, it walks a dtype/device fallback ladder automatically; if every tier fails it surfaces a clear message with manual **Retry** / **Reset and re-detect** and what to try next. A mid-stream failure is not auto-rebuilt — recovery there is manual.

## Configuration

Configuration lives in `.env.json` at the repo root. See [`.env.example.json`](.env.example.json) for the defaults:

```json
{
  "apiKey": "dummy",
  "device": "webgpu",
  "dtype": "q4f16",
  "modelName": "onnx-community/gemma-4-E2B-it-ONNX"
}
```

The `.env.json` model is the boot default. At runtime, the in-panel gear popover lets you pick any model from the curated catalog and set the idle-release timeout; the picker's stored preference overrides the `.env.json` model on subsequent sessions. Details and tradeoffs are in [docs/configuration.md](docs/configuration.md).

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
- [Selection rewrite](docs/transform.md) — highlight-to-edit flow, undo, GPU-memory handling
- [Development](docs/development.md) — local setup, build, debugging
- [Configuration](docs/configuration.md) — model, device, dtype
- [Models & runtime notes](docs/models.md) — picking a model, running without WebGPU, ONNX op gotchas
- [Prompt API polyfill](docs/prompt-api.md) — what we vendor and how it's wired in
- [Privacy](docs/privacy.md) — what leaves your machine and what doesn't
- [Testing](docs/testing.md) — how the test suite is structured
- [Contributing](docs/contributing.md) — how to propose changes

## License

Apache-2.0 — see [LICENSE](LICENSE). The vendored polyfill under `vendor/prompt-api-polyfill/` is also Apache-2.0, copyright Google LLC.
