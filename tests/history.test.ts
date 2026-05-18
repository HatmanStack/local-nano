import { describe, expect, it } from 'vitest';
import {
  loadHistory,
  saveHistory,
  storageKey,
  type Entry,
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
    chromeMock.storage.local.store['k'] = { not: 'an array' };
    expect(await loadHistory('k')).toEqual([]);
  });

  it('returns the stored entries', async () => {
    const entries: Entry[] = [
      { role: 'user', text: 'hi' },
      { role: 'model', text: 'hello' },
    ];
    chromeMock.storage.local.store['k'] = entries;
    expect(await loadHistory('k')).toEqual(entries);
  });
});

describe('saveHistory', () => {
  it('writes entries under the given key', async () => {
    const entries: Entry[] = [{ role: 'user', text: 'q' }];
    await saveHistory('k', entries);
    expect(chromeMock.storage.local.store['k']).toEqual(entries);
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
