/**
 * Offscreen document entry point.
 *
 * Lives in a hidden document the extension owns (created from the service
 * worker via `chrome.offscreen.createDocument`). Hosts one long-lived
 * `LanguageModel` session that survives content-script reloads and is
 * shared across tabs.
 *
 * Token streaming is the only transport: callers open a port named
 * `STREAM_PORT_NAME`, post a `StreamRequest`, and receive `StreamChunk`
 * frames until a `StreamDone` frame closes the exchange. Callers can
 * cancel mid-stream by posting `StreamAbort`.
 *
 * The heavy-module load mirrors the inline pattern in `src/session.ts` —
 * deliberately not extracted into a shared helper. v0.2 went down that
 * path with `src/heavy.ts` and was reverted; the duplication here keeps
 * the chat client and offscreen session independent.
 */

import transformersConfig from './.env.json';
import {
  COUNT_TOKENS_RESPONSE,
  type CountTokensResponse,
  type HistoryTurn,
  isCountTokensRequest,
  isRebuildSessionRequest,
  isStreamAbort,
  isStreamRequest,
  REBUILD_SESSION_RESPONSE,
  type RebuildSessionResponse,
  STREAM_CHUNK,
  STREAM_DONE,
  STREAM_PORT_NAME,
  type StreamChunk,
  type StreamDone,
} from './src/offscreen/protocol.js';

interface LanguageModelSession {
  promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>;
  measureContextUsage(input: string): Promise<number>;
  destroy(): void;
}

interface LoadedHeavy {
  LanguageModel: { create: (opts: unknown) => Promise<LanguageModelSession> };
}

interface OnnxWasmEnv {
  backends: { onnx: { wasm: { wasmPaths: string; numThreads: number } } };
}

const SYSTEM_INSTRUCTION = 'You are a helpful assistant. Answer concisely and directly.';

let heavyPromise: Promise<LoadedHeavy> | null = null;
let sessionPromise: Promise<LanguageModelSession> | null = null;

function loadHeavy(): Promise<LoadedHeavy> {
  if (heavyPromise) return heavyPromise;
  heavyPromise = (async () => {
    try {
      const [tfMod, polyfillMod] = await Promise.all([
        import('@huggingface/transformers'),
        import('./vendor/prompt-api-polyfill/prompt-api-polyfill.js'),
      ]);
      const ortPath = chrome.runtime.getURL('dist/ort/');
      (tfMod.env as unknown as OnnxWasmEnv).backends.onnx.wasm.wasmPaths = ortPath;
      (tfMod.env as unknown as OnnxWasmEnv).backends.onnx.wasm.numThreads = 1;
      (window as unknown as Record<string, unknown>).TRANSFORMERS_CONFIG = transformersConfig;
      console.log('[local-nano/offscreen] heavy modules loaded; ORT wasmPaths =', ortPath);
      return {
        LanguageModel: (
          polyfillMod as unknown as {
            LanguageModel: { create: (opts: unknown) => Promise<LanguageModelSession> };
          }
        ).LanguageModel,
      };
    } catch (err) {
      heavyPromise = null;
      throw err;
    }
  })();
  return heavyPromise;
}

function buildInitialPrompts(
  history: HistoryTurn[] | undefined,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const seeded: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: SYSTEM_INSTRUCTION },
  ];
  if (!history) return seeded;
  for (const turn of history) {
    seeded.push({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: turn.text,
    });
  }
  return seeded;
}

function ensureSession(history?: HistoryTurn[]): Promise<LanguageModelSession> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    try {
      const { LanguageModel } = await loadHeavy();
      return await LanguageModel.create({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: buildInitialPrompts(history),
      });
    } catch (err) {
      sessionPromise = null;
      throw err;
    }
  })();
  return sessionPromise;
}

/**
 * Tear down the current polyfill session and create a fresh one seeded
 * with the provided history. Invoked when the chat layer detects a
 * device-loss failure (zero-chunk stream) and wants to recover without
 * losing conversational context.
 */
async function rebuildSession(history: HistoryTurn[]): Promise<void> {
  try {
    const previous = await sessionPromise;
    previous?.destroy();
  } catch {
    // Previous session may have failed to load — nothing to destroy.
  }
  sessionPromise = null;
  await ensureSession(history);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isRebuildSessionRequest(msg)) return false;
  rebuildSession(msg.history).then(
    () => {
      const ok: RebuildSessionResponse = { type: REBUILD_SESSION_RESPONSE, ok: true };
      sendResponse(ok);
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const fail: RebuildSessionResponse = {
        type: REBUILD_SESSION_RESPONSE,
        ok: false,
        error: message,
      };
      sendResponse(fail);
    },
  );
  return true;
});

// Count-tokens channel. Best-effort: failures here do not destroy or
// rebuild the session — the client side has a heuristic fallback so a
// slow or broken count never blocks a transform.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isCountTokensRequest(msg)) return false;
  (async () => {
    try {
      const session = await ensureSession();
      const count = await session.measureContextUsage(msg.text);
      const ok: CountTokensResponse = { type: COUNT_TOKENS_RESPONSE, ok: true, count };
      sendResponse(ok);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const fail: CountTokensResponse = {
        type: COUNT_TOKENS_RESPONSE,
        ok: false,
        error: message,
      };
      sendResponse(fail);
    }
  })();
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== STREAM_PORT_NAME) return;

  // Track every in-flight abort controller on this port so an early
  // `stream/abort` (or a `port.onDisconnect`) can cancel generation.
  const activeAborts = new Map<string, AbortController>();

  port.onMessage.addListener((raw: unknown) => {
    if (isStreamAbort(raw)) {
      const ac = activeAborts.get(raw.id);
      ac?.abort();
      return;
    }
    if (!isStreamRequest(raw)) return;

    const id = raw.id;
    const controller = new AbortController();
    activeAborts.set(id, controller);

    (async () => {
      const t0 = performance.now();
      let chunkCount = 0;
      let totalChars = 0;
      try {
        console.log(
          `[local-nano/offscreen] stream/request id=${id} prompt.length=${raw.prompt.length}`,
        );
        const session = await ensureSession();
        const tSession = performance.now() - t0;
        const stream = session.promptStreaming(raw.prompt, { signal: controller.signal });
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunkCount++;
            totalChars += value.length;
            const chunk: StreamChunk = { type: STREAM_CHUNK, id, value };
            try {
              port.postMessage(chunk);
            } catch {
              // Caller disconnected mid-stream — cancel the read loop.
              controller.abort();
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (chunkCount === 0 && !controller.signal.aborted) {
          // The polyfill's transformers backend catches generation errors
          // (WebGPU device loss after a tab switch is the common one) and
          // sets isDone=true without erroring the stream
          // (vendor/prompt-api-polyfill/backends/transformers.js:241-248).
          // The polyfill then pushes user/model("") into its history and
          // closes the stream cleanly. We get a "successful zero-chunk"
          // result here — surface it as a failure and rebuild the session:
          // the polyfill's history is now polluted with an empty turn that
          // tends to cascade into more empty turns, and the WebGPU device
          // is likely gone anyway.
          console.warn(
            `[local-nano/offscreen] EMPTY response id=${id} prompt.length=${raw.prompt.length} sessionMs=${tSession.toFixed(0)} totalMs=${(performance.now() - t0).toFixed(0)} — treating as failure and rebuilding session on next call.`,
          );
          try {
            const previous = await sessionPromise;
            previous?.destroy();
          } catch {
            // Nothing useful to do — we're tearing it down anyway.
          }
          sessionPromise = null;
          const empty: StreamDone = {
            type: STREAM_DONE,
            id,
            ok: false,
            error:
              'Model returned no output (likely WebGPU device loss after tab/window switch). Rebuilding session; try again.',
          };
          try {
            port.postMessage(empty);
          } catch {
            // Caller gone.
          }
          return;
        }
        console.log(
          `[local-nano/offscreen] stream/done id=${id} chunks=${chunkCount} chars=${totalChars} sessionMs=${tSession.toFixed(0)} totalMs=${(performance.now() - t0).toFixed(0)}`,
        );
        const done: StreamDone = controller.signal.aborted
          ? { type: STREAM_DONE, id, ok: false, error: 'aborted' }
          : { type: STREAM_DONE, id, ok: true };
        try {
          port.postMessage(done);
        } catch {
          // Caller is gone — nothing to deliver.
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errName = (err as { name?: unknown })?.name;
        // Aborts are a normal end-of-stream signal — the user clicked
        // Stop, or another tab disconnected the port. Resetting the
        // session here would destroy the polyfill's conversation history
        // and the next turn would have no memory of the prior one.
        //
        // Only reset on real failures (WebGPU device-lost, "OrtRun"
        // failures, malformed model output). The next request then
        // rebuilds the session from cached weights — slower for that
        // call, recoverable across the tab's lifetime.
        if (errName !== 'AbortError') {
          sessionPromise = null;
          console.warn('[local-nano/offscreen] stream error, resetting session:', errMsg);
        }
        const fail: StreamDone = { type: STREAM_DONE, id, ok: false, error: errMsg };
        try {
          port.postMessage(fail);
        } catch {
          // Caller gone.
        }
      } finally {
        activeAborts.delete(id);
      }
    })();
  });

  port.onDisconnect.addListener(() => {
    for (const ac of activeAborts.values()) ac.abort();
    activeAborts.clear();
  });
});

console.log('[local-nano/offscreen] listener ready');
