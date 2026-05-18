import type { ActionId } from '../transform-prompts.js';

export const TOGGLE_COMMAND = 'toggle_ai_palette';
export const TOGGLE_MESSAGE = { a: 'toggle' } as const;
export type ToggleMessage = typeof TOGGLE_MESSAGE;

/**
 * Discriminator for the action-dispatch message kind. Both
 * `chrome.contextMenus.onClicked` and the v0.2 keyboard commands produce
 * messages of this shape, so the content script only needs one listener.
 */
export const ACTION_MESSAGE_KIND = 'action' as const;

export interface ActionMessage {
  a: typeof ACTION_MESSAGE_KIND;
  id: ActionId;
  /**
   * For ask_about_selection / summarize_page, the selection text (if any)
   * is captured by the content script at right-click time; it is not
   * carried in this message. The background only knows the action id.
   */
}

export function handleCommand(command: string): void {
  if (command !== TOGGLE_COMMAND) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs[0]?.id;
    if (id != null) chrome.tabs.sendMessage(id, TOGGLE_MESSAGE);
  });
}
