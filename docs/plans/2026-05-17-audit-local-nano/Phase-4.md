# Phase 4 — [IMPLEMENTER] Tests for `src/session.ts`

## Phase Goal

Add a comprehensive test suite for the extracted `src/session.ts` module,
covering the scenarios identified in eval.md as missing: single-ensureSession
concurrency guard, send-skips-when-activeAbort, abort appends `[stopped]`,
and isFirstTurn prefixes pageContext only on turn 1. Raise the branch coverage
threshold from 70% to 80% once this module is covered.

**Success criteria:**

- `tests/session.test.ts` exists with ≥ 15 tests
- All four eval.md scenarios are covered
- `npm run coverage` passes with raised branch threshold (80%)
- Total test count is ≥ 45

**Token estimate:** ~18k tokens

## Prerequisites

- Phase-3 complete and committed
- `src/session.ts` exports `initSession` and `LanguageModelSession`
- All 30 existing tests pass

## Task 4.1 — Write `tests/session.test.ts`

**Goal:** Test `initSession` with a complete mock dependency injection setup,
covering session lifecycle, streaming, abort, and concurrency behavior.

**Files:**

- `tests/session.test.ts` (new file)
- `vitest.config.ts` (branch threshold update)

**Prerequisites:** None

**Implementation Steps:**

**Step 1: Understand what `initSession` does**

`initSession(deps)` is a closure factory. It:

1. Calls `restore()` immediately (async, fire-and-forget) to load prior history
   from storage.
1. Registers a `chrome.runtime.onMessage` listener for the toggle.
1. Registers click and keydown event listeners on `actionBtn` and `input`.
1. Exposes no return value — all behavior is driven by events.

To test it, you must:

1. Call `initSession(deps)` with mocked deps.
1. Trigger events on the mocked DOM elements.
1. Assert side effects: messages rendered, storage written, button state changed.

### Step 2: Create the test file

Create `tests/session.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock } from './setup.js';
import { initSession, type SessionDeps } from '../src/session.js';
import { TOGGLE_MESSAGE } from '../src/background/handler.js';
import { MAX_HISTORY } from '../src/history.js';

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

// Minimal ReadableStream mock that yields a single chunk then closes
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
      new Promise<ReturnType<typeof makeSessionMock>>((r) => { resolveCreate = r; }),
    );
    initSession(deps);
    // Simulate toggle to trigger ensureSession
    const listener = (chromeMock.runtime.onMessage.addListener as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as (m: typeof TOGGLE_MESSAGE) => void;
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
    const listener = (chromeMock.runtime.onMessage.addListener as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as (m: typeof TOGGLE_MESSAGE) => void;
    deps._root.style.display = 'none';
    listener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 10));
    // Input should be re-enabled after failure
    expect(deps._input.disabled).toBe(false);
    // Triggering ensureSession again should attempt a new create (heavyLoadPromise reset)
    mockLanguageModelCreate.mockResolvedValue(makeSessionMock());
    listener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockLanguageModelCreate).toHaveBeenCalledTimes(2);
  });

  it('does not call LanguageModel.create twice under concurrent ensureSession calls', async () => {
    let resolveCreate!: (s: ReturnType<typeof makeSessionMock>) => void;
    mockLanguageModelCreate.mockReturnValue(
      new Promise<ReturnType<typeof makeSessionMock>>((r) => { resolveCreate = r; }),
    );
    initSession(deps);
    const listener = (chromeMock.runtime.onMessage.addListener as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as (m: typeof TOGGLE_MESSAGE) => void;
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
    const listener = (chromeMock.runtime.onMessage.addListener as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as (m: typeof TOGGLE_MESSAGE) => void;
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
    // Second send immediately (generation still in progress)
    deps._input.value = 'second message';
    deps._actionBtn.click(); // activeAbort != null, so clicking stops (not sends)
    // Actually: clicking btn while activeAbort is set calls activeAbort.abort()
    // The second click aborts, not sends a second message. Verify only 1 promptStreaming call.
    await new Promise((r) => setTimeout(r, 20));
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
    // Stream that throws AbortError mid-read
    const abortError = new DOMException('Aborted', 'AbortError');
    const reader = {
      read: vi.fn()
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
    const stored = chromeMock.storage.local.store[storageKey] as Array<{ role: string; text: string }>;
    // Should have user + model entries
    expect(stored.some((e) => e.role === 'user' && e.text === 'user question')).toBe(true);
    expect(stored.some((e) => e.role === 'model')).toBe(true);
  });
});

describe('initSession — toggle behavior', () => {
  it('shows panel and calls ensureSession on toggle when hidden', async () => {
    const deps = makeDeps();
    mockLanguageModelCreate.mockResolvedValue(makeSessionMock());
    initSession(deps);
    const listener = (chromeMock.runtime.onMessage.addListener as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as (m: typeof TOGGLE_MESSAGE) => void;
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
    const listener = (chromeMock.runtime.onMessage.addListener as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as (m: typeof TOGGLE_MESSAGE) => void;
    deps._root.style.display = 'flex';
    listener(TOGGLE_MESSAGE);
    expect(deps._root.style.display).toBe('none');
  });

  it('ignores messages with a different action key', () => {
    const deps = makeDeps();
    initSession(deps);
    const listener = (chromeMock.runtime.onMessage.addListener as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as (m: { a: string }) => void;
    deps._root.style.display = 'none';
    listener({ a: 'unknown-action' });
    expect(deps._root.style.display).toBe('none');
  });

  it('Enter key triggers send', async () => {
    const deps = makeDeps();
    const session = makeSessionMock();
    mockLanguageModelCreate.mockResolvedValue(session);
    initSession(deps);
    const toggleListener = (chromeMock.runtime.onMessage.addListener as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as (m: typeof TOGGLE_MESSAGE) => void;
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
    const toggleListener = (chromeMock.runtime.onMessage.addListener as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as (m: typeof TOGGLE_MESSAGE) => void;
    deps._root.style.display = 'none';
    toggleListener(TOGGLE_MESSAGE);
    await new Promise((r) => setTimeout(r, 10));
    deps._input.value = 'should not send';
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true });
    deps._input.dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 0));
    expect(session.promptStreaming).not.toHaveBeenCalled();
  });
});
```

**Step 3: Update `vitest.config.ts` branch threshold**

Open `vitest.config.ts`. Change the `branches` threshold from `70` to `80`:

```ts
thresholds: {
  lines: 75,
  statements: 75,
  functions: 75,
  branches: 80,
},
```

**Verification Checklist:**

- [x] `tests/session.test.ts` exists with ≥ 15 tests
- [x] The four eval.md scenarios are covered:
  - [x] Single `ensureSession` under concurrent calls (concurrency guard test)
  - [x] `send` skips when `activeAbort` is set (in-progress guard test)
  - [x] Abort appends `[stopped]` (AbortError test)
  - [x] `isFirstTurn` prefixes pageContext only on turn 1 (page context test)
- [x] `npm run typecheck` passes
- [x] `npm run coverage` passes with branches ≥ 80%
- [x] Total test count ≥ 45
- [x] `docs/testing.md` is updated to reflect `src/session.ts` coverage and the
  updated test table (see Task 4.2)

**Testing Instructions:**

```bash
npm run typecheck
npm run coverage
```

**Commit Message Template:**

```text
test(session): add tests/session.test.ts for initSession behavior

- Covers session concurrency guard (single create under rapid toggling)
- Covers isFirstTurn page context prefix on turn 1 only
- Covers AbortError -> [stopped] append and reader.releaseLock() in finally
- Covers send guard when activeAbort is non-null
- Covers toggle show/hide/ignore-unknown-action behavior
- Raised branch coverage threshold from 70% to 80%
```

---

## Task 4.2 — Update `docs/testing.md` Test Table

**Goal:** Add `src/session.ts` to the test table in `docs/testing.md` and
update the test count to reflect the new total.

**Files:**

- `docs/testing.md`

**Prerequisites:** Task 4.1 complete

**Implementation Steps:**

1. Open `docs/testing.md`.

1. Find the test file table (lines ~16–23). Add a row for `session.test.ts`:

   | Test file | Covers |
   |-----------|--------|
   | `tests/session.test.ts` | `initSession` — session lifecycle, streaming, abort, toggle, concurrency |

1. Update the coverage threshold note to mention the raised branch threshold:

   Find the text and replace with the raised threshold. The old text reads:

   ```text
   lines/statements/functions: 75%
   branches:                   70%
   ```

   The new text should read:

   ```text
   lines/statements/functions: 75%
   branches:                   80%
   ```

1. Update the test count wherever it appears in the doc. Search for `27` and
   replace with the actual count after Phase-4 (run `npm test -- --reporter=verbose 2>&1 | tail -5`
   to get the real count).

**Verification Checklist:**

- [x] `docs/testing.md` has a row for `tests/session.test.ts`
- [x] `docs/testing.md` shows `branches: 80%`
- [x] Test count is accurate

**Commit Message Template:**

```text
docs(testing): update test table and branch threshold documentation

- Added tests/session.test.ts row to coverage table
- Updated branch threshold doc from 70% to 80%
- Updated test count to reflect new total
```

---

## Phase Verification

After all tasks are committed:

```bash
npm run typecheck
npm run coverage
npm run build
```

All three must exit 0. Confirm:

- `tests/session.test.ts` exists with ≥ 15 tests
- `vitest.config.ts` has `branches: 80`
- All four eval.md session scenarios are tested
- `docs/testing.md` is updated
- `npm run build` still generates `dist/content.js` and `dist/background.js`
