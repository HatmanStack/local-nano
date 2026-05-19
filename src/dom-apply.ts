import type { SelectionSnapshot } from './dom-actions.js';

/**
 * Replace the selection captured in `snapshot` with `newText`.
 *
 * Three branches:
 *  - `input`/`textarea`: `setRangeText` with `'end'` selection mode, plus
 *    a synthetic bubbling `input` event so framework-controlled components
 *    (React, Vue) update their state.
 *  - `range` inside a `contentEditable`: `execCommand('insertText')` so
 *    native browser undo works; falls back to `Range` mutation if
 *    `execCommand` is unavailable or returns `false`.
 *  - `range` in read-only prose: `deleteContents()` +
 *    `insertNode(textNode)`. Model output is wrapped in a Text node,
 *    never `innerHTML`, so a `<script>` payload is inert.
 *
 * Returns `true` on success, `false` if the apply could not be performed
 * (e.g. the element was removed from the DOM between snapshot and apply).
 */
export function applyToTarget(snapshot: SelectionSnapshot, newText: string): boolean {
  if (snapshot.kind === 'input') {
    const el = snapshot.element;
    if (!el.isConnected) return false;
    el.setRangeText(newText, snapshot.selectionStart, snapshot.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  // kind === 'range'
  const range = snapshot.range;
  const ce = snapshot.contentEditable;
  if (ce?.isConnected) {
    // Restore the selection to the captured range, then attempt
    // execCommand('insertText'). Restoring is required because clicking
    // the panel clears the original selection.
    const doc = ce.ownerDocument;
    const sel = doc.defaultView?.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = doc.execCommand('insertText', false, newText);
      if (ok) {
        // execCommand returned true; nothing else to do.
        return true;
      }
      // Fall through to Range mutation.
    }
  }
  // Read-only prose OR contentEditable fallback.
  try {
    range.deleteContents();
    const doc = range.startContainer.ownerDocument ?? document;
    const textNode = doc.createTextNode(newText);
    range.insertNode(textNode);
    return true;
  } catch {
    return false;
  }
}
