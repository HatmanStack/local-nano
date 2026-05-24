import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAskPrompt,
  buildRewritePrompt,
  CONTEXT_CHARS_AFTER,
  CONTEXT_CHARS_BEFORE,
  decideSnapshot,
  isSupportedSelection,
  MAX_OUTPUT_MULTIPLIER,
  MAX_SELECTION_CHARS,
  MIN_OUTPUT_TOKENS,
  type SelectionSnapshot,
  snapshotSelection,
  streamRewriteIntoRange,
  undoRewrite,
} from '../src/selection-rewrite.js';

// Helpers ------------------------------------------------------------------

function makeSelection(range: Range): Selection {
  const sel: Selection = {
    rangeCount: 1,
    isCollapsed: range.collapsed,
    getRangeAt: () => range,
    removeAllRanges: () => undefined,
    addRange: () => undefined,
    toString: () => range.toString(),
  } as unknown as Selection;
  return sel;
}

function makeRangeFor(node: Node, start: number, end: number): Range {
  const r = document.createRange();
  r.setStart(node, start);
  r.setEnd(node, end);
  return r;
}

function expectSnap(snap: SelectionSnapshot | null): SelectionSnapshot {
  if (!snap) throw new Error('expected a non-null snapshot');
  return snap;
}

afterEach(() => {
  document.body.innerHTML = '';
});

// Constants ----------------------------------------------------------------

describe('module constants', () => {
  it('exports the soft-cap and selection-bound constants', () => {
    expect(MIN_OUTPUT_TOKENS).toBe(256);
    expect(MAX_OUTPUT_MULTIPLIER).toBe(2);
    expect(CONTEXT_CHARS_BEFORE).toBe(200);
    expect(CONTEXT_CHARS_AFTER).toBe(200);
    expect(MAX_SELECTION_CHARS).toBe(700);
  });
});

// isSupportedSelection -----------------------------------------------------

describe('isSupportedSelection', () => {
  it('returns false for null', () => {
    expect(isSupportedSelection(null)).toBe(false);
  });

  it('returns false for a collapsed selection', () => {
    const p = document.createElement('p');
    p.textContent = 'hello world';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 3, 3);
    expect(isSupportedSelection(makeSelection(range))).toBe(false);
  });

  it('returns false when the selection is only whitespace', () => {
    const p = document.createElement('p');
    p.textContent = '   spaces   ';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, 3);
    expect(isSupportedSelection(makeSelection(range))).toBe(false);
  });

  it('returns false when an ancestor is INPUT', () => {
    const wrap = document.createElement('div');
    const input = document.createElement('input');
    input.value = 'hello';
    wrap.appendChild(input);
    document.body.appendChild(wrap);
    // The range can't really be inside an input's value; emulate by putting
    // the range on the input element itself.
    const range = document.createRange();
    range.selectNodeContents(input);
    expect(isSupportedSelection(makeSelection(range))).toBe(false);
  });

  it('returns false when an ancestor is TEXTAREA', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    const range = document.createRange();
    range.selectNodeContents(ta);
    expect(isSupportedSelection(makeSelection(range))).toBe(false);
  });

  it('returns false when an ancestor is contentEditable', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    div.textContent = 'edit me';
    document.body.appendChild(div);
    const text = div.firstChild as Text;
    const range = makeRangeFor(text, 0, 4);
    expect(isSupportedSelection(makeSelection(range))).toBe(false);
  });

  it('returns true for a selection inside a <p>', () => {
    const p = document.createElement('p');
    p.textContent = 'hello world';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, 5);
    expect(isSupportedSelection(makeSelection(range))).toBe(true);
  });
});

// snapshotSelection --------------------------------------------------------

describe('snapshotSelection', () => {
  it('returns null when the selection is not supported', () => {
    const p = document.createElement('p');
    p.textContent = 'x';
    document.body.appendChild(p);
    const range = makeRangeFor(p.firstChild as Text, 0, 0);
    expect(snapshotSelection(makeSelection(range))).toBeNull();
  });

  it('captures the selected text verbatim', () => {
    const p = document.createElement('p');
    p.textContent = 'the quick brown fox';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 4, 9); // "quick"
    const snap = snapshotSelection(makeSelection(range));
    expect(snap?.text).toBe('quick');
  });

  it('truncates the prompt-side text to MAX_SELECTION_CHARS', () => {
    const longText = 'a'.repeat(MAX_SELECTION_CHARS + 100);
    const p = document.createElement('p');
    p.textContent = longText;
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, longText.length);
    const snap = snapshotSelection(makeSelection(range));
    expect(snap?.text.length).toBe(MAX_SELECTION_CHARS);
    // Undo anchor preserves the full original text.
    expect(snap?.undoAnchor.originalText.length).toBe(longText.length);
  });

  it('captures before-context up to CONTEXT_CHARS_BEFORE', () => {
    const beforeText = 'b'.repeat(CONTEXT_CHARS_BEFORE + 50);
    const p = document.createElement('p');
    p.textContent = `${beforeText}MIDDLE`;
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, beforeText.length, beforeText.length + 6);
    const snap = snapshotSelection(makeSelection(range));
    expect(snap?.text).toBe('MIDDLE');
    expect(snap?.before.length).toBeLessThanOrEqual(CONTEXT_CHARS_BEFORE);
    expect(snap?.before.endsWith('b')).toBe(true);
  });

  it('captures after-context up to CONTEXT_CHARS_AFTER', () => {
    const afterText = 'c'.repeat(CONTEXT_CHARS_AFTER + 50);
    const p = document.createElement('p');
    p.textContent = `MIDDLE${afterText}`;
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, 6);
    const snap = snapshotSelection(makeSelection(range));
    expect(snap?.text).toBe('MIDDLE');
    expect(snap?.after.length).toBeLessThanOrEqual(CONTEXT_CHARS_AFTER);
    expect(snap?.after.startsWith('c')).toBe(true);
  });

  it('captures undoAnchor.originalText untruncated', () => {
    const p = document.createElement('p');
    p.textContent = 'short selection here';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 6, 15); // "selection"
    const snap = snapshotSelection(makeSelection(range));
    expect(snap?.undoAnchor.originalText).toBe('selection');
  });
});

// decideSnapshot -----------------------------------------------------------

describe('decideSnapshot', () => {
  it('returns {action:"ignore"} when activeEl === inputEl, regardless of selection', () => {
    const inputEl = document.createElement('input');
    document.body.appendChild(inputEl);
    const p = document.createElement('p');
    p.textContent = 'hello world';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, 5);
    const sel = makeSelection(range);
    expect(decideSnapshot({ activeEl: inputEl, inputEl, selection: sel })).toEqual({
      action: 'ignore',
    });
  });

  it('returns {action:"set", snapshot} when activeEl !== inputEl and a selection exists', () => {
    const inputEl = document.createElement('input');
    document.body.appendChild(inputEl);
    const otherEl = document.createElement('div');
    document.body.appendChild(otherEl);
    const p = document.createElement('p');
    p.textContent = 'hello world';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, 5);
    const sel = makeSelection(range);
    const decision = decideSnapshot({ activeEl: otherEl, inputEl, selection: sel });
    expect(decision.action).toBe('set');
    if (decision.action === 'set') {
      expect(decision.snapshot.text).toBe('hello');
    }
  });

  it('returns {action:"clear"} when selection is null and the input is not focused', () => {
    const inputEl = document.createElement('input');
    document.body.appendChild(inputEl);
    expect(decideSnapshot({ activeEl: null, inputEl, selection: null })).toEqual({
      action: 'clear',
    });
    expect(decideSnapshot({ activeEl: document.body, inputEl, selection: null })).toEqual({
      action: 'clear',
    });
  });
});

// buildRewritePrompt -------------------------------------------------------

function makeFakeSnapshot(args: {
  text: string;
  before?: string;
  after?: string;
}): SelectionSnapshot {
  const r = document.createRange();
  return {
    text: args.text,
    before: args.before ?? '',
    after: args.after ?? '',
    range: r,
    undoAnchor: {
      startContainer: document.body,
      startOffset: 0,
      endContainer: document.body,
      endOffset: 0,
      originalText: args.text,
      insertedNode: null,
    },
  };
}

describe('buildRewritePrompt', () => {
  it('includes the instruction, selection, before, and after in order', () => {
    const snap = makeFakeSnapshot({
      text: 'middle',
      before: 'preface',
      after: 'epilogue',
    });
    const prompt = buildRewritePrompt(snap, 'make it crisper', 256);
    expect(prompt).toContain('middle');
    expect(prompt).toContain('preface');
    expect(prompt).toContain('epilogue');
    expect(prompt).toContain('make it crisper');
    // Order: before-context appears before after-context, which appears
    // before the selection-to-rewrite line, which appears before the
    // instruction.
    const idxBefore = prompt.indexOf('preface');
    const idxAfter = prompt.indexOf('epilogue');
    const idxSel = prompt.indexOf('middle');
    const idxInstr = prompt.indexOf('make it crisper');
    expect(idxBefore).toBeLessThan(idxAfter);
    expect(idxAfter).toBeLessThan(idxSel);
    expect(idxSel).toBeLessThan(idxInstr);
  });

  it('mentions the soft-cap token count', () => {
    const snap = makeFakeSnapshot({ text: 'middle' });
    const prompt = buildRewritePrompt(snap, 'tighten', 333);
    expect(prompt).toContain('333');
    expect(prompt.toLowerCase()).toContain('tokens');
  });
});

// buildAskPrompt -----------------------------------------------------------

describe('buildAskPrompt', () => {
  it('quotes the selection and the instruction', () => {
    const snap = makeFakeSnapshot({ text: 'photosynthesis' });
    const prompt = buildAskPrompt(snap, 'what does this mean?');
    expect(prompt).toContain('photosynthesis');
    expect(prompt).toContain('what does this mean?');
  });

  it('does not include the word "rewrite"', () => {
    const snap = makeFakeSnapshot({ text: 'foo' });
    const prompt = buildAskPrompt(snap, 'bar');
    expect(prompt.toLowerCase()).not.toContain('rewrite');
  });
});

// streamRewriteIntoRange ---------------------------------------------------

describe('streamRewriteIntoRange', () => {
  it('deletes the range contents on the first non-empty chunk', () => {
    const p = document.createElement('p');
    p.textContent = 'original text';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, 8); // "original"
    const sel = makeSelection(range);
    const snap = expectSnap(snapshotSelection(sel));
    const rewrite = streamRewriteIntoRange(snap);
    rewrite.applyChunk('NEW');
    expect(p.textContent).toBe('NEW text');
  });

  it('appends subsequent chunks to the same text node', () => {
    const p = document.createElement('p');
    p.textContent = 'ABC';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, 3);
    const snap = expectSnap(snapshotSelection(makeSelection(range)));
    const rewrite = streamRewriteIntoRange(snap);
    rewrite.applyChunk('foo');
    rewrite.applyChunk(' bar');
    rewrite.applyChunk(' baz');
    expect(p.textContent).toBe('foo bar baz');
  });

  it('treats empty leading chunks as no-ops and only deletes on the first non-empty chunk', () => {
    const p = document.createElement('p');
    p.textContent = 'keep this';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, 4); // "keep"
    const snap = expectSnap(snapshotSelection(makeSelection(range)));
    const rewrite = streamRewriteIntoRange(snap);
    rewrite.applyChunk('');
    rewrite.applyChunk('');
    // The range has not been deleted yet — text remains untouched.
    expect(p.textContent).toBe('keep this');
    rewrite.applyChunk('GO');
    expect(p.textContent).toBe('GO this');
  });
});

// undoRewrite --------------------------------------------------------------

describe('undoRewrite', () => {
  it('restores the original text at the range location', () => {
    const p = document.createElement('p');
    p.textContent = 'original text here';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, 8); // "original"
    const snap = expectSnap(snapshotSelection(makeSelection(range)));
    const rewrite = streamRewriteIntoRange(snap);
    rewrite.applyChunk('REWRITTEN');
    expect(p.textContent).toBe('REWRITTEN text here');
    const result = undoRewrite(snap);
    expect(result.ok).toBe(true);
    expect(p.textContent).toBe('original text here');
  });

  it('returns ok:false with reason snapshot detached when the container is removed', () => {
    const p = document.createElement('p');
    p.textContent = 'will be detached';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, 4);
    const snap = expectSnap(snapshotSelection(makeSelection(range)));
    const rewrite = streamRewriteIntoRange(snap);
    rewrite.applyChunk('NEW');
    // Detach the whole paragraph from the document.
    p.remove();
    const result = undoRewrite(snap);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('detached');
  });

  it('returns ok:false with reason already undone on the second call', () => {
    const p = document.createElement('p');
    p.textContent = 'twice undone never twice';
    document.body.appendChild(p);
    const text = p.firstChild as Text;
    const range = makeRangeFor(text, 0, 5); // "twice"
    const snap = expectSnap(snapshotSelection(makeSelection(range)));
    const rewrite = streamRewriteIntoRange(snap);
    rewrite.applyChunk('FOO');
    const first = undoRewrite(snap);
    expect(first.ok).toBe(true);
    const second = undoRewrite(snap);
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('already undone');
  });
});
