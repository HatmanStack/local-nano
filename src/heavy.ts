/**
 * Minimal typed surface for a LanguageModel session returned by the
 * Prompt API polyfill. Only the methods called in this extension are
 * declared; the full spec surface is larger.
 */
export interface LanguageModelSession {
  promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>;
  destroy(): void;
}

/**
 * Resolved value of `loadHeavy()` — the polyfill `LanguageModel` factory
 * plus any other heavy bindings callers need. Currently scoped to the
 * one binding both `initSession` and `runTransform` require.
 */
export interface LoadedHeavy {
  LanguageModel: { create: (opts: unknown) => Promise<LanguageModelSession> };
}

interface OnnxWasmEnv {
  backends: { onnx: { wasm: { wasmPaths: string; numThreads: number } } };
}

// Module-level memo: the first call kicks off the dynamic imports, every
// subsequent call returns the same in-flight or settled promise. On
// failure the cache is cleared so the next call retries from scratch.
let heavyLoadPromise: Promise<LoadedHeavy> | null = null;

// The transformersConfig that was stamped onto window.TRANSFORMERS_CONFIG
// by the first loadHeavy call. Stored so subsequent calls with a
// different reference can be flagged — both initSession and runTransform
// must agree on the config, and a mismatch is a wiring bug, not a
// recoverable runtime condition.
let cachedTransformersConfig: unknown = null;

/**
 * Lazily load the heavy on-device-model modules and return the polyfill
 * binding. Shared across `initSession` (chat session) and `runTransform`
 * (ephemeral per-action sessions) so the multi-MB Transformers.js init
 * runs at most once per page lifetime.
 *
 * The promise is memoized at module scope. Pass the same
 * `transformersConfig` value the rest of the extension uses; it is
 * stamped onto `window.TRANSFORMERS_CONFIG` for the polyfill to read.
 * Subsequent calls with a different `transformersConfig` reference log
 * a warning — the first config wins and is reused.
 */
export function loadHeavy(transformersConfig: unknown): Promise<LoadedHeavy> {
  if (heavyLoadPromise) {
    if (cachedTransformersConfig !== transformersConfig) {
      console.warn(
        '[local-nano] loadHeavy called with a different transformersConfig; ' +
          'reusing the first one. This indicates a wiring bug between callers ' +
          '(initSession and runTransform must share the same config object).',
      );
    }
    return heavyLoadPromise;
  }
  cachedTransformersConfig = transformersConfig;
  heavyLoadPromise = (async () => {
    try {
      const [tfMod, polyfillMod] = await Promise.all([
        import('@huggingface/transformers'),
        import('../vendor/prompt-api-polyfill/prompt-api-polyfill.js'),
      ]);
      const ortPath = chrome.runtime.getURL('dist/ort/');
      (tfMod.env as unknown as OnnxWasmEnv).backends.onnx.wasm.wasmPaths = ortPath;
      (tfMod.env as unknown as OnnxWasmEnv).backends.onnx.wasm.numThreads = 1;
      (window as unknown as Record<string, unknown>).TRANSFORMERS_CONFIG = transformersConfig;
      console.log('[local-nano] heavy modules loaded; ORT wasmPaths =', ortPath);
      return {
        LanguageModel: (
          polyfillMod as unknown as {
            LanguageModel: { create: (opts: unknown) => Promise<LanguageModelSession> };
          }
        ).LanguageModel,
      };
    } catch (err) {
      // Clear the cache so the next call retries from scratch.
      heavyLoadPromise = null;
      throw err;
    }
  })();
  return heavyLoadPromise;
}

/**
 * Reset the module-level memo. Intended for tests only — production
 * code should never call this. Tests use it to isolate the shared
 * cache between cases.
 */
export function resetHeavyCache(): void {
  heavyLoadPromise = null;
  cachedTransformersConfig = null;
}
