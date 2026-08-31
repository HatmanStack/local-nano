import { describe, expect, it } from 'vitest';
import {
  CONTENT_SCRIPT_FILE,
  handleActionClick,
  handleCommand,
  isNoReceiverError,
  RESTRICTED_BADGE_COLOR,
  RESTRICTED_BADGE_TEXT,
  RESTRICTED_TITLE,
  refreshActionTitle,
  TOGGLE_COMMAND,
  TOGGLE_MESSAGE,
} from '../src/background/handler.js';
import { chromeMock } from './setup.js';

describe('handleCommand', () => {
  it('ignores unknown commands', () => {
    handleCommand('something_else');
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('sends a toggle message to the active tab', () => {
    handleCommand(TOGGLE_COMMAND);
    expect(chromeMock.tabs.query).toHaveBeenCalledWith(
      { active: true, currentWindow: true },
      expect.any(Function),
    );
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      TOGGLE_MESSAGE,
      expect.any(Function),
    );
  });

  it('does not send a message when the active tab has no id', () => {
    chromeMock.tabs.query.mockImplementationOnce((_q, cb) => cb([{}]));
    handleCommand(TOGGLE_COMMAND);
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('does not send a message when no tabs are returned', () => {
    chromeMock.tabs.query.mockImplementationOnce((_q, cb) => cb([]));
    handleCommand(TOGGLE_COMMAND);
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe('handleActionClick', () => {
  it('sends a toggle message to the clicked tab', () => {
    handleActionClick({ id: 7 } as chrome.tabs.Tab);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      TOGGLE_MESSAGE,
      expect.any(Function),
    );
  });

  it('does not send a message when the tab has no id', () => {
    handleActionClick({} as chrome.tabs.Tab);
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe('refreshActionTitle', () => {
  it('reflects the bound shortcut in the tooltip when set', async () => {
    chromeMock.commands.getAll.mockImplementationOnce(async () => [
      { name: TOGGLE_COMMAND, shortcut: 'Ctrl+Shift+K' },
    ]);
    await refreshActionTitle();
    expect(chromeMock.action.setTitle).toHaveBeenCalledWith({
      title: 'Toggle Local Nano (Ctrl+Shift+K)',
    });
  });

  it('points the user at chrome://extensions/shortcuts when unbound', async () => {
    chromeMock.commands.getAll.mockImplementationOnce(async () => [
      { name: TOGGLE_COMMAND, shortcut: '' },
    ]);
    await refreshActionTitle();
    expect(chromeMock.action.setTitle).toHaveBeenCalledWith({
      title: 'Toggle Local Nano — set a shortcut at chrome://extensions/shortcuts',
    });
  });

  it('points the user at chrome://extensions/shortcuts when the command is missing', async () => {
    chromeMock.commands.getAll.mockImplementationOnce(async () => []);
    await refreshActionTitle();
    expect(chromeMock.action.setTitle).toHaveBeenCalledWith({
      title: 'Toggle Local Nano — set a shortcut at chrome://extensions/shortcuts',
    });
  });
});

describe('isNoReceiverError', () => {
  it('recognizes the message Chrome sends when a tab has no content script', () => {
    expect(
      isNoReceiverError({
        message: 'Could not establish connection. Receiving end does not exist.',
      }),
    ).toBe(true);
  });

  it('recognizes the bare "Receiving end does not exist" form', () => {
    expect(isNoReceiverError({ message: 'Receiving end does not exist.' })).toBe(true);
  });

  it('does not claim unrelated errors', () => {
    expect(isNoReceiverError({ message: 'The tab was closed.' })).toBe(false);
    expect(isNoReceiverError({})).toBe(false);
    expect(isNoReceiverError(undefined)).toBe(false);
  });
});

/**
 * A tab that predates the install or auto-update has no content script, so the
 * toggle send fails. The click must still open the panel rather than being
 * dropped — see `injectAndRetry` in src/background/handler.ts.
 */
describe('toggling a tab whose content script is missing', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  /** Drive the sendMessage callback with a chrome.runtime.lastError set. */
  function failNextSendWith(message: string): void {
    chromeMock.tabs.sendMessage.mockImplementationOnce(
      (_id: number, _msg: unknown, cb?: () => void) => {
        chromeMock.runtime.lastError = { message };
        cb?.();
        chromeMock.runtime.lastError = undefined;
      },
    );
  }

  it('injects the content script and retries the toggle', async () => {
    failNextSendWith('Could not establish connection. Receiving end does not exist.');
    handleActionClick({ id: 7 } as chrome.tabs.Tab);
    await flush();

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: [CONTENT_SCRIPT_FILE],
    });
    // Once for the failed send, once for the retry after injection.
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(chromeMock.tabs.sendMessage).toHaveBeenLastCalledWith(
      7,
      TOGGLE_MESSAGE,
      expect.any(Function),
    );
  });

  it('heals the keyboard-command path too, not just the toolbar click', async () => {
    failNextSendWith('Could not establish connection. Receiving end does not exist.');
    handleCommand(TOGGLE_COMMAND);
    await flush();

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1 },
      files: [CONTENT_SCRIPT_FILE],
    });
  });

  it('does not inject when the send succeeded', async () => {
    handleActionClick({ id: 7 } as chrome.tabs.Tab);
    await flush();
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('does not inject on an unrelated send failure', async () => {
    failNextSendWith('The tab was closed.');
    handleActionClick({ id: 7 } as chrome.tabs.Tab);
    await flush();
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('stays quiet on a tab it may never script (chrome://, the Web Store)', async () => {
    failNextSendWith('Could not establish connection. Receiving end does not exist.');
    chromeMock.scripting.executeScript.mockRejectedValueOnce(
      new Error('Cannot access a chrome:// URL'),
    );
    handleActionClick({ id: 7 } as chrome.tabs.Tab);
    await flush();

    // Injection was attempted and refused; no retry, and nothing thrown.
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });
});

/**
 * `chrome://` pages, the Web Store, the PDF viewer and a blank new tab can
 * never be scripted, so the panel has nowhere to open. That is the one failure
 * the user can actually act on — open a site — so the icon has to say so
 * rather than swallowing the click.
 */
describe('a tab the panel can never open in', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function failNextSendWith(message: string): void {
    chromeMock.tabs.sendMessage.mockImplementationOnce(
      (_id: number, _msg: unknown, cb?: () => void) => {
        chromeMock.runtime.lastError = { message };
        cb?.();
        chromeMock.runtime.lastError = undefined;
      },
    );
  }

  const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

  it('marks the icon when Chrome refuses the injection', async () => {
    failNextSendWith(NO_RECEIVER);
    chromeMock.scripting.executeScript.mockRejectedValueOnce(
      new Error('Cannot access a chrome:// URL'),
    );
    handleActionClick({ id: 7 } as chrome.tabs.Tab);
    await flush();

    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({
      tabId: 7,
      text: RESTRICTED_BADGE_TEXT,
    });
    expect(chromeMock.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      tabId: 7,
      color: RESTRICTED_BADGE_COLOR,
    });
    expect(chromeMock.action.setTitle).toHaveBeenCalledWith({
      tabId: 7,
      title: RESTRICTED_TITLE,
    });
  });

  it('scopes the marker to that tab, leaving other tabs alone', async () => {
    failNextSendWith(NO_RECEIVER);
    chromeMock.scripting.executeScript.mockRejectedValueOnce(new Error('Cannot access'));
    handleActionClick({ id: 7 } as chrome.tabs.Tab);
    await flush();

    for (const call of chromeMock.action.setBadgeText.mock.calls) {
      expect(call[0]).toHaveProperty('tabId', 7);
    }
  });

  it('does not mark the icon when the injection succeeded', async () => {
    failNextSendWith(NO_RECEIVER);
    handleActionClick({ id: 7 } as chrome.tabs.Tab);
    await flush();

    expect(chromeMock.action.setBadgeText).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: RESTRICTED_BADGE_TEXT }),
    );
  });

  it('clears the marker once the panel does open in a flagged tab', async () => {
    chromeMock.action.getTitle.mockImplementation(async () => RESTRICTED_TITLE);
    handleActionClick({ id: 7 } as chrome.tabs.Tab);
    // The default sendMessage mock invokes no callback; drive the success path.
    const cb = chromeMock.tabs.sendMessage.mock.calls[0]?.[2] as (() => void) | undefined;
    cb?.();
    await flush();

    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '' });
    // Tooltip is restored explicitly, not blanked, so the tab override dies with it.
    expect(chromeMock.action.setTitle).toHaveBeenCalledWith({
      tabId: 7,
      title: 'Toggle Local Nano — set a shortcut at chrome://extensions/shortcuts',
    });
  });

  it('leaves a tab it never flagged completely untouched', async () => {
    // getTitle reports the normal tooltip, so this tab was never restricted.
    handleActionClick({ id: 7 } as chrome.tabs.Tab);
    const cb = chromeMock.tabs.sendMessage.mock.calls[0]?.[2] as (() => void) | undefined;
    cb?.();
    await flush();

    // No tab-scoped tooltip copy is pinned, so it cannot go stale later.
    expect(chromeMock.action.setTitle).not.toHaveBeenCalled();
    expect(chromeMock.action.setBadgeText).not.toHaveBeenCalled();
  });

  it('clears the marker after a heal-and-retry succeeds', async () => {
    chromeMock.action.getTitle.mockImplementation(async () => RESTRICTED_TITLE);
    failNextSendWith(NO_RECEIVER);
    handleActionClick({ id: 7 } as chrome.tabs.Tab);
    await flush();

    const retry = chromeMock.tabs.sendMessage.mock.calls.at(-1)?.[2] as (() => void) | undefined;
    retry?.();
    await flush();

    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '' });
  });
});
