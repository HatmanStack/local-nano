import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUSY_BG,
  BUSY_LABEL,
  IDLE_BG,
  IDLE_LABEL,
  setGeneratingState,
  setIdleState,
} from '../src/ui/state.js';

function bgWith(color: string): string {
  const el = document.createElement('div');
  el.style.background = color;
  return el.style.background;
}

describe('button state helpers', () => {
  let btn: HTMLButtonElement;
  let input: HTMLInputElement;

  beforeEach(() => {
    btn = document.createElement('button');
    input = document.createElement('input');
  });

  it('setIdleState sets label/background and re-enables input', () => {
    input.disabled = true;
    setIdleState(btn, input);
    expect(btn.textContent).toBe(IDLE_LABEL);
    expect(btn.style.background).toBe(bgWith(IDLE_BG));
    expect(input.disabled).toBe(false);
  });

  it('setGeneratingState sets label/background and disables input', () => {
    input.disabled = false;
    setGeneratingState(btn, input);
    expect(btn.textContent).toBe(BUSY_LABEL);
    expect(btn.style.background).toBe(bgWith(BUSY_BG));
    expect(input.disabled).toBe(true);
  });

  it('round-trips idle → busy → idle', () => {
    setGeneratingState(btn, input);
    setIdleState(btn, input);
    expect(btn.textContent).toBe(IDLE_LABEL);
    expect(input.disabled).toBe(false);
  });
});
