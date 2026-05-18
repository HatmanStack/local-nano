# Phase 4 — Documentation and Release

## Phase Goal

Close out v0.2 with documentation and release plumbing: write
`docs/dom-actions.md` (the public-facing feature doc), update privacy /
README / architecture docs, bump versions in `manifest.json` and
`package.json` to `0.2.0`, and add the `[0.2.0]` CHANGELOG entry.

After this phase, the release workflow can publish 0.2.0 cleanly.

**Success criteria:**

- `docs/dom-actions.md` exists and is markdownlint-clean.
- `docs/privacy.md`, `README.md`, and `docs/architecture.md` updated to
  reflect v0.2.
- `manifest.json` and `package.json` both at `0.2.0`.
- `CHANGELOG.md` has a populated `[0.2.0]` section.
- `npx markdownlint-cli2 "docs/*.md" "README.md" "CHANGELOG.md"` exits 0.
- `npm run lint:ci && npm run typecheck && npm run coverage && npm run build`
  all exit 0.
- Test files have no regressions.

**Estimated tokens:** ~10k

## Prerequisites

- Phases 1, 2, 3 complete and merged.
- Manual smoke test from Phase-3 passed.

## Tasks

### Task 4.1 — Write `docs/dom-actions.md`

**Goal:** A new public doc that describes the v0.2 feature: what the menu
items do, how the hotkeys map, the preview-then-apply UX, privacy
implications, and how to add a new action in the future.

**Files to Modify/Create:**

- `docs/dom-actions.md` (new)

**Prerequisites:** None.

**Implementation Steps:**

- Create `docs/dom-actions.md` with these sections (markdownlint-clean —
  fenced code blocks with language tags, no trailing punctuation in
  headings, blank lines around blocks and lists):

  - **Heading and intro paragraph.** "DOM-Aware Actions" — explain
    that v0.2 makes the extension act on the user's selection or page
    via right-click menu + hotkeys, all on-device.

  - **Menu structure.** Table of every menu entry, its context
    (selection / page / editable), and what it does. Match the v0.2
    action list verbatim:

    The labels in the table below come from the canonical id-to-label
    table defined in Phase-1 Task 1.2. Do not paraphrase them — they must
    match what the user sees in the right-click menu.

    ```text
    | Menu item                                                         | Context                     | Behavior                                                                       |
    | ----------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
    | Ask local-nano about this                                         | selection                   | Prefill chat input with the selection wrapped as context; user types question  |
    | Summarize this page                                               | page (right-click anywhere) | Synthetic chat turn; page excerpt auto-prepended on first turn                 |
    | Rewrite ▸ Improve writing                                         | editable                    | Preview + apply rewrite that improves clarity and flow                         |
    | Rewrite ▸ Make shorter                                            | editable                    | Preview + apply rewrite that compresses                                        |
    | Rewrite ▸ Make formal                                             | editable                    | Preview + apply rewrite in formal register                                     |
    | Rewrite ▸ Fix grammar                                             | editable                    | Preview + apply grammar/spelling/punctuation fix                               |
    | Translate / Simplify / Summarize in place ▸ To English            | selection                   | Preview + apply translation to English                                         |
    | Translate / Simplify / Summarize in place ▸ To Spanish            | selection                   | Preview + apply translation to Spanish                                         |
    | Translate / Simplify / Summarize in place ▸ To French             | selection                   | Preview + apply translation to French                                          |
    | Translate / Simplify / Summarize in place ▸ Simplify              | selection                   | Preview + apply simpler-language rewrite                                       |
    | Translate / Simplify / Summarize in place ▸ Summarize             | selection                   | Preview + apply 1-3 sentence summary                                           |
    ```

  - **Hotkeys.** Table of the four `commands` and their default chords;
    note that users can rebind at `chrome://extensions/shortcuts`:

    ```text
    | Command id | Default chord (Linux/Win) | Default chord (Mac) | Action |
    | --- | --- | --- | --- |
    | toggle_ai_palette | Ctrl+Shift+K | Cmd+Shift+K | Open/close the chat panel |
    | ask_about_selection | Ctrl+Shift+L | Cmd+Shift+L | Ask about current selection |
    | rewrite_selection | Ctrl+Shift+I | Cmd+Shift+I | Rewrite current selection (Improve writing) |
    | translate_selection | Ctrl+Shift+U | Cmd+Shift+U | Translate current selection to English |
    ```

    Add a note that Chrome caps a manifest at 4 commands; the
    additional rewrite / translate variants are reachable via the
    context menu.

  - **Preview-then-apply UX.** Describe the Preview component: original
    on top, streamed result below, Apply / Discard buttons, Escape to
    discard, browser-native undo (`Ctrl+Z`) works on the Apply for
    `<input>` / `<textarea>` / contenteditable targets. Mention the
    1500-character selection cap and what happens when exceeded
    (error displayed in Preview before stream starts).

  - **Privacy.** Reiterate the on-device invariant: the selection
    text is part of the prompt to the local model and **does not** leave
    your machine. The new `contextMenus` permission grants no network
    access. Link to `docs/privacy.md`.

  - **Known limitations.**
    - Selections inside cross-origin iframes are not supported in
      v0.2 (top-frame only).
    - Translation languages are hardcoded EN / ES / FR; configurable
      set deferred to v0.3.
    - `contenteditable` widgets that intercept native events (Notion,
      Google Docs) may behave unexpectedly during Apply — the project
      uses `execCommand('insertText')` and falls back to direct Range
      mutation when that fails, but framework-specific guarantees are
      out of scope.
    - If the page DOM mutates between the right-click snapshot and the
      Apply click, the captured Range may point to changed content.
      Re-anchoring is out of scope for v0.2.
    - Only one transform may stream at a time; triggering a new
      transform aborts the in-flight one (consistent with the chat
      Send / Stop semantics).
    - The right-click menu currently shows v0.2 entries only on
      selection / page / editable contexts; image / link / non-text
      contexts are out of scope.

  - **How to add a new action.** Step-by-step for contributors:
    1. Add a new value to the `ActionId` union in
       `src/transform-prompts.ts`.
    1. Add a `ActionDescriptor` entry to `ACTION_DESCRIPTORS` with the
       appropriate `kind`, `label`, `parentLabel`, and `systemPrompt`.
    1. Add a test in `tests/transform-prompts.test.ts` for the new
       prompt (or extend the existing `every action has a prompt`
       sweep).
    1. If the action needs a new hotkey, add it to `manifest.json`'s
       `commands` block — but be aware of the 4-command Chrome cap.
       Also add the command→action mapping in
       `src/background/handler.ts`'s `COMMAND_TO_ACTION` table.
    1. If the action uses a brand-new `kind`, extend the `switch` in
       `descriptorToMenuProps` (background/menus.ts) and the `switch`
       in `dispatchAction` (`src/dom-actions.ts`).
    1. No content-script changes are needed if the action fits one of
       the existing kinds.

  - **Architecture pointer.** "Lower-level dataflow is described in
    [docs/architecture.md](architecture.md). The transform module is
    `src/transform.ts`; the action schema and prompts live in
    `src/transform-prompts.ts`; the apply layer is `src/dom-apply.ts`;
    the preview component is `src/ui/preview.ts`."

**Verification Checklist:**

- [ ] `docs/dom-actions.md` exists
- [ ] `npx markdownlint-cli2 "docs/dom-actions.md"` exits 0
- [ ] All internal links resolve (run `npx lychee --config .lychee.toml docs/dom-actions.md`)
- [ ] No emojis (project convention)

**Testing Instructions:**

- Lint: `npx markdownlint-cli2 "docs/dom-actions.md"`
- Link check (optional locally; CI runs lychee on push):
  `npx lychee --config .lychee.toml docs/dom-actions.md`

**Commit Message Template:**

```text
docs: add docs/dom-actions.md describing v0.2 feature surface

- Menu inventory, hotkey table, preview-then-apply UX, privacy
  invariant, and known limitations
- Step-by-step for adding a new action targeted at contributors
- Linked from README and architecture doc in subsequent commits
```

---

### Task 4.2 — Update Privacy, README, and Architecture Docs

**Goal:** Update the existing docs to reflect v0.2. Three small edits.

**Files to Modify/Create:**

- `docs/privacy.md` (modify)
- `README.md` (modify)
- `docs/architecture.md` (modify)

**Prerequisites:** Task 4.1 complete (so docs/dom-actions.md exists to
link to).

**Implementation Steps:**

- **`docs/privacy.md`**:
  - In "What stays on your machine", add a bullet:
    `**Selection text from right-click / hotkey actions.** Any text you
    select and feed into an action (Ask, Rewrite, Translate, etc.) is
    sent to the local model only. It is not transmitted off your
    machine.`
  - In the Permissions table, add a row:
    `| 'contextMenus' | Required for the right-click menu of DOM-aware
    actions. Grants no network access; chrome.contextMenus is a UI-only
    Chrome API. |`

- **`README.md`**:
  - Highlights section: add a new bullet before the existing "Per-tab
    chat history" line:
    `**DOM-aware actions.** Right-click any selection (or use a hotkey)
    to ask about it, rewrite editable text, or translate / simplify /
    summarize prose in place — preview the result, then Apply with one
    click. All actions stay on-device.`
  - Top nav (the `<p align="center">` link bar): insert
    `<a href="docs/dom-actions.md">DOM Actions</a> ·` after the
    Architecture link.
  - Documentation list at the bottom: insert
    `- [DOM Actions](docs/dom-actions.md) — right-click menu, hotkeys,
    and inline rewrite / translate`
    between Configuration and Models.

- **`docs/architecture.md`**:
  - Add a top-level heading "DOM-Aware Actions (v0.2)" after the
    Session Lifecycle section but before the ADRs. Briefly describe:
    - `chrome.contextMenus` registered from background;
      `chrome.runtime.onMessage` delivers `ActionMessage` to the
      content script.
    - `src/dom-actions.ts` snapshots the selection at right-click time
      and dispatches by descriptor kind.
    - `src/transform.ts` creates ephemeral `LanguageModel` sessions
      with action-specific prompts; reuses the shared `loadHeavy`
      cache.
    - Preview component (`src/ui/preview.ts`) sits in the panel,
      replacing the messages list while active.
    - DOM apply layer (`src/dom-apply.ts`) handles `<input>` /
      `<textarea>` / contenteditable / read-only prose branches.
  - "What lives where" table: add rows:
    - `Action schema & prompts | src/transform-prompts.ts`
    - `Per-action transform | src/transform.ts`
    - `Heavy module loader | src/heavy.ts`
    - `Context-menu registration | src/background/menus.ts`
    - `Selection capture & dispatch | src/dom-actions.ts`
    - `DOM apply layer | src/dom-apply.ts`
    - `Preview component | src/ui/preview.ts`
  - Add ADR section entries: ADR-005 through ADR-012 (titles only;
    full text already in `docs/plans/2026-05-18-dom-aware-actions/Phase-0.md`).
    The architecture doc should summarize each ADR in 2-3 lines.

**Verification Checklist:**

- [ ] All three files updated
- [ ] `npx markdownlint-cli2 "docs/*.md" "README.md"` exits 0
- [ ] `docs/dom-actions.md` link from README and architecture resolves

**Testing Instructions:**

- Lint: `npx markdownlint-cli2 "docs/*.md" "README.md"`
- Open the rendered README in a viewer (or
  `npx --yes serve .`) and confirm the new nav link works.

**Commit Message Template:**

```text
docs: surface v0.2 in privacy, README, and architecture

- privacy.md: selection-text bullet under "What stays"; contextMenus
  permission row added
- README.md: new highlight bullet, nav entry, and documentation-index
  entry for docs/dom-actions.md
- architecture.md: DOM-aware-actions section; "What lives where" rows
  for the new src/ modules; ADR-005 through ADR-012 summarized
```

---

### Task 4.3 — Bump Versions and CHANGELOG

**Goal:** Tag the release. The release workflow at
`.github/workflows/release.yml` watches for new `## [X.Y.Z]` headers on
main and tags + publishes — so the CHANGELOG entry has to be precise.

**Files to Modify/Create:**

- `manifest.json` (modify — version)
- `package.json` (modify — version)
- `CHANGELOG.md` (modify — new `[0.2.0]` section)

**Prerequisites:** Tasks 4.1 and 4.2 complete (docs in place).

**Implementation Steps:**

- `manifest.json`: change `"version": "0.1.1"` → `"version": "0.2.0"`.

- `package.json`: change `"version": "0.1.1"` → `"version": "0.2.0"`.

- `CHANGELOG.md`: insert a new section above `## [0.1.1]`. Use the
  Keep-a-Changelog format established in the file. Suggested content
  (refine before commit if implementation deviated):

  ```markdown
  ## [0.2.0] - 2026-05-18

  First feature release. v0.1.x was a chat panel that opened on a
  hotkey and read the page body as a single excerpt. v0.2 makes the
  extension DOM-aware: right-click on a selection (or hit a hotkey) to
  ask, rewrite, or transform that selection in place. All inference
  still runs on-device.

  ### Added

  - **Right-click menu.** `chrome.contextMenus` integration registered
    from the background service worker. Menu inventory:
    `Ask local-nano about this`, `Summarize this page`,
    `Rewrite ▸ {Improve writing, Make shorter, Make formal, Fix
    grammar}`, and
    `Translate / Simplify / Summarize in place ▸ {To English, To
    Spanish, To French, Simplify, Summarize}`.
  - **Hotkeys.** Three new commands (`ask_about_selection`,
    `rewrite_selection`, `translate_selection`) bring the manifest to
    its 4-command Chrome cap. Default chords are Ctrl+Shift+{L, I, U}
    (Cmd+Shift+{L, I, U} on Mac).
  - **Preview-then-apply UX.** Write-side actions stream into a stacked
    Preview component (original on top, model output below) with Apply
    / Discard buttons. Escape triggers Discard. Apply replaces the
    captured Range / input selection in the page DOM.
  - **Per-action ephemeral sessions.** `runTransform` creates a fresh
    `LanguageModel` session per action with a task-specific system
    prompt; the chat session is untouched. Transforms do not write to
    chat history. Heavy modules (Transformers.js + polyfill) share a
    module-level cache in the new `src/heavy.ts`.
  - **Selection snapshot layer.** `src/dom-actions.ts` snapshots the
    selection at `contextmenu` / `keydown` time via
    `Range.cloneRange()` or `<input>`/`<textarea>` offsets, so the
    selection survives the user clicking the panel.
  - **DOM apply layer.** `src/dom-apply.ts` covers three branches:
    `setRangeText` for `<input>` / `<textarea>` (plus a synthetic
    `input` event so React/Vue see the change),
    `execCommand('insertText')` for contenteditable (preserving native
    undo, with a Range-mutation fallback), and
    `deleteContents` + `insertNode(createTextNode)` for read-only
    prose. No `innerHTML` anywhere in the apply path.
  - **Docs.** New `docs/dom-actions.md` describing the menu inventory,
    hotkeys, preview-then-apply UX, privacy invariant, and contributor
    guide for adding a new action. Privacy doc and architecture doc
    updated to reflect v0.2.
  - **Tests.** `tests/transform-prompts.test.ts`,
    `tests/transform.test.ts`, `tests/background-menus.test.ts`,
    `tests/dom-actions.test.ts`, `tests/dom-apply.test.ts`,
    `tests/ui-preview.test.ts` add coverage for every new
    `src/` module.

  ### Changed

  - `initSession` now returns a `SessionHandle` (`openPanel`,
    `closePanel`, `isPanelOpen`, `prefillAndSend`, `mountPreview`) so
    the new dispatch layer can drive the panel without owning its DOM.
    The existing 24 session tests still pass unchanged.
  - `src/heavy.ts` factored out of `src/session.ts`. The heavy-module
    promise is now module-scoped so both the long-lived chat session
    and the per-action transform sessions share it.
  - `manifest.json`: `permissions` += `contextMenus`; `commands`
    expanded to the 4-command cap.
  - `tests/setup.ts`: extended with `contextMenus`,
    `runtime.onInstalled`, and `runtime.onStartup` mocks.

  ### Privacy

  - Selection text and chat input are still on-device only. The new
    `contextMenus` permission is a chrome UI API and grants no network
    access. See `docs/privacy.md` for the updated permissions table.

  ### Known Limitations

  - Translation languages hardcoded EN / ES / FR (configurable in v0.3).
  - Selections in cross-origin iframes are not supported (top frame
    only).
  - DOM mutations between the right-click snapshot and Apply may make
    the captured Range point to changed content; re-anchoring deferred.
  - `contenteditable` widgets that intercept native events may behave
    unexpectedly during Apply; framework-specific guarantees are not
    in scope.
  - Only one transform may stream at a time; a new transform aborts
    the in-flight one.
  ```

- Confirm the existing `[0.1.1]` and `[0.1.0]` sections are unchanged.

**Verification Checklist:**

- [ ] `manifest.json` version is `0.2.0`
- [ ] `package.json` version is `0.2.0`
- [ ] `CHANGELOG.md` has a populated `[0.2.0]` section above `[0.1.1]`
- [ ] `npx markdownlint-cli2 "CHANGELOG.md"` exits 0
- [ ] `npm run build` exits 0; reload the extension and confirm
      `chrome://extensions` shows version 0.2.0

**Testing Instructions:**

- `node -e "console.log(require('./manifest.json').version, require('./package.json').version)"`
  prints `0.2.0 0.2.0`.
- Full quality gate:
  `npm run lint:ci && npm run typecheck && npm run coverage && npm run build`

**Commit Message Template:**

```text
chore(release): bump to 0.2.0 and add CHANGELOG entry

- manifest.json and package.json -> 0.2.0
- CHANGELOG.md gains a populated [0.2.0] section covering the new
  context-menu surface, hotkeys, preview-then-apply UX, ephemeral
  per-action sessions, snapshot/apply layers, docs, and tests
- Existing [0.1.1] and [0.1.0] sections unchanged

This is the release commit that the release.yml workflow uses to tag
v0.2.0.
```

---

## Phase Verification

Final quality gate:

```bash
npm run lint:ci && npm run typecheck && npm run coverage && npm run build
npx markdownlint-cli2 "docs/*.md" "README.md" "CHANGELOG.md"
```

All five commands must exit 0. Additionally:

- The link from the README's nav bar to `docs/dom-actions.md` resolves.
- `chrome://extensions` shows version `0.2.0` after the reload.
- The manual smoke checklist from Phase-3 still passes on the released
  build.
- The CI workflow runs successfully on the resulting commit (push to a
  feature branch or open a PR; do not push directly to main unless the
  user explicitly approves).
- The release workflow (`.github/workflows/release.yml`) will pick up
  the new `## [0.2.0]` header on the next push to main and tag
  `v0.2.0`. This plan does **not** include the actual push to main —
  that is a human decision after final review.

## Definition of Done — Whole Plan

When all four phases are complete:

1. The full quality gate (lint, typecheck, coverage, build, markdownlint)
   exits 0.
1. Coverage thresholds met (lines/statements/functions >= 75%, branches
   >= 80%).
1. Every new `src/` module is covered at >= 80% statements, >= 75%
   branches (most are higher).
1. Existing v0.1.x tests pass unchanged.
1. Manual smoke checklist from Phase-3 passes on the loaded build.
1. `docs/dom-actions.md` is published; privacy, README, and architecture
   docs reflect v0.2.
1. `manifest.json` and `package.json` both at `0.2.0`.
1. CHANGELOG.md has the `[0.2.0]` section.
1. No `innerHTML` anywhere in `src/**/*.ts`.
1. No new outbound network traffic: the only network access is the
   existing Transformers.js model download.
