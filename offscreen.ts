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
 * The heavy `@huggingface/transformers` import lives only here, in the
 * offscreen document — the chat layer (`src/session.ts`) holds no model and
 * streams over a port instead. The load is deliberately inline in this entry
 * file: v0.2 extracted it into a shared `src/heavy.ts` helper and that was
 * reverted, keeping the offscreen session self-contained.
 */

import transformersConfig from './.env.json';
import { debugLog } from './src/debug.js';
import { BusyGate } from './src/offscreen/busy-gate.js';
import { classifyOffscreenMessage } from './src/offscreen/dispatch.js';
import { applyTierToConfig, type Tier, tierKey } from './src/offscreen/ladder.js';
import {
  COUNT_TOKENS_RESPONSE,
  type CountTokensRequest,
  type CountTokensResponse,
  GPU_INFO_RESPONSE,
  type GpuInfoResponse,
  type HistoryTurn,
  IS_BUSY_RESPONSE,
  type IsBusyResponse,
  isStreamAbort,
  isStreamRequest,
  type ProgressFrame,
  REBUILD_SESSION_RESPONSE,
  type RebuildSessionRequest,
  type RebuildSessionResponse,
  STREAM_CHUNK,
  STREAM_DONE,
  STREAM_PORT_NAME,
  STREAM_PROGRESS,
  STREAM_PROGRESS_PORT,
  type StreamChunk,
  type StreamDone,
  WARMUP_RESPONSE,
  type WarmupRequest,
  type WarmupResponse,
} from './src/offscreen/protocol.js';

interface LanguageModelSession {
  promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>;
  measureContextUsage(input: string): Promise<number>;
  destroy(): void;
}

/**
 * The polyfill's public `monitor` callback (ADR-R10). The polyfill calls
 * `monitor(monitorTarget)` with a fresh `EventTarget` per `create()` and
 * dispatches `downloadprogress` ProgressEvents on it. We attach a listener and
 * relay `loaded`/`total` to the panel. Read through the public surface only;
 * no polyfill patching.
 */
type ProgressMonitorTarget = EventTarget;
type ProgressMonitor = (target: ProgressMonitorTarget) => void;
interface DownloadProgressEvent extends Event {
  loaded?: number;
  total?: number;
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

// The tier currently loaded into the live session (Phase 2, ADR-R2). Null until
// a warmup with an explicit tier lands. Tracked module-scoped so a tier change
// can guard against overlapping a prior generator (ADR-R1/R3) and so the
// diagnostic can report what was loading. The panel drives the ladder and is
// the source of truth; this is the offscreen-side mirror for the guard.
let activeTier: Tier | null = null;

// One generation at a time against the single shared session. The
// polyfill mutates one `#history`; two ports streaming concurrently would
// interleave on one ONNX generator and corrupt that history, so a second
// `stream/request` is rejected with a busy error rather than queued
// (reject-when-busy is YAGNI-sufficient for a single-user extension). The
// gate is module-scoped because the session it guards is module-scoped.
const generationGate = new BusyGate();

// Connected first-run progress ports (ADR-R10). In practice at most one panel
// warms at a time, but tolerate zero or many cleanly. Each `downloadprogress`
// event is forwarded to every connected port; a disconnected port is dropped
// on its own onDisconnect and a postMessage to a stale port is swallowed.
const progressPorts = new Set<chrome.runtime.Port>();

/**
 * Forward one progress event to every connected progress port. A disconnected
 * panel must not break the load, so each post is individually guarded.
 */
function broadcastProgress(loaded: number, total: number): void {
  const frame: ProgressFrame = { type: STREAM_PROGRESS, loaded, total };
  for (const port of progressPorts) {
    try {
      port.postMessage(frame);
    } catch {
      // Port gone; its onDisconnect removes it from the set.
    }
  }
}

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

/**
 * Build (or return the in-flight singleton for) the shared session.
 *
 * `onProgress` is the ADR-R10 hook: when provided, a `monitor` is passed into
 * the polyfill `create()` so each `downloadprogress` event's `loaded`/`total`
 * is relayed to the panel. The monitor is per `create()`; it only fires on the
 * one load this call kicks off. A concurrent caller that shares the existing
 * `sessionPromise` does not re-attach a monitor (the download already started),
 * which is fine: there is one panel warming at a time in practice.
 */
function ensureSession(
  history?: HistoryTurn[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<LanguageModelSession> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    try {
      const { LanguageModel } = await loadHeavy();
      const monitor: ProgressMonitor | undefined = onProgress
        ? (target) => {
            target.addEventListener('downloadprogress', (event: Event) => {
              const e = event as DownloadProgressEvent;
              if (typeof e.loaded === 'number' && typeof e.total === 'number') {
                onProgress(e.loaded, e.total);
              }
            });
          }
        : undefined;
      return await LanguageModel.create({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: buildInitialPrompts(history),
        ...(monitor ? { monitor } : {}),
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
  // Clear the tier mirror too: it must not outlive the session it describes.
  // Leaving it stale here is a latent OOM-guard bypass — if the handleWarmup
  // destroy-guard (ADR-R1/R3) is ever reordered, a stale activeTier could skip
  // the destroy that prevents overlapping loads.
  activeTier = null;
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
    // Skip the measure while a generation holds the gate (eval Pragmatism 8->9,
    // ADR-1): measureContextUsage touches the shared session, which a concurrent
    // warmup teardown could be tearing down. Reply non-fatal so the client's
    // heuristic fallback takes over — a skipped count never blocks a transform.
    if (generationGate.busy) {
      const busy: CountTokensResponse = {
        type: COUNT_TOKENS_RESPONSE,
        ok: false,
        error: 'busy: a generation is in progress',
      };
      sendResponse(busy);
      return;
    }
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

// Warmup channel (Phase 2). Block-loads the session, optionally dictating the
// tier to load (ADR-R2). When a tier is present, override
// `window.TRANSFORMERS_CONFIG` with the tier's model/device/dtype before
// `ensureSession()` builds the polyfill session (the polyfill and the
// transformers backend each read the config fresh per `create()`). A hard crash
// drops the channel instead of replying; the panel detects that client-side.
function handleWarmup(msg: WarmupRequest, sendResponse: SendResponse): void {
  (async () => {
    try {
      if (msg.tier) {
        const tier: Tier = {
          modelName: msg.tier.modelName,
          device: msg.tier.device,
          dtype: msg.tier.dtype,
        };
        // Safety net for a soft tier change inside a still-live document
        // (ADR-R1/R3): if a session is already loaded for a DIFFERENT tier,
        // destroy it and null sessionPromise before creating, so two loads never
        // overlap. The normal ladder advance recreates the whole document first,
        // so sessionPromise is null and this is a no-op.
        const tierChange =
          sessionPromise !== null && (activeTier === null || tierKey(activeTier) !== tierKey(tier));
        // Enforce the single-load invariant via the gate MECHANISM, not the
        // caller contract (eval Pragmatism 8->9, ADR-1). The destructive teardown
        // below would destroy the live session and start a second load; if a
        // generation holds the gate, that overlaps a load with an in-flight
        // generator — the v0.2.0 OOM. Refuse while busy (mirrors the stream
        // path's reject-when-busy policy) so a future warmup entry point cannot
        // reintroduce the overlap. The check is a one-liner against the existing
        // BusyGate, so no extracted predicate is warranted (Phase 2 step 5).
        // Loading a fresh session when none exists (no tier change) is NOT a
        // concurrency hazard, so it is left unguarded below.
        if (tierChange && generationGate.busy) {
          const busy: WarmupResponse = {
            type: WARMUP_RESPONSE,
            ok: false,
            error: 'busy: a generation is in progress',
          };
          sendResponse(busy);
          return;
        }
        if (tierChange) {
          try {
            const previous = await sessionPromise;
            previous?.destroy();
          } catch {
            // Prior session may have failed to load; nothing to destroy.
          }
          sessionPromise = null;
        }
        activeTier = tier;
        // Load the heavy singleton BEFORE applying the override. loadHeavy()
        // sets window.TRANSFORMERS_CONFIG to the base import as part of its
        // one-time init; on a freshly recreated document (heavyPromise === null,
        // i.e. every ladder rung) that reset would otherwise clobber the tier
        // override before LanguageModel.create() reads it — so every rung would
        // load the base .env.json config and the ladder would never actually
        // vary dtype/device. Running it first lets the override land last;
        // ensureSession's own loadHeavy() below then returns the cached promise
        // and does not reset the config again.
        await loadHeavy();
        // Override the in-memory config (never the on-disk .env.json). The
        // base import supplies tier 0 / apiKey; this overrides model/device/dtype.
        (window as unknown as Record<string, unknown>).TRANSFORMERS_CONFIG = applyTierToConfig(
          transformersConfig as Record<string, unknown>,
          tier,
        );
      }
      // Relay download progress to any connected progress port (ADR-R10). The
      // broadcast is per-event and individually guarded, so a disconnected
      // panel never breaks the load.
      await ensureSession(undefined, broadcastProgress);
      const ok: WarmupResponse = { type: WARMUP_RESPONSE, ok: true };
      sendResponse(ok);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const fail: WarmupResponse = { type: WARMUP_RESPONSE, ok: false, error: message };
      sendResponse(fail);
    }
  })();
}

// Verify-idle probe (ADR-P9). Report whether a generation is in flight so the
// service worker can decide to close the document or reschedule the idle alarm.
// The single shared `generationGate` is the authoritative one-at-a-time signal.
// This handler ONLY reports state: the offscreen document never closes itself
// (constraint 3); the SW owns `closeOffscreen()` and the sticky `documentReady`.
function handleIsBusy(sendResponse: SendResponse): void {
  const reply: IsBusyResponse = { type: IS_BUSY_RESPONSE, ok: true, busy: generationGate.busy };
  sendResponse(reply);
}

// Single dispatcher for the five request channels. Sibling
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
    // classifyOffscreenMessage validated the shape with the same protocol
    // guard, and each handler closes the reply channel via its own try/catch,
    // so call unconditionally. A re-guard here could only fail on dispatch/
    // protocol drift, and a false guard would skip the handler while still
    // returning true — leaking the open reply channel until Chrome times it out.
    case 'rebuild-session':
      handleRebuildSession(msg as RebuildSessionRequest, sendResponse);
      return true;
    case 'count-tokens':
      handleCountTokens(msg as CountTokensRequest, sendResponse);
      return true;
    case 'warmup':
      handleWarmup(msg as WarmupRequest, sendResponse);
      return true;
    case 'is-busy':
      handleIsBusy(sendResponse);
      return true;
  }
});

// First-run download-progress port (ADR-R10). The panel opens this during
// warmup; the offscreen monitor broadcasts `downloadprogress` frames to it.
// Fire-and-forget: it carries no inbound messages, just the relayed frames.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== STREAM_PROGRESS_PORT) return;
  progressPorts.add(port);
  port.onDisconnect.addListener(() => {
    progressPorts.delete(port);
  });
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
