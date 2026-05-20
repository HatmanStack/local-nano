import { describe, expect, it } from 'vitest';
import {
  COUNT_TOKENS_REQUEST,
  COUNT_TOKENS_RESPONSE,
  ENSURE_OFFSCREEN_REQUEST,
  ENSURE_OFFSCREEN_RESPONSE,
  isCountTokensRequest,
  isCountTokensResponse,
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

  it('keeps count-tokens constants stable', () => {
    expect(COUNT_TOKENS_REQUEST).toBe('offscreen/count-tokens-request');
    expect(COUNT_TOKENS_RESPONSE).toBe('offscreen/count-tokens-response');
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
    expect(isRebuildSessionResponse({ type: REBUILD_SESSION_RESPONSE, ok: false, error: 42 })).toBe(
      false,
    );
  });

  it('rejects wrong type', () => {
    expect(isRebuildSessionResponse({ type: 'other', ok: true })).toBe(false);
  });
});

describe('isCountTokensRequest', () => {
  it('accepts a well-formed request', () => {
    expect(isCountTokensRequest({ type: COUNT_TOKENS_REQUEST, text: 'hello' })).toBe(true);
    expect(isCountTokensRequest({ type: COUNT_TOKENS_REQUEST, text: '' })).toBe(true);
  });

  it('rejects null and primitives', () => {
    expect(isCountTokensRequest(null)).toBe(false);
    expect(isCountTokensRequest(undefined)).toBe(false);
    expect(isCountTokensRequest('foo')).toBe(false);
  });

  it('rejects wrong discriminator', () => {
    expect(isCountTokensRequest({ type: 'other', text: 'hi' })).toBe(false);
  });

  it('rejects missing or non-string text', () => {
    expect(isCountTokensRequest({ type: COUNT_TOKENS_REQUEST })).toBe(false);
    expect(isCountTokensRequest({ type: COUNT_TOKENS_REQUEST, text: 42 })).toBe(false);
    expect(isCountTokensRequest({ type: COUNT_TOKENS_REQUEST, text: null })).toBe(false);
  });
});

describe('isCountTokensResponse', () => {
  it('accepts ok:true with finite count', () => {
    expect(isCountTokensResponse({ type: COUNT_TOKENS_RESPONSE, ok: true, count: 0 })).toBe(true);
    expect(isCountTokensResponse({ type: COUNT_TOKENS_RESPONSE, ok: true, count: 42 })).toBe(true);
  });

  it('accepts ok:false with error string', () => {
    expect(isCountTokensResponse({ type: COUNT_TOKENS_RESPONSE, ok: false, error: 'boom' })).toBe(
      true,
    );
  });

  it('rejects ok:true with non-numeric count', () => {
    expect(isCountTokensResponse({ type: COUNT_TOKENS_RESPONSE, ok: true })).toBe(false);
    expect(isCountTokensResponse({ type: COUNT_TOKENS_RESPONSE, ok: true, count: '5' })).toBe(
      false,
    );
  });

  it('rejects ok:true with non-finite count', () => {
    expect(
      isCountTokensResponse({ type: COUNT_TOKENS_RESPONSE, ok: true, count: Number.NaN }),
    ).toBe(false);
    expect(
      isCountTokensResponse({
        type: COUNT_TOKENS_RESPONSE,
        ok: true,
        count: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
    expect(
      isCountTokensResponse({
        type: COUNT_TOKENS_RESPONSE,
        ok: true,
        count: Number.NEGATIVE_INFINITY,
      }),
    ).toBe(false);
  });

  it('rejects ok:false without error string', () => {
    expect(isCountTokensResponse({ type: COUNT_TOKENS_RESPONSE, ok: false })).toBe(false);
    expect(isCountTokensResponse({ type: COUNT_TOKENS_RESPONSE, ok: false, error: 42 })).toBe(
      false,
    );
  });

  it('rejects null and wrong discriminator', () => {
    expect(isCountTokensResponse(null)).toBe(false);
    expect(isCountTokensResponse({ type: 'other', ok: true, count: 1 })).toBe(false);
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
