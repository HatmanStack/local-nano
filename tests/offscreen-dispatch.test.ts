import { describe, expect, it } from 'vitest';
import { classifyOffscreenMessage } from '../src/offscreen/dispatch.js';
import {
  COUNT_TOKENS_REQUEST,
  type CountTokensRequest,
  ENSURE_OFFSCREEN_REQUEST,
  type EnsureOffscreenRequest,
  GPU_INFO_REQUEST,
  type GpuInfoRequest,
  REBUILD_SESSION_REQUEST,
  type RebuildSessionRequest,
  STREAM_REQUEST,
  type StreamRequest,
  WARMUP_REQUEST,
  type WarmupRequest,
} from '../src/offscreen/protocol.js';

describe('classifyOffscreenMessage', () => {
  it('classifies a gpu-info request', () => {
    const msg: GpuInfoRequest = { type: GPU_INFO_REQUEST };
    expect(classifyOffscreenMessage(msg)).toBe('gpu-info');
  });

  it('classifies a rebuild-session request', () => {
    const msg: RebuildSessionRequest = {
      type: REBUILD_SESSION_REQUEST,
      history: [{ role: 'user', text: 'hi' }],
    };
    expect(classifyOffscreenMessage(msg)).toBe('rebuild-session');
  });

  it('classifies a count-tokens request', () => {
    const msg: CountTokensRequest = { type: COUNT_TOKENS_REQUEST, text: 'hello' };
    expect(classifyOffscreenMessage(msg)).toBe('count-tokens');
  });

  it('classifies a warmup request with a tier', () => {
    const msg: WarmupRequest = {
      type: WARMUP_REQUEST,
      tier: { modelName: 'org/model', device: 'webgpu', dtype: 'q4f16' },
    };
    expect(classifyOffscreenMessage(msg)).toBe('warmup');
  });

  it('classifies a warmup request without a tier (base tier)', () => {
    const msg: WarmupRequest = { type: WARMUP_REQUEST };
    expect(classifyOffscreenMessage(msg)).toBe('warmup');
  });

  it('returns null for a malformed warmup request (bad tier device)', () => {
    expect(
      classifyOffscreenMessage({
        type: WARMUP_REQUEST,
        tier: { modelName: 'org/model', device: 'metal', dtype: 'q4f16' },
      }),
    ).toBeNull();
  });

  it('returns null for an ensure-offscreen request (owned by the SW context)', () => {
    const msg: EnsureOffscreenRequest = { type: ENSURE_OFFSCREEN_REQUEST };
    expect(classifyOffscreenMessage(msg)).toBeNull();
  });

  it('returns null for a stream request (owned by the onConnect port)', () => {
    const msg: StreamRequest = { type: STREAM_REQUEST, id: 'abc', prompt: 'hi' };
    expect(classifyOffscreenMessage(msg)).toBeNull();
  });

  it('returns null for null', () => {
    expect(classifyOffscreenMessage(null)).toBeNull();
  });

  it('returns null for an empty object', () => {
    expect(classifyOffscreenMessage({})).toBeNull();
  });

  it('returns null for a random object', () => {
    expect(classifyOffscreenMessage({ foo: 'bar', type: 'something-else' })).toBeNull();
  });

  it('returns null for a malformed rebuild-session request (bad history)', () => {
    expect(classifyOffscreenMessage({ type: REBUILD_SESSION_REQUEST, history: 'oops' })).toBeNull();
  });

  it('returns null for a malformed count-tokens request (missing text)', () => {
    expect(classifyOffscreenMessage({ type: COUNT_TOKENS_REQUEST })).toBeNull();
  });
});
