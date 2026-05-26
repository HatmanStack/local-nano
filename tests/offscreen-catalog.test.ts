import { describe, expect, it, vi } from 'vitest';
import * as catalogModule from '../src/offscreen/catalog.js';
import {
  type CatalogEntry,
  DEFAULT_MODEL_ID,
  findCatalogEntry,
  isLargerModelEnabled,
  isQwen3_08bEnabled,
  LARGER_MODEL_ENABLED,
  listCatalog,
  QWEN3_08B_ENABLED,
} from '../src/offscreen/catalog.js';
import { PRIMARY_LADDER, PRIMARY_MODEL, type Tier } from '../src/offscreen/ladder.js';

const QWEN25_05B = 'onnx-community/Qwen2.5-0.5B-Instruct';
const QWEN35_08B = 'onnx-community/Qwen3.5-0.8B-ONNX';

/** Cells docs/models.md marks as failing or caveated for any model. */
const FORBIDDEN_NON_GATED: ReadonlyArray<Pick<Tier, 'device' | 'dtype'>> = [
  { device: 'webgpu', dtype: 'q4' },
];

describe('catalog gate constants', () => {
  it('ships both unvetted gates OFF by default', () => {
    expect(QWEN3_08B_ENABLED).toBe(false);
    expect(LARGER_MODEL_ENABLED).toBe(false);
  });

  it('exposes function seams returning the production constants', () => {
    expect(isQwen3_08bEnabled()).toBe(QWEN3_08B_ENABLED);
    expect(isLargerModelEnabled()).toBe(LARGER_MODEL_ENABLED);
  });

  it('DEFAULT_MODEL_ID is the primary model', () => {
    expect(DEFAULT_MODEL_ID).toBe(PRIMARY_MODEL);
  });
});

describe('listCatalog', () => {
  it('with all gates off returns exactly the default + Qwen2.5-0.5B, no gated entries', () => {
    const entries = listCatalog({ largerEnabled: false, qwen3Enabled: false });
    const ids = entries.map((e) => e.id);
    expect(ids).toContain(PRIMARY_MODEL);
    expect(ids).toContain(QWEN25_05B);
    expect(ids).not.toContain(QWEN35_08B);
    expect(entries.every((e) => e.gated === false)).toBe(true);
    expect(entries).toHaveLength(2);
  });

  it('orders smallest to largest with the default in its size position', () => {
    const ids = listCatalog({ largerEnabled: false, qwen3Enabled: false }).map((e) => e.id);
    // Qwen2.5-0.5B (~0.5 GB) is smaller than gemma-4-E2B (~1.5 GB).
    expect(ids.indexOf(QWEN25_05B)).toBeLessThan(ids.indexOf(PRIMARY_MODEL));
  });

  it('includes Qwen3.5-0.8B only when its gate is on', () => {
    expect(listCatalog({ qwen3Enabled: false }).map((e) => e.id)).not.toContain(QWEN35_08B);
    expect(listCatalog({ qwen3Enabled: true }).map((e) => e.id)).toContain(QWEN35_08B);
  });

  it('includes the larger placeholder entry only when its gate is on', () => {
    const off = listCatalog({ largerEnabled: false, qwen3Enabled: false });
    const on = listCatalog({ largerEnabled: true, qwen3Enabled: false });
    expect(on.length).toBe(off.length + 1);
    // The larger entry sorts after the default (largest size position).
    const larger = on.find((e) => !off.some((o) => o.id === e.id));
    expect(larger).toBeDefined();
    expect(on.indexOf(larger as CatalogEntry)).toBeGreaterThan(
      on.findIndex((e) => e.id === PRIMARY_MODEL),
    );
  });

  it('defaults the gate options to the function seams (vi.spyOn drives both states)', () => {
    const qwenSpy = vi.spyOn(catalogModule, 'isQwen3_08bEnabled').mockReturnValue(true);
    const largerSpy = vi.spyOn(catalogModule, 'isLargerModelEnabled').mockReturnValue(true);
    try {
      const ids = listCatalog().map((e) => e.id);
      expect(ids).toContain(QWEN35_08B);
      // Larger placeholder present too (4 total: Qwen2.5, default, Qwen3.5, larger).
      expect(ids.length).toBe(4);
    } finally {
      qwenSpy.mockRestore();
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

  it('returns null for an unknown id', () => {
    expect(findCatalogEntry('made-up/model')).toBeNull();
  });

  it('returns null for a gated id while its gate is off, and the entry while on', () => {
    expect(findCatalogEntry(QWEN35_08B, { qwen3Enabled: false })).toBeNull();
    const entry = findCatalogEntry(QWEN35_08B, { qwen3Enabled: true });
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe(QWEN35_08B);
    expect(entry?.gated).toBe(true);
  });

  it('defaults its gate options to the function seams', () => {
    const qwenSpy = vi.spyOn(catalogModule, 'isQwen3_08bEnabled').mockReturnValue(true);
    try {
      expect(findCatalogEntry(QWEN35_08B)?.id).toBe(QWEN35_08B);
    } finally {
      qwenSpy.mockRestore();
    }
  });
});

describe('vetted-cell discipline', () => {
  it('no non-gated entry encodes a webgpu/q4 tier or any failing/caveated cell', () => {
    const nonGated = listCatalog({ largerEnabled: false, qwen3Enabled: false });
    for (const entry of nonGated) {
      for (const tier of entry.tiers) {
        for (const bad of FORBIDDEN_NON_GATED) {
          expect(tier.device === bad.device && tier.dtype === bad.dtype).toBe(false);
        }
      }
    }
  });

  it('the gated Qwen3.5-0.8B entry encodes no clean WebGPU tier', () => {
    const entry = findCatalogEntry(QWEN35_08B, { qwen3Enabled: true });
    expect(entry).not.toBeNull();
    expect(entry?.tiers.some((t) => t.device === 'webgpu')).toBe(false);
  });

  it('every entry carries display metadata fields', () => {
    const all = listCatalog({ largerEnabled: true, qwen3Enabled: true });
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
