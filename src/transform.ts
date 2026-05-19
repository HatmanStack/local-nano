import { type LanguageModelSession, loadHeavy } from './heavy.js';
import { type ActionId, actionToPrompt, SELECTION_LIMIT } from './transform-prompts.js';

export interface RunTransformArgs {
  action: ActionId;
  sourceText: string;
  signal?: AbortSignal;
  /**
   * The transformers config object stamped onto `window.TRANSFORMERS_CONFIG`
   * by `loadHeavy()`. Pass the same value `initSession` receives — both
   * callers share the memoized cache.
   */
  transformersConfig: unknown;
}

export interface RunTransformResult {
  /** Caller-facing stream of model output chunks. */
  stream: ReadableStream<string>;
  /**
   * Resolves once the underlying ephemeral session has been destroyed
   * (the stream has finished, errored, or been aborted, and
   * `session.destroy()` has run). For most call sites this is
   * fire-and-forget; awaiting it is useful for tests and for callers
   * that want to know when model context has been freed.
   */
  done: Promise<void>;
}

/**
 * Run a write-side DOM-aware action.
 *
 * Creates a fresh ephemeral `LanguageModel` session whose initial
 * prompt is the action-specific system prompt, then returns a
 * `ReadableStream<string>` of model output plus a `done` promise that
 * settles after `session.destroy()` runs.
 *
 * The heavy modules (Transformers.js + polyfill) are memoized across
 * calls via `loadHeavy()`; only the per-action session is fresh, so
 * setup cost is paid once per page lifetime.
 *
 * Validates inputs before any model work:
 * - throws `Error('Selection text required')` if the trimmed source is
 *   empty;
 * - throws `Error('Selection too long')` if the source exceeds
 *   `SELECTION_LIMIT` characters;
 * - propagates the `actionToPrompt` error when called with a chat-kind
 *   action id (programming error in the caller).
 */
export async function runTransform(args: RunTransformArgs): Promise<RunTransformResult> {
  const { action, sourceText, signal, transformersConfig } = args;

  if (sourceText.trim().length === 0) {
    throw new Error('Selection text required');
  }
  if (sourceText.length > SELECTION_LIMIT) {
    throw new Error('Selection too long');
  }

  // Look up the system prompt before paying any model cost. For
  // chat-kind ids this throws and we abort before touching loadHeavy.
  const systemPrompt = actionToPrompt(action);

  const { LanguageModel } = await loadHeavy(transformersConfig);
  const session: LanguageModelSession = await LanguageModel.create({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
    initialPrompts: [{ role: 'system', content: systemPrompt }],
  });

  const upstream = session.promptStreaming(sourceText, signal ? { signal } : undefined);

  // Tee the stream so we can dispose the session in a separate branch
  // without coupling lifecycle to the consumer's read loop.
  const [consumer, tracker] = upstream.tee();

  const done = (async () => {
    const reader = tracker.getReader();
    try {
      while (true) {
        const { done: isDone } = await reader.read();
        if (isDone) return;
      }
    } catch {
      // Swallow stream errors (including AbortError) — the consumer
      // branch surfaces them. Our only job here is to drain the
      // tracker side so the `finally` runs.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // releaseLock can throw if the stream is already errored; the
        // session is still about to be destroyed, so we ignore it.
      }
      session.destroy();
    }
  })();

  return { stream: consumer, done };
}
