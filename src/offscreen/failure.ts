/**
 * Pure terminal-vs-transient failure classifier (ADR-R5).
 *
 * A model load can hard-crash the offscreen document. A page crash is not a
 * catchable JS throw, so detection is client-side: it inspects the failure
 * surfaced through the message transport and decides whether the document (or
 * its message channel) likely died and a force-recreate is required, or the
 * failure is a retryable in-place condition.
 *
 * No Chrome, polyfill, or timer dependency, so it is unit-testable directly.
 * Consumed by `src/session.ts` (the warmup path) and available to
 * `src/offscreen/stream-client.ts`.
 */

export type FailureClass = 'terminal' | 'transient';

/**
 * Crash-shaped signals. Each indicates the offscreen document or its message
 * channel died, so recovery must recreate the document rather than retry in
 * place. Matched case-insensitively as substrings of the failure message.
 */
const TERMINAL_SIGNALS: readonly string[] = [
  // streamOverPort's onDisconnect reject form when no lastError reason is
  // available (src/offscreen/stream-client.ts:111) — the port dropped, which
  // on a crash is how the death surfaces.
  'port disconnected',
  // chrome.runtime.sendMessage / port closed before a reply: the channel
  // backing the offscreen document went away mid-request.
  'message channel closed',
  'the message port closed',
  'message port closed',
  // chrome.runtime.sendMessage when no offscreen document is listening: the
  // document is gone.
  'receiving end does not exist',
];

/**
 * Classify a load/warmup/stream failure as terminal (document likely dead,
 * recreate required) or transient (retryable in place).
 */
export function classifyFailure(error: unknown): FailureClass {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  for (const signal of TERMINAL_SIGNALS) {
    if (message.includes(signal)) return 'terminal';
  }
  // A document that reports its own crash (manual-smoke wording) is terminal.
  if (message.includes('document') && message.includes('crash')) return 'terminal';
  // Default: an ordinary in-session error (e.g. a generation error reported via
  // StreamDone ok:false, or the busy-gate rejection) stays out of the recreate
  // path. Only crash-shaped failures recreate.
  return 'transient';
}

/** Readability wrapper for call sites. */
export function isTerminalFailure(error: unknown): boolean {
  return classifyFailure(error) === 'terminal';
}
