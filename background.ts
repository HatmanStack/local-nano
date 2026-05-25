import { handleCommand } from './src/background/handler.js';
import {
  closeOffscreen,
  ensureOffscreen,
  handleAlarm,
  installEnsureListener,
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
