# Phase 3: Gear Popover UI

## Phase Goal

Surface the feature: a gear/settings popover in the panel header that lists the
curated catalog (model picker) and the idle-timeout options, with a
select-then-explicit-Load flow that calls the Phase 2 serialized re-warm
primitive. The popover mounts like the existing Copy-diagnostic control, via the
`header` dep in `SessionDeps`.

Success criteria: a gear button appears in the panel header; clicking it opens a
popover showing each visible catalog model (displayName, download size, note)
with the current selection marked, plus the idle-timeout radio options; selecting
a model marks it as the pending preference; clicking Load persists the model
preference and runs `reloadModel`; the Load control is disabled while a stream is
in flight (ADR-P7). All DOM behavior is unit-tested in jsdom; the real model
switch is manual-smoke.

Estimated tokens: ~35,000.

## Prerequisites

- Phases 0, 1, 2 complete and green. ADR-P6, P7, P11, P12 govern this phase.
- Read `makeCopyDiagnosticAffordance` and its header-mount block in
  `src/session.ts` (the existing pattern to mirror), `content.ts` (how `header`
  is supplied and how header controls are grouped), and `src/ui/state.ts`
  (button-state helpers and `BUTTON_CSS` usage).

## Tasks

> **Task 3.1: Gear button and popover scaffold in the header**
>
> **Goal:** Add an unobtrusive gear button to the panel header that toggles a
> popover container, mounted via the `header` dep exactly like the Copy-
> diagnostic control, falling back to the panel root when no header is supplied.
>
> **Files to Modify/Create:**
>
> - `src/session.ts` (modify) - Build the gear button + popover, mount in the
>   header.
>
> **Prerequisites:**
>
> - Read the existing header-mount block in `src/session.ts` (the one that does
>   `header.insertBefore(copyBtn, header.lastElementChild)`), and the
>   `header.addEventListener('mousedown', …)` drag-suppression in `content.ts`
>   (it already ignores presses on `button` elements, so the gear button will not
>   start a panel drag).
>
> **Implementation Steps:**
>
> - Add a `makeSettingsAffordance()` builder returning the gear button and a
>   hidden popover element it controls (or a small object exposing both plus an
>   `open`/`close` toggle). Style the gear button consistently with the muted
>   header controls (mirror the `makeCopyDiagnosticAffordance` CSS: transparent
>   background, muted color, small font, `flex-shrink: 0`). Use a gear glyph or
>   the text "Settings" as the label; keep it text/Unicode, no image asset.
> - The popover is an absolutely-positioned container anchored under the header,
>   high `z-index` (the panel root is already `z-index: 2147483647`; keep the
>   popover within the panel stacking context). Hidden by default
>   (`display: none`); the gear button toggles it. A click outside the popover
>   (or a second gear click) closes it. Keep the popover inside the panel root so
>   it inherits the panel's fixed positioning and is removed with the panel.
> - Mount the gear button in the header next to the Copy-diagnostic control
>   (group the header controls on the right, as `content.ts` already arranges
>   with `title.style.marginRight = 'auto'`). When `header` is absent (tests),
>   fall back to appending to `root`, mirroring the Copy-diagnostic fallback.
> - Do NOT change `content.ts` beyond what is necessary; the `header` dep already
>   flows in. If a structural change to the header is needed, keep it minimal and
>   note it.
>
> **Verification Checklist:**
>
> - [x] After `initSession`, a gear button is present in the header (or root in
>       the no-header test path).
> - [x] Clicking the gear toggles the popover's visibility.
> - [x] A click outside the popover closes it.
> - [x] The gear button does not start a panel drag (it is a `button`, which
>       `content.ts` already excludes from drag).
>
> **Testing Instructions:**
>
> - Extend `tests/session.test.ts`: assert the gear button exists after init,
>   assert toggling shows/hides the popover, assert outside-click closes it.
>   Build the DOM in jsdom as the existing tests do.
> - Run `npx vitest run tests/session.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(picker): add a gear settings popover to the panel header
>
> - makeSettingsAffordance: gear button toggling a header-anchored popover
> - mounts via the header dep like the Copy-diagnostic control; root fallback
> - outside-click and second-click close; no panel-drag interference
> ```

---

> **Task 3.2: Model list rendering with current-selection marker**
>
> **Goal:** Render the visible catalog inside the popover, each row showing the
> display name, download size, and note, with the current preference (or the
> default) marked, and a pending-selection state that does not yet apply
> (ADR-P12, select-then-Load).
>
> **Files to Modify/Create:**
>
> - `src/session.ts` (modify) - Render the catalog rows and track the pending
>   selection.
>
> **Prerequisites:**
>
> - `listCatalog`, `findCatalogEntry`, `DEFAULT_MODEL_ID` from `catalog.ts`;
>   `loadModelPref` from `model-pref.ts`.
>
> **Implementation Steps:**
>
> - On popover open (or once at init), call `listCatalog()` (gated; Qwen3.5-0.8B
>   appears only when `QWEN3_08B_ENABLED`, larger entries only when
>   `LARGER_MODEL_ENABLED`, both off in production) and render one selectable row
>   per entry: `displayName`, `downloadSize`, and `note`. Use radio inputs or
>   clickable rows; keep markup minimal and styled to match the dark panel. In
>   production the visible rows are gemma-4-E2B (default) and Qwen2.5-0.5B only.
> - Determine the currently-selected id: `loadModelPref().modelId ??
>   DEFAULT_MODEL_ID`. Mark that row as the current selection. The DEFAULT row is
>   labeled as the default (e.g. "(default)") per ADR-P4.
> - Track a `pendingModelId` separate from the persisted preference. Selecting a
>   row updates `pendingModelId` only; it does NOT persist or reload (select-then-
>   explicit-Load, decision 7). The Load button (Task 3.4) commits it.
> - When `pendingModelId` differs from the current selection, visually indicate
>   the row is pending and enable the Load button (Task 3.4 owns the button
>   state). When they match, the Load button is disabled (nothing to apply).
>
> **Verification Checklist:**
>
> - [x] Each visible catalog entry renders a row with displayName, size, note.
> - [x] In production (all gates off) only gemma-4-E2B and Qwen2.5-0.5B render.
> - [x] The current model (preference or default) is marked.
> - [x] Gated entries do not appear with their flag off; they do with it on
>       (`vi.spyOn` on `isQwen3_08bEnabled` / `isLargerModelEnabled`).
> - [x] Selecting a row changes `pendingModelId` but does NOT persist or reload.
>
> **Testing Instructions:**
>
> - Extend `tests/session.test.ts`: seed a preference, open the popover, assert
>   the rows and the marked current selection; click a different row and assert
>   no `saveModelPref`/`reloadModel`/`recreateOffscreen` fires yet (spy the
>   client/store). Spy `isQwen3_08bEnabled` / `isLargerModelEnabled` for the
>   gated-row case.
> - Run `npx vitest run tests/session.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(picker): render the catalog model list in the popover
>
> - one row per visible catalog entry (name, size, note); current marked
> - selecting a row sets a pending choice only; no persist, no reload
> - gated entries hidden while their gate flag is off (production: 2 rows)
> ```

---

> **Task 3.3: Idle-timeout selector in the popover**
>
> **Goal:** Render the idle-timeout options (`5 min / 15 min / 60 min / Never`,
> default 15) in the same popover, persisting the choice immediately on change
> (the timeout is not a multi-GB action, so it does not need the explicit-Load
> guard) (ADR-P11).
>
> **Files to Modify/Create:**
>
> - `src/session.ts` (modify) - Render the timeout options and persist on change.
>
> **Prerequisites:**
>
> - `IDLE_TIMEOUT_OPTIONS`, `DEFAULT_IDLE_TIMEOUT_MINUTES`,
>   `setIdleTimeoutMinutes`, `loadModelPref` from `model-pref.ts`.
>
> **Implementation Steps:**
>
> - Render `IDLE_TIMEOUT_OPTIONS` as a labeled radio group in the popover, under
>   or beside the model list, with a short heading (e.g. "Release model after").
> - Initialize the selected option from `loadModelPref().idleTimeoutMinutes ??
>   DEFAULT_IDLE_TIMEOUT_MINUTES`.
> - On change, call `setIdleTimeoutMinutes(minutes | null)` immediately
>   (persisting the choice). Selecting "Never" stores `null`.
> - Phase 4 reads this stored value when scheduling the alarm; this phase only
>   persists it. Do NOT wire any alarm here. If the SW needs to learn of a change
>   while running, Phase 4 handles re-reading on the next `touchIdle`; no live
>   alarm reschedule is required in this phase.
>
> **Verification Checklist:**
>
> - [x] The four options render; the stored/default option is preselected.
> - [x] Changing the option calls `setIdleTimeoutMinutes` with the right value
>       (including `null` for "Never").
> - [x] No alarm or reload is triggered by changing the timeout.
>
> **Testing Instructions:**
>
> - Extend `tests/session.test.ts`: open the popover, assert the preselected
>   option matches the stored value, change it, assert the stored record's
>   `idleTimeoutMinutes` updated (read `chromeMock.storage.local.store`). Assert
>   no `recreateOffscreen` fires.
> - Run `npx vitest run tests/session.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(idle): add idle-timeout selector to the settings popover
>
> - radio group 5/15/60/Never, default 15; persists on change
> - Never stores null (release disabled); no alarm wired here yet
> ```

---

> **Task 3.4: Load control that applies the pending model**
>
> **Goal:** A Load button that persists the pending model preference and runs the
> serialized re-warm primitive, gated so it cannot fire while a generation
> streams (ADR-P6, P7).
>
> **Files to Modify/Create:**
>
> - `src/session.ts` (modify) - The Load button, its enable/disable logic, and
>   the apply handler.
>
> **Prerequisites:**
>
> - `reloadModel` from Phase 2 Task 2.3; `setModelId` from `model-pref.ts`; the
>   panel's `activeAbort` and `reWarmInFlight` state.
>
> **Implementation Steps:**
>
> - Add a Load button to the popover, styled with `BUTTON_CSS`. Enabled only when
>   `pendingModelId` differs from the current selection AND no stream is in flight
>   (`activeAbort` is null) AND no re-warm is in flight (`reWarmInFlight` is
>   null). Otherwise disabled. When a stream is in flight, show an unobtrusive
>   note ("finishing current response") rather than a hard error (ADR-P7).
> - On click: `await setModelId(pendingModelId)`, then `await reloadModel()`
>   (Phase 2's serialized primitive, which recreates the document and re-walks
>   the ladder, now resolving the new preference in `ensureWarm`). Disable the
>   Load button and show the existing loading affordance while the reload runs;
>   re-enable/refresh the popover state when it resolves. Close the popover on a
>   successful Load (the model list re-reads the new current selection next open).
> - The reload runs the standard `ensureWarm` walk, so all existing failure UI
>   (terminal bubble, network bubble, progress) applies to a switch unchanged.
> - When `activeAbort` becomes null (a stream finishes), refresh the Load button
>   enabled state so a switch the user queued can proceed. Hook this into the
>   existing stream-finalize tail (`runStreamTurn`'s finally) via a small
>   "refresh popover controls" callback; keep it side-effect-light.
>
> **Verification Checklist:**
>
> - [x] Load is disabled when the pending selection equals the current one.
> - [x] Load is disabled while `activeAbort` is set (a stream is in flight) and
>       re-enables when the stream finishes.
> - [x] Clicking Load persists the model id then calls `reloadModel` exactly
>       once.
> - [x] A second rapid Load click does not start a second concurrent reload
>       (coalesced by `reWarmInFlight` from Phase 2).
> - [x] A failed reload surfaces the existing terminal/network failure UI.
>
> **Testing Instructions:**
>
> - Extend `tests/session.test.ts`: select a non-current model, click Load,
>   assert `setModelId` then `recreateOffscreen` + the warmup walk fire in order
>   (mocked client). Set `activeAbort` (simulate an in-flight stream) and assert
>   Load is disabled; finish the stream and assert it re-enables. Assert
>   double-click coalescing.
> - Run `npx vitest run tests/session.test.ts`.
>
> **Commit Message Template:**
>
> ```text
> feat(picker): add the Load control to apply a model switch
>
> - Load persists the pending model id then runs reloadModel (Phase 2)
> - disabled until the pending choice differs and no stream/reload is active
> - blocks (does not abort) while a generation streams; re-enables after
> - reuses existing warmup failure/progress UI for the switch
> ```

## Phase Verification

- `npm run typecheck`, `npm test -- --run`, `npm run build`, `npm run lint:ci`,
  `npm run coverage` all green.
- The popover renders the catalog and timeout options, marks the current
  selection, and applies a switch only on explicit Load.
- Selecting a model is inert until Load; changing the timeout persists
  immediately and triggers no reload.
- The Load control respects the in-flight-stream and in-flight-reload gates.
- No vendor edits; no new `LanguageModel.create`; single shared session
  preserved (the switch goes through recreate + ensureWarm).

### Integration points to verify

- Popover mounts via the `header` dep; falls back to root in tests.
- Load persists via `setModelId` then drives the Phase 2 `reloadModel`, which
  resolves the new preference in `ensureWarm` (Phase 2 Task 2.2).

### Known limitations / manual-smoke only

- The actual multi-GB model switch (teardown, download/cache, coherent answer)
  is manual-smoke only (Phase-0 matrix steps 1, 2). jsdom verifies the wiring,
  not the WebGPU load.
- Idle release is still not active; Phase 4 reads the persisted timeout and adds
  the alarm.
