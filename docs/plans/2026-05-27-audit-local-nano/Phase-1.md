# Phase 1 — [HYGIENIST] Subtractive Cleanup

## Phase Goal

Clear the small, low-risk hygiene findings before any structural work: stop the
three stray screenshots from being committable, pre-empt the latent stale
`activeTier` (ADR-4), and reword one version-stale comment. No behavior change,
no new tests beyond the existing suite staying green.

**Success criteria:**

- The three `Screenshot 2026-05-24 *.png` files no longer appear as committable
  in `git status` (ignored via `.gitignore`).
- `rebuildSession()` in `offscreen.ts` resets `activeTier = null` alongside
  `sessionPromise = null`.
- The stale heavy-load-duplication comment block at the top of `offscreen.ts` no
  longer asserts an outdated framing.
- All gates green: `npm run lint:ci`, `npm run typecheck`, `npm test`,
  `npm run build`.

**Estimated tokens:** ~12k.

## Prerequisites

- Phase 0 read.
- Clean working tree apart from the three untracked screenshots.

## Task 1.1 — Ignore the stray root screenshots

**Goal:** stop dev-only binaries (`Screenshot 2026-05-24 *.png`) from being
committable. They are referenced nowhere.

**Files to Modify:**

- `.gitignore`

**Prerequisites:** none.

**Implementation Steps:**

1. Verify the current state: `git status --porcelain` shows exactly the three
   untracked screenshot files (and the plan dir). Confirm none are tracked:
   `git ls-files | grep -i screenshot` returns nothing.
1. Add an ignore pattern to `.gitignore` that covers screenshot binaries at the
   repo root without over-broadly ignoring intentional image assets. Prefer a
   targeted pattern that matches the `Screenshot`-prefixed naming these files share
   (Chrome/macOS screenshot naming), e.g. a root-anchored `Screenshot *.png`.
   Place it under a clearly labelled comment (mirror the existing comment style
   in `.gitignore`, e.g. a `# Dev screenshots` header).
1. Do NOT ignore `*.png` globally — `well_done.jpg` and any committed art/icon
   assets must stay tracked; confirm no currently-tracked image is newly ignored
   (`git ls-files '*.png' '*.jpg'` before/after, list unchanged).
1. Decide screenshot disposition: the files are dev-local and referenced
   nowhere; leave them on disk (now ignored) rather than `git rm` (they were
   never tracked). Do not commit the binaries.

**Verification Checklist:**

- [x] `git status --porcelain` no longer lists the three screenshots as
      untracked-committable.
- [x] `git check-ignore "Screenshot 2026-05-24 7.33.42 PM.png"` prints the path
      (confirming the pattern matches).
- [x] `git ls-files '*.png' '*.jpg'` is unchanged from before the edit (no
      tracked asset newly ignored).
- [x] `well_done.jpg` (referenced by README) is NOT ignored:
      `git check-ignore well_done.jpg` prints nothing.

**Testing Instructions:** no code tests; this is a repo-hygiene change. Confirm
the four checklist commands above.

**Commit Message Template:**

```text
chore(repo): gitignore stray dev screenshots

Three untracked root screenshots could be swept into a `git add .`.
Ignore the Screenshot-prefixed PNGs without affecting tracked image assets.
```

## Task 1.2 — Reset `activeTier` in `rebuildSession` (ADR-4)

**Goal:** pre-empt HEALTH LOW-1 — `rebuildSession()` nulls `sessionPromise` but
leaves module-scoped `activeTier` stale, a latent OOM-guard bypass if the
`handleWarmup` destroy-guard is ever reordered.

**Files to Modify:**

- `offscreen.ts`

**Prerequisites:** none.

**Implementation Steps:**

1. Locate `rebuildSession(history)` in `offscreen.ts` (the function that does
   `previous?.destroy()` then `sessionPromise = null` then re-`ensureSession`).
   Find the `sessionPromise = null;` assignment in that function.
1. Add `activeTier = null;` immediately alongside the `sessionPromise = null;`
   in `rebuildSession`, so the offscreen-side tier mirror is cleared whenever the
   session is rebuilt. Keep the existing ordering otherwise.
1. Add a one-line comment noting WHY (the tier mirror must not outlive the
   session it describes; pre-empts a stale-tier OOM-guard bypass — reference
   ADR-R1/R3 framing already present in the file's tier comment).
1. Confirm this does not alter the `handleWarmup` tier-change guard's behavior
   today (after a rebuild `sessionPromise` is null, so that guard's
   `sessionPromise && ...` already short-circuits; the change only removes the
   latent stale value).

**Verification Checklist:**

- [x] `rebuildSession` sets both `sessionPromise = null` and
      `activeTier = null`.
- [x] No other `activeTier` read path regresses (grep `activeTier` in
      `offscreen.ts`: it is read only in the `handleWarmup` guard and written in
      `handleWarmup`; after this change it is also reset in `rebuildSession`).
- [x] `npm run typecheck` clean.
- [x] `npm test` green (existing offscreen-adjacent tests still pass; note
      `offscreen.ts` itself is not in coverage, so no new test is required for
      this one-line module-state reset, but the suite must stay green).

**Testing Instructions:** `npm test` (full suite). No new test — `offscreen.ts`
is outside the coverage set and this is a module-scoped state reset with no
extractable pure core; the guarantee is upheld by the existing destroy-guard
tests plus the grep audit above.

**Commit Message Template:**

```text
fix(offscreen): reset activeTier on session rebuild

rebuildSession nulled sessionPromise but left the module-scoped activeTier
mirror stale, a latent bypass of the OOM-prevention destroy guard if that
guard is ever reordered. Clear the tier mirror alongside the session.
```

## Task 1.3 — Reword the stale heavy-load-duplication comment

**Goal:** the eval's optional cleanup — the comment block at the top of
`offscreen.ts` frames the heavy-module load as "mirrors the inline pattern in
`src/session.ts`" and references a since-removed `src/heavy.ts` history in a way
that reads as stale. Reword to reflect current reality without changing code.

**Files to Modify:**

- `offscreen.ts` (the file-header/top comment block only)

**Prerequisites:** none.

**Implementation Steps:**

1. Read the top-of-file comment block in `offscreen.ts` (the JSDoc describing the
   offscreen document and the heavy-module load paragraph that begins "The
   heavy-module load mirrors the inline pattern in `src/session.ts`…").
1. Verify the claim against current code: `src/session.ts` no longer hosts an
   inline heavy-module load (the model lives in the offscreen document; the chat
   layer streams over a port). Confirm by grepping `src/session.ts` for any
   `import('@huggingface/transformers')` (there is none — the heavy import is
   `offscreen.ts` only).
1. Reword the paragraph so it states the CURRENT rationale: the heavy import
   lives only here in the offscreen document; the v0.2 `src/heavy.ts` extraction
   was reverted and the load is intentionally kept inline in this entry file. Do
   NOT claim a mirror of `session.ts` that no longer exists. Keep it concise; this
   is comment-only.
1. Comment-only change — no code, no test surface.

**Verification Checklist:**

- [x] The reworded comment no longer asserts an inline-load mirror in
      `src/session.ts`.
- [x] The reworded comment preserves the load-bearing fact (heavy import is
      offscreen-only; `src/heavy.ts` extraction was reverted intentionally).
- [x] No code lines changed (diff is comment-only).
- [x] `npm run lint:ci` clean (biome does not reformat the comment unexpectedly).

**Testing Instructions:** none beyond `npm run lint:ci` and `npm run build`
staying green (comment-only).

**Commit Message Template:**

```text
docs(offscreen): reword stale heavy-load comment

The header comment claimed the heavy-module load mirrors an inline pattern
in src/session.ts that no longer exists (the model is offscreen-only). State
the current rationale without the stale cross-reference.
```

## Phase Verification

- [x] `npm run lint:ci` — exit 0 (run directly, NOT piped to `tail`).
- [x] `npm run typecheck` — exit 0.
- [x] `npm test` — all pass.
- [x] `npm run build` — succeeds.
- [x] `git status` shows the three screenshots gone from the committable list.
- [x] Three atomic commits landed (1.1, 1.2, 1.3), conventional format, no
      `Co-Authored-By` trailer.
