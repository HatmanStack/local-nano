# Phase 5: Rich Always-Available Copy-Only Diagnostic

## Phase Goal

Enrich the minimal Phase 1 diagnostic into a complete report (device, fallback,
maxBufferSize, chosen model and active tier, the full ladder path taken, error
class and message, extension version, Chrome/UA version) and make it always
reachable from the panel via a small affordance that copies to clipboard.
Nothing leaves the device automatically. Success criteria: the enriched builder
is fully unit-tested with the new structured fields; the panel exposes an
always-available "Copy diagnostic" affordance; failure messages embed the
enriched diagnostic; copy works with a fallback for restricted contexts;
build/tests/lint/coverage stay green. Estimated tokens: ~35,000.

## Prerequisites

- Phases 1-4 merged.
- ADR-R11 (pure builder, copy-only, clipboard with execCommand fallback)
  governs this phase.
- Baseline green.
- Re-read `src/offscreen/diagnostic.ts` (Phase 1), the `ensureWarm` failure
  branches (Phases 1, 2, 4), and the ladder `path` tracking (Phase 2).

## Task 5.1: Enrich the diagnostic builder

### Goal

Add the remaining structured fields to `buildDiagnostic` and a typed
`DiagnosticInput`, keeping the builder pure and stable.

### Files to Modify/Create

- Modify `src/offscreen/diagnostic.ts`.
- Modify `tests/offscreen-diagnostic.test.ts`.

### Prerequisites

None beyond prior phases.

### Implementation Steps

1. Extend `DiagnosticInput` with: `chosenModel: string | null` (the model the
   ladder selected), `ladderPath: Array<{ modelName: string; device: string;
   dtype: string; outcome: 'success' | 'load-failure' | 'network' }>` (the tiers
   tried and their outcomes), and `userAgent: string` (the raw `navigator.
   userAgent`, from which the panel can derive a Chrome version; include the raw
   UA, since parsing Chrome version reliably is brittle, and add a best-effort
   `chromeVersion: string | null` parsed from the UA via a simple regex).
1. Add a pure `parseChromeVersion(ua: string): string | null` helper (match
   `/Chrome\/([\d.]+)/`) and use it to populate `chromeVersion` from
   `userAgent`. Keep it exported and tested.
1. Render the new fields in `buildDiagnostic` in a stable order, with the ladder
   path as a readable list (one tier per line: `model/device/dtype →
   outcome`). Keep copy-paste cleanliness (no trailing whitespace, deterministic
   order). Empty `ladderPath` renders `none`.
1. Preserve backward-compatible behavior for the Phase 1 fields; the minimal
   call sites (if any remain) still work by passing `null`/`[]` for the new
   fields, OR update all call sites to pass the full input (preferred, since the
   panel has the data by Phase 5).

### Verification Checklist

- `parseChromeVersion('… Chrome/120.0.0.0 …')` returns `'120.0.0.0'`; a non
  Chrome UA returns `null`.
- `buildDiagnostic` renders chosen model, ladder path (with outcomes),
  Chrome version, and raw UA, plus all Phase 1 fields, in a stable order.
- Empty ladder path renders `none`.
- `npm run typecheck`, `npm run lint:ci` pass.

### Testing Instructions

Extend `tests/offscreen-diagnostic.test.ts`: cover `parseChromeVersion`
(Chrome, Edge-on-Chromium, non-Chrome), the new fields' rendering, and the
empty-path case. Pure, no Chrome.

### Commit Message Template

```text
feat(resilience): enrich the diagnostic with model, ladder path, UA

buildDiagnostic now includes the chosen model, the full ladder path with
per-tier outcomes, the raw user agent, and a best-effort parsed Chrome
version, alongside the existing capability and error fields. Pure and
unit-tested.
```

## Task 5.2: Track and feed the ladder path into the diagnostic

### Goal

Have the panel accumulate the per-tier outcomes during the ladder walk and pass
the structured `ladderPath` plus `chosenModel`, `userAgent` into the diagnostic
at every failure surface.

### Files to Modify/Create

- Modify `src/session.ts` (accumulate the path; build the full diagnostic input
  at each failure branch).
- Modify `tests/session.test.ts`.

### Prerequisites

Task 5.1.

### Implementation Steps

1. In `ensureWarm`, maintain a `ladderPath` array (the Phase 2 `path` list,
   extended to record each tier's outcome: `'success'`, `'load-failure'`, or
   `'network'`). Push an entry per attempt.
1. Replace the Phase 2 text-only path in the terminal message and the Phase 4
   network message with the structured `ladderPath` passed to `buildDiagnostic`,
   along with `chosenModel` (the model of the last/first ladder tier),
   `userAgent: navigator.userAgent`, and the existing capability/error fields.
1. Keep `chrome.runtime.getManifest().version` for `extensionVersion`.
1. Ensure the diagnostic input is built once per failure surface from the live
   state, not stale captures.

### Verification Checklist

- After a multi-tier failure, the terminal bubble's embedded diagnostic lists
  every attempted tier with its outcome.
- A network failure's message embeds the diagnostic with the network outcome on
  the attempted tier.
- The chosen model and UA appear in the diagnostic.
- All five commands pass.

### Testing Instructions

Extend `tests/session.test.ts`: drive a multi-tier failure (reject several
tiers) and assert the rendered diagnostic substring lists the tiers and
outcomes. jsdom provides `navigator.userAgent`; assert it appears. Use the
existing flush pattern.

### Commit Message Template

```text
feat(resilience): feed the live ladder path into failure diagnostics

ensureWarm accumulates per-tier outcomes and passes the structured
ladder path, chosen model, and user agent to buildDiagnostic at the
terminal and network failure surfaces.
```

## Task 5.3: Always-available copy-diagnostic affordance

### Goal

A small panel affordance, available at all times (not only on failure), that
copies the current diagnostic to the clipboard. Copy-only; nothing is sent.

### Files to Modify/Create

- Modify `src/session.ts` (render the affordance; wire copy with fallback).
- Possibly modify `src/ui/state.ts` or `src/ui/messages.ts` if a shared button
  helper is the cleanest home; prefer a small local helper in `session.ts`
  consistent with the existing `makeActionButton`.
- Modify `tests/session.test.ts`.

### Prerequisites

Tasks 5.1, 5.2.

### Implementation Steps

1. Add a small, unobtrusive affordance in the panel (e.g. a tiny "Copy
   diagnostic" text button in a corner of the panel root, styled with
   `BUTTON_CSS`-consistent muted styling). It is present whenever the panel is
   open, independent of failure state.
1. On click, build the diagnostic from the CURRENT live state: the last known
   capability snapshot (`lastGpuInfo` from `ensureWarm`; default conservative if
   warmup has not run), the current `ladderPath` and `chosenModel` (or the
   configured base tier when no walk has happened), the most recent error if any
   (else a placeholder like `none`), `extensionVersion`, and
   `navigator.userAgent`.
1. Copy to clipboard via `navigator.clipboard.writeText(text)`; on rejection or
   when `navigator.clipboard` is unavailable, fall back to a hidden `textarea` +
   `document.execCommand('copy')`. Wrap both in try/catch. On success, briefly
   change the affordance label to "Copied" then restore; on failure, show
   "Copy failed" (and leave the diagnostic available via the failure bubble).
1. Do NOT auto-send, log to network, or persist the diagnostic. It is built
   on-demand and copied locally only (constraint 4).
1. Ensure the affordance does not interfere with the chat layout or the
   existing toggle/anchor logic.

### Verification Checklist

- The affordance renders whenever the panel is open, regardless of load state.
- Clicking it builds a diagnostic and calls `navigator.clipboard.writeText`
  (mock it in jsdom) with a string containing the expected fields.
- When `writeText` rejects, the `execCommand` fallback path runs without
  throwing.
- Nothing is sent over the network (no `fetch`/`sendMessage` for diagnostics).
- All five commands pass.

### Testing Instructions

In `tests/session.test.ts`, stub `navigator.clipboard = { writeText: vi.fn(() =>
Promise.resolve()) }` (jsdom does not provide it by default) and assert the
affordance click calls it with a diagnostic string. Add a case where `writeText`
rejects and assert the fallback runs (mock `document.execCommand`). Assert the
affordance exists right after `initSession`/panel open with no failure.

### Commit Message Template

```text
feat(resilience): add an always-available copy-diagnostic affordance

A small panel control builds the current diagnostic on demand and copies
it to the clipboard (with an execCommand fallback for restricted
contexts). Copy-only: nothing is sent or persisted.
```

## Task 5.4: Docs for the diagnostic

### Goal

Document the diagnostic's contents, its always-available affordance, and the
copy-only privacy guarantee. Keep drift guards green.

### Files to Modify/Create

- Modify `docs/configuration.md` or `docs/privacy.md` (describe the diagnostic
  and the copy-only guarantee; privacy.md is the natural home for the
  nothing-leaves-the-device statement, configuration.md for how to copy it).
- Modify `docs/testing.md` only if a new test file was added (Phase 5 extends
  existing test files; likely no new row needed, but run the drift guard).

### Prerequisites

Tasks 5.1-5.3.

### Implementation Steps

1. In `docs/privacy.md`, add a short note: the diagnostic contains
   device/capability info, the model and tier, the ladder path, an error
   message, the extension version, and the browser user agent; it is built
   on-demand and copied locally only; nothing is auto-sent.
1. In `docs/configuration.md`, describe the "Copy diagnostic" affordance and
   when to use it (attaching to a bug report).
1. Run `npx vitest run tests/docs-config.test.ts` to confirm no drift. Keep
   markdown lint clean.

### Verification Checklist

- `npx vitest run tests/docs-config.test.ts` passes.
- `npm run lint:ci` passes.
- Docs accurately describe the copy-only behavior and the diagnostic contents.

### Testing Instructions

Run the docs-config drift guard. No new test code unless a new test file was
added.

### Commit Message Template

```text
docs(privacy): document the copy-only diagnostic contents

Describe what the diagnostic includes, the always-available Copy
affordance, and the guarantee that nothing leaves the device
automatically.
```

## Phase Verification

- Full green across all five commands.
- Integration points: the enriched builder consumed at the terminal, network,
  and always-available surfaces; the panel feeds live capability, ladder path,
  chosen model, error, extension version, and UA.
- Manual smoke (not strictly WebGPU): open the panel, click "Copy diagnostic",
  paste, and confirm a complete, readable report with no secrets and no network
  activity. Trigger a failure and confirm the embedded diagnostic matches.
- Feature complete: ROADMAP #1-#5 are delivered. The smaller-model rung remains
  gated behind `SMALLER_MODEL_ENABLED` pending the manual WebGPU vetting task
  from Phase 3 (a follow-up, not part of this feature's live default). Out of
  scope and deferred to separate vehicles: ROADMAP #6 (manual test matrix), #7
  (repo audit, stable-vs-dev ORT, version bump/tag/package), #8 (store
  compliance).
