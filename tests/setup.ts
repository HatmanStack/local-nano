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

/**
 * Minimal `chrome.runtime.Port` stand-in for tests. The SW-side helper
 * connects, attaches listeners, and posts messages; tests drive the
 * "offscreen side" by calling `_emit` / `_emitDisconnect` on the port the
 * mock returned for that connect call.
 */
export class FakePort {
  name: string;
  sent: unknown[] = [];
  private msgListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  private connected = true;

  onMessage = {
    addListener: (l: (m: unknown) => void) => {
      this.msgListeners.push(l);
    },
    removeListener: (l: (m: unknown) => void) => {
      this.msgListeners = this.msgListeners.filter((x) => x !== l);
    },
    hasListener: (l: (m: unknown) => void) => this.msgListeners.includes(l),
  };

  onDisconnect = {
    addListener: (l: () => void) => {
      this.disconnectListeners.push(l);
    },
    removeListener: (l: () => void) => {
      this.disconnectListeners = this.disconnectListeners.filter((x) => x !== l);
    },
    hasListener: (l: () => void) => this.disconnectListeners.includes(l),
  };

  constructor(name: string) {
    this.name = name;
  }

  postMessage = vi.fn((msg: unknown) => {
    if (!this.connected) throw new Error('port is disconnected');
    this.sent.push(msg);
  });

  disconnect = vi.fn(() => {
    if (!this.connected) return;
    this.connected = false;
    for (const l of this.disconnectListeners) l();
  });

  /** Test helper: emit a message from the "offscreen" side. */
  _emit(message: unknown) {
    for (const l of this.msgListeners) l(message);
  }

  /** Test helper: fire onDisconnect (e.g. offscreen side dropped). */
  _emitDisconnect() {
    if (!this.connected) return;
    this.connected = false;
    for (const l of this.disconnectListeners) l();
  }

  get isConnected() {
    return this.connected;
  }
}

const local = new FakeStorageArea();

const chromeMock = {
  storage: { local },
  runtime: {
    getURL: vi.fn((p: string) => `chrome-extension://test/${p}`),
    getManifest: vi.fn(() => ({ version: '0.2.4' })),
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(async (_msg: unknown) => undefined as unknown),
    lastError: undefined as { message?: string } | undefined,
    connect: vi.fn((opts: { name: string }) => new FakePort(opts.name)),
  },
  commands: { onCommand: { addListener: vi.fn() } },
  tabs: {
    query: vi.fn((_q: unknown, cb: (tabs: Array<{ id?: number }>) => void) => cb([{ id: 1 }])),
    sendMessage: vi.fn(),
  },
  offscreen: {
    createDocument: vi.fn(async (_opts: unknown) => undefined),
    closeDocument: vi.fn(async () => undefined),
    hasDocument: vi.fn(async () => false),
  },
};

// biome-ignore lint/suspicious/noExplicitAny: global chrome mock requires any
(globalThis as any).chrome = chromeMock;

beforeEach(() => {
  local.store = {};
  local.get.mockClear();
  local.set.mockClear();
  chromeMock.runtime.getURL.mockClear();
  chromeMock.runtime.getManifest.mockClear();
  chromeMock.runtime.getManifest.mockImplementation(() => ({ version: '0.2.4' }));
  chromeMock.runtime.onMessage.addListener.mockClear();
  chromeMock.runtime.sendMessage.mockClear();
  chromeMock.runtime.sendMessage.mockImplementation(async (_msg: unknown) => undefined);
  chromeMock.runtime.lastError = undefined;
  chromeMock.runtime.connect.mockClear();
  chromeMock.runtime.connect.mockImplementation(
    (opts: { name: string }) => new FakePort(opts.name),
  );
  chromeMock.commands.onCommand.addListener.mockClear();
  chromeMock.tabs.query.mockClear();
  chromeMock.tabs.sendMessage.mockClear();
  chromeMock.offscreen.createDocument.mockClear();
  chromeMock.offscreen.createDocument.mockImplementation(async (_opts: unknown) => undefined);
  chromeMock.offscreen.closeDocument.mockClear();
  chromeMock.offscreen.closeDocument.mockImplementation(async () => undefined);
  chromeMock.offscreen.hasDocument.mockClear();
  chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
  // Default tabs.query implementation — overridable per-test.
  chromeMock.tabs.query.mockImplementation(
    (_q: unknown, cb: (tabs: Array<{ id?: number }>) => void) => cb([{ id: 1 }]),
  );
});

export { chromeMock };
