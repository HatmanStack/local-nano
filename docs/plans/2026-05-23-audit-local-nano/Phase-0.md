# Phase 0: Architecture and Conventions

This phase carries no code. It records the project conventions, the
architecture facts an engineer needs to touch these files safely, the testing
strategy, and the commit format every later phase must follow. Read it before
any other phase.

## Project Conventions

Extracted from the repo, its CLAUDE.md memory pointers, and `.github/`.

### Runtime and package manager

- npm + Node. `package-lock.json` is committed; install with `npm ci`.
- `.nvmrc` pins Node `20`. Local development has run on `v24`; CI currently
  hardcodes `node-version: 20` (Phase-6 switches it to `node-version-file`).
- TypeScript, ES2022, `"type": "module"`. Ships to Chrome 120+, no downlevel
  transpilation.

### Commands

- `npm run build` — one-shot esbuild bundle via `build.mjs` into `dist/`, plus
  an ORT wasm copy into `dist/ort/`.
- `npm run watch` — esbuild watch mode.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — `vitest run` (one-shot).
- `npm run test:watch` — vitest watch.
- `npm run coverage` — `vitest run --coverage`, enforcing the thresholds in
  `vitest.config.ts` (lines/statements/functions 75%, branches 80%).
- `npm run lint` — `biome check --write .` (lint + format, autofix).
- `npm run lint:ci` — `biome check .` (no writes; CI uses this).
- `npm run icons` — `scripts/make-icons.mjs` (ffmpeg downscale of
  `icons/icon-source.png`).
- `npm run package` — `scripts/package.mjs` → `web-store/local-nano-v<ver>.zip`.

Before running typecheck/tests/build locally, run `cp .env.example.json .env.json`
(the heavy entry points statically `import './.env.json'`).

### Tooling and gates

- Biome is the single lint+format authority (`biome.json`). It excludes
  `dist`, `coverage`, `node_modules`, `vendor`, `.claude`. The vendored
  polyfill is therefore NOT linted or formatted by Biome; hand-edit it in its
  existing style (2-space indent, single quotes, semicolons).
- `tsconfig.json` is strict. `tsc --noEmit` must exit 0.
- CI (`.github/workflows/ci.yml`) runs, in order: lint → markdownlint → lychee
  link-check → typecheck → coverage → build. Any step failing fails the build.
- markdownlint config: `.markdownlint.json` / `.markdownlintignore`. lychee:
  `.lychee.toml`. `docs/plans/**` is excluded from both markdownlint and lychee.

### Architectural patterns and constraints

- **Single shared offscreen session, by design.** One long-lived
  `LanguageModel` session lives in the hidden offscreen document
  (`offscreen.ts`), shared across all tabs/URLs. Content scripts stream to it
  over a `chrome.runtime.Port`. Do NOT spawn a second `LanguageModel.create()`
  anywhere; a parallel session was the v0.2.0 WebGPU OOM root cause (memory:
  local-nano project state).
- **Heavy-load duplication is intentional.** `offscreen.ts:11-18` documents
  that a shared `src/heavy.ts` extraction was tried in v0.2 and reverted. Do
  not re-extract it. Preserve the documented rationale.
- **Vendored polyfill is treated as upstream.** `vendor/prompt-api-polyfill/`
  is a slimmed copy of Google's polyfill. Edits to it must be minimal,
  surgical, and clearly commented as local deltas, because they have to be
  re-applied on every upstream resync (`docs/prompt-api.md`). Two phases here
  touch it (abort threading in Phase-5, contextWindow in Phase-5) — both are
  flagged as careful vendored edits.
- **`max_new_tokens` stays at 2048.** Do not raise it. KV-cache growth on a
  constrained GPU is a known failure mode.
- **Cross-context messages are runtime-type-guarded.** Every wire message has a
  predicate in `src/offscreen/protocol.ts` validating shape and finiteness.
  Any new message type follows that pattern.
- **`as unknown` is confined to FFI boundaries** (Chrome globals, polyfill
  module shape). Application logic carries no `any`.

### User preferences (apply to plan prose and commit messages)

- No em dashes, no filler, no emojis, no fake enthusiasm. Direct and factual.
- Delete over preserve; edit existing over create new. Atomic, frequent commits.

## Design Decisions and Rationale (ADRs for this remediation)

### ADR-R1: Cleanup precedes structural fixes

The three duplicated send paths (`sendChat`/`sendAsk`/`sendRewrite`) and the
triple offscreen listeners are edited in IMPLEMENTER phases. Removing dead code
(`system.ts`, `finalize()` no-op) and de-duplicating the button CSS first means
those later edits operate on a smaller surface and the diffs stay legible.

### ADR-R2: Preserve documented architecture; do not revert to helpers

Several eval targets touch the vendored polyfill and the single-shared-session
design. These are deliberate, comment-documented decisions. The fixes extend
them (thread a signal, serialize access) rather than reverting them (no shared
`heavy.ts`, no second session). When a finding's "ideal" conflicts with a
documented decision, the documented decision wins and the finding is satisfied
within it.

### ADR-R3: Context-size source of truth via the polyfill contextWindow

The eval offers two ways to fix the "dead 1,000,000 contextWindow guard":
(a) drive the app warning from real `measureContextUsage` token counts, or
(b) set the polyfill's `contextWindow` to the model's real value so its
built-in overflow event becomes meaningful. `measureContextUsage(input)` in the
vendored polyfill measures only the single passed input, not accumulated
session history, so option (a) would require re-passing the full thread on every
turn (expensive, and couples the app to private polyfill history). This plan
takes option (b): a one-line vendored edit to the `contextWindow` getter to
return a model-real value, plus a documentation note tying the app's advisory
char-heuristic to it. This is the lower-risk change and keeps the app heuristic
as the practical guard it already is.

### ADR-R4: Abort threading is a careful vendored edit

Making "Stop" halt ONNX decoding (not just the consumer loop) requires threading
the caller's `AbortSignal` from the polyfill's `promptStreaming(input, options)`
into `TransformersBackend.generateContentStream(contents)` and onto the
`@huggingface/transformers` `generator(prompt, {...})` call via its
`stopping_criteria` / signal support. This edits two vendored files. It must be
additive and guarded: if the transformers.js version in use does not accept the
signal, the change must degrade to current behavior, never throw. The resync
procedure in `docs/prompt-api.md` is updated in Phase-7 to list this delta.

### ADR-R5: Offscreen entry points stay outside coverage thresholds

`content.ts`, `background.ts`, and `offscreen.ts` are import-time-side-effecting
entries excluded from the coverage `include` (`src/**/*.ts`). The offscreen
test-coverage finding is satisfied by extracting the testable offscreen logic
(message dispatch, gpu-info shaping) into a `src/`-resident, unit-tested helper
where practical, NOT by adding `offscreen.ts` to the coverage set (which would
require an integration harness the project deliberately omits). Where extraction
is not clean, add tests against the already-extracted protocol/client layer.

## Tech Stack

- Language: TypeScript (strict), ES2022 modules.
- Bundler: esbuild (`build.mjs`); `content.ts` → IIFE, `background.ts` and
  `offscreen.ts` → ESM.
- Inference: `@huggingface/transformers` (`^4.2.0`) + `onnxruntime-web` behind
  the vendored Prompt API polyfill.
- Tests: Vitest + jsdom + v8 coverage. Chrome APIs mocked in `tests/setup.ts`
  (`FakeStorageArea`, `FakePort`, `chromeMock`).
- Lint/format: Biome. Docs: markdownlint + lychee in CI.

## Deployment Strategy

Local/desktop only. No server. The artifact is an unpacked MV3 extension loaded
from the repo root (manifest.json lives at root, NOT in `dist/`). Release is
manual: bump `version` in `manifest.json` and `package.json`, `npm run build`,
`npm run package`, upload the zip. There is no automated release pipeline. None
of these phases change the deployment model.

## Shared Patterns and Conventions

- New cross-context message types: add a `const` type tag, request/response
  interfaces (discriminated on `ok`), and an `isX` predicate in
  `src/offscreen/protocol.ts` with finiteness checks. Mirror the existing eight.
- New `src/` modules require a matching `tests/<name>.test.ts` (coverage gate).
- Keep `content.ts` thin: extract logic into `src/` pure helpers that are
  testable; content-script side effects are not.
- Comments encode WHY, not narration. Match the existing density.

## Testing Strategy (including CI mocking)

- Unit tests only. No E2E; WebGPU/offscreen runtime is verified by manual smoke
  test, by deliberate project choice (`docs/testing.md`).
- All Chrome APIs are stubbed in `tests/setup.ts`. Use `chromeMock` and the
  `FakePort` harness for any message-passing test. `store` resets before each
  test.
- The vendored polyfill and `@huggingface/transformers` are never loaded in
  tests; the offscreen client is exercised through `FakePort` and through
  mocked `chrome.runtime.sendMessage`.
- Any vendored-file edit (abort, contextWindow) is covered indirectly: assert
  the app-side behavior (signal forwarded into the request, advisory wording)
  against the mock, since the real generator never runs under Vitest. State the
  manual smoke-test steps in the phase's Testing Instructions.
- Run `npm run coverage` before declaring a code phase done; it must stay green
  at 75/80.

## Commit Message Format

Conventional Commits. One atomic commit per task (or per cohesive sub-change).
Do NOT add a `Co-Authored-By` trailer (user git rule). Do not amend; create new
commits. Subject under ~70 chars, imperative mood.

Format template (each task gives its own filled version):

```text
<type>(<scope>): <imperative summary>

<body: what and why, wrapped ~72 cols>
```

Types used here: `refactor`, `fix`, `feat`, `test`, `docs`, `chore`, `build`,
`ci`. Scopes seen in history: `warmup`, `config`, `guard`. Add scopes as
needed (`offscreen`, `session`, `hygiene`, `docs`, `ci`).

## Phase Verification

This phase is complete when the engineer has read it and can state: the package
manager, the build/test/lint commands, the single-shared-session and
heavy-load-duplication constraints, the vendored-edit caution, and the commit
format. No build or test runs are required for Phase-0.
