import { describe, expect, it } from 'vitest';
import { createThinkStripper, stripThink } from '../src/think-strip.js';

describe('stripThink', () => {
  it('passes through text with no think block (non-reasoning model)', () => {
    expect(stripThink('Just a plain answer.')).toBe('Just a plain answer.');
    expect(stripThink('')).toBe('');
  });

  it('removes a complete think block and trims the leading whitespace after it', () => {
    expect(stripThink('<think>reasoning here</think>\n\nThe answer.')).toBe('The answer.');
  });

  it('handles a think block whose inner text spans newlines', () => {
    const raw = '<think>\nstep 1\nstep 2\n</think>\n\nFinal answer.';
    expect(stripThink(raw)).toBe('Final answer.');
  });

  it('hides everything while the think block is still open (mid-stream)', () => {
    expect(stripThink('<think>still reasoning, not closed yet')).toBe('');
  });

  it('holds back a trailing partial of the opening marker so it never flashes', () => {
    // As "<think>" arrives token by token, nothing should leak.
    expect(stripThink('<')).toBe('');
    expect(stripThink('<th')).toBe('');
    expect(stripThink('<think')).toBe('');
    expect(stripThink('<think>')).toBe('');
  });

  it('reveals the answer once the closing marker arrives', () => {
    expect(stripThink('<think>reasoning</think>')).toBe('');
    expect(stripThink('<think>reasoning</think>\n\nHello')).toBe('Hello');
    expect(stripThink('<think>reasoning</think>\n\nHello there')).toBe('Hello there');
  });

  it('produces an append-only visible stream as raw grows (forward streaming)', () => {
    const frames = [
      '<think>',
      '<think>let me',
      '<think>let me think</think>',
      '<think>let me think</think>\n\n',
      '<think>let me think</think>\n\nThe ',
      '<think>let me think</think>\n\nThe answer',
    ];
    const visibles = frames.map(stripThink);
    expect(visibles).toEqual(['', '', '', '', 'The ', 'The answer']);
    // Each visible is a prefix of the next (append-only) — the property the
    // streaming caller relies on for incremental deltas.
    for (let n = 1; n < visibles.length; n++) {
      expect(visibles[n].startsWith(visibles[n - 1])).toBe(true);
    }
  });

  it('removes multiple complete blocks', () => {
    expect(stripThink('<think>a</think>One <think>b</think>Two')).toBe('One Two');
  });

  it('keeps a lone "<" that is not the start of a think marker once resolved', () => {
    expect(stripThink('2 < 3 is true')).toBe('2 < 3 is true');
  });

  it('preserves text that appears before a think block', () => {
    expect(stripThink('Prefix <think>r</think> suffix')).toBe('Prefix  suffix');
  });
});

describe('createThinkStripper (incremental) equivalence', () => {
  // Split `raw` into chunks at the given boundary indices (sorted, in range)
  // and feed them to a fresh stripper, returning the sequence of full visible
  // strings the stripper produced after each push.
  function runIncremental(raw: string, boundaries: number[]): string[] {
    const stripper = createThinkStripper();
    const visibles: string[] = [];
    let prev = 0;
    const cuts = [...boundaries, raw.length];
    for (const cut of cuts) {
      const chunk = raw.slice(prev, cut);
      prev = cut;
      visibles.push(stripper.push(chunk));
    }
    return visibles;
  }

  // The oracle: the full-buffer stripThink applied to each growing prefix the
  // incremental driver has consumed after each push.
  function oracleVisibles(raw: string, boundaries: number[]): string[] {
    const cuts = [...boundaries, raw.length];
    return cuts.map((cut) => stripThink(raw.slice(0, cut)));
  }

  // Every way to split `raw` after each index (single-cut), exercising a marker
  // split at every byte boundary.
  function singleCutBoundaries(raw: string): number[][] {
    const sets: number[][] = [[]]; // no internal cut (one chunk)
    for (let i = 1; i < raw.length; i++) sets.push([i]);
    return sets;
  }

  // A few deterministic multi-cut splittings (every byte = max fragmentation,
  // plus a couple of fixed strides) so a marker can straddle several chunks.
  function multiCutBoundaries(raw: string): number[][] {
    const everyByte: number[] = [];
    for (let i = 1; i < raw.length; i++) everyByte.push(i);
    const stride2: number[] = [];
    for (let i = 2; i < raw.length; i += 2) stride2.push(i);
    const stride3: number[] = [];
    for (let i = 3; i < raw.length; i += 3) stride3.push(i);
    return [everyByte, stride2, stride3];
  }

  const cases: Array<{ name: string; raw: string }> = [
    { name: 'plain text', raw: 'Just a plain answer.' },
    { name: 'empty', raw: '' },
    { name: 'one complete block', raw: '<think>reasoning here</think>\n\nThe answer.' },
    {
      name: 'block with inner newlines',
      raw: '<think>\nstep 1\nstep 2\n</think>\n\nFinal answer.',
    },
    { name: 'multiple blocks', raw: '<think>a</think>One <think>b</think>Two' },
    { name: 'unclosed mid-stream block', raw: '<think>still reasoning, not closed yet' },
    { name: 'text before a block', raw: 'Prefix <think>r</think> suffix' },
    { name: 'literal < that is not a marker', raw: '2 < 3 is true' },
    { name: 'literal </ that is not a close marker', raw: 'a </b> c' },
    { name: 'bare opening marker only', raw: '<think>' },
    { name: 'block then trailing partial open', raw: '<think>x</think>Hi <thi' },
    { name: 'answer with a lone < at the very end', raw: 'done <' },
    { name: 'nested-looking inner < inside a block', raw: '<think>2 < 3</think>Yes' },
    { name: 'close marker as the whole thing', raw: '<think>r</think>' },
  ];

  for (const { name, raw } of cases) {
    it(`matches stripThink for every single-cut split: ${name}`, () => {
      for (const boundaries of singleCutBoundaries(raw)) {
        const got = runIncremental(raw, boundaries);
        const want = oracleVisibles(raw, boundaries);
        expect(got, `split at ${JSON.stringify(boundaries)}`).toEqual(want);
      }
    });

    it(`matches stripThink for fragmented multi-cut splits: ${name}`, () => {
      for (const boundaries of multiCutBoundaries(raw)) {
        const got = runIncremental(raw, boundaries);
        const want = oracleVisibles(raw, boundaries);
        expect(got, `split at ${JSON.stringify(boundaries)}`).toEqual(want);
      }
    });
  }

  it('produces an append-only visible stream (each push extends the prior)', () => {
    // Split-CLOSE-marker-across-boundaries case: feed the close marker one byte
    // at a time so it straddles many chunks, and assert the visible only grows.
    const raw = '<think>let me think</think>\n\nThe answer';
    const visibles = runIncremental(
      raw,
      Array.from({ length: raw.length - 1 }, (_, k) => k + 1),
    );
    for (let n = 1; n < visibles.length; n++) {
      expect(visibles[n].startsWith(visibles[n - 1])).toBe(true);
    }
    expect(visibles.at(-1)).toBe('The answer');
  });

  it('returns the final visible equal to stripThink of the whole buffer', () => {
    const raw = 'Prefix <think>a</think>mid<think>b</think>tail';
    const stripper = createThinkStripper();
    let last = '';
    for (const ch of raw) last = stripper.push(ch);
    expect(last).toBe(stripThink(raw));
  });

  it('matches stripThink for many deterministic-pseudorandom splittings', () => {
    // A small deterministic LCG so the "random" splittings are reproducible
    // (no flaky test) while still covering boundaries the strides miss.
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    for (const { raw } of cases) {
      for (let trial = 0; trial < 50; trial++) {
        const boundaries: number[] = [];
        for (let i = 1; i < raw.length; i++) {
          if (rand() < 0.4) boundaries.push(i);
        }
        const got = runIncremental(raw, boundaries);
        const want = oracleVisibles(raw, boundaries);
        expect(got, `raw=${JSON.stringify(raw)} split=${JSON.stringify(boundaries)}`).toEqual(want);
      }
    }
  });
});
