---
type: doc-health
date: 2026-05-23
prevention_scope: None — fix existing docs only, no new tooling (markdownlint + lychee already in CI)
language_stack: JS/TS
---

# Documentation Audit: local-nano

## Configuration
- **Prevention Scope:** None — just fix the existing docs. (markdownlint + lychee link-checking already wired into `.github/workflows/ci.yml`.)
- **CI Platform:** GitHub Actions (`.github/workflows/ci.yml`)
- **Language Stack:** JS/TS (typedoc/swagger-jsdoc available; not requested)
- **Constraints:** None — all docs in scope (README.md, CHANGELOG.md, docs/, manifest.json text, web-store/). Internal `docs/plans/` files noted but not audited as published docs.

## Summary
- Docs scanned: 12 public docs (README.md, CHANGELOG.md, 9 files in docs/, plus manifest.json / web-store/ text)
- Code modules scanned: ~16 (background.ts, content.ts, offscreen.ts, build.mjs, scripts/*.mjs, src/**, vendored polyfill backends, manifest.json, configs)
- Findings: **8 drift, 1 gap, 0 stale-removed, 0 broken links** (+ 3 stale code examples / config drift, 3 structure issues)
- Most damaging: `architecture.md` predates the offscreen-document refactor — it still says the content script runs the model, which is the design from before 0.2.2.

> **Correction (2026-05-23):** The original auditor flagged the model name `onnx-community/gemma-4-E2B-it-ONNX` as "fabricated," claiming Gemma 4 doesn't exist. This was a false positive — the auditor relied on stale training knowledge for an external-existence claim it could not verify offline. The model **does** exist on the Hugging Face Hub (Gemma 4 E2B, multimodal, ~38K downloads/month) and the name is used consistently across docs and config. The fabricated-model DRIFT finding, its stale-example entry, and the related config-drift finding have been removed below.

## Findings

### DRIFT (doc exists, doesn't match code)

1. **Architecture doc predates the offscreen refactor** (`docs/architecture.md:3-7,29-58,116-129`) → `offscreen.ts`, `src/background/offscreen.ts`, `src/offscreen/*`
   - Doc says: "three moving pieces" = background SW, content script that "owns the chat UI **and runs the model**", and the polyfill; data-flow art shows content.ts "lazy-loads heavy modules / builds Prompt API session."
   - Code says: per CHANGELOG 0.2.2, the model session was moved out of the content script into a dedicated **offscreen document** (`offscreen.ts`, created via `chrome.offscreen.createDocument` in `src/background/offscreen.ts`). The model loads in `offscreen.ts:loadHeavy/ensureSession`; the content script streams to it over a `chrome.runtime.Port` via `src/offscreen/client.ts`. The offscreen document — the actual model host — is entirely absent. The whole doc, diagram, and ADR-002 describe the pre-0.2.2 design.

2. **Heavy-module load location** (`docs/architecture.md:42`, `docs/prompt-api.md:59-66`) → `offscreen.ts:60-86`
   - Doc says: "`content.ts` ... dynamically imports `@huggingface/transformers` and the polyfill" with a snippet attributed to content.ts.
   - Code says: that `Promise.all([import('@huggingface/transformers'), import('./vendor/...')])` lives in `offscreen.ts:64-67`. `content.ts` imports only `src/selection-rewrite.js`, `src/session.js`, `src/ui/state.js`.

3. **`TRANSFORMERS_CONFIG` / `.env.json` injection point** (`docs/configuration.md:18`, `docs/architecture.md:54`, `docs/prompt-api.md:70`) → `offscreen.ts:20,71`
   - Doc says: "imported directly by `content.ts` at build time and passed to the polyfill as `window.TRANSFORMERS_CONFIG`" / "`content.ts` populates from `.env.json`."
   - Code says: `offscreen.ts:20` does `import transformersConfig from './.env.json'` and `offscreen.ts:71` sets `window.TRANSFORMERS_CONFIG`. `content.ts` never touches the config.

4. **"Loading model… NN%" download-progress UI does not exist** (`docs/models.md:29`, `docs/development.md:45`, `docs/prompt-api.md:76`) → `src/session.ts:632-639`
   - Doc says: "the panel shows `Loading model… NN%` during weight download" and "`monitor(target)` receives `downloadprogress` events ... drives the `Loading model… NN%` status."
   - Code says: the warmup hint is a live **elapsed-seconds counter** — `'Loading model… 0s'`, ticking `Loading model… ${secs}s` (`src/session.ts:632,638,639`). No percentage readout and no `monitor`/`downloadprogress` wiring anywhere. The percentage UI was removed (CHANGELOG 0.2.4 describes "bouncing dots + an elapsed counter"); three docs still describe the old UI.

5. **System instruction is NOT seeded from `src/system.ts`** (`docs/prompt-api.md:75`, implied `docs/architecture.md:79`) → `offscreen.ts:55,92`
   - Doc says: "`initialPrompts: [{ role: 'system', content: SYSTEM_INSTRUCTION }]` seeds the system instruction from `src/system.ts`."
   - Code says: the session is seeded with a hardcoded literal in `offscreen.ts:55`: `'You are a helpful assistant. Answer concisely and directly.'`, used at `offscreen.ts:92`. The richer `SYSTEM_INSTRUCTION` in `src/system.ts` is exported and unit-tested but **never imported by the session path** (see STALE/dead-code note).

6. **`content.ts` imports the polyfill global** (`docs/prompt-api.md:68,82`) → reality: offscreen does, via module export
   - Doc says: "`content.ts` imports and uses the module-exported `LanguageModel` directly."
   - Code says: `content.ts` does none of this. `offscreen.ts:74-78` destructures `LanguageModel` from `polyfillMod`. The described behavior (module export, not global) is real, but happens in the offscreen document.

7. **Privacy permissions table lists removed permissions** (`docs/privacy.md:24-33`) → `manifest.json:11,15-19`
   - Doc says permissions rows for `activeTab`, `scripting`, and `host_permissions for cdn.jsdelivr.net`; plus `docs/privacy.md:8` "cdn.jsdelivr.net, in fallback paths only."
   - Code says `manifest.json` permissions are only `["storage", "offscreen"]` and host_permissions are the three huggingface domains — `activeTab`, `scripting`, and `cdn.jsdelivr.net` were all removed in 0.2.4. privacy.md never mentions the `offscreen` permission and omits the offscreen document from "What stays on your machine."

8. **Bundle-size claim points at the wrong file** (`docs/development.md:70`) → `dist/`
   - Doc says: "`dist/content.js` is ~1.5 MB because it inlines the Transformers.js runtime."
   - Reality: `dist/content.js` is ~41 KB. The ~1.5 MB bundle that inlines Transformers.js is `dist/offscreen.js` (1,572,770 bytes). Since the model moved offscreen (0.2.2), the heavy runtime no longer lands in the per-page content script — contradicting this line.

### GAPS (code exists, no doc)

1. **Preflight device-capability advisory undocumented** — `docs/configuration.md:57-68` documents `historyTokenWarnThreshold` well (matches `src/session.ts:69-79` and `offscreen.ts:146`). However the user-visible **preflight advisory** added in the latest commit (`src/session.ts:90-100`, `preflightWarning` — "Heads up: no hardware WebGPU adapter…") is undocumented in any user doc; only CHANGELOG 0.2.4 mentions the warmup indicator, not the device-capability advisory. Minor. (No other meaningful exported-symbol gaps.)

### STALE (doc exists, code doesn't)

1. **`src/system.ts` `SYSTEM_INSTRUCTION` is effectively dead** — `src/system.ts:1` exports the rich prompt; `tests/system.test.ts` tests it; `docs/architecture.md:79` and `docs/prompt-api.md:75` claim it's the system instruction. Nothing in the session/offscreen path imports it (grep finds only the test). The session actually uses the short literal in `offscreen.ts:55`. Either offscreen should import `src/system.ts` or the docs should stop claiming it does.

### BROKEN LINKS
- None. All relative links in README.md, docs/*.md, and CHANGELOG.md resolve. The anchor `docs/models.md#on-max_new_tokens` (referenced from `docs/architecture.md:52`, `docs/prompt-api.md:27`) resolves to the real heading (`docs/models.md:110`). The hero image `well_done.jpg` exists. CI badge points at the existing `actions/workflows/ci.yml`.

### STALE CODE EXAMPLES

1. **`docs/models.md:11-13` TL;DR table dtypes** — recommends `dtype: "q4"` for the two WebGPU rows, but CHANGELOG 0.2.4, `docs/configuration.md:48`, and the live default (`.env.json` / `.env.example.json` = `q4f16`) moved off `q4` because the `q4` ONNX kernel hits a `SIGILL` (commit `22eb999`). The TL;DR still leads users to the dtype the project now warns against. The detailed row at `docs/models.md:101` lists `webgpu + q4 … Current default`, which contradicts the real default of `q4f16`. (Verify the exact `models.md` wording during remediation — model *name* on that row is correct; only the dtype is stale.)
2. **`docs/architecture.md:90-97` session-lifecycle variable table** — lists closure variables `session`, `creating`, `heavyLoadPromise` as the state inside `initSession()`. None exist in current `src/session.ts`: the model session lives in `offscreen.ts` (`sessionPromise`, `heavyPromise`). ADR-004 ("Why `heavyLoadPromise` is reset to null on failure") references a variable that no longer lives where the doc says.
3. **`docs/architecture.md:46` page-context cap** — "body excerpt (capped at 1500 chars)" — *correct* (`src/pageContext.ts:1` `PAGE_CONTEXT_BODY_LIMIT = 1500`); flagged only to confirm it survived. `docs/privacy.md:16` "capped at 1500 characters" also matches.

### CONFIG DRIFT (Phase 5)

1. **`modelName` default is correct and consistent** — `.env.example.json:5` and `.env.json:5` both = `onnx-community/gemma-4-E2B-it-ONNX`, matching `docs/configuration.md` and the model that exists on the Hub. No drift. (Structural note, not a defect: `tests/docs-config.test.ts` only asserts `.env.example.json` and `docs/configuration.md` *agree with each other*, not against the Hub — so it would not catch a genuinely wrong model name. Worth strengthening, but the current value is right.)
2. **Keys read by code vs documented** — code reads `apiKey`, `device`, `dtype`, `modelName` (via polyfill `TRANSFORMERS_CONFIG`) plus optional `historyTokenWarnThreshold` (`offscreen.ts:146`, `src/session.ts:70`). All five documented in `docs/configuration.md`. `.env.example.json` ships only the first four (optional one correctly described as optional). No undocumented or documented-but-unread keys. Note: `apiKey` **is** read by the vendored polyfill (`prompt-api-polyfill.js:181`) — if `docs/configuration.md:53-55` describes it as flatly "unused," that wording is slightly off (it's a placeholder the transformers backend ignores, not a field nothing reads). Verify the exact doc wording during remediation. *(Corrected 2026-05-23: the original audit called the "unused" note accurate.)*
3. **Default fallback layer** — `docs/configuration.md:78-86` says missing fields fall back to `vendor/prompt-api-polyfill/backends/defaults.js` `DEFAULT_MODELS.transformers` = `{ modelName: 'onnx-community/gemma-3-1b-it-ONNX-GQA', device: 'webgpu', dtype: 'q4f16' }` — verified accurate (`defaults.js:13-17`). Note this fallback model is the one `docs/models.md:93` reports as a WASM trap. Both the documented primary default (`gemma-4-E2B-it-ONNX`) and this fallback are real models that exist on the Hub.

### STRUCTURE ISSUES (Phase 6)

1. **`web-store/local-nano-v0.2.3.zip` is a version behind** — `manifest.json:4` and `package.json:3` are `0.2.4`; `docs/chrome-web-store.md:3,57` say `npm run package` produces `web-store/local-nano-v<version>.zip`. The stale `v0.2.3` artifact sits in the working tree, predating current source. It is **untracked** (gitignored via `.gitignore:16`), so this is local-only clutter, not a versioned-file issue. *(Corrected 2026-05-23: the original wording called it a "committed artifact"; it is not in git.)*
2. **`docs/transform.md:91` "Load the unpacked extension from `dist/`"** is wrong and contradicts `README.md:58` ("pick this repository's root directory") and `docs/development.md:19` ("load `local-nano/`"). `manifest.json` lives at repo root, not `dist/` (no `dist/manifest.json`), so loading `dist/` would fail. The verification steps in transform.md and the pre-submit note in chrome-web-store.md inherit this wrong path.
3. **`docs/transform.md` versioning lag + open naming inconsistency** — the doc is framed around "v0.2.3" / "Out of scope for v0.2.3" (`docs/transform.md:45,57,87`) but the project is on 0.2.4 and the feature shipped. Also `docs/chrome-web-store.md:7,49` still flags the unresolved "Local AI Cmd vs Local Nano" name decision, and `manifest.json:3` name is `"Local AI Cmd"` while all branding/README/`content.ts:45` title and the repo say local-nano — a real, still-open naming inconsistency.

**Additional verified-accurate (no action):** vendored polyfill edits (`backends-registry.js` trimmed to transformers-only, `backends/` holds only base/defaults/transformers, iframe/MutationObserver block removed at `prompt-api-polyfill.js:1352`, `max_new_tokens: 2048` at `transformers.js:150`) all match docs. Minor extra DRIFT: `docs/chrome-web-store.md:46` says icons are "generated from `icons/icon.svg` via `npm run icons`", but `make-icons.mjs` uses ffmpeg from `icon-source.png` — there is no `icons/icon.svg`.
