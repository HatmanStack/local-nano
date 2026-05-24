/**
 * Pure message-classification seam for the offscreen `onMessage` listener.
 *
 * The offscreen document answers four `chrome.runtime.sendMessage`
 * request types (gpu-info, rebuild-session, count-tokens, warmup) from a single
 * dispatching listener. This module isolates the routing decision — which
 * handler kind owns a raw message — behind the protocol guards, with no
 * Chrome or polyfill dependency, so the dispatch logic is unit-testable
 * without loading `offscreen.ts` (ADR-R5).
 */

import {
  isCountTokensRequest,
  isGpuInfoRequest,
  isRebuildSessionRequest,
  isWarmupRequest,
} from './protocol.js';

export type OffscreenRequestKind = 'gpu-info' | 'rebuild-session' | 'count-tokens' | 'warmup';

export function classifyOffscreenMessage(msg: unknown): OffscreenRequestKind | null {
  if (isGpuInfoRequest(msg)) return 'gpu-info';
  if (isRebuildSessionRequest(msg)) return 'rebuild-session';
  if (isCountTokensRequest(msg)) return 'count-tokens';
  if (isWarmupRequest(msg)) return 'warmup';
  return null;
}
