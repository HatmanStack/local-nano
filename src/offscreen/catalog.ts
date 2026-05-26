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
 * A model is non-gated (always listed, live on every device) ONLY when
 * `docs/models.md` confirms it has a clean, currently-preferred working tier
 * (ADR-P2). Exactly two entries qualify:
 *
 * - `onnx-community/gemma-4-E2B-it-ONNX` (the default) at `webgpu/q4f16`.
 * - `onnx-community/Qwen2.5-0.5B-Instruct` at `wasm/q8` (the "smallest model
 *   that actually answers", the WASM-tier default in `docs/models.md`).
 *
 * Every other candidate sits behind an off-by-default build-time gate, read
 * through a function seam mirroring `isSmallerModelEnabled()` in `ladder.ts`, so
 * the picker can be exercised with gated entries on and off in tests via
 * `vi.spyOn` without flipping a production constant.
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
  qwen3Enabled: boolean;
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
 * Build-time gate for `onnx-community/Qwen3.5-0.8B-ONNX`. DEFAULT OFF.
 *
 * Qwen3.5-0.8B is GATED, not live, because `docs/models.md` shows it has NO
 * clean, currently-preferred WebGPU tier: `webgpu/q4f16` fails numerically
 * (emits a few real tokens then loops one repeated token on Iris Xe), and
 * `webgpu/q4` only "worked historically" and carries the `q4` SIGILL caveat the
 * project deliberately moved off for the primary model (CHANGELOG 0.2.4). On
 * WASM, every quantized variant fails on `GatherBlockQuantized`, leaving only
 * the slow per-component path. Flipping this flag is a manual WebGPU-smoke
 * follow-up (ROADMAP #6), not a CI change: it must NOT be set true until a
 * manual smoke pass confirms a clean, SIGILL-free working tier on real hardware.
 */
export const QWEN3_08B_ENABLED = false;

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
 * Read the Qwen3.5-0.8B gate through a function seam so the picker can be
 * exercised with the gated entry on and off in tests (`vi.spyOn`) without
 * flipping the production constant. Production always returns
 * `QWEN3_08B_ENABLED` (false).
 */
export function isQwen3_08bEnabled(): boolean {
  return QWEN3_08B_ENABLED;
}

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
 * (`wasm/q8`). The same model `ladder.ts` names as `SMALLER_MODEL_CANDIDATE`. It
 * is given NO WebGPU tier here because the guide does not vet one.
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
 * The default entry for the primary model (gemma-4-E2B). Its ladder is
 * `PRIMARY_LADDER` itself (referenced, not duplicated) so the default entry's
 * tiers are identical to today's primary ladder.
 */
const DEFAULT_ENTRY: InternalEntry = {
  id: PRIMARY_MODEL,
  displayName: 'Gemma 4 E2B Instruct',
  downloadSize: '~1.5 GB',
  note: 'default; WebGPU, ~5-15 tok/s on Iris Xe',
  tiers: PRIMARY_LADDER,
  gated: false,
  isVisible: () => true,
};

/**
 * The gated Qwen3.5-0.8B entry. Gated because `docs/models.md` shows no clean
 * preferred WebGPU tier (numerical breakdown on `q4f16`; SIGILL-caveated `q4`
 * the project abandoned). The only vetted path is the slow per-component WASM
 * config `{embed_tokens: 'fp16', decoder_model_merged: 'q8'}` (~50s TTFT for a
 * 1500-char context), encoded here as the single tier so no clean WebGPU tier is
 * claimed. `dtype` is a JSON string of the per-component object the
 * transformers v4 object form accepts; the note marks this entry as a
 * manual-smoke target. Flipping `QWEN3_08B_ENABLED` is a manual WebGPU-smoke
 * follow-up, not a CI change.
 */
const QWEN3_08B_ENTRY: InternalEntry = {
  id: 'onnx-community/Qwen3.5-0.8B-ONNX',
  displayName: 'Qwen3.5 0.8B',
  downloadSize: '~0.8 GB',
  note: 'WebGPU-quirky; WASM only via slow per-component path; unvetted on WebGPU',
  tiers: [
    {
      modelName: 'onnx-community/Qwen3.5-0.8B-ONNX',
      device: 'wasm',
      dtype: '{"embed_tokens":"fp16","decoder_model_merged":"q8"}',
    },
  ],
  gated: true,
  isVisible: (gates) => gates.qwen3Enabled,
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
  qwen3Enabled?: boolean;
}

/**
 * The full ordered catalog, smallest to largest with the default in its size
 * position. Gated entries are filtered by `listCatalog`/`findCatalogEntry` via
 * each entry's own `isVisible`.
 */
const ALL_ENTRIES: InternalEntry[] = [SMALLER_ENTRY, DEFAULT_ENTRY, QWEN3_08B_ENTRY, LARGER_ENTRY];

/**
 * The visible catalog. Returns the non-gated entries always (the default +
 * Qwen2.5-0.5B), and includes a gated entry only when its gate is on. Order is
 * smallest to largest with the default in its size position.
 */
export function listCatalog(opts: GateOpts = {}): CatalogEntry[] {
  // Route the default through the module's own exports so tests can drive the
  // gate state with `vi.spyOn`, the same way `session.ts` spies
  // `isSmallerModelEnabled` (ESM intra-module calls bind locally; the self
  // import lets the spy intercept).
  const gates: GateState = {
    largerEnabled: opts.largerEnabled ?? self.isLargerModelEnabled(),
    qwen3Enabled: opts.qwen3Enabled ?? self.isQwen3_08bEnabled(),
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
