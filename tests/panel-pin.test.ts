import { describe, expect, it } from 'vitest';
import { _newState, onPanelConnect, onPanelDisconnect } from '../src/background/panel-pin.js';

describe('panel-pin counter', () => {
  it('fresh state has count 0', () => {
    const state = _newState();
    expect(state.count).toBe(0);
  });

  it('first onPanelConnect returns acquire-offscreen-pin and count 1', () => {
    const state = _newState();
    const action = onPanelConnect(state);
    expect(action).toEqual({ kind: 'acquire-offscreen-pin' });
    expect(state.count).toBe(1);
  });

  it('second onPanelConnect returns noop and count 2', () => {
    const state = _newState();
    onPanelConnect(state);
    const action = onPanelConnect(state);
    expect(action).toEqual({ kind: 'noop' });
    expect(state.count).toBe(2);
  });

  it('onPanelDisconnect from count 2 returns noop and count 1', () => {
    const state = _newState();
    onPanelConnect(state);
    onPanelConnect(state);
    const action = onPanelDisconnect(state);
    expect(action).toEqual({ kind: 'noop' });
    expect(state.count).toBe(1);
  });

  it('onPanelDisconnect from count 1 returns release-offscreen-pin and count 0', () => {
    const state = _newState();
    onPanelConnect(state);
    const action = onPanelDisconnect(state);
    expect(action).toEqual({ kind: 'release-offscreen-pin' });
    expect(state.count).toBe(0);
  });

  it('onPanelDisconnect from count 0 returns noop and count stays 0', () => {
    const state = _newState();
    const action = onPanelDisconnect(state);
    expect(action).toEqual({ kind: 'noop' });
    expect(state.count).toBe(0);
  });
});
