import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOGGLE_MESSAGE } from '../src/background/handler.js';
import { MAX_HISTORY } from '../src/history.js';
import { initSession, type SessionDeps } from '../src/session.js';
import { chromeMock } from './setup.js';

// ---------------------------------------------------------------------------
// Mock the dynamic imports inside loadHeavy()
// ---------------------------------------------------------------------------

// Minimal LanguageModelSession mock
function makeSessionMock() {
  return {
    promptStreaming: vi.fn(),
    destroy: vi.fn(),
  };
}

// Minimal ReadableStream mock that yields chunks then closes
function makeStream(chunks: string[]) {
  let idx = 0;
  const reader = {
    read: vi.fn(async () => {
      if (idx < chunks.length) return { done: false, value: chunks[idx++] };
      return { done: true, value: undefined };
    }),
    releaseLock: vi.fn(),
  };
  return {
    getReader: () => reader,
    _reader: reader, // exposed for assertions
  };
}

// Stub the dynamic imports at the module level
vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { wasm: { wasmPaths: '', numThreads: 0 } } } },
}));

vi.mock('../vendor/prompt-api-polyfill/prompt-api-polyfill.js', () => ({
  LanguageModel: {
    create: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helper: build a minimal SessionDeps with real JSDOM elements
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
    transformersConfig: {
      apiKey: 'dummy',
      device: 'wasm',
      dtype: 'q8',
      modelName: 'test-model',
    },
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

// ---------------------------------------------------------------------------
// Import the mocked polyfill for controlling LanguageModel.create
// ---------------------------------------------------------------------------
import * as polyfillMod from '../vendor/prompt-api-polyfill/prompt-api-polyfill.js';

const mockLanguageModelCreate = polyfillMod.LanguageModel.create as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helper to get the registered toggle listener
// ---------------------------------------------------------------------------
function getToggleListener(): (m: typeof TOGGLE_MESSAGE) => void {
  const calls = (chromeMock.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0] as (m: typeof TOGGLE_MESSAGE) => void;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initSession — session lifecycle', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(async () => {
    vi.clearAllMocks();
    deps = makeDeps();
    // Default: LanguageModel.create succeeds immediately
    mockLanguageModelCreate.mockResolvedValue(makeSessionMock());
  });

  it('restores history on init and renders stored messages', async () => {
    const key = `local-nano:history:https://example.com/page`;
    chromeMock.storage.local.store[key] = [
      { role: 'user', text: 'hello' },
      { role: 'model', text: 'world' },
    ];
    initSession(deps);
    // Wait for restore() microtask to complete
    await new Promise((r) => setTimeout(r, 0));
    // Two message divs should have been appended to messages container
    expect(deps._messages.children.length).toBe(2);
    expect(deps._messages.children[0].textContent).toBe('hello');
    expect(deps._messages.children[1].textContent).toBe('world');
  });

  it('disables input while session is loading', async () => {
    // Create resolves after we check
    let resolveCreate!: (s: ReturnType<typeof makeSessionMock>) => void;
    mockLanguageModelCreate.mockReturnValue(
      new Promise<ReturnType<typeof makeSessionMock>>((r) => {
        resolveCreate = r;
      }),
    );
    initSession(deps);
    // Simulate toggle to trigger ensureSession
    const listener = getToggleListener();
    deps._root.style.display = 'none';
    listener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._input.disabled).toBe(true);
    // Now resolve
    resolveCreate(makeSessionMock());
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._input.disabled).toBe(false);
  });

  it('re-enables input and resets heavyLoadPromise on session creation failure', async () => {
    mockLanguageModelCreate.mockRejectedValue(new Error('Model unavailable'));
    initSession(deps);
    const listener = getToggleListener();
    // First toggle: panel hidden → show, triggers ensureSession → fails
    deps._root.style.display = 'none';
    listener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 10));
    // Input should be re-enabled after failure
    expect(deps._input.disabled).toBe(false);
    // Triggering ensureSession again should attempt a new create (heavyLoadPromise reset).
    // Must hide the panel first so the toggle shows it again and calls ensureSession.
    mockLanguageModelCreate.mockResolvedValue(makeSessionMock());
    deps._root.style.display = 'none';
    listener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockLanguageModelCreate).toHaveBeenCalledTimes(2);
  });

  it('does not call LanguageModel.create twice under concurrent ensureSession calls', async () => {
    let resolveCreate!: (s: ReturnType<typeof makeSessionMock>) => void;
    mockLanguageModelCreate.mockReturnValue(
      new Promise<ReturnType<typeof makeSessionMock>>((r) => {
        resolveCreate = r;
      }),
    );
    initSession(deps);
    const listener = getToggleListener();
    // Trigger toggle twice rapidly
    deps._root.style.display = 'none';
    listener(TOGGLE_MESSAGE);
    deps._root.style.display = 'none';
    listener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 0));
    // create should only have been called once despite two triggers
    expect(mockLanguageModelCreate).toHaveBeenCalledTimes(1);
    resolveCreate(makeSessionMock());
  });

  it('shows "Loading model…" status message while session creates', async () => {
    let resolveCreate!: (s: ReturnType<typeof makeSessionMock>) => void;
    mockLanguageModelCreate.mockReturnValue(
      new Promise<ReturnType<typeof makeSessionMock>>((r) => {
        resolveCreate = r;
      }),
    );
    initSession(deps);
    const listener = getToggleListener();
    deps._root.style.display = 'none';
    listener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 0));
    const statusEl = deps._messages.lastElementChild as HTMLElement;
    expect(statusEl.textContent).toContain('Loading model');
    resolveCreate(makeSessionMock());
    await new Promise((r) => setTimeout(r, 10));
    expect(statusEl.textContent).toBe('Ready.');
  });

  it('shows error message on session creation failure', async () => {
    mockLanguageModelCreate.mockRejectedValue(new Error('GPU not available'));
    initSession(deps);
    const listener = getToggleListener();
    deps._root.style.display = 'none';
    listener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 10));
    const statusEl = deps._messages.lastElementChild as HTMLElement;
    expect(statusEl.textContent).toContain('GPU not available');
  });
});

describe('initSession — send behavior', () => {
  let deps: ReturnType<typeof makeDeps>;
  let sessionMock: ReturnType<typeof makeSessionMock>;

  async function setupWithSession() {
    deps = makeDeps();
    sessionMock = makeSessionMock();
    mockLanguageModelCreate.mockResolvedValue(sessionMock);
    initSession(deps);
    // Trigger toggle to start ensureSession
    const listener = getToggleListener();
    deps._root.style.display = 'none';
    listener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 10));
    // Session should now be ready
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips send when activeAbort is non-null (in-progress generation)', async () => {
    await setupWithSession();
    const stream = makeStream(['chunk1', 'chunk2']);
    sessionMock.promptStreaming.mockReturnValue(stream);
    // First send — starts generation
    deps._input.value = 'first message';
    deps._actionBtn.click(); // starts generation, sets activeAbort
    // Second click while generation in progress — activeAbort != null, so this aborts not sends
    deps._input.value = 'second message';
    deps._actionBtn.click(); // clicks abort, not send
    await new Promise((r) => setTimeout(r, 20));
    // promptStreaming called only once — second click aborted, not re-sent
    expect(sessionMock.promptStreaming).toHaveBeenCalledTimes(1);
  });

  it('skips send when input is empty', async () => {
    await setupWithSession();
    deps._input.value = '   ';
    deps._actionBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(sessionMock.promptStreaming).not.toHaveBeenCalled();
  });

  it('skips send when session is null', async () => {
    // initSession but do NOT trigger ensureSession
    deps = makeDeps();
    mockLanguageModelCreate.mockResolvedValue(makeSessionMock());
    initSession(deps);
    deps._input.value = 'hello';
    deps._actionBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockLanguageModelCreate).not.toHaveBeenCalled();
  });

  it('prefixes pageContext on isFirstTurn only', async () => {
    await setupWithSession();
    const stream = makeStream(['response']);
    sessionMock.promptStreaming.mockReturnValue(stream);
    // First send
    deps._input.value = 'first question';
    deps._actionBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    const firstCallArg = sessionMock.promptStreaming.mock.calls[0][0] as string;
    expect(firstCallArg).toContain('Page: Test Page');
    expect(firstCallArg).toContain('first question');
    // Second send — should NOT include page context
    const stream2 = makeStream(['response2']);
    sessionMock.promptStreaming.mockReturnValue(stream2);
    deps._input.value = 'follow-up';
    deps._actionBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    const secondCallArg = sessionMock.promptStreaming.mock.calls[1][0] as string;
    expect(secondCallArg).toBe('follow-up');
    expect(secondCallArg).not.toContain('Page:');
  });

  it('appends [stopped] on AbortError', async () => {
    await setupWithSession();
    // Stream that throws an AbortError mid-read.
    // Use a plain Error with name 'AbortError' rather than DOMException because
    // jsdom's DOMException is not instanceof Error in the vitest environment.
    const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: 'partial' })
        .mockRejectedValueOnce(abortError),
      releaseLock: vi.fn(),
    };
    sessionMock.promptStreaming.mockReturnValue({ getReader: () => reader });
    deps._input.value = 'test abort';
    deps._actionBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    // Find the model response element (last child of messages after 'user' message)
    const responseEl = deps._messages.lastElementChild as HTMLElement;
    expect(responseEl.textContent).toContain('[stopped]');
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it('removes the typing indicator when the stream yields zero chunks', async () => {
    await setupWithSession();
    // Stream closes immediately with no values
    const emptyStream = makeStream([]);
    sessionMock.promptStreaming.mockReturnValue(emptyStream);
    deps._input.value = 'will get an empty reply';
    deps._actionBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    // The model bubble is the last child; it must contain no `.ln-dot`
    // descendants once the stream finishes.
    const responseEl = deps._messages.lastElementChild as HTMLElement;
    expect(responseEl.querySelectorAll('.ln-dot').length).toBe(0);
  });

  it('calls reader.releaseLock() even when stream errors', async () => {
    await setupWithSession();
    const reader = {
      read: vi.fn().mockRejectedValue(new Error('stream error')),
      releaseLock: vi.fn(),
    };
    sessionMock.promptStreaming.mockReturnValue({ getReader: () => reader });
    deps._input.value = 'trigger error';
    deps._actionBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it('persists model response after successful stream', async () => {
    await setupWithSession();
    const stream = makeStream(['hello world']);
    sessionMock.promptStreaming.mockReturnValue(stream);
    deps._input.value = 'user question';
    deps._actionBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    const storageKey = 'local-nano:history:https://example.com/page';
    const stored = chromeMock.storage.local.store[storageKey] as Array<{
      role: string;
      text: string;
    }>;
    // Should have user + model entries
    expect(stored.some((e) => e.role === 'user' && e.text === 'user question')).toBe(true);
    expect(stored.some((e) => e.role === 'model')).toBe(true);
  });

  it('renders user message immediately when send is called', async () => {
    await setupWithSession();
    const stream = makeStream(['the answer']);
    sessionMock.promptStreaming.mockReturnValue(stream);
    deps._input.value = 'my question';
    deps._actionBtn.click();
    // Give one microtask tick — user message rendered synchronously before await
    await new Promise((r) => setTimeout(r, 0));
    const userEl = Array.from(deps._messages.children).find(
      (el) => el.textContent === 'my question',
    );
    expect(userEl).toBeDefined();
  });

  it('clears input value after send', async () => {
    await setupWithSession();
    const stream = makeStream(['reply']);
    sessionMock.promptStreaming.mockReturnValue(stream);
    deps._input.value = 'some text';
    deps._actionBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._input.value).toBe('');
  });

  it('respects MAX_HISTORY by not exceeding the cap in storage', async () => {
    // Pre-populate history with MAX_HISTORY entries
    const key = 'local-nano:history:https://example.com/page';
    chromeMock.storage.local.store[key] = Array.from({ length: MAX_HISTORY }, (_, k) => ({
      role: k % 2 === 0 ? 'user' : 'model',
      text: `msg ${k}`,
    }));

    await setupWithSession();
    const stream = makeStream(['new answer']);
    sessionMock.promptStreaming.mockReturnValue(stream);
    deps._input.value = 'new question';
    deps._actionBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    const stored = chromeMock.storage.local.store[key] as Array<{ role: string; text: string }>;
    expect(stored.length).toBeLessThanOrEqual(MAX_HISTORY);
  });

  it('trims oversized restored history to MAX_HISTORY on the first persist', async () => {
    // Storage somehow contains more than MAX_HISTORY entries (e.g. from a
    // prior buggy write). Restore must clamp the in-memory array; otherwise
    // the next persist re-writes the oversized history back to storage,
    // and the array grows unbounded during the session.
    const key = 'local-nano:history:https://example.com/page';
    const oversized = MAX_HISTORY + 50;
    chromeMock.storage.local.store[key] = Array.from({ length: oversized }, (_, k) => ({
      role: k % 2 === 0 ? 'user' : 'model',
      text: `msg ${k}`,
    }));

    await setupWithSession();
    const stream = makeStream(['fresh answer']);
    sessionMock.promptStreaming.mockReturnValue(stream);
    deps._input.value = 'fresh question';
    deps._actionBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    const stored = chromeMock.storage.local.store[key] as Array<{ role: string; text: string }>;
    expect(stored.length).toBe(MAX_HISTORY);
    // Oldest entries dropped; newest (user + model) retained at the tail
    expect(stored[stored.length - 2]).toEqual({ role: 'user', text: 'fresh question' });
    expect(stored[stored.length - 1].role).toBe('model');
  });
});

describe('initSession — toggle behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows panel and calls ensureSession on toggle when hidden', async () => {
    const deps = makeDeps();
    mockLanguageModelCreate.mockResolvedValue(makeSessionMock());
    initSession(deps);
    const listener = getToggleListener();
    deps._root.style.display = 'none';
    listener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 10));
    expect(deps._root.style.display).toBe('flex');
    expect(mockLanguageModelCreate).toHaveBeenCalledTimes(1);
  });

  it('hides panel on toggle when visible', () => {
    const deps = makeDeps();
    mockLanguageModelCreate.mockResolvedValue(makeSessionMock());
    initSession(deps);
    const listener = getToggleListener();
    deps._root.style.display = 'flex';
    listener(TOGGLE_MESSAGE);
    expect(deps._root.style.display).toBe('none');
  });

  it('ignores messages with a different action key', () => {
    const deps = makeDeps();
    initSession(deps);
    const listener = getToggleListener() as unknown as (m: { a: string }) => void;
    deps._root.style.display = 'none';
    listener({ a: 'unknown-action' });
    expect(deps._root.style.display).toBe('none');
  });

  it('Enter key triggers send', async () => {
    const deps = makeDeps();
    const session = makeSessionMock();
    mockLanguageModelCreate.mockResolvedValue(session);
    initSession(deps);
    const toggleListener = getToggleListener();
    deps._root.style.display = 'none';
    toggleListener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 10));
    const stream = makeStream(['response']);
    session.promptStreaming.mockReturnValue(stream);
    deps._input.value = 'keyboard send';
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true });
    deps._input.dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 20));
    expect(session.promptStreaming).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter does not trigger send', async () => {
    const deps = makeDeps();
    const session = makeSessionMock();
    mockLanguageModelCreate.mockResolvedValue(session);
    initSession(deps);
    const toggleListener = getToggleListener();
    deps._root.style.display = 'none';
    toggleListener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 10));
    deps._input.value = 'should not send';
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true });
    deps._input.dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 0));
    expect(session.promptStreaming).not.toHaveBeenCalled();
  });

  it('does not call ensureSession on hide toggle (panel visible)', async () => {
    const deps = makeDeps();
    mockLanguageModelCreate.mockResolvedValue(makeSessionMock());
    initSession(deps);
    const listener = getToggleListener();
    // Toggle when visible — should hide, not trigger ensureSession
    deps._root.style.display = 'flex';
    listener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 10));
    expect(deps._root.style.display).toBe('none');
    expect(mockLanguageModelCreate).not.toHaveBeenCalled();
  });
});
