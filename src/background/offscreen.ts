/**
 * Service-worker-side helper for the offscreen-document model host.
 *
 * Lifecycle: lazy `chrome.offscreen.createDocument` on first ensure call;
 * no teardown in production (the whole point is keeping the model warm).
 * `closeOffscreen` exists for tests and explicit reset.
 *
 * Content scripts cannot call `chrome.offscreen.*`, so they ask the SW to
 * ensure the document is up via `ENSURE_OFFSCREEN_REQUEST`. The matching
 * `chrome.runtime.onMessage` listener registered by `installEnsureListener`
 * is what fields those requests. Streaming itself uses the shared
 * `streamOverPort` helper so the wire logic is identical across contexts.
 */

import {
  ENSURE_OFFSCREEN_RESPONSE,
  type EnsureOffscreenResponse,
  isEnsureOffscreenRequest,
  isRecreateOffscreenRequest,
  RECREATE_OFFSCREEN_RESPONSE,
  type RecreateOffscreenResponse,
} from '../offscreen/protocol.js';
import { type StreamPromptOptions, streamOverPort } from '../offscreen/stream-client.js';

const OFFSCREEN_URL = 'dist/offscreen.html';
const OFFSCREEN_REASONS = ['WORKERS'] as const;
const OFFSCREEN_JUSTIFICATION = 'Hosts shared LanguageModel session backed by ONNX/WebGPU.';

let createInFlight: Promise<void> | null = null;
let documentReady = false;

async function offscreenAlreadyExists(): Promise<boolean> {
  if (documentReady) return true;
  const hasDocument = (chrome.offscreen as unknown as { hasDocument?: () => Promise<boolean> })
    .hasDocument;
  if (typeof hasDocument === 'function') {
    try {
      const exists = await hasDocument.call(chrome.offscreen);
      if (exists) documentReady = true;
      return exists;
    } catch {
      return false;
    }
  }
  return false;
}

export async function ensureOffscreen(): Promise<void> {
  if (await offscreenAlreadyExists()) return;
  if (createInFlight) {
    await createInFlight;
    return;
  }
  createInFlight = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: OFFSCREEN_REASONS as unknown as chrome.offscreen.Reason[],
        justification: OFFSCREEN_JUSTIFICATION,
      });
      documentReady = true;
    } finally {
      createInFlight = null;
    }
  })();
  await createInFlight;
}

export async function closeOffscreen(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument();
  } finally {
    documentReady = false;
    createInFlight = null;
  }
}

/**
 * Force-recreate the offscreen document (ADR-R4). `ensureOffscreen` trusts the
 * sticky `documentReady` and so can no-op against a document that crashed; this
 * path resets that flag unconditionally then builds a fresh document.
 *
 * `closeOffscreen()` already resets `documentReady` and `createInFlight` in its
 * `finally`, so the reset happens even when `closeDocument()` rejects (a
 * crashed or absent document can make it reject). The rejection is swallowed
 * here on purpose. We do NOT consult `hasDocument()` to decide whether to
 * recreate: a crashed document may still report as present, so we always reset
 * then create.
 */
export async function recreateOffscreen(): Promise<void> {
  try {
    await closeOffscreen();
  } catch {
    // A crashed or absent document can make closeDocument() reject. The
    // closeOffscreen finally still reset the sticky state, so proceed.
  }
  await ensureOffscreen();
}

/**
 * Register a `chrome.runtime.onMessage` listener that fields
 * `ENSURE_OFFSCREEN_REQUEST` and `RECREATE_OFFSCREEN_REQUEST` messages from
 * content scripts. Call this once from `background.ts` at top level. Idempotent
 * across SW restarts — Chrome dedupes addListener calls keyed by the function
 * reference.
 *
 * Returns `true` only for owned messages (to keep the reply channel open for
 * the async response) and `false` otherwise, preserving the MV3
 * channel-race discipline so a sibling listener can still answer.
 */
export function installEnsureListener(): void {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (isEnsureOffscreenRequest(msg)) {
      ensureOffscreen().then(
        () => {
          const ok: EnsureOffscreenResponse = { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
          sendResponse(ok);
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          const fail: EnsureOffscreenResponse = {
            type: ENSURE_OFFSCREEN_RESPONSE,
            ok: false,
            error: message,
          };
          sendResponse(fail);
        },
      );
      return true; // keep the channel open for the async reply
    }
    if (isRecreateOffscreenRequest(msg)) {
      recreateOffscreen().then(
        () => {
          const ok: RecreateOffscreenResponse = { type: RECREATE_OFFSCREEN_RESPONSE, ok: true };
          sendResponse(ok);
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          const fail: RecreateOffscreenResponse = {
            type: RECREATE_OFFSCREEN_RESPONSE,
            ok: false,
            error: message,
          };
          sendResponse(fail);
        },
      );
      return true; // keep the channel open for the async reply
    }
    return false;
  });
}

/**
 * SW-side `streamPrompt`. Uses `ensureOffscreen` directly (cheaper than a
 * round-trip sendMessage to itself, which doesn't fire its own
 * onMessage anyway). Suitable for the SW devtools smoke test.
 */
export function streamPrompt(prompt: string, opts: StreamPromptOptions = {}): Promise<string> {
  return streamOverPort(prompt, opts, ensureOffscreen);
}

export function sendPrompt(prompt: string): Promise<string> {
  return streamPrompt(prompt);
}

/** Reset module-scoped state. Tests only. */
export function _resetForTests(): void {
  documentReady = false;
  createInFlight = null;
}
