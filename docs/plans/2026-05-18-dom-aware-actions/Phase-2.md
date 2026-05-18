# Phase 2 — Manifest, Background Service Worker, and Context-Menu Routing

## Phase Goal

Wire the platform surface for v0.2: extend `manifest.json` with the
`contextMenus` permission and the three new keyboard commands; register
context-menu items from the background service worker; and route both
context-menu clicks and command events to the active tab's content script
as a uniform `{ a: 'action', id: <ActionId> }` message.

After this phase, right-clicking on a page shows the new menu items and
selecting one delivers a typed message to the content script — but the
content script does not yet handle that message. Phase-3 adds the dispatch
side.

**Success criteria:**

- `manifest.json` declares `contextMenus` permission and exactly 4 commands
  total.
- `src/background/menus.ts` exports `registerMenus()` and an `onClicked`
  router that calls `chrome.tabs.sendMessage` with a typed payload.
- `background.ts` calls `registerMenus()` on both `runtime.onInstalled` and
  `runtime.onStartup`.
- `src/background/handler.ts` handles the three new commands by sending the
  same typed payload to the active tab.
- `tests/setup.ts` mocks the new chrome surfaces.
- `tests/background-menus.test.ts` covers menu registration and click
  routing; `tests/background-handler.test.ts` is extended for the new
  commands.
- `npm run lint:ci && npm run typecheck && npm run coverage && npm run build`
  all exit 0.
- Existing 53 tests still pass.

**Estimated tokens:** ~22k

## Prerequisites

- Phase-1 complete (Tasks 1.1 - 1.4 merged).
- `src/transform-prompts.ts` exports `ActionId` and `ACTION_DESCRIPTORS`.
- `src/heavy.ts` exists.

## Tasks

### Task 2.1 — Extend the Chrome Mock in `tests/setup.ts`

**Goal:** The `chrome` mock currently exposes `storage`, `runtime`,
`commands`, and `tabs`. Add `contextMenus` and the additional `runtime`
lifecycle listeners so the Phase-2 modules can be unit-tested.

**Files to Modify/Create:**

- `tests/setup.ts` (modify)

**Prerequisites:** none

**Implementation Steps:**

- Add to the existing `chromeMock`:

  ```ts
  contextMenus: {
    create: vi.fn(),
    removeAll: vi.fn((cb?: () => void) => { if (cb) cb(); }),
    onClicked: { addListener: vi.fn() },
  },
  ```

- Add to `runtime`:

  ```ts
  onInstalled: { addListener: vi.fn() },
  onStartup: { addListener: vi.fn() },
  ```

- In the `beforeEach` block, clear every new mock:
  - `chromeMock.contextMenus.create.mockClear();`
  - `chromeMock.contextMenus.removeAll.mockClear();`
  - `chromeMock.contextMenus.onClicked.addListener.mockClear();`
  - `chromeMock.runtime.onInstalled.addListener.mockClear();`
  - `chromeMock.runtime.onStartup.addListener.mockClear();`
  - Reset `removeAll.mockImplementation((cb) => { if (cb) cb(); })`
    (default behavior).

- Do not break the existing `chromeMock` export shape. Just add fields.

**Verification Checklist:**

- [ ] `tests/setup.ts` exports a `chromeMock` that includes
      `contextMenus.create`, `contextMenus.removeAll`,
      `contextMenus.onClicked.addListener`, `runtime.onInstalled.addListener`,
      `runtime.onStartup.addListener`
- [ ] Every existing test still passes
- [ ] `npm run typecheck` exits 0

**Testing Instructions:**

- `npm test` — confirm zero regressions across the 53 existing tests.
- No new test file added in this task; the mocks are exercised in the
  Phase-2 tests added by subsequent tasks.

**Commit Message Template:**

```text
test(setup): add contextMenus and runtime lifecycle mocks

- chrome.contextMenus.create, .removeAll, .onClicked.addListener
- chrome.runtime.onInstalled.addListener, .onStartup.addListener
- Mocks cleared in beforeEach to match the existing reset pattern
```

---

### Task 2.2 — Implement `registerMenus` and `onClicked` Router

**Goal:** Build the background-side context-menu module. It registers a menu
item per `ACTION_DESCRIPTOR`, groups them under their `parentLabel`, and
forwards clicks to the active tab as `{ a: 'action', id: <ActionId> }`.

**Files to Modify/Create:**

- `src/background/menus.ts` (new)
- `src/background/handler.ts` (modify — extend message protocol)
- `tests/background-menus.test.ts` (new)

**Prerequisites:** Task 2.1 complete (mocks available).

**Implementation Steps:**

- Define the action message protocol next to the existing toggle protocol
  in `src/background/handler.ts`. Add:

  ```ts
  import type { ActionId } from '../transform-prompts.js';

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
  ```

- Create `src/background/menus.ts`:

  ```ts
  import { ACTION_DESCRIPTORS, type ActionDescriptor, type ActionId } from '../transform-prompts.js';
  import { ACTION_MESSAGE_KIND, type ActionMessage } from './handler.js';

  /**
   * Map an action descriptor to chrome.contextMenus.create properties.
   * `contexts` is derived from the action kind.
   */
  function descriptorToMenuProps(d: ActionDescriptor): chrome.contextMenus.CreateProperties {
    const contexts: chrome.contextMenus.ContextType[] = (() => {
      switch (d.kind) {
        case 'chat': return ['selection'];
        case 'page-chat': return ['page'];
        case 'transform-editable': return ['editable'];
        case 'transform-readonly': return ['selection'];
      }
    })();
    return { id: d.id, title: d.label, contexts };
  }

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

      // Top-level items first
      const topLevel = byParent.get(null) ?? [];
      for (const d of topLevel) api.create(descriptorToMenuProps(d));

      // Submenu parents and their children
      for (const [parentLabel, children] of byParent) {
        if (parentLabel === null) continue;
        const parentId = `parent:${parentLabel}`;
        // Parent menu inherits the union of children's contexts
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
   * Handle a context-menu click. Sends an ActionMessage to the active tab.
   */
  export function onMenuClicked(
    info: chrome.contextMenus.OnClickData,
    tab: chrome.tabs.Tab | undefined,
    tabsApi: typeof chrome.tabs = chrome.tabs,
  ): void {
    const id = info.menuItemId;
    if (typeof id !== 'string') return;
    if (id.startsWith('parent:')) return; // submenu parent click — ignore
    const tabId = tab?.id;
    if (tabId == null) return;
    const msg: ActionMessage = { a: ACTION_MESSAGE_KIND, id: id as ActionId };
    tabsApi.sendMessage(tabId, msg);
  }
  ```

  Notes:
  - `api.removeAll` runs asynchronously (with a callback). Subsequent
    `api.create` calls inside the callback are safe because the worker is
    single-threaded.
  - `info.menuItemId` is typed as `string | number` by `@types/chrome`.
    Branch on `typeof === 'string'` and ignore unexpected shapes.
  - The `id` cast to `ActionId` is justified: we only register menu items
    whose ids come from `ACTION_DESCRIPTORS`. The cast is safe by
    construction. A defensive check is added in the content script in
    Phase-3 in case of stale registration.

- Update `background.ts`:

  ```ts
  import { handleCommand } from './src/background/handler.js';
  import { onMenuClicked, registerMenus } from './src/background/menus.js';

  chrome.commands.onCommand.addListener(handleCommand);
  chrome.contextMenus.onClicked.addListener(onMenuClicked);
  chrome.runtime.onInstalled.addListener(() => registerMenus());
  chrome.runtime.onStartup.addListener(() => registerMenus());
  ```

- Create `tests/background-menus.test.ts`. At minimum:
  1. `registerMenus` calls `removeAll` first, then `create` for each
     descriptor.
  1. The number of `create` calls equals (top-level descriptors) +
     (submenu parents) + (submenu children). For the v0.2 schema this is
     `2 (top-level: ask_about_selection, summarize_page) + 2 (parents) + 9 (children) = 13`.
     Verify with a length assertion on `create.mock.calls`.
  1. Submenu children receive `parentId: 'parent:Rewrite'` or
     `parentId: 'parent:Translate / Simplify / Summarize in place'`.
  1. `descriptorToMenuProps` mapping: editable kind → `['editable']`
     context, etc. Assert on a representative call.
  1. `onMenuClicked` with `menuItemId === 'ask_about_selection'` and
     `tab.id === 5` invokes `tabs.sendMessage` with
     `(5, { a: 'action', id: 'ask_about_selection' })`.
  1. `onMenuClicked` returns silently when `tab` is undefined.
  1. `onMenuClicked` returns silently when `tab.id` is undefined.
  1. `onMenuClicked` ignores menu ids starting with `'parent:'` (submenu
     parents are not actionable themselves).
  1. `onMenuClicked` ignores numeric `menuItemId` values.

**Verification Checklist:**

- [ ] `src/background/menus.ts` exports `registerMenus` and `onMenuClicked`
- [ ] `background.ts` registers all four chrome listeners
- [ ] `tests/background-menus.test.ts` has >= 9 tests, all passing
- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint:ci` exits 0
- [ ] `npm run coverage` shows `src/background/menus.ts` at >= 90%
      statements

**Testing Instructions:**

- `npx vitest run tests/background-menus.test.ts`
- Use the existing `chromeMock` from `./setup.js`. Override
  `chromeMock.contextMenus.removeAll.mockImplementation` to call the
  callback synchronously where needed.

**Commit Message Template:**

```text
feat(menus): register chrome.contextMenus for DOM-aware actions

- ACTION_DESCRIPTORS drive both top-level items and submenus (Rewrite,
  Translate/Simplify/Summarize in place); descriptors expose contexts
  appropriate to each kind (selection, editable, page)
- onMenuClicked forwards { a: 'action', id } to the active tab; submenu
  parent clicks and unknown shapes are ignored
- background.ts registers the handler on both onInstalled and onStartup
  so menu items survive service-worker termination
- Tests cover removeAll-then-create order, parent/child registration,
  message shape, and the no-tab branch
```

---

### Task 2.3 — Extend `handleCommand` for the Three New Commands

**Goal:** When the user presses a v0.2 hotkey, the existing
`chrome.commands.onCommand` listener should route the command to the active
tab as an `ActionMessage` — exactly the same shape that
`chrome.contextMenus.onClicked` produces. This unifies the dispatch and
keeps Phase-3 simple (one message kind to handle).

**Files to Modify/Create:**

- `src/background/handler.ts` (modify)
- `tests/background-handler.test.ts` (modify)

**Prerequisites:** Task 2.2 complete (`ActionMessage` and
`ACTION_MESSAGE_KIND` defined).

**Implementation Steps:**

- Add a command→action mapping table to `src/background/handler.ts`:

  ```ts
  const COMMAND_TO_ACTION: Record<string, ActionId> = {
    ask_about_selection: 'ask_about_selection',
    rewrite_selection: 'rewrite_improve',
    translate_selection: 'translate_en',
  };
  ```

  Notes:
  - `ask_about_selection` maps to the same-named action id.
  - `rewrite_selection` (the command) maps to `rewrite_improve` (the most
    useful default; the menu still exposes the other rewrite variants).
  - `translate_selection` (the command) maps to `translate_en` (the most
    common default; the menu exposes ES / FR).
  - This is documented in `docs/dom-actions.md` (Phase-4).

- Refactor `handleCommand`:

  ```ts
  export function handleCommand(command: string): void {
    if (command === TOGGLE_COMMAND) {
      sendToActiveTab(TOGGLE_MESSAGE);
      return;
    }
    const actionId = COMMAND_TO_ACTION[command];
    if (actionId) {
      sendToActiveTab({ a: ACTION_MESSAGE_KIND, id: actionId });
      return;
    }
    // Unknown command — ignore.
  }

  function sendToActiveTab(message: unknown): void {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const id = tabs[0]?.id;
      if (id != null) chrome.tabs.sendMessage(id, message);
    });
  }
  ```

- Extend `tests/background-handler.test.ts`:
  1. `handleCommand('ask_about_selection')` → `tabs.sendMessage(1, { a: 'action', id: 'ask_about_selection' })`.
  1. `handleCommand('rewrite_selection')` → message id is `rewrite_improve`.
  1. `handleCommand('translate_selection')` → message id is `translate_en`.
  1. Unknown command (e.g. `'foo'`) → `tabs.sendMessage` not called.
  1. Active tab has no id → no message sent (existing test pattern).
  1. The existing toggle tests still pass unmodified.

**Verification Checklist:**

- [ ] `COMMAND_TO_ACTION` table defined and used
- [ ] `handleCommand` routes all four commands correctly
- [ ] `tests/background-handler.test.ts` adds >= 4 new tests
- [ ] All existing handler tests still pass
- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint:ci` exits 0

**Testing Instructions:**

- `npx vitest run tests/background-handler.test.ts`

**Commit Message Template:**

```text
feat(handler): route action commands to the active tab

- COMMAND_TO_ACTION table maps the three new commands
  (ask_about_selection, rewrite_selection, translate_selection) to
  ActionIds and sends ActionMessage to the active tab
- sendToActiveTab helper deduplicates the chrome.tabs.query + sendMessage
  pattern shared with the toggle command
- Existing TOGGLE_COMMAND path unchanged
```

---

### Task 2.4 — Update `manifest.json`

**Goal:** Declare the new permission and the three new keyboard commands.

**Files to Modify/Create:**

- `manifest.json` (modify)

**Prerequisites:** Tasks 2.2 and 2.3 complete (the manifest changes are
inert until the background wiring is in place).

**Implementation Steps:**

- In `manifest.json`, change the `permissions` array from
  `["activeTab", "scripting", "storage"]` to
  `["activeTab", "scripting", "storage", "contextMenus"]`. Append
  `contextMenus` at the end of the array; Chrome ignores the order, and
  the project's Biome 2.4.15 config does not enforce JSON array
  ordering (verified against `biome.json`).

- In the `commands` block, add three siblings to `toggle_ai_palette`. The
  manifest must end up with **exactly 4 commands** (the Chrome max).
  Suggested chords (from ADR-008):

  ```json
  "commands": {
    "toggle_ai_palette": {
      "suggested_key": { "default": "Ctrl+Shift+K", "mac": "Command+Shift+K" },
      "description": "Toggle AI Palette"
    },
    "ask_about_selection": {
      "suggested_key": { "default": "Ctrl+Shift+L", "mac": "Command+Shift+L" },
      "description": "Ask local-nano about the current selection"
    },
    "rewrite_selection": {
      "suggested_key": { "default": "Ctrl+Shift+I", "mac": "Command+Shift+I" },
      "description": "Rewrite the current selection (improve writing)"
    },
    "translate_selection": {
      "suggested_key": { "default": "Ctrl+Shift+U", "mac": "Command+Shift+U" },
      "description": "Translate the current selection to English"
    }
  }
  ```

- Do **not** bump `manifest.json`'s `version` field in this phase. The
  bump to `0.2.0` happens in Phase-4 alongside the CHANGELOG entry to
  keep the release-flow commits clean.

**Verification Checklist:**

- [ ] `manifest.json` has `"contextMenus"` in `permissions`
- [ ] `manifest.json` has exactly 4 commands
- [ ] Manifest JSON parses cleanly (`node -e "JSON.parse(require('fs').readFileSync('manifest.json'))"`)
- [ ] `npm run build` exits 0
- [ ] Load the unpacked extension in Chrome: the new chords appear at
      `chrome://extensions/shortcuts`; right-clicking on any page shows
      the new menu items (`Ask local-nano about this`, `Summarize this
      page`, `Rewrite ▸`, `Translate / Simplify / Summarize in place ▸`)

**Testing Instructions:**

- No new unit tests for `manifest.json`. The manual smoke is the
  verification step above.
- Run `npm run build` and reload the unpacked extension at
  `chrome://extensions`.

**Commit Message Template:**

```text
feat(manifest): add contextMenus permission and three action commands

- permissions += contextMenus (required for chrome.contextMenus API)
- commands += ask_about_selection (Ctrl+Shift+L),
  rewrite_selection (Ctrl+Shift+I), translate_selection (Ctrl+Shift+U)
- Brings the manifest to its 4-command Chrome cap
- Version stays at 0.1.1 until Phase-4 release commit
```

---

## Phase Verification

```bash
npm run lint:ci && npm run typecheck && npm run coverage && npm run build
```

All four must exit 0. Additionally:

- `tests/background-menus.test.ts` has >= 9 tests, all passing.
- `tests/background-handler.test.ts` has >= 7 tests total (4 existing + 3+
  new).
- Manual smoke: load the unpacked build; right-click on any page; the
  v0.2 menu items render. Clicking one does *not* yet do anything
  user-visible (Phase-3 handles dispatch) but must not throw an error in
  the service-worker console.
- Service-worker console shows no errors after `chrome.runtime.onInstalled`
  fires.

## Known Limitations Entering Phase-3

- Clicking a v0.2 menu item delivers a message to the content script, but
  the content script has no listener for `{ a: 'action', ... }` messages
  yet — clicks are silently dropped.
- Hotkeys do the same — they fire the command, route through the handler,
  send the message, and the content script ignores it.
- The selection-capture layer does not exist yet. Phase-3 adds it.
