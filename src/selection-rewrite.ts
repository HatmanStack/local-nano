/**
 * Selection-driven in-place rewrite.
 *
 * Owns the snapshot type, the prompt builders, the in-place streaming DOM
 * mutation, and single-level undo. The module has no dependency on the
 * polyfill or `LanguageModel`; the chat session feeds it chunks and asks
 * it to mutate the captured Range.
 *
 * Constraints inherited from the v0.2.0 post-mortem:
 *
 * - Single offscreen `LanguageModel` session for chat and transforms (this
 *   module never calls `LanguageModel.create`).
 * - Selection payload bounded at `MAX_SELECTION_CHARS` (selection plus
 *   `CONTEXT_CHARS_BEFORE` / `CONTEXT_CHARS_AFTER` of context).
 * - Soft output cap derived from a real input token count; the polyfill's
 *   2048-token `max_new_tokens` ceiling is unchanged.
 */

export const MIN_OUTPUT_TOKENS = 256;
export const MAX_OUTPUT_MULTIPLIER = 2;
export const CONTEXT_CHARS_BEFORE = 200;
export const CONTEXT_CHARS_AFTER = 200;
export const MAX_SELECTION_CHARS = 700;

export const TRANSFORM_SYSTEM_HINT =
  'You are rewriting a piece of text in place. Respond with only the rewritten text. No commentary, no quotes, no preamble. Match the style of the surrounding context.';

export interface SelectionSnapshot {
  /** Selected text, truncated to MAX_SELECTION_CHARS for the prompt. */
  text: string;
  /** Up to CONTEXT_CHARS_BEFORE chars of surrounding text before the selection. */
  before: string;
  /** Up to CONTEXT_CHARS_AFTER chars of surrounding text after the selection. */
  after: string;
  /** Live range; the in-place stream writes to this. */
  range: Range;
  /** Coordinates used for undo. */
  undoAnchor: {
    startContainer: Node;
    startOffset: number;
    endContainer: Node;
    endOffset: number;
    /** Untruncated original selection text — undo must restore exactly this. */
    originalText: string;
    /**
     * Set by `streamRewriteIntoRange` on the first chunk. Undo replaces
     * this node's data with `originalText`. Null until the first non-
     * empty chunk arrives.
     */
    insertedNode: Text | null;
  };
}

// Internal state for undo tracking.
const undoneSnapshots = new WeakSet<SelectionSnapshot>();

function isInsideExcludedAncestor(node: Node | null): boolean {
  let cur: Node | null = node;
  while (cur) {
    if (cur.nodeType === 1) {
      const el = cur as Element;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      const html = el as HTMLElement;
      // `isContentEditable` is the canonical check (browsers); jsdom does
      // not implement that getter, so fall back to the attribute and the
      // `contentEditable` IDL property.
      if (html.isContentEditable === true) return true;
      const ce = html.contentEditable;
      if (typeof ce === 'string' && ce && ce !== 'false' && ce !== 'inherit') return true;
      const attr = el.getAttribute('contenteditable');
      if (attr && attr !== 'false' && attr !== 'inherit') return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

/**
 * A selection is supported when it is non-null, has exactly one range, is
 * not collapsed, contains at least one non-whitespace character, and is
 * not inside an `<input>`, `<textarea>`, or `contenteditable` ancestor.
 */
export function isSupportedSelection(sel: Selection | null): boolean {
  if (!sel) return false;
  if (sel.rangeCount !== 1) return false;
  if (sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return false;
  const text = range.toString();
  if (!text.trim()) return false;
  const container = range.commonAncestorContainer;
  const probe = container.nodeType === 1 ? container : container.parentNode;
  if (isInsideExcludedAncestor(probe)) return false;
  return true;
}

/**
 * Walk text nodes backwards from `endNode/endOffset` and collect up to
 * `budget` chars, returned in document order.
 */
function collectBeforeContext(
  root: Node,
  endNode: Node,
  endOffset: number,
  budget: number,
): string {
  const ownerDoc = endNode.ownerDocument ?? document;
  const walker = ownerDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const pieces: string[] = [];
  let remaining = budget;
  let reached = false;
  let lastFromEnd = '';
  // Collect all text nodes up to and including endNode.
  const nodes: Text[] = [];
  let n: Node | null = walker.nextNode();
  while (n) {
    nodes.push(n as Text);
    if (n === endNode) {
      reached = true;
      break;
    }
    n = walker.nextNode();
  }
  if (!reached) {
    // endNode is not a text node under root; fall back to no context.
    return '';
  }
  // Walk nodes in reverse to gather up to `budget` chars.
  for (let i = nodes.length - 1; i >= 0 && remaining > 0; i--) {
    const node = nodes[i];
    let content: string;
    if (i === nodes.length - 1) {
      // Last node — only take up to endOffset.
      content = node.data.slice(0, endOffset);
      lastFromEnd = content;
    } else {
      content = node.data;
    }
    if (content.length <= remaining) {
      pieces.unshift(content);
      remaining -= content.length;
    } else {
      pieces.unshift(content.slice(content.length - remaining));
      remaining = 0;
    }
  }
  // Silence unused-var lint for the intermediate variable.
  void lastFromEnd;
  return pieces.join('');
}

/**
 * Walk text nodes forwards from `startNode/startOffset` and collect up to
 * `budget` chars in document order.
 */
function collectAfterContext(
  root: Node,
  startNode: Node,
  startOffset: number,
  budget: number,
): string {
  const ownerDoc = startNode.ownerDocument ?? document;
  const walker = ownerDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const pieces: string[] = [];
  let remaining = budget;
  let started = false;
  let n: Node | null = walker.nextNode();
  while (n && remaining > 0) {
    const text = n as Text;
    if (!started) {
      if (text === startNode) {
        started = true;
        const content = text.data.slice(startOffset);
        if (content.length <= remaining) {
          pieces.push(content);
          remaining -= content.length;
        } else {
          pieces.push(content.slice(0, remaining));
          remaining = 0;
        }
      }
    } else {
      if (text.data.length <= remaining) {
        pieces.push(text.data);
        remaining -= text.data.length;
      } else {
        pieces.push(text.data.slice(0, remaining));
        remaining = 0;
      }
    }
    n = walker.nextNode();
  }
  return pieces.join('');
}

function nearestBlockAncestor(node: Node): Node {
  let cur: Node | null = node;
  while (cur) {
    if (cur.nodeType === 1) {
      const el = cur as Element;
      const tag = el.tagName;
      if (
        tag === 'P' ||
        tag === 'DIV' ||
        tag === 'LI' ||
        tag === 'BLOCKQUOTE' ||
        tag === 'ARTICLE' ||
        tag === 'SECTION' ||
        tag === 'MAIN' ||
        tag === 'BODY' ||
        tag === 'H1' ||
        tag === 'H2' ||
        tag === 'H3' ||
        tag === 'H4' ||
        tag === 'H5' ||
        tag === 'H6'
      ) {
        return cur;
      }
    }
    cur = cur.parentNode;
  }
  return node.ownerDocument?.body ?? node;
}

/**
 * Build a SelectionSnapshot from a live Selection. Returns null for
 * unsupported selections.
 */
export function snapshotSelection(sel: Selection): SelectionSnapshot | null {
  if (!isSupportedSelection(sel)) return null;
  const range = sel.getRangeAt(0).cloneRange();
  const fullText = range.toString();
  const truncated =
    fullText.length > MAX_SELECTION_CHARS ? fullText.slice(0, MAX_SELECTION_CHARS) : fullText;

  const root = nearestBlockAncestor(range.commonAncestorContainer);
  const before = collectBeforeContext(
    root,
    range.startContainer,
    range.startOffset,
    CONTEXT_CHARS_BEFORE,
  );
  const after = collectAfterContext(root, range.endContainer, range.endOffset, CONTEXT_CHARS_AFTER);

  return {
    text: truncated,
    before,
    after,
    range,
    undoAnchor: {
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
      originalText: fullText,
      insertedNode: null,
    },
  };
}

/**
 * Pure function wrapping ADR-007's input-focus suppression rule. Returns
 * null when the chat input is focused (so a `selectionchange` fired from
 * the focus shift does not clobber the previously captured snapshot);
 * otherwise delegates to `snapshotSelection`.
 */
export function decideSnapshot(args: {
  activeEl: Element | null;
  inputEl: Element;
  selection: Selection | null;
}): SelectionSnapshot | null {
  if (args.activeEl === args.inputEl) return null;
  if (!args.selection) return null;
  return snapshotSelection(args.selection);
}

/**
 * Construct the rewrite prompt. The exact wording is fixed; do not
 * paraphrase. The soft-cap token count is substituted in plain text; the
 * model treats it as guidance, not a hard limit.
 */
export function buildRewritePrompt(
  snap: SelectionSnapshot,
  instruction: string,
  softCapTokens: number,
): string {
  return `${TRANSFORM_SYSTEM_HINT} Aim for roughly ${softCapTokens} tokens.

Context before the selection:
${snap.before.trim()}

Context after the selection:
${snap.after.trim()}

Selection to rewrite:
${snap.text}

Instruction:
${instruction}`;
}

/**
 * Construct the Ask-about-selection prompt. Does not mutate the DOM; the
 * caller routes the result through the normal chat bubble flow.
 */
export function buildAskPrompt(snap: SelectionSnapshot, instruction: string): string {
  return `The user has selected this text on the page:
${snap.text}

Their question:
${instruction}

Answer concisely. Do not change the text; just answer.`;
}

/**
 * Stream tokens directly into the captured Range. On the first non-empty
 * chunk, the range's contents are deleted and replaced with a single
 * empty text node; subsequent chunks append to that node.
 */
export function streamRewriteIntoRange(snap: SelectionSnapshot): {
  applyChunk: (chunk: string) => void;
  finalize: () => void;
} {
  function applyChunk(chunk: string): void {
    if (!chunk) return;
    let target = snap.undoAnchor.insertedNode;
    if (!target) {
      snap.range.deleteContents();
      const ownerDoc = snap.range.startContainer.ownerDocument ?? document;
      const node = ownerDoc.createTextNode('');
      snap.range.insertNode(node);
      snap.undoAnchor.insertedNode = node;
      target = node;
    }
    target.data += chunk;
  }

  function finalize(): void {
    // Reserved for future commit-or-rollback behaviour; today a no-op.
  }

  return { applyChunk, finalize };
}

/**
 * Restore the original text at the snapshot's anchor coordinates. Returns
 * `{ ok: true }` on success. Returns `{ ok: false, reason }` when the
 * snapshot containers have been detached, when a DOM exception is thrown,
 * or when the snapshot has already been undone.
 */
export function undoRewrite(snap: SelectionSnapshot): { ok: boolean; reason?: string } {
  if (undoneSnapshots.has(snap)) {
    return { ok: false, reason: 'already undone' };
  }
  const inserted = snap.undoAnchor.insertedNode;
  const { originalText } = snap.undoAnchor;
  if (!inserted) {
    // No rewrite was committed; nothing to undo.
    return { ok: false, reason: 'no rewrite to undo' };
  }
  if (!inserted.isConnected) {
    return { ok: false, reason: 'snapshot detached' };
  }
  try {
    inserted.data = originalText;
    undoneSnapshots.add(snap);
    return { ok: true };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}
