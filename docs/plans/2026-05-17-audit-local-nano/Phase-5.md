# Phase 5 — [FORTIFIER] Lint, Formatter, Node Pin, Shared Message Type

## Phase Goal

Add Biome as the project linter and formatter, enforce it in CI, pin the Node
version via `.nvmrc`, and share the message protocol type so the raw string
`'toggle'` is no longer duplicated. These changes harden the process layer to
prevent future quality regressions.

**Success criteria:**

- `biome.json` is present and configured
- `npm run lint` runs Biome lint + format check and passes
- CI (`.github/workflows/ci.yml`) runs lint before typecheck
- `.nvmrc` is present and contains `20`
- All existing tests still pass; `npm run coverage` passes

**Token estimate:** ~10k tokens

## Prerequisites

- Phase-4 complete and committed
- All tests passing (≥ 45)
- `strict: true` already enabled (Phase-2)

## Task 5.1 — Add Biome for Lint and Format

**Goal:** Install Biome as the single linter + formatter, configure it for this
project's conventions, add `lint` and `format` scripts, and fix any lint
violations that Biome surfaces (eval.md Reproducibility 8→9 target).

Biome is chosen over ESLint + Prettier because it is a single package with
zero transitive dependencies, a faster runner, and simpler configuration —
consistent with the YAGNI principle for a small extension project.

**Files:**

- `package.json`
- `biome.json` (new file)
- `src/` and `content.ts` (fix any lint violations)

**Prerequisites:** None

**Implementation Steps:**

1. Install Biome as a dev dependency:

   ```bash
   npm install --save-dev @biomejs/biome
   ```

1. Initialize Biome configuration:

   ```bash
   npx biome init
   ```

   This creates `biome.json`. Open it and replace its contents with the
   following project-specific configuration:

   ```json
   {
     "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
     "organizeImports": { "enabled": true },
     "linter": {
       "enabled": true,
       "rules": {
         "recommended": true,
         "suspicious": {
           "noExplicitAny": "off"
         },
         "style": {
           "noNonNullAssertion": "warn"
         }
       }
     },
     "formatter": {
       "enabled": true,
       "indentStyle": "space",
       "indentWidth": 2,
       "lineWidth": 100
     },
     "javascript": {
       "formatter": {
         "quoteStyle": "single",
         "trailingCommas": "all",
         "semicolons": "always"
       }
     },
     "files": {
       "ignore": [
         "dist/**",
         "coverage/**",
         "node_modules/**",
         "vendor/**"
       ]
     }
   }
   ```

   Key decisions:
   - `noExplicitAny: "off"` — the polyfill boundary requires intentional `any`
     casts documented in Phase-2; linting them as errors would be noise.
   - `vendor/**` excluded — vendored code is not ours to lint.
   - Single quotes, 2-space indent, 100-char line width match the existing
     codebase style.

1. Add scripts to `package.json`:

   ```json
   "lint": "biome check --write .",
   "lint:ci": "biome check ."
   ```

   `lint` applies auto-fixes (safe for local dev). `lint:ci` is read-only and
   fails on any violation (for CI).

1. Run `npm run lint` to apply auto-formatting and fix lint violations:

   ```bash
   npm run lint
   ```

   Review the diff. Accept all whitespace/quote/semicolon changes. For any
   logic-affecting suggestions, evaluate individually — Biome's recommended
   rules are generally safe. Common auto-fixable findings you will see:
   - Trailing commas added/removed
   - Quote style normalization
   - Import ordering

1. After `npm run lint` succeeds, run the full check suite to confirm nothing
   broke:

   ```bash
   npm run typecheck
   npm run coverage
   npm run build
   ```

**Verification Checklist:**

- [x] `biome.json` exists at repo root
- [x] `package.json` has `lint` and `lint:ci` scripts
- [x] `npm run lint:ci` exits 0
- [x] `npm run typecheck` exits 0
- [x] `npm run coverage` exits 0 (all tests pass)
- [x] `npm run build` exits 0

**Testing Instructions:**

```bash
npm run lint:ci
npm run typecheck
npm run coverage
npm run build
```

**Commit Message Template:**

```text
chore(lint): add Biome linter and formatter

- Single-package replacement for ESLint + Prettier
- Configured for 2-space indent, single quotes, 100-char line width
- vendor/ and dist/ excluded from linting
- noExplicitAny disabled (intentional any at polyfill boundary)
- Added lint and lint:ci scripts; lint:ci will be used in CI
```

---

## Task 5.2 — Add Lint Step to CI

**Goal:** Run `npm run lint:ci` in the CI pipeline before `typecheck` so that
formatting and lint violations fail the build before slower checks run
(eval.md Reproducibility target).

**Files:**

- `.github/workflows/ci.yml`

**Prerequisites:** Task 5.1 complete

**Implementation Steps:**

1. Open `.github/workflows/ci.yml`.

1. Find the `steps` block. Add a `Lint` step between `Provision .env.json` and
   `Typecheck`:

   ```yaml
   - name: Lint
     run: npm run lint:ci
   ```

   The full steps sequence should become:

   ```text
   - Install
   - Provision .env.json
   - Lint          <-- new
   - Typecheck
   - Test (with coverage)
   - Build
   - Upload coverage report
   ```

**Verification Checklist:**

- [x] `.github/workflows/ci.yml` has a `Lint` step before `Typecheck`
- [x] The `Lint` step runs `npm run lint:ci`
- [x] CI step order is: Install → Provision → Lint → Typecheck → Coverage → Build

**Testing Instructions:**

Run locally to simulate CI:

```bash
npm run lint:ci && npm run typecheck && npm run coverage && npm run build
```

**Commit Message Template:**

```text
ci: add Biome lint step before typecheck

- Lint failures now fail the build before spending time on typecheck/coverage
- Uses lint:ci (read-only) not lint (auto-fix) in CI context
```

---

## Task 5.3 — Pin Node Version via `.nvmrc`

**Goal:** Add `.nvmrc` with `20` to declare the required Node version for local
development (eval.md Reproducibility target). CI already pins Node 20 via
`actions/setup-node`; this aligns local development.

**Files:**

- `.nvmrc` (new file)

**Prerequisites:** None (independent task)

**Implementation Steps:**

1. Create `.nvmrc` at the repo root with the single line:

   ```text
   20
   ```

1. Verify `node --version` on your machine is v20.x; if not, run
   `nvm use` to switch.

**Verification Checklist:**

- [x] `.nvmrc` exists at repo root containing `20`
- [x] `cat .nvmrc` outputs `20`

**Testing Instructions:**

```bash
node --version  # should be v20.x
```

**Commit Message Template:**

```text
chore(dev): add .nvmrc pinning Node 20

- Aligns local development with CI node-version: 20
- nvm users can run `nvm use` at the repo root to switch automatically
```

---

## Task 5.4 — Share Message Protocol Type

**Goal:** The toggle check in `src/session.ts` already uses `TOGGLE_MESSAGE.a`
imported from `src/background/handler.ts` (fixed in Phase-3). Verify this is
correct and no raw `'toggle'` string remains in `content.ts` or `src/session.ts`.
If Phase-3 left any raw string, fix it here.

Additionally, add a `type ToggleMessage = typeof TOGGLE_MESSAGE` export to
`src/background/handler.ts` so callers can use the type without importing the
value if needed.

**Files:**

- `src/background/handler.ts`
- `src/session.ts` (verify, no change expected if Phase-3 was done correctly)

**Prerequisites:** Phase-3 complete

**Implementation Steps:**

1. Open `src/background/handler.ts`. Add a type export after `TOGGLE_MESSAGE`:

   ```ts
   export type ToggleMessage = typeof TOGGLE_MESSAGE;
   ```

1. Open `src/session.ts`. Confirm the `onMessage` listener check reads:

   ```ts
   if (m.a !== TOGGLE_MESSAGE.a) return;
   ```

   If it still reads `m.a !== 'toggle'`, fix it now.

1. Open `content.ts`. Confirm there is no `m.a !== 'toggle'` raw string check
   (it was removed in Phase-3 when the listener moved to `session.ts`).

1. Run `npm run typecheck` to confirm the type export is valid.

**Verification Checklist:**

- [x] `src/background/handler.ts` exports `type ToggleMessage`
- [x] `src/session.ts` uses `TOGGLE_MESSAGE.a` not the raw string `'toggle'`
- [x] `content.ts` contains no raw string toggle check
- [x] `npm run typecheck` passes
- [x] `npm run lint:ci` passes

**Testing Instructions:**

```bash
npm run typecheck
npm run lint:ci
npm test
```

**Commit Message Template:**

```text
refactor(handler): export ToggleMessage type for protocol type safety

- Added type ToggleMessage = typeof TOGGLE_MESSAGE export
- Confirmed session.ts uses TOGGLE_MESSAGE.a (no raw string literal)
- Message protocol is now type-shared across the background/content boundary
```

---

## Phase Verification

After all tasks are committed:

```bash
npm run lint:ci
npm run typecheck
npm run coverage
npm run build
```

All four must exit 0. Confirm:

- `biome.json` exists
- `.nvmrc` contains `20`
- `.github/workflows/ci.yml` has Lint step
- `src/background/handler.ts` exports `ToggleMessage` type
- All tests pass (≥ 45)
- Coverage thresholds met (branches 80%)
