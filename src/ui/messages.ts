import type { Role } from '../history.js';

export function makeTypingIndicator(doc: Document = document): HTMLElement {
  const wrap = doc.createElement('span');
  for (let idx = 0; idx < 3; idx++) {
    const dot = doc.createElement('span');
    dot.className = 'ln-dot';
    wrap.appendChild(dot);
  }
  return wrap;
}

export function renderMessage(
  container: HTMLElement,
  role: Role,
  text: string,
  doc: Document = document,
): HTMLElement {
  const el = doc.createElement('div');
  const align = role === 'user' ? 'flex-end' : 'flex-start';
  const bg =
    role === 'user' ? '#0a5fa3' : role === 'system' ? '#3a3a3a' : '#2a3942';
  el.style.cssText = `
    padding: 6px 10px; border-radius: 6px; max-width: 90%;
    white-space: pre-wrap; overflow-wrap: anywhere;
    align-self: ${align};
    background: ${bg};
  `;
  el.textContent = text;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}
