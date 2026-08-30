export const TOGGLE_COMMAND = 'toggle_ai_palette';
export const TOGGLE_MESSAGE = { a: 'toggle' } as const;
export type ToggleMessage = typeof TOGGLE_MESSAGE;

const UNBOUND_TITLE = 'Toggle Local Nano — set a shortcut at chrome://extensions/shortcuts';

/**
 * The bundled content script, as listed in `manifest.json`'s `content_scripts`.
 * Re-injected on demand by `sendToggleToTab` when a tab has no listener.
 */
export const CONTENT_SCRIPT_FILE = 'dist/content.js';

/**
 * Chrome's error when nothing in the tab is listening for the toggle message.
 * The declared content script only lands on navigation, so every tab that was
 * already open when the extension was installed or auto-updated has no
 * listener until it reloads — clicking the toolbar icon there used to fail
 * silently and look like a dead extension.
 */
export function isNoReceiverError(err: { message?: string } | undefined): boolean {
  const message = err?.message ?? '';
  return /Receiving end does not exist|Could not establish connection/i.test(message);
}

/**
 * Inject the content script into a tab that has none, then retry the toggle.
 * `executeScript` resolves only after the script has run, so the listener is
 * registered by the time the retry is sent.
 *
 * Host access comes from `activeTab`, which Chrome grants for exactly the two
 * gestures that reach here — a toolbar click and the keyboard command — so
 * this needs no broad host permission. A tab the extension can never script
 * (`chrome://`, the Web Store, the PDF viewer) rejects; there is no panel to
 * open there, so it stays quiet rather than surfacing a failure the user can
 * do nothing about.
 */
async function injectAndRetry(id: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch {
    return;
  }
  chrome.tabs.sendMessage(id, TOGGLE_MESSAGE, () => {
    void chrome.runtime.lastError;
  });
}

function sendToggleToTab(id: number): void {
  // The callback consumes chrome.runtime.lastError so a tab with no content
  // script doesn't surface as an uncaught "Could not establish connection"
  // rejection in the service worker. When that is why the send failed, heal
  // the tab and retry instead of dropping the user's click on the floor.
  chrome.tabs.sendMessage(id, TOGGLE_MESSAGE, () => {
    const err = chrome.runtime.lastError;
    if (!err) return;
    if (!isNoReceiverError(err)) return;
    void injectAndRetry(id);
  });
}

export function handleCommand(command: string): void {
  if (command !== TOGGLE_COMMAND) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs[0]?.id;
    if (id == null) return;
    sendToggleToTab(id);
  });
}

export function handleActionClick(tab: chrome.tabs.Tab): void {
  if (tab.id == null) return;
  sendToggleToTab(tab.id);
}

export async function refreshActionTitle(): Promise<void> {
  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((c) => c.name === TOGGLE_COMMAND)?.shortcut ?? '';
  const title = shortcut ? `Toggle Local Nano (${shortcut})` : UNBOUND_TITLE;
  await chrome.action.setTitle({ title });
}
