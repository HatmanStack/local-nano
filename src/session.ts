import { TOGGLE_MESSAGE } from './background/handler.js';
import {
  type Entry,
  loadHistory as loadHistoryFromStorage,
  MAX_HISTORY,
  type Role,
  saveHistory as saveHistoryToStorage,
  storageKey,
} from './history.js';
import { countTokens, rebuildSession, streamPrompt } from './offscreen/client.js';
import { pageContext } from './pageContext.js';
import {
  buildAskPrompt,
  buildRewritePrompt,
  MAX_OUTPUT_MULTIPLIER,
  MIN_OUTPUT_TOKENS,
  type SelectionSnapshot,
  streamRewriteIntoRange,
  undoRewrite,
} from './selection-rewrite.js';
import { makeTypingIndicator, renderMessage } from './ui/messages.js';
import { setGeneratingState, setIdleState } from './ui/state.js';

/**
 * Recognize the explicit failure offscreen.ts raises when the polyfill
 * stream closes with zero chunks — typically caused by WebGPU device
 * loss after the user switches tabs/windows. Matched on the message
 * string because the polyfill swallows the underlying ORT error and the
 * offscreen layer surfaces a sentinel string instead.
 */
function isDeviceLossError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'AbortError') return false;
  const message = err instanceof Error ? err.message : '';
  return message.includes('WebGPU device loss') || message.includes('Model returned no output');
}

const PLACEHOLDER_CHAT = 'Ask anything about this page (Enter)';
const PLACEHOLDER_EDIT = 'Edit selection… (Esc to switch to Ask)';
const PLACEHOLDER_ASK = 'Ask about selection… (Esc to switch back to Edit)';
const CHIP_MAX_CHARS = 60;

/**
 * DOM elements and values that content.ts provides at injection time.
 * session.ts does not touch document directly.
 */
export interface SessionDeps {
  root: HTMLElement;
  messages: HTMLElement;
  input: HTMLInputElement;
  actionBtn: HTMLButtonElement;
  /**
   * Compact chip element above the input showing a preview of the
   * current selection. Owned by content.ts; the session manages content
   * and visibility.
   */
  selectionChip: HTMLElement;
  /**
   * Register a callback for selection-change events. content.ts wires
   * `document.addEventListener('selectionchange', …)` and forwards
   * `decideSnapshot(...)` results here. Snapshot may be null when no
   * supported selection exists.
   */
  onSelectionChange: (cb: (snap: SelectionSnapshot | null) => void) => void;
  location: Pick<Location, 'origin' | 'pathname' | 'href'>;
  document: Pick<Document, 'title'> & { body: { innerText: string } };
}

export function initSession(deps: SessionDeps): void {
  const {
    root,
    messages,
    input: i,
    actionBtn,
    selectionChip,
    onSelectionChange,
    location,
    document,
  } = deps;
  const STORAGE_KEY = storageKey(location);

  // ---- History ----
  let history: Entry[] = [];

  // Keep the in-memory array bounded so a long session doesn't grow it
  // without limit. Storage is already capped in saveHistory, but the
  // in-memory copy can outlive any single persist call.
  function pushEntry(entry: Entry) {
    history.push(entry);
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
  }

  function persist() {
    saveHistoryToStorage(STORAGE_KEY, history).catch((err: unknown) => {
      console.error('[local-nano] history write failed:', err);
    });
  }

  async function restore(): Promise<void> {
    const loaded = await loadHistoryFromStorage(STORAGE_KEY);
    history = loaded.length > MAX_HISTORY ? loaded.slice(-MAX_HISTORY) : loaded;
    for (const entry of history) renderMessage(messages, entry.role, entry.text);
  }

  function addMessage(role: Role, text: string): HTMLElement {
    const el = renderMessage(messages, role, text);
    if (role !== 'system') {
      pushEntry({ role, text });
      persist();
    }
    return el;
  }

  // ---- Selection state ----
  let currentSelection: SelectionSnapshot | null = null;
  let askMode = false;

  function updatePlaceholder(): void {
    if (!currentSelection) {
      i.placeholder = PLACEHOLDER_CHAT;
      return;
    }
    i.placeholder = askMode ? PLACEHOLDER_ASK : PLACEHOLDER_EDIT;
  }

  function updateChip(): void {
    if (!currentSelection) {
      selectionChip.style.display = 'none';
      selectionChip.textContent = '';
      return;
    }
    const preview =
      currentSelection.text.length > CHIP_MAX_CHARS
        ? `${currentSelection.text.slice(0, CHIP_MAX_CHARS)}…`
        : currentSelection.text;
    selectionChip.textContent = preview;
    selectionChip.style.display = 'block';
  }

  onSelectionChange((snap) => {
    currentSelection = snap;
    if (!snap) askMode = false;
    updatePlaceholder();
    updateChip();
  });

  // ---- Send / Stop ----
  // NOTE(isFirstTurn): This flag isn't reset after restore() re-renders
  // prior history. The restored messages are displayed in the UI but the
  // offscreen session has no knowledge of them (it holds a single
  // long-lived context across tabs/URLs). The page-context prefix is only
  // applied on the very first user turn of the lifetime of this content
  // script. Cross-URL chat continuity needs a follow-up.
  let isFirstTurn = true;
  let activeAbort: AbortController | null = null;

  function attachUndoButton(modelBubble: HTMLElement, snap: SelectionSnapshot): void {
    const btn = window.document.createElement('button');
    btn.textContent = 'Undo';
    btn.style.cssText =
      'margin-top: 4px; padding: 2px 8px; font: inherit; cursor: pointer; background: #444; color: #eee; border: 1px solid #666; border-radius: 4px;';
    btn.addEventListener('click', () => {
      const result = undoRewrite(snap);
      btn.disabled = true;
      if (result.ok) {
        btn.textContent = 'Undone';
        console.log('[local-nano] undo: restored original selection');
      } else {
        btn.textContent = 'Undo failed';
        console.warn(`[local-nano] undo failed: ${result.reason ?? 'unknown'}`);
      }
    });
    modelBubble.appendChild(window.document.createElement('br'));
    modelBubble.appendChild(btn);
  }

  async function sendChat(text: string): Promise<void> {
    addMessage('user', text);
    const wasFirstTurn = isFirstTurn;
    const firstTurnHint = wasFirstTurn
      ? addMessage('system', 'Loading model… first response can take up to a minute.')
      : null;
    const responseEl = renderMessage(messages, 'model', '');
    const indicator = makeTypingIndicator();
    responseEl.appendChild(indicator);
    const prompt = isFirstTurn ? `${pageContext(document, location)}\n\n---\n\n${text}` : text;
    isFirstTurn = false;

    activeAbort = new AbortController();
    setGeneratingState(actionBtn, i);

    let modelText = '';
    let firstChunk = true;
    let rebuildHint: HTMLElement | null = null;
    const t0 = performance.now();
    const onChunk = (chunk: string) => {
      if (firstChunk) {
        console.log(`[local-nano] first token at ${(performance.now() - t0).toFixed(0)}ms`);
        if (firstTurnHint?.parentNode) firstTurnHint.remove();
        if (rebuildHint?.parentNode) rebuildHint.remove();
        responseEl.textContent = '';
        firstChunk = false;
      }
      modelText += chunk;
      responseEl.textContent = modelText;
      messages.scrollTop = messages.scrollHeight;
    };
    try {
      try {
        await streamPrompt(prompt, { signal: activeAbort.signal, onChunk });
      } catch (err) {
        if (!isDeviceLossError(err) || activeAbort.signal.aborted) throw err;
        rebuildHint = addMessage('system', 'GPU device lost — restoring session and retrying…');
        modelText = '';
        firstChunk = true;
        const historyForReseed = history
          .slice(0, -1)
          .filter(
            (entry): entry is { role: 'user' | 'model'; text: string } => entry.role !== 'system',
          );
        await rebuildSession(historyForReseed);
        await streamPrompt(text, { signal: activeAbort.signal, onChunk });
      }
      console.log(
        `[local-nano] stream done in ${(performance.now() - t0).toFixed(0)}ms, chars=${modelText.length}, prompt.length=${prompt.length}`,
      );
    } catch (err: unknown) {
      const name = (err as { name?: unknown })?.name;
      if (name === 'AbortError') {
        modelText = modelText + (modelText ? '\n\n[stopped]' : '[stopped]');
        responseEl.textContent = modelText;
      } else {
        modelText = err instanceof Error ? err.message : String(err);
        responseEl.textContent = modelText;
      }
    } finally {
      if (indicator.parentNode) indicator.remove();
      if (firstTurnHint?.parentNode) firstTurnHint.remove();
      if (rebuildHint?.parentNode) rebuildHint.remove();
      if (!modelText) {
        responseEl.textContent = '(no response — the model returned an empty answer)';
      }
      if (modelText) {
        pushEntry({ role: 'model', text: modelText });
        persist();
      }
      setIdleState(actionBtn, i);
      activeAbort = null;
      i.focus();
    }
  }

  async function sendAsk(instruction: string, snap: SelectionSnapshot): Promise<void> {
    addMessage('user', instruction);
    const responseEl = renderMessage(messages, 'model', '');
    const indicator = makeTypingIndicator();
    responseEl.appendChild(indicator);
    const prompt = buildAskPrompt(snap, instruction);

    activeAbort = new AbortController();
    setGeneratingState(actionBtn, i);

    let modelText = '';
    let firstChunk = true;
    const onChunk = (chunk: string) => {
      if (firstChunk) {
        responseEl.textContent = '';
        firstChunk = false;
      }
      modelText += chunk;
      responseEl.textContent = modelText;
      messages.scrollTop = messages.scrollHeight;
    };
    try {
      await streamPrompt(prompt, { signal: activeAbort.signal, onChunk });
    } catch (err: unknown) {
      const name = (err as { name?: unknown })?.name;
      if (name === 'AbortError') {
        modelText = modelText + (modelText ? '\n\n[stopped]' : '[stopped]');
        responseEl.textContent = modelText;
      } else {
        modelText = err instanceof Error ? err.message : String(err);
        responseEl.textContent = modelText;
      }
    } finally {
      if (indicator.parentNode) indicator.remove();
      if (!modelText) {
        responseEl.textContent = '(no response — the model returned an empty answer)';
      }
      if (modelText) {
        pushEntry({ role: 'model', text: modelText });
        persist();
      }
      setIdleState(actionBtn, i);
      activeAbort = null;
      // Ask mode is one-shot; reset to Edit for the next turn if the
      // selection is still active.
      askMode = false;
      updatePlaceholder();
      i.focus();
    }
  }

  async function sendRewrite(instruction: string, snap: SelectionSnapshot): Promise<void> {
    // Compute the soft cap from the *content* payload, not the framed
    // prompt — the framed prompt embeds the cap number, so counting that
    // would be chicken-and-egg. The framing is short and constant; the
    // delta is well inside the soft cap's margin.
    const payload = `${snap.before}\n${snap.text}\n${snap.after}\n${instruction}`;
    const inputTokens = await countTokens(payload);
    const softCap = Math.max(MIN_OUTPUT_TOKENS, inputTokens * MAX_OUTPUT_MULTIPLIER);
    const prompt = buildRewritePrompt(snap, instruction, softCap);

    addMessage('user', instruction);
    const responseEl = renderMessage(messages, 'model', '');
    const indicator = makeTypingIndicator();
    responseEl.appendChild(indicator);

    activeAbort = new AbortController();
    setGeneratingState(actionBtn, i);

    const rewrite = streamRewriteIntoRange(snap);
    let modelText = '';
    let firstChunk = true;
    let succeeded = false;
    const onChunk = (chunk: string) => {
      if (firstChunk) {
        responseEl.textContent = '';
        firstChunk = false;
      }
      rewrite.applyChunk(chunk);
      modelText += chunk;
      responseEl.textContent = modelText;
      messages.scrollTop = messages.scrollHeight;
    };
    try {
      try {
        await streamPrompt(prompt, { signal: activeAbort.signal, onChunk });
      } catch (err) {
        if (!isDeviceLossError(err) || activeAbort.signal.aborted) throw err;
        modelText = '';
        firstChunk = true;
        const historyForReseed = history
          .slice(0, -1)
          .filter(
            (entry): entry is { role: 'user' | 'model'; text: string } => entry.role !== 'system',
          );
        await rebuildSession(historyForReseed);
        await streamPrompt(prompt, { signal: activeAbort.signal, onChunk });
      }
      succeeded = modelText.length > 0;
    } catch (err: unknown) {
      const name = (err as { name?: unknown })?.name;
      if (name === 'AbortError') {
        modelText = modelText + (modelText ? '\n\n[stopped]' : '[stopped]');
        responseEl.textContent = modelText;
      } else {
        modelText = err instanceof Error ? err.message : String(err);
        responseEl.textContent = modelText;
      }
    } finally {
      if (indicator.parentNode) indicator.remove();
      if (!modelText) {
        responseEl.textContent = '(no response — the model returned an empty answer)';
      }
      if (modelText) {
        pushEntry({ role: 'model', text: modelText });
        persist();
      }
      if (succeeded) {
        rewrite.finalize();
        attachUndoButton(responseEl, snap);
      }
      setIdleState(actionBtn, i);
      activeAbort = null;
      i.focus();
    }
  }

  async function send() {
    if (!i.value.trim() || activeAbort) return;
    const text = i.value.trim();
    i.value = '';
    const snap = currentSelection;
    if (snap && askMode) {
      // Snapshot reference is fine — ask mode does not mutate the DOM.
      await sendAsk(text, snap);
      return;
    }
    if (snap) {
      // Detach the snapshot from session state so a later selectionchange
      // does not clobber the in-flight rewrite's anchor.
      currentSelection = null;
      updatePlaceholder();
      updateChip();
      await sendRewrite(text, snap);
      return;
    }
    await sendChat(text);
  }

  // ---- Event wiring ----
  actionBtn.addEventListener('click', () => {
    if (activeAbort) {
      activeAbort.abort();
    } else {
      void send();
    }
  });

  i.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && currentSelection) {
      e.preventDefault();
      askMode = !askMode;
      updatePlaceholder();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  // ---- Toggle listener ----
  let convertedAnchor = false;
  chrome.runtime.onMessage.addListener((m: typeof TOGGLE_MESSAGE) => {
    if (m.a !== TOGGLE_MESSAGE.a) return;
    if (root.style.display === 'none') {
      root.style.display = 'flex';
      if (!convertedAnchor) {
        const rect = root.getBoundingClientRect();
        root.style.left = `${rect.left}px`;
        root.style.right = 'auto';
        convertedAnchor = true;
      }
      i.focus();
    } else {
      root.style.display = 'none';
    }
  });

  // ---- Initial restore ----
  void restore();
}
