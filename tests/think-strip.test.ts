import { describe, expect, it } from 'vitest';
import { stripThink } from '../src/think-strip.js';

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
