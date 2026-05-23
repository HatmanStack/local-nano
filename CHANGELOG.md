# Changelog

All notable changes to local-nano will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.4] - 2026-05-23

Polishes the selection-rewrite UX and prepares the first Chrome Web Store submission. An earlier automatic GPU-OOM "guard" (zero-chunk-as-failure + session teardown + rebuild-and-retry) was removed: on a memory-constrained adapter the session churn tended to make out-of-memory worse, not better. The session now loads once and is never auto-destroyed; GPU errors surface plainly instead.

### Added

- **Model preloads when the panel opens.** Previously the first message ate the 30–90s WebGPU upload. Now opening the panel (Ctrl/Cmd+Shift+K) kicks off the load in the background with a live "Loading…" indicator (bouncing dots + an elapsed counter); the input stays editable while the Send button is gated until the model is ready. The preload is best-effort — if it fails it degrades quietly to lazy loading on the first message rather than raising an alarm, and the load is never killed on a timer.
- **Proactive "Clear conversation" warning.** The panel tracks how large the conversation has grown and warns before the next turn is likely to exhaust VRAM, with a one-click button to reset the session. The warning threshold is derived per-session from the actual WebGPU adapter (or `device` / an optional `historyTokenWarnThreshold` in `.env.json`).
- **Undo / Accept on rewrites.** A finished rewrite now offers both Undo (restore the original text) and Accept (commit and reset selection state for the next edit), instead of Undo alone.
- **Brand icon** (`icons/`) and an `npm run package` step that zips a Web-Store-ready upload (manifest + `dist/` + icons).

### Changed

- Reduced requested permissions to `["storage", "offscreen"]`. Removed `activeTab` and `scripting` (the declarative `<all_urls>` content script already grants the page access the extension uses; nothing calls the `chrome.scripting` API) and the `cdn.jsdelivr.net` host permission (ONNX Runtime WASM loads from the bundled `dist/ort/`, never jsdelivr).

### Removed

- The automatic GPU-OOM guard: zero-chunk streams are no longer treated as failures, the offscreen session is no longer torn down on a stream error, and the chat/rewrite paths no longer rebuild-and-retry on a device-loss-shaped error. A failed turn now shows its error plainly. Manual recovery is still available via the "Clear conversation" button.

### Fixed

- Highlighting text then clicking into the chat input no longer drops the selection — focus-shift `selectionchange` events are ignored so the captured snapshot survives.

### Notes

- All inference still runs on-device; the only network access remains the one-time model-weights download from Hugging Face. No new permissions touch the network beyond what 0.2.2 already declared (and jsdelivr was dropped).
- See [docs/chrome-web-store.md](docs/chrome-web-store.md) for the submission checklist and permission justifications.

## [0.2.3] - 2026-05-19

Restores selection-driven in-place rewrite, designed against the memory budget that killed v0.2.0. Highlight prose, type an instruction into the chat input, and the model rewrites the selection in place while tokens stream. A single-level Undo button on the resulting chat bubble restores the original text. Pressing Esc inside the input toggles to "Ask about selection" mode, which quotes the selection into a normal chat prompt without mutating the DOM.

The feature reuses the v0.2.2 offscreen `LanguageModel` session; no second model is loaded into WebGPU. Selection payload is hard-capped at ~700 chars. The polyfill's 2048-token output ceiling is unchanged; a prompt-side soft cap computed from the input token count keeps real-world rewrite outputs bounded.

### Added

- `src/selection-rewrite.ts` — snapshot capture, prompt builders, in-place streaming into the captured `Range`, single-level undo.
- New `count` channel in the offscreen protocol (`src/offscreen/protocol.ts`) and `countTokens()` export in `src/offscreen/client.ts`, racing the polyfill round-trip against a 100ms timeout with a `chars/3` heuristic fallback.
- Esc-toggled "Ask about selection" mode that quotes the selection without mutating the DOM.
- `docs/transform.md`.
- New tests: `tests/selection-rewrite.test.ts`; extensions to `tests/offscreen-protocol.test.ts`, `tests/offscreen-client.test.ts`, and `tests/session.test.ts`.

### Changed

- `src/session.ts` — selection-aware placeholder swap, Esc handler, rewrite send path, undo button on the model bubble.
- `content.ts` — installs the `selectionchange` listener and the selection-preview chip.
- `package.json` and `manifest.json` version bumped 0.2.2 → 0.2.3.

### Notes

- The chat session and selection-rewrite share one `LanguageModel` instance by design; the v0.2.0 OOM root cause is foreclosed by construction.
- `<input>`, `<textarea>`, and `contenteditable` regions are still unsupported. Queued for v0.3.0.
- **Verification status:** the unit + integration suite (200+ tests, all passing under Vitest + jsdom with a mocked offscreen client) covers the selection-rewrite plumbing end-to-end. The in-browser smoke test against a real WebGPU-backed Gemma session was deferred for this release — open the unpacked extension and run the steps in `docs/transform.md#how-to-use` against a public article before treating the happy path as proven.

## [0.2.2] - 2026-05-19

Moves the on-device `LanguageModel` session out of the content script and into a hidden offscreen document, so the model loads once and is shared across tabs/pages instead of reloading WebGPU on every navigation. Per-URL chat history continues to live in `chrome.storage.local`; the polyfill session is the shared resource.

Adds explicit recovery for WebGPU device loss. When the offscreen doc loses its GPU device — typical after a tab/window switch — the polyfill swallows the underlying ONNX Runtime Web error and closes the stream with zero chunks. The offscreen layer now treats zero-chunk results as failure and tears the session down; the chat layer catches the failure, re-seeds a fresh session with the persisted conversation, and retries the prompt once. The user sees "GPU device lost — restoring session…" instead of an empty bubble and the conversation resumes in place.

### Added

- `offscreen.html` / `offscreen.ts` — hidden offscreen document that hosts the polyfill session and streams tokens over a `chrome.runtime.Port`.
- `src/offscreen/protocol.ts` — wire types for `ENSURE_OFFSCREEN_*`, `STREAM_*`, and `REBUILD_SESSION_*` messages.
- `src/offscreen/client.ts` and `src/offscreen/stream-client.ts` — content-script-facing client and the context-agnostic port-streaming helper it shares with the service worker.
- `src/background/offscreen.ts` — service-worker side of the offscreen lifecycle (idempotent `ensureOffscreen`, dedupe of concurrent calls).
- One-shot device-loss retry path in `src/session.ts`, including a transient "restoring session" hint.

### Changed

- `manifest.json` — adds the `offscreen` permission and a `content_security_policy` allowing `wasm-unsafe-eval` (required for ONNX Runtime Web's WebAssembly).
- `manifest.json` version bumped 0.1.1 → 0.2.2 to catch up with `package.json` (the 0.2.1 revert bumped one but not the other).
- `src/session.ts` — drops its direct polyfill imports; streams through the offscreen client.

### Notes

- Same model, same UX surface as 0.2.1; the change is architectural. No new commands, no new menus.
- Cross-URL conversation continuity is still scoped to the offscreen session's lifetime — the polyfill session is shared, but UI history switches per URL.

## [0.2.1] - 2026-05-18

Reverts the entire v0.2.0 DOM-aware-actions release. The feature was too ambitious for the in-browser GPU memory budget: spinning up a second `LanguageModel` session for every right-click action on top of the long-lived chat session pushed WebGPU into `VK_ERROR_OUT_OF_DEVICE_MEMORY` cascades during normal use. The tree is reset to the v0.1.1 baseline (chat-only, one model session per tab).

The rewrite-selection capability is on the roadmap and will return in a future iteration designed against the memory budget — likely by reusing the chat session for transforms rather than allocating a parallel one, and by capping `max_new_tokens` per-call.

### Removed

- All v0.2.0 surface area: `chrome.contextMenus` registration, `ask_about_selection` / `rewrite_selection` / `translate_selection` keyboard commands, `runTransform` ephemeral sessions, the Preview component, the dom-apply layer, the selection-capture layer, and `docs/dom-actions.md`.
- `src/transform-prompts.ts`, `src/transform.ts`, `src/dom-actions.ts`, `src/dom-apply.ts`, `src/ui/preview.ts`, `src/background/menus.ts`, and `src/heavy.ts` (the heavy-loader factored out for v0.2; the lazy import moves back inline into `src/session.ts`).
- `SessionHandle` surface on `initSession` — the chat-only build doesn't need `openPanel` / `prefillAndSend` / `mountPreview`.

### Notes

- The v0.2.0 GitHub release and tag remain published. Anyone who pinned v0.2.0 still has it; this release just rolls `main` back to a stable baseline.
- `package.json` version bumped 0.1.1 → 0.2.1 to match the changelog; semver-wise this is a backwards-incompatible removal under a 0.x version, which is the intended signal.

## [0.2.0] - 2026-05-18

First feature release. v0.1.x was a chat panel that opened on a hotkey and read the page body as a single excerpt. v0.2 makes the extension DOM-aware: right-click on a selection (or hit a hotkey) to ask, rewrite, or transform that selection in place. All inference still runs on-device.

> **Reverted in [0.2.1]** — GPU memory pressure from double-loading the model made this release unstable in practice. See the 0.2.1 notes for the path forward.

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
