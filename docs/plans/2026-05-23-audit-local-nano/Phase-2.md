# Phase 2: Duplication and Console Gating [HYGIENIST]

## Phase Goal

Remove two hygiene smells: the verbatim-duplicated button `style.cssText`
strings in `src/session.ts`, and the unconditional production `console.log`
calls that leak prompt/response lengths and timings into the host page's
console on every turn. Extract one `BUTTON_CSS` constant and route diagnostic
logging through a single `DEBUG` gate.

Success criteria: the action-button CSS string appears exactly once as a shared
constant; production `console.log` diagnostic calls are gated behind a single
`DEBUG` flag (default off) so a normal build is quiet; `console.error` /
`console.warn` for genuine failures stay unconditional; tests and build pass.

Estimated tokens: ~14k.

## Prerequisites

- Phase-1 complete (smaller `session.ts` surface; `finalize` already removed).
- `cp .env.example.json .env.json`; `npm ci`.

## Tasks

### Task 2.1: Extract the duplicated button cssText into one constant

**Goal:** The action-button style string (`padding`, `font: inherit`,
`cursor: pointer`, `background: #444`, `color: #eee`, `border: 1px solid #666`,
`border-radius: 4px`) appears verbatim in
`makeActionButton` (`session.ts:232-233`) and again, with a leading
`'margin-top: 6px; '`, on the history-pressure Clear button
(`session.ts:539-540`). The Clear-conversation bubble button repeats it too.
Consolidate (`health` finding 12; eval Code Quality).

**Files to Modify/Create:**

- `src/session.ts`

**Prerequisites:** none beyond Phase-1.

**Implementation Steps:**

1. At module scope in `src/session.ts` (near the other `const` declarations
   like `PLACEHOLDER_CHAT`), add a `BUTTON_CSS` constant holding the shared
   base string (the `makeActionButton` value).
1. In `makeActionButton`, set `btn.style.cssText = BUTTON_CSS;`.
1. For the history-pressure Clear button (`attachHistoryPressureBubble`), which
   needs the extra `margin-top: 6px;`, set
   `btn.style.cssText = \`margin-top: 6px; ${BUTTON_CSS}\`;` (template literal)
   so the shared portion stays single-sourced.
1. Verify there is no third literal copy left; grep for `border-radius: 4px;`
   inside `session.ts` and confirm only `BUTTON_CSS` (and unrelated
   content.ts/chip styling, which is out of scope) carries the action-button
   palette.
1. Do not change visual output. The rendered `cssText` must be byte-identical
   to before for each button.

**Verification Checklist:**

- [x] `BUTTON_CSS` is declared once and referenced by `makeActionButton` and the
  history-pressure button.
- [x] The action-button style literal does not appear more than once in
  `session.ts`.
- [x] `npm run typecheck` exits 0; `npm run lint:ci` clean.
- [x] Existing button-related tests (`session.test.ts` Clear-conversation,
  history-pressure) pass unchanged.

**Testing Instructions:** Run `npm run coverage`. If a test asserts on a
specific `cssText` substring, it must still match. Add a small assertion in
`tests/session.test.ts` only if no existing test touches the buttons' presence;
otherwise rely on the existing history-pressure / Clear tests.

**Commit Message Template:**

```text
refactor(session): hoist duplicated button cssText into BUTTON_CSS

The action-button style string was copied verbatim across
makeActionButton and the history-pressure Clear button. One shared
constant; rendered output is unchanged.
```

### Task 2.2: Gate production console.log behind a single DEBUG flag

**Goal:** Multiple unconditional `console.log` calls ship in production
(`offscreen.ts:72,293,318,355`; `session.ts:316,327,651`; the undo/accept logs
at `session.ts:260,284`). They leak prompt/response lengths and timings to the
shared host-page console every turn (`health` finding 11). Route them through a
single `DEBUG` const so a normal build is quiet, while keeping `console.error` /
`console.warn` (genuine failures) and the already-appropriate `console.debug`
calls untouched.

**Files to Modify/Create:**

- `src/session.ts`
- `offscreen.ts`
- (optional) a tiny shared `src/debug.ts` if both files should share one flag.

**Prerequisites:** Task 2.1 done (same file).

**Implementation Steps:**

1. Decide the gate mechanism. Use a module-level `const DEBUG = false;` in a new
   `src/debug.ts` exporting a `debugLog(...args)` helper that no-ops when
   `DEBUG` is false, and import it where needed. Rationale for a shared module:
   `offscreen.ts` (an entry point, ESM-bundled) and `session.ts` (a `src/`
   module) both need it; a single source avoids drift. Keep the helper trivial
   (`export function debugLog(...args: unknown[]): void { if (DEBUG)
   console.log(...args); }`). `DEBUG` is a compile-time `false`; esbuild will
   tree-shake the dead branch in production.
1. Replace each unconditional diagnostic `console.log` in `session.ts` and
   `offscreen.ts` with `debugLog(...)`:
   - `offscreen.ts:72` heavy-modules-loaded log.
   - `offscreen.ts:293` stream/request prompt-length log.
   - `offscreen.ts:318` stream/done chunks/chars/timings log.
   - `offscreen.ts:355` "listener ready" log.
   - `session.ts:316` first-token-latency log.
   - `session.ts:327` stream-done chars/prompt-length log.
   - `session.ts:651` history-threshold dump log.
   - `session.ts:260` undo "restored original selection" log and `:284`
     "rewrite accepted; selection state reset" log (low-value, route through
     `debugLog`).
1. Do NOT change:
   - `console.error` (e.g. `session.ts:156` history write failure).
   - `console.warn` (e.g. `offscreen.ts:336` stream error; `session.ts:263`
     undo failed; `:576` clearConversation failed; `:657` gpu preflight;
     `:670` warmup failed; `client.ts` warns).
   - `console.debug` (`session.ts:213/215` selection diagnostics) — already
     correctly leveled.
1. `offscreen.ts` is bundled by esbuild as its own entry; confirm `build.mjs`
   includes `offscreen.ts` (it must, since the offscreen doc loads
   `dist/offscreen.js`). Importing `src/debug.js` from `offscreen.ts` is fine —
   esbuild inlines it. If `build.mjs` does not currently list `offscreen.ts` as
   an entry, do not add it here; instead inline a local `const DEBUG = false;`
   plus a private `dbg()` in `offscreen.ts` to avoid a build change. Verify
   `build.mjs` entry list before choosing.

**Verification Checklist:**

- No unconditional `console.log` remains in `src/session.ts` or `offscreen.ts`
  for diagnostics; each is `debugLog(...)` (or the local `dbg()` in offscreen).
- `console.error` / `console.warn` / `console.debug` calls are unchanged in
  count and level.
- With `DEBUG = false`, a built bundle emits no per-turn `console.log`. Confirm
  by grepping `dist/content.js` and `dist/offscreen.js` after `npm run build`
  for the leaked strings (e.g. `first token at`, `stream/request id=`) — they
  must be absent (tree-shaken) or unreachable.
- `npm run typecheck`, `npm run lint:ci`, `npm run coverage`, `npm run build`
  all pass.

**Testing Instructions:** Add `tests/debug.test.ts` (if a shared `src/debug.ts`
is created) asserting `debugLog` does not call `console.log` when `DEBUG` is
false. Since `DEBUG` is a const, the test can spy on `console.log` and assert
zero calls. If the offscreen path uses a local `dbg`, no test is required for it
(offscreen.ts is outside the coverage set per ADR-R5); the build-grep check
covers it.

**Commit Message Template:**

```text
chore(hygiene): gate diagnostic console.log behind a DEBUG flag

Per-turn logs leaked prompt/response lengths and timings to the shared
host-page console. Route them through a single compile-time DEBUG gate
(default off); error/warn/debug levels are unchanged.
```

## Phase Verification

- `BUTTON_CSS` exists once; button styling is single-sourced.
- Production build is quiet: no diagnostic `console.log` reaches a normal
  build; failure logging (`error`/`warn`) and `console.debug` are intact.
- `npm run typecheck`, `npm run lint:ci`, `npm run coverage`, `npm run build`
  pass.

Integration points: Phase-5 adds offscreen logic that should also use the same
gate; the `debugLog` helper introduced here is the convention to follow.

Known limitations: `content.ts` retains its own inline CSS strings (panel
chrome) — out of scope; only the action-button family is consolidated.
