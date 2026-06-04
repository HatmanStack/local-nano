import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetForTests,
  closeOffscreen,
  ensureOffscreen,
  handleAlarm,
  installEnsureListener,
  recreateOffscreen,
  scheduleIdleAlarm,
} from '../src/background/offscreen.js';
import { IDLE_ALARM_NAME } from '../src/offscreen/idle-policy.js';
import { MODEL_PREF_KEY, type ModelPref } from '../src/offscreen/model-pref.js';
import {
  ENSURE_OFFSCREEN_REQUEST,
  ENSURE_OFFSCREEN_RESPONSE,
  IS_BUSY_RESPONSE,
  RECREATE_OFFSCREEN_REQUEST,
  RECREATE_OFFSCREEN_RESPONSE,
  SESSION_POISONED_REQUEST,
  SESSION_POISONED_RESPONSE,
  TOUCH_IDLE_REQUEST,
  TOUCH_IDLE_RESPONSE,
} from '../src/offscreen/protocol.js';
import { chromeMock } from './setup.js';

/** Seed the model preference so the scheduler/handler read a known timeout. */
function seedIdleTimeout(minutes: number | null): void {
  const pref: ModelPref = { modelId: null, idleTimeoutMinutes: minutes };
  chromeMock.storage.local.store[MODEL_PREF_KEY] = pref;
}

describe('ensureOffscreen', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('calls createDocument once when no offscreen exists', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    await ensureOffscreen();
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
    const arg = chromeMock.offscreen.createDocument.mock.calls[0]?.[0] as {
      url: string;
      reasons: string[];
      justification: string;
    };
    expect(arg.url).toBe('dist/offscreen.html');
    expect(arg.reasons).toContain('WORKERS');
    expect(typeof arg.justification).toBe('string');
  });

  it('no-ops when hasDocument returns true', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => true);
    await ensureOffscreen();
    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('dedupes concurrent calls', async () => {
    let resolveCreate!: () => void;
    chromeMock.offscreen.createDocument.mockImplementation(
      () =>
        new Promise<undefined>((r) => {
          resolveCreate = () => r(undefined);
        }),
    );
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    const a = ensureOffscreen();
    const b = ensureOffscreen();
    const c = ensureOffscreen();
    await new Promise((r) => setTimeout(r, 0));
    resolveCreate();
    await Promise.all([a, b, c]);
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('skips createDocument on a subsequent call after a successful create', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    await ensureOffscreen();
    await ensureOffscreen();
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });
});

describe('closeOffscreen', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('calls closeDocument and lets the next ensureOffscreen create again', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    await ensureOffscreen();
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
    await closeOffscreen();
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    await ensureOffscreen();
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(2);
  });

  it('resets state even when closeDocument throws', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    await ensureOffscreen();
    chromeMock.offscreen.closeDocument.mockImplementation(async () => {
      throw new Error('not allowed');
    });
    await expect(closeOffscreen()).rejects.toThrow('not allowed');
    chromeMock.offscreen.closeDocument.mockImplementation(async () => undefined);
    await ensureOffscreen();
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(2);
  });
});

describe('recreateOffscreen', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('closes then recreates the document and the next ensureOffscreen no-ops', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    await ensureOffscreen();
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
    await recreateOffscreen();
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(2);
    // The document is ready again, so a follow-up ensure does not re-create.
    await ensureOffscreen();
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(2);
  });

  it('still calls createDocument when closeDocument rejects', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    chromeMock.offscreen.closeDocument.mockImplementation(async () => {
      throw new Error('no document to close');
    });
    await recreateOffscreen();
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });
});

describe('installEnsureListener', () => {
  type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

  beforeEach(() => {
    _resetForTests();
  });

  function captureListener(): Listener {
    const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
    return calls[calls.length - 1]?.[0] as Listener;
  }

  it('registers a chrome.runtime.onMessage listener', () => {
    installEnsureListener();
    expect(chromeMock.runtime.onMessage.addListener).toHaveBeenCalled();
  });

  it('ignores messages that are not ENSURE_OFFSCREEN_REQUEST', () => {
    installEnsureListener();
    const listener = captureListener();
    const sendResponse = vi.fn();
    const result = listener({ type: 'something-else' }, { id: 'test-ext' }, sendResponse);
    expect(result).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('rejects messages from foreign senders (sender.id mismatch)', () => {
    installEnsureListener();
    const listener = captureListener();
    const sendResponse = vi.fn();
    const result = listener({ type: ENSURE_OFFSCREEN_REQUEST }, { id: 'other-ext' }, sendResponse);
    expect(result).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('replies with ok:true after ensureOffscreen resolves', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    installEnsureListener();
    const listener = captureListener();
    const sendResponse = vi.fn();
    const kept = listener({ type: ENSURE_OFFSCREEN_REQUEST }, { id: 'test-ext' }, sendResponse);
    expect(kept).toBe(true); // channel kept open for the async reply
    for (let i = 0; i < 10 && sendResponse.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(sendResponse).toHaveBeenCalledWith({
      type: ENSURE_OFFSCREEN_RESPONSE,
      ok: true,
    });
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('replies with ok:false carrying the error message when ensureOffscreen rejects', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    chromeMock.offscreen.createDocument.mockImplementation(async () => {
      throw new Error('blocked');
    });
    installEnsureListener();
    const listener = captureListener();
    const sendResponse = vi.fn();
    listener({ type: ENSURE_OFFSCREEN_REQUEST }, { id: 'test-ext' }, sendResponse);
    for (let i = 0; i < 10 && sendResponse.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const reply = sendResponse.mock.calls[0]?.[0] as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('blocked');
  });

  it('replies ok:true after a RECREATE_OFFSCREEN_REQUEST resolves', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    installEnsureListener();
    const listener = captureListener();
    const sendResponse = vi.fn();
    const kept = listener({ type: RECREATE_OFFSCREEN_REQUEST }, { id: 'test-ext' }, sendResponse);
    expect(kept).toBe(true);
    for (let i = 0; i < 10 && sendResponse.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(sendResponse).toHaveBeenCalledWith({ type: RECREATE_OFFSCREEN_RESPONSE, ok: true });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('replies ok:false with the error when recreate createDocument rejects', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    chromeMock.offscreen.createDocument.mockImplementation(async () => {
      throw new Error('recreate blocked');
    });
    installEnsureListener();
    const listener = captureListener();
    const sendResponse = vi.fn();
    listener({ type: RECREATE_OFFSCREEN_REQUEST }, { id: 'test-ext' }, sendResponse);
    for (let i = 0; i < 10 && sendResponse.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const reply = sendResponse.mock.calls[0]?.[0] as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('recreate blocked');
  });

  it('schedules the idle alarm and replies ok:true to a TOUCH_IDLE_REQUEST', async () => {
    seedIdleTimeout(15);
    installEnsureListener();
    const listener = captureListener();
    const sendResponse = vi.fn();
    const kept = listener({ type: TOUCH_IDLE_REQUEST }, { id: 'test-ext' }, sendResponse);
    expect(kept).toBe(true);
    for (let i = 0; i < 10 && sendResponse.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(sendResponse).toHaveBeenCalledWith({ type: TOUCH_IDLE_RESPONSE, ok: true });
    expect(chromeMock.alarms.create).toHaveBeenCalledTimes(1);
    const [name] = chromeMock.alarms.create.mock.calls[0] as [string, { when: number }];
    expect(name).toBe(IDLE_ALARM_NAME);
  });

  /** Drive a message into the listener and await its async sendResponse reply. */
  async function dispatch(listener: Listener, msg: unknown): Promise<unknown> {
    const sendResponse = vi.fn();
    listener(msg, { id: 'test-ext' }, sendResponse);
    for (let i = 0; i < 20 && sendResponse.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    return sendResponse.mock.calls[0]?.[0];
  }

  /** Mock the IS_BUSY round-trip the ensure-poisoned path uses via sendMessage. */
  function mockBusy(busy: boolean): void {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: IS_BUSY_RESPONSE,
      ok: true,
      busy,
    }));
  }

  it('flips the poisoned flag and acks ok:true on SESSION_POISONED_REQUEST', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    installEnsureListener();
    const listener = captureListener();
    const reply = await dispatch(listener, {
      type: SESSION_POISONED_REQUEST,
      at: '2026-06-04T00:00:00.000Z',
      reason: 'destroyed',
      message: 'lost',
    });
    expect(reply).toEqual({ type: SESSION_POISONED_RESPONSE, ok: true });
  });

  it('recreates the offscreen on the next ensure when poisoned and not busy', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    installEnsureListener();
    const listener = captureListener();
    // Build the document once so a later recreate has something to close.
    await dispatch(listener, { type: ENSURE_OFFSCREEN_REQUEST });
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
    // Poison the session.
    await dispatch(listener, {
      type: SESSION_POISONED_REQUEST,
      at: 'a',
      reason: 'destroyed',
      message: 'lost',
    });
    // Next ensure with IS_BUSY -> busy:false recreates (close + create).
    mockBusy(false);
    const reply = await dispatch(listener, { type: ENSURE_OFFSCREEN_REQUEST });
    expect(reply).toEqual({ type: ENSURE_OFFSCREEN_RESPONSE, ok: true });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(2);
    // The flag is cleared: a further ensure does NOT recreate again.
    const before = chromeMock.offscreen.closeDocument.mock.calls.length;
    await dispatch(listener, { type: ENSURE_OFFSCREEN_REQUEST });
    expect(chromeMock.offscreen.closeDocument.mock.calls.length).toBe(before);
  });

  it('defers the recreate while busy, then recreates on the next ensure', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    installEnsureListener();
    const listener = captureListener();
    await dispatch(listener, { type: ENSURE_OFFSCREEN_REQUEST });
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
    await dispatch(listener, {
      type: SESSION_POISONED_REQUEST,
      at: 'a',
      reason: 'destroyed',
      message: 'lost',
    });
    // Busy ensure: do NOT recreate, flag stays set.
    mockBusy(true);
    await dispatch(listener, { type: ENSURE_OFFSCREEN_REQUEST });
    expect(chromeMock.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
    // Next ensure, now idle: recreate fires.
    mockBusy(false);
    await dispatch(listener, { type: ENSURE_OFFSCREEN_REQUEST });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(2);
  });

  it('does not recreate on ensure when there was no prior poison', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    installEnsureListener();
    const listener = captureListener();
    await dispatch(listener, { type: ENSURE_OFFSCREEN_REQUEST });
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
    // A second ensure with no poison must not close/recreate.
    await dispatch(listener, { type: ENSURE_OFFSCREEN_REQUEST });
    expect(chromeMock.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });
});

describe('scheduleIdleAlarm', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('creates the single named alarm at now + timeout for a 15-min preference', async () => {
    seedIdleTimeout(15);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await scheduleIdleAlarm();
      expect(chromeMock.alarms.create).toHaveBeenCalledTimes(1);
      expect(chromeMock.alarms.create).toHaveBeenCalledWith(IDLE_ALARM_NAME, {
        when: 1_000 + 900_000,
      });
      expect(chromeMock.alarms.clear).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses now + 300000 for a 5-min preference (clears the alarms ~1 min minimum)', async () => {
    seedIdleTimeout(5);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      await scheduleIdleAlarm();
      expect(chromeMock.alarms.create).toHaveBeenCalledWith(IDLE_ALARM_NAME, { when: 300_000 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('clears the alarm and does not create when the preference is "Never" (null)', async () => {
    seedIdleTimeout(null);
    await scheduleIdleAlarm();
    expect(chromeMock.alarms.clear).toHaveBeenCalledWith(IDLE_ALARM_NAME);
    expect(chromeMock.alarms.create).not.toHaveBeenCalled();
  });

  it('keeps replacing the single named alarm on repeated calls (reset semantics)', async () => {
    seedIdleTimeout(60);
    await scheduleIdleAlarm();
    await scheduleIdleAlarm();
    await scheduleIdleAlarm();
    expect(chromeMock.alarms.create).toHaveBeenCalledTimes(3);
    for (const call of chromeMock.alarms.create.mock.calls) {
      expect(call[0]).toBe(IDLE_ALARM_NAME);
    }
  });
});

describe('handleAlarm (verify-idle close)', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('ignores an alarm whose name is not the idle alarm', async () => {
    seedIdleTimeout(15);
    await handleAlarm({ name: 'some-other-alarm' });
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalled();
    expect(chromeMock.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(chromeMock.alarms.create).not.toHaveBeenCalled();
  });

  it('closes the document exactly once when the busy probe reports idle', async () => {
    seedIdleTimeout(15);
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: IS_BUSY_RESPONSE,
      ok: true,
      busy: false,
    }));
    await handleAlarm({ name: IDLE_ALARM_NAME });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(chromeMock.alarms.create).not.toHaveBeenCalled();
  });

  it('reschedules and does NOT close when the busy probe reports busy', async () => {
    seedIdleTimeout(15);
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: IS_BUSY_RESPONSE,
      ok: true,
      busy: true,
    }));
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(5_000);
    try {
      await handleAlarm({ name: IDLE_ALARM_NAME });
      expect(chromeMock.offscreen.closeDocument).not.toHaveBeenCalled();
      expect(chromeMock.alarms.create).toHaveBeenCalledWith(IDLE_ALARM_NAME, {
        when: 5_000 + 900_000,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('treats a malformed/absent busy reply as not-busy (safe to close)', async () => {
    seedIdleTimeout(15);
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({ type: 'something-else' }));
    await handleAlarm({ name: IDLE_ALARM_NAME });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('treats a thrown busy probe (gone document) as not-busy (safe to close)', async () => {
    seedIdleTimeout(15);
    chromeMock.runtime.sendMessage.mockImplementation(async () => {
      throw new Error('receiving end does not exist');
    });
    await handleAlarm({ name: IDLE_ALARM_NAME });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('clears the alarm and does not close when the timeout is now "Never"', async () => {
    seedIdleTimeout(null);
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: IS_BUSY_RESPONSE,
      ok: true,
      busy: false,
    }));
    await handleAlarm({ name: IDLE_ALARM_NAME });
    expect(chromeMock.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(chromeMock.alarms.clear).toHaveBeenCalledWith(IDLE_ALARM_NAME);
  });
});
