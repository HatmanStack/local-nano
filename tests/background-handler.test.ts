import { describe, expect, it } from 'vitest';
import {
  ACTION_MESSAGE_KIND,
  handleCommand,
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
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, TOGGLE_MESSAGE);
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

  it('routes ask_about_selection command to an ActionMessage', () => {
    handleCommand('ask_about_selection');
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, {
      a: ACTION_MESSAGE_KIND,
      id: 'ask_about_selection',
    });
  });

  it('routes rewrite_selection command to rewrite_improve', () => {
    handleCommand('rewrite_selection');
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, {
      a: ACTION_MESSAGE_KIND,
      id: 'rewrite_improve',
    });
  });

  it('routes translate_selection command to translate_en', () => {
    handleCommand('translate_selection');
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, {
      a: ACTION_MESSAGE_KIND,
      id: 'translate_en',
    });
  });

  it('does not send an action message when the active tab has no id', () => {
    chromeMock.tabs.query.mockImplementationOnce((_q, cb) => cb([{}]));
    handleCommand('ask_about_selection');
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
