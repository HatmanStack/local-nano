# Feedback Log

## Active Feedback

## Verification Report — 2026-05-17

### Health Audit Findings

- **H1**: VERIFIED — `src/session.ts:144` sets `heavyLoadPromise = null` inside the `catch` block of `ensureSession`, enabling retry after failed model creation.
- **H2**: VERIFIED — `src/session.ts:118` sets `i.disabled = true` at the start of `ensureSession`; lines 137 and 145 re-enable it on success and failure respectively, preventing message drops while the model loads.
- **H3**: VERIFIED — `content.ts` is now 122 lines (down from 295). All session orchestration lives in `src/session.ts` (250 lines). `content.ts` contains only UI construction, drag handling, and a single `initSession()` call.
- **H4**: VERIFIED — `package.json:22` has `"onnxruntime-web": "1.26.0-dev.20260416-b7804b056c"` in `devDependencies` with a pinned pre-release version.
- **H5**: VERIFIED — `tsconfig.json:7` has `"strict": true`. `npm run typecheck` exits 0.
- **H6**: VERIFIED — `src/session.ts:174-191` wraps `reader.read()` in an inner try/finally with `reader.releaseLock()` in the finally clause. The outer try/catch handles AbortError and other errors, but `releaseLock()` always runs.
- **M1**: VERIFIED — No `JSON.stringify` calls appear in `src/session.ts` or `content.ts`. The per-chunk `console.log` is gone. Remaining `console.log` calls are one-time events: module load, stream done timing, first-token timing.
- **M3**: PARTIALLY VERIFIED — Module-scope `s` variable is gone (replaced by `session` inside the `initSession` closure in `src/session.ts:103`). The `i` alias remains at `src/session.ts:48` as a destructuring alias (`input: i`) and is used consistently throughout the function. The original finding required `i` in `content.ts` to be renamed; `content.ts` no longer has `i` at all — the variable is `input` in the `content.ts` DOM construction (line 67) and passed as `input` to `initSession`. The internal alias `i` inside `initSession` is a local shorthand accepted by the plan. VERIFIED for the original `content.ts:95,163` scope.
- **M4**: VERIFIED — `src/history.ts:14` exports `export const MAX_HISTORY = 200;`. `saveHistory` at lines 16-18 slices to the last `MAX_HISTORY` entries before writing.
- **M5**: VERIFIED — `src/session.ts:83` has `saveHistoryToStorage(...).catch((err: unknown) => { console.error(...) })`, making persist failures observable.
- **M6**: VERIFIED — `.gitignore` contains `.vscode/`, `.idea/` (under `# IDE`) and `.DS_Store`, `Thumbs.db` (under `# OS`).

### Eval Pillar Remediation

- **Defensiveness** (was 5): VERIFIED — H1 (`heavyLoadPromise = null` on failure), H2 (`input.disabled` during load), H6 (`reader.releaseLock()` in finally), M4 (history cap), M5 (persist `.catch()`) — all four critical failure points addressed.
- **Type Rigor** (was 5): VERIFIED — `"strict": true` in `tsconfig.json`; `LanguageModelSession` interface defined at `src/session.ts:6-9`; `SessionDeps` interface at `src/session.ts:33-41`. No double-cast in `src/history.ts` (the `as unknown as Promise<void>` pattern is absent — `saveHistory` returns `Promise<void>` directly). Casts in `src/session.ts` are justified polyfill boundaries with typed interfaces.
- **Performance** (was 6): VERIFIED — Per-chunk `console.log` removed. Stream timing logs (done, first token) fire once per generation, not per chunk. Scroll update on `messages.scrollTop = messages.scrollHeight` still runs per chunk (unchanged from original; not a blocker per plan).
- **Test Value** (was 7): VERIFIED — `tests/session.test.ts` exists with 22 tests covering concurrency guard, activeAbort skip, AbortError `[stopped]`, isFirstTurn page context prefix, releaseLock on error, MAX_HISTORY enforcement, and more. `vitest.config.ts:14-19` has thresholds raised: `lines: 75`, `statements: 75`, `functions: 75`, `branches: 80` (branch threshold raised from 70 to 80).
- **Code Quality** (was 7): VERIFIED — Per-chunk log removed; `ToggleMessage` type exported from `src/background/handler.ts:3`; `session.ts:231` uses `TOGGLE_MESSAGE.a` instead of a raw string. Color token `#0a5fa3` is still duplicated across `src/ui/state.ts:2` (as `IDLE_BG`) and `src/ui/messages.ts:21` — the `IDLE_BG` constant was not imported into `messages.ts`; however this was a LOW-priority item and the plan did not mandate it as a blocking requirement.
- **Reproducibility** (was 8): VERIFIED — `.nvmrc` exists with `20`; `biome.json` configured (Biome 2.4.15); `package.json` has `lint` and `lint:ci` scripts; CI `ci.yml` has a `Lint` step running before typecheck.

### Doc Audit Findings

- **D1**: VERIFIED — `docs/prompt-api.md:82` ("When native lands" section) accurately describes conditional install guard and explains the extension bypasses it by importing `LanguageModel` from the module directly. `docs/models.md` updated to match.
- **D2**: VERIFIED — `docs/configuration.md:14` JSON block now shows `"modelName": "onnx-community/gemma-4-E2B-it-ONNX"`, matching `.env.example.json`.
- **D3**: VERIFIED — `docs/models.md` "Thinking…" indicator claim is gone; replaced with accurate description of the three-dot animation and loading progress indicator.
- **D4**: VERIFIED — `docs/privacy.md:28` permissions table has a row for `host_permissions for huggingface.co and *.huggingface.co`, matching `manifest.json`'s wildcard entry.
- **D5**: VERIFIED — `manifest.json:4` now reads `"version": "0.1.0"`, aligned with `package.json:3`.
- **G1**: VERIFIED — `docs/contributing.md` has a "Dependency updates" section documenting `dependabot-auto-merge.yml` and its auto-squash-merge behavior.
- **G2**: VERIFIED — `docs/configuration.md` has a "Default fallback layer" section documenting `backends/defaults.js` and `DEFAULT_MODELS.transformers`.
- **G3**: VERIFIED — `docs/prompt-api.md:29-55` has a complete 7-step "Resync procedure" with curl commands, each edit to carry forward, and a build smoke-test instruction.
- **G4**: VERIFIED — `vendor/prompt-api-polyfill/prompt-api-polyfill.js:7-13` header now lists only Transformers.js as the supported backend and explicitly notes the removed backends in a NOTE comment.
- **C1**: VERIFIED — `docs/configuration.md:63` now reads "it is a **reference template only** and is not read at runtime."
- **S1**: VERIFIED — `README.md:14-23` nav bar contains all 8 doc links including Development, Prompt API, Testing, Contributing.
- **S2**: VERIFIED — `README.md:32` polyfill link points to `https://github.com/GoogleChromeLabs/web-ai-demos/tree/main/prompt-api-polyfill`.
- **S3**: VERIFIED — `docs/contributing.md:11` note clarifies that `coverage` implicitly runs `npm test`.

### Test Suite

- Tests: 53/53 passing (8 test files)
- Typecheck: exit 0
- Lint: exit 0 — "Checked 28 files in 38ms. No fixes applied."
- Build: exit 0 — `dist/content.js` and `dist/background.js` generated
- Markdownlint: exit 0 — 10 files, 0 errors

### Notes

One minor observation not blocking verification: the `#0a5fa3` blue color token still appears in both `src/ui/state.ts` (as `IDLE_BG`) and `src/ui/messages.ts:21` (inline). The `messages.ts` file does not import `IDLE_BG`. This was a LOW-priority item ("deduplicate color token") in the eval remediation plan and the plan did not list it as a phase deliverable, so it does not affect the verdict.

VERIFIED

## Doc Review - Phase 6

### Verification Summary

- Content fixes: All D1-D5, G1-G4, C1, S1-S3 verified against source code — every fix is accurate and present
- Prevention tools: `.markdownlint.json` (MD013/MD033/MD041/MD060 disabled), `.markdownlintignore` (docs/plans/, node_modules/, vendor/, coverage/), `.lychee.toml` (HuggingFace exclusions, cache, timeout), CI `Markdown lint` step, CI `Check links` step — all present and correct
- Tests: 53/53 passing (8 test files); `tests/docs-config.test.ts` exists, uses `process.cwd()` (no bare `__dirname`), cross-references `.env.example.json` `modelName` against `docs/configuration.md`; coverage 94.44% branches (threshold 80% — passes with margin)
- Build/lint: `markdownlint-cli2` exits 0, `npm run typecheck` exits 0, `npm run lint:ci` exits 0, `npm run build` exits 0
- Commits: 8 atomic conventional commits — `docs:` (x3), `ci:` (x2), `test(docs):`, `chore(lint):`, `chore(docs):` — all match Phase-6 commit message templates

### Content Fixes Verified

**D1** `docs/prompt-api.md:82` — "When native lands" section now reads: "The polyfill's install guard skips globalThis assignment when a native `LanguageModel` is already present. This extension bypasses that guard entirely — `content.ts` imports and uses the module-exported `LanguageModel` directly..." Accurate: `src/session.ts:59-73` imports from `./vendor/prompt-api-polyfill/prompt-api-polyfill.js` and extracts `LanguageModel` from the module export. `docs/models.md:108` now reads: "The polyfill's install guard would skip installation if native `LanguageModel` were present. This extension bypasses the guard by importing `LanguageModel` from the polyfill module directly — see `src/session.ts` for the import." `src/session.ts` exists and is the correct reference.

**D2** `docs/configuration.md:14` shows `"modelName": "onnx-community/gemma-4-E2B-it-ONNX"` in the JSON block. `.env.example.json` ships `"modelName": "onnx-community/gemma-4-E2B-it-ONNX"`. Model list at line 28 labels gemma-4-E2B-it-ONNX as "the default." Match confirmed.

**D3** `docs/models.md:29` now reads: "The panel shows a three-dot animation while generating and `Loading model… NN%` during weight download." No "Thinking…" present anywhere in the file.

**D4** `docs/privacy.md:28-29` now has two separate rows: `host_permissions for huggingface.co and *.huggingface.co` and `host_permissions for cdn-lfs.huggingface.co`. `manifest.json` declares both `https://huggingface.co/*` and `https://*.huggingface.co/*` and `https://cdn-lfs.huggingface.co/*` — table now matches.

**D5** `manifest.json:3` reads `"version": "0.1.0"`. `package.json:3` reads `"version": "0.1.0"`. Aligned.

**G1** `docs/contributing.md:52-57` has "Dependency updates" section describing `dependabot-auto-merge.yml`, auto-squash-merge behavior, and major bump exception.

**G2** `docs/configuration.md:65-73` has "Default fallback layer" section describing `backends/defaults.js`, the `DEFAULT_MODELS.transformers` fallback, and the fields it supplies.

**G3** `docs/prompt-api.md:29-55` has a complete "Resync procedure" section with all 7 steps including curl commands, header comment check, iframe-injection block removal, `max_new_tokens` verification, backends-registry check, and build smoke-test.

**G4** `vendor/prompt-api-polyfill/prompt-api-polyfill.js:7-13` header now reads "Supported backends (in this vendored copy): - Transformers.js" with a NOTE listing the removed backends. Accurate.

**C1** `docs/configuration.md:63` now reads: "see `vendor/prompt-api-polyfill/dot_env.json` — it is a **reference template only** and is not read at runtime. All live configuration comes from your `.env.json`."

**S1** `README.md:14-23` nav bar contains all 8 links: Architecture, Configuration, Models, Privacy, Development, Prompt API, Testing, Contributing.

**S2** `README.md:32` polyfill link now points to `https://github.com/GoogleChromeLabs/web-ai-demos/tree/main/prompt-api-polyfill`. Correct.

**S3** `docs/contributing.md:11` note before the bash block: "The `coverage` command runs the full test suite (implicitly `npm test`) and then enforces the coverage thresholds from `vitest.config.ts`. You do not need to run `npm test` separately."

### Prevention Tools Verified

- `.markdownlint.json` present with `MD013`, `MD033`, `MD041`, `MD060` disabled; additional `MD060` disable is correct (fenced code language tag rule — pre-existing violations were cleaned up)
- `.markdownlintignore` present, excludes `docs/plans/`, `node_modules/`, `vendor/`, `coverage/`
- CI `Markdown lint` step runs `npx --yes markdownlint-cli2 "docs/*.md" "README.md" "CHANGELOG.md"` — matches the review checklist's specified scope
- `.lychee.toml` present with HuggingFace exclusions, cache configuration, and timeout
- CI `Check links` step uses `lycheeverse/lychee-action@v2` with `.lychee.toml` config
- `tests/docs-config.test.ts` exists; uses `process.cwd()` (not bare `__dirname`) — valid Node-20-ESM-safe approach; Vitest sets cwd to project root; test passes

PHASE_APPROVED

## Code Review - Phase 4

### Verification Summary

- Tests: 52 passing (22 new in `tests/session.test.ts`, 30 existing across 6 files)
- Build: exit 0 — `dist/content.js` and `dist/background.js` generated
- Typecheck: exit 0
- Coverage: 94.44% branches overall; `src/session.ts` at 91.48% branches — threshold 80% passes with margin
- Commits: 2 atomic conventional commits (`test(session):` + `docs(testing):`)
- Spec: all Phase-4 tasks complete; checkboxes marked `[x]` in Phase-4.md

### Checklist Results

**Spec Compliance**

1. `tests/session.test.ts` exists with 22 tests (requirement: ≥ 15)
1. All four eval.md scenarios covered: concurrency guard, activeAbort skip, AbortError `[stopped]`, isFirstTurn page context
1. `vitest.config.ts` no longer excludes `src/session.ts` — the temporary exclude added in a prior commit was removed
1. Branch threshold raised 70 → 80 in `vitest.config.ts`
1. `docs/testing.md` updated: `tests/session.test.ts` row added, branches threshold updated to 80%

**Tests Pass and Are Meaningful**

All 52 tests pass. Spot-checked assertions confirm real behavior coverage:

- `prefixes pageContext on isFirstTurn only` checks the first `promptStreaming` call arg contains `Page: Test Page` and the second call arg is exactly `'follow-up'` with no `Page:` prefix — genuine behavior test
- `does not call LanguageModel.create twice under concurrent ensureSession calls` triggers toggle twice synchronously before any await and asserts `mockLanguageModelCreate` called exactly once — genuine concurrency guard test
- `appends [stopped] on AbortError` injects a stream reader that rejects with an AbortError and asserts the response element `textContent` contains `[stopped]` — genuine abort-path test
- No placeholder tests found

**DOMException Workaround**

Production code at `src/session.ts:191` checks `err instanceof Error && err.name === 'AbortError'` — no `instanceof DOMException`. This is the correct pattern. The test workaround (`Object.assign(new Error('Aborted'), { name: 'AbortError' })`) matches exactly what the production check inspects and is documented inline at `tests/session.test.ts:300-301`. In real Chrome, `AbortController` rejects with a `DOMException` that passes `instanceof Error` and has `.name === 'AbortError'`, so the test faithfully exercises the same code path.

**Build / Typecheck:** both exit 0

**Commit Quality:** two atomic conventional commits; body bullet points describe what each covers

**Code Quality:** no `console.log`, `TODO`, or `FIXME` in test files; no `src/` files modified in Phase-4 commits (only `tests/session.test.ts`, `vitest.config.ts`, `docs/testing.md`)

PHASE_APPROVED

## Health Review - Phase 5

### Verification Summary

- Configs: `biome.json` present, valid JSON, Biome 2.4.15 installed; `.nvmrc` contains `20`; `package.json` has `lint` and `lint:ci` scripts
- Lint: `npm run lint:ci` exits 0 — "Checked 26 files in 30ms. No fixes applied."
- CI: `.github/workflows/ci.yml` has `Lint` step running `npm run lint:ci` in exact spec order — Install → Provision → Lint → Typecheck → Coverage → Build → Upload
- Tests: 52/52 pass; 94.44% branches overall; `src/session.ts` at 91.48% branches; threshold 80% met with margin; `npm run typecheck` exits 0; `npm run build` exits 0
- Commits: 4 atomic conventional commits — `chore(lint):`, `ci:`, `chore(dev):`, `refactor(handler):` — each covers exactly one task; commit bodies match Phase-5 templates
- Spec: all Phase-5 checkboxes marked `[x]`; all 4 tasks landed

### Checklist Results

**Config Validity**

1. `biome.json` is present at repo root, parses cleanly, Biome 2.4.15 confirmed via `npx biome --version`
1. `npm run lint:ci` exits 0
1. `.github/workflows/ci.yml` YAML is syntactically valid (read and confirmed)
1. `.nvmrc` exists, contains `20`
1. `package.json` scripts include `lint` (`biome check --write .`) and `lint:ci` (`biome check .`)

**Guardrail Effectiveness**

1. Lint step in CI is at the correct position: between `Provision .env.json` and `Typecheck`
1. `ToggleMessage` type exported from `src/background/handler.ts:3`
1. `src/session.ts:231` uses `m.a !== TOGGLE_MESSAGE.a` — no raw `'toggle'` string; only canonical definition at `src/background/handler.ts:2` remains

**No False Positives**

1. `npm test`: 52/52 pass; no regressions
1. `npm run coverage`: branches 94.44% — exceeds 80% threshold
1. `npm run typecheck`: exits 0
1. `npm run build`: exits 0

**Biome v2 Config Adjustment (spec'd 1.9.0, resolved 2.4.15)**

The v2 API changes are sound:
- `organizeImports.enabled: true` (v1) → `assist.actions.source.organizeImports: "on"` (v2): import sorting is still enforced; the feature moved from a top-level key to `assist.actions.source` in v2
- `files.ignore` (v1 array of globs) → `files.includes` with negated patterns (v2): `["**", "!dist", "!coverage", "!node_modules", "!vendor", "!.claude"]` achieves the same exclusions; `.claude/` exclusion is an additive improvement
- All lint rules (`recommended`, `noExplicitAny: "off"`, `noNonNullAssertion: "warn"`), formatter settings (2-space, single quotes, 100-char, trailing commas, always semicolons), and `javascript.formatter` block are identical to the Phase-5 spec — no semantic drift
- Biome v2 confirmed `noExplicitAny` rule exists with the same name (`npx biome explain noExplicitAny` returns valid output)
- The `$schema` correctly references the 2.4.15 schema URL

**Commit Quality**

1. `abcb71b chore(lint): add Biome linter and formatter` — Biome install, config, auto-fix pass; 17 files touched (expected: config + all linted sources)
1. `b17f47f ci: add Biome lint step before typecheck` — single file `.github/workflows/ci.yml`, 3 lines added
1. `4dd17de chore(dev): add .nvmrc pinning Node 20` — single file `.nvmrc`, 1 line added
1. `5efa0f8 refactor(handler): export ToggleMessage type for protocol type safety` — single file `src/background/handler.ts`, 1 line added
1. All four match Phase-5 commit message templates exactly

PHASE_APPROVED

## Resolved Feedback

### PLAN_REVIEW - Iteration 1 - Phase 6, Task 6.6

> **Consider:** Does vitest 2 with `jsdom` and `"type": "module"` in `package.json` provide `__dirname`?
> **Think about:** The test file shown in Task 6.6 uses `resolve(__dirname, '../docs/configuration.md')`. Since this project uses `"type": "module"`, test files are treated as ESM. In ESM modules, `__dirname` is not defined — it is a CommonJS-only global. On Node 20, `import.meta.dirname` is not yet available either (that was added in Node 21.2). The correct Node 20 ESM pattern requires `fileURLToPath(new URL('.', import.meta.url))` to reconstruct `__dirname`.
> **Reflect:** Without this fix, `tests/docs-config.test.ts` will throw `ReferenceError: __dirname is not defined` the first time it runs, causing the entire test suite to fail. The test cannot pass in the current environment — it must be corrected before Phase 6 can complete. Update the test to use: `import { fileURLToPath } from 'node:url'; const __dir = fileURLToPath(new URL('.', import.meta.url));` then `resolve(__dir, '../docs/configuration.md')`.

**Status:** RESOLVED

**Resolution:** Rewrote the `tests/docs-config.test.ts` template in Phase-6.md Task 6.6.
Added `import { fileURLToPath } from 'node:url';` and replaced `resolve(__dirname, ...)` with
`const __dir = fileURLToPath(new URL('.', import.meta.url)); resolve(__dir, ...)`.
Added an explanatory note in the task explaining why `__dirname` is unavailable on Node 20 ESM.

---

### PLAN_REVIEW - Iteration 1 - Phase 3, Task 3.2

> **Consider:** An implementer reads Step 2 in full, writes the complete `initSession` closure from the provided code block (which calls `i.closest<HTMLElement>('.ln-root')` at line 334 and defines `SessionDeps` without a `root` field), and then reaches Step 3 which says "Actually, passing `root` directly is cleaner — update the approach, remove the `closest` call." How certain is an engineer under time pressure that the Step 2 code block is a superseded draft rather than working code?
> **Think about:** The Step 2 code block is long (the entire `initSession` implementation) and contains the `closest()` call that Step 3 explicitly replaces. The first `SessionDeps` definition in Step 1 also lacks `root`. An implementer who implements Step 2 first then applies Step 3 as a delta must know to delete the `closest()` line from the Step 2 body — but Step 3 only says "remove the `closest` call" without pointing at the specific line number in the Step 2 block. Additionally, the `initSession` call example in Step 4 still shows `input: i,` even though the preceding prose says to rename `i` to `input` in `content.ts` (addressing M3) — a renamed variable would appear as just `input,` in shorthand property syntax.
> **Reflect:** Rewrite Task 3.2 so Step 2's code block already uses `deps.root` (not `closest()`), and the first `SessionDeps` definition already includes `root: HTMLElement`. This eliminates the mid-task pivot and makes the code blocks copy-pasteable without requiring mental reconciliation across steps. Also update Step 4's `initSession` call example to match the intended rename: replace `input: i,` with `input,` to be consistent with the M3 rename instruction.

**Status:** RESOLVED

**Resolution:** Three targeted edits to Phase-3.md Task 3.2:

1. `SessionDeps` in Step 1 now includes `root: HTMLElement` from the start — no later
   addition required.
2. Step 2's `initSession` destructuring line now reads `const { root, messages, input: i, ... } = deps;`
   and the toggle listener block no longer contains `const root = i.closest<HTMLElement>('.ln-root');` —
   `root` comes directly from the closure. The code block is copy-pasteable as-is.
3. The mid-task pivot block ("Important notes on the toggle listener approach" + "Step 3: Update
   `SessionDeps` to include `root`") was removed entirely; the old Step 4 is renumbered Step 3.
4. The `initSession(...)` call example in the updated Step 3 now uses shorthand `input,` consistent
   with the M3 rename of `i` → `input` in `content.ts`.
