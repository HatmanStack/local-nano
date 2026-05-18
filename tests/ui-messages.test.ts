import { beforeEach, describe, expect, it } from 'vitest';
import { makeTypingIndicator, renderMessage } from '../src/ui/messages.js';

describe('makeTypingIndicator', () => {
  it('renders three .ln-dot spans', () => {
    const el = makeTypingIndicator();
    expect(el.querySelectorAll('.ln-dot').length).toBe(3);
  });
});

describe('renderMessage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('appends a div with the message text', () => {
    renderMessage(container, 'user', 'hello');
    expect(container.children.length).toBe(1);
    expect(container.firstElementChild?.textContent).toBe('hello');
  });

  it('aligns user messages to flex-end', () => {
    const el = renderMessage(container, 'user', 'q');
    expect(el.style.alignSelf).toBe('flex-end');
  });

  it('aligns model and system messages to flex-start', () => {
    const model = renderMessage(container, 'model', 'a');
    const sys = renderMessage(container, 'system', 's');
    expect(model.style.alignSelf).toBe('flex-start');
    expect(sys.style.alignSelf).toBe('flex-start');
  });

  it('uses different backgrounds per role', () => {
    const user = renderMessage(container, 'user', 'u');
    const model = renderMessage(container, 'model', 'm');
    const sys = renderMessage(container, 'system', 's');
    const bgs = new Set([user, model, sys].map((e) => e.style.background.toLowerCase()));
    expect(bgs.size).toBe(3);
  });

  it('escapes content as text, not HTML', () => {
    const el = renderMessage(container, 'user', '<script>alert(1)</script>');
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toBe('<script>alert(1)</script>');
  });

  it('scrolls the container to the bottom', () => {
    Object.defineProperty(container, 'scrollHeight', {
      configurable: true,
      get: () => 999,
    });
    renderMessage(container, 'user', 'x');
    expect(container.scrollTop).toBe(999);
  });
});
