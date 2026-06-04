import { describe, expect, it } from 'vitest';
import {
  buildDiagnostic,
  type DiagnosticInput,
  errorInfo,
  parseChromeVersion,
} from '../src/offscreen/diagnostic.js';

const base: DiagnosticInput = {
  device: 'webgpu',
  isFallback: false,
  maxBufferSize: 2 * 1024 * 1024 * 1024,
  chosenModel: 'onnx-community/gemma-4-E2B-it-ONNX',
  activeTier: { modelName: 'onnx-community/gemma-4-E2B-it-ONNX', device: 'webgpu', dtype: 'q4f16' },
  ladderPath: [],
  errorClass: 'Error',
  errorMessage: 'offscreen port disconnected: unknown reason',
  deviceLostAt: 'none',
  extensionVersion: '0.2.4',
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

  it('renders deviceLostAt as none when no loss has been observed', () => {
    const out = buildDiagnostic(base);
    expect(out).toContain('deviceLostAt: none');
  });

  it('renders deviceLostAt with an ISO timestamp when a loss happened', () => {
    const out = buildDiagnostic({ ...base, deviceLostAt: '2026-06-04T12:00:00.000Z' });
    expect(out).toContain('deviceLostAt: 2026-06-04T12:00:00.000Z');
  });

  it('renders deviceLostAt immediately after errorMessage', () => {
    const out = buildDiagnostic({ ...base, deviceLostAt: '2026-06-04T12:00:00.000Z' });
    const lines = out.split('\n');
    const errorIdx = lines.findIndex((l) => l.startsWith('errorMessage:'));
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(lines[errorIdx + 1]).toBe('deviceLostAt: 2026-06-04T12:00:00.000Z');
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

  it('renders the chosen model', () => {
    const out = buildDiagnostic(base);
    expect(out).toContain('chosenModel: onnx-community/gemma-4-E2B-it-ONNX');
  });

  it('renders chosenModel as n/a when null', () => {
    const out = buildDiagnostic({ ...base, chosenModel: null });
    expect(out).toContain('chosenModel: n/a');
  });

  it('renders the parsed Chrome version and the raw user agent', () => {
    const out = buildDiagnostic(base);
    expect(out).toContain('chromeVersion: 120.0.0.0');
    expect(out).toContain(`userAgent: ${base.userAgent}`);
  });

  it('renders chromeVersion as n/a for a non-Chrome user agent', () => {
    const out = buildDiagnostic({ ...base, userAgent: 'Mozilla/5.0 (compatible; Bot/1.0)' });
    expect(out).toContain('chromeVersion: n/a');
  });

  it('renders the ladder path with one tier per line and its outcome', () => {
    const out = buildDiagnostic({
      ...base,
      ladderPath: [
        {
          modelName: 'onnx-community/gemma-4-E2B-it-ONNX',
          device: 'webgpu',
          dtype: 'q4f16',
          outcome: 'load-failure',
        },
        {
          modelName: 'onnx-community/gemma-4-E2B-it-ONNX',
          device: 'wasm',
          dtype: 'q8',
          outcome: 'success',
        },
      ],
    });
    expect(out).toContain('ladderPath:');
    expect(out).toContain('onnx-community/gemma-4-E2B-it-ONNX/webgpu/q4f16 -> load-failure');
    expect(out).toContain('onnx-community/gemma-4-E2B-it-ONNX/wasm/q8 -> success');
  });

  it('renders the network outcome on a tier', () => {
    const out = buildDiagnostic({
      ...base,
      ladderPath: [
        {
          modelName: 'onnx-community/gemma-4-E2B-it-ONNX',
          device: 'webgpu',
          dtype: 'q4f16',
          outcome: 'network',
        },
      ],
    });
    expect(out).toContain('onnx-community/gemma-4-E2B-it-ONNX/webgpu/q4f16 -> network');
  });

  it('renders an empty ladder path as none', () => {
    const out = buildDiagnostic({ ...base, ladderPath: [] });
    expect(out).toMatch(/ladderPath:\nnone/);
  });
});

describe('parseChromeVersion', () => {
  it('extracts the version from a Chrome user agent', () => {
    expect(
      parseChromeVersion(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe('120.0.0.0');
  });

  it('extracts the Chromium version from an Edge-on-Chromium user agent', () => {
    expect(
      parseChromeVersion(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      ),
    ).toBe('120.0.0.0');
  });

  it('returns null for a non-Chrome user agent', () => {
    expect(parseChromeVersion('Mozilla/5.0 (Macintosh) Version/17.0 Safari/605.1.15')).toBeNull();
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
