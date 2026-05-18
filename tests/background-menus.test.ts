import { beforeEach, describe, expect, it } from 'vitest';
import { onMenuClicked, registerMenus } from '../src/background/menus.js';
import { ACTION_DESCRIPTORS } from '../src/transform-prompts.js';
import { chromeMock } from './setup.js';

describe('registerMenus', () => {
  beforeEach(() => {
    registerMenus(chromeMock.contextMenus as unknown as typeof chrome.contextMenus);
  });

  it('calls removeAll before creating any items', () => {
    const removeAllOrder = chromeMock.contextMenus.removeAll.mock.invocationCallOrder[0];
    const firstCreateOrder = chromeMock.contextMenus.create.mock.invocationCallOrder[0];
    expect(removeAllOrder).toBeLessThan(firstCreateOrder);
  });

  it('creates the expected total number of menu items (top-level + parents + children)', () => {
    // Top-level: ask_about_selection, summarize_page (2)
    // Parents: Rewrite, Translate/Simplify/Summarize in place (2)
    // Children: 4 rewrite + 5 transform-readonly = 9
    // Total: 13
    expect(chromeMock.contextMenus.create).toHaveBeenCalledTimes(13);
  });

  it('creates top-level items first (without a parentId)', () => {
    const calls = chromeMock.contextMenus.create.mock.calls;
    const askCall = calls.find(
      ([props]) => (props as { id?: string }).id === 'ask_about_selection',
    );
    const summarizeCall = calls.find(
      ([props]) => (props as { id?: string }).id === 'summarize_page',
    );
    expect(askCall).toBeDefined();
    expect(summarizeCall).toBeDefined();
    expect((askCall?.[0] as { parentId?: string }).parentId).toBeUndefined();
    expect((summarizeCall?.[0] as { parentId?: string }).parentId).toBeUndefined();
  });

  it('registers Rewrite submenu children under parent:Rewrite', () => {
    const calls = chromeMock.contextMenus.create.mock.calls;
    const rewriteChildren = ACTION_DESCRIPTORS.filter((d) => d.parentLabel === 'Rewrite');
    for (const child of rewriteChildren) {
      const childCall = calls.find(([props]) => (props as { id?: string }).id === child.id);
      expect(childCall).toBeDefined();
      expect((childCall?.[0] as { parentId?: string }).parentId).toBe('parent:Rewrite');
    }
  });

  it('registers transform-readonly children under parent:Translate / Simplify / Summarize in place', () => {
    const calls = chromeMock.contextMenus.create.mock.calls;
    const transformChildren = ACTION_DESCRIPTORS.filter(
      (d) => d.parentLabel === 'Translate / Simplify / Summarize in place',
    );
    for (const child of transformChildren) {
      const childCall = calls.find(([props]) => (props as { id?: string }).id === child.id);
      expect(childCall).toBeDefined();
      expect((childCall?.[0] as { parentId?: string }).parentId).toBe(
        'parent:Translate / Simplify / Summarize in place',
      );
    }
  });

  it('maps action kinds to the correct chrome contexts', () => {
    const calls = chromeMock.contextMenus.create.mock.calls;
    const ask = calls.find(([props]) => (props as { id?: string }).id === 'ask_about_selection');
    const summarize = calls.find(([props]) => (props as { id?: string }).id === 'summarize_page');
    const rewriteImprove = calls.find(
      ([props]) => (props as { id?: string }).id === 'rewrite_improve',
    );
    const translateEn = calls.find(([props]) => (props as { id?: string }).id === 'translate_en');
    expect((ask?.[0] as { contexts?: string[] }).contexts).toEqual(['selection']);
    expect((summarize?.[0] as { contexts?: string[] }).contexts).toEqual(['page']);
    expect((rewriteImprove?.[0] as { contexts?: string[] }).contexts).toEqual(['editable']);
    expect((translateEn?.[0] as { contexts?: string[] }).contexts).toEqual(['selection']);
  });

  it('creates parent menu items with id prefixed by parent:', () => {
    const calls = chromeMock.contextMenus.create.mock.calls;
    const rewriteParent = calls.find(
      ([props]) => (props as { id?: string }).id === 'parent:Rewrite',
    );
    const transformParent = calls.find(
      ([props]) =>
        (props as { id?: string }).id === 'parent:Translate / Simplify / Summarize in place',
    );
    expect(rewriteParent).toBeDefined();
    expect(transformParent).toBeDefined();
    expect((rewriteParent?.[0] as { title?: string }).title).toBe('Rewrite');
    expect((transformParent?.[0] as { title?: string }).title).toBe(
      'Translate / Simplify / Summarize in place',
    );
  });
});

describe('onMenuClicked', () => {
  it('sends an ActionMessage to the active tab on a known action id', () => {
    onMenuClicked(
      { menuItemId: 'ask_about_selection' } as chrome.contextMenus.OnClickData,
      { id: 5 } as chrome.tabs.Tab,
      chromeMock.tabs as unknown as typeof chrome.tabs,
    );
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(5, {
      a: 'action',
      id: 'ask_about_selection',
    });
  });

  it('returns silently when tab is undefined', () => {
    onMenuClicked(
      { menuItemId: 'ask_about_selection' } as chrome.contextMenus.OnClickData,
      undefined,
      chromeMock.tabs as unknown as typeof chrome.tabs,
    );
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('returns silently when tab.id is undefined', () => {
    onMenuClicked(
      { menuItemId: 'ask_about_selection' } as chrome.contextMenus.OnClickData,
      {} as chrome.tabs.Tab,
      chromeMock.tabs as unknown as typeof chrome.tabs,
    );
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores menu ids starting with parent:', () => {
    onMenuClicked(
      { menuItemId: 'parent:Rewrite' } as chrome.contextMenus.OnClickData,
      { id: 5 } as chrome.tabs.Tab,
      chromeMock.tabs as unknown as typeof chrome.tabs,
    );
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores numeric menuItemId values', () => {
    onMenuClicked(
      { menuItemId: 42 } as chrome.contextMenus.OnClickData,
      { id: 5 } as chrome.tabs.Tab,
      chromeMock.tabs as unknown as typeof chrome.tabs,
    );
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
