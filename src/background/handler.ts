export const TOGGLE_COMMAND = 'toggle_ai_palette';
export const TOGGLE_MESSAGE = { a: 'toggle' } as const;
export type ToggleMessage = typeof TOGGLE_MESSAGE;

export function handleCommand(command: string): void {
  if (command !== TOGGLE_COMMAND) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs[0]?.id;
    if (id == null) return;
    // The no-op callback consumes chrome.runtime.lastError so a freshly
    // loaded tab whose content script hasn't registered its onMessage
    // listener yet doesn't surface as an uncaught "Could not establish
    // connection" promise rejection in the service worker.
    chrome.tabs.sendMessage(id, TOGGLE_MESSAGE, () => {
      void chrome.runtime.lastError;
    });
  });
}
