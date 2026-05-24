import { afterEach, describe, expect, it, vi } from 'vitest';
import { debugLog } from '../src/debug.js';

describe('debugLog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call console.log when DEBUG is false', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    debugLog('diagnostic', 1, { a: 2 });
    expect(spy).not.toHaveBeenCalled();
  });
});
