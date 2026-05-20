import { TOGGLE_MESSAGE } from './background/handler.js';
import {
  type Entry,
  loadHistory as loadHistoryFromStorage,
  MAX_HISTORY,
  type Role,
  saveHistory as saveHistoryToStorage,
  storageKey,
} from './history.js';
import { rebuildSession, streamPrompt } from './offscreen/client.js';
import { pageContext } from './pageContext.js';
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

/**
 * DOM elements and values that content.ts provides at injection time.
 * session.ts does not touch document directly.
 */
export interface SessionDeps {
  root: HTMLElement;
  messages: HTMLElement;
  input: HTMLInputElement;
  actionBtn: HTMLButtonElement;
  location: Pick<Location, 'origin' | 'pathname' | 'href'>;
  document: Pick<Document, 'title'> & { body: { innerText: string } };
}

export function initSession(deps: SessionDeps): void {
  const { root, messages, input: i, actionBtn, location, document } = deps;
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

  // ---- Send / Stop ----
  // NOTE(isFirstTurn): This flag isn't reset after restore() re-renders
  // prior history. The restored messages are displayed in the UI but the
  // offscreen session has no knowledge of them (it holds a single
  // long-lived context across tabs/URLs). The page-context prefix is only
  // applied on the very first user turn of the lifetime of this content
  // script. Cross-URL chat continuity needs a follow-up.
  let isFirstTurn = true;
  let activeAbort: AbortController | null = null;

  async function send() {
    if (!i.value.trim() || activeAbort) return;
    const text = i.value.trim();
    i.value = '';
    addMessage('user', text);
    // First-turn UX hint. The model upload to WebGPU runs in the offscreen
    // doc and the user has no other signal that something is happening for
    // the 30-90s that takes. Hint is a transient system message — not
    // persisted — that's removed when the first chunk arrives, or replaced
    // if generation fails.
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

    // Accumulate inside onChunk so abort/error paths still see the partial
    // text the user just watched stream in. The resolved value from
    // streamPrompt would be identical on the happy path, but we don't
    // rely on it.
    let modelText = '';
    let firstChunk = true;
    let rebuildHint: HTMLElement | null = null;
    const t0 = performance.now();
    const onChunk = (chunk: string) => {
      if (firstChunk) {
        console.log(`[local-nano] first token at ${(performance.now() - t0).toFixed(0)}ms`);
        // Drop the "Loading model…" / "GPU recovering…" hints now that
        // tokens are flowing.
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
        // The offscreen polyfill lost its WebGPU device (typically after a
        // tab/window switch) and surfaced our explicit "no output" error.
        // Re-seed a fresh session with the persisted conversation so the
        // model wakes up knowing what was said, then retry the user's
        // current prompt once. The just-added user turn is sliced off the
        // reseed history — the polyfill will record it itself when we
        // re-send below. Page-context prefix is dropped on retry: it was
        // a first-turn UX nicety and never made it into our stored
        // history, so re-sending it would be incoherent with the reseeded
        // polyfill view.
        rebuildHint = addMessage(
          'system',
          'GPU device lost — restoring session and retrying…',
        );
        modelText = '';
        firstChunk = true;
        const historyForReseed = history
          .slice(0, -1)
          .filter((entry): entry is { role: 'user' | 'model'; text: string } => entry.role !== 'system');
        await rebuildSession(historyForReseed);
        await streamPrompt(text, { signal: activeAbort.signal, onChunk });
      }
      console.log(
        `[local-nano] stream done in ${(performance.now() - t0).toFixed(0)}ms, chars=${modelText.length}, prompt.length=${prompt.length}`,
      );
    } catch (err: unknown) {
      // DOMException isn't always `instanceof Error` in non-browser
      // environments (e.g. jsdom), so check the name field directly.
      const name = (err as { name?: unknown })?.name;
      if (name === 'AbortError') {
        modelText = modelText + (modelText ? '\n\n[stopped]' : '[stopped]');
        responseEl.textContent = modelText;
      } else {
        modelText = err instanceof Error ? err.message : String(err);
        responseEl.textContent = modelText;
      }
    } finally {
      // Drop the typing indicator unconditionally. The in-loop reset only
      // runs when at least one chunk arrives; a stream that closes with
      // zero chunks would otherwise leave the bouncing dots in place.
      if (indicator.parentNode) indicator.remove();
      // Drop the first-turn / rebuild hints if either is still attached
      // (they survive if no chunk ever arrived — abort or error before
      // generation started).
      if (firstTurnHint?.parentNode) firstTurnHint.remove();
      if (rebuildHint?.parentNode) rebuildHint.remove();
      // A stream that completed successfully with zero chunks means the
      // model emitted EOS immediately. Surface it as an explicit message
      // rather than leaving an empty bubble that looks like the panel is
      // broken.
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

  // ---- Event wiring ----
  actionBtn.addEventListener('click', () => {
    if (activeAbort) {
      activeAbort.abort();
    } else {
      void send();
    }
  });

  i.addEventListener('keydown', (e: KeyboardEvent) => {
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
