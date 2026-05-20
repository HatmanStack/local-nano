import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOGGLE_MESSAGE } from '../src/background/handler.js';
import { MAX_HISTORY } from '../src/history.js';
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
}));

import {
  rebuildSession as mockedRebuildSession,
  streamPrompt as mockedStreamPrompt,
} from '../src/offscreen/client.js';

const streamPromptMock = mockedStreamPrompt as unknown as ReturnType<typeof vi.fn>;
const rebuildSessionMock = mockedRebuildSession as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(): SessionDeps & {
  _root: HTMLDivElement;
  _messages: HTMLDivElement;
  _input: HTMLInputElement;
  _actionBtn: HTMLButtonElement;
} {
  const _root = document.createElement('div');
  _root.style.display = 'none';
  const _messages = document.createElement('div');
  const _input = document.createElement('input');
  const _actionBtn = document.createElement('button');
  _root.append(_messages, _input, _actionBtn);
  document.body.appendChild(_root);

  return {
    root: _root,
    messages: _messages,
    input: _input,
    actionBtn: _actionBtn,
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
