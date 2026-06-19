---
plan: 2026-06-17-small-model-default
status: proposed
base: 0.4.6 (commit d600414)
target_release: 0.4.7
supersedes_idea: the "GPU-load timeout + fallback" direction from the 0.4.6 follow-up
---

# Small model by default, gemma opt-in (+ Stop / un-deadlock safety net)

## 1. Problem (what 0.4.6 could not fix)

The reported device: ChromeOS, **16 GB system RAM**, hardware WebGPU, `maxBufferSize: 4096 MiB`, `isFallback: false`. By every signal it is "capable," yet `gemma-4-E2B` dies with `VK_ERROR_OUT_OF_DEVICE_MEMORY` allocating a ~1.17 GB GPU buffer. `Qwen3-0.6B` at `webgpu/q4f16` loads and answers fine on the same GPU.

Two facts make this unfixable by pre-load detection:

1. **No WebGPU adapter limit predicts the OOM.** `maxBufferSize` is a *per-buffer* ceiling, not usable VRAM, and Chrome advertises a uniform ~2–4 GiB even on modest integrated GPUs. `deviceMemory` is system RAM (16 GB here), not GPU budget. So the 0.4.6 RAM-based classifier correctly says "capable" and still loads a model that can't fit.
2. **The CPU/WASM fallback is a hard ~4 GiB context on every machine** (wasm32 address space; see `docs/models.md`). A ~2B model cannot run there regardless of RAM.

So the broad Chrome-extension audience — mostly integrated GPUs, plus the universal WASM 4 GiB floor — is effectively a *memory-constrained* context, and we cannot tell a constrained device from a roomy one before loading. Worse, the gemma GPU-OOM surfaces as an **uncaptured device error**, so `LanguageModel.create()` HANGS instead of rejecting; that hang then **deadlocks a model switch** (`reloadModel` awaits the in-flight warm), which is why the user's in-app "Load Qwen3" did nothing.

## 2. Decision

Stop speculatively loading the 2B model. **Default to a small model that fits the common case; make gemma-2B an explicit opt-in.** This deletes the "can we predict the OOM?" problem entirely. Keep a lightweight **Stop / un-deadlock** so an opt-in gemma load that hangs is still recoverable.

**Trade-off (accepted):** a user with a strong/discrete GPU gets the ~0.6B model by default until they pick gemma in settings (one click). We cannot reliably detect a strong GPU pre-load, so this is the honest default. gemma remains fully available and one selection away.

## 3. Goals / non-goals

**Goals**
- A fresh install with no preference **auto-loads a model that fits** on the common (integrated-GPU / WASM) case — `Qwen3-0.6B` on WebGPU, `Qwen2.5-0.5B` on WASM/fallback — never gemma.
- gemma-2B is selectable in the picker, clearly labeled as the larger/strong-GPU option.
- A hung load (e.g. someone opts into gemma on a weak GPU) is interruptible and never locks the picker.

**Non-goals**
- No attempt to detect GPU VRAM budget (it is not exposed).
- No reintroduction of the 0.4.2/0.4.3 device-loss recreate machinery.
- Not changing the WASM small model or its tiers.

## 4. Design

### Part A — flip the auto-default (the core change)

Replace 0.4.6's `defaultModelForCapability(capability, info)` (which returns `null` → gemma for "capable") with a device-path default that **always returns a small model**:

```ts
// catalog.ts — auto-default when the user has set NO preference.
export function defaultModelForDevice(info: { device: 'webgpu' | 'wasm'; isFallback: boolean }): string {
  if (info.device === 'webgpu' && !info.isFallback) return QWEN3_06B_ENTRY.id; // ~0.5 GB, WebGPU
  return SMALLER_ENTRY.id;                                                     // Qwen2.5-0.5B, WASM/CPU
}
```

In `runWarm` (`session.ts`), the no-preference branch resolves this id (never gemma). An explicit stored preference is still honored unchanged, so gemma loads only when the user picked it. The 0.4.6 "memory-constrained" auto-downsize note is replaced by a neutral one-liner only when useful (e.g. "Using Qwen3-0.6B — pick a larger model in settings"), or dropped; TBD in review.

`classifyCapability`/`deviceMemory` stay (they still feed `deriveHistoryThreshold` and the diagnostic), but **model choice no longer depends on capability** — only on the execution path. Simpler and prediction-free.

### Part B — picker labeling

- Mark **Qwen3-0.6B** as the default in the picker (it is now the no-preference pick).
- Update gemma's catalog `note` to flag it as the larger option, e.g. "largest; needs a strong/discrete GPU — may fail to load on integrated GPUs."
- `DEFAULT_MODEL_ID` usage: audit where it marks "the default" in the UI and point the marker at the new auto-default path (the catalog already lists all three; this is a display detail).

### Part C — Stop / un-deadlock safety net (port + adapt from the stashed 0.4.4 work)

A model LOAD must be interruptible so an opt-in gemma hang never bricks the panel:

- A **Stop button** in the "Loading model… Ns" bubble: sets a `warmAborted` flag and force-recreates the offscreen document (kills the in-flight `create()`), so the pending warmup rejects and `runWarm` ends the walk as a clean cancel (no known-bad, no advance) — returning the panel to idle and unlocking the picker.
- `reloadModel` (model switch) must **not deadlock behind a hung warm**: instead of `await warmInFlight`, cancel it (abort + recreate) then proceed. This is what makes "switch to Qwen3" work even while gemma is hung.

(The stash `wip-0.4.4` holds a working version of this against the 0.4.3 base; it must be **re-applied by hand** to the 0.4.6 `runWarm`, not `stash pop`'d, since the base differs.)

### Part D — also drop the doomed `webgpu/fp16` gemma rung (from the same stash)

If the user opts into gemma and `q4f16`/`q8` fail, the ladder currently climbs to `webgpu/fp16` (~6 GB) which can only churn. Remove it (ladder becomes `q4f16 → q8 → wasm/q8`) so an opt-in gemma that can't fit fails fast instead of hanging. Small, data-only.

## 5. Files touched

| File | Change |
| --- | --- |
| `src/offscreen/catalog.ts` | `defaultModelForDevice` (replaces `defaultModelForCapability`); gemma `note` relabel |
| `src/offscreen/ladder.ts` | drop `webgpu/fp16` from `PRIMARY_LADDER` (Part D) |
| `src/session.ts` | no-preference resolution → `defaultModelForDevice`; Stop button + `warmAborted` cancel; `reloadModel` cancels in-flight warm; default-note copy; picker "default" marker |
| `manifest.json` / `package.json` | bump to 0.4.7 |
| `CHANGELOG.md` | 0.4.7 entry |
| `tests/*` | see §6 |

## 6. Testing

- `defaultModelForDevice` unit tests: webgpu/!fallback → Qwen3-0.6B; webgpu/fallback → Qwen2.5-0.5B; wasm → Qwen2.5-0.5B. (Never gemma.)
- `session.ts`: no preference + webgpu → first warmup tier is Qwen3-0.6B (the reported "capable" 16 GB snapshot now also yields Qwen3); explicit gemma pick → gemma honored; no preference + wasm → Qwen2.5-0.5B.
- Stop: loading bubble has a Stop button; clicking it cancels cleanly (no known-bad, no advance, idle, picker unlocked); after Stop a fresh load runs.
- `reloadModel` cancels a hung warm instead of deadlocking (model switch proceeds).
- `PRIMARY_LADDER` is the 3-tier list; update the affected ladder/session count assertions (same edits as the stash).
- Full gate: `typecheck && lint:ci && vitest && build && package` (run directly).

## 7. Rollout

1. Implement Part A + B + D, validate, **manual smoke**: fresh install (cleared storage) auto-loads Qwen3-0.6B on the dev CrOS device and answers; picking gemma shows the strong-GPU note and (on this device) fails fast / is Stoppable.
2. Implement Part C (Stop / un-deadlock), validate, smoke the hung-gemma → Stop → switch-to-Qwen3 path.
3. Ship **0.4.7** (> published 0.4.3). Pushed/uploaded by the user.

## 8. Open questions

- Keep a one-line "using the lightweight model, pick a larger one in settings" note on the auto-default, or stay silent? Proposed: a single subtle line, dismissible by picking a model. Confirm.
- Should gemma stay in the catalog as-is, or be gated behind a "show advanced/large models" toggle? Proposed: keep it listed (one click), just relabeled. Confirm.
- 0.4.6's `deviceMemory` classifier: keep (feeds threshold/diagnostic) — yes. Confirm we are not removing it.
