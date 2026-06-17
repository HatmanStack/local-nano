import { describe, expect, it, vi } from 'vitest';
import * as catalogModule from '../src/offscreen/catalog.js';
import {
  type CatalogEntry,
  DEFAULT_MODEL_ID,
  defaultModelForCapability,
  findCatalogEntry,
  isLargerModelEnabled,
  LARGER_MODEL_ENABLED,
  listCatalog,
} from '../src/offscreen/catalog.js';
import { PRIMARY_LADDER, PRIMARY_MODEL, type Tier } from '../src/offscreen/ladder.js';

const QWEN25_05B = 'onnx-community/Qwen2.5-0.5B-Instruct';
const QWEN3_06B = 'onnx-community/Qwen3-0.6B-ONNX';
const LARGER_PLACEHOLDER = 'onnx-community/LARGER-MODEL-PLACEHOLDER';

/** Cells docs/models.md marks as failing or caveated for any model. */
const FORBIDDEN_NON_GATED: ReadonlyArray<Pick<Tier, 'device' | 'dtype'>> = [
  { device: 'webgpu', dtype: 'q4' },
];

describe('catalog gate constants', () => {
  it('ships the larger-model gate OFF by default', () => {
    expect(LARGER_MODEL_ENABLED).toBe(false);
  });

  it('exposes the larger-model seam returning the production constant', () => {
    expect(isLargerModelEnabled()).toBe(LARGER_MODEL_ENABLED);
  });

  it('DEFAULT_MODEL_ID is the primary model', () => {
    expect(DEFAULT_MODEL_ID).toBe(PRIMARY_MODEL);
  });
});

describe('listCatalog', () => {
  it('with the larger gate off returns the three non-gated entries, no gated ones', () => {
    const entries = listCatalog({ largerEnabled: false });
    const ids = entries.map((e) => e.id);
    expect(ids).toContain(PRIMARY_MODEL);
    expect(ids).toContain(QWEN25_05B);
    expect(ids).toContain(QWEN3_06B);
    expect(ids).not.toContain(LARGER_PLACEHOLDER);
    expect(entries.every((e) => e.gated === false)).toBe(true);
    expect(entries).toHaveLength(3);
  });

  it('orders smallest to largest with the default in its size position', () => {
    const ids = listCatalog({ largerEnabled: false }).map((e) => e.id);
    // The two small models sort before the gemma default.
    expect(ids.indexOf(QWEN25_05B)).toBeLessThan(ids.indexOf(PRIMARY_MODEL));
    expect(ids.indexOf(QWEN3_06B)).toBeLessThan(ids.indexOf(PRIMARY_MODEL));
  });

  it('includes the larger placeholder entry only when its gate is on', () => {
    const off = listCatalog({ largerEnabled: false });
    const on = listCatalog({ largerEnabled: true });
    expect(on.length).toBe(off.length + 1);
    expect(on.map((e) => e.id)).toContain(LARGER_PLACEHOLDER);
    // The larger entry sorts after the default (largest size position).
    const larger = on.find((e) => e.id === LARGER_PLACEHOLDER) as CatalogEntry;
    expect(on.indexOf(larger)).toBeGreaterThan(on.findIndex((e) => e.id === PRIMARY_MODEL));
  });

  it('defaults the gate option to the function seam (vi.spyOn drives the state)', () => {
    const largerSpy = vi.spyOn(catalogModule, 'isLargerModelEnabled').mockReturnValue(true);
    try {
      const ids = listCatalog().map((e) => e.id);
      expect(ids).toContain(LARGER_PLACEHOLDER);
      // 4 total: Qwen2.5, Qwen3-0.6B, default, larger.
      expect(ids.length).toBe(4);
    } finally {
      largerSpy.mockRestore();
    }
  });
});

describe('findCatalogEntry', () => {
  it('returns the default entry whose tiers are content-equal to PRIMARY_LADDER', () => {
    const entry = findCatalogEntry(PRIMARY_MODEL);
    expect(entry).not.toBeNull();
    expect(entry?.tiers).toEqual(PRIMARY_LADDER);
    expect(entry?.gated).toBe(false);
  });

  it('returns the non-gated Qwen2.5-0.5B entry with exactly the wasm/q8 tier and no WebGPU tier', () => {
    const entry = findCatalogEntry(QWEN25_05B);
    expect(entry).not.toBeNull();
    expect(entry?.tiers).toEqual([{ modelName: QWEN25_05B, device: 'wasm', dtype: 'q8' }]);
    expect(entry?.tiers.some((t) => t.device === 'webgpu')).toBe(false);
  });

  it('returns the non-gated Qwen3-0.6B entry leading with webgpu/q4f16 then wasm fallbacks', () => {
    const entry = findCatalogEntry(QWEN3_06B);
    expect(entry).not.toBeNull();
    expect(entry?.gated).toBe(false);
    expect(entry?.tiers[0]).toEqual({ modelName: QWEN3_06B, device: 'webgpu', dtype: 'q4f16' });
    expect(entry?.tiers.some((t) => t.device === 'wasm')).toBe(true);
  });

  it('returns null for an unknown id', () => {
    expect(findCatalogEntry('made-up/model')).toBeNull();
  });

  it('returns null for the larger placeholder while its gate is off, and the entry while on', () => {
    expect(findCatalogEntry(LARGER_PLACEHOLDER, { largerEnabled: false })).toBeNull();
    const entry = findCatalogEntry(LARGER_PLACEHOLDER, { largerEnabled: true });
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe(LARGER_PLACEHOLDER);
    expect(entry?.gated).toBe(true);
  });
});

describe('vetted-cell discipline', () => {
  it('no non-gated entry encodes a webgpu/q4 tier or any failing/caveated cell', () => {
    const nonGated = listCatalog({ largerEnabled: false });
    for (const entry of nonGated) {
      for (const tier of entry.tiers) {
        for (const bad of FORBIDDEN_NON_GATED) {
          expect(tier.device === bad.device && tier.dtype === bad.dtype).toBe(false);
        }
      }
    }
  });

  it('every entry carries display metadata fields', () => {
    const all = listCatalog({ largerEnabled: true });
    for (const entry of all) {
      expect(typeof entry.id).toBe('string');
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(entry.downloadSize.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.tiers)).toBe(true);
      expect(entry.tiers.length).toBeGreaterThan(0);
    }
  });
});

describe('defaultModelForCapability', () => {
  it('returns null for a capable device (keep the gemma default)', () => {
    expect(
      defaultModelForCapability('capable', { device: 'webgpu', isFallback: false }),
    ).toBeNull();
    // Even a wasm-configured capable device keeps the default (capability wins).
    expect(defaultModelForCapability('capable', { device: 'wasm', isFallback: false })).toBeNull();
  });

  it('picks the small WebGPU model for a weak real WebGPU adapter', () => {
    expect(defaultModelForCapability('weak', { device: 'webgpu', isFallback: false })).toBe(
      QWEN3_06B,
    );
  });

  it('picks the small WASM model for a weak software-fallback or wasm device', () => {
    expect(defaultModelForCapability('weak', { device: 'webgpu', isFallback: true })).toBe(
      QWEN25_05B,
    );
    expect(defaultModelForCapability('weak', { device: 'wasm', isFallback: false })).toBe(
      QWEN25_05B,
    );
  });

  it('only ever returns ids that resolve to live (non-gated) catalog entries', () => {
    for (const info of [
      { device: 'webgpu' as const, isFallback: false },
      { device: 'webgpu' as const, isFallback: true },
      { device: 'wasm' as const, isFallback: false },
    ]) {
      const id = defaultModelForCapability('weak', info);
      expect(id).not.toBeNull();
      expect(findCatalogEntry(id as string)).not.toBeNull();
    }
  });
});
