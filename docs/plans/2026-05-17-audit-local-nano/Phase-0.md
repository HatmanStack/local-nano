# Phase 0 — Architecture Decisions, Conventions, and Strategy

## Project Conventions

### Package Manager and Runtime

- **Package manager:** npm (lockfile: `package-lock.json`)
- **Node version:** 20+ (set in `.github/workflows/ci.yml` via `actions/setup-node@v4 node-version: 20`; no `.nvmrc` yet)
- **TypeScript:** 5.6+ (`"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "bundler"`)
- **Chrome target:** 120+ (`esbuild target: 'chrome120'`)
- **Extension type:** Chrome MV3 content script + background service worker

### Key Scripts

```bash
npm run build      # esbuild one-shot bundle + ORT wasm copy into dist/
npm run watch      # same in watch mode
npm run typecheck  # tsc --noEmit over *.ts and src/**/*.ts
npm test           # vitest run (unit tests only)
npm run coverage   # vitest run --coverage (thresholds enforced)
```

### Architecture Overview

```text
background.ts  ──chrome.commands──▶  src/background/handler.ts
content.ts     ──imports──▶  src/{history,pageContext,system,ui/messages,ui/state}.ts
content.ts     ──lazy import on first toggle──▶  @huggingface/transformers
                                              ──▶  vendor/prompt-api-polyfill/
```

- `content.ts` is a single flat IIFE entry point (294 lines). It mixes DOM
  construction, drag-and-drop, session lifecycle, streaming, and history
  persistence in one file. The `src/` modules under it are pure and fully tested.
- `background.ts` is a 2-line ESM service worker entry that delegates to
  `src/background/handler.ts`.
- **MV3 constraint:** content scripts cannot be ESM; `content.ts` must compile to
  IIFE (`format: 'iife'` in `build.mjs`).
- **CSP constraint:** MV3 content scripts may not fetch remote scripts at
  runtime. ORT wasm files are copied to `dist/ort/` at build time and served via
  `chrome.runtime.getURL`.

### Testing Stack

- **Runner:** Vitest 2 + jsdom
- **Setup file:** `tests/setup.ts` — installs a `chrome` global with
  `FakeStorageArea`, spy mocks for `tabs`, `runtime`, `commands`
- **Coverage provider:** v8
- **Coverage scope:** `src/**/*.ts` only (entry points excluded today; Phase-3
  will extend this to `src/session.ts` after extraction)
- **Coverage thresholds:** lines/statements/functions 75%, branches 70%
- **Current state:** 27 tests across 6 files, 100% on `src/`

### Commit Format

All commits in this remediation must use [Conventional Commits](https://www.conventionalcommits.org/):

```text
type(scope): brief description

- Detail 1
- Detail 2
```

Allowed types: `fix`, `feat`, `refactor`, `test`, `chore`, `docs`, `ci`

Allowed scopes (examples): `content`, `session`, `history`, `build`, `ci`, `docs`

One logical change per commit. Do not batch unrelated changes.

## Stale Findings (Do Not Re-Do)

The following findings from the intake docs are already resolved in the current
tree and must not be worked again:

| Finding | Status |
|---------|--------|
| `.github/workflows/ci.yml` missing | Already exists: typecheck → coverage → build |
| `well_done.jpg` missing from `.gitignore` | Intentionally tracked as README hero — leave as-is |
| License badge missing from README | Apache-2.0 badge already in README |
| `tsconfig.json` had `strict: true` | Confirmed `strict: false` in live tree — this IS a finding, not resolved |

## Pillar Ceiling Notes

The user selected "None — require 9/10 on all 12 pillars" during intake.
However, two pillars have realistic ceilings below 9 that implementers and
reviewers must be aware of:

**Git Hygiene (currently 3/10):** The existing 3-commit mega-commit history is
immutable. From this remediation forward, every commit must be atomic and
descriptive (this plan enforces that). Documenting architectural decisions in
`docs/architecture.md` as an ADR section substitutes partially for the invisible
history. Reviewers should accept Git Hygiene at 7/10 if all future commits
follow the convention; 9/10 is not achievable without rewriting history, which
is out of scope.

**Creativity (currently 8/10):** The two genuinely creative solutions already in
the codebase (right-anchor → left-anchor conversion, MV3 wasm bundling) bring
this to 8. Pushing to 9 would require contrived additions inconsistent with YAGNI.
Reviewers should accept Creativity at 8/10.

## Phase Sequencing Rationale

| Phase | Tag | Scope | Primary Findings |
|-------|-----|-------|-----------------|
| 1 | HYGIENIST | Cleanup: noise, lint, IDE artifacts, ort dependency declaration | M1, M6, H4, L1, L3 |
| 2 | IMPLEMENTER | Quick-win fixes: strict mode, reader lock, persist catch, history cap, double-cast | H5, H6, M4, M5 (L1 cast from H5 scope) |
| 3 | IMPLEMENTER | Session extraction: `content.ts` decomp → `src/session.ts` | H1, H2, H3, M2, M3, M7 |
| 4 | IMPLEMENTER | Tests for extracted session module | Test Value pillar |
| 5 | FORTIFIER | Lint + formatter enforcement in CI; Node pin; shared message type | Reproducibility, Code Quality |
| 6 | DOC-ENGINEER | Documentation drift fixes + prevention tooling in CI | D1–D5, G1–G4, S1–S3, C1 |

## Testing Strategy

- Every `src/` module must maintain 100% coverage.
- New `src/session.ts` module must have a `tests/session.test.ts` covering the
  four scenarios listed in eval.md.
- After Phase-3, coverage `include` in `vitest.config.ts` stays as `src/**/*.ts`
  (session.ts is under src/, so it is automatically included).
- Branch threshold raised from 70% → 80% once `src/session.ts` is in place
  (Phase-4 task).
- Integration tests are explicitly out of scope per `docs/testing.md` policy.

## Dependency Pinning Notes

- `onnxruntime-web` is resolved transitively via `@huggingface/transformers`;
  `package-lock.json` pins it at `1.26.0-dev.20260416-b7804b056c` (pre-release).
- Phase-1 adds `onnxruntime-web` as an explicit `devDependency` to declare the
  build-time dependency; it does not bump the resolved version.
- npm vulnerability audit shows 6 moderate in devDependencies (esbuild cascade).
  `npm audit fix --force` would require a breaking esbuild bump to 0.28.0, which
  changes the build tool API. This is deferred; the risk is dev-only and low.

## Color Token Consolidation

`#0a5fa3` appears in three files: `src/ui/messages.ts:19`, `content.ts:104`,
`src/ui/state.ts:2`. Phase-3 (content.ts decomp) is the natural time to
deduplicate it into `src/ui/state.ts` (which already exports `IDLE_BG`) and
import from there. This is captured as a task in Phase-3.

## Message Protocol Type Safety

`content.ts:200` checks `m.a !== 'toggle'` using a raw string literal.
`src/background/handler.ts:2` exports `TOGGLE_MESSAGE = { a: 'toggle' }`.
Phase-3 moves the message handler inside the extracted session module scope
and imports `TOGGLE_MESSAGE` to remove the duplicate literal.
