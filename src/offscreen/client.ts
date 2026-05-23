/**
 * Content-script (and popup) facing client for the offscreen model host.
 *
 * Content scripts can't call `chrome.offscreen.*` directly, so they ask
 * the service worker to ensure the document via `sendMessage` before
 * opening a port. The streaming logic itself is shared with the SW path
 * via `streamOverPort`.
 */

import {
  COUNT_TOKENS_REQUEST,
  type CountTokensRequest,
  ENSURE_OFFSCREEN_REQUEST,
  type EnsureOffscreenRequest,
  GPU_INFO_REQUEST,
  type GpuInfoRequest,
  type GpuInfoSnapshot,
  type HistoryTurn,
  isCountTokensResponse,
  isEnsureOffscreenResponse,
  isGpuInfoResponse,
  isRebuildSessionResponse,
  REBUILD_SESSION_REQUEST,
  type RebuildSessionRequest,
} from './protocol.js';
import { type StreamPromptOptions, streamOverPort } from './stream-client.js';

export type { StreamPromptOptions } from './stream-client.js';

const DEFAULT_COUNT_TIMEOUT_MS = 100;

function heuristicTokenCount(text: string): number {
  return Math.ceil(text.length / 3);
}

async function ensureViaServiceWorker(): Promise<void> {
  const request: EnsureOffscreenRequest = { type: ENSURE_OFFSCREEN_REQUEST };
  const reply = (await chrome.runtime.sendMessage(request)) as unknown;
  const lastError = chrome.runtime.lastError;
  if (lastError) {
    throw new Error(`ensure-offscreen failed: ${lastError.message ?? 'unknown'}`);
  }
  if (!isEnsureOffscreenResponse(reply)) {
    throw new Error('ensure-offscreen: malformed reply from service worker');
  }
  if (!reply.ok) throw new Error(reply.error);
}

/**
 * Stream tokens from the offscreen model session. Returns the full
 * concatenated text once generation completes; `onChunk` fires per token
 * for progressive rendering. `signal` cancels both the stream and the
 * underlying generation.
 */
export function streamPrompt(prompt: string, opts: StreamPromptOptions = {}): Promise<string> {
  return streamOverPort(prompt, opts, ensureViaServiceWorker);
}

/**
 * Non-streaming convenience wrapper — same as `streamPrompt` with no
 * `onChunk` callback. Returns the full text.
 */
export function sendPrompt(prompt: string): Promise<string> {
  return streamPrompt(prompt);
}

/**
 * Ask the offscreen polyfill session to tokenize `text` and report the
 * count. Races the round-trip against `timeoutMs` (default 100ms); on
 * timeout, malformed reply, `ok: false`, or `chrome.runtime.lastError`,
 * resolves with the heuristic `Math.ceil(text.length / 3)` instead of
 * rejecting. The point is a usable number for downstream math, not a
 * faithful surface of every transport error.
 *
 * Used by the selection-rewrite soft-cap computation; the brainstorm
 * flagged that the polyfill's `measureContextUsage` may add real latency
 * on Gemma-4, so the heuristic is the default UX guarantee.
 */
export async function countTokens(
  text: string,
  opts: { timeoutMs?: number } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COUNT_TIMEOUT_MS;
  const fallback = heuristicTokenCount(text);

  const roundTrip = (async (): Promise<number> => {
    try {
      await ensureViaServiceWorker();
    } catch {
      return fallback;
    }
    const request: CountTokensRequest = { type: COUNT_TOKENS_REQUEST, text };
    let reply: unknown;
    try {
      reply = await chrome.runtime.sendMessage(request);
    } catch {
      return fallback;
    }
    const lastError = chrome.runtime.lastError;
    if (lastError) {
      console.warn(`[local-nano] countTokens: ${lastError.message ?? 'lastError set'}`);
      return fallback;
    }
    if (!isCountTokensResponse(reply)) return fallback;
    if (!reply.ok) return fallback;
    return reply.count;
  })();

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (value: number) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    roundTrip.then(
      (value) => {
        clearTimeout(timer);
        finish(value);
      },
      () => {
        clearTimeout(timer);
        finish(fallback);
      },
    );
  });
}

/**
 * Block-load the offscreen polyfill session so it's ready before the
 * user sends their first message. Resolves once `ensureSession()` in
 * the offscreen doc has finished (model weights uploaded to WebGPU and
 * the polyfill session is live), or rejects if loading fails.
 *
 * Implemented as a count-tokens round-trip without the timeout race —
 * we want to actually wait for the load to complete, not fall back to a
 * heuristic. The offscreen side dedupes via its `sessionPromise`
 * singleton, so multiple concurrent warmups across tabs share one load.
 *
 * DEPENDENCY NOTE: this relies on the offscreen count-tokens handler
 * calling `ensureSession()` (which loads the model) before measuring.
 * It assumes `measureContextUsage` exercises the same initialization
 * path as `promptStreaming`. If a future polyfill bump makes
 * `measureContextUsage` cheaper / lazier such that it no longer forces
 * a full model load, this probe will resolve before the model is
 * actually ready and the first real prompt will eat the warmup cost.
 * If that happens, switch this to a tiny throwaway `promptStreaming`
 * call instead.
 *
 * TIMEOUT: a GPU out-of-memory or device-loss during model load can be
 * reported by ONNX/Dawn out-of-band (WebGPU device error to the
 * console) while `LanguageModel.create()` never settles — the offscreen
 * handler then never calls `sendResponse` and this round-trip hangs
 * forever, leaving the panel stuck on "Loading…" with no error. The
 * timeout converts that hang into a rejection so the caller can surface
 * an error bubble + Retry.
 *
 * The window is short (a healthy cached load is ~10-30s) because timing
 * out is cheap: the offscreen `ensureSession` is a singleton, so if the
 * timeout fires while a legitimate cold download is still in progress,
 * clicking Retry rejoins the same in-flight load rather than restarting
 * it — nothing is lost. Better to surface "still working, keep waiting"
 * quickly than to hide a real hang behind a two-minute spinner.
 */
const WARMUP_TIMEOUT_MS = 30_000;

export async function warmupSession(opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? WARMUP_TIMEOUT_MS;
  await ensureViaServiceWorker();
  const request: CountTokensRequest = { type: COUNT_TOKENS_REQUEST, text: '' };

  const roundTrip = (async (): Promise<void> => {
    const reply = (await chrome.runtime.sendMessage(request)) as unknown;
    const lastError = chrome.runtime.lastError;
    if (lastError) {
      throw new Error(`warmup-session failed: ${lastError.message ?? 'unknown'}`);
    }
    if (!isCountTokensResponse(reply)) {
      throw new Error('warmup-session: malformed reply from offscreen');
    }
    if (!reply.ok) throw new Error(reply.error);
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Model load timed out after ${Math.round(timeoutMs / 1000)}s. On a first run it may still be downloading — click Retry to keep waiting. If it keeps timing out, the GPU is likely out of memory or the WebGPU device was lost; restart Chrome or set "device": "wasm" in .env.json.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    await Promise.race([roundTrip, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Query the offscreen environment for runtime info: device type
 * (webgpu/wasm), whether the WebGPU adapter is the software fallback,
 * the adapter's max single-buffer allocation (a usable proxy for VRAM
 * class), and any explicit override from `.env.json`. The chat layer
 * uses this to size its memory-pressure warning threshold to the
 * actual hardware.
 *
 * Queried once per session after warmup. Failures (transport error,
 * `chrome.runtime.lastError`, malformed reply, or `ok: false`) resolve
 * with a conservative shape rather than rejecting, so a transient
 * hiccup doesn't break warmup. The conservative shape
 * (`webgpu` / not-fallback / no buffer info / no override) maps to the
 * default history threshold via `deriveHistoryThreshold`, which is the
 * same outcome callers would get if they had to catch a rejection.
 */
export async function getGpuInfo(): Promise<GpuInfoSnapshot> {
  const conservative: GpuInfoSnapshot = {
    device: 'webgpu',
    isFallback: false,
    maxBufferSize: null,
    configuredThreshold: null,
  };
  try {
    await ensureViaServiceWorker();
    const request: GpuInfoRequest = { type: GPU_INFO_REQUEST };
    const reply = (await chrome.runtime.sendMessage(request)) as unknown;
    const lastError = chrome.runtime.lastError;
    if (lastError) {
      console.warn(`[local-nano] getGpuInfo: ${lastError.message ?? 'lastError set'}`);
      return conservative;
    }
    if (!isGpuInfoResponse(reply) || !reply.ok) {
      console.warn(
        '[local-nano] getGpuInfo: malformed or failed reply; using conservative defaults',
      );
      return conservative;
    }
    return {
      device: reply.device,
      isFallback: reply.isFallback,
      maxBufferSize: reply.maxBufferSize,
      configuredThreshold: reply.configuredThreshold,
    };
  } catch (err) {
    console.warn('[local-nano] getGpuInfo failed; using conservative defaults:', err);
    return conservative;
  }
}

/**
 * Force the offscreen polyfill session to rebuild, seeded with the given
 * conversation history. Used after a WebGPU device-loss event so the
 * model recovers without losing context.
 */
export async function rebuildSession(history: HistoryTurn[]): Promise<void> {
  await ensureViaServiceWorker();
  const request: RebuildSessionRequest = { type: REBUILD_SESSION_REQUEST, history };
  const reply = (await chrome.runtime.sendMessage(request)) as unknown;
  const lastError = chrome.runtime.lastError;
  if (lastError) {
    throw new Error(`rebuild-session failed: ${lastError.message ?? 'unknown'}`);
  }
  if (!isRebuildSessionResponse(reply)) {
    throw new Error('rebuild-session: malformed reply from offscreen');
  }
  if (!reply.ok) throw new Error(reply.error);
}
