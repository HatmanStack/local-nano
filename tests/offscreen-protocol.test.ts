import { describe, expect, it } from 'vitest';
import {
  COUNT_TOKENS_REQUEST,
  COUNT_TOKENS_RESPONSE,
  ENSURE_OFFSCREEN_REQUEST,
  ENSURE_OFFSCREEN_RESPONSE,
  GPU_INFO_REQUEST,
  GPU_INFO_RESPONSE,
  IS_BUSY_REQUEST,
  IS_BUSY_RESPONSE,
  isCountTokensRequest,
  isCountTokensResponse,
  isEnsureOffscreenRequest,
  isEnsureOffscreenResponse,
  isGpuInfoRequest,
  isGpuInfoResponse,
  isIsBusyRequest,
  isIsBusyResponse,
  isProgressFrame,
  isRebuildSessionRequest,
  isRebuildSessionResponse,
  isRecreateOffscreenRequest,
  isRecreateOffscreenResponse,
  isSessionPoisonedRequest,
  isSessionPoisonedResponse,
  isStreamAbort,
  isStreamChunk,
  isStreamDone,
  isStreamRequest,
  isTouchIdleRequest,
  isTouchIdleResponse,
  isWarmupRequest,
  isWarmupResponse,
  REBUILD_SESSION_REQUEST,
  REBUILD_SESSION_RESPONSE,
  RECREATE_OFFSCREEN_REQUEST,
  RECREATE_OFFSCREEN_RESPONSE,
  SESSION_POISONED_REQUEST,
  SESSION_POISONED_RESPONSE,
  STREAM_ABORT,
  STREAM_CHUNK,
  STREAM_DONE,
  STREAM_PORT_NAME,
  STREAM_PROGRESS,
  STREAM_PROGRESS_PORT,
  STREAM_REQUEST,
  TOUCH_IDLE_REQUEST,
  TOUCH_IDLE_RESPONSE,
  WARMUP_REQUEST,
  WARMUP_RESPONSE,
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

  it('keeps progress-port constants stable', () => {
    expect(STREAM_PROGRESS_PORT).toBe('offscreen-progress');
    expect(STREAM_PROGRESS).toBe('stream/progress');
  });

  it('keeps rebuild-session constants stable', () => {
    expect(REBUILD_SESSION_REQUEST).toBe('offscreen/rebuild-session-request');
    expect(REBUILD_SESSION_RESPONSE).toBe('offscreen/rebuild-session-response');
  });

  it('keeps count-tokens constants stable', () => {
    expect(COUNT_TOKENS_REQUEST).toBe('offscreen/count-tokens-request');
    expect(COUNT_TOKENS_RESPONSE).toBe('offscreen/count-tokens-response');
  });

  it('keeps gpu-info constants stable', () => {
    expect(GPU_INFO_REQUEST).toBe('offscreen/gpu-info-request');
    expect(GPU_INFO_RESPONSE).toBe('offscreen/gpu-info-response');
  });

  it('keeps recreate-offscreen constants stable', () => {
    expect(RECREATE_OFFSCREEN_REQUEST).toBe('offscreen/recreate-request');
    expect(RECREATE_OFFSCREEN_RESPONSE).toBe('offscreen/recreate-response');
  });

  it('keeps warmup constants stable', () => {
    expect(WARMUP_REQUEST).toBe('offscreen/warmup-request');
    expect(WARMUP_RESPONSE).toBe('offscreen/warmup-response');
  });

  it('keeps touch-idle constants stable', () => {
    expect(TOUCH_IDLE_REQUEST).toBe('idle/touch-request');
    expect(TOUCH_IDLE_RESPONSE).toBe('idle/touch-response');
  });

  it('keeps is-busy constants stable', () => {
    expect(IS_BUSY_REQUEST).toBe('idle/is-busy-request');
    expect(IS_BUSY_RESPONSE).toBe('idle/is-busy-response');
  });

  it('keeps session-poisoned constants stable', () => {
    expect(SESSION_POISONED_REQUEST).toBe('offscreen/session-poisoned-request');
    expect(SESSION_POISONED_RESPONSE).toBe('offscreen/session-poisoned-response');
  });
});

describe('isSessionPoisonedRequest', () => {
  it('accepts a well-formed request', () => {
    expect(
      isSessionPoisonedRequest({
        type: SESSION_POISONED_REQUEST,
        at: '2026-06-04T00:00:00.000Z',
        reason: 'destroyed',
        message: 'GPU device was lost',
      }),
    ).toBe(true);
  });

  it('rejects a request missing at, reason, or message', () => {
    expect(
      isSessionPoisonedRequest({ type: SESSION_POISONED_REQUEST, reason: 'r', message: 'm' }),
    ).toBe(false);
    expect(
      isSessionPoisonedRequest({ type: SESSION_POISONED_REQUEST, at: 'a', message: 'm' }),
    ).toBe(false);
    expect(isSessionPoisonedRequest({ type: SESSION_POISONED_REQUEST, at: 'a', reason: 'r' })).toBe(
      false,
    );
  });

  it('rejects non-string at, reason, or message', () => {
    expect(
      isSessionPoisonedRequest({
        type: SESSION_POISONED_REQUEST,
        at: 1,
        reason: 'r',
        message: 'm',
      }),
    ).toBe(false);
    expect(
      isSessionPoisonedRequest({
        type: SESSION_POISONED_REQUEST,
        at: 'a',
        reason: 2,
        message: 'm',
      }),
    ).toBe(false);
    expect(
      isSessionPoisonedRequest({
        type: SESSION_POISONED_REQUEST,
        at: 'a',
        reason: 'r',
        message: 3,
      }),
    ).toBe(false);
  });

  it('rejects wrong discriminator and primitives', () => {
    expect(isSessionPoisonedRequest(null)).toBe(false);
    expect(isSessionPoisonedRequest('foo')).toBe(false);
    expect(isSessionPoisonedRequest({ type: 'other', at: 'a', reason: 'r', message: 'm' })).toBe(
      false,
    );
  });
});

describe('isSessionPoisonedResponse', () => {
  it('accepts ok:true and ok:false with error string', () => {
    expect(isSessionPoisonedResponse({ type: SESSION_POISONED_RESPONSE, ok: true })).toBe(true);
    expect(
      isSessionPoisonedResponse({ type: SESSION_POISONED_RESPONSE, ok: false, error: 'boom' }),
    ).toBe(true);
  });

  it('rejects ok:false without an error string', () => {
    expect(isSessionPoisonedResponse({ type: SESSION_POISONED_RESPONSE, ok: false })).toBe(false);
    expect(
      isSessionPoisonedResponse({ type: SESSION_POISONED_RESPONSE, ok: false, error: 42 }),
    ).toBe(false);
  });

  it('rejects wrong discriminator and primitives', () => {
    expect(isSessionPoisonedResponse(null)).toBe(false);
    expect(isSessionPoisonedResponse({ type: 'other', ok: true })).toBe(false);
  });
});

describe('isTouchIdleRequest', () => {
  it('accepts a well-formed request (no payload)', () => {
    expect(isTouchIdleRequest({ type: TOUCH_IDLE_REQUEST })).toBe(true);
  });

  it('rejects null, primitives, and the wrong discriminator', () => {
    expect(isTouchIdleRequest(null)).toBe(false);
    expect(isTouchIdleRequest(undefined)).toBe(false);
    expect(isTouchIdleRequest('foo')).toBe(false);
    expect(isTouchIdleRequest({ type: 'other' })).toBe(false);
  });
});

describe('isTouchIdleResponse', () => {
  it('accepts ok:true and ok:false with error string', () => {
    expect(isTouchIdleResponse({ type: TOUCH_IDLE_RESPONSE, ok: true })).toBe(true);
    expect(isTouchIdleResponse({ type: TOUCH_IDLE_RESPONSE, ok: false, error: 'boom' })).toBe(true);
  });

  it('rejects ok:false without an error string', () => {
    expect(isTouchIdleResponse({ type: TOUCH_IDLE_RESPONSE, ok: false })).toBe(false);
    expect(isTouchIdleResponse({ type: TOUCH_IDLE_RESPONSE, ok: false, error: 42 })).toBe(false);
  });

  it('rejects wrong discriminator and primitives', () => {
    expect(isTouchIdleResponse(null)).toBe(false);
    expect(isTouchIdleResponse({ type: 'other', ok: true })).toBe(false);
  });
});

describe('isIsBusyRequest', () => {
  it('accepts a well-formed request (no payload)', () => {
    expect(isIsBusyRequest({ type: IS_BUSY_REQUEST })).toBe(true);
  });

  it('rejects null, primitives, and the wrong discriminator', () => {
    expect(isIsBusyRequest(null)).toBe(false);
    expect(isIsBusyRequest(undefined)).toBe(false);
    expect(isIsBusyRequest('foo')).toBe(false);
    expect(isIsBusyRequest({ type: 'other' })).toBe(false);
  });
});

describe('isIsBusyResponse', () => {
  it('accepts ok:true with a boolean busy', () => {
    expect(isIsBusyResponse({ type: IS_BUSY_RESPONSE, ok: true, busy: true })).toBe(true);
    expect(isIsBusyResponse({ type: IS_BUSY_RESPONSE, ok: true, busy: false })).toBe(true);
  });

  it('rejects ok:true with a missing or non-boolean busy', () => {
    expect(isIsBusyResponse({ type: IS_BUSY_RESPONSE, ok: true })).toBe(false);
    expect(isIsBusyResponse({ type: IS_BUSY_RESPONSE, ok: true, busy: 'yes' })).toBe(false);
    expect(isIsBusyResponse({ type: IS_BUSY_RESPONSE, ok: true, busy: 1 })).toBe(false);
  });

  it('accepts ok:false with an error string', () => {
    expect(isIsBusyResponse({ type: IS_BUSY_RESPONSE, ok: false, error: 'boom' })).toBe(true);
  });

  it('rejects ok:false without an error string', () => {
    expect(isIsBusyResponse({ type: IS_BUSY_RESPONSE, ok: false })).toBe(false);
    expect(isIsBusyResponse({ type: IS_BUSY_RESPONSE, ok: false, error: 42 })).toBe(false);
  });

  it('rejects wrong discriminator and primitives', () => {
    expect(isIsBusyResponse(null)).toBe(false);
    expect(isIsBusyResponse({ type: 'other', ok: true, busy: true })).toBe(false);
  });
});

describe('isWarmupRequest', () => {
  it('accepts a request with no tier (base-tier warmup)', () => {
    expect(isWarmupRequest({ type: WARMUP_REQUEST })).toBe(true);
  });

  it('accepts a request with a well-formed tier', () => {
    expect(
      isWarmupRequest({
        type: WARMUP_REQUEST,
        tier: { modelName: 'org/model', device: 'webgpu', dtype: 'q4f16' },
      }),
    ).toBe(true);
    expect(
      isWarmupRequest({
        type: WARMUP_REQUEST,
        tier: { modelName: 'org/model', device: 'wasm', dtype: 'q8' },
      }),
    ).toBe(true);
  });

  it('rejects a tier with a bad device enum', () => {
    expect(
      isWarmupRequest({
        type: WARMUP_REQUEST,
        tier: { modelName: 'org/model', device: 'metal', dtype: 'q4f16' },
      }),
    ).toBe(false);
  });

  it('rejects a tier missing modelName or with empty modelName', () => {
    expect(
      isWarmupRequest({
        type: WARMUP_REQUEST,
        tier: { device: 'webgpu', dtype: 'q4f16' },
      }),
    ).toBe(false);
    expect(
      isWarmupRequest({
        type: WARMUP_REQUEST,
        tier: { modelName: '', device: 'webgpu', dtype: 'q4f16' },
      }),
    ).toBe(false);
  });

  it('rejects a tier with a missing or empty dtype', () => {
    expect(
      isWarmupRequest({
        type: WARMUP_REQUEST,
        tier: { modelName: 'org/model', device: 'webgpu' },
      }),
    ).toBe(false);
    expect(
      isWarmupRequest({
        type: WARMUP_REQUEST,
        tier: { modelName: 'org/model', device: 'webgpu', dtype: '' },
      }),
    ).toBe(false);
  });

  it('rejects null, primitives, and the wrong discriminator', () => {
    expect(isWarmupRequest(null)).toBe(false);
    expect(isWarmupRequest('foo')).toBe(false);
    expect(isWarmupRequest({ type: 'other' })).toBe(false);
  });
});

describe('isWarmupResponse', () => {
  it('accepts ok:true', () => {
    expect(isWarmupResponse({ type: WARMUP_RESPONSE, ok: true })).toBe(true);
  });

  it('accepts ok:false with error string', () => {
    expect(isWarmupResponse({ type: WARMUP_RESPONSE, ok: false, error: 'boom' })).toBe(true);
  });

  it('rejects ok:false without error', () => {
    expect(isWarmupResponse({ type: WARMUP_RESPONSE, ok: false })).toBe(false);
  });

  it('rejects wrong discriminator and primitives', () => {
    expect(isWarmupResponse(null)).toBe(false);
    expect(isWarmupResponse({ type: 'other', ok: true })).toBe(false);
  });
});

describe('isProgressFrame', () => {
  it('accepts a well-formed frame', () => {
    expect(isProgressFrame({ type: STREAM_PROGRESS, loaded: 0.5, total: 1 })).toBe(true);
    expect(isProgressFrame({ type: STREAM_PROGRESS, loaded: 0, total: 0 })).toBe(true);
  });

  it('rejects non-finite loaded or total', () => {
    expect(isProgressFrame({ type: STREAM_PROGRESS, loaded: Number.NaN, total: 1 })).toBe(false);
    expect(
      isProgressFrame({ type: STREAM_PROGRESS, loaded: 0.5, total: Number.POSITIVE_INFINITY }),
    ).toBe(false);
  });

  it('rejects non-numeric loaded or total', () => {
    expect(isProgressFrame({ type: STREAM_PROGRESS, loaded: '0.5', total: 1 })).toBe(false);
    expect(isProgressFrame({ type: STREAM_PROGRESS, loaded: 0.5, total: '1' })).toBe(false);
  });

  it('rejects the wrong discriminator and primitives', () => {
    expect(isProgressFrame({ type: 'other', loaded: 0.5, total: 1 })).toBe(false);
    expect(isProgressFrame(null)).toBe(false);
    expect(isProgressFrame('foo')).toBe(false);
  });
});

describe('isRecreateOffscreenRequest', () => {
  it('accepts a well-formed request', () => {
    expect(isRecreateOffscreenRequest({ type: RECREATE_OFFSCREEN_REQUEST })).toBe(true);
  });

  it('rejects null and primitives', () => {
    expect(isRecreateOffscreenRequest(null)).toBe(false);
    expect(isRecreateOffscreenRequest(undefined)).toBe(false);
    expect(isRecreateOffscreenRequest('foo')).toBe(false);
  });

  it('rejects wrong discriminator', () => {
    expect(isRecreateOffscreenRequest({ type: 'other' })).toBe(false);
  });
});

describe('isRecreateOffscreenResponse', () => {
  it('accepts ok:true', () => {
    expect(isRecreateOffscreenResponse({ type: RECREATE_OFFSCREEN_RESPONSE, ok: true })).toBe(true);
  });

  it('accepts ok:false with error string', () => {
    expect(
      isRecreateOffscreenResponse({
        type: RECREATE_OFFSCREEN_RESPONSE,
        ok: false,
        error: 'boom',
      }),
    ).toBe(true);
  });

  it('rejects ok:false without error', () => {
    expect(isRecreateOffscreenResponse({ type: RECREATE_OFFSCREEN_RESPONSE, ok: false })).toBe(
      false,
    );
  });

  it('rejects wrong discriminator and primitives', () => {
    expect(isRecreateOffscreenResponse(null)).toBe(false);
    expect(isRecreateOffscreenResponse({ type: 'other', ok: true })).toBe(false);
  });
});

describe('isGpuInfoRequest', () => {
  it('accepts a well-formed request', () => {
    expect(isGpuInfoRequest({ type: GPU_INFO_REQUEST })).toBe(true);
  });
  it('rejects null and wrong discriminator', () => {
    expect(isGpuInfoRequest(null)).toBe(false);
    expect(isGpuInfoRequest({ type: 'other' })).toBe(false);
  });
});

describe('isGpuInfoResponse', () => {
  it('accepts a full ok:true snapshot', () => {
    expect(
      isGpuInfoResponse({
        type: GPU_INFO_RESPONSE,
        ok: true,
        device: 'webgpu',
        isFallback: false,
        maxBufferSize: 2147483648,
        configuredThreshold: 1500,
        lastDeviceLostAt: '2026-06-04T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('accepts null maxBufferSize and configuredThreshold', () => {
    expect(
      isGpuInfoResponse({
        type: GPU_INFO_RESPONSE,
        ok: true,
        device: 'wasm',
        isFallback: false,
        maxBufferSize: null,
        configuredThreshold: null,
        lastDeviceLostAt: null,
      }),
    ).toBe(true);
  });

  it('accepts a null lastDeviceLostAt', () => {
    expect(
      isGpuInfoResponse({
        type: GPU_INFO_RESPONSE,
        ok: true,
        device: 'webgpu',
        isFallback: false,
        maxBufferSize: null,
        configuredThreshold: null,
        lastDeviceLostAt: null,
      }),
    ).toBe(true);
  });

  it('accepts an absent lastDeviceLostAt for backward shape', () => {
    expect(
      isGpuInfoResponse({
        type: GPU_INFO_RESPONSE,
        ok: true,
        device: 'webgpu',
        isFallback: false,
        maxBufferSize: null,
        configuredThreshold: null,
      }),
    ).toBe(true);
  });

  it('rejects a non-string, non-null lastDeviceLostAt', () => {
    expect(
      isGpuInfoResponse({
        type: GPU_INFO_RESPONSE,
        ok: true,
        device: 'webgpu',
        isFallback: false,
        maxBufferSize: null,
        configuredThreshold: null,
        lastDeviceLostAt: 1717459200000,
      }),
    ).toBe(false);
  });

  it('rejects unknown device strings', () => {
    expect(
      isGpuInfoResponse({
        type: GPU_INFO_RESPONSE,
        ok: true,
        device: 'metal',
        isFallback: false,
        maxBufferSize: null,
        configuredThreshold: null,
      }),
    ).toBe(false);
  });

  it('rejects non-numeric maxBufferSize', () => {
    expect(
      isGpuInfoResponse({
        type: GPU_INFO_RESPONSE,
        ok: true,
        device: 'webgpu',
        isFallback: false,
        maxBufferSize: '4 GiB',
        configuredThreshold: null,
      }),
    ).toBe(false);
  });

  it('rejects ok:true with non-boolean isFallback', () => {
    expect(
      isGpuInfoResponse({
        type: GPU_INFO_RESPONSE,
        ok: true,
        device: 'webgpu',
        isFallback: 'no',
        maxBufferSize: null,
        configuredThreshold: null,
      }),
    ).toBe(false);
  });

  it('rejects non-finite maxBufferSize (NaN / Infinity)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        isGpuInfoResponse({
          type: GPU_INFO_RESPONSE,
          ok: true,
          device: 'webgpu',
          isFallback: false,
          maxBufferSize: bad,
          configuredThreshold: null,
        }),
      ).toBe(false);
    }
  });

  it('rejects non-finite configuredThreshold (NaN / Infinity)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        isGpuInfoResponse({
          type: GPU_INFO_RESPONSE,
          ok: true,
          device: 'wasm',
          isFallback: false,
          maxBufferSize: null,
          configuredThreshold: bad,
        }),
      ).toBe(false);
    }
  });

  it('accepts ok:false with error string', () => {
    expect(isGpuInfoResponse({ type: GPU_INFO_RESPONSE, ok: false, error: 'boom' })).toBe(true);
  });

  it('rejects ok:false with a non-string error', () => {
    expect(isGpuInfoResponse({ type: GPU_INFO_RESPONSE, ok: false, error: 123 })).toBe(false);
    expect(isGpuInfoResponse({ type: GPU_INFO_RESPONSE, ok: false, error: null })).toBe(false);
    expect(isGpuInfoResponse({ type: GPU_INFO_RESPONSE, ok: false })).toBe(false);
  });

  it('rejects wrong discriminator', () => {
    expect(isGpuInfoResponse({ type: 'other', ok: true })).toBe(false);
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
