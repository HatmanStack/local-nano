import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countTokens,
  getGpuInfo,
  rebuildSession,
  recreateOffscreen,
  sendPrompt,
  streamPrompt,
  warmupSession,
} from '../src/offscreen/client.js';
import {
  COUNT_TOKENS_REQUEST,
  COUNT_TOKENS_RESPONSE,
  ENSURE_OFFSCREEN_REQUEST,
  ENSURE_OFFSCREEN_RESPONSE,
  GPU_INFO_REQUEST,
  GPU_INFO_RESPONSE,
  REBUILD_SESSION_REQUEST,
  REBUILD_SESSION_RESPONSE,
  RECREATE_OFFSCREEN_REQUEST,
  RECREATE_OFFSCREEN_RESPONSE,
  STREAM_CHUNK,
  STREAM_DONE,
  type StreamChunk,
  type StreamDone,
  type StreamRequest,
} from '../src/offscreen/protocol.js';
import { chromeMock, type FakePort } from './setup.js';

async function awaitPort(): Promise<FakePort> {
  for (let i = 0; i < 40 && chromeMock.runtime.connect.mock.results.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  const last = chromeMock.runtime.connect.mock.results.at(-1);
  if (!last || last.type !== 'return') throw new Error('no port created');
  return last.value as FakePort;
}

async function waitForPostedRequest(port: FakePort): Promise<StreamRequest> {
  for (let i = 0; i < 40 && port.sent.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  return port.sent[0] as StreamRequest;
}

describe('streamPrompt (content-script client)', () => {
  beforeEach(() => {
    chromeMock.runtime.lastError = undefined;
  });

  it('sends ENSURE_OFFSCREEN_REQUEST to the SW before connecting', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      expect(msg).toEqual({ type: ENSURE_OFFSCREEN_REQUEST });
      return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
    });
    const p = streamPrompt('hello');
    const port = await awaitPort();
    const req = await waitForPostedRequest(port);
    port._emit({ type: STREAM_DONE, id: req.id, ok: true } as StreamDone);
    await p;
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('returns the accumulated text from the stream', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: ENSURE_OFFSCREEN_RESPONSE,
      ok: true,
    }));
    const p = streamPrompt('hello');
    const port = await awaitPort();
    const req = await waitForPostedRequest(port);
    port._emit({ type: STREAM_CHUNK, id: req.id, value: 'hi ' } as StreamChunk);
    port._emit({ type: STREAM_CHUNK, id: req.id, value: 'world' } as StreamChunk);
    port._emit({ type: STREAM_DONE, id: req.id, ok: true } as StreamDone);
    await expect(p).resolves.toBe('hi world');
  });

  it('rejects when the SW replies ok:false to the ensure request', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: ENSURE_OFFSCREEN_RESPONSE,
      ok: false,
      error: 'offscreen blocked',
    }));
    await expect(streamPrompt('hi')).rejects.toThrow('offscreen blocked');
    expect(chromeMock.runtime.connect).not.toHaveBeenCalled();
  });

  it('rejects when chrome.runtime.lastError is set on the ensure call', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => {
      chromeMock.runtime.lastError = { message: 'no SW' };
      return undefined;
    });
    await expect(streamPrompt('hi')).rejects.toThrow(/no SW/);
    chromeMock.runtime.lastError = undefined;
  });

  it('rejects when the SW reply is malformed', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: 'something-else',
      ok: true,
    }));
    await expect(streamPrompt('hi')).rejects.toThrow(/malformed/);
  });

  it('rejects with the busy error when the offscreen gate rejects a concurrent stream', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: ENSURE_OFFSCREEN_RESPONSE,
      ok: true,
    }));
    const p = streamPrompt('hello');
    const port = await awaitPort();
    const req = await waitForPostedRequest(port);
    // The offscreen busy gate replies ok:false with the busy error and
    // never starts a second generation.
    port._emit({
      type: STREAM_DONE,
      id: req.id,
      ok: false,
      error: 'busy: another generation is in progress',
    } as StreamDone);
    await expect(p).rejects.toThrow('busy: another generation is in progress');
  });
});

describe('sendPrompt (non-streaming wrapper)', () => {
  beforeEach(() => {
    chromeMock.runtime.lastError = undefined;
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: ENSURE_OFFSCREEN_RESPONSE,
      ok: true,
    }));
  });

  it('accumulates chunks and returns the full text', async () => {
    const p = sendPrompt('hello');
    const port = await awaitPort();
    const req = await waitForPostedRequest(port);
    port._emit({ type: STREAM_CHUNK, id: req.id, value: 'one' } as StreamChunk);
    port._emit({ type: STREAM_CHUNK, id: req.id, value: ' two' } as StreamChunk);
    port._emit({ type: STREAM_DONE, id: req.id, ok: true } as StreamDone);
    await expect(p).resolves.toBe('one two');
  });

  it('surfaces stream errors as rejected promises', async () => {
    const p = sendPrompt('boom');
    const port = await awaitPort();
    const req = await waitForPostedRequest(port);
    port._emit({ type: STREAM_DONE, id: req.id, ok: false, error: 'oops' } as StreamDone);
    await expect(p).rejects.toThrow('oops');
  });
});

describe('rebuildSession (content-script client)', () => {
  beforeEach(() => {
    chromeMock.runtime.lastError = undefined;
  });

  it('ensures offscreen then sends REBUILD_SESSION_REQUEST with the provided history', async () => {
    const history = [
      { role: 'user' as const, text: 'hi' },
      { role: 'model' as const, text: 'hello' },
    ];
    const calls: unknown[] = [];
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      calls.push(msg);
      const type = (msg as { type?: string })?.type;
      if (type === ENSURE_OFFSCREEN_REQUEST) {
        return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
      }
      if (type === REBUILD_SESSION_REQUEST) {
        return { type: REBUILD_SESSION_RESPONSE, ok: true };
      }
      return undefined;
    });

    await expect(rebuildSession(history)).resolves.toBeUndefined();
    expect(calls).toEqual([
      { type: ENSURE_OFFSCREEN_REQUEST },
      { type: REBUILD_SESSION_REQUEST, history },
    ]);
  });

  it('rejects when the offscreen reply is ok:false', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      const type = (msg as { type?: string })?.type;
      if (type === ENSURE_OFFSCREEN_REQUEST) {
        return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
      }
      return { type: REBUILD_SESSION_RESPONSE, ok: false, error: 'gpu unavailable' };
    });
    await expect(rebuildSession([])).rejects.toThrow('gpu unavailable');
  });

  it('rejects when the offscreen reply is malformed', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      const type = (msg as { type?: string })?.type;
      if (type === ENSURE_OFFSCREEN_REQUEST) {
        return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
      }
      return { type: 'something-else', ok: true };
    });
    await expect(rebuildSession([])).rejects.toThrow(/malformed/);
  });
});

describe('recreateOffscreen (content-script client)', () => {
  beforeEach(() => {
    chromeMock.runtime.lastError = undefined;
  });

  it('sends RECREATE_OFFSCREEN_REQUEST and resolves on ok:true', async () => {
    const calls: unknown[] = [];
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      calls.push(msg);
      return { type: RECREATE_OFFSCREEN_RESPONSE, ok: true };
    });
    await expect(recreateOffscreen()).resolves.toBeUndefined();
    expect(calls).toEqual([{ type: RECREATE_OFFSCREEN_REQUEST }]);
  });

  it('throws the SW error message on ok:false', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: RECREATE_OFFSCREEN_RESPONSE,
      ok: false,
      error: 'recreate blocked',
    }));
    await expect(recreateOffscreen()).rejects.toThrow('recreate blocked');
  });

  it('throws when chrome.runtime.lastError is set', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => {
      chromeMock.runtime.lastError = { message: 'no SW' };
      return undefined;
    });
    await expect(recreateOffscreen()).rejects.toThrow(/no SW/);
    chromeMock.runtime.lastError = undefined;
  });

  it('throws when the reply is malformed', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: 'something-else',
      ok: true,
    }));
    await expect(recreateOffscreen()).rejects.toThrow(/malformed/);
  });
});

describe('countTokens (content-script client)', () => {
  beforeEach(() => {
    chromeMock.runtime.lastError = undefined;
  });

  it('sends ENSURE_OFFSCREEN_REQUEST then COUNT_TOKENS_REQUEST and returns the polyfill count', async () => {
    const calls: unknown[] = [];
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      calls.push(msg);
      const type = (msg as { type?: string })?.type;
      if (type === ENSURE_OFFSCREEN_REQUEST) {
        return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
      }
      if (type === COUNT_TOKENS_REQUEST) {
        return { type: COUNT_TOKENS_RESPONSE, ok: true, count: 17 };
      }
      return undefined;
    });

    await expect(countTokens('the quick brown fox')).resolves.toBe(17);
    expect(calls).toEqual([
      { type: ENSURE_OFFSCREEN_REQUEST },
      { type: COUNT_TOKENS_REQUEST, text: 'the quick brown fox' },
    ]);
  });

  it('falls back to the heuristic when the reply is ok:false', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      const type = (msg as { type?: string })?.type;
      if (type === ENSURE_OFFSCREEN_REQUEST) {
        return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
      }
      return { type: COUNT_TOKENS_RESPONSE, ok: false, error: 'gpu busy' };
    });

    // 'abcdefghi' is 9 chars → ceil(9 / 3) = 3.
    await expect(countTokens('abcdefghi')).resolves.toBe(3);
  });

  it('falls back to the heuristic when chrome.runtime.lastError is set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
        const type = (msg as { type?: string })?.type;
        if (type === ENSURE_OFFSCREEN_REQUEST) {
          return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
        }
        chromeMock.runtime.lastError = { message: 'sw asleep' };
        return undefined;
      });

      // 'hello world' is 11 chars → ceil(11 / 3) = 4.
      await expect(countTokens('hello world')).resolves.toBe(4);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      chromeMock.runtime.lastError = undefined;
    }
  });

  it('falls back to the heuristic when the reply is malformed', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      const type = (msg as { type?: string })?.type;
      if (type === ENSURE_OFFSCREEN_REQUEST) {
        return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
      }
      return { type: 'something-else', ok: true };
    });

    // 'foo' is 3 chars → ceil(3 / 3) = 1.
    await expect(countTokens('foo')).resolves.toBe(1);
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('falls back to the heuristic when the send takes longer than timeoutMs', async () => {
      // ensure resolves immediately, count never resolves.
      let resolveEnsure: (v: unknown) => void = () => undefined;
      chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
        const type = (msg as { type?: string })?.type;
        if (type === ENSURE_OFFSCREEN_REQUEST) {
          return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
        }
        // count-tokens — never resolves.
        return new Promise(() => {
          // Hold the resolver in a closure to avoid an unused-var lint.
          resolveEnsure = () => undefined;
        });
      });

      const p = countTokens('abcdef'); // 6 chars → ceil(6/3)=2
      await vi.advanceTimersByTimeAsync(101);
      await expect(p).resolves.toBe(2);
      // Reference the unused resolver to satisfy lint without changing semantics.
      void resolveEnsure;
    });

    it('uses the polyfill count when it arrives before timeoutMs', async () => {
      chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
        const type = (msg as { type?: string })?.type;
        if (type === ENSURE_OFFSCREEN_REQUEST) {
          return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
        }
        return { type: COUNT_TOKENS_RESPONSE, ok: true, count: 99 };
      });
      const p = countTokens('hi');
      await vi.advanceTimersByTimeAsync(50);
      await expect(p).resolves.toBe(99);
    });
  });

  it('heuristic value is Math.ceil(text.length / 3)', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => {
      // Always malformed → forces heuristic.
      return { type: 'noop' };
    });
    await expect(countTokens('a')).resolves.toBe(1); // ceil(1/3)=1
    await expect(countTokens('ab')).resolves.toBe(1); // ceil(2/3)=1
    await expect(countTokens('abc')).resolves.toBe(1); // ceil(3/3)=1
    await expect(countTokens('abcd')).resolves.toBe(2); // ceil(4/3)=2
    await expect(countTokens('abcdefg')).resolves.toBe(3); // ceil(7/3)=3
    await expect(countTokens('')).resolves.toBe(0); // ceil(0/3)=0
  });
});

describe('warmupSession (content-script client)', () => {
  beforeEach(() => {
    chromeMock.runtime.lastError = undefined;
  });

  it('ensures offscreen then sends an empty count-tokens request to force ensureSession', async () => {
    const seen: unknown[] = [];
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      seen.push(msg);
      const type = (msg as { type?: string })?.type;
      if (type === ENSURE_OFFSCREEN_REQUEST) {
        return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
      }
      if (type === COUNT_TOKENS_REQUEST) {
        return { type: COUNT_TOKENS_RESPONSE, ok: true, count: 0 };
      }
      return undefined;
    });

    await expect(warmupSession()).resolves.toBeUndefined();
    expect(seen).toEqual([
      { type: ENSURE_OFFSCREEN_REQUEST },
      { type: COUNT_TOKENS_REQUEST, text: '' },
    ]);
  });

  it('rejects when the count-tokens reply is ok:false', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      const type = (msg as { type?: string })?.type;
      if (type === ENSURE_OFFSCREEN_REQUEST) {
        return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
      }
      return { type: COUNT_TOKENS_RESPONSE, ok: false, error: 'model failed to load' };
    });
    await expect(warmupSession()).rejects.toThrow('model failed to load');
  });

  it('rejects when the offscreen reply is malformed', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      const type = (msg as { type?: string })?.type;
      if (type === ENSURE_OFFSCREEN_REQUEST) {
        return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
      }
      return { type: 'something-else' };
    });
    await expect(warmupSession()).rejects.toThrow(/malformed/);
  });

  it('rejects when chrome.runtime.lastError is set on the count call', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      const type = (msg as { type?: string })?.type;
      if (type === ENSURE_OFFSCREEN_REQUEST) {
        return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
      }
      chromeMock.runtime.lastError = { message: 'port closed' };
      return undefined;
    });
    await expect(warmupSession()).rejects.toThrow(/port closed/);
    chromeMock.runtime.lastError = undefined;
  });

  it('rejects when the ensure step fails', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({
      type: ENSURE_OFFSCREEN_RESPONSE,
      ok: false,
      error: 'offscreen blocked',
    }));
    await expect(warmupSession()).rejects.toThrow('offscreen blocked');
  });
});

describe('getGpuInfo (content-script client)', () => {
  beforeEach(() => {
    chromeMock.runtime.lastError = undefined;
  });

  it('ensures offscreen then returns the GPU snapshot', async () => {
    const seen: unknown[] = [];
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
      seen.push(msg);
      const type = (msg as { type?: string })?.type;
      if (type === ENSURE_OFFSCREEN_REQUEST) {
        return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
      }
      if (type === GPU_INFO_REQUEST) {
        return {
          type: GPU_INFO_RESPONSE,
          ok: true,
          device: 'webgpu',
          isFallback: false,
          maxBufferSize: 2147483648,
          configuredThreshold: null,
        };
      }
      return undefined;
    });
    await expect(getGpuInfo()).resolves.toEqual({
      device: 'webgpu',
      isFallback: false,
      maxBufferSize: 2147483648,
      configuredThreshold: null,
    });
    expect(seen[0]).toEqual({ type: ENSURE_OFFSCREEN_REQUEST });
    expect(seen[1]).toEqual({ type: GPU_INFO_REQUEST });
  });

  // The contract is "never reject — resolve a conservative shape on any
  // failure". The conservative shape maps to the default history
  // threshold downstream, the same outcome a try/catch around a
  // rejecting version would have produced.
  const CONSERVATIVE = {
    device: 'webgpu',
    isFallback: false,
    maxBufferSize: null,
    configuredThreshold: null,
  };

  it('resolves the conservative shape when the offscreen reply is ok:false', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
        const type = (msg as { type?: string })?.type;
        if (type === ENSURE_OFFSCREEN_REQUEST) {
          return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
        }
        return { type: GPU_INFO_RESPONSE, ok: false, error: 'gpu unavailable' };
      });
      await expect(getGpuInfo()).resolves.toEqual(CONSERVATIVE);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resolves the conservative shape when the reply is malformed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
        const type = (msg as { type?: string })?.type;
        if (type === ENSURE_OFFSCREEN_REQUEST) {
          return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
        }
        return { type: 'something-else' };
      });
      await expect(getGpuInfo()).resolves.toEqual(CONSERVATIVE);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resolves the conservative shape when chrome.runtime.lastError is set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      chromeMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
        const type = (msg as { type?: string })?.type;
        if (type === ENSURE_OFFSCREEN_REQUEST) {
          return { type: ENSURE_OFFSCREEN_RESPONSE, ok: true };
        }
        chromeMock.runtime.lastError = { message: 'port closed' };
        return undefined;
      });
      await expect(getGpuInfo()).resolves.toEqual(CONSERVATIVE);
    } finally {
      warnSpy.mockRestore();
      chromeMock.runtime.lastError = undefined;
    }
  });
});
