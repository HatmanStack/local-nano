export const TOGGLE_COMMAND = 'toggle_ai_palette';
export const TOGGLE_MESSAGE = { a: 'toggle' } as const;

export function handleCommand(command: string): void {
  if (command !== TOGGLE_COMMAND) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs[0]?.id;
    if (id != null) chrome.tabs.sendMessage(id, TOGGLE_MESSAGE);
  });
}
