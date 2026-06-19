# Phase 0: Foundation

This file is the law for Phases 1 through 4. Every implementation choice in a
later phase must be consistent with the decisions captured here. Estimated
tokens: ~9,000.

## Project Conventions

Inherited from `CLAUDE.md`, the Claude Code memory index
(`~/.claude/projects/-home-christophergalliart-projects-local-nano/memory/MEMORY.md`),
the parent memory at
`~/.claude/projects/-home-christophergalliart-projects/memory/`, and the
current codebase. Do not contradict any of these in a later phase.

### Toolchain

- **Package manager:** npm. `package-lock.json` is authoritative.
- **Node:** version pinned in `.nvmrc` (currently 20). Use `nvm use` before
  running commands.
- **TypeScript:** strict mode is on (see `tsconfig.json`). All new code must
  type-check without `any` escape hatches except where existing code already
  uses them. The codebase casts `chrome`/`navigator`/`window` shapes through
  `unknown` rather than `any`; follow that pattern.
- **Linter / formatter:** Biome 2.4.15. Run `npm run lint` (autofix) during
  development and `npm run lint:ci` before commit. Rules of note: 2-space
  indent, single quotes, trailing commas, semicolons required, 100-char line
  width. `vendor/`, `dist/`, `coverage/`, `node_modules/`, `.claude/` are
  excluded from Biome.
- **Test runner:** Vitest + jsdom. Coverage thresholds enforced at 75 percent
  lines/statements/functions and 80 percent branches, measured on
  `src/**/*.ts` only (see `vitest.config.ts`). Files at the repo root
  (`offscreen.ts`, `background.ts`, `content.ts`) are NOT in the coverage
  include set, so logic that must be unit-tested belongs under `src/`.
- **Build:** `node build.mjs` (esbuild). Three entry points: `content.ts`
  (IIFE), `background.ts` (ESM module worker), `offscreen.ts` (IIFE). Any new
  module under `src/` is bundled into whichever entry imports it.

### Commands

| Task | Command |
| ---- | ------- |
| Install | `npm ci` |
| Type-check | `npm run typecheck` |
| Test (one shot) | `npx vitest run` |
| Single test file | `npx vitest run tests/<name>.test.ts` |
| Coverage | `npm run coverage` |
| Build | `npm run build` |
| Lint (autofix) | `npm run lint` |
| Lint (CI) | `npm run lint:ci` |
| Markdown lint | `npx markdownlint-cli2 docs/plans/2026-06-04-device-loss-resilience/**/*.md` |

Run `typecheck`, the test command, `lint:ci`, and `build` directly before each
commit. NEVER pipe their output to `tail` — a non-zero exit code is hidden by
the pipe and CI has been broken by exactly that mistake. If you need to scan a
long output, redirect to a file (`> /tmp/out.log`) and read the file.

### Git workflow

- Conventional commits. Allowed types: `feat`, `fix`, `refactor`, `test`,
  `docs`, `chore`. Scope encouraged (e.g. `fix(offscreen): …`).
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

- No em dashes in code or commits. Use commas, periods, semicolons, or
  parentheses. (Em dashes are tolerated in prose docs already in the
  repository but new prose should avoid them.)
- No filler. No fake enthusiasm. No emojis. No exclamation marks.
- Direct and factual. State facts, give instructions, move on.

### Markdown lint (any docs touched)

- Fenced code blocks need a language tag (` ```text `, ` ```bash `,
  ` ```json `, ` ```typescript `, ` ```markdown `). Never bare fences.
- Headings must not end with punctuation.
- Ordered lists use `1.` for every item (markdownlint auto-renumbers).
- Blank lines required before and after headings, code blocks, and lists.
- Code spans must not have spaces inside backticks.

CI already runs `markdownlint-cli2` and `lychee`. Do NOT re-add either to
GitHub Actions.

### Memory note: do not over-assert unverified facts

A standing memory feedback note warns that audit/eval agents over-assert
unverified facts (external existence, git state, counts, "unused" claims). The
planner verified every file:line cited in this plan against the live codebase
before writing it. If an implementation phase finds a cited anchor has drifted
(file lines change as edits land), trust the SEMANTIC anchor (the function
name, the comment marker, the test name) over the exact line number. Do not
invent file:line numbers in code or commit messages.

## Non-negotiable Constraints

Any plan or implementation that violates one of these is a defect.

1. **Never two concurrent model loads.** The v0.2.0 OOM
   (`VK_ERROR_OUT_OF_DEVICE_MEMORY`) came from concurrent sessions. The
   poisoned-state recovery path must reuse the EXISTING serialized
   `reloadModel` / `recreateOffscreen` primitive in `src/session.ts`
   (`reloadModel` is a closure inside `initSession`, end of file, returning
   the `reloadModel` handle around line 1913). The offscreen-side
   `warmInFlight` / `reWarmInFlight` lock plus `BusyGate` in
   `src/offscreen/busy-gate.ts` must not be bypassed by any new code path.
1. **Never tear down a live stream (ADR-P7).** Honored already by the
   offscreen warmup handler (the `generationGate.busy` early-reject around
   `offscreen.ts:399`) and the SW-side `recreateOffscreen` call (the SW asks
   the offscreen for `IS_BUSY` before closing on the idle alarm; see
   `queryOffscreenBusy` in `src/background/offscreen.ts`). The
   poisoned-state recovery in Phase 2 MUST also defer the recreate while
   `generationGate.busy === true`; the rebuild happens AFTER the in-flight
   generation finishes.
1. **Vendored polyfill is upstream.** `vendor/prompt-api-polyfill/*` is never
   patched. The only seam to capture the `GPUDevice` is the
   `navigator.gpu` monkey-patch in the offscreen document (ADR-0).
1. **Validation discipline.** Run `npm run lint:ci`, `npm run typecheck`,
   `npx vitest run`, and `npm run build` directly. NEVER pipe to `tail` (it
   hides non-zero exit codes — same mistake that let a Biome format error
   reach CI once).
1. **No remote code, no eval.** The `navigator.gpu` monkey-patch must use
   bundled local code only (Enhanced Safe Browsing posture from 0.4.1).
1. **Single offscreen document.** One offscreen at a time, owned by the SW
   via the `chrome.offscreen.*` API. Closing or recreating happens through
   `closeOffscreen` / `recreateOffscreen` in `src/background/offscreen.ts`.
1. **Text-in/text-out only.** No vision / multimodal capability.
1. **CI cannot exercise WebGPU.** The `device.lost` listener cannot be
   end-to-end tested in CI. Unit tests via mocked `navigator.gpu` cover the
   wiring (Phase 2 lays the mock). Real-device behavior is verified by manual
   smoke on the ChromeOS repro (switch tabs, reopen, send).
1. **MV3 service-worker eviction.** The SW can be evicted after ~30s of
   inactivity. The panel-pin port (Phase 3) must survive SW restart: when
   the SW wakes via an `ENSURE_OFFSCREEN_REQUEST` or stream connect, it must
   re-derive any active pin from observed port connections (not from a
   persisted count, which would lie after a stale-port cleanup).

## Architecture Decision Records

### ADR-0: `navigator.gpu` monkey-patch is installed at offscreen module top

**Decision.** The patch wraps `navigator.gpu.requestAdapter` and the adapter's
`requestDevice` at the TOP of `offscreen.ts` (module load), inside an
idempotent helper that no-ops on second call. It runs before `loadHeavy`, the
`gpu-info` handler, and any other consumer.

**Why.** The offscreen-side `collectGpuInfo` (`offscreen.ts` around line 270)
ALREADY calls `navigator.gpu.requestAdapter` directly. If the monkey-patch
were installed lazily inside `loadHeavy`, a `gpu-info` request from the panel
preflight (which always runs before warmup) would race the patch and the
adapter capture would miss. Installing at module top makes the patch a
property of the document, not a property of a particular code path, and is
the simplest mental model.

**Rejected alternative.** Install inside `loadHeavy` (lazy). Smaller blast
radius but introduces a real race window with the `gpu-info` preflight, and
saves no measurable work since the wrap is one method-level assignment.

**Defensibility check.** The patch must wrap the ORIGINAL `requestAdapter`
and call through; any consumer (including `collectGpuInfo`) must continue to
work transparently. Phase 2 tests assert this on both the existing
`gpu-info` path and the new device capture.

### ADR-1: Push, not pull, for SW <-> offscreen poisoned-state propagation

**Decision.** When `device.lost` fires in the offscreen document, the
offscreen sends a one-way `SESSION_POISONED` `chrome.runtime.sendMessage` to
the SW. The SW fields it through a new branch in `installEnsureListener`
(`src/background/offscreen.ts`), flips a module-scoped boolean
`sessionPoisoned = true`, and acks `ok: true`. On the next
`ENSURE_OFFSCREEN_REQUEST` from a panel, the SW checks the flag, calls
`recreateOffscreen` if set, then resets the flag and replies `ok: true`.

**Why.** Push lets the most common operation (panel-open ensure) stay a
cheap, single-round-trip path. A pull design would add a round-trip to every
ensure for a device-loss event that fires once per session at most. The push
shape also slots into the existing `chrome.runtime.onMessage` + sender-id
guard pattern already used for every other request type (gpu-info,
rebuild-session, count-tokens, warmup, is-busy).

**Rejected alternative.** Pull: SW asks the offscreen
`IS_SESSION_POISONED` on each ensure. Lower protocol surface (no new
message type for the inbound direction), but adds a round-trip latency to
every panel-open, plus a "no listener" branch when the offscreen is gone.
Push is simpler at the cost of one new message type, which is a small price.

**Defensibility check.** The push message is fire-and-forget; the offscreen
does not await the SW reply. If the SW happens to be evicted at that
instant, the message is dropped and the next `device.lost` (if any) re-sends.
The outermost 0.4.2 empty-success retry is the safety net for the
push-was-lost edge case.

### ADR-2: Dedicated panel-pin port, name `offscreen-panel-pin`

**Decision.** Phase 3 introduces TWO new long-lived port names:

- Content -> SW: `local-nano-panel-pin` (a new constant
  `PANEL_PIN_PORT_NAME` in `src/offscreen/protocol.ts`).
- SW -> offscreen: `offscreen-pin` (a new constant `OFFSCREEN_PIN_PORT_NAME`
  in `src/offscreen/protocol.ts`).

Both follow the existing `<scope>-<purpose>` shape (the existing stream port
is `offscreen-stream`, progress is `offscreen-progress`). The content-side
prefix `local-nano-` disambiguates it from the offscreen-document-side ports
in the panel code (the panel never opens an offscreen-* port directly; the
SW does the offscreen connect).

**Why.** Reusing the stream port would conflate transport with lifetime: a
stream port closes when the stream ends, which is exactly the wrong moment
to release the pin. A dedicated port matches the established convention
(progress is already its own port). Two distinct names also let the SW tell
panel-pin connects from offscreen connects without a sender check.

**Rejected alternative.** Adding a `pin: true` flag to the existing stream
port message frame. Lifetime confusion remains, and the flag would have to
live in the protocol's `StreamRequest` shape, which has no business carrying
a lifetime bit.

**Defensibility check.** The new constants live next to the existing
`STREAM_PORT_NAME` and `STREAM_PROGRESS_PORT` exports in `protocol.ts`. The
existing `port.name !== STREAM_PORT_NAME` early-return guards in the
offscreen `onConnect` handler are untouched; the new pin port adds a third
`onConnect` listener that filters on `OFFSCREEN_PIN_PORT_NAME`.

### ADR-3: Diagnostic field naming — single `deviceLostAt` string, pulled via gpu-info

**Decision.** Extend the `DiagnosticInput` shape in
`src/offscreen/diagnostic.ts` with one new field:

```typescript
/**
 * ISO 8601 timestamp of the most recent device.lost event, or 'none' when
 * none has been observed in this offscreen lifetime.
 */
deviceLostAt: string;
```

Render as a new line in `buildDiagnostic`: `deviceLostAt: <value>`.

The panel learns the timestamp by PULL only: Phase 4 Task 4.1 extends the
existing `GpuInfoSnapshot` reply with an optional `lastDeviceLostAt: string
| null` field that the offscreen populates from the module-scoped
`lastDeviceLostAt` set by Phase 2's `device.lost` handler. The panel reads
that field through its existing `getGpuInfo()` preflight (already called
during warmup at `src/session.ts:1380`), stores it in the panel-side
`lastGpuInfo`, and `buildDiagnosticInput` maps a `null` to the string
`'none'` so the renderer keeps a fixed output shape.

No SW-to-panel push or broadcast is added. Phase 2 stops at SW-side
ingest (the `sessionPoisoned` flag and the ensure-time recreate); the
diagnostic-field plumbing is entirely contained in Phase 4.

**Why pull, not push.** The diagnostic is only built on a failure render
or a user Copy click, both of which run AFTER the panel's preflight has
populated `lastGpuInfo`. The pull path is functionally complete: by the
time the diagnostic is built, the most recent `getGpuInfo()` reply has
already carried the latest `lastDeviceLostAt`. A push (SW broadcast on
`SESSION_POISONED`) would add protocol surface (a new SW-to-panel message
or a `chrome.tabs.sendMessage` fan-out across open tabs) for a rare event
the diagnostic does not need to react to in real time.

**Why a dedicated field, not `errorClass`/`errorMessage`.** Clear
semantics. `deviceLostAt` is unambiguous to a future bug reporter.
Reusing the existing error fields would conflate a runtime device-loss
observation with a load-time error class; a load-time terminal failure
would clobber a device-loss timestamp. A generic `runtimeErrors` bucket
invites scope creep; a single targeted field is YAGNI-correct for the
one event class that motivated it.

**Rejected alternatives.**

1. **SW-to-panel push of `SESSION_POISONED`** (`chrome.tabs.sendMessage`
   fan-out, or a dedicated long-lived port). Cheaper diagnostic freshness
   in theory, but the diagnostic is only built post-preflight, so the
   freshness is unused. Rejected for 0.4.3 as excess protocol surface for
   no observable behavior change. If a future release wants a "model
   reloading" notice in open panels (brainstorm out-of-scope), this is
   the natural place to add it; deferring keeps 0.4.3's surface minimal.
1. **Reuse `errorClass`/`errorMessage`** for the device-loss timestamp.
   Conflates two distinct observation kinds; rejected on semantics.

**Defensibility check.** A field-level change keeps the diagnostic
renderer deterministic (one new line in a fixed order). Phase 4 Task 4.2
adds a test that asserts the rendered string contains `deviceLostAt:
<value>` in the position immediately after `errorMessage`. Phase 4 Task
4.1 extends `tests/offscreen-protocol.test.ts` and
`tests/offscreen-client.test.ts` to round-trip the new wire field.
Phase 2 contains no diagnostic-field work; an engineer reading ADR-3
should expect to touch `protocol.ts`, `diagnostic.ts`, `offscreen.ts`'s
`collectGpuInfo`, and `src/session.ts`'s `buildDiagnosticInput` only in
Phase 4.

## Layer Map

The brainstorm calls the fix "three layers." Each layer is one phase:

| Layer | Phase | What it does | Why it stays separate |
| ----- | ----- | ------------ | --------------------- |
| C | Phase 1 | Offscreen converts zero-chunk streams into typed `STREAM_DONE { ok: false }`; `classifyFailure` classes the new wire string as terminal so 0.4.2's reactive recovery runs | Smallest, no SW or content-script coupling; ships independent value if Phases 2+ slip |
| A | Phase 2 | `navigator.gpu` monkey-patch captures `GPUDevice`; `device.lost` marks session poisoned; SW recreates on next ensure | The actual fix for the underlying cause |
| B | Phase 3 | Panel-pin port keeps offscreen alive while panels are open, so the loss window shrinks toward zero | Pure lifetime guarantee; orthogonal to the recovery logic |
| Polish | Phase 4 | Diagnostic field, version bump 0.4.2 -> 0.4.3, CHANGELOG entry | Version is bumped LAST so a broken intermediate phase never ships as 0.4.3 |

## Shared Patterns and Seams

These patterns recur across phases. Implement once per the conventions below;
later phases reuse them without re-inventing.

### Module-scoped state in `offscreen.ts`

The offscreen entry already uses module-scoped state for `heavyPromise`,
`sessionPromise`, `activeTier`, `generationGate`, `progressPorts`. The new
state added by this plan follows the same shape:

- Phase 2: `sessionPoisoned: boolean = false` (set by the `device.lost`
  handler, cleared by `rebuildSession`). `lastDeviceLostAt: string | null =
  null` (ISO timestamp of the most recent loss). `capturedGpuDevice:
  GPUDevice | null = null` (the device handle the patch most recently
  observed). `pinPorts: Set<chrome.runtime.Port> = new Set()` (one entry per
  connected SW pin port; the offscreen side just acks the connect; the
  lifetime work is on the SW side).
- Phase 3: nothing new in `offscreen.ts`; the SW owns the pin counter.

State that must survive SW restart is observed (not persisted): Phase 3's
panel-pin count is rebuilt by counting `onConnect` events, not loaded from
storage.

### SW-side message branches

Every new request type goes into `src/background/offscreen.ts`'s
`installEnsureListener`, alongside the existing `isEnsureOffscreenRequest`,
`isRecreateOffscreenRequest`, `isTouchIdleRequest` branches. The dispatch
test (`tests/offscreen-dispatch.test.ts`) only covers the offscreen-side
dispatch (`src/offscreen/dispatch.ts`), so a SW-side branch is tested in
`tests/background-offscreen.test.ts`.

### Phase boundaries respect the busy gate

Every code path that calls `recreateOffscreen` (Phase 2's poisoned-state
ensure handler, Phase 3's panel-unpin teardown) must FIRST check the
offscreen's `IS_BUSY_REQUEST` via the existing `queryOffscreenBusy` helper
in `src/background/offscreen.ts`. When busy, the SW DEFERS the recreate
until the next opportunity (next ensure for Phase 2; the next idle alarm
fire for Phase 3). NEVER abort the in-flight generation; NEVER race the
busy-gate teardown.

## Testing Strategy

### What is testable in CI

Pure logic under `src/` (jsdom + Vitest). Phase 1 unit-tests the new
zero-chunk path inside the offscreen stream handler's pure helpers (the read
loop is a closure inside `offscreen.ts`; Phase 1 extracts the
chunk-count-and-finalize decision into a pure helper under `src/offscreen/`
so it is unit-testable, same pattern as `BusyGate`). Phase 1 also extends
`tests/offscreen-failure.test.ts` to assert the new wire string classes as
terminal.

Phase 2's `navigator.gpu` capture logic is extracted into a pure module
under `src/offscreen/` (proposed: `src/offscreen/gpu-capture.ts`) so the
patch + listener wiring is unit-testable with a programmable `navigator.gpu`
mock. The SW-side `SESSION_POISONED` handler is unit-tested in
`tests/background-offscreen.test.ts` by driving `chrome.runtime.onMessage`
listeners through the `chromeMock`.

Phase 3's panel-pin counter logic is also extracted into a pure module
(proposed: `src/background/panel-pin.ts`) so the SW-side `acquire`/`release`
state machine is testable without firing real ports.

Phase 4's diagnostic field is tested in `tests/offscreen-diagnostic.test.ts`
and in `tests/session.test.ts` (panel-side population, see existing tests
that assert the diagnostic shape in the terminal bubble).

### What is NOT testable in CI

- A real WebGPU adapter or device.
- The actual `device.lost` event firing from Chrome.
- Chrome's 30-second no-port reap of the offscreen document.

These are validated by manual smoke on the ChromeOS repro:

1. Open the panel, send a message, confirm a response.
1. Switch to another tab for ~60 seconds.
1. Switch back, reopen the panel, send a message.
1. Without 0.4.3 the response is empty and the second send shows
   "Generation failed". With Phases 2 and 3 the response is correct on the
   first try.
1. Inspect the Copy diagnostic; `deviceLostAt` carries an ISO timestamp
   when the loss happened, or `none` when Phase 3's pin port prevented it.

### Mocking the WebGPU surface

Phase 2 adds a programmable `navigator.gpu` mock in `tests/setup.ts`
alongside the existing `chromeMock`. The new mock supports:

- `requestAdapter()` returns a fake adapter with `requestDevice()`.
- `requestDevice()` returns a fake device with a settable `lost` Promise.
- A test helper `_fireDeviceLost(reason: string)` resolves the `lost`
  Promise with a `{ reason }` payload so a test can drive the listener.
- Phase 2 leaves the existing `getGpuInfoMock` in `tests/session.test.ts`
  untouched; the new mock attaches to `globalThis.navigator.gpu`, which the
  offscreen-side `collectGpuInfo` reads. Tests that exercise the panel
  preflight (which mocks `getGpuInfo` at the client boundary) keep using
  the existing client mock; tests that exercise the offscreen capture path
  use the new `navigator.gpu` mock directly.

### Coverage threshold

Vitest enforces 75% lines/statements/functions and 80% branches on
`src/**/*.ts`. Each phase must keep coverage at or above the threshold; any
new module under `src/` needs accompanying tests that exercise its branches.

### Test-file table drift guard

The repo enforces (`tests/docs-config.test.ts`) that every new
`tests/<name>.test.ts` is documented in the test-file table in
`docs/testing.md`. Any phase that adds a test file must update
`docs/testing.md` in the SAME commit; otherwise the docs-config test fails
the build.

## Commit Message Format

Conventional commits with a scope from the affected area. No
`Co-Authored-By`. No `Generated-By`. No emojis. No exclamation marks.

Examples for this plan:

```text
fix(offscreen): treat zero-chunk stream as typed terminal failure

Extend the stream handler in offscreen.ts to track a chunk counter
across the read loop. On natural completion with zero chunks, emit
STREAM_DONE { ok: false, error: 'no tokens emitted; session may be
poisoned' } so the panel side's classifyFailure routes the failure
through the existing reactive recovery path instead of treating an
empty success as a legitimate empty answer.

Extend classifyFailure with the new wire string as a TERMINAL signal so
the panel re-warms via the serialized primitive (no second concurrent
load).
```

```text
feat(offscreen): capture GPUDevice and recover on loss

Install a transparent navigator.gpu monkey-patch at the offscreen
module top. The patch wraps the original requestAdapter and the
adapter's requestDevice, capturing the GPUDevice handle as the polyfill
flows through to it. A device.lost listener marks the session poisoned
and pushes SESSION_POISONED to the service worker.

The SW recreates the offscreen document on the next
ENSURE_OFFSCREEN_REQUEST when the flag is set (and the offscreen is not
busy), so the next user send runs on a fresh session. Rejected:
proactive background rebuild (likely to lose against the same GPU
pressure that caused the loss).
```

Each phase enumerates the exact commits it expects.

## What Phase 0 ships

Nothing. Phase 0 is documentation only. Verification:

- `npx markdownlint-cli2 docs/plans/2026-06-04-device-loss-resilience/**/*.md`
  passes.
- `git status` shows the new plan files under
  `docs/plans/2026-06-04-device-loss-resilience/` only; no source files
  changed.
- Phases 1-4 must remain consistent with the ADRs above. A later phase that
  wants to deviate writes a PLAN_REVIEW feedback item against this file.
