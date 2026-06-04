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
  alarmWhen,
  decideIdleAction,
  IDLE_ALARM_NAME,
  shouldScheduleOnTouch,
} from '../offscreen/idle-policy.js';
import { loadModelPref } from '../offscreen/model-pref.js';
import {
  ENSURE_OFFSCREEN_RESPONSE,
  type EnsureOffscreenResponse,
  IS_BUSY_REQUEST,
  type IsBusyRequest,
  isEnsureOffscreenRequest,
  isIsBusyResponse,
  isRecreateOffscreenRequest,
  isSessionPoisonedRequest,
  isTouchIdleRequest,
  RECREATE_OFFSCREEN_RESPONSE,
  type RecreateOffscreenResponse,
  SESSION_POISONED_RESPONSE,
  type SessionPoisonedResponse,
  TOUCH_IDLE_RESPONSE,
  type TouchIdleResponse,
} from '../offscreen/protocol.js';
import { type StreamPromptOptions, streamOverPort } from '../offscreen/stream-client.js';

const OFFSCREEN_URL = 'dist/offscreen.html';
const OFFSCREEN_REASONS = ['WORKERS'] as const;
const OFFSCREEN_JUSTIFICATION = 'Hosts shared LanguageModel session backed by ONNX/WebGPU.';

let createInFlight: Promise<void> | null = null;
let documentReady = false;

/**
 * Sticky poisoned-session flag (Layer A, ADR-1). Set true when the offscreen
 * document pushes `SESSION_POISONED` after a GPUDevice `lost` event. The next
 * `ENSURE_OFFSCREEN_REQUEST` consults it: when set and the offscreen is not
 * busy, the SW recreates the document on a healthy session and clears the flag.
 * Module-scoped and NOT persisted: a fresh SW after eviction has no live
 * offscreen anyway (it was reaped with the SW), so the next ensure builds a
 * clean document and there is nothing to recover.
 */
let sessionPoisoned = false;

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
 * Idle-release scheduler (ADR-P8). Reads the configured idle timeout from the
 * model preference and (re)schedules the single named idle alarm to
 * `now + timeout`. Creating an alarm with the same name REPLACES the existing
 * one, which is the reset-on-each-generation behavior (the idle window measures
 * from the last generation). When the user chose "Never" (null timeout) this
 * clears any prior alarm so a stale alarm cannot fire after the opt-out.
 *
 * The shortest offered option (5 min) sits comfortably above the
 * `chrome.alarms` ~1 min minimum (ADR-P11).
 */
export async function scheduleIdleAlarm(): Promise<void> {
  const pref = await loadModelPref();
  const timeout = pref.idleTimeoutMinutes;
  if (!shouldScheduleOnTouch(timeout)) {
    // "Never": cancel any prior alarm so a release cannot fire after opt-out.
    await chrome.alarms.clear(IDLE_ALARM_NAME);
    return;
  }
  // timeout is non-null here (shouldScheduleOnTouch returned true).
  chrome.alarms.create(IDLE_ALARM_NAME, {
    when: alarmWhen(Date.now(), timeout as number),
  });
}

/**
 * Probe the offscreen document for its busy state over the `IS_BUSY_REQUEST`
 * round-trip (ADR-P9). Returns `reply.busy` when the document answers; defaults
 * to `false` on a malformed/absent reply or a `chrome.runtime.lastError`, so a
 * gone document is treated as idle-and-closable safely (closing an
 * already-gone document is a harmless no-op via `closeOffscreen`).
 */
export async function queryOffscreenBusy(): Promise<boolean> {
  try {
    const request: IsBusyRequest = { type: IS_BUSY_REQUEST };
    const reply = (await chrome.runtime.sendMessage(request)) as unknown;
    if (chrome.runtime.lastError) return false;
    if (!isIsBusyResponse(reply) || !reply.ok) return false;
    return reply.busy;
  } catch {
    // No offscreen document listening (gone) — treat as idle.
    return false;
  }
}

/**
 * Ensure the offscreen document for a panel-open request, recreating it first
 * when the session is poisoned (Layer A, ADR-1, ADR-P7).
 *
 * When `sessionPoisoned` is set, probe the offscreen `IS_BUSY` state via the
 * existing `queryOffscreenBusy` round-trip. If a generation is in flight
 * (`busy === true`) the recreate is DEFERRED: the flag stays set and a plain
 * `ensureOffscreen` runs so the panel is not blocked, and the next ensure tries
 * again once the generation finishes. NEVER tear down a live stream. When not
 * busy, `recreateOffscreen` (which itself ensures a fresh document) runs and the
 * flag is cleared BEFORE returning. The clear happens only on a completed
 * recreate so a recreate failure leaves the session poisoned for a retry.
 */
async function ensurePossiblyRecreate(): Promise<void> {
  if (sessionPoisoned) {
    const busy = await queryOffscreenBusy();
    if (!busy) {
      await recreateOffscreen();
      sessionPoisoned = false;
      return;
    }
    // Busy: defer the recreate; just ensure the document is up for the panel.
  }
  await ensureOffscreen();
}

/**
 * Idle-alarm listener body (ADR-P8, P9). Ignores any alarm that is not the idle
 * alarm. On the idle alarm: read the current timeout, probe the offscreen busy
 * state, then act per the pure `decideIdleAction`:
 *
 * - `close`: `closeOffscreen()` (resets the sticky `documentReady`). The next
 *   generation re-arms the window via touch-idle, so we do NOT reschedule here.
 * - `reschedule`: re-create the alarm for another full window (a generation is
 *   in flight, do not drop it).
 * - `noop`: the user switched to "Never"; clear the alarm.
 */
export async function handleAlarm(alarm: { name: string }): Promise<void> {
  if (alarm.name !== IDLE_ALARM_NAME) return;
  const pref = await loadModelPref();
  const timeoutMinutes = pref.idleTimeoutMinutes;
  const busy = await queryOffscreenBusy();
  const action = decideIdleAction({ busy, timeoutMinutes });
  if (action.kind === 'close') {
    await closeOffscreen();
    return;
  }
  if (action.kind === 'reschedule') {
    chrome.alarms.create(IDLE_ALARM_NAME, {
      when: alarmWhen(Date.now(), action.delayMinutes),
    });
    return;
  }
  // noop: release disabled ("Never"); clear any lingering alarm.
  await chrome.alarms.clear(IDLE_ALARM_NAME);
}

/**
 * Register a `chrome.runtime.onMessage` listener that fields
 * `ENSURE_OFFSCREEN_REQUEST`, `RECREATE_OFFSCREEN_REQUEST`,
 * `SESSION_POISONED_REQUEST`, and `TOUCH_IDLE_REQUEST` messages. The ensure
 * branch recreates the document first when the session is poisoned and idle
 * (ADR-1). Call this once from `background.ts` at top level. Idempotent across
 * SW restarts — Chrome dedupes addListener calls keyed by the function
 * reference.
 *
 * Returns `true` only for owned messages (to keep the reply channel open for
 * the async response) and `false` otherwise, preserving the MV3
 * channel-race discipline so a sibling listener can still answer.
 */
export function installEnsureListener(): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Defense in depth: only field messages from THIS extension. Chrome already
    // bars cross-extension messaging when `externally_connectable` is unset,
    // but the explicit check makes the trust boundary visible to a reviewer.
    if (sender.id !== chrome.runtime.id) return false;
    if (isEnsureOffscreenRequest(msg)) {
      ensurePossiblyRecreate().then(
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
    if (isSessionPoisonedRequest(msg)) {
      // Push from the offscreen on device.lost (ADR-1). Flip the sticky flag
      // and ack. The offscreen does not await this reply; the ack exists for
      // protocol uniformity and test observability. The actual recreate is
      // deferred to the next ensure (when the offscreen is not busy).
      sessionPoisoned = true;
      const ok: SessionPoisonedResponse = { type: SESSION_POISONED_RESPONSE, ok: true };
      sendResponse(ok);
      return true; // keep the channel open for the (synchronous) reply
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
    if (isTouchIdleRequest(msg)) {
      // Reset the single idle alarm to now + the configured timeout (ADR-P8).
      // Reading the timeout from storage here keeps a freshly-woken SW correct.
      scheduleIdleAlarm().then(
        () => {
          const ok: TouchIdleResponse = { type: TOUCH_IDLE_RESPONSE, ok: true };
          sendResponse(ok);
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          const fail: TouchIdleResponse = { type: TOUCH_IDLE_RESPONSE, ok: false, error: message };
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
  sessionPoisoned = false;
}
