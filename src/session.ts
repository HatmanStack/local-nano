import type transformersConfigType from '../.env.json';
import { TOGGLE_MESSAGE } from './background/handler.js';
import { type LanguageModelSession, loadHeavy, resetHeavyCache } from './heavy.js';
import {
  type Entry,
  loadHistory as loadHistoryFromStorage,
  MAX_HISTORY,
  type Role,
  saveHistory as saveHistoryToStorage,
  storageKey,
} from './history.js';
import { pageContext } from './pageContext.js';
import { SYSTEM_INSTRUCTION } from './system.js';
import { makeTypingIndicator, renderMessage } from './ui/messages.js';
import { setGeneratingState, setIdleState } from './ui/state.js';

// Re-export the LanguageModelSession interface so existing importers
// that still reach for it via `./session.js` keep compiling.
export type { LanguageModelSession } from './heavy.js';

// The transformers config shape — imported for type only; actual import
// happens at build time in content.ts.
type TransformersConfig = typeof transformersConfigType;

/**
 * DOM elements and values that content.ts provides at injection time.
 * session.ts does not touch document directly.
 */
export interface SessionDeps {
  root: HTMLElement;
  messages: HTMLElement;
  input: HTMLInputElement;
  actionBtn: HTMLButtonElement;
  transformersConfig: TransformersConfig;
  location: Pick<Location, 'origin' | 'pathname' | 'href'>;
  document: Pick<Document, 'title'> & { body: { innerText: string } };
}

/**
 * Public handle returned by `initSession`. v0.2 exposes a small surface
 * so `initDomActions` can drive the panel (open it, prefill+send, mount
 * a Preview component) without owning panel DOM.
 */
export interface SessionHandle {
  /** Show the panel (hidden by default) and focus the input. */
  openPanel(): void;
  /** Hide the panel. */
  closePanel(): void;
  /** Whether the panel is currently visible. */
  isPanelOpen(): boolean;
  /**
   * Prefill the input with `text` and (optionally) trigger send.
   * Used by `Summarize this page` and `ask_about_selection`. When
   * `autoSend === false` the user must press Enter themselves.
   */
  prefillAndSend(text: string, autoSend: boolean): void;
  /**
   * Replace the messages list with the given Preview element. Returns a
   * teardown function that restores the messages list and removes the
   * Preview root. Calling `mountPreview` while a previous Preview is
   * still mounted invokes the previous teardown before mounting the new
   * one (one Preview at a time).
   */
  mountPreview(previewRoot: HTMLElement): () => void;
}

export function initSession(deps: SessionDeps): SessionHandle {
  const { root, messages, input: i, actionBtn, transformersConfig, location, document } = deps;
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

  // ---- Session state ----
  let session: LanguageModelSession | null = null;
  let creating = false;
  // NOTE(isFirstTurn): This flag is not reset after restore() re-renders prior
  // history. The restored messages are displayed in the UI but the new session
  // has no access to them (the polyfill creates a fresh context). This means
  // follow-up messages after a page reload produce contextless responses.
  // Fixing this requires either replaying history into the session's
  // initialPrompts on creation, or disabling isFirstTurn-based page context
  // injection when prior history exists. Tracked as M7 — deferred to a future
  // iteration because the correct fix depends on polyfill replay support.
  let isFirstTurn = true;

  async function ensureSession() {
    if (session || creating) return;
    creating = true;
    i.disabled = true;
    const status = addMessage('system', 'Loading model…');
    try {
      const { LanguageModel } = await loadHeavy(transformersConfig);
      const created = await LanguageModel.create({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: [{ role: 'system', content: SYSTEM_INSTRUCTION }],
        monitor(mon: EventTarget) {
          mon.addEventListener('downloadprogress', (e) => {
            const ev = e as Event & { loaded: number };
            const v = ev.loaded;
            const label = v <= 1 ? `${Math.round(v * 100)}%` : `${(v / 1_000_000).toFixed(1)} MB`;
            status.textContent = `Loading model… ${label}`;
          });
        },
      });
      session = created;
      status.textContent = 'Ready.';
    } catch (e: unknown) {
      console.error('[local-nano] LanguageModel.create failed:', e);
      status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      // Reset the heavy module cache so the user can retry by closing and
      // reopening the panel. Without this, every subsequent ensureSession
      // call returns the same rejected promise and the failure is permanent
      // for the tab.
      resetHeavyCache();
    } finally {
      creating = false;
      i.disabled = false;
    }
  }

  // ---- Send / Stop ----
  let activeAbort: AbortController | null = null;

  async function send() {
    if (!i.value.trim() || !session || activeAbort) return;
    const text = i.value.trim();
    i.value = '';
    addMessage('user', text);
    const responseEl = renderMessage(messages, 'model', '');
    const indicator = makeTypingIndicator();
    responseEl.appendChild(indicator);
    const prompt = isFirstTurn ? `${pageContext(document, location)}\n\n---\n\n${text}` : text;
    isFirstTurn = false;

    activeAbort = new AbortController();
    setGeneratingState(actionBtn, i);

    let modelText = '';
    try {
      const t0 = performance.now();
      const stream = session.promptStreaming(prompt, { signal: activeAbort.signal });
      const reader = stream.getReader();
      let firstChunk = true;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log(`[local-nano] stream done in ${(performance.now() - t0).toFixed(0)}ms`);
            break;
          }
          if (firstChunk) {
            console.log(`[local-nano] first token at ${(performance.now() - t0).toFixed(0)}ms`);
            responseEl.textContent = '';
            firstChunk = false;
          }
          modelText += value;
          responseEl.textContent = modelText;
          messages.scrollTop = messages.scrollHeight;
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        modelText = modelText + (modelText ? '\n\n[stopped]' : '[stopped]');
        responseEl.textContent = modelText;
      } else {
        modelText = String(err);
        responseEl.textContent = modelText;
      }
    } finally {
      // Drop the typing indicator unconditionally. The in-loop reset only
      // runs when at least one chunk arrives; a stream that closes with
      // zero chunks would otherwise leave the bouncing dots in place.
      if (indicator.parentNode) indicator.remove();
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

  // ---- Panel show/hide (shared by toggle and SessionHandle.openPanel) ----
  let convertedAnchor = false;
  function isPanelOpen(): boolean {
    return root.style.display !== 'none';
  }

  function openPanel(): void {
    if (root.style.display === 'none') {
      root.style.display = 'flex';
      if (!convertedAnchor) {
        const rect = root.getBoundingClientRect();
        root.style.left = `${rect.left}px`;
        root.style.right = 'auto';
        convertedAnchor = true;
      }
    }
    i.focus();
    void ensureSession();
  }

  function closePanel(): void {
    root.style.display = 'none';
  }

  // ---- Preview mount/unmount ----
  // Only one Preview can be active at a time. The teardown captured here
  // returns the panel to its chat layout; calling mountPreview again
  // tears down the previous Preview first (idempotent — clearing happens
  // before the new mount).
  let currentPreviewTeardown: (() => void) | null = null;

  function mountPreview(previewRoot: HTMLElement): () => void {
    // Tear down any previous Preview first so only one is mounted.
    if (currentPreviewTeardown) {
      currentPreviewTeardown();
      currentPreviewTeardown = null;
    }
    const prevDisplay = messages.style.display;
    messages.style.display = 'none';
    // Insert the preview after the messages list so the existing inputWrap
    // still sits at the bottom of the panel.
    messages.parentNode?.insertBefore(previewRoot, messages.nextSibling);
    const teardown = () => {
      if (previewRoot.parentNode) previewRoot.parentNode.removeChild(previewRoot);
      messages.style.display = prevDisplay;
      // Only clear the slot if this is still the active teardown — a
      // concurrent mountPreview call already cleared us out.
      if (currentPreviewTeardown === teardown) currentPreviewTeardown = null;
    };
    currentPreviewTeardown = teardown;
    return teardown;
  }

  // ---- Toggle listener ----
  chrome.runtime.onMessage.addListener((m: typeof TOGGLE_MESSAGE) => {
    if (m.a !== TOGGLE_MESSAGE.a) return;
    if (isPanelOpen()) {
      closePanel();
    } else {
      openPanel();
    }
  });

  // ---- Initial restore ----
  void restore();

  return {
    openPanel,
    closePanel,
    isPanelOpen,
    prefillAndSend(text: string, autoSend: boolean): void {
      i.value = text;
      if (autoSend) void send();
    },
    mountPreview,
  };
}
