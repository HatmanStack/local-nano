import { handleCommand } from './src/background/handler.js';
import {
  closeOffscreen,
  ensureOffscreen,
  installEnsureListener,
  recreateOffscreen,
  sendPrompt,
  streamPrompt,
} from './src/background/offscreen.js';

// Re-exported for any extension context that loads this module statically.
export { closeOffscreen, ensureOffscreen, recreateOffscreen, sendPrompt, streamPrompt };

// Content scripts ask the SW to ensure the offscreen document is up before
// they open a streaming port. This listener handles that handshake.
installEnsureListener();

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
