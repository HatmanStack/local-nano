import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureSelection,
  type DomActionsDeps,
  type InputSnapshot,
  initDomActions,
  type RangeSnapshot,
  type SelectionSnapshot,
} from '../src/dom-actions.js';
import { chromeMock } from './setup.js';

// Mock runTransform so we never touch the heavy modules during dispatch
// tests. The mock returns a controllable stream and abort tracking.
vi.mock('../src/transform.js', () => ({
  runTransform: vi.fn(),
}));

// Mock applyToTarget so tests can drive both the success and failure
// paths of the Apply button without relying on jsdom's partial Range
// behavior under detached nodes.
vi.mock('../src/dom-apply.js', () => ({
  applyToTarget: vi.fn(),
}));

import * as applyMod from '../src/dom-apply.js';
import * as transformMod from '../src/transform.js';

const mockRunTransform = transformMod.runTransform as ReturnType<typeof vi.fn>;
const mockApplyToTarget = applyMod.applyToTarget as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * jsdom does not fully implement `window.getSelection()`'s mutation API.
 * `selection.addRange(range)` is a no-op in some jsdom versions, so a few
 * tests below stub `window.getSelection` to return a fake Selection whose
 * `getRangeAt` returns the test's pre-built Range. Each test that does this
 * restores the original getter in its `afterEach`.
 */

function stubSelection(opts: {
  rangeCount?: number;
  isCollapsed?: boolean;
  range?: Range;
  text?: string;
}): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'getSelection');
  const fakeSelection = {
    rangeCount: opts.rangeCount ?? (opts.range ? 1 : 0),
    isCollapsed: opts.isCollapsed ?? false,
    getRangeAt: (_: number) => opts.range as Range,
    toString: () => opts.text ?? '',
    removeAllRanges: () => {},
    addRange: (_: Range) => {},
  };
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    value: () => fakeSelection,
  });
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(window, 'getSelection', originalDescriptor);
    } else {
      Object.defineProperty(window, 'getSelection', {
        configurable: true,
        value: () => null,
      });
    }
  };
}

describe('captureSelection', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    document.body.innerHTML = '';
  });

  it('returns null when no selection exists', () => {
    cleanup = stubSelection({ rangeCount: 0, isCollapsed: true });
    expect(captureSelection(document)).toBeNull();
  });

  it('returns InputSnapshot for an active <input> with a non-empty selection', () => {
    const input = document.createElement('input');
    input.value = 'hello world';
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(0, 5);

    const snap = captureSelection(document);
    expect(snap).not.toBeNull();
    expect(snap?.kind).toBe('input');
    if (snap?.kind === 'input') {
      expect(snap.element).toBe(input);
      expect(snap.selectionStart).toBe(0);
      expect(snap.selectionEnd).toBe(5);
      expect(snap.text).toBe('hello');
    }
  });

  it('returns InputSnapshot for an active <textarea>', () => {
    const ta = document.createElement('textarea');
    ta.value = 'foo bar baz';
    document.body.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(4, 7);

    const snap = captureSelection(document);
    expect(snap?.kind).toBe('input');
    if (snap?.kind === 'input') {
      expect(snap.element).toBe(ta);
      expect(snap.text).toBe('bar');
    }
  });

  it('returns null when an <input> is focused with start === end', () => {
    const input = document.createElement('input');
    input.value = 'hello world';
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(3, 3);
    // Also stub the window selection to be empty so the fallback branch
    // also returns null.
    cleanup = stubSelection({ rangeCount: 0, isCollapsed: true });
    expect(captureSelection(document)).toBeNull();
  });

  it('returns RangeSnapshot for a regular DOM selection', () => {
    const p = document.createElement('p');
    p.textContent = 'hello world';
    document.body.appendChild(p);
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    cleanup = stubSelection({
      rangeCount: 1,
      isCollapsed: false,
      range,
      text: 'hello',
    });

    const snap = captureSelection(document);
    expect(snap?.kind).toBe('range');
    if (snap?.kind === 'range') {
      expect(snap.text).toBe('hello');
      expect(snap.contentEditable).toBeNull();
      // Cloned, not identity-equal to the original Range.
      expect(snap.range).not.toBe(range);
      expect(snap.range.toString()).toBe('hello');
    }
  });

  it('sets contentEditable when the range is inside a contenteditable ancestor', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    div.textContent = 'editable text';
    document.body.appendChild(div);
    const textNode = div.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 8);
    cleanup = stubSelection({
      rangeCount: 1,
      isCollapsed: false,
      range,
      text: 'editable',
    });

    const snap = captureSelection(document);
    expect(snap?.kind).toBe('range');
    if (snap?.kind === 'range') {
      expect(snap.contentEditable).toBe(div);
    }
  });

  it('returns null when selection is collapsed (cursor only)', () => {
    cleanup = stubSelection({ rangeCount: 1, isCollapsed: true });
    expect(captureSelection(document)).toBeNull();
  });

  it('returns null when sel.toString() yields an empty string', () => {
    const p = document.createElement('p');
    p.textContent = 'hello';
    document.body.appendChild(p);
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 2);
    cleanup = stubSelection({
      rangeCount: 1,
      isCollapsed: false,
      range,
      text: '',
    });
    expect(captureSelection(document)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dispatch tests (Task 3.5)
// ---------------------------------------------------------------------------

function makeSessionStub(): {
  openPanel: ReturnType<typeof vi.fn>;
  closePanel: ReturnType<typeof vi.fn>;
  isPanelOpen: ReturnType<typeof vi.fn>;
  prefillAndSend: ReturnType<typeof vi.fn>;
  mountPreview: ReturnType<typeof vi.fn>;
  /** Captured teardown so a test can assert teardown was invoked. */
  lastTeardown: ReturnType<typeof vi.fn> | null;
} {
  const stub = {
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    isPanelOpen: vi.fn(() => false),
    prefillAndSend: vi.fn(),
    mountPreview: vi.fn(),
    lastTeardown: null as ReturnType<typeof vi.fn> | null,
  };
  stub.mountPreview.mockImplementation((_el: HTMLElement) => {
    const teardown = vi.fn();
    stub.lastTeardown = teardown;
    return teardown;
  });
  return stub;
}

function getMessageListener(): (msg: unknown) => void {
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  // The most recent listener added is the dom-actions dispatcher.
  return calls[calls.length - 1][0] as (msg: unknown) => void;
}

function makeRangeSnapshot(
  text: string,
  contentEditable: HTMLElement | null = null,
): {
  snap: RangeSnapshot;
  setSelection: () => void;
} {
  const host = contentEditable ?? document.createElement('p');
  if (!contentEditable) {
    document.body.appendChild(host);
  }
  host.textContent = text;
  const textNode = host.firstChild as Text;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, text.length);
  const snap: RangeSnapshot = {
    kind: 'range',
    range,
    text,
    contentEditable,
  };
  const setSelection = () => {
    const fake = {
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
      toString: () => text,
      removeAllRanges: () => {},
      addRange: () => {},
    };
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => fake,
    });
  };
  return { snap, setSelection };
}

/**
 * Inject a pending snapshot by firing a `contextmenu` event after
 * stubbing the document's selection. The listener under test reads from
 * the live document, so we make `captureSelection`'s view of the document
 * return our pre-built snapshot.
 */
function primeSnapshot(snap: SelectionSnapshot): void {
  if (snap.kind === 'input') {
    document.body.appendChild(snap.element);
    snap.element.focus();
    snap.element.setSelectionRange(snap.selectionStart, snap.selectionEnd);
  } else {
    // Range snapshot — install the fake selection.
    const fake = {
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => snap.range,
      toString: () => snap.text,
      removeAllRanges: () => {},
      addRange: () => {},
    };
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => fake,
    });
  }
  // Fire the contextmenu listener so the snapshot is captured into the
  // module-local pendingSnapshot slot.
  document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
}

describe('initDomActions — dispatch', () => {
  let session: ReturnType<typeof makeSessionStub>;
  let deps: DomActionsDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: applyToTarget succeeds. Tests covering the failure path
    // override this with mockReturnValueOnce(false).
    mockApplyToTarget.mockReturnValue(true);
    document.body.innerHTML = '';
    // Reset getSelection back to jsdom's default so tests don't leak.
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => null,
    });
    session = makeSessionStub();
    deps = {
      document,
      session,
      transformersConfig: { dummy: true },
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => null,
    });
  });

  it('registers a chrome.runtime.onMessage listener', () => {
    const before = chromeMock.runtime.onMessage.addListener.mock.calls.length;
    initDomActions(deps);
    expect(chromeMock.runtime.onMessage.addListener.mock.calls.length).toBe(before + 1);
  });

  it('ask_about_selection without a snapshot opens the panel and does not prefill', () => {
    initDomActions(deps);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'ask_about_selection' });
    expect(session.openPanel).toHaveBeenCalledTimes(1);
    expect(session.prefillAndSend).not.toHaveBeenCalled();
  });

  it('ask_about_selection with a Range snapshot prefills the chat-context wrapper', () => {
    initDomActions(deps);
    const { snap } = makeRangeSnapshot('hello');
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'ask_about_selection' });
    expect(session.prefillAndSend).toHaveBeenCalledWith('Selection: "hello"\n\nAsk: ', false);
  });

  it('summarize_page calls prefillAndSend("Summarize this page.", true)', () => {
    initDomActions(deps);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'summarize_page' });
    expect(session.openPanel).toHaveBeenCalled();
    expect(session.prefillAndSend).toHaveBeenCalledWith('Summarize this page.', true);
  });

  it('rewrite_improve without a snapshot opens the panel and does not call runTransform', () => {
    initDomActions(deps);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'rewrite_improve' });
    expect(session.openPanel).toHaveBeenCalled();
    expect(mockRunTransform).not.toHaveBeenCalled();
  });

  it('rewrite_improve with a contentEditable Range snapshot calls runTransform', async () => {
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    document.body.appendChild(ce);
    const { snap } = makeRangeSnapshot('write better', ce);
    mockRunTransform.mockResolvedValue({
      stream: new ReadableStream<string>({
        start(controller) {
          controller.enqueue('done');
          controller.close();
        },
      }),
      done: Promise.resolve(),
    });
    initDomActions(deps);
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'rewrite_improve' });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunTransform).toHaveBeenCalledTimes(1);
    const arg = mockRunTransform.mock.calls[0][0] as {
      action: string;
      sourceText: string;
      signal: AbortSignal;
    };
    expect(arg.action).toBe('rewrite_improve');
    expect(arg.sourceText).toBe('write better');
    expect(arg.signal).toBeInstanceOf(AbortSignal);
  });

  it('rewrite_improve with a non-editable Range snapshot does NOT call runTransform', () => {
    initDomActions(deps);
    const { snap } = makeRangeSnapshot('plain text', null);
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'rewrite_improve' });
    expect(mockRunTransform).not.toHaveBeenCalled();
    expect(session.openPanel).toHaveBeenCalled();
  });

  it('translate_en accepts any Range snapshot (transform-readonly)', async () => {
    mockRunTransform.mockResolvedValue({
      stream: new ReadableStream<string>({
        start(controller) {
          controller.close();
        },
      }),
      done: Promise.resolve(),
    });
    initDomActions(deps);
    const { snap } = makeRangeSnapshot('bonjour', null);
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'translate_en' });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunTransform).toHaveBeenCalledTimes(1);
  });

  it('a new transform aborts the in-flight one', async () => {
    // First transform: never-closing stream so the abort path is reachable.
    let firstAbortFired = false;
    let firstSignal: AbortSignal | undefined;
    mockRunTransform.mockImplementationOnce(
      async (args: { sourceText: string; signal: AbortSignal }) => {
        firstSignal = args.signal;
        args.signal.addEventListener('abort', () => {
          firstAbortFired = true;
        });
        return {
          stream: new ReadableStream<string>({
            start() {
              /* never closes */
            },
          }),
          done: Promise.resolve(),
        };
      },
    );
    mockRunTransform.mockImplementationOnce(async () => ({
      stream: new ReadableStream<string>({
        start(controller) {
          controller.close();
        },
      }),
      done: Promise.resolve(),
    }));
    initDomActions(deps);
    const { snap } = makeRangeSnapshot('text', null);
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'translate_en' });
    await new Promise((r) => setTimeout(r, 5));
    // Second dispatch — should abort the first.
    listener({ a: 'action', id: 'translate_es' });
    await new Promise((r) => setTimeout(r, 10));
    expect(firstSignal).toBeDefined();
    expect(firstAbortFired).toBe(true);
    expect(mockRunTransform).toHaveBeenCalledTimes(2);
  });

  it('Preview onApply applies the result text to the page DOM', async () => {
    const p = document.createElement('p');
    p.textContent = 'orig';
    document.body.appendChild(p);
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    const snap: RangeSnapshot = {
      kind: 'range',
      range,
      text: 'orig',
      contentEditable: null,
    };
    mockRunTransform.mockResolvedValue({
      stream: new ReadableStream<string>({
        start(controller) {
          controller.enqueue('NEW');
          controller.close();
        },
      }),
      done: Promise.resolve(),
    });
    // Capture the preview's onApply: mountPreview is called with the
    // preview root; the preview element itself wires onApply internally,
    // so we trigger it by clicking the Apply button.
    initDomActions(deps);
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'translate_en' });
    await new Promise((r) => setTimeout(r, 20));
    // The preview root passed to mountPreview is captured.
    const previewRoot = session.mountPreview.mock.calls[0][0] as HTMLElement;
    expect(previewRoot).toBeInstanceOf(HTMLElement);
    const applyBtn = previewRoot.querySelector('button[data-action="apply"]') as HTMLButtonElement;
    expect(applyBtn).not.toBeNull();
    // After stream completion the Apply button is enabled; click it.
    applyBtn.click();
    // applyToTarget is mocked at module scope; verify dispatch called it
    // with the captured snapshot and the streamed result text.
    expect(mockApplyToTarget).toHaveBeenCalledTimes(1);
    expect(mockApplyToTarget).toHaveBeenCalledWith(snap, 'NEW');
    // On success the preview is torn down (no inline error surfaced).
    expect(session.lastTeardown).not.toBeNull();
    expect(session.lastTeardown).toHaveBeenCalled();
  });

  it('Preview onApply surfaces an error inline when applyToTarget returns false', async () => {
    // Drive the failure path of applyToTarget — happens when the page-DOM
    // target was disconnected between snapshot and Apply. The preview
    // must stay open with an inline error and a locked Apply button.
    const { snap } = makeRangeSnapshot('orig', null);
    mockRunTransform.mockResolvedValue({
      stream: new ReadableStream<string>({
        start(controller) {
          controller.enqueue('NEW');
          controller.close();
        },
      }),
      done: Promise.resolve(),
    });
    mockApplyToTarget.mockReturnValueOnce(false);

    initDomActions(deps);
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'translate_en' });
    await new Promise((r) => setTimeout(r, 20));
    const previewRoot = session.mountPreview.mock.calls[0][0] as HTMLElement;
    const applyBtn = previewRoot.querySelector('button[data-action="apply"]') as HTMLButtonElement;
    applyBtn.click();
    const status = previewRoot.querySelector('[data-role="apply-status"]') as HTMLElement;
    expect(status.textContent).toContain('Could not apply');
    // Preview is NOT torn down on Apply failure — user must Discard
    // explicitly. `lastTeardown` is the fn returned by mountPreview;
    // dispatch keeps it but never calls it on the failure path.
    expect(session.lastTeardown).not.toBeNull();
    expect(session.lastTeardown).not.toHaveBeenCalled();
    // Apply is now locked.
    expect(applyBtn.disabled).toBe(true);
  });

  it('focuses the preview root on mount so Escape keydown reaches the listener', async () => {
    // Element.focus() only takes effect on elements attached to a
    // document — override the mountPreview mock to insert the preview
    // root into the body the way real session.ts does.
    session.mountPreview.mockImplementation((el: HTMLElement) => {
      document.body.appendChild(el);
      const teardown = vi.fn();
      session.lastTeardown = teardown;
      return teardown;
    });
    mockRunTransform.mockResolvedValue({
      stream: new ReadableStream<string>({
        start() {
          /* never closes */
        },
      }),
      done: Promise.resolve(),
    });
    initDomActions(deps);
    const { snap } = makeRangeSnapshot('xx', null);
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'translate_en' });
    await new Promise((r) => setTimeout(r, 5));
    const previewRoot = session.mountPreview.mock.calls[0][0] as HTMLElement;
    expect(document.activeElement).toBe(previewRoot);
  });

  it('Preview onDiscard tears down the preview', async () => {
    mockRunTransform.mockResolvedValue({
      stream: new ReadableStream<string>({
        start() {
          /* never closes */
        },
      }),
      done: Promise.resolve(),
    });
    initDomActions(deps);
    const { snap } = makeRangeSnapshot('xx', null);
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'translate_en' });
    await new Promise((r) => setTimeout(r, 5));
    const previewRoot = session.mountPreview.mock.calls[0][0] as HTMLElement;
    const discardBtn = previewRoot.querySelector(
      'button[data-action="discard"]',
    ) as HTMLButtonElement;
    discardBtn.click();
    expect(session.lastTeardown).not.toBeNull();
    expect(session.lastTeardown).toHaveBeenCalled();
  });

  it('non-AbortError from runTransform surfaces via preview.error', async () => {
    mockRunTransform.mockRejectedValue(new Error('boom'));
    initDomActions(deps);
    const { snap } = makeRangeSnapshot('xx', null);
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'translate_en' });
    await new Promise((r) => setTimeout(r, 10));
    const previewRoot = session.mountPreview.mock.calls[0][0] as HTMLElement;
    const result = previewRoot.querySelector('[data-pane="result"]') as HTMLElement;
    expect(result.textContent).toBe('boom');
  });

  it('AbortError from the stream surfaces via preview.abort ([stopped])', async () => {
    mockRunTransform.mockResolvedValue({
      stream: new ReadableStream<string>({
        start(controller) {
          const err = Object.assign(new Error('Aborted'), { name: 'AbortError' });
          controller.error(err);
        },
      }),
      done: Promise.resolve(),
    });
    initDomActions(deps);
    const { snap } = makeRangeSnapshot('xx', null);
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'translate_en' });
    await new Promise((r) => setTimeout(r, 10));
    const previewRoot = session.mountPreview.mock.calls[0][0] as HTMLElement;
    const result = previewRoot.querySelector('[data-pane="result"]') as HTMLElement;
    expect(result.textContent?.endsWith('[stopped]')).toBe(true);
  });

  it('messages with a !== "action" are ignored', () => {
    initDomActions(deps);
    const listener = getMessageListener();
    listener({ a: 'toggle' });
    listener({ a: 'other' });
    listener(null);
    listener('not an object');
    expect(session.openPanel).not.toHaveBeenCalled();
    expect(mockRunTransform).not.toHaveBeenCalled();
  });

  it('messages with an unknown ActionId are logged and do not crash', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    initDomActions(deps);
    const listener = getMessageListener();
    expect(() => listener({ a: 'action', id: 'totally_made_up' })).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('input snapshot is accepted by transform-editable', async () => {
    const input = document.createElement('input');
    input.value = 'hello world';
    document.body.appendChild(input);
    const snap: InputSnapshot = {
      kind: 'input',
      element: input,
      selectionStart: 0,
      selectionEnd: 5,
      text: 'hello',
    };
    mockRunTransform.mockResolvedValue({
      stream: new ReadableStream<string>({
        start(controller) {
          controller.close();
        },
      }),
      done: Promise.resolve(),
    });
    initDomActions(deps);
    primeSnapshot(snap);
    const listener = getMessageListener();
    listener({ a: 'action', id: 'rewrite_improve' });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunTransform).toHaveBeenCalledTimes(1);
  });
});
