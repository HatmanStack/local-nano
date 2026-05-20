/**
 * Generic "stream a prompt over a chrome.runtime.Port" helper, callable
 * from any extension context (service worker, content script, popup).
 *
 * The caller supplies an `ensure` function that guarantees the offscreen
 * document exists before the port is opened. SW callers pass a direct
 * `ensureOffscreen()`; content scripts pass a sendMessage-based shim.
 * Keeping the ensure strategy as an argument means the port logic itself
 * has no per-context branches.
 */

import {
  isStreamChunk,
  isStreamDone,
  STREAM_ABORT,
  STREAM_PORT_NAME,
  STREAM_REQUEST,
  type StreamAbort,
  type StreamRequest,
} from './protocol.js';

export interface StreamPromptOptions {
  /** Called for every token chunk as it streams in. */
  onChunk?: (chunk: string) => void;
  /** Aborts the stream when fired; the offscreen side cancels generation. */
  signal?: AbortSignal;
}

function makeId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Open a one-shot streaming connection to the offscreen document and
 * resolve with the full concatenated text once `stream/done` arrives.
 *
 * `ensure` is awaited before the port is opened. Pass `ensureOffscreen`
 * directly from the SW, or a sendMessage-based ensure from a content
 * script.
 */
export async function streamOverPort(
  prompt: string,
  opts: StreamPromptOptions,
  ensure: () => Promise<void>,
): Promise<string> {
  await ensure();

  return new Promise<string>((resolve, reject) => {
    const id = makeId();
    const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });

    let accumulated = '';
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      try {
        port.disconnect();
      } catch {
        // Already disconnected — fine.
      }
    };

    const onAbort = () => {
      if (settled) return;
      const abortMsg: StreamAbort = { type: STREAM_ABORT, id };
      try {
        port.postMessage(abortMsg);
      } catch {
        // Port may already be gone; the offscreen side detects via
        // onDisconnect either way.
      }
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      opts.signal.addEventListener('abort', onAbort);
    }

    port.onMessage.addListener((message: unknown) => {
      if (settled) return;
      if (isStreamChunk(message) && message.id === id) {
        accumulated += message.value;
        opts.onChunk?.(message.value);
        return;
      }
      if (isStreamDone(message) && message.id === id) {
        cleanup();
        if (message.ok) {
          resolve(accumulated);
        } else {
          reject(new Error(message.error));
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      const lastError = chrome.runtime.lastError;
      cleanup();
      reject(new Error(`offscreen port disconnected: ${lastError?.message ?? 'unknown reason'}`));
    });

    const request: StreamRequest = { type: STREAM_REQUEST, id, prompt };
    try {
      port.postMessage(request);
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
