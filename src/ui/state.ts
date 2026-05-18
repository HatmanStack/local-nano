export const IDLE_LABEL = 'Send';
export const IDLE_BG = '#0a5fa3';
export const BUSY_LABEL = 'Stop';
export const BUSY_BG = '#a32222';

export function setIdleState(btn: HTMLButtonElement, input: HTMLInputElement): void {
  btn.textContent = IDLE_LABEL;
  btn.style.background = IDLE_BG;
  input.disabled = false;
}

export function setGeneratingState(btn: HTMLButtonElement, input: HTMLInputElement): void {
  btn.textContent = BUSY_LABEL;
  btn.style.background = BUSY_BG;
  input.disabled = true;
}
