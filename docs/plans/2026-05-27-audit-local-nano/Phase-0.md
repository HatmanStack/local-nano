# Phase 0 — Foundations, Conventions, and Decisions

This is the shared reference for every phase. It records the project conventions,
the hard constraints the implementation must never violate, the testing strategy,
the commit format, and the design decisions (including which findings are WONTFIX
and why). Read it before any phase.

## Project Conventions

Sourced from `CLAUDE.md`, `.claude/settings.local.json`, the memory index, and
direct verification of the repo.

- **Runtime / package manager:** Node (version pinned in `.nvmrc`); npm with a
  committed `package-lock.json`. CI provisions `.env.json` from
  `.env.example.json`.
- **Language / build:** TypeScript (strict), bundled with esbuild via
  `build.mjs` (three entry points: `content.ts` IIFE, `background.ts` ESM,
  `offscreen.ts`). Module format is ESM (`"type": "module"`); intra-repo imports
  use `.js` extensions on TypeScript source (e.g. `import { x } from './y.js'`).
- **Validation gates (run each DIRECTLY — see constraint 4 below):**
  - `npm run lint:ci` — `biome check .` (read-only; the writing variant is
    `npm run lint`).
  - `npm run typecheck` — `tsc --noEmit`.
  - `npm test` — `vitest run`.
  - `npm run coverage` — `vitest run --coverage` (thresholds: line 75, others
    80; current line coverage ~95%).
  - `npm run build` — `node build.mjs`.
- **Formatter:** Biome. It auto-renumbers and reformats; after any edit to a TS
  file, run `npm run lint` (write mode) then `npm run lint:ci` to confirm clean.
  Biome also governs single-line vs multi-line array formatting (the last commit
  on record, `0b7491d`, was a biome single-line fix — respect its output).
- **Docs lint:** markdownlint-cli2 and lychee link-check run in CI. Markdown
  files (including this plan) must pass markdownlint: fenced code blocks need a
  language tag, headings carry no trailing punctuation, ordered lists use `1.`
  for every item, blank lines surround headings/lists/code blocks.
- **Coverage scope:** `offscreen.ts` (the entry file) is NOT in the coverage set
  — its pure cores are extracted into `src/offscreen/*` modules that ARE covered
  and unit-tested (e.g. `busy-gate.ts`, `ladder.ts`, `protocol.ts`). This is why
  the Pragmatism fix in Phase 2 must keep its logic testable via the existing
  covered seams where possible.

## Hard Constraints — violating any of these rejects the work

1. **Never patch the vendored polyfill.** `vendor/prompt-api-polyfill/` is
   upstream. Work only through its public surface (the `monitor` hook, the
   `LanguageModel.create` options, `window.TRANSFORMERS_CONFIG`). No edits under
   that directory, ever.
2. **Two model loads must NEVER overlap.** A v0.2.0 bug caused
   `VK_ERROR_OUT_OF_DEVICE_MEMORY` from concurrent sessions. Loads are serialized
   behind `reloadModel` / `warmInFlight` / `reWarmInFlight` locks plus the
   `BusyGate` (one generation at a time). The Pragmatism remediation STRENGTHENS
   this — it makes the invariant enforced by the gate MECHANISM rather than a
   caller contract. It must never weaken it: do not add any path that can begin a
   second load while one is in flight or while a generation holds the gate.
3. **Commits:** conventional-commit format (`type(scope): subject`). NO
   `Co-Authored-By` trailer (the user does not want it). See "Commit Format".
4. **Never pipe `lint`/`typecheck`/`test`/`build` output to `tail`.** Piping
   masks the non-zero exit code — that exact mistake once let a biome format
   error reach CI. Run each gate directly and read the real exit status.
5. **Text-in / text-out only.** This is not a vision/multimodal product; do not
   introduce any image/vision wiring or imply it in docs.
6. **CI already runs lint → markdownlint → lychee → typecheck → coverage →
   build.** markdownlint and lychee ALREADY EXIST — do NOT add them again. No CI
   workflow changes are in scope for this plan.

## Memory note — verify, do not assert

A standing feedback memory warns that audit agents in this repo over-assert
unverified facts (external existence, git state, counts, "unused" claims). Every
file:line and factual claim in this plan was verified against the working tree on
2026-05-27 before writing. The implementer should likewise verify any anchor
before editing (line numbers drift); the plan gives the search target, not just
the number.

## Design Decisions and Rationale

### ADR-1: Gate-enforce the single-load invariant (Pragmatism 8→9)

`handleWarmup`'s soft tier-change teardown (`offscreen.ts`, the
`if (sessionPromise && ...)` block that calls `previous?.destroy()` and nulls
`sessionPromise`) and `handleCountTokens` (which calls
`session.measureContextUsage` on the shared session) both touch the shared
session WITHOUT consulting `generationGate.busy`. Today they are safe only by
caller contract (the panel's `reloadModel` early-returns while a generation's
`activeAbort` is set, ADR-P7; the normal ladder advance recreates the document so
`sessionPromise` is null). A future second warmup/count entry point would
silently reintroduce the v0.2.0 OOM.

**Decision:** make the teardown refuse to run while a generation holds the gate,
so the gate (not the caller) is the enforcement point. Reuse the existing
`BusyGate` — do NOT introduce a second lock. The teardown asserts/checks
`generationGate.busy` and, if busy, does NOT destroy + reload (it surfaces a
busy error to the warmup caller instead, mirroring the stream path's
reject-when-busy policy). `handleCountTokens` similarly must not run a measure
that could race a teardown; the lowest-risk change is to skip/short-circuit the
count when busy (the client already has a heuristic fallback, so a skipped count
never blocks a transform). Complexity LOW.

**Why not a new lock or a queue:** YAGNI and constraint 2 — a second primitive
is more surface for the two paths to diverge. The whole point is ONE enforcement
mechanism. Reject-when-busy matches the established stream policy.

### ADR-2: Incremental `stripThink` (Performance 8→9)

`stripThink(raw)` (`src/think-strip.ts`) is a pure function over the FULL
accumulated buffer. The streaming caller (`src/session.ts`, the `onChunk`
closure: `rawText += chunk; const visible = stripThink(rawText)`) calls it on the
whole buffer EVERY chunk, so a long `<think>` block makes the per-chunk
`indexOf` rescan O(n) and the whole stream O(n²) — the one render-loop hot path.

**Decision:** add an incremental stripping variant that processes only the delta
region per chunk while carrying enough state across chunks to preserve EXACT
equivalence with the full-buffer function — including the four hard cases the
existing tests pin: complete and multiple `<think>…</think>` blocks, an unclosed
mid-stream block (hide from the marker on), a partial OPENING marker held back
(`<thi`), a partial CLOSING marker split across a chunk boundary, text before a
block, and a literal `<` that is NOT a marker. The pure full-buffer `stripThink`
stays exported and tested (it is the equivalence oracle). The new incremental
path carries an offset/state object in `session.ts`'s streaming integration.

**Constraint:** split-marker-across-chunks correctness is non-negotiable. The
plan's verification requires a property test asserting the incremental result
equals `stripThink` of the full buffer for arbitrary chunk splittings.

**Why keep both:** DRY says reuse — but the full-buffer function IS the spec and
the test oracle; deleting it would lose the equivalence anchor. The incremental
variant is the optimization, validated against the spec. This is the documented
trade-off, not duplication for its own sake.

### ADR-3: Unify `Tier` and `WarmupTier`

`Tier` (`src/offscreen/ladder.ts`) and `WarmupTier`
(`src/offscreen/protocol.ts`) are structurally identical
(`{ modelName; device: 'webgpu'|'wasm'; dtype }`). The wire protocol owning its
own shape is a deliberate decoupling (`ladder.ts` stays free of Chrome/protocol
imports), so the redeclaration is documented-intentional. The genuine debt is the
HAND conversion at `offscreen.ts` (the `const tier: Tier = { modelName: ...,
device: ..., dtype: ... }` rebuild inside `handleWarmup`) plus the structural
assignment at `client.ts` (`{ type: WARMUP_REQUEST, tier }` assigns a `Tier`
into a `WarmupTier` slot).

**Decision:** keep the decoupling intent but eliminate the silent-divergence
risk. The lowest-risk option that preserves `ladder.ts`'s zero-protocol-import
property is to have `WarmupTier` be a type ALIAS of (or `extends`/`=` ) the
`Tier` shape sourced from `ladder.ts` — i.e. `protocol.ts` imports the `Tier`
TYPE only (a type-only import keeps it free of runtime coupling) and defines
`export type WarmupTier = Tier`. Then the hand conversion in `offscreen.ts`
collapses to a direct use (no field-by-field rebuild). This makes a future field
addition a one-place change the type system enforces across the wire boundary.

**Guardrail:** `ladder.ts` must remain free of any RUNTIME Chrome/protocol
import; a `type`-only import the other direction (protocol importing the Tier
type) is acceptable because it erases at build time and `ladder.ts` gains no new
dependency. If the type-only-import direction is awkward (e.g. it would create an
import cycle), the fallback is to define the canonical shape in `ladder.ts`,
re-export it as `WarmupTier` from `protocol.ts`, and keep `isWarmupTier`
unchanged. Either way: ONE structural source, zero hand conversions, the runtime
validator (`isWarmupTier`) preserved.

### ADR-4: `rebuildSession` resets `activeTier` (LOW-1 pre-empt)

`offscreen.ts`'s `rebuildSession()` nulls `sessionPromise` but leaves
module-scoped `activeTier` stale. Benign today (the `handleWarmup` destroy-guard
short-circuits on `sessionPromise && ...`), but latent: a future reorder of the
guard could let a stale `activeTier` skip the OOM-prevention destroy.

**Decision:** set `activeTier = null` alongside `sessionPromise = null` in
`rebuildSession`. Quick win, pre-empts the latent bypass, no behavior change
today.

### ADR-5: Documentation fixes pin code as source of truth

Where doc and code disagree, CODE wins (the audit confirmed code is correct in
every drift case). The CHANGELOG 0.4.0 entry, `docs/configuration.md`'s model
recommendation, and the stale line anchors are all corrected TO the shipped code.
ROADMAP.md is the pinned source of truth for Web-Store listing state (it says
v0.3.0 is on the Web Store), so README's "This isn't on the Chrome Web Store" is
the outlier to fix.

## WONTFIX (recorded with rationale, no code change)

These findings were assessed and deliberately deferred. They are NOT padded into
tasks; they are documented here so a future reader knows they were considered.

- **HEALTH MED-1 — `initSession` ~1854-line monolith (decompose).** A large,
  RISKY refactor of the single most invariant-critical file (it owns the
  never-two-loads and never-tear-down-a-live-stream coordination through far-apart
  closure flags). The eval lists decomposition only as an OPTIONAL 10/10 stretch,
  not a remediation requirement; neither below-gate pillar depends on it. Splitting
  it carries real regression risk against constraint 2 for no gate movement.
  **Deferred** — out of scope for this remediation; revisit as a dedicated,
  separately-reviewed refactor with its own test scaffolding.
- **HEALTH MED-2 — page-wide document listeners on `<all_urls>`.** Documented as
  deliberate (the `mousedown` handler early-returns while the popover is closed;
  the content-script `selectionchange`/drag listeners are core to the
  highlight-to-edit feature). Removing or scoping them changes product behavior
  and is not a debt fix. **WONTFIX** — documented-deliberate, no gate impact.
- **HEALTH LOW-2 — dev-only `npm audit` advisories (vitest/vite chain).** 6
  moderate, all dev/CI-only, zero production exposure; remediation needs a Vitest
  major bump (a breaking change to the test toolchain). **WONTFIX for this
  remediation** — Phase 3 records it explicitly as a known, tracked
  dev-only-advisory item so it is not silently lost.
- **HEALTH LOW-3 — closure vars init-then-overwritten.** A minor readability tax
  in `session.ts`; no correctness or perf impact. Untouched to avoid churning the
  invariant-critical file. **WONTFIX.**
- **HEALTH LOW-4 — `streamPrompt`/`sendPrompt` thin adapters.** Genuinely shared
  logic already lives in `stream-client.ts`; these are 3-line per-context
  adapters differing only by injected `ensure` strategy — not dead, not
  duplicated logic. **WONTFIX.**
- **HEALTH LOW-5 — `LARGER_ENTRY` placeholder in `catalog.ts`.** A documented,
  gated-off (`LARGER_MODEL_ENABLED=false`) placeholder seam; never listed live.
  **WONTFIX** — intentional vetting target.

## Testing Strategy

- **TDD where the seam allows.** The two code fixes (ADR-1, ADR-2) have
  unit-testable cores. For ADR-2, write the property/equivalence test FIRST (it
  fails against a naive incremental impl), then implement. For ADR-1, the gate
  decision is testable via the covered `BusyGate` and any extracted pure
  predicate; `offscreen.ts` itself is not covered, so push any new decision logic
  behind a covered seam where reasonable.
- **No new test framework.** Vitest only. Tests are colocated in `tests/*.test.ts`
  and reference source via `.js` extensions.
- **Mocking for CI / no-WebGPU:** CI cannot exercise WebGPU. All new tests must be
  pure/unit (no real model load, no real GPU). The existing suites
  (`tests/think-strip.test.ts`, `tests/offscreen-busy-gate.test.ts`,
  `tests/offscreen-protocol.test.ts`, `tests/offscreen-ladder.test.ts`) are the
  patterns to follow.
- **Drift-guard awareness:** `tests/docs-config.test.ts` enforces the
  `docs/testing.md` test-file table ↔ disk. If Phase 2 ADDS a test file, the
  doc-engineer phase (or the same commit) must keep that table accurate or the
  drift-guard fails CI. Phase 2 notes this explicitly.
- **Coverage thresholds must stay green** (`npm run coverage`): line ≥ 75, others
  ≥ 80. New pure logic should be covered.

## Commit Format

Conventional commits, one atomic commit per logical change. NO `Co-Authored-By`
trailer. Use the existing history style (`feat(scope):`, `fix(scope):`,
`refactor(scope):`, `docs(scope):`, `chore(scope):`, `test(scope):`,
`style(scope):`). Scopes seen in history: `picker`, `catalog`,
`chrome-web-store`, `0.4.0`. Each task below carries a Commit Message Template.

Example shape:

```text
fix(offscreen): enforce single-load invariant via BusyGate in warmup teardown

The tier-change teardown and count-tokens handler now refuse to operate
while a generation holds the gate, moving the never-two-loads guarantee
from caller contract to the gate mechanism (eval Pragmatism 8->9).
```
