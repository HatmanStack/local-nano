/**
 * Minimal typed surface for a LanguageModel session returned by the
 * Prompt API polyfill. Only the methods called in this extension are
 * declared; the full spec surface is larger.
 */
export interface LanguageModelSession {
  promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>;
  destroy(): void;
}

import type transformersConfigType from '../.env.json';
import { TOGGLE_MESSAGE } from './background/handler.js';
import {
  type Entry,
  loadHistory as loadHistoryFromStorage,
  type Role,
  saveHistory as saveHistoryToStorage,
  storageKey,
} from './history.js';
import { pageContext } from './pageContext.js';
import { SYSTEM_INSTRUCTION } from './system.js';
import { makeTypingIndicator, renderMessage } from './ui/messages.js';
import { setGeneratingState, setIdleState } from './ui/state.js';

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

interface OnnxWasmEnv {
  backends: { onnx: { wasm: { wasmPaths: string; numThreads: number } } };
}

export function initSession(deps: SessionDeps): void {
  const { root, messages, input: i, actionBtn, transformersConfig, location, document } = deps;
  const STORAGE_KEY = storageKey(location);

  // ---- Heavy module loader (lazy, singleton) ----
  let heavyLoadPromise: Promise<{
    LanguageModel: { create: (opts: unknown) => Promise<LanguageModelSession> };
  }> | null = null;

  function loadHeavy() {
    if (heavyLoadPromise) return heavyLoadPromise;
    heavyLoadPromise = (async () => {
      const [tfMod, polyfillMod] = await Promise.all([
        import('@huggingface/transformers'),
        import('../vendor/prompt-api-polyfill/prompt-api-polyfill.js'),
      ]);
      const ortPath = chrome.runtime.getURL('dist/ort/');
      (tfMod.env as unknown as OnnxWasmEnv).backends.onnx.wasm.wasmPaths = ortPath;
      (tfMod.env as unknown as OnnxWasmEnv).backends.onnx.wasm.numThreads = 1;
      (window as unknown as Record<string, unknown>).TRANSFORMERS_CONFIG = transformersConfig;
      console.log('[local-nano] heavy modules loaded; ORT wasmPaths =', ortPath);
      return {
        LanguageModel: (
          polyfillMod as unknown as {
            LanguageModel: { create: (opts: unknown) => Promise<LanguageModelSession> };
          }
        ).LanguageModel,
      };
    })();
    return heavyLoadPromise;
  }

  // ---- History ----
  let history: Entry[] = [];

  function persist() {
    saveHistoryToStorage(STORAGE_KEY, history).catch((err: unknown) => {
      console.error('[local-nano] history write failed:', err);
    });
  }

  async function restore(): Promise<void> {
    history = await loadHistoryFromStorage(STORAGE_KEY);
    for (const entry of history) renderMessage(messages, entry.role, entry.text);
  }

  function addMessage(role: Role, text: string): HTMLElement {
    const el = renderMessage(messages, role, text);
    if (role !== 'system') {
      history.push({ role, text });
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
      const { LanguageModel } = await loadHeavy();
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
      i.disabled = false;
    } catch (e: unknown) {
      console.error('[local-nano] LanguageModel.create failed:', e);
      status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      // Reset heavyLoadPromise so the user can retry by closing and reopening
      // the panel. Without this, every subsequent ensureSession call returns
      // the same rejected promise and the failure is permanent for the tab.
      heavyLoadPromise = null;
      i.disabled = false;
    } finally {
      creating = false;
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
      if (modelText) {
        history.push({ role: 'model', text: modelText });
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
    if (!root) return;
    if (root.style.display === 'none') {
      root.style.display = 'flex';
      if (!convertedAnchor) {
        const rect = root.getBoundingClientRect();
        root.style.left = `${rect.left}px`;
        root.style.right = 'auto';
        convertedAnchor = true;
      }
      i.focus();
      void ensureSession();
    } else {
      root.style.display = 'none';
    }
  });

  // ---- Initial restore ----
  void restore();
}
