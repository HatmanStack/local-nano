# Phase 0: Foundation

This file is the law for Phases 1 through 5. Every implementation choice in a
later phase must be consistent with the decisions captured here. Estimated
tokens: ~9,000.

## Project Conventions

Inherited from `CLAUDE.md`, the Claude Code memory index, and the current
codebase. Do not contradict any of these in a later phase.

### Toolchain

- **Package manager:** npm. Not pnpm, not yarn. `package-lock.json` is
  authoritative.
- **Node:** version pinned in `.nvmrc` (currently 20). Use `nvm use` before
  running commands.
- **TypeScript:** strict mode is on (see `tsconfig.json`). All new code must
  type-check without `any` escape hatches except where existing code already
  uses them (the codebase casts `chrome`/`navigator`/`window` shapes through
  `unknown` rather than `any`; follow that pattern).
- **Linter / formatter:** Biome 2.4.15. Run `npm run lint` (autofix) during
  development and `npm run lint:ci` before commit. Rules of note: 2-space
  indent, single quotes, trailing commas, semicolons required, 100-char line
  width. `vendor/`, `dist/`, `coverage/`, `node_modules/`, `.claude/` are
  excluded from Biome.
- **Test runner:** Vitest + jsdom. Coverage thresholds enforced at 75 percent
  lines/statements/functions and 80 percent branches, measured on `src/**/*.ts`
  only (see `vitest.config.ts`). Files at the repo root (`offscreen.ts`,
  `background.ts`, `content.ts`) are NOT in the coverage include set, so logic
  that must be unit-tested belongs under `src/`.
- **Build:** `node build.mjs` (esbuild). Three entry points: `content.ts`
  (IIFE), `background.ts` (ESM module worker), `offscreen.ts` (IIFE). Any new
  module under `src/` is bundled into whichever entry imports it. The build
  also copies the ONNX runtime files and `offscreen.html` into `dist/`.

### Commands

| Task | Command |
| ---- | ------- |
| Install | `npm ci` |
| Type-check | `npm run typecheck` |
| Test | `npm test -- --run` |
| Single test file | `npx vitest run tests/<name>.test.ts` |
| Coverage | `npm run coverage` |
| Build | `npm run build` |
| Lint (autofix) | `npm run lint` |
| Lint (CI) | `npm run lint:ci` |

Run all five (`typecheck`, `test`, `build`, `lint:ci`, and `coverage` when a
phase adds testable `src/` code) locally before each commit.

### Git workflow

- Conventional commits. Allowed types: `feat`, `fix`, `refactor`, `test`,
  `docs`, `chore`. Scope encouraged (e.g. `feat(resilience): …`).
- Atomic commits. One logical change per commit. Each phase enumerates its
  commit boundaries with templates.
- **No `Co-Authored-By` lines.** No `Generated-By` lines. No emojis in commit
  messages.
- **No `--amend`.** Always create a new commit. A pre-commit hook failure gets
  a NEW commit after the fix, never an amendment.
- **Never `--no-verify`.** Never skip or bypass hooks.
- The plan is branch-agnostic. Do not switch branches without explicit user
  instruction. Verify the branch with `git branch --show-current` before
  committing.

### Writing style (comments, docs, commit messages)

- No em dashes. Use commas, periods, semicolons, or parentheses.
- No filler. No fake enthusiasm. No emojis. No exclamation marks.
- Direct and factual. State facts, give instructions, move on.

### Markdown lint (any docs touched)

- Fenced code blocks need a language tag (` ```text `, ` ```bash `,
  ` ```json `, ` ```typescript `). Never bare fences.
- Headings must not end with punctuation.
- Ordered lists use `1.` for every item.
- Blank lines required before and after headings, code blocks, and lists.

### Docs drift guards (enforced by `tests/docs-config.test.ts`)

- **Every new `tests/<name>.test.ts` file MUST be added to the test-file table
  in `docs/testing.md`** in the same commit, or `tests/docs-config.test.ts`
  fails. The table row format is the file path in backticks plus a short
  "Covers" description.
- If a phase changes the default `modelName` in `.env.example.json`, the same
  string must appear verbatim in `docs/configuration.md` or the cross-reference
  test fails. (No phase here changes the default model; see ADR-R8.)

## Non-negotiable Constraints (from the seed and post-mortems)

These are the failure modes that shaped this feature. Any design choice that
contradicts them is a planning defect.

1. **Single `LanguageModel` session, always.** The offscreen document holds one
   session built by `LanguageModel.create()` in `ensureSession()` (`offscreen.ts`
   lines 116-132). v0.2.0 was reverted for `VK_ERROR_OUT_OF_DEVICE_MEMORY` from
   a second concurrent session. The fallback ladder must `destroy()` the prior
   session and clear `sessionPromise` BEFORE creating the next tier. Never
   overlap two loads.
1. **Recovery is automatic on LOAD, manual on STREAM.** A model-load failure
   auto-walks the ladder. A mid-stream or terminal RUNTIME crash shows a message
   plus a manual Retry and never auto-rebuilds. The stream handler at
   `offscreen.ts` lines 379-399 keeps the session alive on stream error on
   purpose; that stays. Do not reintroduce the removed zero-chunk auto-rebuild.
1. **Vendored polyfill is upstream.** All work goes through its public surface:
   `LanguageModel.create(options)` (including the `monitor` option), the
   session's `promptStreaming`, `measureContextUsage`, and `destroy`. Do NOT
   patch any file under `vendor/prompt-api-polyfill/`.
1. **100 percent on-device and private.** The only network use is the one-time
   HF weights download. The diagnostic is copy-only; nothing leaves the device
   automatically.
1. **Text-in/text-out only.** No image input/output.
1. **A model load can HARD-CRASH the offscreen document.** A page crash is not a
   catchable JS throw. Detection must be client-side (port/message death);
   recovery must recreate the document.
1. **CI cannot exercise WebGPU.** The real polyfill, transformers, and WebGPU
   never load under test. Every testable seam must be a pure module under `src/`
   driven by mocks. WebGPU-dependent behavior is verified only by manual smoke
   and is called out per-phase as manual-only.

## Architecture Decision Records

### ADR-R1: Ladder orchestration lives panel-side, state in chrome.storage

A SIGILL-class crash kills the offscreen document before it can report which
tier failed, so the orchestration (which tier to try next, recording the
known-good/known-bad tier, driving the force-recreate) must run in a context
that survives the crash. The panel (`src/session.ts`) drives the ladder; the
durable record lives in `chrome.storage.local`. The offscreen document only
loads the tier it is told to load and reports success or a catchable failure;
it does not own the ladder. The service worker owns only the document lifecycle
(ensure/recreate). Rationale: the panel already runs the warmup and renders
failure UI; centralizing ladder state there keeps one source of truth.

### ADR-R2: Runtime tier override via window.TRANSFORMERS_CONFIG, not file edits

The polyfill reads `globalThis.TRANSFORMERS_CONFIG` fresh inside every
`create()` call (`prompt-api-polyfill.js` `#getBackendInfo` at lines 188-204
reads `win[b.config]`; the offscreen import has no `__window`, so `win` is
`globalThis`). The transformers backend reads `config.modelName`,
`config.device`, and `config.dtype` in its constructor
(`backends/transformers.js` lines 53-56) on each new backend instance built per
`create()`. Therefore a runtime tier change is performed by overwriting
`window.TRANSFORMERS_CONFIG` with the new `{ modelName, device, dtype }` in the
offscreen document IMMEDIATELY BEFORE the next `LanguageModel.create()`. The
static `.env.json` import at `offscreen.ts` line 83 supplies the BASE tier
(tier 0); ladder tiers override it in memory only. Never edit `.env.json` or
`.env.example.json` at runtime.

### ADR-R3: destroy() does not free the ONNX generator; the ladder must recreate the document between rungs that may crash

The polyfill `destroy()` (`prompt-api-polyfill.js` lines 597-601) only sets a
`#destroyed` flag and nulls `#history`; it does NOT tear down the transformers
generator/ONNX session held by the backend instance. A fresh `create()` builds
a NEW backend with a NEW generator, so the prior generator's GPU memory is only
reclaimed when the offscreen document itself is torn down. Consequence for the
ladder: a soft tier change (calling `destroy()` then `create()` inside the same
live document) is acceptable ONLY when the prior tier loaded successfully and
we are deliberately switching (rare). The normal ladder advance happens AFTER a
tier crashes or fails to load, in which case the document is gone or
GPU-poisoned, so the ladder advances by force-RECREATING the offscreen document
(ADR-R4) and loading the next tier into the fresh document. Never start a
second `create()` while a prior generator is still resident.

### ADR-R4: Force-recreate resets the sticky documentReady and recreates the document

`rebuildSession` only rebuilds the polyfill session inside a LIVE document; it
cannot recover a document that itself crashed. Recovery adds a dedicated SW
"recreate" path that calls `closeOffscreen()` (which already resets
`documentReady` and `createInFlight`, lines 66-73) then `ensureOffscreen()`.
The design must NOT depend on `chrome.offscreen.hasDocument()` accurately
reporting a crashed document as gone (open question 3; favor an explicit reset
regardless). Because `offscreenAlreadyExists()` (lines 29-43) trusts the sticky
`documentReady`, the recreate path forces the reset by going through
`closeOffscreen()` first. `closeDocument()` on an already-gone document may
reject; the recreate path swallows that rejection and proceeds to
`createDocument()`. The recreate message also carries the tier to load so the
fresh document loads the right tier (Phase 2+); in Phase 1 it carries no tier
and the document loads the base tier on first use.

### ADR-R5: Terminal-vs-transient classification is a pure, exported seam

Crash detection happens client-side by inspecting the failure: a port
disconnect with a crash-shaped `lastError` reason, a `message channel closed`
runtime error, an ensure/recreate rejection, or a warmup rejection. The
decision "is this terminal (document died, recreate required) vs transient
(retryable in place)" is extracted into a pure function in a new
`src/offscreen/failure.ts` module so it is unit-testable without Chrome. It
takes an error/string and returns a classification enum. `src/session.ts` and
`src/offscreen/stream-client.ts` consume it. This mirrors the existing
pure-seam pattern (`src/offscreen/dispatch.ts`, `src/offscreen/busy-gate.ts`).

### ADR-R6: The ladder state machine is a pure reducer in src/offscreen/ladder.ts

The ladder (which tier comes next, recording known-good/known-bad, deciding
"terminal: give up" when exhausted) is a pure state machine in a new
`src/offscreen/ladder.ts` module: it takes the current ladder position plus a
last-attempt outcome and returns the next action (`load <tier>`, `done`, or
`exhausted`). It has no Chrome, polyfill, or timer dependency, so it is fully
unit-testable. The panel wires the reducer to the real transport (warmup,
recreate, persistence). Tier definitions (the ordered tier list per model) live
here as data.

### ADR-R7: Tier definition and persistence schema

A **tier** is `{ modelName: string; device: 'webgpu' | 'wasm'; dtype: string }`.
The ordered ladder for the primary model (ADR-R8) is, in order:

1. `gemma-4-E2B-it-ONNX` / webgpu / q4f16 (tier 0, the base from `.env.json`)
1. `gemma-4-E2B-it-ONNX` / webgpu / q8
1. `gemma-4-E2B-it-ONNX` / webgpu / fp16
1. `gemma-4-E2B-it-ONNX` / wasm / q8

Then, if all primary tiers fail and the smaller-model rung is enabled (ADR-R8),
the smaller model's own short ladder runs; if that also exhausts, the ladder
returns `exhausted`.

Persistence (Phase 2) uses a single new `chrome.storage.local` key
`local-nano:capability:v1`, DISTINCT from the per-URL history keys
(`local-nano:history:<origin><pathname>`). Shape:

```json
{
  "schemaVersion": 1,
  "extensionVersion": "0.2.4",
  "knownGood": { "modelName": "…", "device": "webgpu", "dtype": "q4f16" },
  "knownBad": [{ "modelName": "…", "device": "webgpu", "dtype": "q4f16" }],
  "capability": { "device": "webgpu", "isFallback": false, "maxBufferSize": 4294967296 }
}
```

Invalidation: the record is ignored (treated as absent) when `schemaVersion`
does not match the current code constant OR when `extensionVersion` does not
match `chrome.runtime.getManifest().version`. A version bump therefore
re-walks the ladder from the top, which is the safe default after a runtime or
model change. A "reset/re-detect" control (Phase 2) deletes the key. Cold start
with a valid `knownGood` skips straight to that tier; `knownBad` tiers are
skipped on the walk.

### ADR-R8: Primary model stays; smaller model is a flagged hook, not a live default

The primary model is unchanged: `onnx-community/gemma-4-E2B-it-ONNX` at webgpu
q4f16 (the current `.env.json` default; do not change `.env.json` or
`.env.example.json`, which keeps `tests/docs-config.test.ts` green). The
capability-selection logic and the smaller-model ladder rung are BUILT and
unit-tested in Phase 3, but the actual smaller-model identity is held behind a
build-time flag `SMALLER_MODEL_ENABLED = false` and a config constant. CI
cannot exercise WebGPU, and the polyfill's own default smaller model
(`onnx-community/gemma-3-1b-it-ONNX-GQA`) is flagged in `docs/models.md` as a
WASM trap, so no unvetted model ships as a live fallback. The documented
candidate is `onnx-community/Qwen2.5-0.5B-Instruct` (the vetted WASM-tier model
in `docs/models.md`); Phase 3 records it as the candidate constant but leaves
the flag off, with a clearly-marked manual-vetting task. Enabling the flag is a
follow-up that requires manual WebGPU smoke vetting.

### ADR-R9: Capability classification thresholds

Phase 3 adds a pure `classifyCapability(info: GpuInfoSnapshot)` returning
`'capable' | 'weak'`, reusing the existing `getGpuInfo` snapshot
(`device`, `isFallback`, `maxBufferSize`). Thresholds, documented here as the
decision:

- `device === 'wasm'` → `weak` (CPU path; the smaller model is the right pick
  when the rung is enabled).
- `device === 'webgpu'` and `isFallback === true` → `weak` (software fallback,
  heavily constrained).
- `device === 'webgpu'`, not fallback, `maxBufferSize !== null` and
  `maxBufferSize < 1 GiB` (`1024 * 1024 * 1024`) → `weak`. This cutoff aligns
  with the existing `preflightWarning` threshold in `src/session.ts` (line 105),
  keeping one capability boundary in the codebase.
- Otherwise (`maxBufferSize >= 1 GiB`, or `null` on a non-fallback adapter) →
  `capable`. A `null` buffer size on a real adapter is treated optimistically as
  capable because the ladder will catch a genuine failure.

`classifyCapability` only selects the STARTING tier when the smaller-model rung
is enabled (ADR-R8). While the flag is off it has no behavioral effect beyond
the diagnostic; it is still unit-tested.

### ADR-R10: Progress relay over a dedicated long-lived port

Phase 4 relays `downloadprogress` from the offscreen document to the panel over
a NEW dedicated long-lived port `STREAM_PROGRESS_PORT` (a new constant in
`protocol.ts`), separate from the stream port and the one-shot warmup
`sendMessage`. The warmup `sendMessage` round-trip has no push channel, so a
port is required for incremental progress. The offscreen side passes a
`monitor` callback into `LanguageModel.create()` (the polyfill dispatches
`downloadprogress` ProgressEvents with `loaded`/`total` on the monitor
EventTarget, `prompt-api-polyfill.js` lines 437-503). Each event is forwarded as
a `ProgressFrame { type, loaded, total }`. The panel maps a real fraction to
"Downloading model NN%", then to "Loading into GPU…" (indeterminate, elapsed
counter) once `loaded` reaches `total` but the session has not yet resolved. The
fraction parsing (`loaded`/`total` to a clamped 0-100 integer, monotonic) is a
pure exported function in `src/offscreen/progress.ts`, unit-tested without
Chrome.

### ADR-R11: Diagnostic is a pure builder, copy-only

Phases 1 and 5 build the diagnostic as a pure `buildDiagnostic(input)` function
in a new `src/offscreen/diagnostic.ts` module returning a plain string. Phase 1
ships a minimal version (device, isFallback, maxBufferSize, active tier, error
class plus message, extension version). Phase 5 enriches it (ladder path taken,
chosen model, Chrome/UA version) and adds an always-available panel affordance
that copies to clipboard via `navigator.clipboard.writeText` with a synchronous
`document.execCommand('copy')` fallback for restricted contexts. Nothing is ever
auto-sent. The builder takes a typed input object so it is unit-tested without
Chrome; the panel supplies the live values.

## Testing and Mocking Strategy

- The real polyfill, transformers, and WebGPU never load under test. Every new
  decision module (`failure.ts`, `ladder.ts`, `progress.ts`,
  `diagnostic.ts`, `capability.ts`) is a pure `src/` module with no Chrome
  import, unit-tested directly.
- Chrome-touching code (the SW recreate path, the progress-port relay, the
  panel ladder wiring) is tested through the existing mocks in `tests/setup.ts`:
  `FakePort` (drive `_emit`, `_emitDisconnect`), `FakeStorageArea`
  (`chrome.storage.local`), and `chromeMock` (`runtime.sendMessage`,
  `offscreen.createDocument/closeDocument/hasDocument`). `tests/setup.ts` resets
  all mocks in `beforeEach`.
- `src/session.ts` is tested via `initSession(deps)` with DOM elements created
  in jsdom and the offscreen client `vi.mock`-ed, exactly as
  `tests/session.test.ts` already does. New panel behaviors (terminal message,
  Retry button, progress text) are asserted by inspecting the rendered DOM and
  driving the mocked client's resolve/reject.
- Each phase states explicitly which parts are unit-testable vs manual-smoke
  only. The WebGPU load itself, real download progress, and a real document
  crash are manual-smoke only.
- Coverage thresholds (75/75/75 lines/statements/functions, 80 branches on
  `src/`) must stay green. New pure modules carry their own focused tests, which
  comfortably clears the bar.

## Glossary

- **Tier:** one `{ modelName, device, dtype }` triple the ladder can attempt.
- **Ladder:** the ordered list of tiers, walked top-down on load failure.
- **Terminal failure:** the document crashed or the ladder is exhausted; needs
  a force-recreate and/or a terminal user message.
- **Transient failure:** a retryable in-place failure (e.g. a network blip on
  the weights download) that does not require recreating the document.
- **Force-recreate:** `closeOffscreen()` then `ensureOffscreen()` driven from
  the SW, resetting the sticky `documentReady`.
- **Known-good / known-bad tier:** persisted per-device records so cold start
  skips to a working tier and avoids a deterministically crashing one.
