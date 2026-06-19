/**
 * Curated model catalog (ADR-P1, P2, P12).
 *
 * The picker offers a curated list of supported models, not arbitrary Hugging
 * Face ids. Each entry carries display metadata plus the ordered `Tier[]` ladder
 * for that model, reusing the existing `Tier` type and the primary ladder data
 * from `ladder.ts`. This module is a DATA extension of `ladder.ts`, not a new
 * state machine: the `nextAction`/`firstTierIndex` reducer is model-agnostic and
 * walks whatever `Tier[]` it is handed (ADR-P1).
 *
 * Non-gated (always listed, live) entries, each with a tier confirmed working by
 * manual smoke testing:
 *
 * - `onnx-community/gemma-4-E2B-it-ONNX` (the default) at `webgpu/q4f16`.
 * - `onnx-community/Qwen2.5-0.5B-Instruct` at `wasm/q8` (WASM-only — WebGPU
 *   parrots for this model; see `docs/models.md`).
 * - `onnx-community/Qwen3-0.6B-ONNX` at `webgpu/q4f16` (the small WebGPU option;
 *   loads and answers on the dev integrated GPU, WASM fallback behind it).
 *
 * Other candidates sit behind off-by-default build-time gates, read through a
 * function seam mirroring `isSmallerModelEnabled()` in `ladder.ts`, so the picker
 * can be exercised with gated entries on and off in tests via `vi.spyOn` without
 * flipping a production constant. (Smoke-rejected candidates — the Qwen3.5 VL
 * model, the unsupported `qwen3_5_text` arch, and Qwen3-1.7B on integrated GPUs —
 * are recorded in `docs/models.md`.)
 *
 * No Chrome, polyfill, or timer dependency: this is pure data plus pure
 * accessors.
 */

import * as self from './catalog.js';
import { PRIMARY_LADDER, PRIMARY_MODEL, type Tier } from './ladder.js';

/**
 * A curated model with the display metadata the popover renders (ADR-P12) plus
 * its ordered dtype/device ladder. `id` is the canonical model name, identical
 * to the string used in `Tier.modelName`. `gated` is true when the entry
 * requires an off-by-default gate flag; gated entries are never live while their
 * gate is off.
 */
export interface CatalogEntry {
  id: string;
  displayName: string;
  /** Descriptive approximate download size, e.g. '~1.5 GB'. Not asserted-exact. */
  downloadSize: string;
  /** One-line note sourced from docs/models.md. Descriptive text, not a benchmark. */
  note: string;
  tiers: Tier[];
  gated: boolean;
}

/** Resolved gate states passed to each entry's visibility predicate. */
interface GateState {
  largerEnabled: boolean;
}

/**
 * Internal catalog entry: the public `CatalogEntry` plus a per-entry visibility
 * predicate. A non-gated entry is always visible; each gated entry reads its own
 * gate from the resolved state. Keeping the predicate per-entry means adding a
 * future gated entry needs no change to `isVisible`.
 */
interface InternalEntry extends CatalogEntry {
  isVisible: (gates: GateState) => boolean;
}

/** The default model id, so the picker can mark the default. */
export const DEFAULT_MODEL_ID = PRIMARY_MODEL;

/**
 * Build-time gate for the larger-than-default smoke-vetting candidate. DEFAULT
 * OFF.
 *
 * The exact larger-model id is finalized at vetting time (open question 1); the
 * placeholder below is harmless while this gate is off. Flipping this flag is a
 * manual WebGPU-smoke follow-up (ROADMAP #6), not a CI change.
 */
export const LARGER_MODEL_ENABLED = false;

/**
 * Read the larger-model gate through a function seam, mirroring
 * `isSmallerModelEnabled()`. Production always returns `LARGER_MODEL_ENABLED`
 * (false).
 */
export function isLargerModelEnabled(): boolean {
  return LARGER_MODEL_ENABLED;
}

/**
 * The non-gated smaller entry: `onnx-community/Qwen2.5-0.5B-Instruct`, the only
 * smaller model `docs/models.md` confirms working, at the only cell it vets
 * (`wasm/q8`). WebGPU was smoke-tested 2026-05-26 and REJECTED for this model:
 * both `q4f16` and `fp16` PARROT the input on this GPU class. It is not a
 * precision problem — the more-quantized `wasm/q8` answers correctly while
 * full-precision `fp16` on WebGPU does not — but a WebGPU execution-provider
 * correctness issue for this model's ops (gemma is unaffected on WebGPU). A
 * WebGPU tier would be a landmine here: it LOADS, so the ladder cannot
 * auto-recover from the garbage. So this entry stays WASM-only.
 */
const SMALLER_ENTRY: InternalEntry = {
  id: 'onnx-community/Qwen2.5-0.5B-Instruct',
  displayName: 'Qwen2.5 0.5B Instruct',
  downloadSize: '~0.5 GB',
  note: 'smallest that answers; CPU/WASM only, ~1-3 tok/s',
  tiers: [{ modelName: 'onnx-community/Qwen2.5-0.5B-Instruct', device: 'wasm', dtype: 'q8' }],
  gated: false,
  isVisible: () => true,
};

/**
 * The non-gated small WebGPU entry: `onnx-community/Qwen3-0.6B-ONNX`. Verified
 * text-only (`Qwen3ForCausalLM`, `qwen3`, no `vision_config`), single-file ONNX.
 * Smoke-accepted 2026-05-26 as the small WebGPU option — it loads and answers on
 * the dev integrated GPU (it is a reasoning model; the `<think>` block is
 * stripped in `src/think-strip.ts`). Leads with `webgpu/q4f16`, then WASM
 * `q8` → `fp16`. Caveat: `q4f16` is vetted only on the dev's GPU; like any
 * small-model WebGPU tier it could parrot on other GPUs (as Qwen2.5 did) with no
 * auto-recovery, since parroting is not a load failure — accepted for release as
 * the lightweight Q&A option, with gemma-4-E2B remaining the capable default.
 */
const QWEN3_06B_ENTRY: InternalEntry = {
  id: 'onnx-community/Qwen3-0.6B-ONNX',
  displayName: 'Qwen3 0.6B',
  downloadSize: '~0.5 GB',
  note: 'small WebGPU model; prefers WebGPU (q4f16), WASM fallback',
  tiers: [
    { modelName: 'onnx-community/Qwen3-0.6B-ONNX', device: 'webgpu', dtype: 'q4f16' },
    { modelName: 'onnx-community/Qwen3-0.6B-ONNX', device: 'wasm', dtype: 'q8' },
    { modelName: 'onnx-community/Qwen3-0.6B-ONNX', device: 'wasm', dtype: 'fp16' },
  ],
  gated: false,
  isVisible: () => true,
};

/**
 * The default entry for the primary model (gemma-4-E2B). Its ladder is
 * `PRIMARY_LADDER` itself (referenced, not duplicated) so the default entry's
 * tiers are identical to today's primary ladder.
 */
const DEFAULT_ENTRY: InternalEntry = {
  id: PRIMARY_MODEL,
  displayName: 'Gemma 4 E2B Instruct',
  downloadSize: '~1.5 GB',
  note: 'largest; best answers but needs a strong/discrete GPU — may fail to load on integrated GPUs',
  tiers: PRIMARY_LADDER,
  gated: false,
  isVisible: () => true,
};

/**
 * The placeholder larger-than-default entry. The exact model id is an open
 * question finalized at vetting time; this constant is harmless while
 * `LARGER_MODEL_ENABLED` is off and exists only as the larger end of the
 * both-directions spectrum and the manual-vetting target (mirroring how
 * `SMALLER_MODEL_CANDIDATE` documents its unvetted WebGPU tier). Its tier is a
 * placeholder; the candidate and its vetted tier are confirmed at smoke time.
 */
const LARGER_ENTRY: InternalEntry = {
  id: 'onnx-community/LARGER-MODEL-PLACEHOLDER',
  displayName: 'Larger model (placeholder)',
  downloadSize: '~3 GB',
  note: 'placeholder; unvetted; finalized at manual WebGPU smoke time',
  tiers: [
    { modelName: 'onnx-community/LARGER-MODEL-PLACEHOLDER', device: 'webgpu', dtype: 'q4f16' },
  ],
  gated: true,
  isVisible: (gates) => gates.largerEnabled,
};

/** Options that override the gate states (default to the production seams). */
interface GateOpts {
  largerEnabled?: boolean;
}

/**
 * The full ordered catalog, smallest to largest with the default in its size
 * position. Gated entries are filtered by `listCatalog`/`findCatalogEntry` via
 * each entry's own `isVisible`.
 */
const ALL_ENTRIES: InternalEntry[] = [SMALLER_ENTRY, QWEN3_06B_ENTRY, DEFAULT_ENTRY, LARGER_ENTRY];

/**
 * The visible catalog. Returns the non-gated entries always (gemma default,
 * Qwen2.5-0.5B, Qwen3-0.6B), and includes a gated entry only when its gate is on.
 * Order is smallest to largest with the default in its size position.
 */
export function listCatalog(opts: GateOpts = {}): CatalogEntry[] {
  // Route the default through the module's own exports so tests can drive the
  // gate state with `vi.spyOn`, the same way `session.ts` spies
  // `isSmallerModelEnabled` (ESM intra-module calls bind locally; the self
  // import lets the spy intercept).
  const gates: GateState = {
    largerEnabled: opts.largerEnabled ?? self.isLargerModelEnabled(),
  };
  return ALL_ENTRIES.filter((e) => e.isVisible(gates));
}

/**
 * The entry with `id` from the visible catalog, or null for an
 * unknown/gated-while-disabled id (so a stale stored preference resolves to
 * null, which the caller treats as "no preference", ADR-P4).
 */
export function findCatalogEntry(id: string, opts: GateOpts = {}): CatalogEntry | null {
  return listCatalog(opts).find((e) => e.id === id) ?? null;
}

/**
 * The model id to auto-default to when the user has set NO preference (ADR-P4,
 * revised 0.4.7). ALWAYS a small model that fits the common case — never the
 * 2B gemma default. No WebGPU adapter limit reliably predicts whether gemma's
 * GPU allocations will fit (maxBufferSize is a per-buffer cap, not usable VRAM;
 * deviceMemory is system RAM), so rather than speculatively load the big model
 * and hope, we default small and let the user opt UP to gemma in the picker.
 *
 * - real WebGPU adapter → `onnx-community/Qwen3-0.6B-ONNX` (~0.5 GB, webgpu/q4f16,
 *   confirmed loading on the dev integrated GPU in docs/models.md), faster than CPU.
 * - WASM / software-fallback adapter → `onnx-community/Qwen2.5-0.5B-Instruct`
 *   (~0.5 GB, wasm/q8), the documented "smallest that answers" CPU pick.
 *
 * An explicit user preference bypasses this (the caller only consults it when no
 * valid preference is stored), so a deliberate choice of gemma is honored. Pure:
 * maps device facts to a catalog id; never returns null.
 */
export function defaultModelForDevice(info: {
  device: 'webgpu' | 'wasm';
  isFallback: boolean;
}): string {
  // deviceMemory is deliberately NOT an input: the WebGPU pick (Qwen3-0.6B, ~0.5
  // GB) fits even a memory-constrained WebGPU device, so a low-RAM box still gets
  // the faster GPU model rather than the slower WASM one. Routing is purely by
  // execution path (real WebGPU vs WASM/software-fallback).
  if (info.device === 'webgpu' && !info.isFallback) return QWEN3_06B_ENTRY.id;
  return SMALLER_ENTRY.id;
}
