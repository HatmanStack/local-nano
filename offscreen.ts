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
import { debugLog } from './src/debug.js';
import { BusyGate } from './src/offscreen/busy-gate.js';
import { classifyOffscreenMessage } from './src/offscreen/dispatch.js';
import {
  COUNT_TOKENS_RESPONSE,
  type CountTokensRequest,
  type CountTokensResponse,
  GPU_INFO_RESPONSE,
  type GpuInfoResponse,
  type HistoryTurn,
  isCountTokensRequest,
  isRebuildSessionRequest,
  isStreamAbort,
  isStreamRequest,
  REBUILD_SESSION_RESPONSE,
  type RebuildSessionRequest,
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

// One generation at a time against the single shared session. The
// polyfill mutates one `#history`; two ports streaming concurrently would
// interleave on one ONNX generator and corrupt that history, so a second
// `stream/request` is rejected with a busy error rather than queued
// (reject-when-busy is YAGNI-sufficient for a single-user extension). The
// gate is module-scoped because the session it guards is module-scoped.
const generationGate = new BusyGate();

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
      debugLog('[local-nano/offscreen] heavy modules loaded; ORT wasmPaths =', ortPath);
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
 * with the provided history. Invoked from the user-initiated "Clear
 * conversation" path in the chat layer (the automatic device-loss
 * rebuild/retry guard was removed); lets the user reset the session
 * while keeping the prior conversation as context.
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

interface MaybeGpuAdapter {
  isFallbackAdapter?: boolean;
  limits?: { maxBufferSize?: number };
}

async function collectGpuInfo(): Promise<GpuInfoResponse & { ok: true }> {
  const cfg = transformersConfig as { device?: string; historyTokenWarnThreshold?: number };
  const device: 'webgpu' | 'wasm' = cfg.device === 'wasm' ? 'wasm' : 'webgpu';
  const configuredThreshold =
    typeof cfg.historyTokenWarnThreshold === 'number' &&
    Number.isFinite(cfg.historyTokenWarnThreshold)
      ? cfg.historyTokenWarnThreshold
      : null;

  if (device === 'wasm') {
    return {
      type: GPU_INFO_RESPONSE,
      ok: true,
      device,
      isFallback: false,
      maxBufferSize: null,
      configuredThreshold,
    };
  }

  const gpu = (
    navigator as unknown as { gpu?: { requestAdapter?: () => Promise<MaybeGpuAdapter | null> } }
  ).gpu;
  if (!gpu?.requestAdapter) {
    return {
      type: GPU_INFO_RESPONSE,
      ok: true,
      device,
      isFallback: true,
      maxBufferSize: null,
      configuredThreshold,
    };
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return {
        type: GPU_INFO_RESPONSE,
        ok: true,
        device,
        isFallback: true,
        maxBufferSize: null,
        configuredThreshold,
      };
    }
    const maxBufferSize =
      typeof adapter.limits?.maxBufferSize === 'number' ? adapter.limits.maxBufferSize : null;
    return {
      type: GPU_INFO_RESPONSE,
      ok: true,
      device,
      isFallback: Boolean(adapter.isFallbackAdapter),
      maxBufferSize,
      configuredThreshold,
    };
  } catch {
    return {
      type: GPU_INFO_RESPONSE,
      ok: true,
      device,
      isFallback: false,
      maxBufferSize: null,
      configuredThreshold,
    };
  }
}

type SendResponse = (response: unknown) => void;

function handleGpuInfo(sendResponse: SendResponse): void {
  collectGpuInfo().then(
    (reply) => sendResponse(reply),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const fail: GpuInfoResponse = { type: GPU_INFO_RESPONSE, ok: false, error: message };
      sendResponse(fail);
    },
  );
}

function handleRebuildSession(msg: RebuildSessionRequest, sendResponse: SendResponse): void {
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
}

// Count-tokens channel. Best-effort: failures here do not destroy or
// rebuild the session — the client side has a heuristic fallback so a
// slow or broken count never blocks a transform.
function handleCountTokens(msg: CountTokensRequest, sendResponse: SendResponse): void {
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
}

// Single dispatcher for the three request channels. Three sibling
// listeners each returning false for non-owned messages risk the MV3
// sendResponse race: a false-returning listener can close the channel
// before the async owner replies. This listener returns true only when
// it owns the message (keeping the async channel open) and false for
// everything else, letting other contexts' listeners field their own
// messages.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const kind = classifyOffscreenMessage(msg);
  if (!kind) return false;
  switch (kind) {
    case 'gpu-info':
      handleGpuInfo(sendResponse);
      return true;
    case 'rebuild-session':
      if (isRebuildSessionRequest(msg)) handleRebuildSession(msg, sendResponse);
      return true;
    case 'count-tokens':
      if (isCountTokensRequest(msg)) handleCountTokens(msg, sendResponse);
      return true;
  }
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

    // Reject a second concurrent generation on the shared session. Done
    // before allocating the controller / read loop so a busy request is a
    // clean no-op aside from the StreamDone reply.
    if (!generationGate.tryAcquire()) {
      const busy: StreamDone = {
        type: STREAM_DONE,
        id,
        ok: false,
        error: 'busy: another generation is in progress',
      };
      try {
        port.postMessage(busy);
      } catch {
        // Caller gone — nothing to deliver.
      }
      return;
    }

    const controller = new AbortController();
    activeAborts.set(id, controller);

    (async () => {
      const t0 = performance.now();
      let chunkCount = 0;
      let totalChars = 0;
      try {
        debugLog(
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
        debugLog(
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
        // Guard removed: the session is NOT torn down or rebuilt on
        // error. We keep the loaded session alive and just report the
        // failure — destroying + reloading on a constrained GPU was
        // suspected of worsening OOM via reload churn. The caller
        // surfaces the error message.
        console.warn('[local-nano/offscreen] stream error:', errMsg);
        const fail: StreamDone = { type: STREAM_DONE, id, ok: false, error: errMsg };
        try {
          port.postMessage(fail);
        } catch {
          // Caller gone.
        }
      } finally {
        activeAborts.delete(id);
        // Free the single generation slot on every outcome — success,
        // error, and abort/disconnect (disconnect aborts the controller,
        // which ends the read loop and runs this finally).
        generationGate.release();
      }
    })();
  });

  port.onDisconnect.addListener(() => {
    for (const ac of activeAborts.values()) ac.abort();
    activeAborts.clear();
  });
});

debugLog('[local-nano/offscreen] listener ready');
