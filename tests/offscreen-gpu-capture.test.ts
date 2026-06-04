import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetForTests,
  type DeviceLostInfo,
  installGpuCapture,
} from '../src/offscreen/gpu-capture.js';
import { gpuMock, makeFakeAdapter, makeFakeDevice } from './setup.js';

// `navigator.gpu` IS the `gpuMock` object (installed via defineProperty in
// setup.ts), so reading `gpuMock` and reading `navigator.gpu` are the same
// surface. Tests drive the mock through `gpuMock` directly.
const gpu = () => gpuMock;

describe('installGpuCapture', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('returns silently when navigator.gpu is undefined', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'gpu');
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    try {
      expect(() => installGpuCapture({ onDeviceLost: vi.fn() })).not.toThrow();
    } finally {
      if (original) Object.defineProperty(navigator, 'gpu', original);
    }
  });

  it('requestAdapter resolves to the original adapter unchanged (transparency)', async () => {
    const adapter = makeFakeAdapter();
    gpu()._setAdapter(adapter);
    installGpuCapture({ onDeviceLost: vi.fn() });
    const resolved = await gpu().requestAdapter();
    expect(resolved).toBe(adapter);
  });

  it('requestDevice resolves to the original device unchanged', async () => {
    const adapter = makeFakeAdapter();
    const device = makeFakeDevice();
    adapter.requestDevice = vi.fn(async () => device);
    gpu()._setAdapter(adapter);
    installGpuCapture({ onDeviceLost: vi.fn() });
    const resolvedAdapter = await gpu().requestAdapter();
    const resolvedDevice = await resolvedAdapter?.requestDevice();
    expect(resolvedDevice).toBe(device);
  });

  it('fires onDeviceLost with reason, message, and an ISO timestamp', async () => {
    const onDeviceLost = vi.fn<(info: DeviceLostInfo) => void>();
    installGpuCapture({ onDeviceLost });
    const adapter = await gpu().requestAdapter();
    const device = await adapter?.requestDevice();
    expect(device).toBeDefined();
    device?._fireLost('destroyed', 'GPU device was lost');
    // Let the .lost.then microtask settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(onDeviceLost).toHaveBeenCalledTimes(1);
    const info = onDeviceLost.mock.calls[0]?.[0] as DeviceLostInfo;
    expect(info.reason).toBe('destroyed');
    expect(info.message).toBe('GPU device was lost');
    expect(typeof info.at).toBe('string');
    expect(new Date(info.at).toISOString()).toBe(info.at);
  });

  it('does not double-wrap on a second install (requestAdapter reference unchanged)', async () => {
    installGpuCapture({ onDeviceLost: vi.fn() });
    const afterFirst = gpu().requestAdapter;
    installGpuCapture({ onDeviceLost: vi.fn() });
    const afterSecond = gpu().requestAdapter;
    expect(afterSecond).toBe(afterFirst);
  });

  it('attaches exactly one listener per device handle (no double fire on re-install)', async () => {
    const onDeviceLost = vi.fn<(info: DeviceLostInfo) => void>();
    installGpuCapture({ onDeviceLost });
    // Re-install with the SAME captured-device WeakSet still in place.
    installGpuCapture({ onDeviceLost });
    const adapter = await gpu().requestAdapter();
    const device = await adapter?.requestDevice();
    device?._fireLost('destroyed', 'lost');
    await Promise.resolve();
    await Promise.resolve();
    expect(onDeviceLost).toHaveBeenCalledTimes(1);
  });

  it('a second requestDevice returning a different device attaches its own listener', async () => {
    const onDeviceLost = vi.fn<(info: DeviceLostInfo) => void>();
    const adapter = makeFakeAdapter();
    const deviceA = makeFakeDevice();
    const deviceB = makeFakeDevice();
    let call = 0;
    adapter.requestDevice = vi.fn(async () => {
      call += 1;
      return call === 1 ? deviceA : deviceB;
    });
    gpu()._setAdapter(adapter);
    installGpuCapture({ onDeviceLost });
    const a = await gpu().requestAdapter();
    await a?.requestDevice();
    await a?.requestDevice();
    deviceA._fireLost('destroyed', 'a');
    deviceB._fireLost('destroyed', 'b');
    await Promise.resolve();
    await Promise.resolve();
    expect(onDeviceLost).toHaveBeenCalledTimes(2);
  });

  it('fires onDeviceCaptured once per unique captured device', async () => {
    const onDeviceCaptured = vi.fn();
    const adapter = makeFakeAdapter();
    const device = makeFakeDevice();
    adapter.requestDevice = vi.fn(async () => device);
    gpu()._setAdapter(adapter);
    installGpuCapture({ onDeviceLost: vi.fn(), onDeviceCaptured });
    const a = await gpu().requestAdapter();
    await a?.requestDevice();
    await a?.requestDevice();
    expect(onDeviceCaptured).toHaveBeenCalledTimes(1);
    const captured = onDeviceCaptured.mock.calls[0]?.[0] as { device: unknown; capturedAt: string };
    expect(captured.device).toBe(device);
    expect(typeof captured.capturedAt).toBe('string');
  });

  it('returns the original null adapter unchanged when requestAdapter resolves null', async () => {
    gpu()._setAdapter(null);
    installGpuCapture({ onDeviceLost: vi.fn() });
    const resolved = await gpu().requestAdapter();
    expect(resolved).toBeNull();
  });
});
