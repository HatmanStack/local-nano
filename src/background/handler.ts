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

/**
 * Map a `chrome.commands` command name to the canonical `ActionId` that
 * gets dispatched to the active tab. Keyboard commands intentionally
 * default to the most useful variant of their action family — the
 * remaining variants are only reachable via the context menu in v0.2.
 */
const COMMAND_TO_ACTION: Record<string, ActionId> = {
  ask_about_selection: 'ask_about_selection',
  rewrite_selection: 'rewrite_improve',
  translate_selection: 'translate_en',
};

function sendToActiveTab(message: unknown): void {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs[0]?.id;
    if (id != null) chrome.tabs.sendMessage(id, message);
  });
}

export function handleCommand(command: string): void {
  if (command === TOGGLE_COMMAND) {
    sendToActiveTab(TOGGLE_MESSAGE);
    return;
  }
  const actionId = COMMAND_TO_ACTION[command];
  if (actionId) {
    const msg: ActionMessage = { a: ACTION_MESSAGE_KIND, id: actionId };
    sendToActiveTab(msg);
    return;
  }
  // Unknown command — ignore.
}
