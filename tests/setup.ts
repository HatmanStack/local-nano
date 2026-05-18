import { beforeEach, vi } from 'vitest';

type StorageRecord = Record<string, unknown>;

class FakeStorageArea {
  store: StorageRecord = {};

  get = vi.fn(async (key?: string | string[] | null) => {
    if (key == null) return { ...this.store };
    if (typeof key === 'string') {
      return key in this.store ? { [key]: this.store[key] } : {};
    }
    const out: StorageRecord = {};
    for (const k of key) if (k in this.store) out[k] = this.store[k];
    return out;
  });

  set = vi.fn(async (items: StorageRecord) => {
    Object.assign(this.store, items);
  });

  clear = vi.fn(async () => {
    this.store = {};
  });
}

const local = new FakeStorageArea();

const chromeMock = {
  storage: { local },
  runtime: {
    getURL: vi.fn((p: string) => `chrome-extension://test/${p}`),
    onMessage: { addListener: vi.fn() },
  },
  commands: { onCommand: { addListener: vi.fn() } },
  tabs: {
    query: vi.fn((_q: unknown, cb: (tabs: Array<{ id?: number }>) => void) => cb([{ id: 1 }])),
    sendMessage: vi.fn(),
  },
};

(globalThis as any).chrome = chromeMock;

beforeEach(() => {
  local.store = {};
  local.get.mockClear();
  local.set.mockClear();
  chromeMock.runtime.getURL.mockClear();
  chromeMock.runtime.onMessage.addListener.mockClear();
  chromeMock.commands.onCommand.addListener.mockClear();
  chromeMock.tabs.query.mockClear();
  chromeMock.tabs.sendMessage.mockClear();
  // Default tabs.query implementation — overridable per-test.
  chromeMock.tabs.query.mockImplementation(
    (_q: unknown, cb: (tabs: Array<{ id?: number }>) => void) => cb([{ id: 1 }]),
  );
});

export { chromeMock };
