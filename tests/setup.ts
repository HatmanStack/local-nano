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

  remove = vi.fn(async (key: string | string[]) => {
    const keys = typeof key === 'string' ? [key] : key;
    for (const k of keys) delete this.store[k];
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

/**
 * Programmable `navigator.gpu` mock (Phase 2 of the device-loss resilience
 * plan). The offscreen-side `collectGpuInfo` and the new `gpu-capture` monkey-
 * patch both read `navigator.gpu.requestAdapter`; this stand-in lets a test
 * drive the adapter/device capture path and fire a synthetic `device.lost`
 * event without a real WebGPU stack (CI has none).
 *
 * The CLIENT-boundary `getGpuInfoMock` in `tests/session.test.ts` mocks
 * `getGpuInfo` from `src/offscreen/client.ts`, not this surface, so it stays
 * independent of this mock.
 */
export interface FakeGpuDevice {
  lost: Promise<{ reason: string; message: string }>;
  /** Test helper: resolve the `lost` Promise to drive the device.lost listener. */
  _fireLost(reason: string, message: string): void;
}

export interface FakeGpuAdapter {
  isFallbackAdapter: boolean;
  limits: { maxBufferSize: number | null };
  requestDevice(): Promise<FakeGpuDevice>;
}

export interface FakeGpu {
  requestAdapter(): Promise<FakeGpuAdapter | null>;
  /** Test helper: set the adapter the next requestAdapter resolves to (null = no adapter). */
  _setAdapter(adapter: FakeGpuAdapter | null): void;
  /** Test helper: reset the captured adapter/device records to defaults. */
  _resetCaptures(): void;
  /** Test helper: the adapter most recently returned by requestAdapter. */
  _lastAdapter(): FakeGpuAdapter | null;
  /** Test helper: the device most recently returned by requestDevice. */
  _lastDevice(): FakeGpuDevice | null;
}

/** Construct a fresh fake device with a settable `lost` Promise. */
export function makeFakeDevice(): FakeGpuDevice {
  let fire!: (payload: { reason: string; message: string }) => void;
  const lost = new Promise<{ reason: string; message: string }>((resolve) => {
    fire = resolve;
  });
  return {
    lost,
    _fireLost(reason: string, message: string) {
      fire({ reason, message });
    },
  };
}

/** Construct a fresh fake adapter that yields a fresh device per requestDevice. */
export function makeFakeAdapter(
  overrides: Partial<Pick<FakeGpuAdapter, 'isFallbackAdapter' | 'limits'>> = {},
): FakeGpuAdapter {
  return {
    isFallbackAdapter: overrides.isFallbackAdapter ?? false,
    limits: overrides.limits ?? { maxBufferSize: 268435456 },
    requestDevice: vi.fn(async () => {
      const device = makeFakeDevice();
      gpuState.lastDevice = device;
      return device;
    }),
  };
}

interface GpuState {
  adapter: FakeGpuAdapter | null;
  lastAdapter: FakeGpuAdapter | null;
  lastDevice: FakeGpuDevice | null;
}

const gpuState: GpuState = {
  adapter: null,
  lastAdapter: null,
  lastDevice: null,
};

const gpuMock: FakeGpu = {
  requestAdapter: vi.fn(async () => {
    gpuState.lastAdapter = gpuState.adapter;
    return gpuState.adapter;
  }),
  _setAdapter(adapter: FakeGpuAdapter | null) {
    gpuState.adapter = adapter;
  },
  _resetCaptures() {
    gpuState.adapter = makeFakeAdapter();
    gpuState.lastAdapter = null;
    gpuState.lastDevice = null;
  },
  _lastAdapter() {
    return gpuState.lastAdapter;
  },
  _lastDevice() {
    return gpuState.lastDevice;
  },
};

// jsdom provides `navigator`, but its properties are read-only by default, so
// install the mock through defineProperty (same pattern session.test.ts uses
// for navigator.clipboard). `configurable: true` lets a test redefine it.
Object.defineProperty(navigator, 'gpu', {
  configurable: true,
  writable: true,
  value: gpuMock,
});

const local = new FakeStorageArea();

/**
 * Minimal `chrome.alarms` stand-in for tests (Task 4.1). The SW registers one
 * `onAlarm` listener; `_fireAlarm(name)` invokes the captured listener with a
 * named-alarm payload so a test can drive the idle-release path without a real
 * Chrome alarm. `create` and `clear` are spies the scheduler tests assert.
 */
const alarmListeners: Array<(alarm: { name: string }) => void> = [];

const alarms = {
  create: vi.fn((_name: string, _info: unknown) => undefined),
  clear: vi.fn(async (_name?: string) => true),
  onAlarm: {
    addListener: vi.fn((l: (alarm: { name: string }) => void) => {
      alarmListeners.push(l);
    }),
  },
  /** Test helper: fire every registered onAlarm listener with a named alarm. */
  _fireAlarm(name: string) {
    for (const l of alarmListeners) l({ name });
  },
};

const chromeMock = {
  storage: { local },
  alarms,
  runtime: {
    id: 'test-ext',
    getURL: vi.fn((p: string) => `chrome-extension://test/${p}`),
    getManifest: vi.fn(() => ({ version: '0.2.4' })),
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(async (_msg: unknown) => undefined as unknown),
    lastError: undefined as { message?: string } | undefined,
    connect: vi.fn((opts: { name: string }) => new FakePort(opts.name)),
  },
  commands: {
    onCommand: { addListener: vi.fn() },
    getAll: vi.fn(async () => [] as Array<{ name?: string; shortcut?: string }>),
  },
  action: {
    onClicked: { addListener: vi.fn() },
    setTitle: vi.fn(async (_opts: { title: string }) => undefined),
  },
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
  local.remove.mockClear();
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
  chromeMock.commands.getAll.mockClear();
  chromeMock.commands.getAll.mockImplementation(async () => []);
  chromeMock.action.onClicked.addListener.mockClear();
  chromeMock.action.setTitle.mockClear();
  chromeMock.action.setTitle.mockImplementation(async (_opts: { title: string }) => undefined);
  chromeMock.tabs.query.mockClear();
  chromeMock.tabs.sendMessage.mockClear();
  chromeMock.offscreen.createDocument.mockClear();
  chromeMock.offscreen.createDocument.mockImplementation(async (_opts: unknown) => undefined);
  chromeMock.offscreen.closeDocument.mockClear();
  chromeMock.offscreen.closeDocument.mockImplementation(async () => undefined);
  chromeMock.offscreen.hasDocument.mockClear();
  chromeMock.offscreen.hasDocument.mockImplementation(async () => false);
  chromeMock.alarms.create.mockClear();
  chromeMock.alarms.clear.mockClear();
  chromeMock.alarms.clear.mockImplementation(async (_name?: string) => true);
  chromeMock.alarms.onAlarm.addListener.mockClear();
  alarmListeners.length = 0;
  // Reset the navigator.gpu mock to a fresh default adapter between tests.
  (gpuMock.requestAdapter as ReturnType<typeof vi.fn>).mockClear();
  gpuMock._resetCaptures();
  // Default tabs.query implementation — overridable per-test.
  chromeMock.tabs.query.mockImplementation(
    (_q: unknown, cb: (tabs: Array<{ id?: number }>) => void) => cb([{ id: 1 }]),
  );
});

export { chromeMock, gpuMock };
