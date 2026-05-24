/**
 * Content-script (and popup) facing client for the offscreen model host.
 *
 * Content scripts can't call `chrome.offscreen.*` directly, so they ask
 * the service worker to ensure the document via `sendMessage` before
 * opening a port. The streaming logic itself is shared with the SW path
 * via `streamOverPort`.
 */

import type { Tier } from './ladder.js';
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
  isProgressFrame,
  isRebuildSessionResponse,
  isRecreateOffscreenResponse,
  isWarmupResponse,
  REBUILD_SESSION_REQUEST,
  RECREATE_OFFSCREEN_REQUEST,
  type RebuildSessionRequest,
  type RecreateOffscreenRequest,
  STREAM_PROGRESS_PORT,
  WARMUP_REQUEST,
  type WarmupRequest,
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
 * When `tier` is provided (Phase 2, the ladder walk), the offscreen
 * document overrides `window.TRANSFORMERS_CONFIG` with that
 * model/device/dtype before `LanguageModel.create()` (ADR-R2), so each
 * rung loads the dictated tier. Without a tier the offscreen document
 * loads its base tier (the static `.env.json` import). The panel
 * force-recreates the document between failed rungs (ADR-R3/R4) so a
 * tier change never overlaps two loads.
 *
 * Implemented as a dedicated `WARMUP_REQUEST` round-trip without a
 * timeout race — we want to actually wait for the load to complete. The
 * offscreen side dedupes via its `sessionPromise` singleton, so multiple
 * concurrent warmups across tabs share one load.
 *
 * NO TIMEOUT: a first run downloads multi-GB weights and can legitimately
 * take minutes, so a fixed timeout here false-fails a slow-but-healthy
 * load. Instead the chat layer (`ensureWarm`) shows a live elapsed
 * counter as proof-of-life and, if the load drags, appends remedies
 * without giving up. A genuine failure still rejects this promise:
 * the offscreen handler catches a load error and returns `ok: false`,
 * which throws below. The only unhandled case is an out-of-band GPU
 * error that hangs `LanguageModel.create()` without rejecting — that
 * surfaces to the user as a stuck elapsed counter with remedies, which
 * they can act on (reload / wasm) rather than being told a healthy load
 * "failed".
 */
export async function warmupSession(tier?: Tier): Promise<void> {
  await ensureViaServiceWorker();
  const request: WarmupRequest = tier ? { type: WARMUP_REQUEST, tier } : { type: WARMUP_REQUEST };
  const reply = (await chrome.runtime.sendMessage(request)) as unknown;
  const lastError = chrome.runtime.lastError;
  if (lastError) {
    throw new Error(`warmup-session failed: ${lastError.message ?? 'unknown'}`);
  }
  if (!isWarmupResponse(reply)) {
    throw new Error('warmup-session: malformed reply from offscreen');
  }
  if (!reply.ok) throw new Error(reply.error);
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
 * Subscribe to first-run download progress (ADR-R10). Ensures the offscreen
 * document exists, opens a long-lived `STREAM_PROGRESS_PORT`, and calls
 * `onFrame(loaded, total)` for each `downloadprogress` event the offscreen
 * monitor relays. Returns an unsubscribe function that disconnects the port.
 *
 * Fire-and-forget: it never rejects. A failed ensure or a port disconnect just
 * means no frames arrive, and the panel falls back to the elapsed counter. The
 * subscription is per warmup invocation; a recreated document opens a fresh
 * port the next time this is called.
 */
export function subscribeProgress(onFrame: (loaded: number, total: number) => void): () => void {
  let port: chrome.runtime.Port | null = null;
  let cancelled = false;

  const disconnect = () => {
    cancelled = true;
    if (port) {
      try {
        port.disconnect();
      } catch {
        // Already disconnected — fine.
      }
      port = null;
    }
  };

  void (async () => {
    try {
      await ensureViaServiceWorker();
    } catch {
      // No offscreen document; no progress to relay. The panel falls back to
      // the elapsed counter.
      return;
    }
    if (cancelled) return;
    port = chrome.runtime.connect({ name: STREAM_PROGRESS_PORT });
    port.onMessage.addListener((message: unknown) => {
      if (isProgressFrame(message)) onFrame(message.loaded, message.total);
    });
    port.onDisconnect.addListener(() => {
      port = null;
    });
  })();

  return disconnect;
}

/**
 * Force-recreate the offscreen document (ADR-R4). Asks the service worker to
 * reset the sticky `documentReady` and build a fresh document, recovering a
 * document that itself crashed (which `rebuildSession` cannot, since it only
 * rebuilds the polyfill session inside a live document). Throws on
 * `chrome.runtime.lastError`, a malformed reply, or `ok:false`.
 */
export async function recreateOffscreen(): Promise<void> {
  const request: RecreateOffscreenRequest = { type: RECREATE_OFFSCREEN_REQUEST };
  const reply = (await chrome.runtime.sendMessage(request)) as unknown;
  const lastError = chrome.runtime.lastError;
  if (lastError) {
    throw new Error(`recreate-offscreen failed: ${lastError.message ?? 'unknown'}`);
  }
  if (!isRecreateOffscreenResponse(reply)) {
    throw new Error('recreate-offscreen: malformed reply from service worker');
  }
  if (!reply.ok) throw new Error(reply.error);
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
