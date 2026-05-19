import { handleCommand } from './src/background/handler.js';
import { onMenuClicked, registerMenus } from './src/background/menus.js';

chrome.commands.onCommand.addListener(handleCommand);
chrome.contextMenus.onClicked.addListener(onMenuClicked);
chrome.runtime.onInstalled.addListener(() => registerMenus());
chrome.runtime.onStartup.addListener(() => registerMenus());
