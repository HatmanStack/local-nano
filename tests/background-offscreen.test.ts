import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetForTests,
  closeOffscreen,
  ensureOffscreen,
  installEnsureListener,
  recreateOffscreen,
} from '../src/background/offscreen.js';
import {
  ENSURE_OFFSCREEN_REQUEST,
  ENSURE_OFFSCREEN_RESPONSE,
  RECREATE_OFFSCREEN_REQUEST,
  RECREATE_OFFSCREEN_RESPONSE,
} from '../src/offscreen/protocol.js';
import { chromeMock } from './setup.js';

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
    const result = listener({ type: 'something-else' }, {}, sendResponse);
    expect(result).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('replies with ok:true after ensureOffscreen resolves', async () => {
    chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
    installEnsureListener();
    const listener = captureListener();
    const sendResponse = vi.fn();
    const kept = listener({ type: ENSURE_OFFSCREEN_REQUEST }, {}, sendResponse);
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
    listener({ type: ENSURE_OFFSCREEN_REQUEST }, {}, sendResponse);
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
    const kept = listener({ type: RECREATE_OFFSCREEN_REQUEST }, {}, sendResponse);
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
    listener({ type: RECREATE_OFFSCREEN_REQUEST }, {}, sendResponse);
    for (let i = 0; i < 10 && sendResponse.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const reply = sendResponse.mock.calls[0]?.[0] as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('recreate blocked');
  });
});
