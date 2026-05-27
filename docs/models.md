# Models & Runtime Notes

Picking a model is the single biggest knob you have. The space of "ONNX text-generation models that run in `@huggingface/transformers` inside a browser" is narrower than it sounds, and what works at all depends on whether you have WebGPU, which ONNX ops your runtime implements, and how much memory your tab can spend.

This page captures what we've actually tried — model by model, dtype by dtype, on capable WebGPU hardware and on machines stuck on WASM. Treat it as a field guide, not a benchmark.

## TL;DR picks

| Hardware                                  | Recommended config                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Modern WebGPU (Iris Xe, M-series, RTX)    | `device: "webgpu"`, `dtype: "q4f16"`, `modelName: "onnx-community/gemma-4-E2B-it-ONNX"`                       |
| WebGPU but quirky (older Intel, drivers)  | `device: "webgpu"`, `dtype: "q4f16"`, `modelName: "onnx-community/Qwen3-0.6B-ONNX"` (small WebGPU option; reasoning model, `<think>` stripped) |
| No WebGPU (WASM CPU only)                 | `device: "wasm"`, `dtype: "q8"`, `modelName: "onnx-community/Qwen2.5-0.5B-Instruct"`                          |

The rest of this doc explains *why* those particular cells.

## Running without WebGPU

WebGPU is the fast path. Without it, inference happens in WebAssembly on the CPU, and the constraint set narrows considerably:

- **Heap is capped at ~4 GB.** This is the single biggest reason large models trap. A 1B-param model at q8 plus its KV cache plus Chrome's own per-tab overhead is uncomfortably close to that line — push it (longer context, bigger model, more tokens) and you'll get an emscripten panic surfaced as an integer "exception" (a raw heap pointer). It looks like junk; it's actually a WASM abort.
- **Single-threaded by default.** We explicitly set `numThreads = 1` for stability — ONNX's threaded WASM path requires SharedArrayBuffer, which requires cross-origin isolation, which most host pages don't have. CPU inference is therefore one core wide.
- **Fewer ONNX ops are implemented.** The WASM execution provider is missing some kernels that the WebGPU/JSEP execution provider has — most painfully `GatherBlockQuantized`, which newer quantized models use for their embedding lookup. See [ONNX op compatibility](#onnx-op-compatibility) below.

What's still viable:

- **Stick to ≤1B-parameter models.** Qwen2.5-0.5B-Instruct is the sweet spot in our testing — it runs without tripping the heap, gives coherent answers, and finishes prompts in tens of seconds rather than minutes.
- **Prefer `q8` or `fp16` dtypes.** Both avoid `GatherBlockQuantized`. q8 is smaller (~500 MB for a 0.5B model); fp16 is bigger (~1 GB) but slightly more numerically stable.
- **Expect 1–3 tokens/second.** Real-world. The first token of a response also has a long prefill cost — for ~1500 chars of page context that's roughly 30–60 seconds of work before output starts. The panel shows a three-dot animation while generating; while the model loads it shows a live elapsed-seconds counter (`Loading model… Ns`) rather than a percentage, since the app does not consume download-progress events.

Configure it as:

```json
{
  "apiKey": "dummy",
  "device": "wasm",
  "dtype": "q8",
  "modelName": "onnx-community/Qwen2.5-0.5B-Instruct"
}
```

## Enabling WebGPU on ChromeOS

ChromeOS doesn't expose WebGPU by default. To check what you have:

1. Open `chrome://gpu` and look at the **Graphics Feature Status** block. The `WebGPU` line tells you the truth: `Hardware accelerated`, `Software only`, or `Disabled`. If it's not hardware-accelerated, none of the flags below will help — your GPU/drivers can't.
2. Visit <https://webgpureport.org>. If it reports adapter info ("Intel Iris Xe Graphics" or similar), you're in.

If WebGPU is disabled but the hardware should be capable:

- Set `chrome://flags/#enable-unsafe-webgpu` to **Enabled** and restart.
- The `chrome://flags/#enable-vulkan` flag is sometimes "Not available on your platform" — that's fine, it controls browser rasterization, not WebGPU. WebGPU on ChromeOS goes through Dawn separately.

"Unsafe WebGPU" bypasses some compatibility validations. Fine for personal use; not something to rely on in a production extension.

## ONNX op compatibility

The single most common failure mode we hit on WASM was:

```text
Error: Can't create a session. ERROR_CODE: 9,
ERROR_MESSAGE: Could not find an implementation for
GatherBlockQuantized(1) node with name '/model/embed_tokens/Gather_Quant'
```

`GatherBlockQuantized` is an ONNX op used by recent quantized models for their embedding table. It's implemented in the WebGPU (JSEP) execution provider, but **not** in the CPU WASM execution provider. Worse: every quant variant (`q4`, `q4f16`, `_quantized` aka q8) of some models bakes in this op. Only `fp16` and `fp32` skip it.

Workarounds, in order of preference:

1. **Use WebGPU.** It implements the op.
2. **Pick a model whose quantized exports don't use it.** Older models (Qwen2.5 series, Gemma 3 Instruct) are mostly safe at q8.
3. **Use per-component dtype** if the model is multi-file (separate `embed_tokens.onnx`, `decoder_model_merged.onnx`, etc.). Set the embeddings to `fp16` to dodge the op while keeping the heavy decoder in `q8`:

   ```json
   {
     "dtype": {
       "embed_tokens": "fp16",
       "decoder_model_merged": "q8"
     }
   }
   ```

   `@huggingface/transformers` v4 supports this object form. It only helps when the model publishes those component files individually; single-file `model.onnx` models can't be split this way.

4. **Fall back to `fp16` or `fp32`.** Larger download, more memory, but unambiguously compatible.

## Models we tried

Captured in roughly the order we hit them so the rationale is visible.

| Model                                              | Setup                       | Result                                                                 |
| -------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| `onnx-community/gemma-3-1b-it-ONNX-GQA`            | wasm + q4                   | WASM trap (raw heap pointer thrown); too close to the 4 GB heap line   |
| `HuggingFaceTB/SmolLM2-360M-Instruct`              | wasm + q8                   | Runs, but coherence too weak to be useful                              |
| `onnx-community/gemma-3-270m-it-ONNX`              | wasm + fp16                 | Runs fast; officially a "fine-tune base" — echoes prompts as a chat model |
| `onnx-community/Qwen2.5-0.5B-Instruct`             | wasm + q8                   | ✅ Smallest model that actually answers questions. WASM-tier default.   |
| `onnx-community/Qwen2.5-0.5B-Instruct`             | webgpu + q4f16, smoke 2026-05-26 | ❌ PARROTED the input — small-model q4f16 numerical breakdown on this GPU class (loads fine, so the ladder can't auto-recover; gemma is unaffected at q4f16). |
| `onnx-community/Qwen2.5-0.5B-Instruct`             | webgpu + fp16, smoke 2026-05-26 | ❌ Also PARROTED. Since full-precision `fp16` fails on WebGPU while the more-quantized `wasm/q8` answers, this is a WebGPU execution-provider correctness issue for this model's ops, not precision. **WebGPU rejected for this model on this GPU; catalog entry stays WASM-only.** |
| `onnx-community/Qwen3.5-0.8B-ONNX`                 | wasm + q4 / q4f16 / q8      | `GatherBlockQuantized` missing in WASM kernel; all three variants fail |
| `onnx-community/Qwen3.5-0.8B-ONNX`                 | wasm + per-component dtype  | Works with `{embed_tokens: "fp16", decoder_model_merged: "q8"}`, but slow (~50s TTFT for 1500-char context) |
| `onnx-community/Qwen3.5-0.8B-ONNX`                 | webgpu + q4f16, Intel Iris Xe | Numerical breakdown — model emits a few real tokens then loops one repeated token (`!!!!!`). Driver/precision issue with f16 on this GPU. |
| `onnx-community/Qwen3.5-0.8B-ONNX`                 | webgpu + q4                 | ✅ Worked on Iris Xe historically; ~15–40 tok/s. See the `q4` SIGILL caveat below — `q4f16` is now preferred. |
| `onnx-community/Qwen3.5-0.8B-ONNX`                 | webgpu + q4 / wasm per-component, 2026-05-26 | ❌ Load-FAILS on both tiers now. `config.json` is `Qwen3_5ForConditionalGeneration` with a `vision_config` and image/video tokens — the repo is a **vision-language model**, not a text causal LM, so the text-only polyfill can't construct it. The "worked historically" rows above predate that; do **not** use as a text model. |
| `onnx-community/Qwen3-0.6B-ONNX`                   | webgpu + q4f16 / wasm q8 → fp16, shipped 2026-05-26 | ✅ The live small WebGPU option in v0.4.0. Verified text-only (`Qwen3ForCausalLM`, no `vision_config`), single-file ONNX; loads and answers on the dev integrated GPU (reasoning model — `<think>` stripped). Sub-1B so weaker than gemma at open Q&A, but the usable small/light pick after Qwen3.5-0.8B-Text and Qwen3-1.7B were both rejected (below). |
| `onnx-community/Qwen3.5-0.8B-Text-ONNX`            | webgpu q4f16 / wasm q8 / wasm fp16, smoke 2026-05-26 | ❌ Failed to load on ALL tiers (fell back to gemma). Text-only (`Qwen3_5ForCausalLM`, `qwen3_5_text`) but the brand-new `qwen3_5_text` arch (hybrid linear/full attention) is **not implemented by transformers@4.2.0** — no dtype/device loads it. Gated off; revisit after a transformers upgrade. |
| `onnx-community/Qwen3-1.7B-ONNX`                   | webgpu q4f16 / wasm q8 → fp16, smoke 2026-05-26 | ❌ On a 4 GiB integrated GPU (CrOS): `webgpu/q4f16` load-failed (model-specific — it's smaller than gemma-4-E2B, which loads at the same tier), `wasm/q8` fails on `GatherBlockQuantized`, leaving only `wasm/fp16` (~3.4 GB, single-thread CPU, >300 s load — unusable). Gated off; maybe re-vet on a discrete GPU. |
| `onnx-community/gemma-4-E2B-it-ONNX`               | webgpu + q4                 | ✅ Smarter than Qwen3.5-0.8B; ~5–15 tok/s on Iris Xe. ~1.5 GB download. (Historical `q4` observation.) |
| `onnx-community/gemma-4-E2B-it-ONNX`               | webgpu + q4f16              | ✅ Current default. Moved off `q4` after the `q4` ONNX kernel hit a `SIGILL` on some Chrome/Dawn builds (see [configuration.md](configuration.md) and CHANGELOG 0.2.4). |

## Smaller-model fallback rung (gated)

The fallback ladder can append a smaller model as a last-resort rung after the primary model's dtype/device tiers are exhausted. It exists in code behind a build-time flag, `SMALLER_MODEL_ENABLED` in `src/offscreen/ladder.ts`, which **defaults to false**: the rung is dormant and live behavior is the primary model only.

The candidate is `onnx-community/Qwen2.5-0.5B-Instruct`, the WASM-tier default from the [TL;DR picks](#tldr-picks) and the [Models we tried](#models-we-tried) table above. It is vetted **on WASM only** (`device: "wasm"`, `dtype: "q8"`); its WebGPU tier (`q4f16`) is **unvetted** and is present in the candidate list solely as the manual-vetting target.

Enabling the flag is a manual follow-up, not a CI-checkable change: CI cannot exercise WebGPU. Before flipping `SMALLER_MODEL_ENABLED` to true, run the manual WebGPU smoke matrix against the candidate at each of its tiers and confirm it loads and answers coherently. Until that vetting passes, the rung stays off and the polyfill's own default smaller model (`onnx-community/gemma-3-1b-it-ONNX-GQA`, a documented WASM trap in the table above) is never used.

## Failure modes worth recognizing

- **Integer "exception" (e.g., `Error: 12077640`).** Emscripten panic in the WASM ONNX runtime. Almost always memory pressure — bigger model than the heap can hold, or KV cache outgrowing it during long generation. Drop to a smaller model or a smaller `max_new_tokens`.
- **`Could not find an implementation for X` errors.** ONNX op missing in the active execution provider. See [ONNX op compatibility](#onnx-op-compatibility). If `X` isn't `GatherBlockQuantized`, the same workaround pattern applies: change dtype to dodge the op.
- **Streaming arrives as one giant chunk instead of token-by-token.** Usually means the model is degenerate (looping on one token), and `TextStreamer`'s UTF-8 boundary heuristic collapses the run into one flush. The streaming code is fine; the model is broken. Try a different dtype or a different model.
- **`The feature flag gating model execution was disabled` (NotAllowedError).** This is Chrome's *native* `LanguageModel` API rejecting because you're not on Chromebook Plus / equivalent. The polyfill's install guard would skip installation if native `LanguageModel` were present. This extension bypasses the guard by importing `LanguageModel` from the polyfill module directly in the offscreen document — see [`offscreen.ts`](../offscreen.ts) for the import. The extension always uses the polyfill.

## On `max_new_tokens`

The polyfill's Transformers backend defaults to 1024; we use 2048. Bigger is tempting but pricey:

- **KV cache grows linearly** with output length. A 0.8B model at 8192 tokens is ~200 MB of KV cache alone before activations, weights, or page chrome.
- **If the model doesn't emit EOS naturally, you pay the full cap.** Some models with low-quality quantization never produce a clean stop — they'd happily generate until forcibly cut off, building cache the whole time.

For genuinely long-form output, the better pattern is to ask the model to continue from where it stopped (the polyfill session preserves history across turns) rather than raising the cap. We've found 2048 to be the largest value that doesn't risk tab-level memory issues on a 4 GB-budget WASM tab or a memory-constrained WebGPU adapter.
