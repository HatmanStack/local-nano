# Configuration

All configuration lives in `.env.json` at the repo root. The file is **gitignored** — `.env.example.json` ships defaults you can copy:

```bash
cp .env.example.json .env.json
```

```json
{
  "apiKey": "dummy",
  "device": "webgpu",
  "dtype": "q4f16",
  "modelName": "onnx-community/gemma-4-E2B-it-ONNX"
}
```

The file is imported by the offscreen document (`offscreen.ts`, where the model runs) and assigned to `window.TRANSFORMERS_CONFIG` for the polyfill. The content script never reads it.

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

#### Preflight device-capability advisory

When the panel opens, the extension queries the WebGPU adapter before the heavy model load. If it finds no hardware WebGPU adapter (a software fallback) or an adapter whose max buffer size looks too small to hold the model, it shows a one-time "Heads up…" system message in the chat advising you to set `"device": "wasm"` in `.env.json` (CPU — slower but reliable). The advisory is informational only: the load is still attempted, since the capability snapshot can false-negative. If the load then fails, the advisory tells you what to try.

### `dtype` (string)

Quantization level for model weights. Smaller dtypes mean smaller download, lower memory, and slightly worse quality. Common values:

- `"q4f16"` — 4-bit weights with fp16 activations. **Recommended default.**
- `"q4"` — 4-bit, the most aggressive quantization. **Avoid on WebGPU:** the `q4` ONNX kernel has hit a WebAssembly `SIGILL` (illegal instruction) inside ONNX Runtime Web's SIMD path on some Chrome/Dawn builds, crashing the offscreen document during model load. `q4f16` uses different kernels and avoids it. See the 0.2.4 CHANGELOG note.
- `"q8"` / `"fp16"` / `"fp32"` — increasingly precise, increasingly heavy. Good alternatives if `q4f16` ever regresses.

Not every model publishes every variant — check the model's `onnx/` folder on the Hub.

### `apiKey` (string)

A placeholder. The vendored polyfill **does** read this field (`prompt-api-polyfill.js:189`, `if (config && config.apiKey)`), but the Transformers.js backend ignores it — there is no cloud call to authenticate. The `"dummy"` value is a deliberate placeholder that the polyfill reads and the backend never uses. It exists because the upstream polyfill supports cloud backends (firebase / gemini / openai) that need real keys; the slimmed `backends-registry.js` in this repo only ships the Transformers.js backend, so keep it as `"dummy"`.

### `historyTokenWarnThreshold` (number, optional)

Override for the conversation-history token threshold above which the panel surfaces a "Clear conversation" warning. When absent, the panel queries the WebGPU adapter at warmup and derives a threshold automatically:

- `wasm` device — `8000` (CPU has gigabytes of system RAM)
- WebGPU software fallback — `800` (very constrained)
- WebGPU `maxBufferSize` &lt; 512 MiB — `1000`
- WebGPU `maxBufferSize` &lt; 1 GiB — `1500`
- WebGPU `maxBufferSize` &lt; 2 GiB — `2500`
- WebGPU `maxBufferSize` &ge; 2 GiB — `4000`

Set this field if the auto-derived value is wrong for your hardware. The number is in estimated tokens (`chars / 3` over persisted history text); typical chat turn is ~100-300 tokens, typical rewrite turn ~400-600.

## Changing the keyboard shortcut

The shortcut isn't in `.env.json` — it's in `manifest.json` under `commands.toggle_ai_palette.suggested_key`. To override per-user, go to `chrome://extensions/shortcuts` and rebind there; you don't need to rebuild.

## Other knobs

The polyfill itself accepts an `env` block that maps onto Transformers.js's `env` object (e.g., `allowRemoteModels`, custom wasm paths). That `env` block is not read at runtime — all live configuration comes from your `.env.json`. For the backend-level defaults the polyfill applies when a field is absent, see `vendor/prompt-api-polyfill/backends/defaults.js` (covered under "Default fallback layer" below).

## Default fallback layer

If a field is absent from `.env.json`, the polyfill's Transformers backend
falls back to the values in
`vendor/prompt-api-polyfill/backends/defaults.js` (the `DEFAULT_MODELS.transformers`
object). This secondary layer supplies `modelName`, `device`, and `dtype`
defaults. In practice `.env.json` always provides all fields — but if you
remove a field to experiment, it will silently resolve from that file rather
than failing.
