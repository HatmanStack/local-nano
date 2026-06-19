# Phase 0: Foundation

This file is the law for Phases 1 through 4. Every implementation choice in a
later phase must be consistent with the decisions captured here. Estimated
tokens: ~10,000.

## Project Conventions

Inherited from the Claude Code memory index for this repo, the prior
model-load-resilience plan's Phase-0, and the current codebase. Do not
contradict any of these in a later phase.

### Toolchain

- **Package manager:** npm. Not pnpm, not yarn. `package-lock.json` is
  authoritative.
- **Node:** version pinned in `.nvmrc` (currently 20). Run `nvm use` first.
- **TypeScript:** strict mode is on (`tsconfig.json`). New code must type-check
  with no `any` escape hatches except where existing code already casts
  `chrome`/`navigator`/`window` through `unknown` (follow that pattern).
- **Linter / formatter:** Biome 2.4.15. Run `npm run lint` (autofix) during
  development and `npm run lint:ci` before commit. 2-space indent, single
  quotes, trailing commas, semicolons, 100-char width. `vendor/`, `dist/`,
  `coverage/`, `node_modules/`, `.claude/` are excluded from Biome.
- **Test runner:** Vitest + jsdom. Coverage thresholds enforced at 75 percent
  lines/statements/functions and 80 percent branches, measured on `src/**/*.ts`
  only (`vitest.config.ts`). Files at the repo root (`offscreen.ts`,
  `background.ts`, `content.ts`) are NOT in the coverage include set, so logic
  that must be unit-tested belongs under `src/`.
- **Build:** `node build.mjs` (esbuild). Three entry points: `content.ts`
  (IIFE), `background.ts` (ESM module worker), `offscreen.ts` (IIFE). Any new
  module under `src/` is bundled into whichever entry imports it.

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

Run `typecheck`, `test`, `build`, `lint:ci`, and `coverage` (when a phase adds
testable `src/` code) locally before each commit.

### Git workflow

- Conventional commits. Allowed types: `feat`, `fix`, `refactor`, `test`,
  `docs`, `chore`. Scope encouraged (e.g. `feat(picker): …`,
  `feat(idle): …`).
- Atomic commits. One logical change per commit. Each phase enumerates its
  commit boundaries with templates.
- **No `Co-Authored-By` lines.** No `Generated-By` lines. No emojis in commit
  messages.
- **No `--amend`.** Always create a new commit. A pre-commit hook failure gets a
  NEW commit after the fix, never an amendment.
- **Never `--no-verify`.** Never skip or bypass hooks.
- The plan is branch-agnostic. Do not switch branches without explicit user
  instruction. Verify the branch with `git branch --show-current` before
  committing.

### Writing style (comments, docs, commit messages)

- No em dashes. Use commas, periods, semicolons, or parentheses.
- No filler. No fake enthusiasm. No emojis. No exclamation marks.
- Direct and factual.

### Markdown lint (any docs touched)

- Fenced code blocks need a language tag (` ```text `, ` ```bash `,
  ` ```json `, ` ```typescript `). Never bare fences.
- Headings must not end with punctuation.
- Ordered lists use `1.` for every item.
- Blank lines required before and after headings, code blocks, and lists.

### Docs drift guards (enforced by `tests/docs-config.test.ts`)

- **Every new `tests/<name>.test.ts` file MUST be added to the test-file table
  in `docs/testing.md`** in the same commit, or `tests/docs-config.test.ts`
  fails. The row format is the file path in backticks plus a short "Covers"
  description.
- If a phase changed the default `modelName` in `.env.example.json`, the same
  string must appear verbatim in `docs/configuration.md`. No phase here changes
  the default model (ADR-P5), so this guard is satisfied unchanged.

## Non-negotiable Constraints (from the brainstorm and post-mortems)

These are the failure modes that shaped this feature. Any design choice that
contradicts them is a planning defect.

1. **Single `LanguageModel` session, always.** The offscreen document holds one
   session built by `LanguageModel.create()` in `ensureSession()`
   (`offscreen.ts`). v0.2.0 was reverted for `VK_ERROR_OUT_OF_DEVICE_MEMORY`
   from a second concurrent session. A model switch and an idle re-warm must
   fully tear down before the next load begins. Never overlap two loads.
1. **MV3 service-worker eviction (~30s idle).** A long inactivity delay cannot
   use an in-SW `setTimeout`; it must use `chrome.alarms`, which Chrome holds and
   which wakes the SW to act. The SW loses in-memory state on each restart, so
   any persistent state lives in storage or in the alarm itself.
1. **`documentReady` staleness.** Only the SW closes the offscreen document, and
   it must reset the sticky `documentReady` flag (which `closeOffscreen()`
   already does). A self-closing document would leave the flag stale and
   re-introduce the sticky-flag silent death the prior plan's Phase 1 fixed. The
   offscreen document never closes itself.
1. **`handleWarmup` ordering.** `loadHeavy()` resets
   `window.TRANSFORMERS_CONFIG` to the base import as part of its one-time init;
   it must run BEFORE the per-tier override or every rung loads the base config.
   Any code path that re-warms (switch, idle re-warm) must preserve the existing
   `handleWarmup` ordering. Do not change that ordering; route every re-warm
   through the existing warmup path.
1. **Vendored polyfill is upstream.** Work through its public surface only
   (`LanguageModel.create(options)`, `promptStreaming`, `measureContextUsage`,
   `destroy`, the `monitor`/`downloadprogress` events). Do NOT patch any file
   under `vendor/prompt-api-polyfill/`.
1. **100 percent on-device and private.** The only network use is the one-time
   HF weights download (cached after first load). A switch to an un-downloaded
   catalog model incurs a one-time download for that model. Nothing else leaves
   the device. The diagnostic stays copy-only.
1. **Text-in/text-out only.** No image input/output.
1. **CI cannot exercise WebGPU.** The real polyfill, transformers, and WebGPU
   never load under test. Every testable seam is a pure module under `src/`
   driven by mocks. Model load, the larger-model gate, and the full
   idle-release/re-warm cycle on real hardware are verifiable only by manual
   smoke test and are called out per-phase as manual-only.

## Architecture Decision Records

These build on the prior plan's ADRs (R1 through R11), which remain in force.
The new ADRs are prefixed `P`.

### ADR-P1: The catalog extends ladder.ts data; the reducer is unchanged

The curated model catalog is new data, not a new state machine. It lives in a
new pure module `src/offscreen/catalog.ts` (no Chrome/polyfill/timer import), and
each catalog entry carries display metadata plus an ordered `Tier[]` ladder for
that model (reusing the existing `Tier` type from `ladder.ts`). The existing
`nextAction`/`firstTierIndex` reducer in `ladder.ts` is model-agnostic and needs
no change: it walks whatever `Tier[]` it is handed. Phase 2 wires the chosen
model's ladder into `assembleLadder` so the chosen model heads the ladder.
Rationale: the reducer already operates on any `Tier[]`; adding a catalog is a
data extension, keeping one ladder engine.

### ADR-P2: A model is non-gated only with a clean docs/models.md-vetted tier; everything unvetted is gated, off

A catalog entry is non-gated (always listed, live on every device) ONLY when
`docs/models.md` confirms it has a clean, currently-preferred working tier. Two
entries qualify:

- `onnx-community/gemma-4-E2B-it-ONNX` (the default), `webgpu/q4f16` (the current
  `.env.json` tier).
- `onnx-community/Qwen2.5-0.5B-Instruct`, `wasm/q8` only (the "smallest model that
  actually answers", the WASM-tier default in `docs/models.md`). This is the same
  model `ladder.ts` already names as `SMALLER_MODEL_CANDIDATE`.

Every other candidate is gated behind a build-time flag that ships OFF, read
through a function seam mirroring the existing `SMALLER_MODEL_ENABLED` /
`isSmallerModelEnabled()` precedent in `ladder.ts`. There are two gated groups:

- `LARGER_MODEL_ENABLED = false`: models LARGER than gemma-4-E2B. The specific
  candidate is a planning/vetting-time decision (open question 1).
- `QWEN3_08B_ENABLED = false`: `onnx-community/Qwen3.5-0.8B-ONNX`. It is GATED, not
  live, because `docs/models.md` shows it has NO clean, currently-preferred
  WebGPU tier: `webgpu/q4f16` fails numerically (line 99), `webgpu/q4` only
  "worked historically" and carries the `q4` SIGILL caveat the project
  deliberately moved off for the primary model (lines 100-102, CHANGELOG 0.2.4),
  and every WASM quantized variant fails on `GatherBlockQuantized` (lines 97-98)
  with only the slow per-component path working. It is retained as a gated
  smoke-vetting target (mirroring how `SMALLER_MODEL_CANDIDATE` carries an
  unvetted WebGPU tier) so the both-directions spectrum has a concrete next
  candidate, but it never ships live until a manual WebGPU smoke pass confirms a
  working, SIGILL-free tier.

While a gate is off, its entries are excluded from the catalog the picker
presents and from any resolution path, so live behavior is identical to a
default-plus-Qwen2.5-0.5B catalog. Rationale: CI cannot exercise WebGPU
(constraint 8); shipping a model with no vetted tier risks the v0.2.0-style OOM
or the SIGILL the project already abandoned. No entry is described as
"already-vetted" on WebGPU unless `docs/models.md` actually marks a clean WebGPU
cell working; Qwen3.5-0.8B does not, so it is gated.

### ADR-P3: Model preference is a separate storage key surviving version bumps

The user's model choice and idle-timeout choice persist under a NEW
`chrome.storage.local` key `local-nano:model-pref:v1`, distinct from both the
per-URL history keys (`local-nano:history:<origin><pathname>`) and the per-device
`CapabilityRecord` (`local-nano:capability:v1`). Unlike `CapabilityRecord`, which
is invalidated on every extension-version bump (`capability-store.ts`), the
preference record is NOT version-gated: a user's choice is a preference, not a
device fact, and must survive updates. The preference store validates shape and
ignores a corrupt blob (matching the guard discipline in `capability-store.ts`
and `history.ts`), and an unknown/stale stored model id falls back to "no
preference" (today's auto-pick). The per-device known-good/known-bad record
already namespaces by model (model name is part of `tierKey`), so it keeps
working per-model unchanged. Rationale: separation of concerns; a preference and
a device fact have different invalidation lifetimes.

### ADR-P4: "No preference" means today's capability-based auto-pick

When no model preference is stored (or the stored id is unknown), the resolved
ladder is exactly what ships today: `assembleLadder` against the primary model
(and the gated smaller rung if its flag is ever enabled). gemma-4-E2B stays the
default. A user who never opens the picker sees zero behavior change. The picker
default selection is presented as gemma-4-E2B but only writes a preference when
the user explicitly Loads a different model. Rationale: decision 5 in the
brainstorm; preserve the no-op path.

### ADR-P5: Primary default model and .env.json are unchanged

`PRIMARY_MODEL` in `ladder.ts` stays `onnx-community/gemma-4-E2B-it-ONNX`;
`.env.json` and `.env.example.json` are unchanged on disk. The picker overrides
the model in memory only, via the existing `applyTierToConfig` +
`window.TRANSFORMERS_CONFIG` override path (ADR-R2), never on disk. This keeps
`tests/docs-config.test.ts` green and the cold-start no-preference path identical
to today. Rationale: a runtime preference must not mutate the shipped config.

### ADR-P6: One serialized teardown/re-warm primitive, panel-owned, single lock

A model switch and an idle re-warm are the same operation: tear down the
offscreen document (force-recreate) and re-warm against the resolved model/tier.
This is implemented as ONE primitive in the panel (`src/session.ts`) that wraps
the existing `recreateOffscreen()` + `ensureWarm()` path and is guarded by a
single in-panel lock (an in-flight promise) so a user Load and any other re-warm
trigger cannot run concurrently. A re-warm in progress short-circuits a second
request to the same in-flight promise. Rationale: brainstorm decisions 1, 7, 14;
the v0.2.0 OOM came from overlapping loads, so serialization is a hard safety
property. The idle ALARM lives in the SW (ADR-P8), but the re-warm it triggers on
return runs through this same panel primitive on next use, never as a second
concurrent load.

### ADR-P7: Switch waits for an in-flight generation (block, do not abort)

When the user clicks Load while a generation is streaming, the switch is blocked
until the stream finishes rather than aborting the user's in-progress answer. The
Load control is disabled (or shows a "finishing current response" state) while
`activeAbort` is set in the panel, and re-enables when the stream completes. This
is the same verify-idle gate the idle alarm uses (ADR-P9). Rationale: open
question 4; aborting a user's visible answer to switch models is more surprising
than waiting; the user initiated the switch, not an emergency. The teardown must
also never overlap a live load (ADR-P6 / constraint 1).

### ADR-P8: The SW owns the idle alarm; the offscreen document never self-closes

Idle release is driven by `chrome.alarms` owned by the service worker
(`src/background/offscreen.ts` and a new `background.ts` wiring). On each
generation the panel sends the SW a "touch idle" message; the SW sets a single
named alarm to `now + timeout`. When the alarm fires, the SW verifies idle
(ADR-P9) and, if idle, calls `closeOffscreen()` (which resets the sticky
`documentReady`). The offscreen document NEVER closes itself (constraint 3). The
alarm period is stored so a fresh SW (post-eviction) reads the configured
timeout from `chrome.storage.local`. Adds the `alarms` permission to
`manifest.json`. Rationale: brainstorm decisions 8, 9, 10; an in-SW `setTimeout`
never fires after eviction, and a self-closing doc re-introduces the sticky-flag
silent death.

### ADR-P9: Verify-idle before close; reschedule if busy

When the idle alarm fires, the SW must confirm no generation is in flight before
closing. The offscreen document owns the live generation state (`generationGate`
and the per-port `activeAborts` in `offscreen.ts`). The SW asks the offscreen
document over a new request channel whether it is busy; if busy, the SW
reschedules the alarm to `now + timeout` and does not close. Each new generation
also resets the alarm (ADR-P8). The pure decision ("given busy/idle and a
configured timeout, close or reschedule") is a unit-testable function in a new
`src/offscreen/idle-policy.ts` module. Rationale: brainstorm decision 11; closing
mid-generation would drop a user's in-flight answer and could leave the panel in
a closed-doc error.

### ADR-P10: Re-warm must be recoverable from the send path, not just panel-open

After a hard release, a send from a still-alive (possibly backgrounded) content
script must trigger a recreate + warm rather than erroring into a closed
document. Today only the panel-open toggle calls `ensureWarm()`; the send path
assumes the session exists. Phase 4 makes the send path re-warm-aware: when a
generation is attempted and `modelReady` is false (or the stream fails with a
closed-document/terminal signal, classified via the existing
`classifyFailure`/`classifyLoadFailure` seam), the panel runs the serialized
re-warm primitive (ADR-P6) once and then retries the send. Rationale: brainstorm
decision 12; idle release can fire on a backgrounded tab, and the next send on
that tab must recover.

### ADR-P11: Idle timeout options and storage shape

The idle-timeout options are `5 min`, `15 min`, `60 min`, and `Never`, with a
default of `15 min`. Values are stored as a minute count, with `Never` encoded as
`null` (release disabled). The `chrome.alarms` minimum period is ~1 min, so the
shortest offered option (5 min) sits comfortably above it (open question 3,
confirmed). The model id and the idle timeout share one preference record under
`local-nano:model-pref:v1` (ADR-P3). Parsing/validation of the stored value and
the option-to-minutes mapping are pure functions in `src/offscreen/model-pref.ts`
(value mapping) and `src/offscreen/idle-policy.ts` (alarm-time math), unit-tested
without Chrome. Rationale: brainstorm decision 13.

### ADR-P12: Per-model popover metadata fields

Each catalog entry carries: a stable `id` (the canonical model name, the same
string used in `Tier.modelName`), a `displayName`, an approximate `downloadSize`
string (e.g. `"~1.5 GB"`), and a one-line `note` sourced from `docs/models.md`
(e.g. `"smallest, runs on CPU"`). The popover renders the displayName,
downloadSize, and note per row. Sizes/notes are sourced from `docs/models.md` and
are descriptive text, not asserted-exact figures. Rationale: open question 2;
keep the metadata
small and grounded in the field guide.

## Data Flow (new and changed paths)

### Model switch (Phase 2 + 3)

```text
gear popover (content.ts header) -> session.ts: user selects model -> Load
  -> session.ts: writeModelPref(id) [storage]
  -> session.ts: serialized re-warm primitive (ADR-P6)
       -> recreateOffscreen() [SW closes + recreates the doc]
       -> ensureWarm() [resolve ladder from chosen model, walk tiers]
```

### Idle release (Phase 4)

```text
each generation (session.ts send path)
  -> touchIdle message to SW
       -> SW: chrome.alarms.create(IDLE_ALARM, { when: now + timeoutMs })

chrome.alarms.onAlarm (SW wakes)
  -> SW: read configured timeout from storage
  -> SW: ask offscreen "are you busy?" [new request channel]
       -> busy  -> reschedule alarm to now + timeout, do not close
       -> idle  -> closeOffscreen() [resets documentReady]

next send on a still-alive content script after a release
  -> stream fails (closed doc) OR modelReady is false
  -> session.ts: serialized re-warm primitive (ADR-P6), then retry the send
```

## Testing and Mocking Strategy

- The real polyfill, transformers, and WebGPU never load under test. Every new
  decision module (`catalog.ts`, `model-pref.ts`, `idle-policy.ts`) is a pure
  `src/` module with no Chrome import (except `model-pref.ts`, which touches
  `chrome.storage.local` through the existing promisified pattern and is tested
  with `FakeStorageArea` exactly like `capability-store.ts`).
- Chrome-touching code (the SW alarm scheduling/close, the offscreen busy-query
  channel, the panel switch + send-path re-warm wiring) is tested through the
  existing mocks in `tests/setup.ts`: `FakePort`, `FakeStorageArea`, and
  `chromeMock`. Phase 4 ADDS a `chrome.alarms` mock to `tests/setup.ts` (create,
  clear, onAlarm.addListener with a `_fire` test helper) and an
  `offscreen.hasDocument`-style busy probe; both reset in `beforeEach`.
- `src/session.ts` is tested via `initSession(deps)` with jsdom DOM elements and
  the offscreen client `vi.mock`-ed, exactly as `tests/session.test.ts` already
  does. New panel behaviors (the popover DOM, the Load button gating, the
  send-path re-warm-then-retry) are asserted by inspecting rendered DOM and
  driving the mocked client's resolve/reject.
- Each phase states which parts are unit-testable vs manual-smoke only. The
  WebGPU load itself, a real multi-GB model switch, real VRAM reclamation after
  a close, and the end-to-end idle-release-then-return cycle on hardware are
  manual-smoke only and are gated on the ROADMAP #6 manual matrix.
- Coverage thresholds (75/75/75 lines/statements/functions, 80 branches on
  `src/`) must stay green. New pure modules carry focused tests.

## Manual Smoke Matrix (gates the WebGPU-dependent work)

These are NOT CI-checkable. Run on real hardware before considering the feature
shippable; record results against the ROADMAP #6 matrix.

1. Pick each non-gated catalog model in turn, click Load, confirm it tears down
   the prior model, downloads (first time) or loads-from-cache, and answers
   coherently.
1. Confirm a Load while a stream is in flight waits for the stream to finish
   (ADR-P7), then switches.
1. Set idle timeout to 5 min, leave the panel open and idle, confirm the model
   is released (observe VRAM drop in `chrome://gpu` or task manager) after ~5
   min from the last generation.
1. After a release, send a new prompt on the same tab and confirm it re-warms
   and answers (ADR-P10), not a closed-doc error.
1. Set idle timeout to "Never" and confirm no release fires.
1. If/when a gated model is vetted (Qwen3.5-0.8B via `QWEN3_08B_ENABLED`, or a
   larger model via `LARGER_MODEL_ENABLED`): confirm a clean, SIGILL-free working
   tier on this hardware first, then flip the gate, run steps 1-4 against it, and
   confirm no OOM. Do not flip a gate without a passing smoke run.

## Glossary

- **Tier:** one `{ modelName, device, dtype }` triple the ladder can attempt
  (existing, `ladder.ts`).
- **Catalog entry:** a curated model with display metadata plus its ordered
  `Tier[]` ladder (new, `catalog.ts`).
- **Model preference:** the user's chosen model id and idle timeout, persisted
  under `local-nano:model-pref:v1` and surviving version bumps (new).
- **Re-warm primitive:** the single serialized panel operation that
  force-recreates the document and walks the ladder for the resolved model
  (ADR-P6).
- **Idle release / hard release:** the SW closing the whole offscreen document
  after an inactivity timeout (ADR-P8).
- **Verify-idle:** confirming no generation is in flight before an idle close
  (ADR-P9).
