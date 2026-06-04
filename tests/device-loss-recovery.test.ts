import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetForTests, installEnsureListener } from '../src/background/offscreen.js';
import { installGpuCapture, _resetForTests as resetCapture } from '../src/offscreen/gpu-capture.js';
import {
  ENSURE_OFFSCREEN_REQUEST,
  IS_BUSY_REQUEST,
  IS_BUSY_RESPONSE,
  SESSION_POISONED_REQUEST,
  type SessionPoisonedRequest,
} from '../src/offscreen/protocol.js';
import { chromeMock, type FakeGpuDevice, gpuMock } from './setup.js';

/**
 * End-to-end wiring for Layer A: install the gpu capture against the
 * navigator.gpu mock, fire device.lost, route the resulting SESSION_POISONED
 * push into the SW listener, then send an ENSURE_OFFSCREEN_REQUEST and assert
 * the SW recreated the offscreen document. This is the single place where the
 * capture seam, the push, the SW listener, and the recreate meet without
 * loading the real offscreen.ts entry.
 */
describe('device-loss recovery (end-to-end wiring)', () => {
  type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

  function captureListener(): Listener {
    const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
    return calls[calls.length - 1]?.[0] as Listener;
  }

  /** Drive a message into the SW listener and await its async reply. */
  async function dispatch(listener: Listener, msg: unknown): Promise<unknown> {
    const sendResponse = vi.fn();
    listener(msg, { id: chromeMock.runtime.id }, sendResponse);
    await flushUntil(() => sendResponse.mock.calls.length > 0);
    return sendResponse.mock.calls[0]?.[0];
  }

  /**
   * Drain micro- and macro-tasks until `predicate()` holds, then return. Throws
   * if the predicate never becomes true within a generous tick budget. This
   * expresses the intent ("wait until X happened") rather than guessing a fixed
   * number of `await Promise.resolve()` iterations, which is brittle against any
   * change in async-chain depth or microtask-vs-task scheduling.
   */
  async function flushUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
    for (let tick = 0; tick < maxTicks; tick++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!predicate()) {
      throw new Error('flushUntil: predicate never became true within the tick budget');
    }
  }

  beforeEach(() => {
    _resetForTests();
    resetCapture();
  });

  it('captures the device transparently, then recreates the offscreen on the next ensure', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    installEnsureListener();
    const listener = captureListener();

    // Route messages: a SESSION_POISONED push goes INTO the SW listener (what
    // the offscreen handleDeviceLost would do over chrome.runtime.sendMessage);
    // an IS_BUSY probe is answered directly with not-busy.
    chromeMock.runtime.sendMessage.mockImplementation(async (raw: unknown) => {
      const m = raw as { type?: string };
      if (m?.type === IS_BUSY_REQUEST) {
        return { type: IS_BUSY_RESPONSE, ok: true, busy: false };
      }
      if (m?.type === SESSION_POISONED_REQUEST) {
        await dispatch(listener, raw);
        return undefined;
      }
      return undefined;
    });

    // Install the capture with the same shape offscreen.ts uses: onDeviceLost
    // pushes SESSION_POISONED over chrome.runtime.sendMessage.
    installGpuCapture({
      onDeviceLost: (info) => {
        const push: SessionPoisonedRequest = {
          type: SESSION_POISONED_REQUEST,
          at: info.at,
          reason: info.reason,
          message: info.message,
        };
        void chrome.runtime.sendMessage(push);
      },
    });

    // Build the document once.
    await dispatch(listener, { type: ENSURE_OFFSCREEN_REQUEST });
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);

    // Drive the chrome-side capture path and assert transparency.
    const adapter = await gpuMock.requestAdapter();
    expect(adapter).toBe(gpuMock._lastAdapter());
    const device = (await adapter?.requestDevice()) as FakeGpuDevice;
    expect(device).toBe(gpuMock._lastDevice());

    // Fire device.lost; the listener pushes SESSION_POISONED into the SW.
    device._fireLost('destroyed', 'GPU device was lost');
    // Drain until the SESSION_POISONED push has actually been sent (its receipt
    // sets the SW's sticky poisoned flag synchronously), rather than guessing a
    // fixed microtask count.
    await flushUntil(() =>
      chromeMock.runtime.sendMessage.mock.calls.some(
        (call) => (call[0] as { type?: string } | undefined)?.type === SESSION_POISONED_REQUEST,
      ),
    );

    // The next ensure recreates the document (close + create) on a healthy
    // session.
    await dispatch(listener, { type: ENSURE_OFFSCREEN_REQUEST });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(2);

    // The flag was cleared: a second ensure does not recreate again.
    const closesBefore = chromeMock.offscreen.closeDocument.mock.calls.length;
    await dispatch(listener, { type: ENSURE_OFFSCREEN_REQUEST });
    expect(chromeMock.offscreen.closeDocument.mock.calls.length).toBe(closesBefore);
  });
});
