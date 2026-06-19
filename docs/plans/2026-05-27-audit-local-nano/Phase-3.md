# Phase 3 — [FORTIFIER] Additive Guardrails

## Phase Goal

Add the one genuinely warranted guardrail and record the deliberately-deferred
dev-dependency advisory so it is tracked rather than silently lost. This phase is
DELIBERATELY SMALL: the eval scores Type Rigor 9, Reproducibility 10, and Git
Hygiene 9 (all at/above the gate), and CI already runs lint → markdownlint →
lychee → typecheck → coverage → build. There is NO warranted new lint rule, CI
job, or git hook here — adding one would be padding against the explicit
constraint that markdownlint/lychee already exist and that this is polish, not a
rescue.

**Success criteria:**

- The `.gitignore` screenshot guardrail from Phase 1 is confirmed durable (does
  not over-ignore tracked assets) — verified, not re-implemented.
- The dev-only `npm audit` advisory situation (HEALTH LOW-2) is recorded as a
  known, tracked WONTFIX with the upgrade condition, so a future reader does not
  re-discover it as a surprise.

**Estimated tokens:** ~8k.

## Prerequisites

- Phases 1 and 2 complete; gates green.

## Task 3.1 — Confirm the gitignore guardrail is durable

**Goal:** Phase 1 added an ignore pattern for stray dev screenshots. As a
fortifier step, verify the pattern is correctly scoped so it durably prevents
binary-screenshot commits WITHOUT risking a tracked asset being silently ignored
later. This is a verification + (only if needed) tightening task, not a
re-implementation.

**Files to Modify:**

- `.gitignore` (only if the Phase 1 pattern is too broad or too narrow)

**Prerequisites:** Task 1.1 landed.

**Implementation Steps:**

1. Re-read the screenshot ignore pattern added in Phase 1. Confirm it is
   root-anchored / prefix-scoped to the `Screenshot`-prefixed naming and does NOT match
   intentional assets (`well_done.jpg`, any icons under the build output or
   committed art).
1. Run the durability checks: `git check-ignore` matches the three screenshot
   names; `git ls-files '*.png' '*.jpg'` is identical before/after (no tracked
   asset newly ignored); `git status --porcelain` shows no new untracked-but-
   committable binaries.
1. If — and only if — the Phase 1 pattern is over-broad (would ignore a future
   intentional `*.png` asset) or too narrow (misses the screenshot naming), make
   a minimal tightening edit and re-run the checks. If the Phase 1 pattern is
   already correctly scoped, make NO edit and record the verification in the
   commit body of the WONTFIX note (Task 3.2) or skip a redundant commit.
1. Do NOT add a pre-commit hook to enforce this — git hooks are not currently
   used in this repo, the constraint set forbids skipping hooks but does not
   require adding them, and a hook for three stray dev files is over-engineering
   for a single-author repo (Git Hygiene already scores 9).

**Verification Checklist:**

- [x] `git check-ignore "Screenshot 2026-05-24 7.33.42 PM.png"` prints the path.
- [x] `git check-ignore well_done.jpg` prints nothing (intentional asset safe).
- [x] `git ls-files '*.png' '*.jpg'` unchanged vs. pre-Phase-1.
- [x] No git hook added.

**Testing Instructions:** the four checklist commands; no code tests.

**Commit Message Template (only if a tightening edit was made):**

```text
chore(repo): tighten dev-screenshot ignore pattern

Scope the screenshot ignore to the Screenshot-prefixed root binaries so an
intentional image asset is never silently ignored.
```

## Task 3.2 — Record the dev-dependency advisory WONTFIX (HEALTH LOW-2)

**Goal:** `npm audit` reports moderate advisories, all in the dev-only
`vitest → vite` chain (zero production exposure; remediation needs a Vitest major
bump). This is WONTFIX for this remediation; record it so it is tracked, not
re-discovered.

**Files to Modify:**

- `docs/development.md` (a short "Dependency advisories" / "Known dev-only
  advisories" note) OR `ROADMAP.md` (a tracked follow-up line) — pick the file
  that already documents dependency/maintenance posture; do NOT create a new
  file.

**Prerequisites:** none.

**Implementation Steps:**

1. Confirm the current advisory count and chain before writing a number: run
   `npm audit` and `npm audit --omit=dev`. Record the EXACT moderate count from
   the run (the memory note specifically warns against asserting a stale count —
   the prior audit found dev-only moderates; verify today's number) and that
   `--omit=dev` reports 0 production vulnerabilities.
1. Decide placement: `docs/development.md` is the natural home (it already covers
   local setup / maintenance). Add a brief subsection stating: the advisories are
   dev/CI-only in the `vitest → vite` chain, zero production exposure
   (`npm audit --omit=dev` = 0), and remediation is deferred because it requires a
   Vitest MAJOR upgrade (a breaking test-toolchain change) — tracked, not
   accepted-risk-in-production.
1. Keep it factual and short. Do NOT pin an exact advisory count that will drift
   on every transitive bump; state the CLASS (dev-only vitest/vite chain,
   moderate, zero prod exposure) and the upgrade condition (Vitest major). If a
   count is included, mark it as "as of 2026-05-27".
1. Ensure the prose passes markdownlint (blank lines around the heading/list,
   language-tagged code fences if any).

**Verification Checklist:**

- [x] `npm audit --omit=dev` confirmed 0 production vulnerabilities at write
      time.
- [x] The note states: dev-only, vitest/vite chain, zero prod exposure, deferred
      pending a Vitest major bump.
- [x] No exact-and-undated count asserted (or it is dated "as of 2026-05-27").
- [x] `npx markdownlint-cli2` passes on the edited doc.
- [x] No new file created; the note lives in an existing maintenance-posture doc.

**Testing Instructions:** `npx markdownlint-cli2 <edited file>` and
(if CI link-check covers it) confirm no new external links break lychee.

**Commit Message Template:**

```text
docs(development): record dev-only npm audit advisories as tracked WONTFIX

The moderate advisories are confined to the vitest/vite dev chain with zero
production exposure (npm audit --omit=dev = 0). Document that remediation is
deferred pending a Vitest major upgrade so it is tracked, not re-discovered.
```

## Phase Verification

- [x] `git check-ignore` confirms the screenshot guardrail is scoped correctly;
      no tracked asset newly ignored.
- [x] The dev-advisory WONTFIX is recorded in an existing doc with the upgrade
      condition.
- [x] `npx markdownlint-cli2` passes on any edited doc.
- [x] No CI workflow, lint rule, or git hook added (intentionally — see Phase
      Goal).
- [x] At most two atomic commits (3.1 only if a tightening edit was needed; 3.2),
      conventional format, no `Co-Authored-By`.
