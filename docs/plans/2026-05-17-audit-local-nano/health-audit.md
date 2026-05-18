---
type: repo-health
date: 2026-05-17
goal: General health check — scan all 4 vectors equally
deployment_target: Not deployed yet (Chrome extension, loaded unpacked)
existing_tooling: None (no linter, CI added during audit window — see context note)
---

# Codebase Health Audit: local-nano

## Context

This audit ran across the repository root at 2026-05-17. A few minor edits to the repo happened during the audit window (CI workflow added, `well_done.jpg` adopted as the README hero, license badge added) — those mean a couple of LOW findings below are already partly addressed in the live tree. They're preserved here for completeness; the planner can drop them when remediating.

## Executive Summary

- **Overall health:** FAIR
- **Biggest structural risk:** `content.ts` is a 294-line god module that mixes DOM construction, animation CSS, drag-and-drop logic, session management, streaming, history persistence, and message rendering in a single flat script — making it untestable and impossible to maintain in isolation.
- **Biggest operational risk:** A single `loadHeavy()` failure (network error during dynamic import) permanently caches a rejected `Promise` in `heavyLoadPromise`, making session creation permanently unrecoverable for the lifetime of the tab with no user-visible retry path.
- **Total findings:** 0 critical, 6 high, 7 medium, 5 low.

## Tech Debt Ledger

### CRITICAL

(None.)

### HIGH

#### H1. [Operational & Resiliency Debt] `content.ts:16–31`
- **The Debt:** `loadHeavy()` stores the in-flight `Promise` in `heavyLoadPromise` and never clears it on failure. If the dynamic `import()` of `@huggingface/transformers` or the polyfill rejects (e.g., network timeout, CSP violation, missing file), `heavyLoadPromise` holds a permanently rejected `Promise`. Every subsequent call to `loadHeavy()` — on all future panel-open toggles — returns the same rejected promise. `ensureSession()` catches the error and resets `creating = false`, but `heavyLoadPromise` is never nullified, so the failure is irrecoverable for the entire tab lifetime without a page reload.
- **The Risk:** A transient failure (brief network blip during first model load) permanently bricks the extension in that tab. The user sees an error message but has no way to retry without reloading the page; subsequent toggles silently open the panel with the error message still visible but the input non-functional because `s` is `null`.

#### H2. [Operational & Resiliency Debt] `content.ts:222–223`
- **The Debt:** `send()` guards with `if (!i.value.trim() || !s || activeAbort) return` but provides no user feedback when `s` is `null` (session creation failed or not yet complete). If the user types a message and presses Enter while the session is loading or has failed, the input is silently consumed: `i.value = ''` is never cleared because the early return fires first, but the user gets zero indication of why nothing happened. There is no call to `ensureSession()` inside `send()` to trigger model loading if the user types before toggling.
- **The Risk:** Confusing UX leading to user believing the extension is broken or unresponsive; no actionable feedback distinguishes "still loading" from "permanently failed".

#### H3. [Structural Design Debt] `content.ts:1–295` (entire file)
- **The Debt:** `content.ts` is a 294-line flat script that directly implements: CSS animation injection (lines 35–49), full DOM tree construction (lines 52–112), drag-and-drop logic (lines 117–136), storage key computation and history restoration (lines 140–159), lazy module loading with ORT configuration (lines 16–32), `LanguageModel` session lifecycle (lines 163–194), toggle message handling (lines 199–217), streaming inference with AbortController (lines 220–278), and button/keyboard event wiring (lines 281–294). The six modules in `src/` exist, but the entry-point itself is the largest and most complex file, untested and untestable as a unit.
- **The Risk:** Any regression in `content.ts` has zero test coverage. The file is the primary user-facing surface; future changes to any single concern (e.g., switching streaming API, changing drag behavior) require modifying and mentally re-validating the entire script.

#### H4. [Architectural Debt] `build.mjs:12–16`
- **The Debt:** `build.mjs` directly copies files from `node_modules/onnxruntime-web/dist/`, but `onnxruntime-web` is not declared in `package.json` — it is a transitive dependency of `@huggingface/transformers`. The build script has an undeclared, non-negotiated runtime dependency on a specific internal file layout of an indirect package.
- **The Risk:** If `@huggingface/transformers` upgrades its peer dependency to a different `onnxruntime-web` version that changes the dist file naming convention, or drops the dependency entirely, `npm ci` will succeed but `npm run build` will throw `ENOENT` at the `cp` call with no clear error message pointing to the root cause.

#### H5. [Code Hygiene & Maintenance Debt] `tsconfig.json:7`
- **The Debt:** `"strict": false` disables the entire TypeScript strict family. This is compounded by `content.ts:163` (`let s: any = null`), `content.ts:16` (`Promise<{ LanguageModel: any }>`), `content.ts:25–27` (three `as any` casts), `content.ts:179–180` (`mon: any`, `e: any`), and `src/history.ts:15` (a `as unknown as Promise<void>` double-cast that is unnecessary given that `StorageArea.set` is already typed as `Promise<void>`).
- **The Risk:** Without `strictNullChecks`, the `s: any = null` session variable is the single point of unsafety for every function that calls session methods — the compiler cannot flag `s.promptStreaming(...)` as a potential null dereference.

#### H6. [Operational & Resiliency Debt] `content.ts:242–249`
- **The Debt:** The stream reader is acquired via `stream.getReader()` (line 242) but `reader.releaseLock()` is never called in a `finally` block. If an `AbortError` or other exception is thrown mid-stream, the catch block handles the error message but the reader lock on the underlying `ReadableStream` is never explicitly released.
- **The Risk:** Depending on the polyfill's `promptStreaming` implementation, an unreleased reader lock could prevent the session from being reused correctly on the next message send.

### MEDIUM

#### M1. [Code Hygiene & Maintenance Debt] `content.ts:257`
- **The Debt:** Per-chunk verbose logging: `console.log('[local-nano] chunk ${chunkCount}:', JSON.stringify(value))` fires on every streamed token. For a 300-token response this produces 300 console log entries in the host page's DevTools.
- **The Risk:** Severe DevTools performance degradation on the host page for any user who has DevTools open; leaks partial LLM responses verbatim into console output.

#### M2. [Architectural Debt] `content.ts:27` + `vendor/prompt-api-polyfill/backends-registry.js`
- **The Debt:** Configuration is passed to the Transformers backend via `window.TRANSFORMERS_CONFIG` (a global mutation), set immediately before the polyfill module is loaded. The coupling is implicit and order-dependent: the polyfill reads the window global at class instantiation time. If module evaluation order changes, the config may be read before it is written.
- **The Risk:** Silent misconfiguration: the backend falls back to default values from `vendor/prompt-api-polyfill/backends/defaults.js` with no error.

#### M3. [Structural Design Debt] `content.ts:95` + `content.ts:163`
- **The Debt:** The input element is named `i` (line 95) and the LLM session is named `s` (line 163). Both are module-scope variables referenced throughout the 295-line file. A third single-character variable `v` is used locally in `send()` (line 224) for the trimmed user input value.
- **The Risk:** Reduces read-time clarity in a file that already lacks structural separation. `s` in particular is accessed from multiple closures and its `any` type plus cryptic name makes call-site intent unclear.

#### M4. [Operational & Resiliency Debt] `content.ts:140–148` (unbounded history growth)
- **The Debt:** `history: Entry[]` grows without bound. Every user message and model response is appended (lines 156–158, 272–273) and the full array is written to `chrome.storage.local` on every turn. `chrome.storage.local` has a 10 MB total quota; there is no `MAX_HISTORY` trim, no LRU eviction, and no error handler on `saveHistory` / `persist()`.
- **The Risk:** On pages visited many times over weeks, storage quota exhaustion causes `chrome.storage.local.set` to silently fail (the returned `Promise` rejects), since `persist()` does not `await` the result and does not attach a `.catch()` handler. The failure is completely invisible to the user.

#### M5. [Operational & Resiliency Debt] `content.ts:144` + `src/history.ts:14`
- **The Debt:** `persist()` calls `saveHistoryToStorage(...)` without `await` and without `.catch()`. Any storage write failure — quota exceeded, storage API error — is silently swallowed.
- **The Risk:** Data loss on quota exhaustion is completely silent. Combined with M4, this creates a progressive failure mode where saves stop working with no indication.

#### M6. [Code Hygiene & Maintenance Debt] `.gitignore`
- **The Debt:** `.gitignore` covers `node_modules/`, `dist/`, `coverage/`, and `.env.json`. It does not cover common IDE artifacts (`.vscode/`, `.idea/`) or OS artifacts (`.DS_Store`, `Thumbs.db`). (Note: `well_done.jpg` was flagged as missing from `.gitignore` but is now intentionally checked in as the README hero image — finding partly stale.)
- **The Risk:** No mitigation for common accidental commits.

#### M7. [Operational & Resiliency Debt] `content.ts:163–165` (session state on `isFirstTurn`)
- **The Debt:** `isFirstTurn = true` is a module-scope flag that is never reset to `true` after `restore()` re-renders prior history. On a tab reload, `restore()` is called and prior messages are rendered — but the session `s` is also `null` after reload; `ensureSession()` creates a fresh session with no knowledge of the restored history. The LLM has no memory of prior turns even though they are displayed in the UI.
- **The Risk:** Users see a conversation history that the model has no access to. Sending a follow-up like "expand on that" after a page reload will produce a confused or irrelevant response.

### LOW

#### L1. [Code Hygiene] `src/ui/messages.ts:5`
- **The Debt:** `innerHTML` is used to inject the three `.ln-dot` spans in `makeTypingIndicator()`. The string is a hardcoded literal — no XSS risk in practice — but inconsistent with the rest of the codebase (all other dynamic text uses `textContent`).
- **The Risk:** Inconsistent pattern. A future modification could introduce XSS if a contributor doesn't notice the pattern difference.

#### L2. [Code Hygiene] 6 moderate npm vulnerabilities
- **The Debt:** `npm audit` reports 6 moderate severity vulnerabilities in `esbuild ≤ 0.24.2`, `vite`, `@vitest/mocker`, `vitest`, `@vitest/coverage-v8`, `vite-node`. All are in devDependencies only. The esbuild vulnerability is only exploitable during `npm run watch`.
- **The Risk:** Zero production risk (extension bundle is unaffected). Developers running `npm run watch` on a machine with a browser open to an adversarial page are exposed.

#### L3. [Code Hygiene] `vendor/prompt-api-polyfill/dot_env.json`
- **The Debt:** File contains an empty Firebase/Gemini config template with keys `apiKey`, `projectId`, `appId`, `reCaptchaSiteKey`. Values are empty strings; the file is upstream boilerplate for backends not used in this extension.
- **The Risk:** May trigger false positives in secret-scanning tools and is confusing for contributors unfamiliar with the vendored library's multi-backend scope.

#### L4. [Code Hygiene] `vitest.config.ts:12` + `content.ts` (coverage gap)
- **The Debt:** Coverage `include` is scoped to `src/**/*.ts`. The two entry-point files `content.ts` and `background.ts` are excluded from measurement. `content.ts` contains all the most complex orchestration in the repo and has zero measured coverage.
- **The Risk:** Coverage thresholds (75% lines/statements/functions, 70% branches) are met by trivial `src/` modules, giving a false sense of safety for the untested orchestration layer.

#### L5. [Architectural Debt] `content.ts:25–26` (redundant ORT config)
- **The Debt:** `content.ts` manually sets `tfMod.env.backends.onnx.wasm.wasmPaths` and `numThreads`, then sets `window.TRANSFORMERS_CONFIG` which includes an `env.backends.onnx.wasm.wasmPaths` key that the `TransformersBackend` also merges into `env`. The direct mutation and the config-path merge both set the same field.
- **The Risk:** If `window.TRANSFORMERS_CONFIG.env.backends.onnx.wasm.wasmPaths` is non-empty in a future change, it will overwrite the direct assignment. Currently inert but a latent misconfiguration hazard.

## Quick Wins

1. `src/history.ts:15` — Remove the `as unknown as Promise<void>` double-cast. (< 5 minutes)
2. `tsconfig.json:7` — Change `"strict": false` to `"strict": true`. (< 30 minutes to enable + fix type errors)
3. `content.ts:257` — Remove the per-chunk `console.log`. (< 5 minutes)
4. `.gitignore` — Add `.vscode/`, `.DS_Store`, `Thumbs.db`. (< 5 minutes)
5. `content.ts:144` — Add `.catch()` around `persist()`. (< 15 minutes)

## Automated Scan Results

**Dead code (`npx knip`):** 9 false positives (entry points + vendored code knip doesn't trace through). No genuine dead code in `src/`.

**Vulnerabilities (`npm audit`):** 6 moderate in devDependencies (esbuild ≤ 0.24.2, cascading). Zero in production bundle. `npm audit fix --force` would require breaking esbuild upgrade to 0.28.0.

**Secrets:** `.env.json` is gitignored. `vendor/prompt-api-polyfill/dot_env.json` is tracked but credential fields are empty. `apiKey: "dummy"` in `.env.example.json` is intentional placeholder. No live secrets committed.

**Pre-release dep pin:** `package-lock.json` pins `onnxruntime-web` to `1.26.0-dev.20260416-b7804b056c` (pre-release dev build resolved transitively from `@huggingface/transformers`). Not declared in `package.json`; stability risk for a core runtime dependency.
