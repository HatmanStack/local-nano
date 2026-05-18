import { makeTypingIndicator } from './messages.js';
import { BUSY_BG } from './state.js';

/**
 * State machine for the Preview component:
 *  - `pending`: typing indicator visible; Apply disabled.
 *  - `streaming`: chunks have started arriving; Apply still disabled.
 *  - `complete`: stream done; Apply enabled.
 *  - `aborted`: stream stopped by user/discard; Apply disabled; result
 *    pane shows the accumulated text plus a `[stopped]` suffix.
 *  - `error`: terminal error from the transform; Apply disabled; result
 *    pane replaced with the error message.
 *
 * Once a terminal state (`complete`, `aborted`, `error`) is reached, the
 * other terminal transitions are no-ops. Use `reset()` to return to
 * `pending` and clear the streamed text.
 */
export type PreviewState = 'pending' | 'streaming' | 'complete' | 'aborted' | 'error';

export interface PreviewHandle {
  /** Root element to be appended inside the panel. */
  root: HTMLElement;
  /** Replace the original-selection text shown on top. */
  setOriginal(text: string): void;
  /** Append a chunk to the streamed result; transitions state to `streaming`. */
  appendChunk(chunk: string): void;
  /** Transition to `complete`; enable Apply, remove streaming UI. */
  complete(): void;
  /** Transition to `aborted`; disable Apply, append `[stopped]`. */
  abort(): void;
  /** Transition to `error`; disable Apply, replace result with the message. */
  error(message: string): void;
  /** Reset to `pending`. Clears the streamed text and restores indicator. */
  reset(): void;
  /**
   * Disable Apply and surface an error message below the buttons.
   * Used when `applyToTarget` returns `false` (the page-DOM target was
   * removed or mutation threw). The preview stays open so the user can
   * Discard explicitly — calling this on a terminal state is allowed.
   */
  applyFailed(message: string): void;
  /** Remove the Preview root from the DOM. */
  destroy(): void;
  /** Accumulated streamed text (independent of `[stopped]` suffix). */
  getResultText(): string;
}

export interface PreviewCallbacks {
  onApply(): void;
  onDiscard(): void;
}

const APPLY_BG_ENABLED = '#1f8a3a';
const APPLY_BG_DISABLED = '#555';

export function makePreview(callbacks: PreviewCallbacks, doc: Document = document): PreviewHandle {
  let state: PreviewState = 'pending';
  let resultText = '';

  const root = doc.createElement('div');
  root.style.cssText = `
    display: flex; flex-direction: column;
    flex: 1; gap: 8px; padding: 10px;
    background: #222; overflow: hidden;
    outline: none;
  `;
  // tabindex so the root receives focus and the Escape keydown fires.
  root.tabIndex = -1;

  const originalHeader = doc.createElement('div');
  originalHeader.textContent = 'Original';
  originalHeader.style.cssText = 'color: #888; font-size: 12px;';

  const originalPane = doc.createElement('div');
  originalPane.dataset.pane = 'original';
  originalPane.style.cssText = `
    background: #1a1a1a; color: #ddd; padding: 6px;
    border-radius: 4px; max-height: 120px; overflow-y: auto;
    white-space: pre-wrap; overflow-wrap: anywhere;
  `;

  const resultHeader = doc.createElement('div');
  resultHeader.textContent = 'Result';
  resultHeader.style.cssText = 'color: #888; font-size: 12px;';

  const resultPane = doc.createElement('div');
  resultPane.dataset.pane = 'result';
  resultPane.style.cssText = `
    background: #1a1a1a; color: #eee; padding: 6px;
    border-radius: 4px; flex: 1; overflow-y: auto;
    white-space: pre-wrap; overflow-wrap: anywhere;
    min-height: 80px;
  `;

  // Start with a typing indicator inside the result pane.
  let indicator: HTMLElement | null = makeTypingIndicator(doc);
  resultPane.appendChild(indicator);

  const buttonRow = doc.createElement('div');
  buttonRow.style.cssText = `
    display: flex; justify-content: flex-end; gap: 8px;
  `;

  const discardBtn = doc.createElement('button');
  discardBtn.dataset.action = 'discard';
  discardBtn.textContent = 'Discard';
  discardBtn.style.cssText = `
    background: ${BUSY_BG}; color: #fff; border: none;
    border-radius: 4px; padding: 6px 12px; cursor: pointer;
    font: inherit; font-weight: 600;
  `;

  const applyBtn = doc.createElement('button');
  applyBtn.dataset.action = 'apply';
  applyBtn.textContent = 'Apply';
  applyBtn.disabled = true;
  applyBtn.style.cssText = `
    background: ${APPLY_BG_DISABLED}; color: #fff; border: none;
    border-radius: 4px; padding: 6px 12px;
    font: inherit; font-weight: 600;
  `;

  buttonRow.append(discardBtn, applyBtn);

  // Status line for post-Apply failures (e.g. the page DOM target was
  // removed between snapshot and Apply). Hidden by default.
  const status = doc.createElement('div');
  status.dataset.role = 'apply-status';
  status.style.cssText = 'color: #f88; font-size: 12px; min-height: 0;';

  root.append(originalHeader, originalPane, resultHeader, resultPane, buttonRow, status);

  function setApplyEnabled(enabled: boolean): void {
    applyBtn.disabled = !enabled;
    applyBtn.style.background = enabled ? APPLY_BG_ENABLED : APPLY_BG_DISABLED;
    applyBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
  }

  function removeIndicator(): void {
    if (indicator?.parentNode) indicator.remove();
    indicator = null;
  }

  function renderResult(): void {
    // Always render via textContent — model output is untrusted.
    resultPane.textContent = resultText;
  }

  function isTerminal(): boolean {
    return state === 'complete' || state === 'aborted' || state === 'error';
  }

  applyBtn.addEventListener('click', () => {
    if (applyBtn.disabled) return;
    callbacks.onApply();
  });
  discardBtn.addEventListener('click', () => {
    callbacks.onDiscard();
  });
  root.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      callbacks.onDiscard();
    }
  });

  return {
    root,
    setOriginal(text: string): void {
      originalPane.textContent = text;
    },
    appendChunk(chunk: string): void {
      // Ignore chunks that arrive after a terminal state — the stream
      // should be aborted by then; this is a defensive guard.
      if (isTerminal()) return;
      if (state === 'pending') {
        state = 'streaming';
        removeIndicator();
      }
      resultText += chunk;
      renderResult();
    },
    complete(): void {
      if (isTerminal()) return;
      state = 'complete';
      removeIndicator();
      renderResult();
      setApplyEnabled(true);
    },
    abort(): void {
      if (isTerminal()) return;
      state = 'aborted';
      removeIndicator();
      const suffix = resultText.length === 0 ? '[stopped]' : '\n\n[stopped]';
      resultPane.textContent = resultText + suffix;
      setApplyEnabled(false);
    },
    error(message: string): void {
      if (isTerminal()) return;
      state = 'error';
      removeIndicator();
      resultPane.textContent = message;
      setApplyEnabled(false);
    },
    reset(): void {
      state = 'pending';
      resultText = '';
      resultPane.textContent = '';
      indicator = makeTypingIndicator(doc);
      resultPane.appendChild(indicator);
      setApplyEnabled(false);
    },
    applyFailed(message: string): void {
      // Allowed from terminal states (Apply is only clickable when
      // `complete`). Do not change the state machine — just surface the
      // failure and lock Apply so the user must Discard.
      status.textContent = message;
      setApplyEnabled(false);
    },
    destroy(): void {
      if (root.parentNode) root.parentNode.removeChild(root);
    },
    getResultText(): string {
      return resultText;
    },
  };
}
