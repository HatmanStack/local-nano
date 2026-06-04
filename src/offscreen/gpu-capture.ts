/**
 * Transparent `navigator.gpu` capture seam (Layer A, ADR-0).
 *
 * The vendored polyfill drives `LanguageModel.create()`, which lets ORT build a
 * WebGPU `GPUDevice` via `navigator.gpu.requestAdapter()` then
 * `adapter.requestDevice()`. We never patch the polyfill (constraint 3), so the
 * only seam to observe the live `GPUDevice` is to wrap those two
 * `navigator.gpu` methods at the offscreen-document level. The wrap is
 * TRANSPARENT: it stores the original method, calls through, and returns the
 * original result unchanged, so the existing `collectGpuInfo` path keeps working
 * (ADR-0 defensibility check). On the resolved device it attaches a
 * `device.lost.then(...)` handler that fires a caller-supplied callback.
 *
 * The module is pure: no Chrome API calls. `offscreen.ts` injects the callbacks
 * so the wiring (flip `sessionPoisoned`, push `SESSION_POISONED`) lives in the
 * entry file and this seam stays unit-testable with a programmable
 * `navigator.gpu` mock.
 */

/** A captured GPUDevice handle and the ISO timestamp it was observed at. */
export interface CapturedDevice {
  device: unknown;
  capturedAt: string;
}

/** Payload passed to `onDeviceLost` when a captured device's `lost` resolves. */
export interface DeviceLostInfo {
  reason: string;
  message: string;
  at: string;
}

export interface InstallGpuCaptureOptions {
  onDeviceLost: (info: DeviceLostInfo) => void;
  onDeviceCaptured?: (captured: CapturedDevice) => void;
}

// Minimal structural views of the WebGPU surface we touch. Shaped through
// `unknown` casts (the codebase convention) rather than relying on lib.dom's
// GPU types, which jsdom does not provide.
interface GpuDeviceLike {
  lost?: Promise<{ reason?: unknown; message?: unknown }>;
}
interface GpuAdapterLike {
  requestDevice: (...args: unknown[]) => Promise<GpuDeviceLike>;
}
interface GpuLike {
  requestAdapter: (...args: unknown[]) => Promise<GpuAdapterLike | null>;
}

/** Marker so a re-import or a second install never double-wraps the surface. */
const INSTALLED_SYMBOL = Symbol.for('local-nano/gpu-capture-installed');

// Devices we have already attached a `.lost` listener to. A WeakSet so a
// device handle is decorated at most once even across multiple requestDevice
// calls, and so a dropped handle does not leak.
let capturedDevices = new WeakSet<object>();

// The original requestAdapter, kept so `_resetForTests` can restore it.
let originalRequestAdapter: GpuLike['requestAdapter'] | null = null;

function readGpu(): (GpuLike & Record<symbol, unknown>) | undefined {
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  const gpu = nav?.gpu;
  if (!gpu || typeof gpu !== 'object') return undefined;
  if (typeof (gpu as GpuLike).requestAdapter !== 'function') return undefined;
  return gpu as GpuLike & Record<symbol, unknown>;
}

/**
 * Wrap a resolved adapter's `requestDevice` so each resolved device gets a
 * single `.lost` listener. Idempotent per adapter via the same marker symbol
 * the gpu surface uses, so re-wrapping an already-wrapped adapter is a no-op.
 */
function wrapAdapter(adapter: GpuAdapterLike, opts: InstallGpuCaptureOptions): void {
  const marked = adapter as GpuAdapterLike & Record<symbol, unknown>;
  if (marked[INSTALLED_SYMBOL] === true) return;
  if (typeof adapter.requestDevice !== 'function') return;
  marked[INSTALLED_SYMBOL] = true;
  const originalRequestDevice = adapter.requestDevice;
  adapter.requestDevice = async (...args: unknown[]) => {
    const device = await originalRequestDevice.call(adapter, ...args);
    attachDeviceLost(device, opts);
    return device;
  };
}

/**
 * Attach a single `.lost` listener to a freshly captured device. The WeakSet
 * guard means a device captured twice (e.g. the same handle returned by two
 * requestDevice calls) gets exactly one listener.
 */
function attachDeviceLost(device: GpuDeviceLike, opts: InstallGpuCaptureOptions): void {
  if (!device || typeof device !== 'object') return;
  if (capturedDevices.has(device)) return;
  capturedDevices.add(device);
  opts.onDeviceCaptured?.({ device, capturedAt: new Date().toISOString() });
  const lost = device.lost;
  if (!lost || typeof lost.then !== 'function') return;
  lost.then(
    (info) => {
      opts.onDeviceLost({
        reason: typeof info?.reason === 'string' ? info.reason : String(info?.reason ?? ''),
        message: typeof info?.message === 'string' ? info.message : String(info?.message ?? ''),
        at: new Date().toISOString(),
      });
    },
    () => {
      // The WebGPU spec says `GPUDevice.lost` resolves and never rejects, so
      // this arm should be unreachable. It exists only so a non-conforming
      // engine or a test double that rejects the promise cannot surface as an
      // unhandled rejection. Nothing to recover here: a rejected `lost` tells
      // us nothing actionable about the device, so we drop it silently.
    },
  );
}

/**
 * Install the transparent `navigator.gpu` capture. No-op when WebGPU is absent
 * (jsdom, a wasm build) or when already installed (idempotent).
 */
export function installGpuCapture(opts: InstallGpuCaptureOptions): void {
  const gpu = readGpu();
  if (!gpu) return;
  if (gpu[INSTALLED_SYMBOL] === true) return;
  gpu[INSTALLED_SYMBOL] = true;
  // Keep the original reference UNBOUND so `_resetForTests` can restore the
  // exact same function (a bound copy would lose a test mock's `.mockClear`).
  // Preserve `this` at call time via `.call(gpu, ...)` for a real
  // navigator.gpu whose requestAdapter may depend on its receiver.
  const original = gpu.requestAdapter;
  originalRequestAdapter = original;
  gpu.requestAdapter = async (...args: unknown[]) => {
    const adapter = await original.call(gpu, ...args);
    if (adapter) wrapAdapter(adapter, opts);
    return adapter;
  };
}

/**
 * Reset module state for tests: clears the device-dedup WeakSet, restores the
 * original `requestAdapter`, and removes the install marker so the next
 * `installGpuCapture` re-wraps a fresh surface.
 *
 * Scope limitation: this restores ONLY `navigator.gpu.requestAdapter`. It
 * cannot un-wrap any adapter's `requestDevice`, because adapters are transient
 * objects this module never retains (it marks them in place and lets them be
 * GC'd, matching real WebGPU where adapters are short-lived). A test that
 * REUSES the same fake adapter across a reset boundary would still see the
 * wrapped `requestDevice`; the test harness avoids this by minting a fresh
 * adapter per reset (see `gpuMock._resetCaptures` in `tests/setup.ts`).
 */
export function _resetForTests(): void {
  capturedDevices = new WeakSet<object>();
  const gpu = readGpu();
  // Restore only when this surface still carries an active install marker. A
  // test harness that already replaced navigator.gpu.requestAdapter (clearing
  // the marker) owns the surface, so restoring a stale reference would clobber
  // its fresh spy.
  if (gpu && gpu[INSTALLED_SYMBOL] === true) {
    if (originalRequestAdapter) {
      (gpu as GpuLike).requestAdapter = originalRequestAdapter;
    }
    delete gpu[INSTALLED_SYMBOL];
  }
  originalRequestAdapter = null;
}
