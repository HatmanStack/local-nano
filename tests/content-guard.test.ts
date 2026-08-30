import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The service worker re-injects `dist/content.js` into tabs that predate the
 * install or auto-update. That injection can land in a tab that already has
 * the declared content script, so running the file twice must not build a
 * second panel on top of the first.
 */
describe('content script — re-injection guard', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete (window as { __localNanoLoaded?: true }).__localNanoLoaded;
    vi.resetModules();
  });

  async function runContentScript(): Promise<void> {
    await import('../content.js');
  }

  it('builds exactly one panel on first run', async () => {
    await runContentScript();
    expect(window.__localNanoLoaded).toBe(true);
    expect(document.body.children).toHaveLength(1);
  });

  it('does not build a second panel when the file runs again', async () => {
    await runContentScript();
    const afterFirst = document.body.innerHTML;

    vi.resetModules();
    await runContentScript();

    expect(document.body.children).toHaveLength(1);
    expect(document.body.innerHTML).toBe(afterFirst);
  });

  it('does not add a second animation <style> tag on the repeat run', async () => {
    await runContentScript();
    const styleCount = () =>
      [...document.head.querySelectorAll('style')].filter((s) =>
        (s.textContent ?? '').includes('ln-bounce'),
      ).length;
    expect(styleCount()).toBe(1);

    vi.resetModules();
    await runContentScript();
    expect(styleCount()).toBe(1);
  });
});
