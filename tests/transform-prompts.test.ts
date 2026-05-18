import { describe, expect, it } from 'vitest';
import {
  ACTION_DESCRIPTORS,
  type ActionDescriptor,
  type ActionId,
  actionToDescriptor,
  actionToPrompt,
  SELECTION_LIMIT,
} from '../src/transform-prompts.js';

// ---------------------------------------------------------------------------
// Canonical id → label → parentLabel → kind table (Phase-1 Task 1.2)
// ---------------------------------------------------------------------------

const EXPECTED_DESCRIPTORS: Record<
  ActionId,
  { label: string; parentLabel?: string; kind: ActionDescriptor['kind'] }
> = {
  ask_about_selection: {
    label: 'Ask local-nano about this',
    kind: 'chat',
  },
  summarize_page: {
    label: 'Summarize this page',
    kind: 'page-chat',
  },
  rewrite_improve: {
    label: 'Improve writing',
    parentLabel: 'Rewrite',
    kind: 'transform-editable',
  },
  rewrite_shorter: {
    label: 'Make shorter',
    parentLabel: 'Rewrite',
    kind: 'transform-editable',
  },
  rewrite_formal: {
    label: 'Make formal',
    parentLabel: 'Rewrite',
    kind: 'transform-editable',
  },
  rewrite_grammar: {
    label: 'Fix grammar',
    parentLabel: 'Rewrite',
    kind: 'transform-editable',
  },
  translate_en: {
    label: 'To English',
    parentLabel: 'Translate / Simplify / Summarize in place',
    kind: 'transform-readonly',
  },
  translate_es: {
    label: 'To Spanish',
    parentLabel: 'Translate / Simplify / Summarize in place',
    kind: 'transform-readonly',
  },
  translate_fr: {
    label: 'To French',
    parentLabel: 'Translate / Simplify / Summarize in place',
    kind: 'transform-readonly',
  },
  simplify_in_place: {
    label: 'Simplify',
    parentLabel: 'Translate / Simplify / Summarize in place',
    kind: 'transform-readonly',
  },
  summarize_in_place: {
    label: 'Summarize',
    parentLabel: 'Translate / Simplify / Summarize in place',
    kind: 'transform-readonly',
  },
};

const TRANSFORM_IDS: ActionId[] = [
  'rewrite_improve',
  'rewrite_shorter',
  'rewrite_formal',
  'rewrite_grammar',
  'translate_en',
  'translate_es',
  'translate_fr',
  'simplify_in_place',
  'summarize_in_place',
];

const CHAT_IDS: ActionId[] = ['ask_about_selection', 'summarize_page'];

describe('ACTION_DESCRIPTORS schema', () => {
  it('contains every ActionId in the union exactly once', () => {
    const expectedIds = new Set(Object.keys(EXPECTED_DESCRIPTORS));
    const tableIds = new Set(ACTION_DESCRIPTORS.map((d) => d.id));
    expect(tableIds).toEqual(expectedIds);
    // No duplicates: the table length equals the set size.
    expect(ACTION_DESCRIPTORS.length).toBe(tableIds.size);
  });

  it('matches the canonical label / parentLabel / kind table for every id', () => {
    for (const descriptor of ACTION_DESCRIPTORS) {
      const expected = EXPECTED_DESCRIPTORS[descriptor.id];
      expect(expected, `Unexpected ActionId in table: ${descriptor.id}`).toBeDefined();
      expect(descriptor.label).toBe(expected.label);
      expect(descriptor.parentLabel).toBe(expected.parentLabel);
      expect(descriptor.kind).toBe(expected.kind);
    }
  });

  it('exports SELECTION_LIMIT === 1500', () => {
    expect(SELECTION_LIMIT).toBe(1500);
  });
});

describe('actionToPrompt', () => {
  it('returns a non-empty string for every transform-* id', () => {
    for (const id of TRANSFORM_IDS) {
      const prompt = actionToPrompt(id);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it('every transform prompt enforces text-only output via "Output ONLY" phrasing', () => {
    for (const id of TRANSFORM_IDS) {
      const prompt = actionToPrompt(id);
      // Defensive: ensure each prompt clearly constrains output to text-only.
      expect(prompt).toMatch(/Output ONLY/i);
    }
  });

  it('prompts contain no Markdown formatting hints (no **, no leading # )', () => {
    for (const id of TRANSFORM_IDS) {
      const prompt = actionToPrompt(id);
      // No Markdown bold sequences — the model could otherwise mimic them.
      expect(prompt).not.toMatch(/\*\*/);
      // No leading `# ` heading lines.
      expect(prompt).not.toMatch(/^#\s|\n#\s/);
    }
  });

  it('throws for chat-kind actions (systemPrompt is null)', () => {
    for (const id of CHAT_IDS) {
      expect(() => actionToPrompt(id)).toThrow(/Unknown action/);
    }
  });

  it('throws for unknown action ids', () => {
    expect(() => actionToPrompt('not_a_real_action' as ActionId)).toThrow(/Unknown action/);
  });
});

describe('actionToDescriptor', () => {
  it('returns the right kind family per id', () => {
    expect(actionToDescriptor('ask_about_selection').kind).toBe('chat');
    expect(actionToDescriptor('summarize_page').kind).toBe('page-chat');
    expect(actionToDescriptor('rewrite_improve').kind).toBe('transform-editable');
    expect(actionToDescriptor('translate_en').kind).toBe('transform-readonly');
    expect(actionToDescriptor('simplify_in_place').kind).toBe('transform-readonly');
  });

  it('throws for unknown action ids', () => {
    expect(() => actionToDescriptor('bogus' as ActionId)).toThrow(/Unknown action/);
  });
});
