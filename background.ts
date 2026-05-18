import { handleCommand } from './src/background/handler.js';

chrome.commands.onCommand.addListener(handleCommand);
