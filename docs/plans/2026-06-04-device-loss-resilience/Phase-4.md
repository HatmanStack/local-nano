# Phase 4: Diagnostic Field, Version Bump, CHANGELOG

## Phase Goal

Add the `deviceLostAt` field to the Copy diagnostic so future bug reports
carry the device-loss timestamp. Bump the project version from 0.4.2 to
0.4.3 in `package.json` and `manifest.json`. Add the `0.4.3` entry at the
top of `CHANGELOG.md` describing the three-layer fix in the Keep-A-Changelog
format already established.

This phase ships LAST so a broken intermediate phase never propagates a
0.4.3 build. After this phase the extension is ready to package
(`npm run package`) for a manual smoke run.

### Success criteria

- `DiagnosticInput` in `src/offscreen/diagnostic.ts` gains a new
  `deviceLostAt: string` field. `buildDiagnostic` renders it as a new line
  `deviceLostAt: <value>` in a fixed position right after `errorMessage`.
- `src/session.ts` populates `deviceLostAt` from a panel-side
  `lastDeviceLostAt` value sourced from the next `gpu-info` reply's new
  `lastDeviceLostAt` field (per ADR-3, pull-only via the existing preflight
  round-trip; no SW-to-panel broadcast is added).
- `package.json` and `manifest.json` both read `0.4.3`.
- `CHANGELOG.md` has a new `## [0.4.3] - <today>` section at the top with
  an overview paragraph and a `### Fixed` subsection listing the three
  layers.
- The packaging step (`npm run package`) produces
  `web-store/local-nano-v0.4.3.zip` after the version bump.
- Estimated tokens: ~12,000.

## Prerequisites

- Phases 1, 2, 3 complete and merged. All five validation commands green.

## Tasks

### Task 4.1: Carry `lastDeviceLostAt` on the gpu-info reply

#### Goal

The panel needs to know `deviceLostAt` for the diagnostic. The simplest
read seam is the existing `gpu-info` round-trip the panel already issues
during its preflight (`src/session.ts` around line 1380:
`const info = await getGpuInfo();`). Extend the `GpuInfoSnapshot` /
`GpuInfoResponse` to carry an optional `lastDeviceLostAt: string | null`
field that the offscreen populates from its module-scoped state.

#### Files to Modify/Create

- **Modify** `src/offscreen/protocol.ts` — extend `GpuInfoSnapshot`:

  ```typescript
  export interface GpuInfoSnapshot {
    device: 'webgpu' | 'wasm';
    isFallback: boolean;
    maxBufferSize: number | null;
    configuredThreshold: number | null;
    /** ISO timestamp of the most recent device.lost event, or null. */
    lastDeviceLostAt: string | null;
  }
  ```

  Update `isGpuInfoResponse` to validate the new field
  (`null || (typeof === 'string')`). Existing wire compatibility is
  preserved by treating an absent field as `null` in the validator
  (`v.lastDeviceLostAt === undefined` -> treat as null), though after this
  phase the offscreen always populates it.

- **Modify** `offscreen.ts` — `collectGpuInfo` returns `lastDeviceLostAt:
  lastDeviceLostAt` (the module-scoped variable added in Phase 2). The
  WASM branch returns `null`.

- **Modify** `src/offscreen/client.ts` — `getGpuInfo` already returns a
  `GpuInfoSnapshot`; no change needed unless the client narrows the
  shape (it should not; it passes the validated reply through).

- **Modify** `tests/offscreen-protocol.test.ts` — extend the existing
  `isGpuInfoResponse` cases to cover `lastDeviceLostAt` being a string,
  `null`, or absent (absent treated as valid for backward shape, but the
  offscreen always sets it after this phase).

- **Modify** `tests/offscreen-client.test.ts` — extend the existing
  `getGpuInfo` cases to assert `lastDeviceLostAt` is round-tripped.

#### Prerequisites

- Phases 2 and 3 complete.

#### Implementation Steps

1. Edit `src/offscreen/protocol.ts`. The change is one new field plus the
   validator extension.
1. Edit `offscreen.ts`. `collectGpuInfo` already builds the snapshot in
   multiple branches; populate `lastDeviceLostAt` in each branch.
1. Run `npx vitest run tests/offscreen-protocol.test.ts` and
   `npx vitest run tests/offscreen-client.test.ts`.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npm run build` passes.
- The protocol and client tests pass with the new cases.

#### Testing Instructions

- Tests above.

#### Commit Message Template

```text
feat(protocol): carry lastDeviceLostAt on the gpu-info reply

Extends GpuInfoSnapshot with an ISO timestamp of the most recent
device.lost event (or null when none observed). The offscreen
collectGpuInfo populates it from the Phase 2 module-scoped state; the
panel reads it during its preflight to thread the value into the Copy
diagnostic.

The isGpuInfoResponse validator accepts an absent field as null for
backward shape; the offscreen always sets it after this commit.
```

### Task 4.2: Diagnostic shape gains `deviceLostAt`

#### Goal

Add the `deviceLostAt` field to `DiagnosticInput` and render it in
`buildDiagnostic`.

#### Files to Modify/Create

- **Modify** `src/offscreen/diagnostic.ts`:
  1. Extend `DiagnosticInput` with `deviceLostAt: string;` (always a
     string, with `'none'` representing absence; the renderer should not
     branch on null).
  1. Add a `deviceLostAt: ${input.deviceLostAt}` line to the `lines`
     array in `buildDiagnostic`, immediately after the `errorMessage`
     line.

- **Modify** `tests/offscreen-diagnostic.test.ts` — extend existing cases
  to populate `deviceLostAt` and assert the rendered string contains
  `deviceLostAt: 2026-06-04T...` (a sample timestamp) or
  `deviceLostAt: none`.

#### Prerequisites

- Task 4.1 merged.

#### Implementation Steps

1. Read `src/offscreen/diagnostic.ts` end to end. The change is two
   lines: one in the type, one in the `lines` array.
1. Update the existing diagnostic test cases. Add a new case that
   confirms ordering (the new field is in the expected position).

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npx vitest run tests/offscreen-diagnostic.test.ts` passes.

#### Testing Instructions

- Test above.

#### Commit Message Template

```text
feat(diagnostic): add deviceLostAt to the Copy diagnostic

DiagnosticInput gains a required deviceLostAt string field, rendered
on a new line immediately after errorMessage. The panel passes 'none'
when no loss has been observed; the Phase 2 gpu-info round-trip
populates an ISO timestamp otherwise.

Future bug reports carry the device-loss timestamp explicitly instead
of forcing the maintainer to infer it from a 'Generation failed'
message and a wall-clock guess.
```

### Task 4.3: Panel reads `lastDeviceLostAt` and feeds the diagnostic

#### Goal

Thread the new field from `getGpuInfo()` into the panel's diagnostic
input.

#### Files to Modify/Create

- **Modify** `src/session.ts`:
  1. The `GpuInfoSnapshot` already lives on the panel side (see the
     existing `lastGpuInfo` variable around line 949). Extend its
     default value to include `lastDeviceLostAt: null`.
  1. Where `lastGpuInfo` is assigned from `getGpuInfo()` (around line
     1380), the assignment is shape-wise compatible; no extra code.
  1. In `buildDiagnosticInput` (around line 1012), add
     `deviceLostAt: lastGpuInfo.lastDeviceLostAt ?? 'none'` to the
     returned object.
- **Modify** `tests/session.test.ts` — the existing diagnostic-shape
  tests (search for `'errorMessage:'` in the file) should be extended to
  cover the new `deviceLostAt` line. Mock `getGpuInfo` to return a
  `lastDeviceLostAt` and assert the terminal-bubble diagnostic contains
  `deviceLostAt: <iso>`; with `null`, contains `deviceLostAt: none`.

#### Prerequisites

- Task 4.2 merged.

#### Implementation Steps

1. Edit `src/session.ts`. Three small edits as above.
1. Update the affected `session.test.ts` cases.

#### Verification Checklist

- `npm run typecheck` passes.
- `npm run lint:ci` passes.
- `npx vitest run tests/session.test.ts` passes.

#### Testing Instructions

- Test above.

#### Commit Message Template

```text
feat(session): thread lastDeviceLostAt into the Copy diagnostic

The panel's lastGpuInfo (already populated from the gpu-info preflight)
now carries the new lastDeviceLostAt field. buildDiagnosticInput maps
the optional null to the string 'none' so the renderer keeps a fixed
output shape.

Adds session-test cases for both populated and 'none' rendering.
```

### Task 4.4: Version bump 0.4.2 -> 0.4.3 and CHANGELOG

#### Goal

Bump `package.json` and `manifest.json` to `0.4.3`. Add the `0.4.3`
Changelog entry. Do NOT commit any other change in this commit; this is
the release-readiness commit and must be reviewable in isolation.

#### Files to Modify/Create

- **Modify** `package.json` — `"version": "0.4.3"`.
- **Modify** `manifest.json` — `"version": "0.4.3"`.
- **Modify** `CHANGELOG.md` — insert a new section at the top under the
  introductory paragraph:

  ```markdown
  ## [0.4.3] - <today YYYY-MM-DD>

  Roots out the WebGPU device-loss failure that 0.4.2 caught reactively.
  Captures the GPUDevice handle through a transparent navigator.gpu
  monkey-patch in the offscreen document, listens for device.lost,
  marks the session poisoned, and rebuilds lazily on the next ensure.
  Pins the offscreen document open while any panel is visible so the
  30-second no-port reap cannot close it across a tab switch. Promotes
  the offscreen's zero-chunk stream completion from a silent ok:true
  to a typed terminal failure so the existing reactive recovery runs.

  ### Fixed

  - **Layer A: GPUDevice.lost listener.** The offscreen installs a
    transparent navigator.gpu monkey-patch at module top, captures the
    GPUDevice the polyfill flows through to, and attaches a .lost
    handler that marks the offscreen session poisoned and pushes
    SESSION_POISONED to the service worker. The next
    ENSURE_OFFSCREEN_REQUEST recreates the offscreen document (when not
    busy, per ADR-P7) before the user's send is dispatched.
  - **Layer B: SW-pinned offscreen port while panels are open.** The
    content script holds a long-lived port to the SW while the panel is
    visible; the SW holds a long-lived port to the offscreen while at
    least one panel-pin port is open. The pin port's existence prevents
    Chrome's 30-second no-port reap from closing the offscreen
    document across a tab switch.
  - **Layer C: authoritative zero-chunk stream detection.** A natural
    stream completion with zero tokens now surfaces as STREAM_DONE
    { ok: false, error: 'no tokens emitted; session may be poisoned' }.
    classifyFailure classes that as terminal so the existing reactive
    recovery in src/session.ts re-warms via the serialized primitive
    and retries the prompt once.
  - **Diagnostic.** The Copy diagnostic gains a new deviceLostAt field
    so future bug reports carry the ISO timestamp of the most recent
    device.lost event observed in the offscreen.
  ```

- **Modify** the docs that reference the version explicitly (if any).
  Search the repo for `0.4.2` literal strings outside `CHANGELOG.md`
  before committing:

  ```bash
  git grep -F '0.4.2' -- ':!CHANGELOG.md' ':!docs/plans/'
  ```

  Any non-plan, non-changelog hit should be updated to `0.4.3`, EXCEPT
  in commit messages, branding strings the user did not request, and
  package-lock.json (which is updated by `npm install` and need not be
  hand-edited).

#### Prerequisites

- Tasks 4.1 through 4.3 merged.

#### Implementation Steps

1. Edit `package.json`. One line.
1. Edit `manifest.json`. One line.
1. Edit `CHANGELOG.md`. Insert the new section above the existing
   `[0.4.2]` entry. The section header date is "today" at commit time;
   the planner does not pin a date because the implementation engineer
   may land this on a different day.
1. Run the grep command above and patch any remaining `0.4.2` hits in
   docs (e.g. README badges, docs/development.md). If no hits, no further
   edits.
1. Run `npm install --package-lock-only` to refresh `package-lock.json`
   with the new version, but DO NOT bump any dependency. The lockfile
   contains `"version": "0.4.2"` for the root package; the
   `--package-lock-only` flag updates this without installing.
1. Run `npm run package`. The script reads the package.json version and
   writes `web-store/local-nano-v0.4.3.zip`. The `web-store/` directory
   is gitignored per repo convention; the zip file is a build artifact,
   not a committed asset.

#### Verification Checklist

- `package.json` shows `"version": "0.4.3"`.
- `manifest.json` shows `"version": "0.4.3"`.
- `CHANGELOG.md` has the new section at the top.
- `npm run lint:ci`, `npm run typecheck`, `npx vitest run`,
  `npm run build` all pass.
- `web-store/local-nano-v0.4.3.zip` exists after `npm run package`.
- `git status` shows ONLY the version files, CHANGELOG, and (if needed)
  `package-lock.json` modified by this commit.

#### Testing Instructions

- The full suite via `npx vitest run`.
- `npx markdownlint-cli2 CHANGELOG.md` (the new section must pass
  markdownlint).

#### Commit Message Template

```text
release: 0.4.3 — root-cause WebGPU device-loss resilience

Bumps the version to 0.4.3 in package.json and manifest.json. Adds the
Keep-A-Changelog 0.4.3 section summarizing the three-layer fix from
this plan (Layer A: device.lost listener; Layer B: SW-pinned offscreen
port; Layer C: authoritative zero-chunk detection) plus the diagnostic
deviceLostAt field.

Version bump is intentionally the last commit of the plan so a broken
intermediate phase never propagates a 0.4.3 build.
```

## Phase Verification

### How to verify the whole phase is complete

Run, in this order, directly (no pipes to `tail`):

```bash
npm run lint:ci
npm run typecheck
npx vitest run
npm run build
npx markdownlint-cli2 docs/plans/2026-06-04-device-loss-resilience/**/*.md CHANGELOG.md
npm run package
```

All six must pass. `git log --oneline` since the phase started should
show four commits in the order of the four tasks above.

### Manual smoke (off-CI, optional but recommended before tagging)

1. `npm run build && npm run package`.
1. Load the unpacked extension from `dist/` in Chrome.
1. Open a tab, open the panel, send a message, confirm a response.
1. Switch tabs for ~60 seconds.
1. Switch back, reopen the panel if hidden, send a new message.
1. Confirm the response renders correctly on the FIRST send (Phase 3's
   pin port prevented the reap; the device was not lost).
1. Open the Copy diagnostic; confirm `deviceLostAt: none` (loss did not
   happen).
1. Optional adversarial: temporarily disable the pin port in
   `src/session.ts` (comment out the `acquirePinPort()` call) to force
   the loss path. Repeat the tab-switch repro. Confirm the first send
   after reopen still produces a response (Phase 2's lazy recovery on
   ensure recreated the document); confirm `deviceLostAt` carries an
   ISO timestamp.

### Integration points checked

- `src/offscreen/protocol.ts` `GpuInfoSnapshot` carries `lastDeviceLostAt`.
- `src/offscreen/diagnostic.ts` `DiagnosticInput` carries `deviceLostAt`;
  `buildDiagnostic` renders it.
- `src/session.ts` populates the panel-side `lastGpuInfo.lastDeviceLostAt`
  from the preflight `getGpuInfo()` and feeds it through
  `buildDiagnosticInput`.
- `package.json`, `manifest.json` both read `0.4.3`.
- `CHANGELOG.md` has the new section in Keep-A-Changelog format,
  consistent with the existing 0.4.2 entry.

### Known limits / tech debt accepted by this phase

- The `lastDeviceLostAt` is pulled via the panel's `getGpuInfo()`
  preflight (per ADR-3, no SW-to-panel broadcast). A panel that has been
  open since BEFORE the loss only sees the timestamp once another
  preflight runs — which it does on every warmup, including the
  device-loss recovery's own re-warm. Phase 2's lazy recovery path
  triggers `reloadModel` -> `recreateOffscreen` -> `ensureWarm`, and
  `ensureWarm` re-issues the preflight, so the next built diagnostic
  carries the fresh timestamp. A diagnostic built BETWEEN the loss and
  the recovery would report a stale `deviceLostAt`; this is acceptable
  because that window is empty of user interaction (the loss is silent
  until a send triggers the recovery).
- The Phase 4 implementation does NOT broadcast SESSION_POISONED to open
  panels as a "model reloading" notice. The brainstorm out-of-scopes
  that explicitly. A future release can layer it on top of the existing
  SW state without touching anything in this plan.
- Web Store submission and tagging are NOT in this plan. The version
  bump is the engineering hand-off; the maintainer (the user) decides
  when to tag and submit.
