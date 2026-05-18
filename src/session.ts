/**
 * Minimal typed surface for a LanguageModel session returned by the
 * Prompt API polyfill. Only the methods called in this extension are
 * declared; the full spec surface is larger.
 */
export interface LanguageModelSession {
  promptStreaming(
    input: string,
    options?: { signal?: AbortSignal },
  ): ReadableStream<string>;
  destroy(): void;
}
