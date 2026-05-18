# Configuration

All configuration lives in `.env.json` at the repo root. The file is **gitignored** — `.env.example.json` ships defaults you can copy:

```bash
cp .env.example.json .env.json
```

```json
{
  "apiKey": "dummy",
  "device": "webgpu",
  "dtype": "q4",
  "modelName": "onnx-community/gemma-4-E2B-it-ONNX"
}
```

The file is imported directly by `content.ts` at build time and passed to the polyfill as `window.TRANSFORMERS_CONFIG`.

## Fields

### `modelName` (string)

A Hugging Face model identifier in `org/repo` form. The model must be an ONNX-format text-generation model — the [`onnx-community`](https://huggingface.co/onnx-community) org on the Hub maintains a large set of pre-converted ones.

Smaller models load faster and are kinder to your GPU memory; bigger ones are smarter but take longer to download and to respond. Some practical picks:

- `onnx-community/gemma-4-E2B-it-ONNX` — bigger, smarter; needs WebGPU (the default).
- `onnx-community/Qwen3.5-0.8B-ONNX` — small, fast, decent for short answers; needs WebGPU.
- `onnx-community/Qwen2.5-0.5B-Instruct` — proven safe pick when you're stuck on WASM.

Picking the right model for your hardware is its own topic — see [`docs/models.md`](models.md) for a field guide covering which models we've tried, what fails, and how to run without WebGPU.

### `device` (`"webgpu"` | `"wasm"`)

Where inference runs.

- `"webgpu"` is much faster. Requires a recent Chrome build with WebGPU enabled (default on modern Chrome).
- `"wasm"` falls back to CPU via WebAssembly. Slower but works everywhere.

If WebGPU isn't available the polyfill will surface an error in the chat panel; switch to `"wasm"` in that case.

### `dtype` (string)

Quantization level for model weights. Smaller dtypes mean smaller download, lower memory, and slightly worse quality. Common values:

- `"q4"` — 4-bit, the most aggressive quantization.
- `"q4f16"` — 4-bit weights with fp16 activations; the polyfill's default.
- `"q8"` / `"fp16"` / `"fp32"` — increasingly precise, increasingly heavy.

Not every model publishes every variant — check the model's `onnx/` folder on the Hub.

### `apiKey` (string)

Unused by the Transformers.js backend. Kept in the shape because the upstream polyfill supports cloud backends (firebase / gemini / openai) that need real keys; the slimmed `backends-registry.js` in this repo only ships the Transformers.js backend.

## Changing the keyboard shortcut

The shortcut isn't in `.env.json` — it's in `manifest.json` under `commands.toggle_ai_palette.suggested_key`. To override per-user, go to `chrome://extensions/shortcuts` and rebind there; you don't need to rebuild.

## Other knobs

The polyfill itself accepts an `env` block that maps onto Transformers.js's `env` object (e.g., `allowRemoteModels`, custom wasm paths). See `vendor/prompt-api-polyfill/dot_env.json` for the full shape if you need to override a Transformers.js setting from `.env.json`.
