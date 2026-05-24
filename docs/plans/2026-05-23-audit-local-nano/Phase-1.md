# Phase 1: Dead-code Removal [HYGIENIST]

## Phase Goal

Subtractively remove four dead or vestigial surfaces with no production
consumers: the unused `src/system.ts` module and its misleading test, the
speculative `finalize()` no-op in `selection-rewrite.ts`, the stale vendored
`dot_env.json`, and the untracked stale `web-store` zip. This shrinks the
surface that later structural phases edit and removes false-confidence test
coverage.

Success criteria: `src/system.ts`, `tests/system.test.ts`, and
`vendor/prompt-api-polyfill/dot_env.json` no longer exist; `rewrite.finalize()`
and its definition are gone; the stale zip is deleted from the working tree;
`npm run typecheck`, `npm run coverage`, and `npm run build` all pass.

Estimated tokens: ~12k.

## Prerequisites

- Phase-0 read.
- `cp .env.example.json .env.json` done; `npm ci` done.

## Tasks

### Task 1.1: Delete the dead `system.ts` module and its test

**Goal:** Remove `src/system.ts` (exports `SYSTEM_INSTRUCTION`) and
`tests/system.test.ts`. The export is imported by nothing in production. The
live system prompt is the terser literal hardcoded at `offscreen.ts:55`
(`const SYSTEM_INSTRUCTION = 'You are a helpful assistant. Answer concisely and
directly.'`). The test asserts the module "mentions webpage," giving false
confidence that a webpage-aware instruction ships when it does not.

**Decision (per health finding 3 / doc STALE-1):** Delete the module rather
than wiring it into offscreen. The offscreen literal is the intended live
prompt and is short by design for a memory-constrained on-device model; adopting
the richer prompt is a product change, not a remediation. Phase-7 fixes the docs
that currently claim `src/system.ts` seeds the session.

**Files to Modify/Create:**

- Delete `src/system.ts`.
- Delete `tests/system.test.ts`.

**Prerequisites:** none beyond Phase-0.

**Implementation Steps:**

1. Confirm no production import: grep the repo (excluding `tests/` and
   `docs/`) for `system.js`, `system.ts`, and `SYSTEM_INSTRUCTION`. The only
   non-test, non-doc hit must be the unrelated local `const` inside
   `offscreen.ts` (a different identifier in a different module). Do not touch
   `offscreen.ts`.
1. Delete both files.
1. Confirm `docs/testing.md` references `tests/system.test.ts` in its table —
   leave the doc alone here; Phase-7 owns the doc table.

**Verification Checklist:**

- [x] `src/system.ts` and `tests/system.test.ts` do not exist.
- [x] `grep -rn "src/system" --include="*.ts" .` returns nothing outside docs.
- [x] `npm run typecheck` exits 0.
- [x] `npm run coverage` passes (test count drops by the two `system.test.ts`
  cases; coverage stays at or above thresholds because a now-untested module is
  also gone).

**Testing Instructions:** No new test. Run `npm run coverage` and confirm green;
confirm the suite no longer lists `tests/system.test.ts`.

**Commit Message Template:**

```text
chore(hygiene): delete unused system.ts module and misleading test

SYSTEM_INSTRUCTION was imported only by its own test; the live system
prompt is the terser literal in offscreen.ts. The test asserted a
webpage-aware prompt that never reaches the model. Docs corrected in a
later docs phase.
```

### Task 1.2: Remove the speculative `finalize()` no-op

**Goal:** Delete the documented no-op `finalize()` from
`selection-rewrite.ts:352-354` and its sole call site at
`src/session.ts:464`. It is reserved-for-future dead surface (`health` finding
16; eval Code Quality concern).

**Files to Modify/Create:**

- `src/selection-rewrite.ts`
- `src/session.ts`

**Prerequisites:** none.

**Implementation Steps:**

1. In `src/selection-rewrite.ts`, `streamRewriteIntoRange` returns
   `{ applyChunk, finalize }`. Remove the `finalize` function definition and
   remove it from the returned object so the return type becomes
   `{ applyChunk: (chunk: string) => void }`.
1. In `src/session.ts` `sendRewrite`, the success branch calls
   `rewrite.finalize();` before `attachRewriteActions(...)`. Remove that call.
   Leave `attachRewriteActions` and `recordSentTurn` in place.
1. Check `tests/selection-rewrite.test.ts` for any assertion that `finalize` is
   a function or is callable. If present, remove just that assertion (the
   rewrite-application behavior tests stay). Do not weaken behavior coverage.

**Verification Checklist:**

- [x] No occurrence of `finalize` remains in `src/selection-rewrite.ts` or
  `src/session.ts`.
- [x] The `streamRewriteIntoRange` return type no longer advertises `finalize`.
- [x] `npm run typecheck` exits 0 (the removed-from-return-type change must not
  break callers — `sendRewrite` is the only caller).
- [x] `npm run coverage` passes.

**Testing Instructions:** Run `npm run coverage`. Existing rewrite-application
tests (chunk streaming into the range, undo) must still pass unchanged.

**Commit Message Template:**

```text
refactor(session): drop speculative rewrite finalize() no-op

finalize() was a reserved-for-future no-op called once in sendRewrite.
Removing it and its call site trims dead surface; commit/rollback can be
reintroduced with real behavior if ever needed.
```

### Task 1.3: Delete the stale vendored `dot_env.json`

**Goal:** Remove `vendor/prompt-api-polyfill/dot_env.json`, a tracked second
copy of env config inside vendored third-party code. Runtime config comes from
the repo-root `.env.json` via `offscreen.ts:20`; this vendored file is read by
nothing in this repo (`health` finding 18).

**Files to Modify/Create:**

- Delete `vendor/prompt-api-polyfill/dot_env.json`.

**Prerequisites:** none.

**Implementation Steps:**

1. Grep the repo for `dot_env` to confirm no code or build step references it
   (`build.mjs`, `scripts/*.mjs`, `src/**`, `offscreen.ts`, the polyfill JS).
   Expect zero references. `docs/configuration.md:76` mentions it as a
   "reference template only"; Phase-7 updates that doc line.
1. `git rm vendor/prompt-api-polyfill/dot_env.json` (this file IS tracked,
   unlike the web-store zip).

**Verification Checklist:**

- [x] `vendor/prompt-api-polyfill/dot_env.json` does not exist.
- [x] `grep -rn "dot_env" .` returns only the `docs/configuration.md` mention
  (which Phase-7 removes) and possibly this plan.
- [x] `npm run build` succeeds (nothing imported it).

**Testing Instructions:** No test. `npm run build` and `npm run typecheck` green.

**Commit Message Template:**

```text
chore(hygiene): remove stale vendored dot_env.json

The vendored copy of the env config is read by nothing; runtime config
comes from repo-root .env.json via offscreen.ts. Doc reference updated
in the docs phase.
```

### Task 1.4: Delete the stale local web-store zip

**Goal:** Remove the untracked, gitignored, version-behind
`web-store/local-nano-v0.2.3.zip` (19 MB) from the working tree. Per the
corrected findings (`health` 4, doc STRUCTURE-1) this is local clutter only, NOT
a git-history problem — a plain file delete, no `git` action.

**Files to Modify/Create:**

- Delete the working-tree file `web-store/local-nano-v0.2.3.zip`.

**Prerequisites:** none.

**Implementation Steps:**

1. Confirm it is untracked: `git ls-files web-store/` returns nothing and
   `git check-ignore web-store/local-nano-v0.2.3.zip` reports `.gitignore:16`
   (`web-store/`).
1. `rm web-store/local-nano-v0.2.3.zip`. Do NOT run any `git` command for this
   file. Leave the `web-store/` directory itself (it is the documented
   `npm run package` output dir).

**Verification Checklist:**

- [x] `web-store/local-nano-v0.2.3.zip` is gone.
- [x] `git status` shows no change related to it (it was never tracked).

**Testing Instructions:** None.

**Commit Message Template:** This task produces no git change (untracked file
delete). Fold the verification note into Task 1.3's commit body if a record is
wanted, or skip — there is nothing to commit.

## Phase Verification

- [x] `src/system.ts`, `tests/system.test.ts`,
  `vendor/prompt-api-polyfill/dot_env.json`, and the stale zip are all gone.
- [x] No `finalize` reference remains in source.
- [x] `npm run typecheck`, `npm run coverage`, `npm run build`, and
  `npm run lint:ci` all pass.

Integration points: Phase-7 (docs) depends on Tasks 1.1 and 1.3 being done so it
can correct `docs/architecture.md`, `docs/prompt-api.md`, `docs/testing.md`, and
`docs/configuration.md` to match the deleted surfaces.

Known limitations: the docs still reference `src/system.ts` and `dot_env.json`
until Phase-7; CI markdownlint/lychee do not check code references, so this is
not a CI break in the interim.
