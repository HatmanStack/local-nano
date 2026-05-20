import { beforeEach, describe, expect, it } from 'vitest';
import { rebuildSession, sendPrompt, streamPrompt } from '../src/offscreen/client.js';
import {
  ENSURE_OFFSCREEN_REQUEST,
  ENSURE_OFFSCREEN_RESPONSE,
  REBUILD_SESSION_REQUEST,
  REBUILD_SESSION_RESPONSE,
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
