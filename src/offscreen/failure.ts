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
 * Load-time classification (Phase 4, ADR-R10). Extends the terminal/transient
 * split with a `'network'` class for a weights-download/network failure: the
 * device is capable, only the HF fetch failed, so the right response is a
 * retryable "check your connection" message that retries the SAME tier without
 * recording a known-bad tier or walking the ladder.
 */
export type LoadFailureClass = 'terminal' | 'transient' | 'network';

/**
 * Network/download signals. Origins:
 * - `failed to fetch`: the browser fetch rejection wording (Chrome/Firefox)
 *   when a request never completes (offline, DNS, CORS-style network drop).
 * - `networkerror` / `network error`: DOMException name and prose form.
 * - `err_internet` / `err_network` / `err_name_not_resolved` /
 *   `err_connection`: Chrome net-stack error-code prefixes surfaced in fetch
 *   failure messages.
 * - `download failed` / `failed to download`: the transformers loader wording
 *   when a model file download does not complete.
 * - `huggingface` / `hf.co` / `huggingface.co`: the HF host, present in a fetch
 *   error against the weights repo.
 * - `status code 4` / `status code 5` / `(status 4` / `(status 5`: a non-200
 *   HTTP status from the HF fetch (4xx/5xx), e.g. a 403 on a gated repo or a
 *   503 on an HF outage.
 */
const NETWORK_SIGNALS: readonly string[] = [
  'failed to fetch',
  'networkerror',
  'network error',
  'err_internet',
  'err_network',
  'err_name_not_resolved',
  'err_connection',
  'download failed',
  'failed to download',
  'huggingface',
  'hf.co',
  'status code 4',
  'status code 5',
  '(status 4',
  '(status 5',
];

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

/**
 * Classify a model-LOAD failure into terminal / transient / network.
 *
 * Terminal crash signals win: a port death is terminal regardless of the
 * underlying cause, because the document is gone and must be recreated. Only
 * when the failure is NOT crash-shaped do we look for a network/download
 * signal, in which case the device is fine and only the HF fetch failed
 * (retry the same tier, no ladder walk, no known-bad). Everything else is
 * transient (the existing default).
 */
export function classifyLoadFailure(error: unknown): LoadFailureClass {
  if (classifyFailure(error) === 'terminal') return 'terminal';
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  for (const signal of NETWORK_SIGNALS) {
    if (message.includes(signal)) return 'network';
  }
  return 'transient';
}
