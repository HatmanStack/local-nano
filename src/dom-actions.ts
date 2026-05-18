/**
 * v0.2 DOM-aware actions: selection capture and action dispatch.
 *
 * Two responsibilities:
 *  - `captureSelection(doc)`: synchronous snapshot of the current
 *    selection. Called from a `contextmenu` (or hotkey `keydown`)
 *    listener before the panel steals focus.
 *  - `initDomActions(deps)`: install the listeners and dispatch
 *    `ActionMessage`s into the right handler (chat prefill, page-chat
 *    send, or transform-Preview flow).
 */

import { ACTION_MESSAGE_KIND, type ActionMessage } from './background/handler.js';
import { applyToTarget } from './dom-apply.js';
import type { SessionHandle } from './session.js';
import { runTransform } from './transform.js';
import {
  type ActionId,
  actionToDescriptor,
  checkSelection,
  selectionChatPrefill,
} from './transform-prompts.js';
import { makePreview, type PreviewHandle } from './ui/preview.js';

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

/**
 * Dependencies for `initDomActions`. `transformersConfig` is the same
 * value passed to `initSession` — both consumers share the memoized
 * `loadHeavy()` cache, so the heavy modules are instantiated once per
 * page lifetime.
 */
export interface DomActionsDeps {
  document: Document;
  session: SessionHandle;
  transformersConfig: unknown;
}

/**
 * Install the contextmenu/keydown selection-capture listeners and the
 * `chrome.runtime.onMessage` action dispatcher.
 *
 * Snapshot is overwritten on every contextmenu/modifier-keydown — the
 * most recent selection wins. Snapshots live in a module-local slot so
 * the panel taking focus does not clear them.
 *
 * Dispatch behavior per `ActionKind`:
 *  - `chat`: package the selection into the chat input via
 *    `prefillAndSend(text, false)`. The user adds their question and
 *    presses Enter.
 *  - `page-chat`: prefill `'Summarize this page.'` and trigger send.
 *  - `transform-editable` / `transform-readonly`: mount a Preview,
 *    stream `runTransform` into it; Apply replaces the selection on the
 *    page DOM, Discard tears down without mutating.
 *
 * Only one transform may run at a time: dispatching a new transform
 * aborts the in-flight one before starting the new one.
 */
export function initDomActions(deps: DomActionsDeps): void {
  const { document: doc, session, transformersConfig } = deps;

  // Module-local pending snapshot, captured at contextmenu / hotkey time.
  let pendingSnapshot: SelectionSnapshot | null = null;

  // Track the active Preview + its abort + its teardown so a new action
  // can replace it (one transform at a time).
  let activeAbort: AbortController | null = null;
  let activePreviewTeardown: (() => void) | null = null;

  const captureToPending = () => {
    pendingSnapshot = captureSelection(doc);
  };

  doc.addEventListener('contextmenu', captureToPending, true);
  doc.addEventListener(
    'keydown',
    (e: Event) => {
      // Snapshot eagerly on any modifier+key combo that might map to our
      // hotkeys. Chrome delivers the actual command via chrome.commands;
      // this just ensures the selection is captured before the panel
      // takes focus.
      const k = e as KeyboardEvent;
      if (k.ctrlKey || k.metaKey) captureToPending();
    },
    true,
  );

  function tearDownPreview(): void {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    if (activePreviewTeardown) {
      activePreviewTeardown();
      activePreviewTeardown = null;
    }
  }

  async function runTransformAction(
    actionId: ActionId,
    snapshot: SelectionSnapshot,
  ): Promise<void> {
    const check = checkSelection(snapshot.text);
    session.openPanel();
    const preview: PreviewHandle = makePreview(
      {
        onApply: () => {
          const text = preview.getResultText();
          applyToTarget(snapshot, text);
          tearDownPreview();
        },
        onDiscard: () => {
          tearDownPreview();
        },
      },
      doc,
    );
    preview.setOriginal(snapshot.text);
    const teardown = session.mountPreview(preview.root);
    activePreviewTeardown = () => {
      teardown();
      preview.destroy();
    };

    if (!check.ok) {
      preview.error(check.error ?? 'Selection unavailable.');
      return;
    }

    const abort = new AbortController();
    activeAbort = abort;
    try {
      const { stream } = await runTransform({
        action: actionId,
        sourceText: snapshot.text,
        signal: abort.signal,
        transformersConfig,
      });
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) preview.appendChunk(value);
        }
        preview.complete();
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Stream already errored — releaseLock can throw.
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        preview.abort();
      } else {
        preview.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (activeAbort === abort) activeAbort = null;
    }
  }

  function dispatchAction(actionId: ActionId): void {
    const descriptor = actionToDescriptor(actionId);
    switch (descriptor.kind) {
      case 'chat': {
        const snap = pendingSnapshot;
        if (!snap || !checkSelection(snap.text).ok) {
          // No selection or too long — open the panel for graceful
          // degradation; do not prefill.
          session.openPanel();
          return;
        }
        session.openPanel();
        session.prefillAndSend(selectionChatPrefill(snap.text), false);
        return;
      }
      case 'page-chat': {
        session.openPanel();
        session.prefillAndSend('Summarize this page.', true);
        return;
      }
      case 'transform-editable':
      case 'transform-readonly': {
        const snap = pendingSnapshot;
        if (!snap) {
          session.openPanel();
          return;
        }
        if (descriptor.kind === 'transform-editable') {
          const isEditable =
            snap.kind === 'input' || (snap.kind === 'range' && snap.contentEditable !== null);
          if (!isEditable) {
            session.openPanel();
            return;
          }
        }
        // Tear down any previous preview/transform before starting a new one.
        tearDownPreview();
        void runTransformAction(actionId, snap);
        return;
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg: unknown) => {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Partial<ActionMessage>;
    if (m.a !== ACTION_MESSAGE_KIND) return;
    if (typeof m.id !== 'string') return;
    try {
      dispatchAction(m.id as ActionId);
    } catch (err) {
      console.error('[local-nano] dispatchAction failed:', err);
    }
  });
}
