import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePreview, type PreviewCallbacks } from '../src/ui/preview.js';

function makeCallbacks(): PreviewCallbacks & {
  onApply: ReturnType<typeof vi.fn>;
  onDiscard: ReturnType<typeof vi.fn>;
} {
  return {
    onApply: vi.fn(),
    onDiscard: vi.fn(),
  };
}

describe('makePreview — initial state', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns a handle whose root is an HTMLElement not yet attached', () => {
    const handle = makePreview(makeCallbacks());
    expect(handle.root).toBeInstanceOf(HTMLElement);
    expect(handle.root.parentNode).toBeNull();
  });

  it('initial state has Apply disabled and a typing indicator in the result pane', () => {
    const handle = makePreview(makeCallbacks());
    document.body.appendChild(handle.root);
    const applyBtn = handle.root.querySelector('button[data-action="apply"]') as HTMLButtonElement;
    expect(applyBtn).not.toBeNull();
    expect(applyBtn.disabled).toBe(true);
    expect(handle.root.querySelectorAll('.ln-dot').length).toBe(3);
  });
});

describe('makePreview — setOriginal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the original text as textContent, not HTML', () => {
    const handle = makePreview(makeCallbacks());
    document.body.appendChild(handle.root);
    handle.setOriginal('<b>x</b>');
    const orig = handle.root.querySelector('[data-pane="original"]') as HTMLElement;
    expect(orig).not.toBeNull();
    expect(orig.textContent).toBe('<b>x</b>');
    expect(orig.querySelector('b')).toBeNull();
  });
});

describe('makePreview — streaming state machine', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('first appendChunk removes the typing indicator and sets result text', () => {
    const handle = makePreview(makeCallbacks());
    document.body.appendChild(handle.root);
    handle.appendChunk('hello');
    expect(handle.root.querySelectorAll('.ln-dot').length).toBe(0);
    const result = handle.root.querySelector('[data-pane="result"]') as HTMLElement;
    expect(result.textContent).toBe('hello');
    const applyBtn = handle.root.querySelector('button[data-action="apply"]') as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
  });

  it('subsequent chunks append', () => {
    const handle = makePreview(makeCallbacks());
    handle.appendChunk('hello');
    handle.appendChunk('world');
    const result = handle.root.querySelector('[data-pane="result"]') as HTMLElement;
    expect(result.textContent).toBe('helloworld');
    expect(handle.getResultText()).toBe('helloworld');
  });

  it('complete() enables Apply and removes any remaining typing indicator', () => {
    const handle = makePreview(makeCallbacks());
    handle.complete();
    const applyBtn = handle.root.querySelector('button[data-action="apply"]') as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(false);
    expect(handle.root.querySelectorAll('.ln-dot').length).toBe(0);
  });

  it('abort() disables Apply and appends [stopped] to the result text', () => {
    const handle = makePreview(makeCallbacks());
    handle.appendChunk('partial');
    handle.abort();
    const applyBtn = handle.root.querySelector('button[data-action="apply"]') as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
    const result = handle.root.querySelector('[data-pane="result"]') as HTMLElement;
    expect(result.textContent?.endsWith('[stopped]')).toBe(true);
    // getResultText is independent of the [stopped] suffix.
    expect(handle.getResultText()).toBe('partial');
  });

  it('error("boom") disables Apply and shows exactly the error text', () => {
    const handle = makePreview(makeCallbacks());
    handle.appendChunk('partial');
    handle.error('boom');
    const applyBtn = handle.root.querySelector('button[data-action="apply"]') as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
    const result = handle.root.querySelector('[data-pane="result"]') as HTMLElement;
    expect(result.textContent).toBe('boom');
  });

  it('reset() clears the result and restores the typing indicator', () => {
    const handle = makePreview(makeCallbacks());
    handle.appendChunk('hello');
    handle.reset();
    const result = handle.root.querySelector('[data-pane="result"]') as HTMLElement;
    expect(result.querySelectorAll('.ln-dot').length).toBe(3);
    expect(handle.getResultText()).toBe('');
  });

  it('complete() after abort() is a no-op', () => {
    const handle = makePreview(makeCallbacks());
    handle.appendChunk('partial');
    handle.abort();
    handle.complete();
    const applyBtn = handle.root.querySelector('button[data-action="apply"]') as HTMLButtonElement;
    // Still disabled because state is 'aborted' — complete() did not
    // transition it back.
    expect(applyBtn.disabled).toBe(true);
  });
});

describe('makePreview — callbacks', () => {
  let callbacks: ReturnType<typeof makeCallbacks>;

  beforeEach(() => {
    callbacks = makeCallbacks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('Apply click invokes onApply once', () => {
    const handle = makePreview(callbacks);
    document.body.appendChild(handle.root);
    handle.complete();
    const applyBtn = handle.root.querySelector('button[data-action="apply"]') as HTMLButtonElement;
    applyBtn.click();
    expect(callbacks.onApply).toHaveBeenCalledTimes(1);
    expect(callbacks.onDiscard).not.toHaveBeenCalled();
  });

  it('Discard click invokes onDiscard once', () => {
    const handle = makePreview(callbacks);
    document.body.appendChild(handle.root);
    const discardBtn = handle.root.querySelector(
      'button[data-action="discard"]',
    ) as HTMLButtonElement;
    discardBtn.click();
    expect(callbacks.onDiscard).toHaveBeenCalledTimes(1);
    expect(callbacks.onApply).not.toHaveBeenCalled();
  });

  it('Escape keydown on the root triggers onDiscard', () => {
    const handle = makePreview(callbacks);
    document.body.appendChild(handle.root);
    handle.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(callbacks.onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe('makePreview — destroy and getResultText', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('destroy() removes the root from its parent', () => {
    const handle = makePreview(makeCallbacks());
    document.body.appendChild(handle.root);
    expect(handle.root.parentNode).toBe(document.body);
    handle.destroy();
    expect(handle.root.parentNode).toBeNull();
  });

  it('getResultText returns the accumulated chunks', () => {
    const handle = makePreview(makeCallbacks());
    expect(handle.getResultText()).toBe('');
    handle.appendChunk('foo');
    handle.appendChunk(' bar');
    expect(handle.getResultText()).toBe('foo bar');
  });
});

describe('makePreview — applyFailed', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('surfaces the message in the status line and disables Apply', () => {
    const handle = makePreview(makeCallbacks());
    document.body.appendChild(handle.root);
    // Drive to a state where Apply is enabled.
    handle.appendChunk('rewritten text');
    handle.complete();
    const applyBtn = handle.root.querySelector(
      'button[data-action="apply"]',
    ) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(false);

    handle.applyFailed('Could not apply — the selection on the page is no longer available.');

    const status = handle.root.querySelector(
      '[data-role="apply-status"]',
    ) as HTMLElement;
    expect(status.textContent).toContain('Could not apply');
    expect(applyBtn.disabled).toBe(true);
  });
});
