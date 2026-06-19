---
plan: 2026-06-16-memory-aware-model-selection
status: proposed
base: 0.4.5 (commit c3457e9, = the reverted 0.4.1 load path)
target_release: 0.4.6
---

# Memory-aware model selection + honest load-failure surfacing

## 1. Problem

On a memory-constrained ChromeOS device (4 GiB RAM, Chrome 148, hardware
WebGPU), `onnx-community/gemma-4-E2B-it-ONNX` (~2B params, ~1.5 GB q4f16
weights) fails to load. The user sees:

- `RangeError: Array buffer allocation failed` (the weights ArrayBuffer cannot
  be allocated), and/or
- `Offscreen document closed before fully loading` (Chrome kills the offscreen
  renderer process to reclaim memory mid-load),

and the in-panel diagnostic shows `errorClass: none / errorMessage: none` with
`extensionVersion: unknown` (the content-script context is severed when the
process is reclaimed). A **full system restart** (freeing RAM) made the same
build load gemma successfully — proving the cause is **system memory pressure**,
not extension code. Both error strings are two faces of the same OOM event.

This was reproduced on **0.4.5 (the reverted 0.4.1 load path)**, so it predates
and is independent of the 0.4.2/0.4.3 device-loss machinery we removed.

## 2. Root cause

Two compounding facts:

1. **We classify device capability from the wrong number.**
   `classifyCapability` (`src/offscreen/capability.ts`) decides `weak` vs
   `capable` from the WebGPU **`maxBufferSize`** (and the fallback flag). The
   user's diagnostic showed `maxBufferSize: 4096 MiB` — a *large GPU buffer
   limit* — so we classified the device `capable` and loaded the 2B model. But
   the actual constraint is **system RAM**, which `maxBufferSize` does not
   reflect. A low-RAM box can still report a big GPU buffer limit.

2. **The auto-default is always the 2B model.** Even when capability is `weak`,
   the no-preference path in `runWarm` (`src/session.ts`) resolves to the
   primary gemma ladder, and the smaller-model rung is gated off
   (`SMALLER_MODEL_ENABLED = false`). So nothing ever downsizes the default.

### External validation

The HuggingFace reference extension `nico-martin/gemma4-browser-extension` runs
the **identical** stack (`@huggingface/transformers@^4.2.0`, same gemma-4-E2B
ONNX, `dtype: q4f16`, `device: webgpu`). It has **no** OOM- or device-loss
handling — confirming there is no missing API. Its only relevant difference is
that it ships **smaller models as first-class options** (Granite-4.0 350M/1B,
then the 2B/4B as the *large* picks). The lesson: do not force a 2B model on
every device; pick by capability. We already have the smaller catalog entries
(`Qwen3-0.6B-ONNX`, `Qwen2.5-0.5B-Instruct`) — we just never auto-select them.

## 3. Goals / non-goals

**Goals**

- A memory-constrained device **auto-selects a model that fits** instead of
  OOMing on gemma-2B. (Highest impact; fixes the reported device.)
- When a load fails for memory, the user sees a **clear, actionable message**,
  and the diagnostic carries the **real** error (never `errorMessage: none`).
- A way to recover from a **corrupt/partial model cache** that survives reinstall.

**Non-goals**

- **No** migration to a service-worker-hosted model + side panel (the blog's
  headline). It is a large rewrite, does not fix OOM, and the SW can be killed
  mid-inference — the offscreen document is the *more* persistent host. Rejected.
- **No** reintroduction of the 0.4.2/0.4.3 device-loss machinery.
- Not trying to make a 2B model fit on a 4 GiB device, or to speed up WASM.

## 4. Design

Three phases, independently shippable. Phase 1 alone fixes the reported device.

### Phase 1 — RAM-aware capability + small-model auto-default (headline)

**1a. Add `deviceMemory` to the GPU snapshot.**
`navigator.deviceMemory` (approximate GB: 0.25/0.5/1/2/4/8, capped at 8; `null`
if unsupported) is available in the offscreen document. Read it in
`collectGpuInfo` (`offscreen.ts`) alongside `maxBufferSize`, so the whole
snapshot comes from one place and is persisted + diagnosed together.

- `src/offscreen/protocol.ts`: add `deviceMemory: number | null` to
  `GpuInfoSnapshot` + its `isGpuInfoResponse` guard.
- `offscreen.ts collectGpuInfo`: populate `deviceMemory` from
  `navigator.deviceMemory ?? null` (both webgpu and wasm branches).
- `src/offscreen/client.ts getGpuInfo`: pass it through; conservative default
  `null` (older offscreen builds omit it → treated as unknown).
- `src/offscreen/diagnostic.ts`: add a `deviceMemory: N GB | n/a` line.
- `src/offscreen/capability-store.ts`: include it in the persisted snapshot +
  validator.

**1b. Factor system RAM into the capability verdict.**
Extend `classifyCapability` (pure):

```ts
export const LOW_MEMORY_GB = 4; // a 2B q4f16 model peaks ~2–3 GB; ≤4 GB is the constraint
// ...existing wasm / isFallback / maxBufferSize checks, plus:
if (info.deviceMemory !== null && info.deviceMemory <= LOW_MEMORY_GB) return 'weak';
```

`deviceMemory` is coarse and only ever **downgrades** — it never blocks a load
and the user can always override in the picker, so a false "weak" is harmless.

**1c. Auto-select a small model on weak devices (no user preference).**
New pure helper (in `catalog.ts`):

```ts
// Returns the model id to default to when the user has set NO preference.
// null => keep today's default (gemma). A weak device gets a model that fits.
export function defaultModelForCapability(
  capability: DeviceCapability,
  info: { device: 'webgpu' | 'wasm'; isFallback: boolean },
): string | null {
  if (capability === 'capable') return null;            // gemma, unchanged
  if (info.device === 'webgpu' && !info.isFallback)
    return 'onnx-community/Qwen3-0.6B-ONNX';             // ~0.5 GB, webgpu/q4f16,
                                                        // vetted on the 4 GiB CrOS GPU (docs/models.md)
  return 'onnx-community/Qwen2.5-0.5B-Instruct';        // ~0.5 GB, wasm/q8 (no/SW WebGPU)
}
```

Wire into `runWarm` (`src/session.ts`, the `entry === null` branch): when there
is no stored preference, resolve `defaultModelForCapability(...)`; if non-null,
`findCatalogEntry(id)` and feed it to the existing
`assembleLadderForModel({ entry, capability })` exactly like a user pick. An
explicit user preference is honored unchanged (capability never overrides a
deliberate choice).

**1d. Tell the user when an auto-downsize happened.** One-line system bubble on
a successful weak-device auto-pick: *"This device looks memory-constrained, so a
smaller model (Qwen3 0.6B) was loaded. You can choose a larger one in
settings."* Suppressed when the user picked the model themselves.

### Phase 2 — honest preflight + error translation

**2a. Never-blank diagnostic.** Capture the error object on **every** tier
failure (not only terminal), so `errorClass`/`errorMessage` always reflect the
last real failure. (Today they read `none` when the copy happens before the
terminal bubble.)

**2b. Translate the failure.** Pure `explainLoadFailure(error, info)`:

| signal in message | headline / action |
| --- | --- |
| `allocation failed`, `out of memory`, `RangeError` | "Low on memory. Restart Chrome or your device, or pick a smaller model in settings." |
| `document closed`, `message channel closed`, `port disconnected` | "The model loader was interrupted (often low memory). Try again, or pick a smaller model." |
| network signals (existing list) | existing connection message |

Show the friendly line in the terminal bubble; keep the raw diagnostic behind
the existing Copy affordance.

**2c. Upfront advisory.** If the user explicitly selected a large model on a
`weak` device, warn before the heavy load begins (reuses `deviceMemory` +
`preflightWarning`).

### Phase 3 — clear model cache

transformers.js caches weights in the **Cache API** under the extension origin.
A load killed mid-download can leave a **partial/corrupt entry that survives a
reinstall** (same extension id) and re-fails identically — consistent with the
"cache feels weird / reinstall doesn't help" reports.

- New protocol message `CLEAR_MODEL_CACHE` → offscreen handler that calls
  `caches.delete(<transformers cache name>)` then nulls the session so the next
  load re-downloads clean.
- **Verify the cache name** the installed `@huggingface/transformers@4.2.0`
  uses (default `transformers-cache` via `env.useBrowserCache`; confirm before
  hardcoding — enumerate `caches.keys()` if unsure).
- A "Clear model cache & reload" button in the gear popover, routed through the
  serialized re-warm primitive (never overlaps a load / live stream).

## 5. Files touched

| File | Change |
| --- | --- |
| `src/offscreen/protocol.ts` | `deviceMemory` on `GpuInfoSnapshot` + guard; `CLEAR_MODEL_CACHE` msg (P3) |
| `offscreen.ts` | `collectGpuInfo` reads `navigator.deviceMemory`; clear-cache handler (P3) |
| `src/offscreen/client.ts` | thread `deviceMemory`; `clearModelCache()` (P3) |
| `src/offscreen/capability.ts` | `LOW_MEMORY_GB`, RAM check in `classifyCapability` |
| `src/offscreen/capability-store.ts` | persist/validate `deviceMemory` |
| `src/offscreen/catalog.ts` | `defaultModelForCapability()` |
| `src/offscreen/diagnostic.ts` | `deviceMemory` line; ensure error fields populated |
| `src/session.ts` | weak-device auto-default in `runWarm`; downsize note; `explainLoadFailure` wiring; clear-cache button (P3) |
| `manifest.json` / `package.json` | bump to 0.4.6 |
| `CHANGELOG.md` | 0.4.6 entry |
| `tests/*` | see §6 |

## 6. Testing

- `tests/capability.test.ts`: `deviceMemory ≤ 4` → `weak` even with a large
  `maxBufferSize`; `deviceMemory: null` → today's behavior; `≥ 8` → `capable`.
- New `defaultModelForCapability` unit tests (capable→null; weak+webgpu→Qwen3;
  weak+wasm/fallback→Qwen2.5).
- `tests/session.test.ts`: weak device + no preference → first warmup tier is
  Qwen3-0.6B (assert `warmupSession` modelName); explicit gemma pick on a weak
  device → still gemma; capable device → gemma (unchanged); downsize note shown
  only on auto-pick.
- `explainLoadFailure` unit tests for each signal class.
- P3: offscreen clear-cache handler test (mock `caches.delete`).
- Full gate: `npm run typecheck && npm run lint:ci && npx vitest run && npm run build && npm run package` (run directly, not piped).

## 7. Risks

- **`deviceMemory` is coarse / capped at 8 / spoofable.** Used only as a
  downsize hint, never to block; the picker overrides. Worst case: a roomy
  device gets a smaller default it can change. Acceptable.
- **Behavior change for existing weak-device users with no preference** — they
  now get a small model that loads instead of a failing 2B. That is the intent.
  Capable devices are unchanged.
- **Qwen3-0.6B is a reasoning model** (`<think>` blocks) — already stripped by
  `src/think-strip.ts` (present in 0.4.5). Confirm in manual smoke.
- **Cache name drift** (P3) — verify against the installed package; enumerate
  `caches.keys()` rather than hardcode if unconfirmed.

## 8. Rollout

1. Implement Phase 1, validate (full gate), **manual smoke on the 4 GiB CrOS
   device**: confirm it auto-selects and loads Qwen3-0.6B, answers a prompt.
2. Phase 2, then Phase 3 — each its own validate + smoke.
3. Ship as **0.4.6** (> published 0.4.3). Keep the device-loss rework separate.

## 9. Open questions

- `LOW_MEMORY_GB` threshold: proposed `≤ 4`. (8 GiB devices keep gemma; the 2B
  model peaks ~2–3 GB, marginal at 4 GiB.) Confirm.
- Weak-device default: Qwen3-0.6B (webgpu, faster, vetted on the target GPU) vs
  Qwen2.5-0.5B (wasm, slowest but immune to WebGPU device-loss). Proposed:
  branch on `device`/`isFallback` as in 1c. Confirm.
- Phase scope for 0.4.6: Phase 1 only, or 1+2, or all three? Proposed: **1+2**
  together (selection + visibility are complementary), Phase 3 as a fast-follow.
