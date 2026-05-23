import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOGGLE_MESSAGE } from '../src/background/handler.js';
import { MAX_HISTORY } from '../src/history.js';
import type { SelectionSnapshot } from '../src/selection-rewrite.js';
import { initSession, type SessionDeps } from '../src/session.js';
import { chromeMock } from './setup.js';

// ---------------------------------------------------------------------------
// Mock the offscreen client
// ---------------------------------------------------------------------------

// The mock returns a promise the test can resolve/reject and also lets the
// test fire onChunk callbacks during the in-flight call.
type StreamPromptOpts = {
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
};

interface PendingStream {
  prompt: string;
  opts: StreamPromptOpts;
  resolve: (text: string) => void;
  reject: (err: unknown) => void;
}

const pending: PendingStream[] = [];

vi.mock('../src/offscreen/client.js', () => ({
  streamPrompt: vi.fn((prompt: string, opts: StreamPromptOpts = {}) => {
    return new Promise<string>((resolve, reject) => {
      pending.push({ prompt, opts, resolve, reject });
    });
  }),
  sendPrompt: vi.fn(),
  rebuildSession: vi.fn(() => Promise.resolve()),
  countTokens: vi.fn(async (text: string) => Math.ceil(text.length / 3)),
  warmupSession: vi.fn(() => Promise.resolve()),
}));

import {
  countTokens as mockedCountTokens,
  rebuildSession as mockedRebuildSession,
  streamPrompt as mockedStreamPrompt,
  warmupSession as mockedWarmupSession,
} from '../src/offscreen/client.js';

const streamPromptMock = mockedStreamPrompt as unknown as ReturnType<typeof vi.fn>;
const rebuildSessionMock = mockedRebuildSession as unknown as ReturnType<typeof vi.fn>;
const countTokensMock = mockedCountTokens as unknown as ReturnType<typeof vi.fn>;
const warmupSessionMock = mockedWarmupSession as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SelectionChangeListener = (snap: SelectionSnapshot | null) => void;

function makeDeps(): SessionDeps & {
  _root: HTMLDivElement;
  _messages: HTMLDivElement;
  _input: HTMLInputElement;
  _actionBtn: HTMLButtonElement;
  _selectionChip: HTMLDivElement;
  _fireSelectionChange: (snap: SelectionSnapshot | null) => void;
} {
  const _root = document.createElement('div');
  _root.style.display = 'none';
  const _messages = document.createElement('div');
  const _input = document.createElement('input');
  const _actionBtn = document.createElement('button');
  const _selectionChip = document.createElement('div');
  _selectionChip.style.display = 'none';
  _root.append(_messages, _input, _actionBtn, _selectionChip);
  document.body.appendChild(_root);

  let captured: SelectionChangeListener | null = null;
  const onSelectionChange = (cb: SelectionChangeListener) => {
    captured = cb;
  };
  const fireSelectionChange: SelectionChangeListener = (snap) => {
    if (captured) captured(snap);
  };

  return {
    root: _root,
    messages: _messages,
    input: _input,
    actionBtn: _actionBtn,
    selectionChip: _selectionChip,
    onSelectionChange,
    location: {
      origin: 'https://example.com',
      pathname: '/page',
      href: 'https://example.com/page',
    },
    document: {
      title: 'Test Page',
      body: { innerText: 'page body text' },
    },
    _root,
    _messages,
    _input,
    _actionBtn,
    _selectionChip,
    _fireSelectionChange: fireSelectionChange,
  };
}

function getToggleListener(): (m: typeof TOGGLE_MESSAGE) => void {
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0] as (m: typeof TOGGLE_MESSAGE) => void;
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function awaitPending(): Promise<PendingStream> {
  for (let i = 0; i < 40 && pending.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  const next = pending.shift();
  if (!next) throw new Error('streamPrompt was not called');
  return next;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initSession — history restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending.length = 0;
  });

  it('restores history on init and renders stored messages', async () => {
    const key = `local-nano:history:https://example.com/page`;
    chromeMock.storage.local.store[key] = [
      { role: 'user', text: 'hello' },
      { role: 'model', text: 'world' },
    ];
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();
    expect(deps._messages.children.length).toBe(2);
    expect(deps._messages.children[0].textContent).toBe('hello');
    expect(deps._messages.children[1].textContent).toBe('world');
  });

  it('caps in-memory history to MAX_HISTORY on restore', async () => {
    const key = `local-nano:history:https://example.com/page`;
    chromeMock.storage.local.store[key] = Array.from({ length: MAX_HISTORY + 50 }, (_, i) => ({
      role: 'user' as const,
      text: `msg ${i}`,
    }));
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();
    // The DOM should only have MAX_HISTORY rendered entries.
    expect(deps._messages.children.length).toBe(MAX_HISTORY);
    expect(deps._messages.children[0].textContent).toBe(`msg 50`);
  });
});

describe('initSession — toggle behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending.length = 0;
  });

  it('toggles panel visibility', () => {
    const deps = makeDeps();
    initSession(deps);
    const listener = getToggleListener();
    // Currently hidden — toggle should show it
    deps._root.style.display = 'none';
    listener(TOGGLE_MESSAGE);
    expect(deps._root.style.display).toBe('flex');
    // Hidden again
    listener(TOGGLE_MESSAGE);
    expect(deps._root.style.display).toBe('none');
  });

  it('ignores messages that are not the toggle command', () => {
    const deps = makeDeps();
    initSession(deps);
    const listener = getToggleListener();
    deps._root.style.display = 'none';
    listener({ a: 'something-else' } as unknown as typeof TOGGLE_MESSAGE);
    expect(deps._root.style.display).toBe('none');
  });

  it('Enter key triggers send when input has content', async () => {
    const deps = makeDeps();
    initSession(deps);
    deps._input.value = 'hi';
    const enter = new KeyboardEvent('keydown', { key: 'Enter' });
    deps._input.dispatchEvent(enter);
    const call = await awaitPending();
    expect(call.prompt).toContain('hi');
    call.resolve('hello there');
    await flushMicrotasks();
  });

  it('Shift+Enter does not trigger send', async () => {
    const deps = makeDeps();
    initSession(deps);
    deps._input.value = 'hi';
    const e = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
    deps._input.dispatchEvent(e);
    await flushMicrotasks();
    expect(streamPromptMock).not.toHaveBeenCalled();
  });

  it('empty/whitespace input does not trigger send', async () => {
    const deps = makeDeps();
    initSession(deps);
    deps._input.value = '   ';
    deps._actionBtn.click();
    await flushMicrotasks();
    expect(streamPromptMock).not.toHaveBeenCalled();
  });

  it('fires warmupSession the first time the panel opens', async () => {
    const deps = makeDeps();
    initSession(deps);
    expect(warmupSessionMock).not.toHaveBeenCalled();
    const listener = getToggleListener();
    listener(TOGGLE_MESSAGE);
    expect(warmupSessionMock).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
  });

  it('does not re-fire warmupSession on subsequent toggle-open while the prior warmup is still in flight or done', async () => {
    let resolveWarm: (() => void) | undefined;
    warmupSessionMock.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveWarm = r;
        }),
    );
    const deps = makeDeps();
    initSession(deps);
    const listener = getToggleListener();
    listener(TOGGLE_MESSAGE); // open
    expect(warmupSessionMock).toHaveBeenCalledTimes(1);
    listener(TOGGLE_MESSAGE); // close
    listener(TOGGLE_MESSAGE); // re-open
    expect(warmupSessionMock).toHaveBeenCalledTimes(1);
    resolveWarm?.();
    await flushMicrotasks();
    listener(TOGGLE_MESSAGE); // close
    listener(TOGGLE_MESSAGE); // re-open after warm done
    expect(warmupSessionMock).toHaveBeenCalledTimes(1);
  });

  it('shows a transient system bubble during warmup and removes it on completion', async () => {
    let resolveWarm: (() => void) | undefined;
    warmupSessionMock.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveWarm = r;
        }),
    );
    const deps = makeDeps();
    initSession(deps);
    const listener = getToggleListener();
    listener(TOGGLE_MESSAGE);
    // System bubble lives while warmup is in flight.
    const bubbleTexts = () => Array.from(deps._messages.children).map((c) => c.textContent ?? '');
    expect(bubbleTexts().some((t) => t.includes('Loading model on first run'))).toBe(true);
    resolveWarm?.();
    await flushMicrotasks();
    // And is gone once warmup resolves.
    expect(bubbleTexts().some((t) => t.includes('Loading model on first run'))).toBe(false);
  });

  it('gates the send button while warmupSession is in flight and re-enables it on completion', async () => {
    let resolveWarm: (() => void) | undefined;
    warmupSessionMock.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveWarm = r;
        }),
    );
    const deps = makeDeps();
    initSession(deps);
    const listener = getToggleListener();
    listener(TOGGLE_MESSAGE);
    // Mid-warmup: button is disabled with the Loading label; input stays editable.
    expect(deps._actionBtn.disabled).toBe(true);
    expect(deps._actionBtn.textContent).toBe('Loading ');
    expect(deps._actionBtn.querySelectorAll('.ln-dot')).toHaveLength(3);
    expect(deps._input.disabled).toBe(false);
    // An Enter keypress during warmup must NOT issue a stream request.
    deps._input.value = 'hi';
    deps._input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flushMicrotasks();
    expect(streamPromptMock).not.toHaveBeenCalled();
    expect(pending.length).toBe(0);
    // Warmup completes -> button returns to idle.
    resolveWarm?.();
    await flushMicrotasks();
    expect(deps._actionBtn.disabled).toBe(false);
    expect(deps._actionBtn.textContent).toBe('Send');
  });

  it('allows a retry on the next open if warmupSession rejects', async () => {
    warmupSessionMock.mockRejectedValueOnce(new Error('offscreen unavailable'));
    const deps = makeDeps();
    initSession(deps);
    const listener = getToggleListener();
    listener(TOGGLE_MESSAGE);
    await flushMicrotasks();
    expect(warmupSessionMock).toHaveBeenCalledTimes(1);
    // After failure the button is back to idle (not stuck on Loading…).
    expect(deps._actionBtn.disabled).toBe(false);
    // Closing and reopening retries the warmup.
    listener(TOGGLE_MESSAGE);
    listener(TOGGLE_MESSAGE);
    expect(warmupSessionMock).toHaveBeenCalledTimes(2);
  });
});

describe('initSession — streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending.length = 0;
  });

  it('prefixes the first turn with page context and sends just the text after', async () => {
    const deps = makeDeps();
    initSession(deps);

    // First send
    deps._input.value = 'question one';
    deps._actionBtn.click();
    const first = await awaitPending();
    expect(first.prompt).toContain('Page: Test Page');
    expect(first.prompt).toContain('URL: https://example.com/page');
    expect(first.prompt).toContain('question one');
    first.resolve('answer one');
    await flushMicrotasks();

    // Second send
    deps._input.value = 'question two';
    deps._actionBtn.click();
    const second = await awaitPending();
    expect(second.prompt).toBe('question two');
    expect(second.prompt).not.toContain('Page:');
    second.resolve('answer two');
    await flushMicrotasks();
  });

  it('renders chunks into the model response element via onChunk', async () => {
    const deps = makeDeps();
    initSession(deps);
    deps._input.value = 'hi';
    deps._actionBtn.click();
    const call = await awaitPending();
    expect(call.opts.onChunk).toBeTypeOf('function');
    call.opts.onChunk?.('one ');
    call.opts.onChunk?.('two ');
    call.opts.onChunk?.('three');
    // After 3 chunks fired, the model bubble should reflect the cumulative text
    const modelBubble = deps._messages.children[1];
    expect(modelBubble?.textContent).toBe('one two three');
    call.resolve('one two three');
    await flushMicrotasks();
  });

  it('persists model entry to history after a successful stream', async () => {
    const deps = makeDeps();
    initSession(deps);
    // Wait for the initial restore() to complete before triggering a send.
    // Otherwise the async restore can clobber the in-memory history mid-send
    // and we drop the user entry from the persisted record.
    await flushMicrotasks();
    deps._input.value = 'hi';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('the response');
    call.resolve('the response');
    await flushMicrotasks();
    const key = `local-nano:history:https://example.com/page`;
    const stored = chromeMock.storage.local.store[key] as Array<{ role: string; text: string }>;
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual({ role: 'user', text: 'hi' });
    expect(stored[1]).toEqual({ role: 'model', text: 'the response' });
  });

  it('renders the error text in the model bubble when streamPrompt rejects', async () => {
    const deps = makeDeps();
    initSession(deps);
    deps._input.value = 'hi';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.reject(new Error('model unavailable'));
    await flushMicrotasks();
    const modelBubble = deps._messages.children[1];
    expect(modelBubble?.textContent).toBe('model unavailable');
  });

  it('appends [stopped] when the user aborts mid-stream', async () => {
    const deps = makeDeps();
    initSession(deps);
    deps._input.value = 'hi';
    deps._actionBtn.click();
    const call = await awaitPending();
    // Simulate one chunk landing
    call.opts.onChunk?.('partial');
    // User clicks Stop — the button fires the abort
    deps._actionBtn.click();
    // The session's catch listens for AbortError specifically
    call.reject(new DOMException('Aborted', 'AbortError'));
    await flushMicrotasks();
    const modelBubble = deps._messages.children[1];
    expect(modelBubble?.textContent).toContain('partial');
    expect(modelBubble?.textContent).toContain('[stopped]');
  });

  it('rebuilds the session and retries when the first attempt reports WebGPU device loss', async () => {
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();

    deps._input.value = 'why is the sky blue';
    deps._actionBtn.click();
    const first = await awaitPending();

    first.reject(
      new Error(
        'Model returned no output (likely WebGPU device loss after tab/window switch). Rebuilding session; try again.',
      ),
    );

    const retry = await awaitPending();
    // Retry drops the page-context prefix and resends just the user text.
    expect(retry.prompt).toBe('why is the sky blue');

    expect(rebuildSessionMock).toHaveBeenCalledTimes(1);
    // History passed to rebuild excludes the just-added user turn (the
    // retried prompt re-introduces it via the polyfill).
    expect(rebuildSessionMock.mock.calls[0][0]).toEqual([]);

    retry.opts.onChunk?.('blue light scatters');
    retry.resolve('blue light scatters');
    await flushMicrotasks();

    // Rebuild hint was removed on the first retry chunk, so children
    // are [user, model] with the model bubble holding the retry output.
    const texts = Array.from(deps._messages.children).map((c) => c.textContent);
    expect(texts).toContain('blue light scatters');
  });

  it('does not retry when the error is not a device-loss', async () => {
    const deps = makeDeps();
    initSession(deps);
    deps._input.value = 'hi';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.reject(new Error('some other failure'));
    await flushMicrotasks();
    expect(rebuildSessionMock).not.toHaveBeenCalled();
    expect(pending.length).toBe(0);
    const modelBubble = deps._messages.children[1];
    expect(modelBubble?.textContent).toBe('some other failure');
  });

  it('blocks a second send while the first stream is still in flight', async () => {
    const deps = makeDeps();
    initSession(deps);
    deps._input.value = 'first';
    deps._actionBtn.click();
    const first = await awaitPending();
    // Try to send again while first is pending
    deps._input.value = 'second';
    deps._actionBtn.click();
    await flushMicrotasks();
    expect(pending.length).toBe(0);
    // Resolve the first
    first.resolve('done');
    await flushMicrotasks();
  });
});

// ---------------------------------------------------------------------------
// Selection mode — placeholder swap, Esc toggle, rewrite, ask, undo, chip
// ---------------------------------------------------------------------------

function makeFakeSnapshot(args: {
  text: string;
  before?: string;
  after?: string;
  container?: HTMLElement;
}): SelectionSnapshot {
  // Build a real DOM range so streamRewriteIntoRange can mutate it.
  const host = args.container ?? document.createElement('p');
  host.textContent = args.text;
  if (!args.container) document.body.appendChild(host);
  const textNode = host.firstChild as Text;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, args.text.length);
  return {
    text: args.text,
    before: args.before ?? '',
    after: args.after ?? '',
    range,
    undoAnchor: {
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
      originalText: args.text,
      insertedNode: null,
    },
  };
}

describe('initSession — selection mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending.length = 0;
    countTokensMock.mockImplementation(async (text: string) => Math.ceil(text.length / 3));
  });

  it('swaps the placeholder to Edit mode when a snapshot arrives', () => {
    const deps = makeDeps();
    initSession(deps);
    const snap = makeFakeSnapshot({ text: 'hello world' });
    deps._fireSelectionChange(snap);
    expect(deps._input.placeholder).toContain('Edit selection');
  });

  it('swaps back to chat default when snapshot becomes null', () => {
    const deps = makeDeps();
    initSession(deps);
    deps._fireSelectionChange(makeFakeSnapshot({ text: 'hi' }));
    deps._fireSelectionChange(null);
    expect(deps._input.placeholder).toContain('Ask anything');
  });

  it('Esc toggles to Ask mode when a selection is present', () => {
    const deps = makeDeps();
    initSession(deps);
    deps._fireSelectionChange(makeFakeSnapshot({ text: 'foo' }));
    const esc = new KeyboardEvent('keydown', { key: 'Escape' });
    deps._input.dispatchEvent(esc);
    expect(deps._input.placeholder).toContain('Ask about selection');
    deps._input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(deps._input.placeholder).toContain('Edit selection');
  });

  it('Esc with no selection is a no-op', () => {
    const deps = makeDeps();
    initSession(deps);
    const original = deps._input.placeholder;
    deps._input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(deps._input.placeholder).toBe(original);
  });

  it('rewrite send: prompt includes selection text, instruction, and soft-cap number', async () => {
    const deps = makeDeps();
    initSession(deps);
    const snap = makeFakeSnapshot({
      text: 'the quick brown fox',
      before: 'before-context',
      after: 'after-context',
    });
    deps._fireSelectionChange(snap);
    deps._input.value = 'make it crisper';
    deps._actionBtn.click();
    const call = await awaitPending();
    expect(call.prompt).toContain('the quick brown fox');
    expect(call.prompt).toContain('make it crisper');
    // soft cap = max(256, ceil(payload.length/3) * 2). For our payload,
    // that's well over 256 so the prompt should contain a numeric token
    // hint of some kind.
    expect(call.prompt).toMatch(/\d+ tokens/);
    call.opts.onChunk?.('CRISPER');
    call.resolve('CRISPER');
    await flushMicrotasks();
  });

  it('rewrite send: chunks land in both the chat bubble and the captured Range', async () => {
    const deps = makeDeps();
    initSession(deps);
    const host = document.createElement('p');
    host.textContent = 'original';
    document.body.appendChild(host);
    const textNode = host.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);
    const snap: SelectionSnapshot = {
      text: 'original',
      before: '',
      after: '',
      range,
      undoAnchor: {
        startContainer: range.startContainer,
        startOffset: 0,
        endContainer: range.endContainer,
        endOffset: textNode.data.length,
        originalText: 'original',
        insertedNode: null,
      },
    };
    deps._fireSelectionChange(snap);
    deps._input.value = 'rewrite please';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('REW');
    call.opts.onChunk?.('RITTEN');
    expect(host.textContent).toBe('REWRITTEN');
    call.resolve('REWRITTEN');
    await flushMicrotasks();
    // The model bubble holds the streamed model text plus an Undo button.
    // Read the text from the first text node to ignore the button label.
    const modelBubble = deps._messages.children[deps._messages.children.length - 1];
    const firstTextNode = Array.from(modelBubble.childNodes).find((n) => n.nodeType === 3);
    expect(firstTextNode?.textContent).toBe('REWRITTEN');
    expect(modelBubble.querySelector('button')).not.toBeNull();
  });

  it('rewrite send on success: Undo button appears and restores the original text', async () => {
    const deps = makeDeps();
    initSession(deps);
    const host = document.createElement('p');
    host.textContent = 'original';
    document.body.appendChild(host);
    const textNode = host.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);
    const snap: SelectionSnapshot = {
      text: 'original',
      before: '',
      after: '',
      range,
      undoAnchor: {
        startContainer: range.startContainer,
        startOffset: 0,
        endContainer: range.endContainer,
        endOffset: textNode.data.length,
        originalText: 'original',
        insertedNode: null,
      },
    };
    deps._fireSelectionChange(snap);
    deps._input.value = 'fix';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('NEW');
    call.resolve('NEW');
    await flushMicrotasks();
    const modelBubble = deps._messages.children[deps._messages.children.length - 1];
    const undoBtn = modelBubble.querySelector('button');
    expect(undoBtn).not.toBeNull();
    expect(host.textContent).toBe('NEW');
    undoBtn?.click();
    expect(host.textContent).toBe('original');
    expect(undoBtn?.textContent).toContain('Undone');
  });

  it('rewrite send on success persists both turns to chrome.storage.local under the per-URL key', async () => {
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();
    const host = document.createElement('p');
    host.textContent = 'orig';
    document.body.appendChild(host);
    const textNode = host.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);
    const snap: SelectionSnapshot = {
      text: 'orig',
      before: '',
      after: '',
      range,
      undoAnchor: {
        startContainer: range.startContainer,
        startOffset: 0,
        endContainer: range.endContainer,
        endOffset: textNode.data.length,
        originalText: 'orig',
        insertedNode: null,
      },
    };
    deps._fireSelectionChange(snap);
    deps._input.value = 'tighten this';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('TIGHT');
    call.resolve('TIGHT');
    await flushMicrotasks();
    const key = `local-nano:history:https://example.com/page`;
    const stored = chromeMock.storage.local.store[key] as Array<{ role: string; text: string }>;
    expect(stored).toBeTruthy();
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual({ role: 'user', text: 'tighten this' });
    expect(stored[1]).toEqual({ role: 'model', text: 'TIGHT' });
  });

  it('rewrite success: model bubble has both Undo and Accept buttons in that order', async () => {
    const deps = makeDeps();
    initSession(deps);
    const host = document.createElement('p');
    host.textContent = 'original';
    document.body.appendChild(host);
    const textNode = host.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);
    const snap: SelectionSnapshot = {
      text: 'original',
      before: '',
      after: '',
      range,
      undoAnchor: {
        startContainer: range.startContainer,
        startOffset: 0,
        endContainer: range.endContainer,
        endOffset: textNode.data.length,
        originalText: 'original',
        insertedNode: null,
      },
    };
    deps._fireSelectionChange(snap);
    deps._input.value = 'fix';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('NEW');
    call.resolve('NEW');
    await flushMicrotasks();
    const modelBubble = deps._messages.children[deps._messages.children.length - 1];
    const buttons = modelBubble.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toBe('Undo');
    expect(buttons[1].textContent).toBe('Accept');
  });

  it('Accept button removes the action bar and resets selection state', async () => {
    const deps = makeDeps();
    initSession(deps);
    const host = document.createElement('p');
    host.textContent = 'original';
    document.body.appendChild(host);
    const textNode = host.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);
    const snap: SelectionSnapshot = {
      text: 'original',
      before: '',
      after: '',
      range,
      undoAnchor: {
        startContainer: range.startContainer,
        startOffset: 0,
        endContainer: range.endContainer,
        endOffset: textNode.data.length,
        originalText: 'original',
        insertedNode: null,
      },
    };
    deps._fireSelectionChange(snap);
    deps._input.value = 'fix';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('NEW');
    call.resolve('NEW');
    await flushMicrotasks();

    // Simulate a stale snapshot lingering in session state — what would
    // happen if a selectionchange fired between sendRewrite finishing
    // and the user clicking Accept.
    deps._fireSelectionChange({
      ...snap,
      text: 'stale',
    });
    expect(deps._selectionChip.style.display).toBe('block');

    const modelBubble = deps._messages.children[deps._messages.children.length - 1];
    const acceptBtn = modelBubble.querySelectorAll('button')[1] as HTMLButtonElement;
    acceptBtn.click();

    // Bar is gone (no more buttons on this bubble).
    expect(modelBubble.querySelectorAll('button')).toHaveLength(0);
    // Selection state reset: chip hidden, placeholder back to chat.
    expect(deps._selectionChip.style.display).toBe('none');
    expect(deps._input.placeholder).not.toContain('Edit selection');
    expect(deps._input.placeholder).not.toContain('Ask about selection');
  });

  it('undo button after container removal changes to Undo failed', async () => {
    const deps = makeDeps();
    initSession(deps);
    const host = document.createElement('p');
    host.textContent = 'original';
    document.body.appendChild(host);
    const textNode = host.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);
    const snap: SelectionSnapshot = {
      text: 'original',
      before: '',
      after: '',
      range,
      undoAnchor: {
        startContainer: range.startContainer,
        startOffset: 0,
        endContainer: range.endContainer,
        endOffset: textNode.data.length,
        originalText: 'original',
        insertedNode: null,
      },
    };
    deps._fireSelectionChange(snap);
    deps._input.value = 'go';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('NEW');
    call.resolve('NEW');
    await flushMicrotasks();
    // Remove the host paragraph so the snapshot is detached.
    host.remove();
    const modelBubble = deps._messages.children[deps._messages.children.length - 1];
    const undoBtn = modelBubble.querySelector('button');
    undoBtn?.click();
    expect(undoBtn?.textContent).toContain('Undo failed');
  });

  it('Ask-mode send: prompt is the ask shape and does not mutate the DOM', async () => {
    const deps = makeDeps();
    initSession(deps);
    const host = document.createElement('p');
    host.textContent = 'photosynthesis';
    document.body.appendChild(host);
    const textNode = host.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);
    const snap: SelectionSnapshot = {
      text: 'photosynthesis',
      before: '',
      after: '',
      range,
      undoAnchor: {
        startContainer: range.startContainer,
        startOffset: 0,
        endContainer: range.endContainer,
        endOffset: textNode.data.length,
        originalText: 'photosynthesis',
        insertedNode: null,
      },
    };
    deps._fireSelectionChange(snap);
    // Toggle to ask mode.
    deps._input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    deps._input.value = 'what does this mean?';
    deps._actionBtn.click();
    const call = await awaitPending();
    expect(call.prompt).toContain('photosynthesis');
    expect(call.prompt).toContain('what does this mean?');
    expect(call.prompt.toLowerCase()).not.toContain('rewrite');
    call.opts.onChunk?.('A plant process.');
    call.resolve('A plant process.');
    await flushMicrotasks();
    // DOM should NOT have been mutated.
    expect(host.textContent).toBe('photosynthesis');
    // After the ask turn completes, mode resets to Edit.
    expect(deps._input.placeholder).toContain('Edit selection');
  });

  it('empty snapshot hides the chip; non-null snapshot shows a truncated preview', () => {
    const deps = makeDeps();
    initSession(deps);
    expect(deps._selectionChip.style.display).toBe('none');
    const longText = 'x'.repeat(120);
    deps._fireSelectionChange(makeFakeSnapshot({ text: longText }));
    expect(deps._selectionChip.style.display).not.toBe('none');
    expect(deps._selectionChip.textContent?.length).toBeLessThanOrEqual(63);
    deps._fireSelectionChange(null);
    expect(deps._selectionChip.style.display).toBe('none');
  });
});
