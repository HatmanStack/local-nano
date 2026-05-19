# Changelog

All notable changes to local-nano will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-18

First feature release. v0.1.x was a chat panel that opened on a hotkey and read the page body as a single excerpt. v0.2 makes the extension DOM-aware: right-click on a selection (or hit a hotkey) to ask, rewrite, or transform that selection in place. All inference still runs on-device.

### Added

- **Right-click menu.** `chrome.contextMenus` integration registered from the background service worker. Menu inventory: `Ask local-nano about this`, `Summarize this page`, `Rewrite ▸ {Improve writing, Make shorter, Make formal, Fix grammar}`, and `Translate / Simplify / Summarize in place ▸ {To English, To Spanish, To French, Simplify, Summarize}`.
- **Hotkeys.** Three new commands (`ask_about_selection`, `rewrite_selection`, `translate_selection`) bring the manifest to its 4-command Chrome cap. Default chords are `Ctrl+Shift+{L, I, U}` (`Cmd+Shift+{L, I, U}` on Mac).
- **Preview-then-apply UX.** Write-side actions stream into a stacked Preview component (original on top, model output below) with Apply / Discard buttons. Escape triggers Discard. Apply replaces the captured `Range` / input selection in the page DOM.
- **Per-action ephemeral sessions.** `runTransform` creates a fresh `LanguageModel` session per action with a task-specific system prompt; the chat session is untouched. Transforms do not write to chat history. Heavy modules (Transformers.js + polyfill) share a module-level cache in the new `src/heavy.ts`.
- **Selection snapshot layer.** `src/dom-actions.ts` snapshots the selection at `contextmenu` / `keydown` time via `Range.cloneRange()` or `<input>` / `<textarea>` offsets, so the selection survives the user clicking the panel.
- **DOM apply layer.** `src/dom-apply.ts` covers three branches: `setRangeText` for `<input>` / `<textarea>` (plus a synthetic `input` event so React/Vue see the change), `execCommand('insertText')` for contenteditable (preserving native undo, with a `Range`-mutation fallback), and `deleteContents` + `insertNode(createTextNode)` for read-only prose. No `innerHTML` anywhere in the apply path.
- **Docs.** New `docs/dom-actions.md` describing the menu inventory, hotkeys, preview-then-apply UX, privacy invariant, and contributor guide for adding a new action. Privacy doc and architecture doc updated to reflect v0.2.
- **Tests.** `tests/transform-prompts.test.ts`, `tests/transform.test.ts`, `tests/background-menus.test.ts`, `tests/dom-actions.test.ts`, `tests/dom-apply.test.ts`, `tests/ui-preview.test.ts` add coverage for every new `src/` module.

### Changed

- `initSession` now returns a `SessionHandle` (`openPanel`, `closePanel`, `isPanelOpen`, `prefillAndSend`, `mountPreview`) so the new dispatch layer can drive the panel without owning its DOM. The existing 24 session tests still pass unchanged.
- `src/heavy.ts` factored out of `src/session.ts`. The heavy-module promise is now module-scoped so both the long-lived chat session and the per-action transform sessions share it.
- `manifest.json`: `permissions` += `contextMenus`; `commands` expanded to the 4-command cap.
- `tests/setup.ts`: extended with `contextMenus`, `runtime.onInstalled`, and `runtime.onStartup` mocks.

### Privacy

- Selection text and chat input are still on-device only. The new `contextMenus` permission is a Chrome UI API and grants no network access. See `docs/privacy.md` for the updated permissions table.

### Fixed

- **Preview apply-failure surface.** When the page-DOM target was removed between the right-click snapshot and Apply, `applyToTarget` returned `false` but the Preview tore down as if it had succeeded. The new `Preview.applyFailed(message)` keeps the preview open with an inline error and a locked Apply so the user has to Discard explicitly.
- **prefillAndSend readiness race.** `prefillAndSend(text, true)` triggered from a context-menu action before the model had loaded would silently drop the autoSend (because `send()` early-returns when `session` is null). The internal `creating: boolean` is now an awaitable `createInFlight: Promise<void>`, and `prefillAndSend` chains the send onto it.
- **Preview Escape key.** The Preview registered a keydown listener on its root with `tabIndex=-1`, but the root was never focused on mount — so Escape was a no-op until the user clicked into the preview. `dispatchAction` now calls `preview.root.focus()` after `mountPreview`.
- **chrome.runtime.lastError on context-menu clicks.** Right-clicks on chrome:// pages, extension pages, or any tab where the content script wasn't injected would surface "Could not establish connection. Receiving end does not exist." in the service worker console. `chrome.tabs.sendMessage` now passes a no-op callback that consumes `lastError`.
- **`ACTION_DESCRIPTORS` deep freeze.** `Object.freeze` was applied only to the outer array, leaving individual descriptors mutable at runtime. Each descriptor is now frozen too, so accidentally overwriting `systemPrompt` in a caller becomes a TypeError under strict mode instead of silently corrupting later transforms.
- **`actionToPrompt` error message.** Throwing `"Unknown action: <id>"` for chat-kind actions was misleading — the action IS known, it just has no system prompt. The message now names the kind: `"Action '<id>' is a chat-kind action and has no system prompt"`.
- **Discard button color.** The Discard button used the chat panel's red `BUSY_BG`, which semantically reads as "generation in progress" instead of "dismiss the preview." It's now neutral grey.

### Hardening

- **`loadHeavy` config-mismatch warning.** The cache silently won the first config and ignored later mismatches. A wiring bug between `initSession` and `runTransform` (passing different `transformersConfig` references) now surfaces a single `console.warn` naming the symptom.

### Known Limitations

- Translation languages hardcoded EN / ES / FR (configurable in v0.3).
- Selections in cross-origin iframes are not supported (top frame only).
- DOM mutations between the right-click snapshot and Apply may make the captured `Range` point to changed content; re-anchoring deferred.
- `contenteditable` widgets that intercept native events may behave unexpectedly during Apply; framework-specific guarantees are not in scope.
- Only one transform may stream at a time; a new transform aborts the in-flight one.

## [0.1.1] - 2026-05-18

Patch release covering the first round of post-publication audit remediation and PR review fixes. No new user-facing features; the focus is correctness, hardening, and contributor-experience tooling.

### Added

- **Lint:** Biome 2.4.15 wired in as the linter/formatter, with `npm run lint` (write) and `npm run lint:ci` (check), and a Biome step in CI that runs before typecheck.
- **Doc lint:** `markdownlint-cli2` step in CI catches markdown drift across all of `docs/**/*.md` (internal plan files under `docs/plans/` excluded) plus `README.md` and `CHANGELOG.md`.
- **Link check:** `lycheeverse/lychee-action` step in CI verifies external links in the public docs with a tuned `.lychee.toml`.
- **Tests:** `tests/session.test.ts` covers `initSession` end-to-end — lifecycle, streaming, abort, toggle, concurrency, and history bounds (24 tests). `tests/docs-config.test.ts` keeps `.env.example.json` and `docs/configuration.md` in sync.
- **Architecture docs:** `docs/architecture.md` gained a session lifecycle section and ADR entries.
- **Dev tooling:** `.nvmrc` pins Node 20 for contributors.
- **Type surface:** `ToggleMessage` exported from `src/background/handler.ts` for protocol type safety across the worker/content-script boundary.

### Changed

- **TypeScript strict mode** is on across the project; tsconfig now also type-checks `tests/**/*.ts`.
- **Session module** extracted from `content.ts` into `src/session.ts` with a typed `LanguageModelSession` interface; `content.ts` is now a thin DOM bootstrap that delegates to `initSession`.
- **History eviction:** `saveHistory` caps stored history at `MAX_HISTORY = 200` entries, and the in-memory session array is now bounded at the same cap on both push and restore.
- **Coverage thresholds** raised from `branches: 70` to `branches: 80`. `lines/statements/functions` remain at 75.
- **Doc drift:** D1-D5 (model defaults, ORT path, host permissions), G1-G4 (missing context for the WASM-only / WebGPU story, qwen experiments), and C1/S1-S3 (config and structure references) corrected. `docs/privacy.md` now lists `cdn.jsdelivr.net` in the outbound egress section. `docs/testing.md` drops the brittle "sits at 100%" claim. `docs/contributing.md` clarifies the coverage gate.
- **Build hygiene:** `onnxruntime-web` declared as an explicit `devDependency`; `.gitignore` extended for IDE / OS artifacts and the local `.claude/skill-runs.json` audit manifest.

### Fixed

- **Streaming UX:** the typing-indicator dots no longer linger in the model bubble when the stream closes with zero chunks (regression test added).
- **Reader leak:** the streaming `ReadableStreamDefaultReader` is now released in a `finally` so an error mid-stream can't leave the lock held.
- **Silent storage failures:** `chrome.storage.local.set` rejections from `persist()` are surfaced via `console.error` instead of being swallowed.
- **Stream perf chatter:** per-chunk `console.log` removed from the hot path.
- **CI scope:** typecheck now sees the test suite (was previously `src/`-only); markdown lint uses a recursive glob so future nested user docs are caught without a CI tweak.

### Security

- `makeTypingIndicator` constructs DOM via `createElement` instead of `innerHTML` — defense in depth even though the prior input was a static literal.

### Removed

- Stale ESLint directive in `vendor/prompt-api-polyfill/prompt-api-polyfill.d.ts` (the project lints with Biome, and `vendor/` is excluded from Biome anyway).
- Dead `if (!root) return` guard in the toggle listener — unreachable under strict mode where `root: HTMLElement` is non-nullable.

## [0.1.0] - 2026-05-17

First public-ready cut. The extension was already working end-to-end on `main`; this release wraps it in documentation, tests, and CI so it can take outside contributors.

### Added

- **Docs:** Root `README.md` with hero image, status badges (CI, Chrome MV3, runs-locally, TypeScript, Vitest, Apache-2.0), and a docs index. `docs/` covers architecture, development, configuration, models, privacy, prompt-API polyfill, testing, and contributing.
- **License:** Apache-2.0. The vendored polyfill under `vendor/prompt-api-polyfill/` remains Apache-2.0 © Google LLC.
- **Config:** `.env.example.json` so a fresh clone can build — `.env.json` is gitignored.
- **Testing:** Vitest + jsdom unit suite under `tests/`. 27 tests covering history persistence, page-context builder, message rendering, button state, system instruction, and the background command handler. v8 coverage thresholds enforced at 75% lines/statements/functions, 70% branches (currently 100% on `src/`).
- **CI:** GitHub Actions workflow (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, coverage (with thresholds), and a build smoke test on push and pull request.
- **Release:** Changelog-driven release workflow (`.github/workflows/release.yml`) — pushing a new `## [X.Y.Z]` header to `main` tags and publishes a GitHub release with the extracted notes.

### Changed

- **Refactor:** Pure logic extracted from `content.ts` / `background.ts` into `src/` modules (`history`, `pageContext`, `system`, `ui/messages`, `ui/state`, `background/handler`). Entry files are now thin DOM bootstraps that import from `src/`. Behavior is unchanged.
- **Build hygiene:** `tsconfig.json` now includes `src/**/*.ts`; `package.json` adds `typecheck`, `test`, `test:watch`, and `coverage` scripts.
