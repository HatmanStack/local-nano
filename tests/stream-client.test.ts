import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STREAM_CHUNK,
  STREAM_DONE,
  STREAM_PORT_NAME,
  STREAM_REQUEST,
  type StreamChunk,
  type StreamDone,
  type StreamRequest,
} from '../src/offscreen/protocol.js';
import { streamOverPort } from '../src/offscreen/stream-client.js';
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
  const sent = port.sent[0] as StreamRequest;
  if (!sent) throw new Error('helper did not post a request');
  return sent;
}

describe('streamOverPort', () => {
  beforeEach(() => {
    chromeMock.runtime.lastError = undefined;
  });

  it('awaits the ensure function before connecting', async () => {
    const order: string[] = [];
    const ensure = vi.fn(async () => {
      order.push('ensure');
    });
    const p = streamOverPort('hi', {}, ensure);
    // After a tick the helper should have hit `await ensure()`.
    await new Promise((r) => setTimeout(r, 0));
    order.push('post-tick');
    const port = await awaitPort();
    const req = await waitForPostedRequest(port);
    port._emit({ type: STREAM_DONE, id: req.id, ok: true } as StreamDone);
    await p;
    expect(order).toEqual(['ensure', 'post-tick']);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('connects with STREAM_PORT_NAME and posts a well-formed StreamRequest', async () => {
    const ensure = vi.fn(async () => {});
    const p = streamOverPort('hello', {}, ensure);
    const port = await awaitPort();
    expect(chromeMock.runtime.connect).toHaveBeenCalledWith({ name: STREAM_PORT_NAME });
    const req = await waitForPostedRequest(port);
    expect(req.type).toBe(STREAM_REQUEST);
    expect(req.prompt).toBe('hello');
    expect(typeof req.id).toBe('string');
    expect(req.id.length).toBeGreaterThan(0);
    port._emit({ type: STREAM_DONE, id: req.id, ok: true } as StreamDone);
    await p;
  });

  it('accumulates chunk values into the resolved string and fires onChunk', async () => {
    const chunks: string[] = [];
    const ensure = vi.fn(async () => {});
    const p = streamOverPort('go', { onChunk: (c) => chunks.push(c) }, ensure);
    const port = await awaitPort();
    const req = await waitForPostedRequest(port);
    port._emit({ type: STREAM_CHUNK, id: req.id, value: 'one ' } as StreamChunk);
    port._emit({ type: STREAM_CHUNK, id: req.id, value: 'two ' } as StreamChunk);
    port._emit({ type: STREAM_CHUNK, id: req.id, value: 'three' } as StreamChunk);
    port._emit({ type: STREAM_DONE, id: req.id, ok: true } as StreamDone);
    await expect(p).resolves.toBe('one two three');
    expect(chunks).toEqual(['one ', 'two ', 'three']);
    expect(port.disconnect).toHaveBeenCalled();
  });

  it('ignores chunks with a mismatched id', async () => {
    const chunks: string[] = [];
    const p = streamOverPort('hi', { onChunk: (c) => chunks.push(c) }, async () => {});
    const port = await awaitPort();
    const req = await waitForPostedRequest(port);
    port._emit({ type: STREAM_CHUNK, id: 'other', value: 'leak' } as StreamChunk);
    port._emit({ type: STREAM_CHUNK, id: req.id, value: 'ok' } as StreamChunk);
    port._emit({ type: STREAM_DONE, id: req.id, ok: true } as StreamDone);
    await expect(p).resolves.toBe('ok');
    expect(chunks).toEqual(['ok']);
  });

  it('rejects when stream/done arrives with ok:false', async () => {
    const p = streamOverPort('boom', {}, async () => {});
    const port = await awaitPort();
    const req = await waitForPostedRequest(port);
    port._emit({ type: STREAM_DONE, id: req.id, ok: false, error: 'model unavailable' });
    await expect(p).rejects.toThrow('model unavailable');
  });

  it('rejects when the port disconnects without a done frame', async () => {
    chromeMock.runtime.lastError = { message: 'crashed' };
    const p = streamOverPort('hi', {}, async () => {});
    const port = await awaitPort();
    await waitForPostedRequest(port);
    port._emitDisconnect();
    await expect(p).rejects.toThrow(/crashed/);
    chromeMock.runtime.lastError = undefined;
  });

  it('rejects with AbortError and sends a stream/abort frame when signal fires', async () => {
    const controller = new AbortController();
    const p = streamOverPort('hi', { signal: controller.signal }, async () => {});
    const port = await awaitPort();
    const req = await waitForPostedRequest(port);
    controller.abort();
    await expect(p).rejects.toThrow(/Aborted/);
    const abortFrame = port.sent[1] as { type: string; id: string } | undefined;
    expect(abortFrame?.type).toBe('stream/abort');
    expect(abortFrame?.id).toBe(req.id);
    expect(port.disconnect).toHaveBeenCalled();
  });

  it('rejects immediately when signal is already aborted before calling', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamOverPort('hi', { signal: controller.signal }, async () => {}),
    ).rejects.toThrow(/Aborted/);
  });

  it('propagates errors thrown by ensure without connecting', async () => {
    const ensure = vi.fn(async () => {
      throw new Error('ensure failed');
    });
    await expect(streamOverPort('hi', {}, ensure)).rejects.toThrow('ensure failed');
    expect(chromeMock.runtime.connect).not.toHaveBeenCalled();
  });
});
