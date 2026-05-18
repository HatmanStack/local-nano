/**
 * v0.2 DOM-aware actions: selection capture and (later) action dispatch.
 *
 * This module is split across two phase tasks:
 *  - Task 3.1 (this commit): selection snapshot types and
 *    `captureSelection`. The capture is synchronous so it can run from a
 *    `contextmenu` listener before the panel steals focus.
 *  - Task 3.5: `initDomActions(deps)` which installs the listeners and
 *    dispatches incoming `ActionMessage`s.
 */

/** Snapshot for a regular DOM selection (anywhere outside of <input>/<textarea>). */
export interface RangeSnapshot {
  kind: 'range';
  range: Range;
  text: string;
  /**
   * If the selection sits inside a contentEditable, this is that element
   * (used by the apply layer to prefer `execCommand('insertText')`). Null
   * otherwise.
   */
  contentEditable: HTMLElement | null;
}

/** Snapshot for an `<input>` or `<textarea>` selection. */
export interface InputSnapshot {
  kind: 'input';
  element: HTMLInputElement | HTMLTextAreaElement;
  selectionStart: number;
  selectionEnd: number;
  text: string;
}

export type SelectionSnapshot = RangeSnapshot | InputSnapshot;

/**
 * Capture the current selection. Call from a `contextmenu` listener (or
 * the hotkey `keydown` handler) BEFORE the panel steals focus.
 *
 * Returns `null` if there is no usable selection. Two branches:
 *  - active element is `<input>`/`<textarea>` with a non-empty selection
 *    → returns an `InputSnapshot`;
 *  - otherwise reads `window.getSelection()` and clones the first range
 *    → returns a `RangeSnapshot`.
 */
export function captureSelection(doc: Document): SelectionSnapshot | null {
  const active = doc.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (start != null && end != null && start !== end) {
      return {
        kind: 'input',
        element: active,
        selectionStart: start,
        selectionEnd: end,
        text: active.value.slice(start, end),
      };
    }
  }
  const sel = doc.defaultView?.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0).cloneRange();
  const text = sel.toString();
  if (text.length === 0) return null;
  // Find an ancestor contentEditable for the apply hint. Real browsers
  // expose this via the `isContentEditable` IDL property; jsdom does not
  // implement it, so fall back to the `contenteditable` attribute. The
  // attribute lookup also catches host pages that set
  // `contenteditable="true"` on a wrapper without inheritance.
  let ce: HTMLElement | null = null;
  let node: Node | null = range.commonAncestorContainer;
  while (node) {
    if (node instanceof HTMLElement) {
      const isCe =
        node.isContentEditable === true ||
        node.getAttribute('contenteditable') === 'true' ||
        node.getAttribute('contenteditable') === '';
      if (isCe) {
        ce = node;
        break;
      }
    }
    node = node.parentNode;
  }
  return { kind: 'range', range, text, contentEditable: ce };
}
