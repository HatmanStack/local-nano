/**
 * Content-script (and popup) facing client for the offscreen model host.
 *
 * Content scripts can't call `chrome.offscreen.*` directly, so they ask
 * the service worker to ensure the document via `sendMessage` before
 * opening a port. The streaming logic itself is shared with the SW path
 * via `streamOverPort`.
 */

import {
  ENSURE_OFFSCREEN_REQUEST,
  type EnsureOffscreenRequest,
  type HistoryTurn,
  isEnsureOffscreenResponse,
  isRebuildSessionResponse,
  REBUILD_SESSION_REQUEST,
  type RebuildSessionRequest,
} from './protocol.js';
import { type StreamPromptOptions, streamOverPort } from './stream-client.js';

export type { StreamPromptOptions } from './stream-client.js';

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
