import { describe, expect, it } from 'vitest';
import {
  handleActionClick,
  handleCommand,
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
