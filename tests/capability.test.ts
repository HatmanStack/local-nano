import { describe, expect, it } from 'vitest';
import { CAPABLE_MIN_BUFFER_BYTES, classifyCapability } from '../src/offscreen/capability.js';
import type { GpuInfoSnapshot } from '../src/offscreen/protocol.js';

/**
 * Build a GpuInfoSnapshot with sensible defaults the test can override.
 * configuredThreshold is irrelevant to classification but part of the shape.
 */
function snapshot(overrides: Partial<GpuInfoSnapshot>): GpuInfoSnapshot {
  return {
    device: 'webgpu',
    isFallback: false,
    maxBufferSize: 4 * 1024 * 1024 * 1024,
    configuredThreshold: null,
    lastDeviceLostAt: null,
    ...overrides,
  };
}

describe('CAPABLE_MIN_BUFFER_BYTES', () => {
  it('is exactly 1 GiB, matching the existing preflight boundary', () => {
    expect(CAPABLE_MIN_BUFFER_BYTES).toBe(1024 * 1024 * 1024);
  });
});

describe('classifyCapability (ADR-R9)', () => {
  it('classifies a wasm device as weak', () => {
    expect(classifyCapability(snapshot({ device: 'wasm', maxBufferSize: null }))).toBe('weak');
  });

  it('classifies a software-fallback webgpu adapter as weak', () => {
    expect(classifyCapability(snapshot({ device: 'webgpu', isFallback: true }))).toBe('weak');
  });

  it('classifies a webgpu adapter under 1 GiB max buffer as weak', () => {
    expect(classifyCapability(snapshot({ maxBufferSize: 512 * 1024 * 1024 }))).toBe('weak');
  });

  it('classifies a webgpu adapter at or above 1 GiB max buffer as capable', () => {
    expect(classifyCapability(snapshot({ maxBufferSize: 2 * 1024 * 1024 * 1024 }))).toBe('capable');
  });

  it('treats exactly 1 GiB as capable (strict less-than cutoff)', () => {
    expect(classifyCapability(snapshot({ maxBufferSize: CAPABLE_MIN_BUFFER_BYTES }))).toBe(
      'capable',
    );
  });

  it('treats a null max buffer on a real (non-fallback) adapter as capable', () => {
    expect(classifyCapability(snapshot({ maxBufferSize: null }))).toBe('capable');
  });
});
