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

#### Automatic dtype/device fallback ladder

When the model fails to LOAD at warmup, the panel automatically walks a fallback ladder within the configured model before giving up. The order is `q4f16` (the `.env.json` default), then `q8`, then `fp16` on WebGPU, then `q8` on WASM. Between each rung the panel force-recreates the offscreen document, so a crashed or GPU-poisoned document never blocks the next attempt. Recreating between attempts also guarantees that two loads never overlap. The elapsed counter keeps ticking across the whole walk; the per-tier internals are not surfaced.

The resolved outcome is persisted per device in `chrome.storage.local` under `local-nano:capability:v1`: the working tier (known-good) and any tiers that failed (known-bad), plus a capability snapshot. A later cold start skips straight to the known-good tier and skips known-bad tiers, so a device that already settled on a working tier does not re-walk the whole ladder. The record is ignored (re-walked from the top) after an extension version change, which is the safe default after a runtime or model update.

This auto-fallback applies only to a LOAD failure. A mid-stream or runtime crash never auto-rebuilds; recovery there is manual (see `docs/models.md`).

#### Terminal load failure, Retry, and Reset and re-detect

If every tier in the ladder fails, the panel shows a terminal system message ("Couldn't load the model on this device.") with a line of guidance, the list of tiers tried, and the copyable diagnostic block described under "Copy diagnostic" below. It offers two controls:

- **Retry** force-recreates the offscreen document and re-walks the ladder, skipping the tiers already recorded known-bad. After a full exhaustion this usually reaches the terminal message again unless something on the device changed.
- **Reset and re-detect** clears the persisted `local-nano:capability:v1` record (forgetting the known-good and known-bad tiers), force-recreates the document, and re-walks the ladder from the top tier.

Recovery is manual: nothing retries automatically, and there is no timer. Use Retry or Reset and re-detect, or set `"device": "wasm"` in `.env.json` for a slower CPU fallback. The diagnostic block is copy-only; nothing leaves your device.

#### Copy diagnostic

A small, muted "Copy diagnostic" control sits in the top-right corner of the chat panel. It is available whenever the panel is open, not only on failure, so you can grab a report at any time when something looks wrong. Clicking it builds a snapshot of the current state and copies it to your clipboard (with a synchronous fallback when the async Clipboard API is blocked); the label briefly shows "Copied" (or "Copy failed").

The report contains:

- the device (`webgpu` or `wasm`), the software-fallback flag, and the adapter's max buffer size;
- the chosen model and the active tier;
- the full ladder path that was walked, one tier per line with its outcome (`success`, `load-failure`, or `network`);
- the error class and message of the most recent load failure (or `none` when there has been none);
- the extension version, the parsed Chrome version, and the raw browser user agent.

Paste it into a bug report so the model, tier, device class, and failure are all captured. The report is built on demand and copied locally only: nothing is auto-sent, logged to the network, or persisted (see `docs/privacy.md`).

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
