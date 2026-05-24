import { describe, expect, it } from 'vitest';
import {
  formatProgressText,
  GPU_LOADING_TEXT,
  nextProgress,
  type ProgressState,
} from '../src/offscreen/progress.js';

const initial: ProgressState = { percent: 0 };

describe('nextProgress', () => {
  it('maps a half-loaded fraction to 50 percent', () => {
    expect(nextProgress(initial, { loaded: 0.5, total: 1 }).percent).toBe(50);
  });

  it('rounds the fraction to the nearest integer percent', () => {
    // 0.426 * 100 = 42.6 → 43
    expect(nextProgress(initial, { loaded: 0.426, total: 1 }).percent).toBe(43);
  });

  it('does not decrease the reported percent on a lower subsequent loaded', () => {
    const after = nextProgress(initial, { loaded: 0.8, total: 1 });
    expect(after.percent).toBe(80);
    // A reordered/out-of-order frame reporting less must hold at 80.
    const held = nextProgress(after, { loaded: 0.3, total: 1 });
    expect(held.percent).toBe(80);
  });

  it('holds the previous percent when total is zero', () => {
    const after = nextProgress({ percent: 37 }, { loaded: 5, total: 0 });
    expect(after.percent).toBe(37);
  });

  it('holds the previous percent when total is negative or non-finite', () => {
    expect(nextProgress({ percent: 12 }, { loaded: 5, total: -1 }).percent).toBe(12);
    expect(nextProgress({ percent: 12 }, { loaded: 5, total: Number.NaN }).percent).toBe(12);
    expect(
      nextProgress({ percent: 12 }, { loaded: 5, total: Number.POSITIVE_INFINITY }).percent,
    ).toBe(12);
  });

  it('holds the previous percent when loaded is non-finite', () => {
    expect(nextProgress({ percent: 20 }, { loaded: Number.NaN, total: 1 }).percent).toBe(20);
  });

  it('clamps to 0-100', () => {
    expect(nextProgress(initial, { loaded: 2, total: 1 }).percent).toBe(100);
    expect(nextProgress({ percent: 0 }, { loaded: -5, total: 1 }).percent).toBe(0);
  });

  it('reaches exactly 100 when loaded equals total', () => {
    expect(nextProgress({ percent: 90 }, { loaded: 1, total: 1 }).percent).toBe(100);
  });
});

describe('formatProgressText', () => {
  it('renders the downloading text with the percent', () => {
    expect(formatProgressText(42)).toContain('42%');
    expect(formatProgressText(42)).toContain('Downloading model');
  });

  it('renders 0% and 100%', () => {
    expect(formatProgressText(0)).toContain('0%');
    expect(formatProgressText(100)).toContain('100%');
  });
});

describe('GPU_LOADING_TEXT', () => {
  it('is the indeterminate GPU-load label', () => {
    expect(GPU_LOADING_TEXT).toContain('Loading into GPU');
  });
});
