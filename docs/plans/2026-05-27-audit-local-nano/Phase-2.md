# Phase 2 — [IMPLEMENTER] Code Fixes

## Phase Goal

Land the two below-gate code fixes plus the structural type unification, each
small and individually committed:

1. **Pragmatism 8→9** — make the single-load invariant enforced by the
   `BusyGate` MECHANISM, not a caller contract, in `handleWarmup`'s tier-change
   teardown and `handleCountTokens` (ADR-1).
1. **Performance 8→9** — incremental `stripThink` so the streaming render loop
   is no longer O(n²) over a long `<think>` block, with proven equivalence to the
   full-buffer function (ADR-2).
1. **HEALTH MED-3** — unify `Tier` and `WarmupTier` so a field addition is a
   one-place, type-checked change (ADR-3).

**Success criteria:**

- A generation in flight (gate busy) blocks the tier-change teardown and the
  count-tokens measure; behavior is reject/skip, never a concurrent destroy.
- The incremental strip produces byte-identical visible output to
  `stripThink(fullBuffer)` for arbitrary chunk boundaries (property test),
  preserving every existing `tests/think-strip.test.ts` case.
- `WarmupTier` and `Tier` share one structural source; the hand conversion in
  `offscreen.ts` is gone; the runtime validator `isWarmupTier` still works.
- All gates green, coverage thresholds held.

**Estimated tokens:** ~40k.

## Prerequisites

- Phase 1 complete (working tree clean, gates green).
- Phase 0 ADR-1/2/3 understood, especially constraint 2 (never two loads).

## Task 2.1 — Gate-enforce the single-load invariant (Pragmatism 8→9, ADR-1)

**Goal:** `handleWarmup`'s tier-change teardown and `handleCountTokens` currently
operate on the shared session without consulting `generationGate.busy`, relying
on caller contract. Make the gate the enforcement point so a future entry point
cannot reintroduce the v0.2.0 OOM.

**Files to Modify:**

- `offscreen.ts` (`handleWarmup` tier-change teardown block; `handleCountTokens`)
- Possibly `src/offscreen/busy-gate.ts` (only if a tiny read-helper aids
  testability — see step 5; do NOT change `tryAcquire`/`release`/`busy`
  semantics)
- `tests/offscreen-busy-gate.test.ts` or a new `tests/*.test.ts` for any
  extracted pure predicate

**Prerequisites:** Task 2.1 is independent of 2.2/2.3; do it first.

**Implementation Steps:**

1. Re-read the two sites in `offscreen.ts`:
   - In `handleWarmup`, the tier-change teardown: the
     `if (sessionPromise && (activeTier === null || tierKey(activeTier) !== tierKey(tier)))`
     block that does `previous?.destroy()` and `sessionPromise = null`.
   - `handleCountTokens`, which does `const session = await ensureSession();`
     then `await session.measureContextUsage(msg.text)`.
1. **Warmup teardown:** before performing the destroy + null, check
   `generationGate.busy`. If a generation holds the gate, do NOT destroy/reload —
   instead reply with `ok: false` and a clear busy error
   (`WARMUP_RESPONSE` with `ok: false, error: 'busy: a generation is in
   progress'`), mirroring the stream path's reject-when-busy policy
   (`'busy: another generation is in progress'`). This makes the gate the
   enforcement mechanism rather than the panel's `reloadModel` early-return
   (ADR-P7). Do NOT acquire-and-hold the gate across the whole load (a load is
   not a generation; holding the gate would block the post-load first stream and
   is not what the gate models). The minimal, correct change is: refuse the
   destructive teardown WHILE busy.
1. Keep the no-tier-change path (same tier already loaded, or first load) exactly
   as today — the gate check only guards the DESTRUCTIVE branch (the one that
   could overlap a live session with a new load). Loading a fresh session when
   none exists is not a concurrency hazard.
1. **Count-tokens:** when `generationGate.busy`, short-circuit the measure and
   reply `ok: false` with a non-fatal error (the client already has a heuristic
   fallback, per the handler's existing comment — a skipped count never blocks a
   transform). Do NOT destroy or rebuild anything here (the handler already
   never does). This removes the unguarded `measureContextUsage` race against a
   concurrent teardown.
1. **Testability:** `offscreen.ts` is not in the coverage set. If the
   busy-decision logic is more than a trivial inline check, extract a pure
   predicate (e.g. `shouldRefuseTeardown(busy: boolean): boolean` or reuse the
   gate directly) into a covered location and unit-test it. If the check is a
   one-liner against `generationGate.busy`, an extraction is over-engineering —
   prefer the inline check and document it. Do NOT change `BusyGate`'s public
   contract.
1. Add/extend unit tests for any extracted predicate. Assert: busy ⇒ teardown
   refused (busy error); not-busy ⇒ teardown proceeds; busy ⇒ count-tokens
   returns `ok: false` non-fatal; not-busy ⇒ count proceeds.
1. Re-confirm constraint 2: trace that NO path now begins a second load or a
   destroy while a generation holds the gate. The stream path already
   `tryAcquire`s before generating and `release`s in `finally`; the warmup
   teardown now defers to `busy`; count-tokens defers to `busy`.

**Verification Checklist:**

- [x] `handleWarmup` tier-change destructive teardown is skipped (and replies
      `ok: false` busy) when `generationGate.busy` is true.
- [x] `handleWarmup` first-load / same-tier paths are unchanged.
- [x] `handleCountTokens` returns `ok: false` (non-fatal) when busy, never
      running `measureContextUsage` concurrently with a teardown.
- [x] `BusyGate` public surface (`tryAcquire`/`release`/`busy`) unchanged.
- [x] Any extracted predicate is unit-tested; or the inline check is justified in
      a comment.
- [x] `npm run typecheck`, `npm test`, `npm run coverage` all green (thresholds
      held).

**Testing Instructions:** `npm test` plus `npm run coverage`. If a test file was
added, update `docs/testing.md`'s test-file table (see ADR / Phase 0 testing
strategy — `tests/docs-config.test.ts` enforces it) in THIS commit or note it
for Phase 4; the simplest is to keep the table accurate here so the drift-guard
passes immediately.

**Commit Message Template:**

```text
fix(offscreen): enforce single-load invariant via BusyGate, not caller contract

handleWarmup's tier-change teardown and handleCountTokens touched the shared
session without consulting generationGate.busy, relying on the panel's
reloadModel early-return (ADR-P7). Refuse the destructive teardown and skip
the count while a generation holds the gate, so a future entry point cannot
reintroduce the v0.2.0 OOM (eval Pragmatism 8->9). BusyGate contract unchanged.
```

## Task 2.2 — Incremental `stripThink` (Performance 8→9, ADR-2)

**Goal:** the streaming caller calls `stripThink(rawText)` on the FULL buffer
every chunk (`src/session.ts` `onChunk`), so a long `<think>` block makes
stripping O(n²). Replace the per-chunk full-buffer rescan with an incremental
strip that processes only the delta, while preserving EXACT equivalence
(including split markers, multiple blocks, partial open/close markers, literal
`<`, text-before-block).

**Files to Modify:**

- `src/think-strip.ts` (add the incremental variant; keep the pure full-buffer
  `stripThink` as the spec/oracle)
- `src/session.ts` (the `onChunk` streaming integration: carry the incremental
  state instead of recomputing `stripThink(rawText)` per chunk)
- `tests/think-strip.test.ts` (add the equivalence/property test; keep all
  existing cases)

**Prerequisites:** independent of 2.1/2.3; the property test is written FIRST
(TDD, ADR-2).

**Implementation Steps:**

1. **Write the equivalence test first.** In `tests/think-strip.test.ts`, add a
   test that, for a set of representative raw strings (plain text; one complete
   block; multiple blocks; unclosed mid-stream block; text before a block; a
   literal `<` that is not a marker; a closing marker `</think>` whose characters
   are split across chunk boundaries; an opening marker `<think>` split across
   boundaries) and for MANY chunk-boundary splittings of each (e.g. split after
   every index, and a few random splittings), the incremental strip fed chunk by
   chunk produces the SAME final visible string AND the same append-only
   intermediate sequence as `stripThink` applied to each growing prefix. This
   test fails until the incremental impl exists.
1. **Design the incremental API.** Add a small stateful helper to
   `src/think-strip.ts` that the caller drives per chunk. Two viable shapes (pick
   the simpler that passes the property test):
   - a factory returning a `push(chunk: string): string` (returns the new FULL
     visible text, or just the delta — match what `session.ts` needs) plus the
     state it carries; or
   - a pure reducer `stripThinkIncremental(state, chunk) => { state, visible }`
     that `session.ts` threads.
   The state must carry: the bytes-consumed offset into the raw buffer, whether
   currently inside an unclosed `<think>` (so far-back reopen scanning is
   unnecessary), and any held-back trailing partial-marker tail (so a marker
   split across chunks resolves without rescanning from 0). The full-buffer
   `stripThink` stays exported unchanged as the oracle.
1. **Preserve the held-back partial-marker behavior.** The existing code holds
   back a trailing run that could be the start of `<think>` (so `<thi` never
   flashes) and, when inside an open block, hides everything until `</think>`
   completes — including when `</think>` arrives split across chunks. The
   incremental state must reproduce BOTH: a partial OPEN marker at the visible
   tail and a partial CLOSE marker while inside a block. Re-read the full-buffer
   logic (the `indexOf(OPEN)`/`indexOf(CLOSE)` loop plus the trailing-partial
   `for (let n = Math.min(OPEN.length - 1, ...))` block and the leading
   whitespace trim) and mirror each rule incrementally.
1. **Wire `session.ts`.** In the `onChunk` closure, replace
   `rawText += chunk; const visible = stripThink(rawText);` with the incremental
   driver. Preserve the downstream contract EXACTLY: `visible` must remain
   append-only (the code computes `delta = visible.startsWith(modelText) ?
   visible.slice(modelText.length) : ''` and feeds `delta` to `extraOnChunk` for
   the rewrite path). The leading-whitespace trim and the "still thinking ⇒
   empty visible" behavior must be identical, or the typing-indicator/first-token
   swap regresses. Keep `rawText` if the diagnostic/persistence path still needs
   the raw buffer; only the STRIP becomes incremental.
1. **Verify equivalence and big-input performance.** The property test from step
   1 must pass. Add (or assert in a comment) that the per-chunk work is bounded
   by the delta plus a constant-size held-back tail, not the whole buffer —
   optionally a coarse timing/operation-count sanity check, but correctness is
   the gate, not a perf assertion (CI perf timing is flaky; do NOT add a flaky
   timing assertion).
1. Run the full existing `tests/think-strip.test.ts` — every prior case must
   still pass against BOTH the full-buffer function and (where applicable) the
   incremental driver.

**Verification Checklist:**

- [x] Property test asserts incremental == full-buffer `stripThink` over many
      chunk splittings for: plain, complete block, multiple blocks, unclosed,
      text-before, literal `<`, split OPEN marker, split CLOSE marker.
- [x] All pre-existing `tests/think-strip.test.ts` cases still pass.
- [x] `session.ts` `onChunk` no longer calls `stripThink(rawText)` on the full
      buffer each chunk; the visible stream stays append-only and the
      `delta`/`extraOnChunk` rewrite contract is preserved.
- [x] Per-chunk work is bounded by the delta + a constant tail (verified by code
      review / the design, not a timing assertion).
- [x] No flaky timing-based test added.
- [x] `npm run typecheck`, `npm test`, `npm run coverage` green; the incremental
      code is covered.

**Testing Instructions:** `npm test` (focus `tests/think-strip.test.ts`) then
`npm run coverage`. Because `session.ts` streaming is exercised by
`tests/session.test.ts`, run the full suite to confirm the integration did not
regress the typing-indicator/first-visible-token swap.

**Commit Message Template:**

```text
perf(think-strip): strip reasoning blocks incrementally, not full-buffer per chunk

The streaming caller re-ran stripThink over the whole accumulated buffer each
chunk, making a long <think> block O(n^2) on the render hot path. Add an
incremental driver that processes only the delta while carrying open-block and
partial-marker state, proven equivalent to the full-buffer function across
arbitrary chunk splittings (eval Performance 8->9).
```

## Task 2.3 — Unify `Tier` and `WarmupTier` (HEALTH MED-3, ADR-3)

**Goal:** `Tier` (`ladder.ts`) and `WarmupTier` (`protocol.ts`) are structurally
identical and hand-converted at `offscreen.ts`. Make them share ONE structural
source so a field addition is one place, type-checked across the wire boundary,
while preserving `ladder.ts`'s freedom from Chrome/protocol RUNTIME imports and
the runtime validator `isWarmupTier`.

**Files to Modify:**

- `src/offscreen/protocol.ts` (`WarmupTier` becomes an alias of the `Tier`
  shape; keep `isWarmupTier`)
- `offscreen.ts` (remove the hand conversion in `handleWarmup`)
- Possibly `src/offscreen/client.ts` (already assigns a `Tier` into the
  `WarmupRequest.tier` slot structurally; confirm it still type-checks)
- `tests/offscreen-protocol.test.ts` (confirm `isWarmupTier` tests still pass; no
  behavior change expected)

**Prerequisites:** independent; do after 2.1/2.2 or before — no ordering
dependency.

**Implementation Steps:**

1. Confirm the two declarations are structurally identical
   (`{ modelName: string; device: 'webgpu' | 'wasm'; dtype: string }`) — they
   are, as of 2026-05-27.
1. In `protocol.ts`, replace the standalone `interface WarmupTier { ... }` with a
   TYPE-ONLY import of `Tier` from `ladder.ts`
   (`import type { Tier } from './ladder.js'`) and
   `export type WarmupTier = Tier;`. A type-only import erases at build time, so
   `protocol.ts` gains no runtime dependency and `ladder.ts` gains NO new import
   at all (the dependency points protocol→ladder, type-only). Keep the
   `WarmupTier` JSDoc explaining it is the wire mirror of `Tier`.
1. Keep `isWarmupTier` exactly as is — it is the RUNTIME validator at the wire
   boundary and must still structurally validate `{ modelName, device, dtype }`.
   Its `value is WarmupTier` predicate now narrows to the alias, which is fine.
1. In `offscreen.ts` `handleWarmup`, remove the hand conversion
   `const tier: Tier = { modelName: msg.tier.modelName, device: msg.tier.device,
   dtype: msg.tier.dtype };` — since `msg.tier` is now `WarmupTier = Tier`, use
   `msg.tier` directly as the `Tier` (assign `const tier: Tier = msg.tier;` or
   inline it). The subsequent `tierKey(tier)` / `applyTierToConfig(..., tier)`
   calls are unchanged.
1. Confirm `client.ts`'s `{ type: WARMUP_REQUEST, tier }` (assigning a `Tier`
   into `WarmupRequest.tier: WarmupTier`) still type-checks — it must, since the
   types are now the same.
1. **Guard against an import cycle.** If `protocol.ts` importing the `Tier` type
   from `ladder.ts` creates a cycle (check: does `ladder.ts` import anything from
   `protocol.ts`? It does not today — it imports only `./capability.js`), the
   type-only direction is clean. If a cycle ever appears, fall back to the
   ADR-3 alternative (canonical shape in `ladder.ts`, re-exported as `WarmupTier`
   from `protocol.ts`). Verify no cycle with `npm run build` (esbuild reports
   cycles) and `npm run typecheck`.

**Verification Checklist:**

- [ ] `WarmupTier` is defined as an alias of `Tier` (single structural source);
      a field added to `Tier` propagates to `WarmupTier` automatically.
- [ ] `ladder.ts` has NO new runtime import (still imports only
      `./capability.js`); the new coupling is a TYPE-ONLY import in
      `protocol.ts`.
- [ ] `isWarmupTier` is unchanged and still validates the wire shape at runtime.
- [ ] The hand conversion in `offscreen.ts` `handleWarmup` is removed;
      `msg.tier` is used directly as a `Tier`.
- [ ] `npm run typecheck` clean; `npm run build` reports no import cycle.
- [ ] `tests/offscreen-protocol.test.ts` passes unchanged.

**Testing Instructions:** `npm run typecheck`, `npm run build`, `npm test`
(`tests/offscreen-protocol.test.ts` covers `isWarmupTier`). No new test needed —
this is a type unification; the runtime validator's existing tests guard the wire
shape.

**Commit Message Template:**

```text
refactor(protocol): make WarmupTier an alias of Tier

WarmupTier and Tier were structurally identical and hand-converted in
offscreen.ts, so a field addition needed edits in 4+ places the type system
could not catch across the wire boundary. Alias WarmupTier to Tier via a
type-only import (ladder.ts keeps zero runtime protocol coupling) and drop
the hand conversion. Runtime validator isWarmupTier is unchanged.
```

## Phase Verification

- [ ] `npm run lint:ci` — exit 0 (direct, not piped).
- [ ] `npm run typecheck` — exit 0.
- [ ] `npm test` — all pass (new property test + all prior cases).
- [ ] `npm run coverage` — thresholds held (line ≥ 75, others ≥ 80); new logic
      covered.
- [ ] `npm run build` — succeeds, no import cycle.
- [ ] Constraint 2 re-verified: no path begins a second load or destroy while a
      generation holds the gate.
- [ ] If a test file was added, `docs/testing.md`'s test-file table is accurate
      (drift-guard `tests/docs-config.test.ts` green).
- [ ] Three atomic commits (2.1, 2.2, 2.3), conventional format, no
      `Co-Authored-By`.
