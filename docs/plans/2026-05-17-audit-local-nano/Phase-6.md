# Phase 6 — [DOC-ENGINEER] Documentation Drift Fixes and Prevention Tooling

## Phase Goal

Fix all five drift findings, four gap findings, one config drift finding, and
three structure findings from the doc-audit. Add markdownlint and lychee to CI
for ongoing prevention. Add a Vitest test that cross-references the default model
in `.env.example.json` against `docs/configuration.md`.

**Success criteria:**

- All D1–D5 drift findings corrected
- All G1–G4 gap findings addressed
- C1 config drift corrected
- All S1–S3 structure findings corrected
- `markdownlint-cli2` runs in CI with zero violations
- Lychee runs in CI with zero broken links
- A Vitest test asserts `.env.example.json` `modelName` matches
  `docs/configuration.md`
- All existing tests still pass

**Token estimate:** ~16k tokens

## Prerequisites

- Phase-5 complete and committed
- All code phases done (no more source changes expected)

## Task 6.1 — Fix Documentation Drift Findings (D1–D5)

**Goal:** Correct factual errors where docs disagree with the actual code.

**Files:**

- `docs/prompt-api.md` (D1)
- `docs/models.md` (D1, D3)
- `docs/configuration.md` (D2)
- `docs/privacy.md` (D4)
- `manifest.json` (D5)

**Prerequisites:** None

**Implementation Steps:**

### D1 — Polyfill installation behavior

The polyfill does NOT install over the native binding when both exist. It skips
installation when native `LanguageModel` is already present. The current code
path in `content.ts` (and `src/session.ts` after Phase-3) uses the module-exported
`LanguageModel` directly, bypassing the global entirely.

1. Open `docs/prompt-api.md`. Find the section "When native lands" which
   currently says (last paragraph before the code block at line ~52–54):
   `"The polyfill installs over the native binding when both exist, so today the extension behaves identically..."`

   Replace the sentence with:
   `"The polyfill's install guard skips globalThis assignment when a native \`LanguageModel\` is already present. This extension bypasses that guard entirely — \`content.ts\` imports and uses the module-exported \`LanguageModel\` directly, so behavior is identical on Chromebook Plus and on every other Chrome."`

1. Open `docs/models.md`. Find the last bullet point under "Failure modes worth
   recognizing" (line ~108):
   `"The polyfill installs over the native binding, but only if it actually loads — see [content.ts](../content.ts) for the unconditional polyfill import we use to bypass this."`

   Replace with:
   `"The polyfill's install guard would skip installation if native \`LanguageModel\` were present. This extension bypasses the guard by importing \`LanguageModel\` from the polyfill module directly — see [\`src/session.ts\`](../src/session.ts) for the import. The extension always uses the polyfill."`

### D2 — Default model name mismatch in docs/configuration.md

`docs/configuration.md` shows `"modelName": "onnx-community/Qwen3.5-0.8B-ONNX"`
as the default. The actual `.env.example.json` (and README) uses
`"onnx-community/gemma-4-E2B-it-ONNX"`.

1. Open `docs/configuration.md`. Find the JSON block under the opening
   description (~line 13) that shows:

   ```json
   {
     "apiKey": "dummy",
     "device": "webgpu",
     "dtype": "q4",
     "modelName": "onnx-community/Qwen3.5-0.8B-ONNX"
   }
   ```

   Change `"modelName": "onnx-community/Qwen3.5-0.8B-ONNX"` to
   `"modelName": "onnx-community/gemma-4-E2B-it-ONNX"`.

   Also update the `modelName` field description text just below (the three-
   bullet list of "practical picks"): move `Qwen3.5-0.8B-ONNX` from being
   labeled "the default" to being listed as the second option, and label
   `gemma-4-E2B-it-ONNX` as "the current default". The list should read:

   - `onnx-community/gemma-4-E2B-it-ONNX` — bigger, smarter; needs WebGPU (the default).
   - `onnx-community/Qwen3.5-0.8B-ONNX` — small, fast, decent for short answers; needs WebGPU.
   - `onnx-community/Qwen2.5-0.5B-Instruct` — proven safe pick when you're stuck on WASM.

### D3 — Claimed Thinking indicator does not exist

1. Open `docs/models.md`. Find line ~29:
   `"The \`Thinking…\` indicator exists for this."`

   Replace the sentence with:
   `"The panel shows a three-dot animation while generating and \`Loading model… NN%\` during weight download."`

### D4 — Missing wildcard host permission in privacy table

1. Open `docs/privacy.md`. Find the permissions table. The current entry reads:
   `| host_permissions for huggingface.co  | Download model weights. |`

   Split this into two rows:

   ```markdown
   | `host_permissions` for `huggingface.co` and `*.huggingface.co` | Download model weights from Hugging Face and its CDN subdomains. |
   | `host_permissions` for `cdn-lfs.huggingface.co` | Download large model files from Hugging Face's LFS CDN. |
   ```

   Also add the `cdn.jsdelivr.net` entry if it is missing (check the current
   table — it should already be there; if not, add it).

### D5 — Version string format mismatch

`manifest.json` uses `"version": "0.1"`. `package.json` and `CHANGELOG.md`
use `"0.1.0"`. The `release.yml` workflow extracts the version from
`CHANGELOG.md` and uses it for the git tag — so a tag `v0.1.0` would not
match the manifest `0.1`.

Note: Chrome Web Store requires the manifest version to be in
`major.minor.patch.build` format (1–4 integers). `"0.1.0"` is valid;
`"0.1"` is also valid but inconsistent with the semver convention used
everywhere else.

1. Open `manifest.json`. Change:

   ```json
   "version": "0.1",
   ```

   To:

   ```json
   "version": "0.1.0",
   ```

**Verification Checklist:**

- [x] `docs/prompt-api.md` no longer says polyfill "installs over" the native binding
- [x] `docs/models.md` no longer says polyfill "installs over" native binding
- [x] `docs/models.md` no longer mentions `Thinking…` indicator
- [x] `docs/configuration.md` shows `gemma-4-E2B-it-ONNX` as default in JSON block
- [x] `docs/configuration.md` model list labels `gemma-4-E2B-it-ONNX` as default
- [x] `docs/privacy.md` permissions table lists `*.huggingface.co` wildcard
- [x] `manifest.json` version is `"0.1.0"` (three-part semver)

**Testing Instructions:**

```bash
npm run build
# Confirm build still succeeds with the manifest version change
```

**Commit Message Template:**

```text
docs: fix D1-D5 drift findings from doc audit

- D1: corrected polyfill install guard description in prompt-api.md and models.md
  (polyfill skips globalThis when native exists; extension uses module export directly)
- D2: updated docs/configuration.md default modelName to gemma-4-E2B-it-ONNX
- D3: replaced fictional "Thinking…" indicator reference with actual dot animation description
- D4: added *.huggingface.co wildcard entry to privacy.md permissions table
- D5: aligned manifest.json version to 0.1.0 (three-part semver, matching package.json)
```

---

## Task 6.2 — Fix Gap Findings (G1–G4)

**Goal:** Document undocumented CI workflows, the defaults layer, and write the
missing resync procedure. Fix the vendored polyfill's stale header comment.

**Files:**

- `docs/contributing.md` (G1, G3)
- `docs/configuration.md` (G2)
- `vendor/prompt-api-polyfill/prompt-api-polyfill.js` (G4)

**Prerequisites:** None

**Implementation Steps:**

**G1 — Document `dependabot-auto-merge.yml` in contributing.md**

1. Open `docs/contributing.md`. After the "Releases" section, add:

   ```markdown
   ## Dependency updates

   Dependabot is configured to open PRs for non-major version bumps in
   `devDependencies`. A separate CI workflow (`dependabot-auto-merge.yml`)
   waits for all CI checks to pass and then auto-squash-merges the PR.
   Major version bumps require manual review and are never auto-merged.
   ```

**G2 — Document `defaults.js` secondary config layer in docs/configuration.md**

1. Open `docs/configuration.md`. After the "Other knobs" section, add:

   ```markdown
   ## Default fallback layer

   If a field is absent from `.env.json`, the polyfill's Transformers backend
   falls back to the values in
   `vendor/prompt-api-polyfill/backends/defaults.js` (the `DEFAULT_MODELS.transformers`
   object). This secondary layer supplies `modelName`, `device`, and `dtype`
   defaults. In practice `.env.json` always provides all fields — but if you
   remove a field to experiment, it will silently resolve from that file rather
   than failing.
   ```

### G3 — Write the missing resync procedure in docs/prompt-api.md

The current doc claims a resync procedure exists but the section is absent.

1. Open `docs/prompt-api.md`. Find the "What we changed" section. Append a
   new `## Resync procedure` section after it with the following content
   (write this markdown directly into the file):

   - A numbered list: "When pulling a new upstream commit of the polyfill:"
   - Step 1: Download `prompt-api-polyfill.js` using curl from the GitHub raw
     URL: `https://raw.githubusercontent.com/GoogleChromeLabs/web-ai-demos/main/prompt-api-polyfill/prompt-api-polyfill.js`
     into `vendor/prompt-api-polyfill/prompt-api-polyfill.js`
   - Step 2: Check the header comment (lines 1–30) for new backends; keep
     only the Transformers.js backend listing.
   - Step 3: Search for `HTMLIFrameElement.prototype` or `MutationObserver`
     near the top; delete the iframe-injection block if present (removed to
     prevent SPA performance regressions — see ADR in `docs/architecture.md`).
   - Step 4: Download `backends/transformers.js` from upstream using the same
     curl pattern into `vendor/prompt-api-polyfill/backends/transformers.js`.
   - Step 5: In `backends/transformers.js`, verify `max_new_tokens` is 2048;
     raise it if the upstream reset it to 1024.
   - Step 6: Verify `backends-registry.js` still only registers the
     `'transformers'` backend.
   - Step 7: Run `npm run build` and smoke-test the extension in Chrome.
     Confirm `[local-nano] heavy modules loaded` appears in the console.

### G4 — Update stale header comment in the vendored polyfill

The header comment (lines 7–22) lists all four original backends
(Firebase AI Logic, Google Gemini API, OpenAI API, Transformers.js). Only
the Transformers.js backend is present.

1. Open `vendor/prompt-api-polyfill/prompt-api-polyfill.js`. Find the header
   comment block (lines 7–22 approximately). It looks like:

   ```text
   * Supported backends:
   * - Firebase AI Logic
   * - Google Gemini API
   * - OpenAI API
   * - Transformers.js
   ```

   Replace it with:

   ```text
   * Supported backends (in this vendored copy):
   * - Transformers.js
   *
   * NOTE: Firebase AI Logic, Google Gemini API, OpenAI API, and WebLLM
   * backends from the upstream project have been removed from this copy.
   * See docs/prompt-api.md for the full list of modifications.
   ```

**Verification Checklist:**

- [x] `docs/contributing.md` has a "Dependency updates" section describing
  `dependabot-auto-merge.yml`
- [x] `docs/configuration.md` has a "Default fallback layer" section
- [x] `docs/prompt-api.md` has a "Resync procedure" section with all steps
- [x] `vendor/prompt-api-polyfill/prompt-api-polyfill.js` header comment only
  lists Transformers.js and notes the removed backends

**Testing Instructions:**

```bash
npm run build
npm test
```

**Commit Message Template:**

```text
docs: fix G1-G4 gap findings from doc audit

- G1: documented dependabot-auto-merge.yml workflow in contributing.md
- G2: documented defaults.js secondary config fallback layer in configuration.md
- G3: wrote the missing resync procedure in docs/prompt-api.md
- G4: updated stale header comment in vendor polyfill to reflect only Transformers.js
```

---

## Task 6.3 — Fix Config Drift and Structure Findings (C1, S1–S3)

**Goal:** Correct the misleading reference to `dot_env.json` as a live config
file, improve README navigation, fix the polyfill link, and clarify the coverage
step in contributing.md.

**Files:**

- `docs/configuration.md` (C1)
- `README.md` (S1, S2)
- `docs/contributing.md` (S3)

**Prerequisites:** None

**Implementation Steps:**

**C1 — Clarify `dot_env.json` is a reference template, not a live config**

1. Open `docs/configuration.md`. Find line ~63:
   `"See \`vendor/prompt-api-polyfill/dot_env.json\` for the full shape if you need to override a Transformers.js setting from \`.env.json\`."`

   Replace with:
   `"For the full list of Transformers.js-level settings the polyfill accepts, see \`vendor/prompt-api-polyfill/dot_env.json\` — it is a **reference template only** and is not read at runtime. All live configuration comes from your \`.env.json\`."`

### S1 — Add missing docs to README nav bar

1. Open `README.md`. Find the nav paragraph (~line 14):

   ```html
   <p align="center">
     <a href="docs/architecture.md">Architecture</a> · <a href="docs/configuration.md">Configuration</a> · <a href="docs/models.md">Models</a> · <a href="docs/privacy.md">Privacy</a>
   </p>
   ```

   Replace with a nav that includes all eight doc files:

   ```html
   <p align="center">
     <a href="docs/architecture.md">Architecture</a> ·
     <a href="docs/configuration.md">Configuration</a> ·
     <a href="docs/models.md">Models</a> ·
     <a href="docs/privacy.md">Privacy</a> ·
     <a href="docs/development.md">Development</a> ·
     <a href="docs/prompt-api.md">Prompt API</a> ·
     <a href="docs/testing.md">Testing</a> ·
     <a href="docs/contributing.md">Contributing</a>
   </p>
   ```

### S2 — Fix polyfill link in README

1. Open `README.md`. Find line ~25. The link text reads
   `Uses Google's prompt-api-polyfill` and the link target is the spec proposal
   repo (`webmachinelearning/prompt-api`).

   The link points to the spec proposal. Replace it with the correct polyfill
   implementation link:

   ```markdown
   Uses Google's [`prompt-api-polyfill`](https://github.com/GoogleChromeLabs/web-ai-demos/tree/main/prompt-api-polyfill) so the same code can target...
   ```

### S3 — Clarify that `npm run coverage` runs tests

1. Open `docs/contributing.md`. Find the workflow steps block (~lines 9–15):

   ```bash
   npm run typecheck
   npm run coverage
   npm run build
   ```

   Add an inline note so contributors know `coverage` runs tests:

   ```bash
   npm run typecheck
   npm run coverage  # runs the test suite and enforces coverage thresholds
   npm run build
   ```

   If the script block is a fenced code block without space for inline comments,
   add a note sentence before the block instead:
   `"The \`coverage\` command runs the full test suite (implicitly \`npm test\`) and then enforces the coverage thresholds from \`vitest.config.ts\`. You do not need to run \`npm test\` separately."`

**Verification Checklist:**

- [x] `docs/configuration.md` clarifies `dot_env.json` is a reference template
- [x] `README.md` nav bar includes all 8 doc links
- [x] `README.md` polyfill link points to `GoogleChromeLabs/web-ai-demos/.../prompt-api-polyfill`
- [x] `docs/contributing.md` clarifies that `npm run coverage` runs tests

**Testing Instructions:**

```bash
npm run build
# Manually verify README renders correctly
```

**Commit Message Template:**

```text
docs: fix C1, S1-S3 structure and config drift findings

- C1: dot_env.json now documented as a reference template (not read at runtime)
- S1: README nav bar extended to include all 8 doc links
- S2: README polyfill link corrected from spec repo to implementation repo
- S3: contributing.md clarifies npm run coverage implicitly runs tests
```

---

## Task 6.4 — Add markdownlint to CI

**Goal:** Enforce markdown formatting in CI to prevent future drift from
reintroducing the kinds of formatting issues the doc audit found (doc-audit
Prevention Recommendations).

**Files:**

- `.github/workflows/ci.yml`
- `.markdownlint.json` (new file)

**Prerequisites:** None

**Implementation Steps:**

1. Create `.markdownlint.json` at the repo root:

   ```json
   {
     "default": true,
     "MD013": false,
     "MD033": false,
     "MD041": false
   }
   ```

   Disabled rules:
   - `MD013` (line-length) — long lines are unavoidable in tables and code blocks
   - `MD033` (no-inline-HTML) — README uses `<p align="center">` intentionally
   - `MD041` (first-line-h1) — README starts with `<p>` tag, not a heading

1. Run markdownlint locally to see existing violations:

   ```bash
   npx markdownlint-cli2 "**/*.md" --ignore node_modules --ignore vendor --ignore coverage
   ```

   Fix any violations found. Common ones to expect:
   - Fenced code blocks without language tags (add the language tag)
   - Blank lines missing before/after headings
   - Ordered lists not using `1.` for every item

1. Once `npx markdownlint-cli2` exits 0, add the CI step. Open
   `.github/workflows/ci.yml`. Add after the `Lint` step and before
   `Typecheck`:

   ```yaml
   - name: Markdown lint
     run: npx --yes markdownlint-cli2 "**/*.md" --ignore "node_modules/**" --ignore "vendor/**" --ignore "coverage/**"
   ```

**Verification Checklist:**

- [x] `.markdownlint.json` exists at repo root
- [x] `npx markdownlint-cli2` exits 0 on all tracked markdown files
- [x] `.github/workflows/ci.yml` has a `Markdown lint` step
- [x] All existing tests still pass

**Testing Instructions:**

```bash
npx markdownlint-cli2 "**/*.md" --ignore "node_modules/**" --ignore "vendor/**" --ignore "coverage/**"
npm test
```

**Commit Message Template:**

```text
ci: add markdownlint step to prevent documentation drift

- Added .markdownlint.json with MD013/MD033/MD041 disabled
- Added Markdown lint CI step before Typecheck
- Fixed all pre-existing markdownlint violations in docs/
```

---

## Task 6.5 — Add Lychee Link Checker to CI

**Goal:** Add lychee link checking to CI to catch broken external links
automatically (doc-audit Prevention Recommendations, finding S2 would be caught
by lychee if the target had moved).

**Files:**

- `.github/workflows/ci.yml`
- `.lychee.toml` (new file)

**Prerequisites:** Task 6.4 complete

**Implementation Steps:**

1. Create `.lychee.toml` at the repo root:

   ```toml
   # Lychee link checker configuration

   # Exclude HuggingFace model URLs (require login for some)
   exclude = [
     "https://huggingface.co/onnx-community/.*",
     "https://webgpureport.org",
   ]

   # GitHub rate-limits unauthenticated requests; cache for 1 day
   cache = true
   max_cache_age = "1d"

   # Do not fail on timeouts (transient network issues in CI)
   timeout = 15

   # Only check markdown files
   include_verbatim = false
   ```

1. Add the lychee CI step. Open `.github/workflows/ci.yml`. Add after
   `Markdown lint` and before `Typecheck`:

   ```yaml
   - name: Check links
     uses: lycheeverse/lychee-action@v2
     with:
       args: --config .lychee.toml "**/*.md"
       fail: true
   ```

   Note: `lycheeverse/lychee-action@v2` is the current stable version of the
   lychee GitHub Action. Verify this is the correct version at the
   [lychee-action releases page](https://github.com/lycheeverse/lychee-action/releases)
   before committing.

**Verification Checklist:**

- [x] `.lychee.toml` exists at repo root
- [x] `.github/workflows/ci.yml` has a `Check links` step using lychee-action
- [x] HuggingFace model URLs are in the exclude list
- [x] All tests still pass

**Testing Instructions:**

Run lychee locally (if installed):

```bash
lychee --config .lychee.toml "**/*.md"
```

Or verify the config file is syntactically valid:

```bash
cat .lychee.toml
```

**Commit Message Template:**

```text
ci: add lychee link checker to prevent broken external links

- Added .lychee.toml with HuggingFace model URL exclusions
- Added Check links CI step using lycheeverse/lychee-action@v2
- S2 (wrong polyfill link in README) fixed in Task 6.3 — lychee would
  have caught this if the target had moved
```

---

## Task 6.6 — Add Cross-Reference Test for Default Model Name

**Goal:** Add a Vitest test that imports `.env.example.json` and asserts its
`modelName` matches the value shown in `docs/configuration.md`, preventing the
D2 drift class from recurring silently (doc-audit Prevention Recommendations).

**Files:**

- `tests/docs-config.test.ts` (new file)

**Prerequisites:** None

**Implementation Steps:**

1. Create `tests/docs-config.test.ts`:

   ```ts
   import { describe, it, expect } from 'vitest';
   import { readFileSync } from 'node:fs';
   import { fileURLToPath } from 'node:url';
   import { resolve } from 'node:path';
   import envExample from '../.env.example.json';

   const __dir = fileURLToPath(new URL('.', import.meta.url));

   describe('docs/configuration.md — cross-reference', () => {
     const configDoc = readFileSync(
       resolve(__dir, '../docs/configuration.md'),
       'utf8',
     );

     it('default modelName in .env.example.json matches docs/configuration.md', () => {
       const expectedModel = envExample.modelName;
       expect(configDoc).toContain(`"modelName": "${expectedModel}"`);
     });
   });
   ```

   The project uses `"type": "module"` in `package.json`, so test files are
   treated as ESM. In ESM, `__dirname` is not defined. On Node 20,
   `import.meta.dirname` is not yet available (added in Node 21.2). The
   `fileURLToPath(new URL('.', import.meta.url))` pattern is the correct
   Node 20 ESM replacement.

   This test will fail if `docs/configuration.md` is updated with a wrong model
   name, or if `.env.example.json` is updated without updating the doc.

1. Run the test:

   ```bash
   npx vitest run tests/docs-config.test.ts
   ```

   It should pass now that D2 was fixed in Task 6.1.

**Verification Checklist:**

- [x] `tests/docs-config.test.ts` exists
- [x] Test passes with `npm run coverage`
- [x] Test fails if you temporarily change `docs/configuration.md` model name

**Testing Instructions:**

```bash
npm run coverage
```

**Commit Message Template:**

```text
test(docs): add cross-reference test for .env.example.json vs configuration.md

- Prevents D2-class drift where docs/configuration.md model name diverges
  from .env.example.json without a test failure surfacing it
- Uses readFileSync to check the actual string appears in the markdown
```

---

## Phase Verification

After all six tasks are committed:

```bash
npx markdownlint-cli2 "**/*.md" --ignore "node_modules/**" --ignore "vendor/**" --ignore "coverage/**"
npm run lint:ci
npm run typecheck
npm run coverage
npm run build
```

All must exit 0. Confirm:

- D1–D5 drift: polyfill description corrected, model name correct, Thinking…
  removed, privacy table complete, manifest version aligned
- G1–G4 gaps: dependabot workflow documented, defaults.js documented, resync
  procedure written, polyfill header updated
- C1: `dot_env.json` described as reference template
- S1: README nav has all 8 links
- S2: polyfill link corrected
- S3: contributing.md notes coverage runs tests
- `.markdownlint.json` present, CI step added
- `.lychee.toml` present, CI step added
- `tests/docs-config.test.ts` exists and passes
- All tests pass (≥ 46 including the new cross-reference test)
