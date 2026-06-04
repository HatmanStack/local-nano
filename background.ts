import { handleActionClick, handleCommand, refreshActionTitle } from './src/background/handler.js';
import {
  closeOffscreen,
  ensureOffscreen,
  handleAlarm,
  installEnsureListener,
  installPanelPinListener,
  recreateOffscreen,
  sendPrompt,
  streamPrompt,
} from './src/background/offscreen.js';

// Re-exported for any extension context that loads this module statically.
export { closeOffscreen, ensureOffscreen, recreateOffscreen, sendPrompt, streamPrompt };

// Content scripts ask the SW to ensure the offscreen document is up before
// they open a streaming port. This listener also fields the touch-idle signal
// that (re)schedules the idle-release alarm (Phase 4, ADR-P8).
installEnsureListener();

// Panel-pin lifetime (Layer B, Phase 3). A content-script panel that is visible
// holds a port named PANEL_PIN_PORT_NAME open to the SW; while at least one is
// open the SW holds its own port to the offscreen document, which keeps Chrome
// from reaping the offscreen during a tab switch. Registered at top level so it
// re-derives the count from live onConnect re-fires after SW eviction; Chrome
// dedupes addListener by the function reference.
installPanelPinListener();

// Idle-release alarm (ADR-P8, P9). The single named alarm wakes the SW after
// the configured inactivity timeout; the listener verifies idle then closes the
// offscreen document (or reschedules if a generation is in flight). Registered
// at top level so it survives SW eviction; Chrome dedupes addListener by the
// function reference, like the command listener below.
chrome.alarms.onAlarm.addListener(handleAlarm);

// SW DevTools convenience: `import()` is forbidden inside a service worker,
// so re-exports alone aren't reachable from the console. Tagging onto
// globalThis lets you call these directly.
Object.assign(globalThis as unknown as Record<string, unknown>, {
  ensureOffscreen,
  sendPrompt,
  streamPrompt,
  closeOffscreen,
  recreateOffscreen,
});

chrome.commands.onCommand.addListener(handleCommand);

// Toolbar-icon click path. Fresh Web Store installs don't always honor the
// command's suggested_key, so the icon is the no-config way in; the keyboard
// command still works once the user binds it at chrome://extensions/shortcuts.
chrome.action.onClicked.addListener(handleActionClick);

// Tooltip reflects the current binding: "(Ctrl+Shift+K)" when bound, or a
// pointer to chrome://extensions/shortcuts when not — self-documents the fix
// for the very install state that needs the toolbar fallback.
void refreshActionTitle();
