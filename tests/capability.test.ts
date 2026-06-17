import { describe, expect, it } from 'vitest';
import {
  CAPABLE_MIN_BUFFER_BYTES,
  classifyCapability,
  LOW_MEMORY_GB,
} from '../src/offscreen/capability.js';
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

  it('classifies a low-RAM device as weak even with a large GPU buffer', () => {
    // The reported case: big maxBufferSize (4 GiB), real adapter, but only
    // 4 GiB system RAM. maxBufferSize alone misses this; deviceMemory catches it.
    expect(
      classifyCapability(
        snapshot({ maxBufferSize: 4 * 1024 * 1024 * 1024, deviceMemory: LOW_MEMORY_GB }),
      ),
    ).toBe('weak');
  });

  it('treats deviceMemory above the boundary as capable', () => {
    expect(classifyCapability(snapshot({ deviceMemory: 8 }))).toBe('capable');
  });

  it('ignores an absent (undefined/null) deviceMemory, falling back to buffer-based verdict', () => {
    expect(classifyCapability(snapshot({ deviceMemory: undefined }))).toBe('capable');
    expect(classifyCapability(snapshot({ deviceMemory: null }))).toBe('capable');
  });

  it('LOW_MEMORY_GB is 4 GiB', () => {
    expect(LOW_MEMORY_GB).toBe(4);
  });
});
