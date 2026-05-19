# Feedback Log

This file is the feedback channel between the Planning Architect, the Plan
Reviewer, the Implementation Engineer, and the Code Reviewer for the
`2026-05-18-dom-aware-actions` plan. See `pipeline.md` for the full signal
protocol.

## Active Feedback

(none — all PLAN_REVIEW items from 2026-05-18 are resolved; see below)

## Resolved Feedback

### PLAN_REVIEW 2026-05-18 — resolved 2026-05-18 (Planner iteration 2)

The plan reviewer raised two critical issues and four suggestions. All
have been addressed in the plan files; the resolution per item:

#### Critical Issues (Resolved)

1. **`ActionDescriptor` schema disagreed between Phase-0 and Phase-1.**
   Resolved. Phase-0's `ActionDescriptor` definition (Action Schema
   section) now declares `parentLabel?: string` with the comment "Literal
   submenu title string (omitted = top-level)", matching what Phase-1
   Task 1.2 implements and what Phase-2's `registerMenus` consumes
   (`d.parentLabel`). A short paragraph was added under the interface
   block explaining the field's semantics and pointing to the
   `src/background/menus.ts` grouping rule. The old `parent?: ActionId | null`
   shape is gone.

1. **Per-action `label` strings were never specified.** Resolved. Phase-1
   Task 1.2 now contains an explicit `id → label → parentLabel → kind`
   table for all 11 descriptors, with the exact label strings
   (`Ask local-nano about this`, `Summarize this page`, `Improve writing`,
   `Make shorter`, `Make formal`, `Fix grammar`, `To English`,
   `To Spanish`, `To French`, `Simplify`, `Summarize`). The table is
   cross-referenced from Phase-0's `ActionDescriptor` section ("see the
   id-to-label table in Phase-1 Task 1.2") and from Phase-4 Task 4.1's
   menu table. Phase-1 also gained a new unit-test requirement asserting
   each descriptor's `label`/`parentLabel` matches the table, locking the
   strings in. The schema-test count moved from 6 to 7, and the file's
   Phase Verification line from `>= 11` to `>= 12` tests
   (7 schema + 5 helper).

#### Suggestions (Resolved)

1. **Phase-4 doc table contradicted the actual menu parent label.**
   Accepted and applied. The `docs/dom-actions.md` menu table in Phase-4
   Task 4.1 now uses the actual parent label
   (`Translate / Simplify / Summarize in place ▸ To English`, etc.)
   instead of the abbreviated `Translate ▸ ...` form, and a note was
   added directing the doc writer to the canonical id-to-label table in
   Phase-1 Task 1.2.

1. **Phase-1 Task 1.3 test #9 was awkwardly worded.** Accepted. The test
   description was rewritten to "call `loadHeavy(...)` directly twice
   and assert both calls return the same object reference
   (`expect(a).toBe(b)`)", which is a clean, non-circular assertion of
   cache reuse and does not rely on Vitest module-loader internals.

1. **Phase-3 Task 3.5 numeric off-by-one.** Accepted. The list header is
   now "Required tests (at least 15)" (the actual enumerated count) and
   the verification checklist line now reads `>= 22 tests total
   (7 capture + 15 dispatch)`. The arithmetic is internally consistent.

1. **Phase-2 Task 2.4 manifest-order note.** Verified against
   `biome.json` (the project's only lint config — Biome 2.4.15 does not
   enforce JSON array ordering). The "Insert `contextMenus` last to
   minimize diff churn" instruction was rewritten to "Append
   `contextMenus` at the end of the array; Chrome ignores the order, and
   the project's Biome 2.4.15 config does not enforce JSON array
   ordering (verified against `biome.json`)." so the rationale is
   explicit instead of brittle.
