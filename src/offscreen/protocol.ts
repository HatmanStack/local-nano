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
