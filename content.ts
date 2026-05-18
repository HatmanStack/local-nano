import transformersConfig from './.env.json';
import {
  storageKey,
  loadHistory as loadHistoryFromStorage,
  saveHistory as saveHistoryToStorage,
  type Entry,
  type Role,
} from './src/history.js';
import { pageContext } from './src/pageContext.js';
import { SYSTEM_INSTRUCTION } from './src/system.js';
import { makeTypingIndicator, renderMessage } from './src/ui/messages.js';
import { setIdleState, setGeneratingState } from './src/ui/state.js';

// Lazy-load the heavy bits (transformers.js runtime + polyfill) only on first
// hotkey toggle, so tabs the user never opens the AI in pay near-zero cost.
let heavyLoadPromise: Promise<{ LanguageModel: any }> | null = null;
function loadHeavy(): Promise<{ LanguageModel: any }> {
  if (heavyLoadPromise) return heavyLoadPromise;
  heavyLoadPromise = (async () => {
    const [tfMod, polyfillMod] = await Promise.all([
      import('@huggingface/transformers'),
      import('./vendor/prompt-api-polyfill/prompt-api-polyfill.js'),
    ]);
    const ortPath = chrome.runtime.getURL('dist/ort/');
    (tfMod.env as any).backends.onnx.wasm.wasmPaths = ortPath;
    (tfMod.env as any).backends.onnx.wasm.numThreads = 1;
    (window as any).TRANSFORMERS_CONFIG = transformersConfig;
    console.log('[local-nano] heavy modules loaded; ORT wasmPaths =', ortPath);
    return { LanguageModel: (polyfillMod as any).LanguageModel };
  })();
  return heavyLoadPromise;
}

// --- Animations (needs a <style> tag; can't keyframe via inline style) ---
const styleEl = document.createElement('style');
styleEl.textContent = `
  @keyframes ln-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
    30% { transform: translateY(-4px); opacity: 1; }
  }
  .ln-dot {
    display: inline-block; width: 6px; height: 6px;
    border-radius: 50%; background: #ccc; margin: 0 2px;
    animation: ln-bounce 1.2s infinite ease-in-out;
  }
  .ln-dot:nth-child(2) { animation-delay: 0.15s; }
  .ln-dot:nth-child(3) { animation-delay: 0.3s; }
`;
document.head.appendChild(styleEl);

// --- UI ---
const root = document.createElement('div');
root.style.cssText = `
  position: fixed; top: 80px; right: 80px;
  width: 500px; height: 600px;
  min-width: 280px; min-height: 200px;
  background: #222; color: #eee;
  border: 1px solid #555; border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  z-index: 2147483647;
  display: none; flex-direction: column;
  resize: both; overflow: hidden;
  font: 14px system-ui, -apple-system, sans-serif;
`;

const header = document.createElement('div');
header.style.cssText = `
  padding: 6px 10px; background: #333;
  cursor: move; user-select: none;
  display: flex; justify-content: space-between; align-items: center;
  border-radius: 7px 7px 0 0; flex-shrink: 0;
`;
const title = document.createElement('span');
title.textContent = 'Local AI';
title.style.fontWeight = '600';
const closeBtn = document.createElement('button');
closeBtn.textContent = '×';
closeBtn.style.cssText = `
  background: transparent; border: none; color: #eee;
  font-size: 20px; line-height: 1; cursor: pointer; padding: 0 6px;
`;
header.append(title, closeBtn);

const messages = document.createElement('div');
messages.style.cssText = `
  flex: 1; overflow-y: auto; padding: 10px;
  display: flex; flex-direction: column; gap: 8px;
`;

const inputWrap = document.createElement('div');
inputWrap.style.cssText = `
  padding: 8px; border-top: 1px solid #444; flex-shrink: 0;
  display: flex; gap: 6px; align-items: stretch;
`;
const i = document.createElement('input');
i.style.cssText = `
  flex: 1; padding: 8px; box-sizing: border-box;
  background: #111; color: #fff; border: 1px solid #444;
  border-radius: 4px; outline: none; font: inherit; min-width: 0;
`;
i.placeholder = 'Ask anything about this page (Enter)';
const actionBtn = document.createElement('button');
actionBtn.style.cssText = `
  background: #0a5fa3; color: #fff; border: none;
  border-radius: 4px; padding: 0 14px; cursor: pointer;
  font: inherit; font-weight: 600; min-width: 70px;
`;
actionBtn.textContent = 'Send';
inputWrap.append(i, actionBtn);

root.append(header, messages, inputWrap);
document.body.appendChild(root);

// --- Dragging ---
// Attach mousemove/mouseup only while actively dragging so we don't fire on
// every page mouse movement when the panel is idle.
header.addEventListener('mousedown', (e) => {
  if (e.target === closeBtn) return;
  const rect = root.getBoundingClientRect();
  const offX = e.clientX - rect.left;
  const offY = e.clientY - rect.top;
  root.style.right = 'auto';
  root.style.left = rect.left + 'px';
  e.preventDefault();

  const onMove = (ev: MouseEvent) => {
    root.style.left = (ev.clientX - offX) + 'px';
    root.style.top = (ev.clientY - offY) + 'px';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});
closeBtn.addEventListener('click', () => { root.style.display = 'none'; });

// --- History (persisted to chrome.storage.local, scoped per URL) ---
const STORAGE_KEY = storageKey(location);
let history: Entry[] = [];

function persist() {
  saveHistoryToStorage(STORAGE_KEY, history);
}

async function restore(): Promise<void> {
  history = await loadHistoryFromStorage(STORAGE_KEY);
  for (const entry of history) renderMessage(messages, entry.role, entry.text);
}

function addMessage(role: Role, text: string): HTMLElement {
  const el = renderMessage(messages, role, text);
  // System messages (load progress / errors) are transient — don't persist.
  if (role !== 'system') {
    history.push({ role, text });
    persist();
  }
  return el;
}

// --- Session ---
let s: any = null;
let creating = false;
let isFirstTurn = true;

restore();

async function ensureSession() {
  if (s || creating) return;
  creating = true;
  const status = addMessage('system', 'Loading model…');
  try {
    const { LanguageModel } = await loadHeavy();
    const session = await LanguageModel.create({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
      initialPrompts: [{ role: 'system', content: SYSTEM_INSTRUCTION }],
      monitor(mon: any) {
        mon.addEventListener('downloadprogress', (e: any) => {
          const v = e.loaded;
          const label = v <= 1 ? `${Math.round(v * 100)}%` : `${(v / 1_000_000).toFixed(1)} MB`;
          status.textContent = `Loading model… ${label}`;
        });
      },
    });
    s = session;
    status.textContent = 'Ready.';
  } catch (e: any) {
    console.error('[local-nano] LanguageModel.create failed:', e);
    status.textContent = `Error: ${e?.message || String(e)}`;
  } finally {
    creating = false;
  }
}

// --- Toggle ---
let convertedAnchor = false;
chrome.runtime.onMessage.addListener((m) => {
  if (m.a !== 'toggle') return;
  if (root.style.display === 'none') {
    root.style.display = 'flex';
    // Convert right-anchor → left-anchor once, after the panel has a real
    // computed position. `resize: both` only grows the right edge, so an
    // anchored-right element appears to "grow leftward" instead.
    if (!convertedAnchor) {
      const rect = root.getBoundingClientRect();
      root.style.left = rect.left + 'px';
      root.style.right = 'auto';
      convertedAnchor = true;
    }
    i.focus();
    ensureSession();
  } else {
    root.style.display = 'none';
  }
});

// --- Send / Stop ---
let activeAbort: AbortController | null = null;

async function send() {
  if (!i.value.trim() || !s || activeAbort) return;
  const v = i.value.trim();
  i.value = '';
  addMessage('user', v); // persisted immediately
  const responseEl = renderMessage(messages, 'model', ''); // empty for now, dots will go inside
  const indicator = makeTypingIndicator();
  responseEl.appendChild(indicator);
  const prompt = isFirstTurn
    ? `${pageContext(document, location)}\n\n---\n\n${v}`
    : v;
  isFirstTurn = false;

  activeAbort = new AbortController();
  setGeneratingState(actionBtn, i);

  let modelText = '';
  try {
    const t0 = performance.now();
    const stream = s.promptStreaming(prompt, { signal: activeAbort.signal });
    const reader = stream.getReader();
    let firstChunk = true;
    let chunkCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log(`[local-nano] stream done after ${chunkCount} chunks, ${(performance.now() - t0).toFixed(0)}ms`);
        break;
      }
      if (firstChunk) {
        console.log(`[local-nano] first token at ${(performance.now() - t0).toFixed(0)}ms`);
        responseEl.textContent = ''; // clears the dots
        firstChunk = false;
      }
      chunkCount++;
      console.log(`[local-nano] chunk ${chunkCount}:`, JSON.stringify(value));
      modelText += value;
      responseEl.textContent = modelText;
      messages.scrollTop = messages.scrollHeight;
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
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

actionBtn.addEventListener('click', () => {
  if (activeAbort) {
    activeAbort.abort();
  } else {
    send();
  }
});

i.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
