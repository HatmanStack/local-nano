import { describe, expect, it } from 'vitest';
import { buildDiagnostic, type DiagnosticInput, errorInfo } from '../src/offscreen/diagnostic.js';

const base: DiagnosticInput = {
  device: 'webgpu',
  isFallback: false,
  maxBufferSize: 2 * 1024 * 1024 * 1024,
  activeTier: { modelName: 'onnx-community/gemma-4-E2B-it-ONNX', device: 'webgpu', dtype: 'q4f16' },
  errorClass: 'Error',
  errorMessage: 'offscreen port disconnected: unknown reason',
  extensionVersion: '0.2.4',
};

describe('buildDiagnostic', () => {
  it('renders every input field with a stable label', () => {
    const out = buildDiagnostic(base);
    expect(out).toContain('device: webgpu');
    expect(out).toContain('isFallback: false');
    expect(out).toContain('extensionVersion: 0.2.4');
    expect(out).toContain('errorClass: Error');
    expect(out).toContain('errorMessage: offscreen port disconnected: unknown reason');
  });

  it('renders maxBufferSize as MiB when present', () => {
    const out = buildDiagnostic(base);
    // 2 GiB = 2048 MiB.
    expect(out).toContain('maxBufferSize: 2048 MiB');
  });

  it('renders maxBufferSize as n/a when null', () => {
    const out = buildDiagnostic({ ...base, maxBufferSize: null });
    expect(out).toContain('maxBufferSize: n/a');
  });

  it('renders the active tier as model/device/dtype', () => {
    const out = buildDiagnostic(base);
    expect(out).toContain('activeTier: onnx-community/gemma-4-E2B-it-ONNX/webgpu/q4f16');
  });

  it('renders activeTier as n/a when null', () => {
    const out = buildDiagnostic({ ...base, activeTier: null });
    expect(out).toContain('activeTier: n/a');
  });

  it('produces copy-friendly output with no trailing whitespace on any line', () => {
    const out = buildDiagnostic(base);
    for (const line of out.split('\n')) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('is deterministic for the same input', () => {
    expect(buildDiagnostic(base)).toBe(buildDiagnostic(base));
  });
});

describe('errorInfo', () => {
  it('extracts class and message from an Error subclass', () => {
    expect(errorInfo(new TypeError('x'))).toEqual({ errorClass: 'TypeError', errorMessage: 'x' });
  });

  it('uses Error as the class for a plain Error', () => {
    expect(errorInfo(new Error('boom'))).toEqual({ errorClass: 'Error', errorMessage: 'boom' });
  });

  it('uses Error as the class for non-Error inputs', () => {
    expect(errorInfo('plain')).toEqual({ errorClass: 'Error', errorMessage: 'plain' });
    expect(errorInfo(42)).toEqual({ errorClass: 'Error', errorMessage: '42' });
    expect(errorInfo(undefined)).toEqual({ errorClass: 'Error', errorMessage: 'undefined' });
  });
});
