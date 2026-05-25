import { decideSnapshot, type SelectionSnapshot } from './src/selection-rewrite.js';
import { initSession } from './src/session.js';
import { IDLE_BG } from './src/ui/state.js';

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
  display: flex; justify-content: space-between; align-items: center; gap: 6px;
  border-radius: 7px 7px 0 0; flex-shrink: 0;
`;
const title = document.createElement('span');
title.textContent = 'Local AI';
title.style.fontWeight = '600';
// Hug the left edge so any header controls (close button, and the session's
// Copy-diagnostic button inserted into the header) group on the right.
title.style.marginRight = 'auto';
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

// Selection-preview chip sits above the input. Hidden by default; the
// session shows it when a supported selection is captured. Palette
// matches the header background at `header` above so it reads as part
// of the panel.
const selectionChip = document.createElement('div');
selectionChip.style.cssText = `
  margin: 6px 8px 0; padding: 2px 8px;
  background: #333; color: #eee;
  border-radius: 4px;
  font-size: 12px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  display: none; flex-shrink: 0;
`;

const inputWrap = document.createElement('div');
inputWrap.style.cssText = `
  padding: 8px; border-top: 1px solid #444; flex-shrink: 0;
  display: flex; gap: 6px; align-items: stretch;
`;
const input = document.createElement('input');
input.style.cssText = `
  flex: 1; padding: 8px; box-sizing: border-box;
  background: #111; color: #fff; border: 1px solid #444;
  border-radius: 4px; outline: none; font: inherit; min-width: 0;
`;
input.placeholder = 'Ask anything about this page (Enter)';
const actionBtn = document.createElement('button');
actionBtn.style.cssText = `
  color: #fff; border: none;
  border-radius: 4px; padding: 0 14px; cursor: pointer;
  font: inherit; font-weight: 600; min-width: 70px;
`;
actionBtn.style.background = IDLE_BG;
actionBtn.textContent = 'Send';
inputWrap.append(input, actionBtn);

root.append(header, messages, selectionChip, inputWrap);
document.body.appendChild(root);

// --- Dragging ---
// Attach mousemove/mouseup only while actively dragging so we don't fire on
// every page mouse movement when the panel is idle.
header.addEventListener('mousedown', (e) => {
  // Don't start a panel drag when the press lands on a header control — the
  // close button or the session's Copy-diagnostic button inserted into the header.
  if ((e.target as HTMLElement).closest('button')) return;
  const rect = root.getBoundingClientRect();
  const offX = e.clientX - rect.left;
  const offY = e.clientY - rect.top;
  root.style.right = 'auto';
  root.style.left = `${rect.left}px`;
  e.preventDefault();

  const onMove = (ev: MouseEvent) => {
    root.style.left = `${ev.clientX - offX}px`;
    root.style.top = `${ev.clientY - offY}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});
closeBtn.addEventListener('click', () => {
  root.style.display = 'none';
});

// Selection capture. All the decision logic — including the input-focus
// suppression rule (ADR-007) — lives in the pure `decideSnapshot`; this
// listener just acts on the returned action. `ignore` means the event
// came from focus moving into the chat input (the page selection
// collapses on focus shift) and the prior snapshot must survive, so we
// do nothing; `set`/`clear` forward a snapshot or null to the session.
let selectionCb: ((snap: SelectionSnapshot | null) => void) | null = null;
document.addEventListener('selectionchange', () => {
  if (!selectionCb) return;
  const decision = decideSnapshot({
    activeEl: document.activeElement,
    inputEl: input,
    selection: window.getSelection(),
  });
  if (decision.action === 'ignore') return;
  selectionCb(decision.action === 'set' ? decision.snapshot : null);
});

initSession({
  root,
  header,
  messages,
  input,
  actionBtn,
  selectionChip,
  onSelectionChange: (cb) => {
    selectionCb = cb;
  },
  location,
  document,
});
