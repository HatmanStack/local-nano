import { describe, expect, it } from 'vitest';
import { STREAM_DONE } from '../src/offscreen/protocol.js';
import { finalizeStreamDone, POISONED_STREAM_ERROR } from '../src/offscreen/stream-finalize.js';

describe('finalizeStreamDone', () => {
  it('returns the aborted shape when aborted with zero chunks', () => {
    expect(finalizeStreamDone({ id: 'x', aborted: true, chunkCount: 0 })).toEqual({
      type: STREAM_DONE,
      id: 'x',
      ok: false,
      error: 'aborted',
    });
  });

  it('returns the aborted shape when aborted even if chunks were delivered', () => {
    // An aborted stream that happened to deliver chunks before the abort still
    // surfaces as aborted: abort wins over chunk count.
    expect(finalizeStreamDone({ id: 'x', aborted: true, chunkCount: 3 })).toEqual({
      type: STREAM_DONE,
      id: 'x',
      ok: false,
      error: 'aborted',
    });
  });

  it('returns the poisoned shape on a natural zero-chunk completion', () => {
    expect(finalizeStreamDone({ id: 'x', aborted: false, chunkCount: 0 })).toEqual({
      type: STREAM_DONE,
      id: 'x',
      ok: false,
      error: POISONED_STREAM_ERROR,
    });
  });

  it('returns ok:true on a natural completion that produced chunks', () => {
    expect(finalizeStreamDone({ id: 'x', aborted: false, chunkCount: 1 })).toEqual({
      type: STREAM_DONE,
      id: 'x',
      ok: true,
    });
  });

  it('POISONED_STREAM_ERROR is the exact wire string', () => {
    expect(POISONED_STREAM_ERROR).toBe('no tokens emitted; session may be poisoned');
  });
});
