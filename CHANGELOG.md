# Changelog

All notable changes to local-nano will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
