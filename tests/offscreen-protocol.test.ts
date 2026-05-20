import { describe, expect, it } from 'vitest';
import {
  ENSURE_OFFSCREEN_REQUEST,
  ENSURE_OFFSCREEN_RESPONSE,
  isEnsureOffscreenRequest,
  isEnsureOffscreenResponse,
  isRebuildSessionRequest,
  isRebuildSessionResponse,
  isStreamAbort,
  isStreamChunk,
  isStreamDone,
  isStreamRequest,
  REBUILD_SESSION_REQUEST,
  REBUILD_SESSION_RESPONSE,
  STREAM_ABORT,
  STREAM_CHUNK,
  STREAM_DONE,
  STREAM_PORT_NAME,
  STREAM_REQUEST,
} from '../src/offscreen/protocol.js';

describe('protocol discriminators', () => {
  it('keeps ensure-offscreen constants stable', () => {
    expect(ENSURE_OFFSCREEN_REQUEST).toBe('offscreen/ensure-request');
    expect(ENSURE_OFFSCREEN_RESPONSE).toBe('offscreen/ensure-response');
  });

  it('keeps stream protocol constants stable', () => {
    expect(STREAM_PORT_NAME).toBe('offscreen-stream');
    expect(STREAM_REQUEST).toBe('stream/request');
    expect(STREAM_CHUNK).toBe('stream/chunk');
    expect(STREAM_DONE).toBe('stream/done');
    expect(STREAM_ABORT).toBe('stream/abort');
  });

  it('keeps rebuild-session constants stable', () => {
    expect(REBUILD_SESSION_REQUEST).toBe('offscreen/rebuild-session-request');
    expect(REBUILD_SESSION_RESPONSE).toBe('offscreen/rebuild-session-response');
  });
});

describe('isRebuildSessionRequest', () => {
  it('accepts a request with empty history', () => {
    expect(isRebuildSessionRequest({ type: REBUILD_SESSION_REQUEST, history: [] })).toBe(true);
  });

  it('accepts user and model turns', () => {
    expect(
      isRebuildSessionRequest({
        type: REBUILD_SESSION_REQUEST,
        history: [
          { role: 'user', text: 'hi' },
          { role: 'model', text: 'hello' },
        ],
      }),
    ).toBe(true);
  });

  it('rejects unknown roles (e.g. system)', () => {
    expect(
      isRebuildSessionRequest({
        type: REBUILD_SESSION_REQUEST,
        history: [{ role: 'system', text: 'hi' }],
      }),
    ).toBe(false);
  });

  it('rejects when history is missing or not an array', () => {
    expect(isRebuildSessionRequest({ type: REBUILD_SESSION_REQUEST })).toBe(false);
    expect(isRebuildSessionRequest({ type: REBUILD_SESSION_REQUEST, history: 'nope' })).toBe(false);
  });

  it('rejects when a turn is malformed', () => {
    expect(
      isRebuildSessionRequest({
        type: REBUILD_SESSION_REQUEST,
        history: [{ role: 'user' }],
      }),
    ).toBe(false);
    expect(
      isRebuildSessionRequest({
        type: REBUILD_SESSION_REQUEST,
        history: [{ role: 'user', text: 42 }],
      }),
    ).toBe(false);
  });

  it('rejects messages of the wrong type', () => {
    expect(isRebuildSessionRequest({ type: 'something-else', history: [] })).toBe(false);
    expect(isRebuildSessionRequest(null)).toBe(false);
  });
});

describe('isRebuildSessionResponse', () => {
  it('accepts ok:true and ok:false with error', () => {
    expect(isRebuildSessionResponse({ type: REBUILD_SESSION_RESPONSE, ok: true })).toBe(true);
    expect(
      isRebuildSessionResponse({ type: REBUILD_SESSION_RESPONSE, ok: false, error: 'boom' }),
    ).toBe(true);
  });

  it('rejects ok:false without error string', () => {
    expect(isRebuildSessionResponse({ type: REBUILD_SESSION_RESPONSE, ok: false })).toBe(false);
    expect(
      isRebuildSessionResponse({ type: REBUILD_SESSION_RESPONSE, ok: false, error: 42 }),
    ).toBe(false);
  });

  it('rejects wrong type', () => {
    expect(isRebuildSessionResponse({ type: 'other', ok: true })).toBe(false);
  });
});

describe('isEnsureOffscreenRequest', () => {
  it('accepts a well-formed request', () => {
    expect(isEnsureOffscreenRequest({ type: ENSURE_OFFSCREEN_REQUEST })).toBe(true);
  });

  it('rejects null and primitives', () => {
    expect(isEnsureOffscreenRequest(null)).toBe(false);
    expect(isEnsureOffscreenRequest(undefined)).toBe(false);
    expect(isEnsureOffscreenRequest('foo')).toBe(false);
  });

  it('rejects wrong discriminator', () => {
    expect(isEnsureOffscreenRequest({ type: 'other' })).toBe(false);
  });
});

describe('isEnsureOffscreenResponse', () => {
  it('accepts ok:true', () => {
    expect(isEnsureOffscreenResponse({ type: ENSURE_OFFSCREEN_RESPONSE, ok: true })).toBe(true);
  });

  it('accepts ok:false with error string', () => {
    expect(
      isEnsureOffscreenResponse({
        type: ENSURE_OFFSCREEN_RESPONSE,
        ok: false,
        error: 'boom',
      }),
    ).toBe(true);
  });

  it('rejects ok:false without error', () => {
    expect(isEnsureOffscreenResponse({ type: ENSURE_OFFSCREEN_RESPONSE, ok: false })).toBe(false);
  });

  it('rejects wrong discriminator and primitives', () => {
    expect(isEnsureOffscreenResponse(null)).toBe(false);
    expect(isEnsureOffscreenResponse({ type: 'other', ok: true })).toBe(false);
  });
});

describe('isStreamRequest', () => {
  it('accepts a well-formed request', () => {
    expect(isStreamRequest({ type: STREAM_REQUEST, id: 'a', prompt: 'p' })).toBe(true);
  });

  it('rejects wrong shape', () => {
    expect(isStreamRequest(null)).toBe(false);
    expect(isStreamRequest({ type: STREAM_REQUEST, id: 'a' })).toBe(false);
    expect(isStreamRequest({ type: 'other', id: 'a', prompt: 'p' })).toBe(false);
    expect(isStreamRequest({ type: STREAM_REQUEST, id: 1, prompt: 'p' })).toBe(false);
  });
});

describe('isStreamAbort', () => {
  it('accepts a well-formed abort', () => {
    expect(isStreamAbort({ type: STREAM_ABORT, id: 'a' })).toBe(true);
  });

  it('rejects wrong shape', () => {
    expect(isStreamAbort(null)).toBe(false);
    expect(isStreamAbort({ type: STREAM_ABORT })).toBe(false);
    expect(isStreamAbort({ type: 'other', id: 'a' })).toBe(false);
  });
});

describe('isStreamChunk', () => {
  it('accepts a well-formed chunk', () => {
    expect(isStreamChunk({ type: STREAM_CHUNK, id: 'a', value: 'tok' })).toBe(true);
  });

  it('rejects wrong shape', () => {
    expect(isStreamChunk(null)).toBe(false);
    expect(isStreamChunk({ type: STREAM_CHUNK, id: 'a' })).toBe(false);
    expect(isStreamChunk({ type: STREAM_CHUNK, id: 'a', value: 42 })).toBe(false);
  });
});

describe('isStreamDone', () => {
  it('accepts ok:true', () => {
    expect(isStreamDone({ type: STREAM_DONE, id: 'a', ok: true })).toBe(true);
  });

  it('accepts ok:false with error string', () => {
    expect(isStreamDone({ type: STREAM_DONE, id: 'a', ok: false, error: 'boom' })).toBe(true);
  });

  it('rejects ok:false without error', () => {
    expect(isStreamDone({ type: STREAM_DONE, id: 'a', ok: false })).toBe(false);
  });

  it('rejects wrong shape', () => {
    expect(isStreamDone(null)).toBe(false);
    expect(isStreamDone({ type: 'other', id: 'a', ok: true })).toBe(false);
    expect(isStreamDone({ type: STREAM_DONE, id: 1, ok: true })).toBe(false);
  });
});
