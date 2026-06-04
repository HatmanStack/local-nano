/**
 * Pure SW-side panel-pin counter (Layer B, Phase 3, ADR-2).
 *
 * Tracks how many content-script panel-pin ports are currently open and tells
 * the SW glue when to acquire or release the long-lived offscreen pin port.
 * The offscreen pin port is held WHILE at least one panel is open and released
 * the moment the last panel closes (panel-open-counted lifetime, brainstorm
 * decision 3). This module is intentionally free of any Chrome or port
 * dependency so the acquire/release state machine is unit-testable; the SW glue
 * in `offscreen.ts` calls these and acts on the returned action.
 */

export interface PanelPinState {
  count: number;
}

export type PanelPinAction =
  | { kind: 'acquire-offscreen-pin' }
  | { kind: 'release-offscreen-pin' }
  | { kind: 'noop' };

/** Fresh counter state. */
export function _newState(): PanelPinState {
  return { count: 0 };
}

/**
 * Register one panel-pin connect. Returns `acquire-offscreen-pin` ONLY on the
 * 0 -> 1 transition (the first panel opened); subsequent connects are a noop.
 */
export function onPanelConnect(state: PanelPinState): PanelPinAction {
  state.count += 1;
  return state.count === 1 ? { kind: 'acquire-offscreen-pin' } : { kind: 'noop' };
}

/**
 * Register one panel-pin disconnect. Returns `release-offscreen-pin` ONLY on
 * the 1 -> 0 transition (the last panel closed); other disconnects are a noop.
 * A count already at 0 clamps to 0 so a duplicate disconnect from a stale port
 * is a noop, not a release-twice bug.
 */
export function onPanelDisconnect(state: PanelPinState): PanelPinAction {
  if (state.count <= 0) {
    state.count = 0;
    return { kind: 'noop' };
  }
  state.count -= 1;
  return state.count === 0 ? { kind: 'release-offscreen-pin' } : { kind: 'noop' };
}
