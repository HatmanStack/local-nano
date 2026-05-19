import { ACTION_DESCRIPTORS, type ActionDescriptor, type ActionId } from '../transform-prompts.js';
import { ACTION_MESSAGE_KIND, type ActionMessage } from './handler.js';

/**
 * Map an action descriptor to chrome.contextMenus.create properties.
 * `contexts` is derived from the action kind:
 *  - `chat` and `transform-readonly` need a text selection.
 *  - `transform-editable` needs an editable target (`<input>`,
 *    `<textarea>`, or `contenteditable`).
 *  - `page-chat` is anchored to the page (no selection required).
 */
function descriptorToMenuProps(d: ActionDescriptor): chrome.contextMenus.CreateProperties {
  const contexts: chrome.contextMenus.ContextType[] = (() => {
    switch (d.kind) {
      case 'chat':
        return ['selection'];
      case 'page-chat':
        return ['page'];
      case 'transform-editable':
        return ['editable'];
      case 'transform-readonly':
        return ['selection'];
    }
  })();
  return { id: d.id, title: d.label, contexts };
}

/**
 * Register every entry in `ACTION_DESCRIPTORS` with the chrome
 * context-menu API. Items sharing a `parentLabel` are grouped under a
 * synthetic parent menu whose id is `parent:<label>`. Items without a
 * `parentLabel` are registered as top-level entries.
 *
 * Must be called from both `chrome.runtime.onInstalled` and
 * `chrome.runtime.onStartup`: MV3 service workers are non-persistent, so
 * a fresh registration is required whenever the worker spins up.
 */
export function registerMenus(api: typeof chrome.contextMenus = chrome.contextMenus): void {
  api.removeAll(() => {
    // Group descriptors by parentLabel. Items with no parentLabel are
    // top-level. Items with a parentLabel get a synthetic parent.
    const byParent = new Map<string | null, ActionDescriptor[]>();
    for (const d of ACTION_DESCRIPTORS) {
      const key = d.parentLabel ?? null;
      const arr = byParent.get(key) ?? [];
      arr.push(d);
      byParent.set(key, arr);
    }

    // Top-level items first.
    const topLevel = byParent.get(null) ?? [];
    for (const d of topLevel) api.create(descriptorToMenuProps(d));

    // Submenu parents and their children.
    for (const [parentLabel, children] of byParent) {
      if (parentLabel === null) continue;
      const parentId = `parent:${parentLabel}`;
      // Parent menu inherits the union of its children's contexts.
      const contexts = Array.from(
        new Set(children.flatMap((c) => descriptorToMenuProps(c).contexts ?? [])),
      ) as chrome.contextMenus.ContextType[];
      api.create({ id: parentId, title: parentLabel, contexts });
      for (const child of children) {
        api.create({ ...descriptorToMenuProps(child), parentId });
      }
    }
  });
}

/**
 * Handle a context-menu click. Forwards `{ a: 'action', id }` to the
 * active tab via `chrome.tabs.sendMessage`. Submenu parent clicks and
 * unexpected menu-id shapes are dropped silently — the user expects
 * nothing to happen when they click a submenu header.
 */
export function onMenuClicked(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
  tabsApi: typeof chrome.tabs = chrome.tabs,
): void {
  const id = info.menuItemId;
  if (typeof id !== 'string') return;
  if (id.startsWith('parent:')) return; // Submenu parent click — ignore.
  const tabId = tab?.id;
  if (tabId == null) return;
  const msg: ActionMessage = { a: ACTION_MESSAGE_KIND, id: id as ActionId };
  // Pass a no-op callback so chrome.runtime.lastError is consumed
  // instead of bubbling to the console. On chrome:// pages, extension
  // pages, or any tab where the content script failed to inject, the
  // sendMessage call has no receiver and Chrome would otherwise log
  // "Could not establish connection. Receiving end does not exist." —
  // a known, expected, and harmless condition that we don't want to
  // surface as a runtime error.
  tabsApi.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
}
