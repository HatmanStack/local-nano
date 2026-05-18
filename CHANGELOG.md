# Changelog

All notable changes to local-nano will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
