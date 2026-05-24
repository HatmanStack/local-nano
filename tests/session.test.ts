import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOGGLE_MESSAGE } from '../src/background/handler.js';
import { MAX_HISTORY } from '../src/history.js';
import type { SelectionSnapshot } from '../src/selection-rewrite.js';
import {
  deriveHistoryThreshold,
  initSession,
  preflightWarning,
  type SessionDeps,
} from '../src/session.js';
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
  recreateOffscreen: vi.fn(() => Promise.resolve()),
  countTokens: vi.fn(async (text: string) => Math.ceil(text.length / 3)),
  warmupSession: vi.fn(() => Promise.resolve()),
  getGpuInfo: vi.fn(async () => ({
    device: 'webgpu' as const,
    isFallback: false,
    maxBufferSize: null,
    configuredThreshold: null,
  })),
}));

import {
  countTokens as mockedCountTokens,
  getGpuInfo as mockedGetGpuInfo,
  rebuildSession as mockedRebuildSession,
  recreateOffscreen as mockedRecreateOffscreen,
  streamPrompt as mockedStreamPrompt,
  warmupSession as mockedWarmupSession,
} from '../src/offscreen/client.js';

const streamPromptMock = mockedStreamPrompt as unknown as ReturnType<typeof vi.fn>;
const rebuildSessionMock = mockedRebuildSession as unknown as ReturnType<typeof vi.fn>;
const recreateOffscreenMock = mockedRecreateOffscreen as unknown as ReturnType<typeof vi.fn>;
const countTokensMock = mockedCountTokens as unknown as ReturnType<typeof vi.fn>;
const warmupSessionMock = mockedWarmupSession as unknown as ReturnType<typeof vi.fn>;
const getGpuInfoMock = mockedGetGpuInfo as unknown as ReturnType<typeof vi.fn>;

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

  it('re-seeds the offscreen session with restored user/model turns (system dropped)', async () => {
    const key = `local-nano:history:https://example.com/page`;
    chromeMock.storage.local.store[key] = [
      { role: 'user', text: 'hello' },
      { role: 'system', text: 'a transient notice' },
      { role: 'model', text: 'world' },
    ];
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();
    // The single shared offscreen session is re-seeded with this URL's
    // conversation so a follow-up has context. System entries are dropped
    // (HistoryTurn only accepts user/model).
    expect(rebuildSessionMock).toHaveBeenCalledTimes(1);
    expect(rebuildSessionMock).toHaveBeenCalledWith([
      { role: 'user', text: 'hello' },
      { role: 'model', text: 'world' },
    ]);
  });

  it('does not re-seed when there is no stored history', async () => {
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();
    expect(rebuildSessionMock).not.toHaveBeenCalled();
  });

  it('still renders and does not throw when the re-seed rejects', async () => {
    rebuildSessionMock.mockRejectedValueOnce(new Error('offscreen not ready'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const key = `local-nano:history:https://example.com/page`;
      chromeMock.storage.local.store[key] = [
        { role: 'user', text: 'hi' },
        { role: 'model', text: 'there' },
      ];
      const deps = makeDeps();
      initSession(deps);
      await flushMicrotasks();
      // History is still rendered (degrade to render-only).
      expect(deps._messages.children.length).toBe(2);
      expect(deps._messages.children[0].textContent).toBe('hi');
      expect(rebuildSessionMock).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
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
    await flushMicrotasks(); // getGpuInfo preflight resolves before warmupSession is invoked
    expect(warmupSessionMock).toHaveBeenCalledTimes(1);
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
    await flushMicrotasks(); // preflight resolves, then warmupSession is invoked
    expect(warmupSessionMock).toHaveBeenCalledTimes(1);
    listener(TOGGLE_MESSAGE); // close
    listener(TOGGLE_MESSAGE); // re-open
    await flushMicrotasks();
    expect(warmupSessionMock).toHaveBeenCalledTimes(1);
    resolveWarm?.();
    await flushMicrotasks();
    listener(TOGGLE_MESSAGE); // close
    listener(TOGGLE_MESSAGE); // re-open after warm done
    await flushMicrotasks();
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
    // System bubble (with the elapsed counter) lives while warmup is in flight.
    const bubbleTexts = () => Array.from(deps._messages.children).map((c) => c.textContent ?? '');
    expect(bubbleTexts().some((t) => t.includes('Loading model…'))).toBe(true);
    await flushMicrotasks(); // preflight resolves so warmupSession is invoked (sets resolveWarm)
    resolveWarm?.();
    await flushMicrotasks();
    // And is gone once warmup resolves.
    expect(bubbleTexts().some((t) => t.includes('Loading model…'))).toBe(false);
  });

  it('ticks the elapsed counter and appends remedies if the load drags', async () => {
    vi.useFakeTimers();
    try {
      let resolveWarm: (() => void) | undefined;
      warmupSessionMock.mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolveWarm = r;
          }),
      );
      const deps = makeDeps();
      initSession(deps);
      getToggleListener()(TOGGLE_MESSAGE);
      const bubble = () =>
        Array.from(deps._messages.children)
          .map((c) => c.textContent ?? '')
          .find((t) => t.includes('Loading model…')) ?? '';
      // Counter advances.
      await vi.advanceTimersByTimeAsync(3000);
      expect(bubble()).toMatch(/Loading model… \ds/);
      // After the slow-notice threshold, remedies appear but the load is
      // not failed — the bubble still says it's loading.
      await vi.advanceTimersByTimeAsync(45000);
      expect(bubble()).toContain('Taking longer than usual');
      expect(bubble()).toContain('wasm');
      expect(bubble()).toContain('Loading model…');
      resolveWarm?.();
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
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

  it('resets warmStarted after a full ladder failure so a reopen re-runs ensureWarm', async () => {
    // Reject every tier on the first walk so the panel reaches the terminal
    // bubble. Persistence records all four tiers known-bad, so the reopen
    // re-runs the ladder but skips every (known-bad) tier and re-exhausts
    // immediately, re-rendering the terminal bubble — proving warmStarted was
    // reset and the cycle is not dead.
    warmupSessionMock.mockRejectedValue(new Error('offscreen unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const deps = makeDeps();
      initSession(deps);
      const listener = getToggleListener();
      listener(TOGGLE_MESSAGE);
      await flushMicrotasks(15);
      // One full ladder walk = PRIMARY_LADDER.length attempts.
      expect(warmupSessionMock).toHaveBeenCalledTimes(4);
      // After full failure the button is back to idle (not stuck on Loading…).
      expect(deps._actionBtn.disabled).toBe(false);
      const terminalCount = () =>
        Array.from(deps._messages.children).filter((c) =>
          (c.textContent ?? '').includes("Couldn't load the model on this device."),
        ).length;
      expect(terminalCount()).toBe(1);
      // Closing and reopening re-runs ensureWarm. All four tiers are known-bad
      // (persisted), so no warmup re-fires, but a fresh terminal bubble appears.
      listener(TOGGLE_MESSAGE);
      listener(TOGGLE_MESSAGE);
      await flushMicrotasks(15);
      // No additional warmup attempts (every tier is known-bad).
      expect(warmupSessionMock).toHaveBeenCalledTimes(4);
      // The reopen re-rendered a terminal bubble (warmStarted was reset).
      expect(terminalCount()).toBe(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('surfaces a terminal bubble with a diagnostic and both controls when the ladder is exhausted', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      warmupSessionMock.mockRejectedValue(new Error('offscreen port disconnected: unknown reason'));
      const deps = makeDeps();
      initSession(deps);
      getToggleListener()(TOGGLE_MESSAGE);
      await flushMicrotasks();
      // The transient loading bubble is gone; the terminal bubble is shown.
      const texts = Array.from(deps._messages.children).map((c) => c.textContent ?? '');
      expect(texts.some((t) => t.includes('Loading model…'))).toBe(false);
      const terminal = Array.from(deps._messages.children).find((c) =>
        (c.textContent ?? '').includes("Couldn't load the model on this device."),
      );
      expect(terminal).toBeTruthy();
      const txt = terminal?.textContent ?? '';
      // Headline + guidance + diagnostic block embedded.
      expect(txt).toContain('set "device": "wasm" in .env.json');
      expect(txt).toContain('device: webgpu');
      expect(txt).toContain('errorMessage: offscreen port disconnected: unknown reason');
      expect(txt).toContain('extensionVersion: 0.2.4');
      // The active tier in the diagnostic is the last (wasm) tier tried.
      expect(txt).toContain('activeTier: onnx-community/gemma-4-E2B-it-ONNX/wasm/q8');
      // The ladder path is listed.
      expect(txt).toContain('Tiers tried:');
      // It has Retry and Reset-and-re-detect controls.
      const buttons = Array.from(terminal?.querySelectorAll('button') ?? []).map(
        (b) => b.textContent,
      );
      expect(buttons).toEqual(['Retry', 'Reset and re-detect']);
      // Button is back to idle (the finally ran).
      expect(deps._actionBtn.disabled).toBe(false);
      expect(deps._actionBtn.textContent).toBe('Send');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('Retry force-recreates and re-walks, skipping known-bad tiers (re-exhausts after a full failure)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      warmupSessionMock.mockRejectedValue(new Error('the message channel closed'));
      const deps = makeDeps();
      initSession(deps);
      getToggleListener()(TOGGLE_MESSAGE);
      await flushMicrotasks();
      const terminal = Array.from(deps._messages.children).find((c) =>
        (c.textContent ?? '').includes("Couldn't load the model on this device."),
      );
      const retryBtn = terminal?.querySelector('button') as HTMLButtonElement;
      expect(retryBtn?.textContent).toBe('Retry');
      const recreateBefore = recreateOffscreenMock.mock.calls.length;
      const warmupBefore = warmupSessionMock.mock.calls.length;
      retryBtn.click();
      await flushMicrotasks();
      // Retry force-recreates the document before re-walking (ADR-R4).
      expect(recreateOffscreenMock.mock.calls.length).toBe(recreateBefore + 1);
      // All four tiers are persisted known-bad, so the re-walk skips every tier
      // and never re-attempts warmup — it reaches exhaustion immediately.
      expect(warmupSessionMock.mock.calls.length).toBe(warmupBefore);
      // The terminal bubble is shown again with fresh controls.
      const stillTerminal = Array.from(deps._messages.children).find((c) =>
        (c.textContent ?? '').includes("Couldn't load the model on this device."),
      );
      expect(stillTerminal).toBeTruthy();
      const buttons = Array.from(stillTerminal?.querySelectorAll('button') ?? []).map(
        (b) => b.textContent,
      );
      expect(buttons).toEqual(['Retry', 'Reset and re-detect']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('Reset and re-detect clears known-bad and re-walks from tier 0; recovery removes the bubble', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      warmupSessionMock.mockRejectedValue(new Error('the message channel closed'));
      const deps = makeDeps();
      initSession(deps);
      getToggleListener()(TOGGLE_MESSAGE);
      await flushMicrotasks();
      const terminal = Array.from(deps._messages.children).find((c) =>
        (c.textContent ?? '').includes("Couldn't load the model on this device."),
      );
      const buttons = terminal?.querySelectorAll('button') ?? [];
      const resetBtn = buttons[1] as HTMLButtonElement;
      expect(resetBtn?.textContent).toBe('Reset and re-detect');
      const recreateBefore = recreateOffscreenMock.mock.calls.length;
      // After the reset clears known-bad, tier 0 resolves (environment changed).
      warmupSessionMock.mockReset();
      warmupSessionMock.mockResolvedValue(undefined);
      resetBtn.click();
      await flushMicrotasks();
      // Reset force-recreates the document, then the re-walk loads tier 0.
      expect(recreateOffscreenMock.mock.calls.length).toBe(recreateBefore + 1);
      expect(warmupSessionMock).toHaveBeenCalledTimes(1);
      // The first re-walked tier is tier 0 (the persisted known-bad was cleared).
      const firstTier = warmupSessionMock.mock.calls[0][0] as { dtype?: string } | undefined;
      expect(firstTier?.dtype).toBe('q4f16');
      // Terminal bubble is gone and the model is ready.
      const after = Array.from(deps._messages.children).map((c) => c.textContent ?? '');
      expect(after.some((t) => t.includes("Couldn't load the model on this device."))).toBe(false);
      expect(deps._actionBtn.disabled).toBe(false);
      // Known-bad record cleared by the reset.
      expect(chromeMock.storage.local.store['local-nano:capability:v1']).toBeTruthy();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('re-renders a terminal bubble when Retry recreateOffscreen rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      warmupSessionMock.mockRejectedValue(new Error('offscreen port disconnected: unknown reason'));
      const deps = makeDeps();
      initSession(deps);
      getToggleListener()(TOGGLE_MESSAGE);
      await flushMicrotasks();
      const terminal = Array.from(deps._messages.children).find((c) =>
        (c.textContent ?? '').includes("Couldn't load the model on this device."),
      );
      const retryBtn = terminal?.querySelector('button') as HTMLButtonElement;
      const warmupBefore = warmupSessionMock.mock.calls.length;
      recreateOffscreenMock.mockRejectedValueOnce(new Error('recreate blocked'));
      retryBtn.click();
      await flushMicrotasks();
      // warmup not re-run on the new walk (the pre-walk recreate failed first).
      expect(warmupSessionMock.mock.calls.length).toBe(warmupBefore);
      // A terminal bubble is shown again (with the recreate error), not a dead panel.
      const stillTerminal = Array.from(deps._messages.children).find((c) =>
        (c.textContent ?? '').includes("Couldn't load the model on this device."),
      );
      expect(stillTerminal).toBeTruthy();
      expect(stillTerminal?.textContent ?? '').toContain('recreate blocked');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('initSession — fallback ladder', () => {
  const CAPABILITY_KEY = 'local-nano:capability:v1';

  beforeEach(() => {
    vi.clearAllMocks();
    pending.length = 0;
    // vi.clearAllMocks() clears call history but keeps the FakeStorageArea's
    // inline get/set/remove implementations (those survive clearAllMocks; only
    // resetAllMocks would drop them), so storage persistence works as written.
    warmupSessionMock.mockReset();
    recreateOffscreenMock.mockReset();
    recreateOffscreenMock.mockResolvedValue(undefined);
  });

  type StoredRecord = {
    knownGood: { dtype: string } | null;
    knownBad: Array<{ dtype: string }>;
  };

  it('cold start with no record loads tier 0 and persists it as known-good on success', async () => {
    warmupSessionMock.mockResolvedValue(undefined);
    const deps = makeDeps();
    initSession(deps);
    getToggleListener()(TOGGLE_MESSAGE);
    await flushMicrotasks();
    // Tier 0 (q4f16) was attempted first.
    expect(warmupSessionMock).toHaveBeenCalledTimes(1);
    const firstTier = warmupSessionMock.mock.calls[0][0] as { dtype?: string };
    expect(firstTier.dtype).toBe('q4f16');
    // Persisted as known-good.
    const record = chromeMock.storage.local.store[CAPABILITY_KEY] as StoredRecord;
    expect(record.knownGood?.dtype).toBe('q4f16');
    expect(record.knownBad).toEqual([]);
  });

  it('on a tier-0 load failure records known-bad, recreates, and loads tier 1', async () => {
    // Tier 0 rejects, tier 1 resolves.
    warmupSessionMock.mockRejectedValueOnce(new Error('load failed')).mockResolvedValue(undefined);
    const deps = makeDeps();
    initSession(deps);
    getToggleListener()(TOGGLE_MESSAGE);
    await flushMicrotasks();
    // Two attempts: q4f16 then q8.
    expect(warmupSessionMock).toHaveBeenCalledTimes(2);
    expect((warmupSessionMock.mock.calls[0][0] as { dtype: string }).dtype).toBe('q4f16');
    expect((warmupSessionMock.mock.calls[1][0] as { dtype: string }).dtype).toBe('q8');
    // recreateOffscreen called once, between the two rungs.
    expect(recreateOffscreenMock).toHaveBeenCalledTimes(1);
    // Persisted: tier 0 known-bad, tier 1 known-good.
    const record = chromeMock.storage.local.store[CAPABILITY_KEY] as StoredRecord;
    expect(record.knownBad.map((t) => t.dtype)).toEqual(['q4f16']);
    expect(record.knownGood?.dtype).toBe('q8');
  });

  it('recreates the document between every failed rung and never overlaps loads', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // All tiers fail.
      warmupSessionMock.mockRejectedValue(new Error('crash'));
      const deps = makeDeps();
      initSession(deps);
      getToggleListener()(TOGGLE_MESSAGE);
      await flushMicrotasks();
      // Four attempts (the whole ladder).
      expect(warmupSessionMock).toHaveBeenCalledTimes(4);
      // recreate fires between rungs: 3 times for 4 failed attempts.
      expect(recreateOffscreenMock).toHaveBeenCalledTimes(3);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a subsequent cold start with a persisted known-good skips straight to that tier', async () => {
    // Seed a known-good of tier 2 (fp16) under the live extension version.
    chromeMock.storage.local.store[CAPABILITY_KEY] = {
      schemaVersion: 1,
      extensionVersion: '0.2.4',
      knownGood: {
        modelName: 'onnx-community/gemma-4-E2B-it-ONNX',
        device: 'webgpu',
        dtype: 'fp16',
      },
      knownBad: [],
      capability: { device: 'webgpu', isFallback: false, maxBufferSize: null },
    };
    warmupSessionMock.mockResolvedValue(undefined);
    const deps = makeDeps();
    initSession(deps);
    getToggleListener()(TOGGLE_MESSAGE);
    await flushMicrotasks();
    // The first warmup is for the known-good tier, not tier 0.
    expect(warmupSessionMock).toHaveBeenCalledTimes(1);
    expect((warmupSessionMock.mock.calls[0][0] as { dtype: string }).dtype).toBe('fp16');
  });

  it('skips a persisted known-bad tier on a cold-start walk', async () => {
    // Tier 0 known-bad; no known-good. The walk should start at tier 1.
    chromeMock.storage.local.store[CAPABILITY_KEY] = {
      schemaVersion: 1,
      extensionVersion: '0.2.4',
      knownGood: null,
      knownBad: [
        { modelName: 'onnx-community/gemma-4-E2B-it-ONNX', device: 'webgpu', dtype: 'q4f16' },
      ],
      capability: { device: 'webgpu', isFallback: false, maxBufferSize: null },
    };
    warmupSessionMock.mockResolvedValue(undefined);
    const deps = makeDeps();
    initSession(deps);
    getToggleListener()(TOGGLE_MESSAGE);
    await flushMicrotasks();
    expect(warmupSessionMock).toHaveBeenCalledTimes(1);
    expect((warmupSessionMock.mock.calls[0][0] as { dtype: string }).dtype).toBe('q8');
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

  it('surfaces a stream error plainly and never rebuilds the session (guard removed)', async () => {
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();
    deps._input.value = 'why is the sky blue';
    deps._actionBtn.click();
    const call = await awaitPending();
    // Even a device-loss / OOM-shaped error no longer triggers an
    // automatic rebuild + retry — the guard was removed.
    call.reject(
      new Error('Model returned no output. WebGPU device loss / VK_ERROR_OUT_OF_DEVICE_MEMORY.'),
    );
    await flushMicrotasks();
    expect(rebuildSessionMock).not.toHaveBeenCalled();
    expect(pending.length).toBe(0); // no retry queued
    const modelBubble = deps._messages.children[deps._messages.children.length - 1];
    expect(modelBubble?.textContent).toContain('WebGPU device loss');
  });

  it('surfaces a non-device-loss error plainly without rebuilding', async () => {
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

  it('rewrite surfaces a GPU error plainly and never rebuilds the session (guard removed)', async () => {
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();
    deps._fireSelectionChange(makeFakeSnapshot({ text: 'target' }));
    deps._input.value = 'make it bold';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.reject(
      new Error('GPU out-of-memory (VK_ERROR_OUT_OF_DEVICE_MEMORY). Model returned no output.'),
    );
    await flushMicrotasks();
    expect(rebuildSessionMock).not.toHaveBeenCalled();
    expect(pending.length).toBe(0); // no retry queued
    const modelBubble = deps._messages.children[deps._messages.children.length - 1];
    expect(modelBubble?.textContent).toContain('VK_ERROR_OUT_OF_DEVICE_MEMORY');
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

describe('initSession — history pressure tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending.length = 0;
  });

  it('warns with a Clear-conversation bubble after a turn pushes sent-chars above the threshold', async () => {
    // One send of ~5000 chars prompt + 100 chars response = ~5100 chars
    // = ~1700 estimated tokens, crossing the default 1500 threshold.
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();
    deps._input.value = 'x'.repeat(5000);
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('A'.repeat(100));
    call.resolve('A'.repeat(100));
    await flushMicrotasks();

    const bubble = Array.from(deps._messages.children).find((c) =>
      (c.textContent ?? '').includes('Conversation history is around'),
    );
    expect(bubble).toBeTruthy();
    const btn = bubble?.querySelector('button');
    expect(btn?.textContent).toBe('Clear conversation');
  });

  it('does not warn when history is well under the threshold', async () => {
    const deps = makeDeps();
    initSession(deps);
    deps._input.value = 'short hi';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('hi back');
    call.resolve('hi back');
    await flushMicrotasks();
    const bubble = Array.from(deps._messages.children).find((c) =>
      (c.textContent ?? '').includes('Conversation history is around'),
    );
    expect(bubble).toBeUndefined();
  });

  it('only warns once per session even if subsequent turns also cross the threshold', async () => {
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();

    // First turn — long enough to cross the threshold in one shot.
    deps._input.value = 'x'.repeat(5000);
    deps._actionBtn.click();
    let call = await awaitPending();
    call.opts.onChunk?.('A');
    call.resolve('A');
    await flushMicrotasks();
    const firstCount = Array.from(deps._messages.children).filter((c) =>
      (c.textContent ?? '').includes('Conversation history is around'),
    ).length;
    expect(firstCount).toBe(1);

    // Second turn → no additional warning despite still being above threshold.
    deps._input.value = 'x'.repeat(5000);
    deps._actionBtn.click();
    call = await awaitPending();
    call.opts.onChunk?.('B');
    call.resolve('B');
    await flushMicrotasks();
    const secondCount = Array.from(deps._messages.children).filter((c) =>
      (c.textContent ?? '').includes('Conversation history is around'),
    ).length;
    expect(secondCount).toBe(1);
  });

  it('uses the GPU-info derived threshold (low for fallback adapter) instead of the default', async () => {
    // Fallback adapter → threshold drops to 800. A 2500-char send
    // lands above 800 but below 1500, so the warning only fires under
    // the lower threshold.
    getGpuInfoMock.mockResolvedValueOnce({
      device: 'webgpu',
      isFallback: true,
      maxBufferSize: null,
      configuredThreshold: null,
    });
    const deps = makeDeps();
    initSession(deps);
    // Trigger warmup so getGpuInfo + threshold derivation runs.
    getToggleListener()(TOGGLE_MESSAGE);
    await flushMicrotasks();

    deps._input.value = 'x'.repeat(2500);
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('ok');
    call.resolve('ok');
    await flushMicrotasks();

    const bubble = Array.from(deps._messages.children).find((c) =>
      (c.textContent ?? '').includes('Conversation history is around'),
    );
    expect(bubble).toBeTruthy();
  });

  it('honors a configuredThreshold from .env.json over any derivation', async () => {
    getGpuInfoMock.mockResolvedValueOnce({
      device: 'webgpu',
      isFallback: false,
      maxBufferSize: 4 * 1024 * 1024 * 1024,
      configuredThreshold: 300,
    });
    const deps = makeDeps();
    initSession(deps);
    getToggleListener()(TOGGLE_MESSAGE);
    await flushMicrotasks();
    // ~333-token history (1000 chars / 3) — above the 300 configured
    // threshold but well below any auto-derived value for a 4 GiB
    // adapter.
    deps._input.value = 'x'.repeat(1000);
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('ok');
    call.resolve('ok');
    await flushMicrotasks();
    const bubble = Array.from(deps._messages.children).find((c) =>
      (c.textContent ?? '').includes('Conversation history is around'),
    );
    expect(bubble).toBeTruthy();
  });

  it('clicking Clear conversation calls rebuildSession with empty history, wipes UI and storage', async () => {
    const key = `local-nano:history:https://example.com/page`;
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();
    // Long send to push past the default threshold so the warning bubble
    // and its Clear button materialize.
    deps._input.value = 'x'.repeat(5000);
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('ok');
    call.resolve('ok');
    await flushMicrotasks();

    const bubble = Array.from(deps._messages.children).find((c) =>
      (c.textContent ?? '').includes('Conversation history is around'),
    );
    const btn = bubble?.querySelector('button') as HTMLButtonElement;
    btn.click();
    await flushMicrotasks();
    expect(rebuildSessionMock).toHaveBeenCalledWith([]);
    // UI fully wiped except for the post-clear confirmation bubble.
    const after = Array.from(deps._messages.children).map((c) => c.textContent);
    expect(after.some((t) => t?.includes('Conversation cleared'))).toBe(true);
    expect(after.some((t) => t?.includes('one more'))).toBe(false);
    // Persisted history is reset.
    expect(chromeMock.storage.local.store[key]).toEqual([]);
  });
});

describe('initSession — storage quota surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending.length = 0;
    // vi.clearAllMocks() does not reset a persistent mockRejectedValue, so
    // restore the FakeStorageArea write behavior for tests that rely on a
    // resolving baseline before overriding a single call.
    chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(chromeMock.storage.local.store, items);
    });
  });

  function quotaBubbles(deps: ReturnType<typeof makeDeps>): Element[] {
    return Array.from(deps._messages.children).filter((c) =>
      (c.textContent ?? '').includes('History is full for this page'),
    );
  }

  it('shows a single advisory bubble when a save hits a quota error', async () => {
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();
    // The model-entry persist for this turn rejects with a quota-shaped error.
    chromeMock.storage.local.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    deps._input.value = 'hi';
    deps._actionBtn.click();
    const call = await awaitPending();
    call.opts.onChunk?.('a response');
    call.resolve('a response');
    await flushMicrotasks();
    expect(quotaBubbles(deps)).toHaveLength(1);
  });

  it('does not re-bubble on a second quota failure in the same session', async () => {
    const deps = makeDeps();
    initSession(deps);
    await flushMicrotasks();
    // Every set rejects with a quota error for the rest of the session.
    chromeMock.storage.local.set.mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'));
    deps._input.value = 'first';
    deps._actionBtn.click();
    let call = await awaitPending();
    call.opts.onChunk?.('one');
    call.resolve('one');
    await flushMicrotasks();
    deps._input.value = 'second';
    deps._actionBtn.click();
    call = await awaitPending();
    call.opts.onChunk?.('two');
    call.resolve('two');
    await flushMicrotasks();
    expect(quotaBubbles(deps)).toHaveLength(1);
  });

  it('does not bubble for a non-quota save failure (still logs)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = makeDeps();
      initSession(deps);
      await flushMicrotasks();
      chromeMock.storage.local.set.mockRejectedValueOnce(new Error('some other write failure'));
      deps._input.value = 'hi';
      deps._actionBtn.click();
      const call = await awaitPending();
      call.opts.onChunk?.('resp');
      call.resolve('resp');
      await flushMicrotasks();
      expect(quotaBubbles(deps)).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('deriveHistoryThreshold', () => {
  it('honors an explicit configuredThreshold above everything else', () => {
    expect(
      deriveHistoryThreshold({
        device: 'webgpu',
        isFallback: true,
        maxBufferSize: 0,
        configuredThreshold: 42,
      }),
    ).toBe(42);
    expect(
      deriveHistoryThreshold({
        device: 'wasm',
        isFallback: false,
        maxBufferSize: null,
        configuredThreshold: 12345,
      }),
    ).toBe(12345);
  });

  it('returns a generous threshold for WASM (CPU has system RAM)', () => {
    expect(
      deriveHistoryThreshold({
        device: 'wasm',
        isFallback: false,
        maxBufferSize: null,
        configuredThreshold: null,
      }),
    ).toBe(8000);
  });

  it('drops the threshold sharply for the software fallback adapter', () => {
    expect(
      deriveHistoryThreshold({
        device: 'webgpu',
        isFallback: true,
        maxBufferSize: null,
        configuredThreshold: null,
      }),
    ).toBe(800);
  });

  it('falls back to the default when maxBufferSize is unknown', () => {
    expect(
      deriveHistoryThreshold({
        device: 'webgpu',
        isFallback: false,
        maxBufferSize: null,
        configuredThreshold: null,
      }),
    ).toBe(1500);
  });

  it('scales the threshold with maxBufferSize bands', () => {
    const mk = (mb: number) => ({
      device: 'webgpu' as const,
      isFallback: false,
      maxBufferSize: mb * 1024 * 1024,
      configuredThreshold: null,
    });
    expect(deriveHistoryThreshold(mk(256))).toBe(1000); // <512 MiB → 1000
    expect(deriveHistoryThreshold(mk(768))).toBe(1500); // <1 GiB → 1500
    expect(deriveHistoryThreshold(mk(1536))).toBe(2500); // <2 GiB → 2500
    expect(deriveHistoryThreshold(mk(4096))).toBe(4000); // >=2 GiB → 4000
  });
});

describe('preflightWarning', () => {
  const base = {
    device: 'webgpu' as const,
    isFallback: false,
    maxBufferSize: null,
    configuredThreshold: null,
  };
  it('returns null for wasm device (no GPU needed)', () => {
    expect(preflightWarning({ ...base, device: 'wasm' })).toBeNull();
  });
  it('warns on a software fallback adapter', () => {
    expect(preflightWarning({ ...base, isFallback: true })).toContain('software fallback');
  });
  it('warns when maxBufferSize is under 1 GiB', () => {
    const w = preflightWarning({ ...base, maxBufferSize: 256 * 1024 * 1024 });
    expect(w).toContain('256 MiB');
  });
  it('returns null for a capable webgpu adapter (>=1 GiB) or unknown buffer size', () => {
    expect(preflightWarning({ ...base, maxBufferSize: 4 * 1024 * 1024 * 1024 })).toBeNull();
    expect(preflightWarning(base)).toBeNull(); // maxBufferSize null → no warning
  });
});
