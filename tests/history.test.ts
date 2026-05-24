import { describe, expect, it } from 'vitest';
import {
  type Entry,
  loadHistory,
  MAX_HISTORY,
  type Role,
  saveHistory,
  storageKey,
} from '../src/history.js';
import { chromeMock } from './setup.js';

describe('storageKey', () => {
  it('scopes the key by origin + pathname', () => {
    expect(storageKey({ origin: 'https://a.example', pathname: '/x' })).toBe(
      'local-nano:history:https://a.example/x',
    );
  });

  it('treats different paths under the same origin as distinct keys', () => {
    const k1 = storageKey({ origin: 'https://a.example', pathname: '/x' });
    const k2 = storageKey({ origin: 'https://a.example', pathname: '/y' });
    expect(k1).not.toBe(k2);
  });
});

describe('loadHistory', () => {
  it('returns [] when nothing is stored', async () => {
    expect(await loadHistory('missing')).toEqual([]);
  });

  it('returns [] when the stored value is not an array', async () => {
    chromeMock.storage.local.store.k = { not: 'an array' };
    expect(await loadHistory('k')).toEqual([]);
  });

  it('returns the stored entries', async () => {
    const entries: Entry[] = [
      { role: 'user', text: 'hi' },
      { role: 'model', text: 'hello' },
    ];
    chromeMock.storage.local.store.k = entries;
    expect(await loadHistory('k')).toEqual(entries);
  });

  it('drops malformed entries and keeps the valid ones in order', async () => {
    chromeMock.storage.local.store.k = [
      { role: 'user', text: 'one' },
      { role: 'bogus', text: 'bad role' },
      { role: 'model', text: 123 },
      null,
      42,
      {},
      { role: 'system', text: 'two' },
    ];
    expect(await loadHistory('k')).toEqual([
      { role: 'user', text: 'one' },
      { role: 'system', text: 'two' },
    ]);
  });

  it('returns [] when every stored entry is malformed', async () => {
    chromeMock.storage.local.store.k = [{ role: 'nope' }, null, 7, { text: 5 }];
    expect(await loadHistory('k')).toEqual([]);
  });
});

describe('saveHistory', () => {
  it('writes entries under the given key', async () => {
    const entries: Entry[] = [{ role: 'user', text: 'q' }];
    await saveHistory('k', entries);
    expect(chromeMock.storage.local.store.k).toEqual(entries);
  });

  it('round-trips with loadHistory', async () => {
    const entries: Entry[] = [
      { role: 'user', text: 'q1' },
      { role: 'model', text: 'a1' },
    ];
    await saveHistory('k', entries);
    expect(await loadHistory('k')).toEqual(entries);
  });
});

describe('saveHistory — MAX_HISTORY eviction', () => {
  it('stores at most MAX_HISTORY entries', async () => {
    const entries: Entry[] = Array.from({ length: MAX_HISTORY + 10 }, (_, k) => ({
      role: 'user' as Role,
      text: `msg ${k}`,
    }));
    await saveHistory('k', entries);
    const stored = chromeMock.storage.local.store.k as Entry[];
    expect(stored.length).toBe(MAX_HISTORY);
  });

  it('keeps the most recent entries when trimming', async () => {
    const entries: Entry[] = Array.from({ length: MAX_HISTORY + 5 }, (_, k) => ({
      role: 'user' as Role,
      text: `msg ${k}`,
    }));
    await saveHistory('k', entries);
    const stored = chromeMock.storage.local.store.k as Entry[];
    expect(stored[0].text).toBe(`msg 5`);
    expect(stored[stored.length - 1].text).toBe(`msg ${MAX_HISTORY + 4}`);
  });

  it('does not trim when under the cap', async () => {
    const entries: Entry[] = [{ role: 'user', text: 'hi' }];
    await saveHistory('k', entries);
    const stored = chromeMock.storage.local.store.k as Entry[];
    expect(stored.length).toBe(1);
  });
});
