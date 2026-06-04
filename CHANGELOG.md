# Changelog

All notable changes to local-nano will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-06-04

Roots out the WebGPU device-loss failure that 0.4.2 caught reactively. Captures the GPUDevice handle through a transparent navigator.gpu monkey-patch in the offscreen document, listens for device.lost, marks the session poisoned, and rebuilds lazily on the next ensure. Pins the offscreen document open while any panel is visible so the 30-second no-port reap cannot close it across a tab switch. Promotes the offscreen's zero-chunk stream completion from a silent ok:true to a typed terminal failure so the existing reactive recovery runs.

### Fixed

- **Layer A: GPUDevice.lost listener.** The offscreen installs a transparent navigator.gpu monkey-patch at module top, captures the GPUDevice the polyfill flows through to, and attaches a .lost handler that marks the offscreen session poisoned and pushes SESSION_POISONED to the service worker. The next ENSURE_OFFSCREEN_REQUEST recreates the offscreen document (when not busy, per ADR-P7) before the user's send is dispatched.
- **Layer B: SW-pinned offscreen port while panels are open.** The content script holds a long-lived port to the SW while the panel is visible; the SW holds a long-lived port to the offscreen while at least one panel-pin port is open. The pin port's existence prevents Chrome's 30-second no-port reap from closing the offscreen document across a tab switch. When a poisoned session is rebuilt, the pin is re-acquired on the fresh document while a panel is still open, so the recreate path never leaves the document unpinned.
- **Layer C: authoritative zero-chunk stream detection.** A natural stream completion with zero tokens now surfaces as STREAM_DONE { ok: false, error: 'no tokens emitted; session may be poisoned' }. classifyFailure classes that as terminal so the existing reactive recovery in src/session.ts re-warms via the serialized primitive and retries the prompt once.
- **Diagnostic.** The Copy diagnostic gains a new deviceLostAt field so future bug reports carry the ISO timestamp of the most recent device.lost event observed in the offscreen.

## [0.4.2] - 2026-06-04

Fixes a "no response" failure that surfaced on ChromeOS integrated GPUs after switching tabs and reopening the panel. When the offscreen document was backgrounded across a tab switch, the WebGPU adapter could be lost; the freshly re-warmed session's first generation then ran on a broken GPU device, ORT threw inside WASM (`undefined.destroy()` on a `GPUBuffer` wrapper), Transformers.js swallowed the throw with a console-only "Generation error", and the stream completed with zero tokens. The panel rendered the benign `(no response — the model returned an empty answer)` fallback, leaving the user no recovery affordance.

### Fixed

- **Poisoned-session recovery on empty-output streams.** A `streamPrompt` that resolves with zero accumulated output (no chunks, no error) is now treated as the same class of recoverable failure the terminal-failure path handles: the offscreen document is dropped, the session re-warmed once via the existing serialized primitive, and the same prompt retried exactly once. If the retry also produces empty output the panel reads `Generation failed — the model state was lost (often a ChromeOS tab-switch quirk). Please try again.` rather than the silent benign fallback. The detection signal is the server-side accumulated stream value, not visible token count, so a reasoning model whose entire reply is a `<think>` block (visible text empty, raw stream non-empty) does NOT trigger a churny retry.

## [0.4.1] - 2026-06-02

Adds a toolbar-icon click as a no-config way to open the panel, so a fresh Chrome Web Store install can toggle Local Nano even when Chrome did not honor the `Ctrl+Shift+K` `suggested_key`. The icon tooltip self-documents: it shows the bound shortcut when one is set, and points users at `chrome://extensions/shortcuts` when not.

### Added

- **Toolbar-icon toggle.** Clicking the Local Nano icon next to the address bar now opens (or closes) the panel via the same `{a:'toggle'}` message path the keyboard command uses; no popup, no extra permissions. The icon tooltip resolves the current `chrome.commands` binding on service-worker startup — "Toggle Local Nano (Ctrl+Shift+K)" when bound, or "Toggle Local Nano — set a shortcut at chrome://extensions/shortcuts" when not.

## [0.4.0] - 2026-05-26

Lets you choose which on-device model to run, and stops holding the model in memory when you're not using it. A new gear/settings popover offers a curated model catalog — pick one and click Load to switch — and the offscreen model is now released after a configurable idle timeout and re-warmed on return, reclaiming the multi-GB WebGPU allocation that previously lived for the entire browser session.

### Added

- **User-selectable model picker.** A gear button in the panel header opens a settings popover listing a curated model catalog. Selection is select-then-Load: clicking a row only marks the choice; the Load button commits it, force-recreating the offscreen document and re-walking the fallback ladder headed by the chosen model. The choice persists in `chrome.storage.local` (key `local-nano:model-pref:v1`) and — unlike the per-device capability record — is NOT invalidated on an extension-version bump, since a model preference is a user choice, not a device fact. No preference set means today's capability-based auto-pick (`onnx-community/gemma-4-E2B-it-ONNX`). The picker chooses the model only; dtype/device stay automatic (the existing load-time ladder steps them capable→lean), and the model rows are keyboard-operable.
- **Curated model catalog.** Three live entries span a both-directions size spectrum: the `onnx-community/gemma-4-E2B-it-ONNX` default (`webgpu/q4f16`, capable), `onnx-community/Qwen3-0.6B-ONNX` (`webgpu/q4f16` with WASM fallback, the small WebGPU option — a reasoning model whose `<think>` block is stripped), and `onnx-community/Qwen2.5-0.5B-Instruct` (`wasm/q8`, the CPU/WASM-only "smallest that answers"). A larger-than-default slot ships gated OFF behind `LARGER_MODEL_ENABLED` (mirroring the existing `SMALLER_MODEL_ENABLED` ladder gate), pending manual WebGPU smoke-vetting; only combinations `docs/models.md` confirms working are ever live.
- **Idle resource release.** The offscreen model (a multi-GB WebGPU session) is now freed after a period of inactivity instead of being held for the whole browser session. A `chrome.alarms` timer — measured from the last generation, so it survives the MV3 service-worker eviction a plain timer would not — fires the service worker, which verifies no generation is in flight (reschedules if one is) and then closes the entire offscreen document, a hard release that actually reclaims VRAM. The offscreen document never closes itself, keeping the worker's readiness flag honest. The next use re-warms: recovery works from the send path (not just panel-open), bounded to a single retry so a dead device cannot spin. The timeout is configurable in the popover — 5 / 15 / 60 min or Never (default 15) — and "Never" disables release for users who would rather keep the model warm.

### Notes

- A model switch and an idle re-warm share ONE serialized teardown+re-warm primitive under a single lock, so two model loads can never overlap (the v0.2.0 `VK_ERROR_OUT_OF_DEVICE_MEMORY` came from concurrent sessions). A failed switch reverts the stored preference so the next session does not boot into a model that never loaded.
- All inference still runs on-device. The only network access remains the one-time model-weights download from Hugging Face; switching to a catalog model not yet cached triggers a one-time download for that model.
- The gated placeholders — the larger-model slot behind `LARGER_MODEL_ENABLED` and the smaller-model ladder rung behind `SMALLER_MODEL_ENABLED` — stay off until a manual WebGPU smoke pass confirms each tier loads and answers. CI cannot exercise WebGPU, so on-hardware behavior (real VRAM reclamation, release-then-return) is gated on the manual smoke matrix.

## [0.3.0] - 2026-05-24

Hardens the model-load path for a wide Chrome Web Store audience. When the model can't load on a device, it now self-heals through a dtype/device fallback ladder, picks a model by device capability, shows real download progress, and — when nothing works — fails with a clear, actionable message and a copyable diagnostic instead of a silent dead panel. Also renames the extension to **Local Nano** to match its branding.

### Added

- **Automatic dtype/device fallback ladder.** On a model-LOAD failure the panel walks `q4f16 → q8 → fp16` on WebGPU, then `q8` on WASM, recreating the offscreen document between rungs so a crashed or GPU-poisoned document never blocks the next attempt and two loads never overlap. The resolved tier is persisted per device (`chrome.storage.local`, key `local-nano:capability:v1`) so a later cold start skips straight to a known-good tier and avoids a deterministically crashing one. Auto-fallback applies only at load time; a mid-stream/runtime error never auto-rebuilds.
- **Capability-based model selection.** The WebGPU adapter (max buffer size / software-fallback) is classified at first load so a smaller model can be chosen for weak devices. The smaller-model rung ships gated off (`SMALLER_MODEL_ENABLED = false`) pending manual WebGPU vetting; the live default remains `onnx-community/gemma-4-E2B-it-ONNX`.
- **Phased first-run download progress.** "Downloading model NN%" driven by the polyfill's real `downloadprogress`, then an indeterminate "Loading into GPU…" phase, relayed from the offscreen document to the panel.
- **Graceful terminal failure + manual recovery.** A model-load crash (the offscreen document can hard-crash, not just throw) is detected client-side and surfaced as an actionable in-panel message with a manual Retry that force-recreates the offscreen document — never the old churny auto-rebuild. A weights-download/network failure gets a distinct, retryable "check your connection" message.
- **Copy-only diagnostic.** An always-available, copyable diagnostic (device, adapter limits, chosen model + active dtype tier, the ladder path taken, error class, extension/Chrome version). Nothing leaves the device — copy-to-clipboard only.

### Changed

- **Renamed to "Local Nano"** in the manifest and the in-panel window header, matching the repo and hero-art branding.

### Fixed

- 4xx HTTP statuses from the weights fetch (e.g. 403 gated, 404 bad id) are permanent for the tier and now advance the ladder rather than looping on a misleading "check your connection"; 5xx remains a retryable network condition.
- The Copy-diagnostic control lives in the panel header instead of overlaying the close button, and clicking it after the extension context is invalidated (reload or auto-update) no longer throws — `chrome.runtime.getManifest()` is read defensively.

### Notes

- **`onnxruntime-web` stays pinned to the dev build `1.26.0-dev.20260416-b7804b056c`** — the exact build `@huggingface/transformers@4.2.0` depends on, so they dedupe to one copy. Stable `1.26.0` was evaluated and rejected for this release: it did not fix the q4 SIGILL, and pinning it would de-duplicate the runtime (transformers keeps its dev pin) and mismatch the bundled `dist/ort/` wasm against the ORT JS transformers actually loads. The pin is intentional; revisit only alongside a transformers upgrade plus a full WebGPU smoke pass.
- All inference still runs on-device; the only network access is the one-time model-weights download from Hugging Face.

## [0.2.4] - 2026-05-23

Polishes the selection-rewrite UX and prepares the first Chrome Web Store submission. An earlier automatic GPU-OOM "guard" (zero-chunk-as-failure + session teardown + rebuild-and-retry) was removed: on a memory-constrained adapter the session churn tended to make out-of-memory worse, not better. The session now loads once and is never auto-destroyed; GPU errors surface plainly instead.

### Added

- **Model preloads when the panel opens.** Previously the first message ate the 30–90s WebGPU upload. Now opening the panel (Ctrl/Cmd+Shift+K) kicks off the load in the background with a live "Loading…" indicator (bouncing dots + an elapsed counter); the input stays editable while the Send button is gated until the model is ready. The preload is best-effort — if it fails it degrades quietly to lazy loading on the first message rather than raising an alarm, and the load is never killed on a timer.
- **Proactive "Clear conversation" warning.** The panel tracks how large the conversation has grown and warns before the next turn is likely to exhaust VRAM, with a one-click button to reset the session. The warning threshold is derived per-session from the actual WebGPU adapter (or `device` / an optional `historyTokenWarnThreshold` in `.env.json`).
- **Undo / Accept on rewrites.** A finished rewrite now offers both Undo (restore the original text) and Accept (commit and reset selection state for the next edit), instead of Undo alone.
- **Brand icon** (`icons/`) and an `npm run package` step that zips a Web-Store-ready upload (manifest + `dist/` + icons).

### Changed

- Reduced requested permissions to `["storage", "offscreen"]`. Removed `activeTab` and `scripting` (the declarative `<all_urls>` content script already grants the page access the extension uses; nothing calls the `chrome.scripting` API) and the `cdn.jsdelivr.net` host permission (ONNX Runtime WASM loads from the bundled `dist/ort/`, never jsdelivr).
- Default `dtype` changed from `q4` to `q4f16` in `.env.example.json`. See the Notes below — the `q4` ONNX kernel hits an illegal-instruction crash in ONNX Runtime Web's WASM SIMD path on some Chrome/Dawn builds; `q4f16` routes through different kernels and avoids it, with slightly better quality (fp16 activations, same 4-bit weights).

### Removed

- The automatic GPU-OOM guard: zero-chunk streams are no longer treated as failures, the offscreen session is no longer torn down on a stream error, and the chat/rewrite paths no longer rebuild-and-retry on a device-loss-shaped error. A failed turn now shows its error plainly. Manual recovery is still available via the "Clear conversation" button.

### Fixed

- Highlighting text then clicking into the chat input no longer drops the selection — focus-shift `selectionchange` events are ignored so the captured snapshot survives.

### Notes

- All inference still runs on-device; the only network access remains the one-time model-weights download from Hugging Face. No new permissions touch the network beyond what 0.2.2 already declared (and jsdelivr was dropped).
- See [docs/chrome-web-store.md](docs/chrome-web-store.md) for the submission checklist and permission justifications.
- **`q4` kernel crash (debugging note).** A model load with `dtype: "q4"` was crashing the offscreen document with a WebAssembly `SIGILL` (illegal instruction) inside ONNX Runtime Web's quantized-matmul SIMD kernel — reproducible in a bare webpage with no extension, so it's upstream of this project (a V8/Dawn codegen issue on the affected device, not our code, the model, or the GPU; raw WebGPU buffer allocation and dependency integrity both checked out). `q4f16` uses different kernels and sidesteps the bad instruction. If `q4f16` ever regresses similarly, `fp16` and `q8` are the next dtypes to try.

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
