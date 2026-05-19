import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputSnapshot, RangeSnapshot } from '../src/dom-actions.js';
import { applyToTarget } from '../src/dom-apply.js';

describe('applyToTarget — <input>/<textarea>', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('replaces the selected slice of an <input> value', () => {
    const input = document.createElement('input');
    input.value = 'hello world';
    document.body.appendChild(input);

    const snap: InputSnapshot = {
      kind: 'input',
      element: input,
      selectionStart: 0,
      selectionEnd: 5,
      text: 'hello',
    };
    const ok = applyToTarget(snap, 'goodbye');
    expect(ok).toBe(true);
    expect(input.value).toBe('goodbye world');
  });

  it('dispatches a bubbling input event after mutating an <input>', () => {
    const input = document.createElement('input');
    input.value = 'hello world';
    document.body.appendChild(input);
    const handler = vi.fn();
    document.addEventListener('input', handler);

    const snap: InputSnapshot = {
      kind: 'input',
      element: input,
      selectionStart: 0,
      selectionEnd: 5,
      text: 'hello',
    };
    applyToTarget(snap, 'HI');
    expect(handler).toHaveBeenCalledTimes(1);
    document.removeEventListener('input', handler);
  });

  it('replaces the selected slice of a <textarea> value', () => {
    const ta = document.createElement('textarea');
    ta.value = 'foo bar baz';
    document.body.appendChild(ta);

    const snap: InputSnapshot = {
      kind: 'input',
      element: ta,
      selectionStart: 4,
      selectionEnd: 7,
      text: 'bar',
    };
    const ok = applyToTarget(snap, 'BAR');
    expect(ok).toBe(true);
    expect(ta.value).toBe('foo BAR baz');
  });

  it('returns false and does not mutate when the input is disconnected', () => {
    const input = document.createElement('input');
    input.value = 'hello world';
    // not appended; isConnected === false

    const snap: InputSnapshot = {
      kind: 'input',
      element: input,
      selectionStart: 0,
      selectionEnd: 5,
      text: 'hello',
    };
    const ok = applyToTarget(snap, 'goodbye');
    expect(ok).toBe(false);
    expect(input.value).toBe('hello world');
  });
});

describe('applyToTarget — Range / read-only prose', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('replaces a Range inside read-only prose with a Text node', () => {
    const p = document.createElement('p');
    p.textContent = 'foo bar baz';
    document.body.appendChild(p);
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 4);
    range.setEnd(textNode, 7);

    const snap: RangeSnapshot = {
      kind: 'range',
      range,
      text: 'bar',
      contentEditable: null,
    };
    const ok = applyToTarget(snap, 'BAR');
    expect(ok).toBe(true);
    expect(p.textContent).toBe('foo BAR baz');
  });

  it('inserts model output as a Text node, not HTML (XSS guard)', () => {
    const p = document.createElement('p');
    p.textContent = 'before x after';
    document.body.appendChild(p);
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 7);
    range.setEnd(textNode, 8);

    const snap: RangeSnapshot = {
      kind: 'range',
      range,
      text: 'x',
      contentEditable: null,
    };
    const payload = '<script>alert(1)</script>';
    const ok = applyToTarget(snap, payload);
    expect(ok).toBe(true);
    // No <script> element was created.
    expect(p.querySelector('script')).toBeNull();
    // The payload text is preserved verbatim.
    expect(p.textContent).toBe(`before ${payload} after`);
    // Find the inserted node and verify it's a Text node.
    let inserted: Node | null = null;
    for (const child of Array.from(p.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && child.nodeValue === payload) {
        inserted = child;
        break;
      }
    }
    expect(inserted).not.toBeNull();
    expect(inserted?.nodeType).toBe(Node.TEXT_NODE);
  });
});

describe('applyToTarget — contentEditable', () => {
  let originalExecCommand: typeof document.execCommand | undefined;

  afterEach(() => {
    document.body.innerHTML = '';
    if (originalExecCommand) {
      document.execCommand = originalExecCommand;
      originalExecCommand = undefined;
    }
  });

  it('uses execCommand("insertText") when contentEditable is present', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    div.textContent = 'editable text';
    document.body.appendChild(div);
    const textNode = div.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 8);

    originalExecCommand = document.execCommand;
    const execSpy = vi.fn(() => true);
    document.execCommand = execSpy as unknown as typeof document.execCommand;

    const snap: RangeSnapshot = {
      kind: 'range',
      range,
      text: 'editable',
      contentEditable: div,
    };
    const ok = applyToTarget(snap, '<new>');
    expect(ok).toBe(true);
    expect(execSpy).toHaveBeenCalledWith('insertText', false, '<new>');
  });

  it('falls back to Range mutation when execCommand returns false', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    div.textContent = 'editable text';
    document.body.appendChild(div);
    const textNode = div.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 8);

    originalExecCommand = document.execCommand;
    document.execCommand = vi.fn(() => false) as unknown as typeof document.execCommand;

    const snap: RangeSnapshot = {
      kind: 'range',
      range,
      text: 'editable',
      contentEditable: div,
    };
    const ok = applyToTarget(snap, 'REPLACED');
    expect(ok).toBe(true);
    expect(div.textContent).toBe('REPLACED text');
  });

  it('returns false and does not throw when range mutation fails', () => {
    // Build a snapshot whose range is intentionally broken: replace
    // deleteContents with a thrower so the catch block runs.
    const p = document.createElement('p');
    p.textContent = 'oops';
    document.body.appendChild(p);
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);

    const realDelete = range.deleteContents.bind(range);
    range.deleteContents = (() => {
      throw new Error('synthetic failure');
    }) as typeof range.deleteContents;

    const snap: RangeSnapshot = {
      kind: 'range',
      range,
      text: 'oops',
      contentEditable: null,
    };
    expect(() => applyToTarget(snap, 'X')).not.toThrow();
    const ok = applyToTarget(snap, 'X');
    expect(ok).toBe(false);
    // Restore for cleanup.
    range.deleteContents = realDelete;
  });
});
