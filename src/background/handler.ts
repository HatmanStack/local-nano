export const TOGGLE_COMMAND = 'toggle_ai_palette';
export const TOGGLE_MESSAGE = { a: 'toggle' } as const;
export type ToggleMessage = typeof TOGGLE_MESSAGE;

const UNBOUND_TITLE = 'Toggle Local Nano — set a shortcut at chrome://extensions/shortcuts';

/**
 * Shown on the toolbar icon when the panel cannot run in the current tab.
 * Chrome refuses to script its own surfaces (`chrome://` pages, the Web Store,
 * the PDF viewer, a blank new tab), so there is genuinely nowhere to put the
 * panel — but the user can fix that by opening a site, so the icon says so
 * instead of letting the click look broken.
 */
export const RESTRICTED_BADGE_TEXT = '!';
export const RESTRICTED_BADGE_COLOR = '#b3261e';
export const RESTRICTED_TITLE =
  'Local Nano only runs on a web page — open a site in this tab, then click again';

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
 * (`chrome://`, the Web Store, the PDF viewer) rejects; that is the one case
 * the user can act on, so it marks the icon instead of failing silently.
 */
async function injectAndRetry(id: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch {
    await flagRestrictedTab(id);
    return;
  }
  chrome.tabs.sendMessage(id, TOGGLE_MESSAGE, () => {
    if (chrome.runtime.lastError) return;
    void clearRestrictedFlag(id);
  });
}

function sendToggleToTab(id: number): void {
  // The callback consumes chrome.runtime.lastError so a tab with no content
  // script doesn't surface as an uncaught "Could not establish connection"
  // rejection in the service worker. When that is why the send failed, heal
  // the tab and retry instead of dropping the user's click on the floor.
  chrome.tabs.sendMessage(id, TOGGLE_MESSAGE, () => {
    const err = chrome.runtime.lastError;
    if (!err) {
      void clearRestrictedFlag(id);
      return;
    }
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

/** The icon's normal tooltip, reflecting whatever shortcut is currently bound. */
async function resolveDefaultTitle(): Promise<string> {
  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((c) => c.name === TOGGLE_COMMAND)?.shortcut ?? '';
  return shortcut ? `Toggle Local Nano (${shortcut})` : UNBOUND_TITLE;
}

export async function refreshActionTitle(): Promise<void> {
  await chrome.action.setTitle({ title: await resolveDefaultTitle() });
}

/** Mark one tab as somewhere the panel cannot open, and say why on hover. */
async function flagRestrictedTab(tabId: number): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: RESTRICTED_BADGE_TEXT });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: RESTRICTED_BADGE_COLOR });
  await chrome.action.setTitle({ tabId, title: RESTRICTED_TITLE });
}

/**
 * Undo that marker once the panel does open in the tab — the user navigated
 * somewhere the extension can run.
 *
 * `getTitle` reports the tab's effective tooltip, so comparing it against
 * `RESTRICTED_TITLE` says whether this tab was actually flagged without
 * tracking state that a service-worker eviction would lose. Tabs that were
 * never flagged are left completely untouched: writing a tab-scoped tooltip on
 * every successful toggle would pin a copy of the current title to each tab,
 * and those copies would go stale — and start misreporting the shortcut — the
 * moment the binding changed.
 */
async function clearRestrictedFlag(tabId: number): Promise<void> {
  const current = await chrome.action.getTitle({ tabId });
  if (current !== RESTRICTED_TITLE) return;
  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: await resolveDefaultTitle() });
}
