# Phase 6: Guardrails [FORTIFIER]

## Phase Goal

Add three additive guardrails that prevent regressions the audits flagged:
re-enable Biome's `noExplicitAny` (currently defensively off while the source
has zero `any`) with one scoped ignore for the unavoidable test mock; point CI's
`setup-node` at `node-version-file: .nvmrc` so the CI Node version tracks the
pinned file instead of a hardcoded literal; and extend `tests/docs-config.test.ts`
to assert `docs/testing.md`'s table lists every `tests/*.test.ts` file so that
doc cannot silently drift again.

Success criteria: `biome.json` enables `noExplicitAny`; `npm run lint:ci` passes
with exactly one scoped ignore; CI uses `node-version-file: .nvmrc`; the docs
table guard fails if a test file is added/removed without updating
`docs/testing.md`; all gates green.

Estimated tokens: ~14k.

## Prerequisites

- Phases 1-5 complete. In particular, Phase-1 deleted `tests/system.test.ts`,
  so the docs-table guard and the testing.md update in Phase-7 must agree on the
  final file list. This phase writes the guard; Phase-7 fixes the table content.
- Sequencing note: this guard will FAIL until Phase-7 corrects the
  `docs/testing.md` table. To keep the build green per-phase, either (a) land
  the Phase-7 testing.md table fix together with this guard, or (b) write the
  guard here against the actual current `tests/` listing and have Phase-7's
  table edit conform to it. Choose (b): make the test the source of truth and
  fix the doc to match in Phase-7. Run the guard locally here; if it fails only
  because testing.md is stale, that is expected and Phase-7 closes it. State this
  clearly in the commit body.

## Tasks

### Task 6.1: Re-enable noExplicitAny with a scoped ignore

**Goal:** `biome.json` sets `suspicious.noExplicitAny: "off"`. The source has
zero `any`; the only `as any` is the global chrome mock in `tests/setup.ts:115`
(`(globalThis as any).chrome = chromeMock;`). Turn the rule back on and add one
scoped override for that line/file so the guard catches any future stray `any`
(`eval` Type Rigor / Code Quality optional).

**Files to Modify/Create:**

- `biome.json`
- `tests/setup.ts` (only if a `biome-ignore` inline comment is the chosen
  scoping mechanism)

**Implementation Steps:**

1. In `biome.json`, remove `"noExplicitAny": "off"` (or set it to `"error"`).
   The `suspicious` block may then be empty — if so, remove the now-empty
   `suspicious` object, leaving `recommended: true` and the `style` override.
1. Run `npm run lint:ci`. The only expected violation is `tests/setup.ts:115`.
   Scope the ignore as narrowly as possible:
   - Preferred: an inline `// biome-ignore lint/suspicious/noExplicitAny:
     global chrome mock requires any` comment immediately above the offending
     line. This is the most surgical scope and documents the why.
   - Alternative: a per-file `overrides` entry in `biome.json` for
     `tests/setup.ts`. Prefer the inline ignore (single line, single reason).
1. Consider whether `tests/setup.ts` has other `any` (the `chromeMock`
   `lastError`, `mockImplementation` callbacks use typed `unknown`, so likely
   only line 115). Fix any others by tightening types if trivial; otherwise
   scope-ignore with a reason. Do not introduce new `any` in source to satisfy
   anything.
1. Re-run `npm run lint:ci` until clean.

**Verification Checklist:**

- `biome.json` no longer disables `noExplicitAny`.
- Exactly one `biome-ignore`/override exists, on the test mock, with a reason.
- `npm run lint:ci` exits 0.
- `npm run typecheck` exits 0.

**Testing Instructions:** No new unit test. The guard IS the lint config; verify
by `npm run lint:ci`. Optionally, temporarily add a stray `const x: any = 1;` in
a `src/` file and confirm lint fails, then remove it.

**Commit Message Template:**

```text
chore(lint): re-enable noExplicitAny with one scoped ignore

The rule was off defensively while the source carries zero any. Turn it
back on so a future stray any fails lint; the only exception is the global
chrome test mock, scoped with an inline biome-ignore.
```

### Task 6.2: Point CI setup-node at the .nvmrc file

**Goal:** `.github/workflows/ci.yml` hardcodes `node-version: 20` while the repo
pins `.nvmrc = 20` and local dev has run on v24. Use `node-version-file: .nvmrc`
so CI tracks the pinned file and cannot drift from it (`eval` Reproducibility
optional nit).

**Files to Modify/Create:**

- `.github/workflows/ci.yml`

**Implementation Steps:**

1. In the `actions/setup-node@v4` step, replace `node-version: 20` with
   `node-version-file: .nvmrc`. Keep `cache: npm`.
1. Do not change `.nvmrc` itself (it stays `20`); the point is single-sourcing
   the version, not bumping it. If the team later wants v24, they bump `.nvmrc`
   and CI follows automatically.

**Verification Checklist:**

- The `setup-node` step references `node-version-file: .nvmrc` and no longer has
  a hardcoded `node-version`.
- YAML is valid (no other step altered).

**Testing Instructions:** Cannot run GitHub Actions locally; verify by reading
the YAML and confirming `.nvmrc` exists and contains a valid version. The next
CI run on push/PR exercises it.

**Commit Message Template:**

```text
ci: source the Node version from .nvmrc

setup-node hardcoded node-version: 20 while .nvmrc pins 20. Use
node-version-file so CI tracks the pinned file and cannot drift.
```

### Task 6.3: Guard the testing.md table against test-file drift

**Goal:** `docs/testing.md` lists test files in a table that silently fell out
of date (it lists 7 while the suite has more). Extend `tests/docs-config.test.ts`
to assert the table references every `tests/*.test.ts` file, so adding or
removing a test file without updating the doc fails CI (`eval` Onboarding /
Maintenance Drag).

**Files to Modify/Create:**

- `tests/docs-config.test.ts`

**Implementation Steps:**

1. In `tests/docs-config.test.ts`, add a new `it` (or a new `describe` block for
   `docs/testing.md`). Read `docs/testing.md` and enumerate the actual test
   files: `fs.readdirSync(resolve(repoRoot, 'tests'))` filtered to
   `*.test.ts`. The file list excludes `setup.ts` (not a `*.test.ts`).
1. For each test file, assert `docs/testing.md` content contains the filename
   (e.g. `tests/offscreen-client.test.ts`, or just `offscreen-client.test.ts` —
   match whatever form the table uses; the existing table uses the full
   `tests/<name>.test.ts` path, so assert that form). Use a clear failure
   message naming the missing file.
1. Decide directionality: assert every actual test file appears in the doc (the
   important direction — catches new untracked-in-doc files). Optionally also
   assert the doc lists no nonexistent file (catches stale entries after a
   delete like `system.test.ts`). Implement both for completeness; both must
   pass after Phase-7 fixes the table.
1. This test will FAIL now because the table is stale (and because Phase-1
   removed `system.test.ts` while the table still lists it). That is expected
   per the Prerequisites note. Phase-7 Task updates the table so this passes.
   Land this guard with a commit body noting the dependency on the Phase-7 table
   fix, OR coordinate to land both in sequence so `main` is never red. Preferred:
   land 6.3 and the Phase-7 testing.md table edit back-to-back.

**Verification Checklist:**

- The new test enumerates `tests/*.test.ts` from disk and checks each against
  `docs/testing.md`.
- After the Phase-7 testing.md table fix, `npm run coverage` is green including
  this guard.
- The existing `modelName` cross-reference test is unchanged and still passes.

**Testing Instructions:** Run `npx vitest run tests/docs-config.test.ts`. It
should fail listing the missing/stale files until the table is corrected, then
pass. Add a temporary dummy `tests/zzz.test.ts` to confirm the guard flags an
undocumented file, then remove it.

**Commit Message Template:**

```text
test(docs): guard docs/testing.md table against test-file drift

The testing-doc table listed 7 of the 13 test files and nothing caught
the drift. docs-config.test.ts now asserts the table references every
tests/*.test.ts and no nonexistent file. The table is corrected in the
docs phase.
```

## Phase Verification

- `noExplicitAny` is on with one scoped ignore; `npm run lint:ci` green.
- CI sources Node from `.nvmrc`.
- The docs-table guard exists and (after Phase-7's table fix) passes.
- `npm run typecheck`, `npm run coverage` pass (coordinate 6.3 with the Phase-7
  table fix so `main` stays green).

Integration points: Task 6.3 is tightly coupled to the Phase-7 `docs/testing.md`
table update; land them together. The `noExplicitAny` guard interacts with any
`as any` a future phase might add — none of these phases do.

Known limitations: the docs-table guard checks presence by filename substring,
not column accuracy (the "Covers" description is not validated). That is
sufficient to catch add/remove drift, which is the failure mode observed.
