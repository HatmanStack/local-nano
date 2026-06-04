/**
 * Message protocol between extension contexts and the offscreen document.
 *
 * Two channels:
 *
 * 1. **Ensure request** over `chrome.runtime.sendMessage`. Content scripts
 *    can't call `chrome.offscreen.*` directly, so they ask the service
 *    worker to create the offscreen document and wait for the ack before
 *    opening a stream. SW callers bypass this and call `ensureOffscreen`
 *    directly.
 *
 * 2. **Token streaming** over a long-lived `chrome.runtime.Port`
 *    (`STREAM_PORT_NAME`). The caller opens a port, posts a
 *    `StreamRequest`, and receives `StreamChunk` frames until a
 *    `StreamDone` frame closes the exchange. The caller can also post
 *    `StreamAbort` to cancel mid-stream.
 *
 * The streaming protocol carries an `id` per request so the same port
 * could host multiple sequential exchanges in the future. Today each
 * caller opens one port per stream and disconnects when done.
 */

// Type-only import: erases at build time so this introduces no runtime
// dependency on `ladder.ts` (and `ladder.ts` keeps zero protocol coupling).
// `WarmupTier` aliases `Tier` so the wire shape has ONE structural source.
import type { Tier } from './ladder.js';

export const ENSURE_OFFSCREEN_REQUEST = 'offscreen/ensure-request' as const;
export const ENSURE_OFFSCREEN_RESPONSE = 'offscreen/ensure-response' as const;

export interface EnsureOffscreenRequest {
  type: typeof ENSURE_OFFSCREEN_REQUEST;
}

export type EnsureOffscreenResponse =
  | { type: typeof ENSURE_OFFSCREEN_RESPONSE; ok: true }
  | { type: typeof ENSURE_OFFSCREEN_RESPONSE; ok: false; error: string };

export function isEnsureOffscreenRequest(value: unknown): value is EnsureOffscreenRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (value as Record<string, unknown>).type === ENSURE_OFFSCREEN_REQUEST;
}

export function isEnsureOffscreenResponse(value: unknown): value is EnsureOffscreenResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== ENSURE_OFFSCREEN_RESPONSE) return false;
  if (v.ok === true) return true;
  if (v.ok === false) return typeof v.error === 'string';
  return false;
}

export const RECREATE_OFFSCREEN_REQUEST = 'offscreen/recreate-request' as const;
export const RECREATE_OFFSCREEN_RESPONSE = 'offscreen/recreate-response' as const;

/**
 * Force-recreate the offscreen document (ADR-R4). Asks the service worker to
 * reset the sticky `documentReady` (via `closeOffscreen`) and create a fresh
 * document. Distinct from `ENSURE_OFFSCREEN_REQUEST`, which trusts the sticky
 * flag and can no-op against a crashed document. Carries no tier in Phase 1;
 * the fresh document loads the base tier on first use.
 */
export interface RecreateOffscreenRequest {
  type: typeof RECREATE_OFFSCREEN_REQUEST;
}

export type RecreateOffscreenResponse =
  | { type: typeof RECREATE_OFFSCREEN_RESPONSE; ok: true }
  | { type: typeof RECREATE_OFFSCREEN_RESPONSE; ok: false; error: string };

export function isRecreateOffscreenRequest(value: unknown): value is RecreateOffscreenRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (value as Record<string, unknown>).type === RECREATE_OFFSCREEN_REQUEST;
}

export function isRecreateOffscreenResponse(value: unknown): value is RecreateOffscreenResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== RECREATE_OFFSCREEN_RESPONSE) return false;
  if (v.ok === true) return true;
  if (v.ok === false) return typeof v.error === 'string';
  return false;
}

export const REBUILD_SESSION_REQUEST = 'offscreen/rebuild-session-request' as const;
export const REBUILD_SESSION_RESPONSE = 'offscreen/rebuild-session-response' as const;

/**
 * A single prior turn used to re-seed the polyfill session after a forced
 * teardown (e.g. WebGPU device loss). `text` is the rendered content the
 * user saw in the panel; the offscreen side maps `model` → `assistant`
 * before handing to the polyfill's `initialPrompts`.
 */
export interface HistoryTurn {
  role: 'user' | 'model';
  text: string;
}

export interface RebuildSessionRequest {
  type: typeof REBUILD_SESSION_REQUEST;
  history: HistoryTurn[];
}

export type RebuildSessionResponse =
  | { type: typeof REBUILD_SESSION_RESPONSE; ok: true }
  | { type: typeof REBUILD_SESSION_RESPONSE; ok: false; error: string };

export function isRebuildSessionRequest(value: unknown): value is RebuildSessionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== REBUILD_SESSION_REQUEST) return false;
  if (!Array.isArray(v.history)) return false;
  return v.history.every((turn: unknown) => {
    if (typeof turn !== 'object' || turn === null) return false;
    const t = turn as Record<string, unknown>;
    return (t.role === 'user' || t.role === 'model') && typeof t.text === 'string';
  });
}

export function isRebuildSessionResponse(value: unknown): value is RebuildSessionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== REBUILD_SESSION_RESPONSE) return false;
  if (v.ok === true) return true;
  if (v.ok === false) return typeof v.error === 'string';
  return false;
}

export const GPU_INFO_REQUEST = 'offscreen/gpu-info-request' as const;
export const GPU_INFO_RESPONSE = 'offscreen/gpu-info-response' as const;

/**
 * Snapshot of the offscreen environment used by the chat layer to size
 * its memory-pressure warning threshold to the actual hardware. Queried
 * once per session after warmup completes.
 *
 * `device` mirrors `.env.json` (`webgpu` or `wasm`). `isFallback` is
 * true when the WebGPU adapter is the software fallback (Dawn's SwANGLE
 * path), which is heavily constrained. `maxBufferSize` is the WebGPU
 * adapter's single-allocation ceiling in bytes — not total VRAM, but a
 * usable proxy for hardware class. `configuredThreshold` mirrors an
 * optional `historyTokenWarnThreshold` field in `.env.json` so power
 * users can override the derived default.
 */
export interface GpuInfoSnapshot {
  device: 'webgpu' | 'wasm';
  isFallback: boolean;
  maxBufferSize: number | null;
  configuredThreshold: number | null;
}

export interface GpuInfoRequest {
  type: typeof GPU_INFO_REQUEST;
}

export type GpuInfoResponse =
  | ({ type: typeof GPU_INFO_RESPONSE; ok: true } & GpuInfoSnapshot)
  | { type: typeof GPU_INFO_RESPONSE; ok: false; error: string };

export function isGpuInfoRequest(value: unknown): value is GpuInfoRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (value as Record<string, unknown>).type === GPU_INFO_REQUEST;
}

export function isGpuInfoResponse(value: unknown): value is GpuInfoResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== GPU_INFO_RESPONSE) return false;
  if (v.ok === true) {
    if (v.device !== 'webgpu' && v.device !== 'wasm') return false;
    if (typeof v.isFallback !== 'boolean') return false;
    if (v.maxBufferSize !== null && !Number.isFinite(v.maxBufferSize)) return false;
    if (v.configuredThreshold !== null && !Number.isFinite(v.configuredThreshold)) return false;
    return true;
  }
  if (v.ok === false) return typeof v.error === 'string';
  return false;
}

export const TOUCH_IDLE_REQUEST = 'idle/touch-request' as const;
export const TOUCH_IDLE_RESPONSE = 'idle/touch-response' as const;

/**
 * Idle-release touch (ADR-P8). Sent content-script-to-SW on each generation so
 * the SW (re)schedules the single named idle alarm to `now + timeout`. Carries
 * no payload: the SW reads the configured timeout from `chrome.storage.local`
 * itself, since a freshly woken SW (post-eviction) has no in-memory state. The
 * client never throws on this round-trip, so a failed schedule cannot break a
 * send.
 */
export interface TouchIdleRequest {
  type: typeof TOUCH_IDLE_REQUEST;
}

export type TouchIdleResponse =
  | { type: typeof TOUCH_IDLE_RESPONSE; ok: true }
  | { type: typeof TOUCH_IDLE_RESPONSE; ok: false; error: string };

export function isTouchIdleRequest(value: unknown): value is TouchIdleRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (value as Record<string, unknown>).type === TOUCH_IDLE_REQUEST;
}

export function isTouchIdleResponse(value: unknown): value is TouchIdleResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== TOUCH_IDLE_RESPONSE) return false;
  if (v.ok === true) return true;
  if (v.ok === false) return typeof v.error === 'string';
  return false;
}

export const IS_BUSY_REQUEST = 'idle/is-busy-request' as const;
export const IS_BUSY_RESPONSE = 'idle/is-busy-response' as const;

/**
 * Verify-idle probe (ADR-P9). Sent SW-to-offscreen when the idle alarm fires:
 * the offscreen document owns the live generation state, so the SW asks whether
 * a generation is in flight before closing. The offscreen document only REPORTS
 * its `generationGate.busy` state and never closes itself (constraint 3). A
 * malformed/absent reply is treated as not-busy by the SW (a gone document is
 * idle-and-closable).
 */
export interface IsBusyRequest {
  type: typeof IS_BUSY_REQUEST;
}

export type IsBusyResponse =
  | { type: typeof IS_BUSY_RESPONSE; ok: true; busy: boolean }
  | { type: typeof IS_BUSY_RESPONSE; ok: false; error: string };

export function isIsBusyRequest(value: unknown): value is IsBusyRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (value as Record<string, unknown>).type === IS_BUSY_REQUEST;
}

export function isIsBusyResponse(value: unknown): value is IsBusyResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== IS_BUSY_RESPONSE) return false;
  if (v.ok === true) return typeof v.busy === 'boolean';
  if (v.ok === false) return typeof v.error === 'string';
  return false;
}

export const SESSION_POISONED_REQUEST = 'offscreen/session-poisoned-request' as const;
export const SESSION_POISONED_RESPONSE = 'offscreen/session-poisoned-response' as const;

/**
 * Poisoned-session push (Layer A, ADR-1). The offscreen document sends this
 * fire-and-forget to the service worker the moment a captured `GPUDevice`'s
 * `lost` event fires. The SW flips a sticky `sessionPoisoned` flag and, on the
 * next `ENSURE_OFFSCREEN_REQUEST`, recreates the offscreen document (when not
 * busy) so the next user send runs on a healthy session. `at` is the ISO 8601
 * loss timestamp; `reason`/`message` mirror the WebGPU `GPUDeviceLostInfo`
 * fields for diagnostics. The offscreen does not await the reply (push, not
 * pull); the ack exists for protocol uniformity and test observability.
 */
export interface SessionPoisonedRequest {
  type: typeof SESSION_POISONED_REQUEST;
  at: string;
  reason: string;
  message: string;
}

export type SessionPoisonedResponse =
  | { type: typeof SESSION_POISONED_RESPONSE; ok: true }
  | { type: typeof SESSION_POISONED_RESPONSE; ok: false; error: string };

export function isSessionPoisonedRequest(value: unknown): value is SessionPoisonedRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== SESSION_POISONED_REQUEST) return false;
  return typeof v.at === 'string' && typeof v.reason === 'string' && typeof v.message === 'string';
}

export function isSessionPoisonedResponse(value: unknown): value is SessionPoisonedResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== SESSION_POISONED_RESPONSE) return false;
  if (v.ok === true) return true;
  if (v.ok === false) return typeof v.error === 'string';
  return false;
}

export const COUNT_TOKENS_REQUEST = 'offscreen/count-tokens-request' as const;
export const COUNT_TOKENS_RESPONSE = 'offscreen/count-tokens-response' as const;

export interface CountTokensRequest {
  type: typeof COUNT_TOKENS_REQUEST;
  text: string;
}

export type CountTokensResponse =
  | { type: typeof COUNT_TOKENS_RESPONSE; ok: true; count: number }
  | { type: typeof COUNT_TOKENS_RESPONSE; ok: false; error: string };

export function isCountTokensRequest(value: unknown): value is CountTokensRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === COUNT_TOKENS_REQUEST && typeof v.text === 'string';
}

export function isCountTokensResponse(value: unknown): value is CountTokensResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== COUNT_TOKENS_RESPONSE) return false;
  if (v.ok === true) return typeof v.count === 'number' && Number.isFinite(v.count);
  if (v.ok === false) return typeof v.error === 'string';
  return false;
}

export const WARMUP_REQUEST = 'offscreen/warmup-request' as const;
export const WARMUP_RESPONSE = 'offscreen/warmup-response' as const;

/**
 * One `{ modelName, device, dtype }` triple the ladder can ask the offscreen
 * document to load (ADR-R7). This is the WIRE MIRROR of `Tier` in `ladder.ts`:
 * it shares ONE structural source via a TYPE-ONLY import so a field added to
 * `Tier` propagates here automatically and the offscreen side needs no hand
 * conversion (ADR-3 / HEALTH MED-3). The import is type-only, so it erases at
 * build time — `ladder.ts` gains no runtime protocol dependency, preserving its
 * freedom from Chrome/protocol RUNTIME imports. The runtime validator
 * `isWarmupTier` below still structurally validates the wire shape.
 */
export type WarmupTier = Tier;

/**
 * Block-load (warmup) the offscreen session, optionally dictating the tier to
 * load (Phase 2, ADR-R2). When `tier` is present the offscreen document
 * overrides `window.TRANSFORMERS_CONFIG` with that model/device/dtype before
 * `LanguageModel.create()`. When absent the offscreen document loads its base
 * tier (the static `.env.json` import). Distinct from `COUNT_TOKENS_REQUEST`,
 * which is also used mid-session for the soft cap and must not carry tier
 * semantics.
 */
export interface WarmupRequest {
  type: typeof WARMUP_REQUEST;
  tier?: WarmupTier;
}

export type WarmupResponse =
  | { type: typeof WARMUP_RESPONSE; ok: true }
  | { type: typeof WARMUP_RESPONSE; ok: false; error: string };

function isWarmupTier(value: unknown): value is WarmupTier {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.modelName !== 'string' || v.modelName.length === 0) return false;
  if (v.device !== 'webgpu' && v.device !== 'wasm') return false;
  return typeof v.dtype === 'string' && v.dtype.length > 0;
}

export function isWarmupRequest(value: unknown): value is WarmupRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== WARMUP_REQUEST) return false;
  // tier is optional; when present it must be well-formed.
  if (v.tier === undefined) return true;
  return isWarmupTier(v.tier);
}

export function isWarmupResponse(value: unknown): value is WarmupResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== WARMUP_RESPONSE) return false;
  if (v.ok === true) return true;
  if (v.ok === false) return typeof v.error === 'string';
  return false;
}

export const STREAM_PORT_NAME = 'offscreen-stream' as const;

export const STREAM_REQUEST = 'stream/request' as const;
export const STREAM_CHUNK = 'stream/chunk' as const;
export const STREAM_DONE = 'stream/done' as const;
export const STREAM_ABORT = 'stream/abort' as const;

export interface StreamRequest {
  type: typeof STREAM_REQUEST;
  id: string;
  prompt: string;
}

export interface StreamChunk {
  type: typeof STREAM_CHUNK;
  id: string;
  value: string;
}

export type StreamDone =
  | { type: typeof STREAM_DONE; id: string; ok: true }
  | { type: typeof STREAM_DONE; id: string; ok: false; error: string };

export interface StreamAbort {
  type: typeof STREAM_ABORT;
  id: string;
}

export type StreamServerMessage = StreamChunk | StreamDone;
export type StreamClientMessage = StreamRequest | StreamAbort;

export function isStreamRequest(value: unknown): value is StreamRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === STREAM_REQUEST && typeof v.id === 'string' && typeof v.prompt === 'string';
}

export function isStreamAbort(value: unknown): value is StreamAbort {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === STREAM_ABORT && typeof v.id === 'string';
}

export function isStreamChunk(value: unknown): value is StreamChunk {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === STREAM_CHUNK && typeof v.id === 'string' && typeof v.value === 'string';
}

export function isStreamDone(value: unknown): value is StreamDone {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== STREAM_DONE) return false;
  if (typeof v.id !== 'string') return false;
  if (v.ok === true) return true;
  if (v.ok === false) return typeof v.error === 'string';
  return false;
}

/**
 * Dedicated long-lived port for first-run download progress (ADR-R10).
 * Separate from the stream port and the one-shot warmup `sendMessage`: the
 * warmup round-trip has no push channel, so incremental progress needs its
 * own port. The panel opens this port during warmup and the offscreen
 * document forwards each polyfill `downloadprogress` event as a
 * `ProgressFrame`. A recreated document opens a fresh port per warmup.
 */
export const STREAM_PROGRESS_PORT = 'offscreen-progress' as const;
export const STREAM_PROGRESS = 'stream/progress' as const;

/**
 * Panel-pin port (Layer B, Phase 3, ADR-2). Content script -> service worker.
 * Lifetime is panel visibility: the content script opens this port when the
 * chat panel becomes visible and disconnects it when the panel hides. The SW
 * counts open ports of this name; the port carries no messages, its mere
 * existence is the "a panel is open" signal. The `local-nano-` prefix
 * disambiguates this content-side port from the offscreen-document-side ports
 * (offscreen-stream, offscreen-progress, offscreen-pin).
 */
export const PANEL_PIN_PORT_NAME = 'local-nano-panel-pin' as const;

/**
 * Offscreen-pin port (Layer B, Phase 3, ADR-2). Service worker -> offscreen
 * document. Lifetime is "any panel-pin open": the SW opens this port to the
 * offscreen on the 0->1 panel-pin transition and disconnects it on the 1->0
 * transition (deferred while the offscreen is busy). The open port prevents
 * Chrome's 30-second no-port reap from closing the offscreen document while a
 * panel is open. Carries no messages.
 */
export const OFFSCREEN_PIN_PORT_NAME = 'offscreen-pin' as const;

/**
 * One forwarded `downloadprogress` ProgressEvent. The polyfill dispatches
 * `new ProgressEvent('downloadprogress', { loaded, total, lengthComputable })`
 * (`prompt-api-polyfill.js` `dispatchProgress`); the offscreen monitor reads
 * `loaded`/`total` and posts this frame. The pure parser in `progress.ts`
 * consumes the numeric fields.
 */
export interface ProgressFrame {
  type: typeof STREAM_PROGRESS;
  loaded: number;
  total: number;
}

export function isProgressFrame(value: unknown): value is ProgressFrame {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== STREAM_PROGRESS) return false;
  return (
    typeof v.loaded === 'number' &&
    Number.isFinite(v.loaded) &&
    typeof v.total === 'number' &&
    Number.isFinite(v.total)
  );
}
