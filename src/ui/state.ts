export const IDLE_LABEL = 'Send';
export const IDLE_BG = '#0a5fa3';
export const BUSY_LABEL = 'Stop';
export const BUSY_BG = '#a32222';
export const LOADING_LABEL = 'Loading…';
export const LOADING_BG = '#3a3a3a';

export function setIdleState(btn: HTMLButtonElement, input: HTMLInputElement): void {
  btn.textContent = IDLE_LABEL;
  btn.style.background = IDLE_BG;
  btn.disabled = false;
  input.disabled = false;
}

export function setGeneratingState(btn: HTMLButtonElement, input: HTMLInputElement): void {
  btn.textContent = BUSY_LABEL;
  btn.style.background = BUSY_BG;
  btn.disabled = false;
  input.disabled = true;
}

/**
 * Model is loading (typically the offscreen polyfill + WebGPU upload
 * triggered by the panel-open warmup). Send is gated until the load
 * resolves, but the input stays enabled so the user can keep typing.
 */
export function setLoadingState(btn: HTMLButtonElement, input: HTMLInputElement): void {
  btn.textContent = LOADING_LABEL;
  btn.style.background = LOADING_BG;
  btn.disabled = true;
  input.disabled = false;
}
