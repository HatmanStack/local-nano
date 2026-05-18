import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHeavy, resetHeavyCache } from '../src/heavy.js';
import { runTransform } from '../src/transform.js';
import { type ActionId, actionToPrompt, SELECTION_LIMIT } from '../src/transform-prompts.js';

// ---------------------------------------------------------------------------
// Mock the heavy module dynamic imports — same pattern as session.test.ts.
// ---------------------------------------------------------------------------

vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { wasm: { wasmPaths: '', numThreads: 0 } } } },
}));

vi.mock('../vendor/prompt-api-polyfill/prompt-api-polyfill.js', () => ({
  LanguageModel: { create: vi.fn() },
}));

import * as polyfillMod from '../vendor/prompt-api-polyfill/prompt-api-polyfill.js';

const mockLanguageModelCreate = polyfillMod.LanguageModel.create as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SessionMock {
  promptStreaming: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function makeSessionMock(): SessionMock {
  return {
    promptStreaming: vi.fn(),
    destroy: vi.fn(),
  };
}

/** Build a ReadableStream<string> that yields chunks then closes. */
function streamFromChunks(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/** Build a ReadableStream<string> that errors immediately. */
function streamThatErrors(error: Error): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.error(error);
    },
  });
}

/**
 * Build a ReadableStream<string> that emits one chunk, then waits on a
 * Promise before continuing. Resolves with an AbortError when the
 * caller's signal aborts. Mirrors the polyfill's abort semantics.
 */
function abortableStream(signal: AbortSignal | undefined): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      controller.enqueue('partial-');
      await new Promise<void>((_resolve, reject) => {
        if (!signal) {
          // No signal — never resolves on its own.
          return;
        }
        if (signal.aborted) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        signal.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }).catch((err) => {
        controller.error(err);
      });
    },
  });
}

async function drain(stream: ReadableStream<string>): Promise<string[]> {
  const out: string[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return out;
      out.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

const TRANSFORMERS_CONFIG = {
  apiKey: 'dummy',
  device: 'wasm',
  dtype: 'q8',
  modelName: 'test-model',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTransform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHeavyCache();
  });

  it('returns a stream that yields the same chunks the underlying promptStreaming produces', async () => {
    const session = makeSessionMock();
    session.promptStreaming.mockReturnValue(streamFromChunks(['Hello, ', 'world!']));
    mockLanguageModelCreate.mockResolvedValue(session);

    const result = await runTransform({
      action: 'rewrite_improve',
      sourceText: 'hi world',
      transformersConfig: TRANSFORMERS_CONFIG,
    });
    const chunks = await drain(result.stream);
    await result.done;
    expect(chunks.join('')).toBe('Hello, world!');
  });

  it('passes the action-specific system prompt to LanguageModel.create', async () => {
    const session = makeSessionMock();
    session.promptStreaming.mockReturnValue(streamFromChunks(['out']));
    mockLanguageModelCreate.mockResolvedValue(session);

    await runTransform({
      action: 'rewrite_improve',
      sourceText: 'some text',
      transformersConfig: TRANSFORMERS_CONFIG,
    });

    expect(mockLanguageModelCreate).toHaveBeenCalledTimes(1);
    const opts = mockLanguageModelCreate.mock.calls[0][0] as {
      initialPrompts: Array<{ role: string; content: string }>;
    };
    expect(opts.initialPrompts).toEqual([
      { role: 'system', content: actionToPrompt('rewrite_improve') },
    ]);
  });

  it('throws "Selection text required" for empty sourceText', async () => {
    await expect(
      runTransform({
        action: 'rewrite_improve',
        sourceText: '   ',
        transformersConfig: TRANSFORMERS_CONFIG,
      }),
    ).rejects.toThrow(/Selection text required/);
    expect(mockLanguageModelCreate).not.toHaveBeenCalled();
  });

  it('throws "Selection too long" when sourceText.length === SELECTION_LIMIT + 1', async () => {
    const oversized = 'x'.repeat(SELECTION_LIMIT + 1);
    await expect(
      runTransform({
        action: 'rewrite_improve',
        sourceText: oversized,
        transformersConfig: TRANSFORMERS_CONFIG,
      }),
    ).rejects.toThrow(/Selection too long/);
    expect(mockLanguageModelCreate).not.toHaveBeenCalled();
  });

  it('propagates actionToPrompt errors for chat-kind actions', async () => {
    await expect(
      runTransform({
        action: 'ask_about_selection' as ActionId,
        sourceText: 'hello',
        transformersConfig: TRANSFORMERS_CONFIG,
      }),
    ).rejects.toThrow(/Unknown action/);
    expect(mockLanguageModelCreate).not.toHaveBeenCalled();
  });

  it('calls session.destroy() after the stream completes naturally', async () => {
    const session = makeSessionMock();
    session.promptStreaming.mockReturnValue(streamFromChunks(['done']));
    mockLanguageModelCreate.mockResolvedValue(session);

    const result = await runTransform({
      action: 'rewrite_grammar',
      sourceText: 'tex',
      transformersConfig: TRANSFORMERS_CONFIG,
    });
    await drain(result.stream);
    await result.done;
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('calls session.destroy() after the stream errors', async () => {
    const session = makeSessionMock();
    session.promptStreaming.mockReturnValue(streamThatErrors(new Error('boom')));
    mockLanguageModelCreate.mockResolvedValue(session);

    const result = await runTransform({
      action: 'translate_en',
      sourceText: 'hola',
      transformersConfig: TRANSFORMERS_CONFIG,
    });
    // Consumer-side: draining the user-facing branch should reject.
    await expect(drain(result.stream)).rejects.toThrow(/boom/);
    await result.done;
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('calls session.destroy() after the signal is aborted mid-stream', async () => {
    const session = makeSessionMock();
    const ctrl = new AbortController();
    session.promptStreaming.mockImplementation((_input: string, opts?: { signal?: AbortSignal }) =>
      abortableStream(opts?.signal),
    );
    mockLanguageModelCreate.mockResolvedValue(session);

    const result = await runTransform({
      action: 'rewrite_shorter',
      sourceText: 'long text to shorten',
      signal: ctrl.signal,
      transformersConfig: TRANSFORMERS_CONFIG,
    });

    // Start draining the consumer branch but abort before it finishes.
    const consumerDrain = drain(result.stream);
    ctrl.abort();
    await expect(consumerDrain).rejects.toThrow();
    await result.done;
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('loadHeavy returns the same cached promise across multiple calls', async () => {
    const a = loadHeavy(TRANSFORMERS_CONFIG);
    const b = loadHeavy(TRANSFORMERS_CONFIG);
    expect(a).toBe(b);
    const aResolved = await a;
    const bResolved = await b;
    expect(aResolved).toBe(bResolved);
  });

  it('creates a fresh ephemeral session per runTransform call (heavy modules still memoized)', async () => {
    const sessionA = makeSessionMock();
    sessionA.promptStreaming.mockReturnValue(streamFromChunks(['a']));
    const sessionB = makeSessionMock();
    sessionB.promptStreaming.mockReturnValue(streamFromChunks(['b']));
    mockLanguageModelCreate.mockResolvedValueOnce(sessionA).mockResolvedValueOnce(sessionB);

    const r1 = await runTransform({
      action: 'rewrite_improve',
      sourceText: 'first',
      transformersConfig: TRANSFORMERS_CONFIG,
    });
    await drain(r1.stream);
    await r1.done;

    const r2 = await runTransform({
      action: 'rewrite_improve',
      sourceText: 'second',
      transformersConfig: TRANSFORMERS_CONFIG,
    });
    await drain(r2.stream);
    await r2.done;

    expect(mockLanguageModelCreate).toHaveBeenCalledTimes(2);
    expect(sessionA.destroy).toHaveBeenCalledTimes(1);
    expect(sessionB.destroy).toHaveBeenCalledTimes(1);
  });
});
