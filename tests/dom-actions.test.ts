import { afterEach, describe, expect, it } from 'vitest';
import { captureSelection } from '../src/dom-actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * jsdom does not fully implement `window.getSelection()`'s mutation API.
 * `selection.addRange(range)` is a no-op in some jsdom versions, so a few
 * tests below stub `window.getSelection` to return a fake Selection whose
 * `getRangeAt` returns the test's pre-built Range. Each test that does this
 * restores the original getter in its `afterEach`.
 */

function stubSelection(opts: {
  rangeCount?: number;
  isCollapsed?: boolean;
  range?: Range;
  text?: string;
}): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'getSelection');
  const fakeSelection = {
    rangeCount: opts.rangeCount ?? (opts.range ? 1 : 0),
    isCollapsed: opts.isCollapsed ?? false,
    getRangeAt: (_: number) => opts.range as Range,
    toString: () => opts.text ?? '',
    removeAllRanges: () => {},
    addRange: (_: Range) => {},
  };
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    value: () => fakeSelection,
  });
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(window, 'getSelection', originalDescriptor);
    } else {
      (window as unknown as { getSelection?: unknown }).getSelection = undefined;
    }
  };
}

describe('captureSelection', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    document.body.innerHTML = '';
  });

  it('returns null when no selection exists', () => {
    cleanup = stubSelection({ rangeCount: 0, isCollapsed: true });
    expect(captureSelection(document)).toBeNull();
  });

  it('returns InputSnapshot for an active <input> with a non-empty selection', () => {
    const input = document.createElement('input');
    input.value = 'hello world';
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(0, 5);

    const snap = captureSelection(document);
    expect(snap).not.toBeNull();
    expect(snap?.kind).toBe('input');
    if (snap?.kind === 'input') {
      expect(snap.element).toBe(input);
      expect(snap.selectionStart).toBe(0);
      expect(snap.selectionEnd).toBe(5);
      expect(snap.text).toBe('hello');
    }
  });

  it('returns InputSnapshot for an active <textarea>', () => {
    const ta = document.createElement('textarea');
    ta.value = 'foo bar baz';
    document.body.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(4, 7);

    const snap = captureSelection(document);
    expect(snap?.kind).toBe('input');
    if (snap?.kind === 'input') {
      expect(snap.element).toBe(ta);
      expect(snap.text).toBe('bar');
    }
  });

  it('returns null when an <input> is focused with start === end', () => {
    const input = document.createElement('input');
    input.value = 'hello world';
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(3, 3);
    // Also stub the window selection to be empty so the fallback branch
    // also returns null.
    cleanup = stubSelection({ rangeCount: 0, isCollapsed: true });
    expect(captureSelection(document)).toBeNull();
  });

  it('returns RangeSnapshot for a regular DOM selection', () => {
    const p = document.createElement('p');
    p.textContent = 'hello world';
    document.body.appendChild(p);
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    cleanup = stubSelection({
      rangeCount: 1,
      isCollapsed: false,
      range,
      text: 'hello',
    });

    const snap = captureSelection(document);
    expect(snap?.kind).toBe('range');
    if (snap?.kind === 'range') {
      expect(snap.text).toBe('hello');
      expect(snap.contentEditable).toBeNull();
      // Cloned, not identity-equal to the original Range.
      expect(snap.range).not.toBe(range);
      expect(snap.range.toString()).toBe('hello');
    }
  });

  it('sets contentEditable when the range is inside a contenteditable ancestor', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    div.textContent = 'editable text';
    document.body.appendChild(div);
    const textNode = div.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 8);
    cleanup = stubSelection({
      rangeCount: 1,
      isCollapsed: false,
      range,
      text: 'editable',
    });

    const snap = captureSelection(document);
    expect(snap?.kind).toBe('range');
    if (snap?.kind === 'range') {
      expect(snap.contentEditable).toBe(div);
    }
  });

  it('returns null when selection is collapsed (cursor only)', () => {
    cleanup = stubSelection({ rangeCount: 1, isCollapsed: true });
    expect(captureSelection(document)).toBeNull();
  });

  it('returns null when sel.toString() yields an empty string', () => {
    const p = document.createElement('p');
    p.textContent = 'hello';
    document.body.appendChild(p);
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 2);
    cleanup = stubSelection({
      rangeCount: 1,
      isCollapsed: false,
      range,
      text: '',
    });
    expect(captureSelection(document)).toBeNull();
  });
});
