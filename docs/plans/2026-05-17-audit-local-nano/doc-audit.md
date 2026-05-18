---
type: doc-health
date: 2026-05-17
prevention_scope: Markdown linting (markdownlint) + link checking (lychee)
language_stack: JS/TS
constraints: All docs, no constraints
---

# Documentation Audit: local-nano

## Configuration
- **Prevention Scope:** markdownlint + lychee (catches formatting issues and broken links on every PR)
- **CI Platform:** GitHub Actions (`.github/workflows/ci.yml` exists; new prevention jobs would be added there)
- **Language Stack:** JS/TS
- **Constraints:** None — all docs scanned

## Summary
- **Docs scanned:** 10 files (README.md, CHANGELOG.md, docs/architecture.md, docs/configuration.md, docs/contributing.md, docs/development.md, docs/models.md, docs/privacy.md, docs/prompt-api.md, docs/testing.md)
- **Code modules scanned:** 14 source files (content.ts, background.ts, src/background/handler.ts, src/history.ts, src/pageContext.ts, src/system.ts, src/ui/messages.ts, src/ui/state.ts, plus vendor polyfill, build.mjs, manifest.json, .env.example.json, vitest.config.ts, tests/setup.ts)
- **Findings:** 5 drift, 4 gaps, 0 stale, 0 broken links, 0 stale code examples, 1 config drift, 3 structure issues

## Findings

### Drift (doc exists, doesn't match code)

#### D1. Polyfill installation behaviour described incorrectly
- **`docs/prompt-api.md:53`** says: *"The polyfill installs over the native binding when both exist…"*
- **`docs/models.md:108`** says: *"The polyfill installs over the native binding, but only if it actually loads"*
- **Actual code** (`vendor/prompt-api-polyfill/prompt-api-polyfill.js:1361-1366`):
  ```js
  if (!('LanguageModel' in globalThis) || globalThis.__FORCE_PROMPT_API_POLYFILL__) {
    globalThis.LanguageModel = LanguageModel;
  ```
  Install is **conditional** — it explicitly *skips* installation when native `LanguageModel` is already present.
- **Effective behaviour is still correct** because `content.ts:29`/`174` use the module-exported `LanguageModel` directly, not the global. But the docs' claim that the polyfill "installs over the native binding" is factually backwards and will mislead anyone debugging native API interactions or the `NotAllowedError` failure mode described in `docs/models.md`.

#### D2. `docs/configuration.md:13` — Default model name does not match `.env.example.json`
- `docs/configuration.md` shows `"modelName": "onnx-community/Qwen3.5-0.8B-ONNX"`.
- `.env.example.json` ships `"modelName": "onnx-community/gemma-4-E2B-it-ONNX"`.
- `README.md` correctly shows the gemma-4-E2B default; `docs/models.md` TL;DR table also references gemma-4-E2B as the "Modern WebGPU" default. Only `docs/configuration.md` is out of sync.

#### D3. `docs/models.md:29` — Claimed `Thinking…` indicator doesn't exist
- `docs/models.md` line 29: *"The `Thinking…` indicator exists for this."*
- No `Thinking…` text appears anywhere in the codebase. The UI uses a three-dot CSS bounce animation (`.ln-dot`) while generating, and `Loading model… NN%` during weight download. The doc refers to a UI element that was never implemented.

#### D4. `docs/privacy.md:28` — Permissions table missing `*.huggingface.co` wildcard
- `docs/privacy.md` permissions table lists `host_permissions for huggingface.co`.
- `manifest.json` declares four entries: `https://huggingface.co/*`, **`https://*.huggingface.co/*`**, `https://cdn-lfs.huggingface.co/*`, `https://cdn.jsdelivr.net/*`.
- The wildcard subdomain entry is absent from the privacy table.

#### D5. Version string format mismatch — `manifest.json:3` vs `package.json:3` / `CHANGELOG.md`
- `manifest.json` has `"version": "0.1"`.
- `package.json` and `CHANGELOG.md` use `"0.1.0"`.
- `docs/contributing.md:46` instructs contributors to bump *both* simultaneously, but they currently use different string formats. Any release tag derived from CHANGELOG `[0.1.0]` will not match `manifest.json` version `0.1`.

### Gaps (code exists, no doc)

#### G1. `dependabot-auto-merge.yml` — Undocumented CI workflow
- `.github/workflows/dependabot-auto-merge.yml` exists and implements auto-squash-merge for non-major Dependabot PRs after CI passes.
- Not mentioned in `CHANGELOG.md`, `docs/contributing.md`, `docs/development.md`, or `README.md`. Contributors submitting dependency PRs won't know this workflow exists.

#### G2. `vendor/prompt-api-polyfill/backends/defaults.js` — Undocumented defaults file
- Imported by `transformers.js` (`import { DEFAULT_MODELS } from './defaults.js'`).
- Supplies fallback `modelName`, `device`, `dtype` values when config is absent.
- `docs/configuration.md` describes config propagation but does not mention that `DEFAULT_MODELS.transformers` acts as a secondary default layer beneath `.env.json`.

#### G3. Missing resync procedure for vendored polyfill
- `docs/contributing.md:33` claims: *"See [docs/prompt-api.md](prompt-api.md) for what we modified and the full resync procedure."*
- `docs/prompt-api.md` has a "What we changed" section listing edits to carry forward, but **no actual step-by-step resync procedure** — no commands, no instructions for pulling the upstream diff and reapplying patches. The promised content is absent.

#### G4. `vendor/prompt-api-polyfill/prompt-api-polyfill.js` — Stale header comment lists removed backends
- Header comment (lines 7–22) still lists all four original backends: Firebase AI Logic, Google Gemini API, OpenAI API, Transformers.js.
- The slimmed file only implements the Transformers.js backend (Firebase/Gemini/OpenAI/WebLLM files were deleted from `vendor/prompt-api-polyfill/backends/`).
- The comment-level documentation inside the vendored file misleads anyone reading it directly.

### Stale (doc exists, code doesn't)

None found.

### Broken Links

None. All relative file-path links (`../src/...`, `../build.mjs`, `../content.ts`, `../vendor/...`, `../manifest.json`, `../.env.example.json`, `../src/system.ts`, `../src/background/handler.ts`) resolve. All in-doc anchors (`#onnx-op-compatibility`, `#on-max_new_tokens`) target real headings. `well_done.jpg` and `LICENSE` exist.

### Stale Code Examples

None. The `content.ts` import snippet in `docs/prompt-api.md:34-38` matches the actual code. The `.env.json` JSON in `README.md` matches `.env.example.json` exactly. Coverage thresholds in `docs/testing.md` (75%/75%/75%/70%) match `vitest.config.ts`. The 27-test count in `CHANGELOG.md` matches the suite.

### Config Drift

#### C1. `docs/configuration.md:63` — `dot_env.json` context is misleading
- Says: *"See `vendor/prompt-api-polyfill/dot_env.json` for the full shape if you need to override a Transformers.js setting from `.env.json`."*
- `dot_env.json` does exist and contains a complete config skeleton, but is **not** read at runtime. `content.ts:27` populates `window.TRANSFORMERS_CONFIG` from the imported `.env.json` only.
- The doc implies `dot_env.json` is a live config file. It's only a reference template.

### Structure Issues

#### S1. README top navigation omits half the docs
- README pinned nav bar (`README.md:14`) links only to Architecture, Configuration, Models, Privacy.
- Development, Prompt API polyfill, Testing, Contributing are absent from the quick-nav (though listed in the Documentation section lower).
- A developer scanning the header will miss them.

#### S2. README polyfill link points to wrong repo
- `README.md:25`: *"Uses Google's [`prompt-api-polyfill`](https://github.com/webmachinelearning/prompt-api)…"*
- The link target is the **spec proposal** (`webmachinelearning/prompt-api`), not the polyfill implementation.
- The actual polyfill source — as correctly stated in `docs/prompt-api.md:9` — is `GoogleChromeLabs/web-ai-demos/tree/main/prompt-api-polyfill`.

#### S3. `docs/contributing.md` CI step ordering note
- Lines 14–16 list local CI check order as `typecheck → coverage → build`, matching `ci.yml`. Consistent.
- Minor: contributors may not realise `coverage` (= `vitest run --coverage`) implicitly runs the test step. The table doesn't say so.

## Prevention Recommendations

Per the chosen prevention scope (markdownlint + lychee):

- **markdownlint** in CI will catch heading style drift, list inconsistency, code-fence language tags missing, trailing whitespace. Recommend `markdownlint-cli2-action` with a project `.markdownlint.json` enforcing 1-line above/below headings, no trailing whitespace, fenced code blocks must have language tags.
- **lychee** in CI will catch the kind of latent link rot the audit didn't surface this round (it would flag `S2` automatically if the target had moved). Recommend `lychee-action` with `--no-progress` and an allowlist for HuggingFace model URLs which gate behind auth.
- Neither tool catches the **drift findings (D1–D5)** — those require code-vs-doc cross-referencing that's beyond markdownlint/lychee scope. The remediation plan should still fix them, but prevention here means adding cross-link tests (e.g., a Vitest test that imports `.env.example.json` and asserts its `modelName` matches the one shown in `docs/configuration.md`).
