# Phase 4 — [DOC-ENGINEER] Documentation Fixes

## Phase Goal

Fix the documentation drift before the 0.4.0 listing ships: correct the CHANGELOG
and configuration drift, document the 0.4.0 user-facing feature set in prose,
repair the stale line anchors, add the `alarms` permission to the privacy and
store docs, and clean the version-stale labels. Code is the source of truth in
every case (the audit confirmed code is correct).

**Success criteria:**

- CHANGELOG 0.4.0 catalog entry matches the shipped three-live-entry catalog and
  the real gate flags.
- `docs/configuration.md` no longer recommends the rejected Qwen3.5-0.8B model;
  it recommends the three live catalog models.
- The model picker / gear popover, idle resource release, and `<think>`
  stripping are documented in prose (README + the relevant docs), and the
  `src/offscreen/` module inventory in architecture/development is complete.
- The ~8 stale `offscreen.ts:NN` / `session.ts:NN` anchors and the
  `prompt-api-polyfill.js:189`→191 off-by-2 are corrected.
- The `alarms` permission is explained in `PRIVACY.md`, `docs/privacy.md`, and
  `docs/chrome-web-store.md`.
- Version-stale labels in `docs/transform.md` are updated; the Web-Store status
  contradiction in README is resolved against ROADMAP.

**Estimated tokens:** ~38k.

## Prerequisites

- Phases 1–3 complete (code now matches what the docs will describe; e.g. Phase 2
  may have added a test file the `docs/testing.md` table must reflect, and the
  offscreen comment was reworded in Phase 1).
- markdownlint-cli2 and lychee run in CI — every edit must pass markdownlint and
  introduce no broken links.

## Task 4.1 — Fix the CHANGELOG 0.4.0 catalog drift (HIGH drift)

**Goal:** `CHANGELOG.md` 0.4.0 "Curated model catalog" entry says "Two live
entries — gemma-4-E2B + Qwen2.5-0.5B" and names a gate `QWEN3_08B_ENABLED` that
DOES NOT EXIST. The shipped catalog has THREE live entries and only
`LARGER_MODEL_ENABLED` (catalog.ts) + `SMALLER_MODEL_ENABLED` (ladder.ts).

**Files to Modify:**

- `CHANGELOG.md` (the 0.4.0 "Curated model catalog" bullet, and the "Notes"
  bullet that also references `Qwen3.5-0.8B` / the gated entries)

**Prerequisites:** none.

**Implementation Steps:**

1. Re-verify the ground truth in `src/offscreen/catalog.ts`: THREE non-gated
   (live) entries — `onnx-community/Qwen2.5-0.5B-Instruct` (`wasm/q8`),
   `onnx-community/Qwen3-0.6B-ONNX` (`webgpu/q4f16`, WASM fallback), and the
   `onnx-community/gemma-4-E2B-it-ONNX` default (`webgpu/q4f16`). The only gate in
   `catalog.ts` is `LARGER_MODEL_ENABLED = false`; `ladder.ts` has
   `SMALLER_MODEL_ENABLED = false`. There is NO `QWEN3_08B_ENABLED`. ROADMAP.md
   already says "3 live models" — match it.
1. Rewrite the "Curated model catalog" bullet to list THREE live entries (gemma
   default, Qwen2.5-0.5B WASM-only, Qwen3-0.6B small-WebGPU) and reference only
   the real gate flag(s): `LARGER_MODEL_ENABLED` for the placeholder larger slot
   (and `SMALLER_MODEL_ENABLED` if mentioning the ladder rung). Remove
   `QWEN3_08B_ENABLED` entirely.
1. Fix the 0.4.0 "Notes" bullet that says "The gated catalog entries
   (`Qwen3.5-0.8B`, the larger-model slot) stay off…" — Qwen3.5-0.8B is NOT a
   gated catalog entry (it was rejected as vision-language; see
   `docs/models.md`). Reword to reference only the real gated placeholder
   (larger-model slot behind `LARGER_MODEL_ENABLED`) and the smaller ladder rung
   behind `SMALLER_MODEL_ENABLED`. Do not name Qwen3.5-0.8B as gated.
1. Keep the entry's prose accurate to the shipped behavior (select-then-Load,
   preference persistence, idle release) — only the catalog count and gate names
   are wrong; do not rewrite correct sentences.
1. Preserve Keep-a-Changelog structure and markdownlint compliance.

**Verification Checklist:**

- [x] CHANGELOG 0.4.0 lists exactly three live catalog entries matching
      `catalog.ts`.
- [x] `QWEN3_08B_ENABLED` no longer appears in `CHANGELOG.md`
      (`grep QWEN3_08B CHANGELOG.md` is empty).
- [x] Only real gate names appear (`LARGER_MODEL_ENABLED`,
      `SMALLER_MODEL_ENABLED`).
- [x] Qwen3.5-0.8B is not described as a gated catalog entry.
- [x] markdownlint passes on `CHANGELOG.md`.

**Testing Instructions:** `npx markdownlint-cli2 CHANGELOG.md`;
`grep -n "QWEN3_08B\|Two live" CHANGELOG.md` returns nothing.

**Commit Message Template:**

```text
docs(changelog): correct 0.4.0 catalog entry to shipped three-model reality

The 0.4.0 entry claimed two live catalog entries and a QWEN3_08B_ENABLED
gate that does not exist. The shipped catalog has three live entries
(gemma-4-E2B, Qwen2.5-0.5B, Qwen3-0.6B) behind only LARGER_MODEL_ENABLED /
SMALLER_MODEL_ENABLED. Match the code and ROADMAP.
```

## Task 4.2 — Fix the stale model recommendation in configuration.md (HIGH stale)

**Goal:** `docs/configuration.md:29` recommends
`onnx-community/Qwen3.5-0.8B-ONNX`, which `docs/models.md` and ROADMAP document
as REJECTED (vision-language model the text-only polyfill cannot load). Replace
it with models that actually work.

**Files to Modify:**

- `docs/configuration.md` (the "practical picks" bullet list under `modelName`,
  around line 28-30)

**Prerequisites:** none.

**Implementation Steps:**

1. Re-read the "practical picks" list. The current middle bullet
   (`onnx-community/Qwen3.5-0.8B-ONNX — small, fast, decent for short answers;
   needs WebGPU`) is the stale recommendation.
1. Replace the picks with the three live catalog models, matching the
   per-model notes in `catalog.ts` / `docs/models.md`:
   - `onnx-community/gemma-4-E2B-it-ONNX` — the default; bigger, smarter; WebGPU
     (`q4f16`).
   - `onnx-community/Qwen3-0.6B-ONNX` — small WebGPU option; reasoning model
     (`<think>` stripped), WASM fallback.
   - `onnx-community/Qwen2.5-0.5B-Instruct` — smallest that answers; CPU/WASM
     only (WebGPU parrots for this model — do NOT recommend WebGPU for it).
1. Do NOT recommend Qwen3.5-0.8B anywhere as a working modelName. If a sentence
   benefits from a "models that fail" pointer, cross-link `docs/models.md`
   (already linked at the end of the section) rather than re-listing rejects.
1. Keep the `.env.json` example block (line 9-16) as-is — its default
   (`gemma-4-E2B-it-ONNX`) is correct.
1. markdownlint compliance.

**Verification Checklist:**

- [x] `docs/configuration.md` no longer lists `Qwen3.5-0.8B-ONNX` as a
      recommended modelName (`grep -n "Qwen3.5-0.8B" docs/configuration.md` is
      empty).
- [x] The picks list the three live catalog models with notes consistent with
      `catalog.ts` / `docs/models.md` (Qwen2.5-0.5B marked WASM-only).
- [x] markdownlint passes.

**Testing Instructions:** `npx markdownlint-cli2 docs/configuration.md`;
`grep -n "Qwen3.5-0.8B" docs/configuration.md` empty.

**Commit Message Template:**

```text
docs(configuration): replace rejected Qwen3.5-0.8B with live catalog models

configuration.md recommended onnx-community/Qwen3.5-0.8B-ONNX, which
docs/models.md and ROADMAP record as a rejected vision-language model the
text-only polyfill cannot load. Recommend the three live catalog models
instead (gemma default, Qwen3-0.6B, Qwen2.5-0.5B WASM-only).
```

## Task 4.3 — Document the 0.4.0 user-facing feature set in prose (HIGH gap)

**Goal:** the model picker / gear popover, idle resource release (alarms, the
5/15/60/Never default-15 timeout), and `<think>` stripping appear only in
CHANGELOG/ROADMAP. README "Using it"/"Configuration" still describe a model fixed
by `.env.json` with no gear popover or idle timeout. Document these in prose. Also
correct the README OOM/auto-rebuild claim that contradicts current code.

**Files to Modify:**

- `README.md` ("Highlights", "Using it", "Configuration" sections)
- `docs/configuration.md` (a section on the model picker + idle timeout, since it
  is the configuration reference)
- `docs/architecture.md` ("What lives where" table — enumerate the
  `src/offscreen/` modules; add the model-host/picker/idle/think-strip concerns)
- `docs/development.md` (the `src/offscreen/` tree comment around line 60 — list
  the actual modules)

**Prerequisites:** none, but read `catalog.ts`, `model-pref.ts`,
`idle-policy.ts`, `think-strip.ts` to describe behavior accurately.

**Implementation Steps:**

1. **README "Using it":** add prose for the gear/settings popover (select a
   curated model, click Load to commit, choice persists and is NOT reset on
   version bump) and the idle resource release (the model is released after an
   inactivity timeout — 5 / 15 / 60 min or Never, default 15 — and re-warmed on
   next use). Describe behavior, not implementation.
1. **README "Configuration":** note that, beyond `.env.json`, the in-panel gear
   popover lets a user pick a model and set the idle timeout at runtime; the
   `.env.json` model is the boot default and the picker overrides per the stored
   preference. Keep the `.env.json` example.
1. **README "Highlights" — fix the OOM/auto-rebuild drift.** The current
   bullet(s) claim "Recovers from WebGPU out-of-memory by rebuilding the session"
   and "If a turn fails on GPU memory, it rebuilds and retries automatically".
   The code REMOVED the automatic device-loss rebuild/retry guard
   (`offscreen.ts` rebuildSession doc: "the automatic device-loss rebuild/retry
   guard was removed"; `src/session.ts` comment: "no churny auto-rebuild"). What
   actually exists: a LOAD-time fallback ladder + manual Retry/Reset, a
   history-pressure warning, one-click Clear conversation, and (0.4.0) a
   single-retry reactive re-warm only after an idle hard release. Reword these
   bullets to describe the real behavior (load-time ladder + manual recovery +
   memory warning + Clear), removing the false "rebuilds and retries
   automatically on GPU-memory failure" claim. Verify against the code before
   writing.
1. **docs/configuration.md:** add a "Model picker and idle release" section
   describing the gear popover (select-then-Load, curated catalog, preference
   persistence key `local-nano:model-pref:v1`, survives version bump) and the
   idle timeout options (5/15/60/Never, default 15; measured from last
   generation; `chrome.alarms`-backed so it survives SW eviction; hard-closes the
   offscreen document to reclaim VRAM; re-warms on next use). Cross-reference
   `docs/architecture.md`. Mention `<think>` stripping where reasoning models
   (Qwen3-0.6B) are discussed — the reasoning block is hidden, only the answer
   shows.
1. **docs/architecture.md "What lives where":** the table currently has a single
   generic `Offscreen client/protocol | src/offscreen/` row. Expand to enumerate
   the actual modules so the inventory is complete: `busy-gate.ts`,
   `capability.ts`, `capability-store.ts`, `catalog.ts`, `client.ts`,
   `diagnostic.ts`, `dispatch.ts`, `failure.ts`, `idle-policy.ts`, `ladder.ts`,
   `model-pref.ts`, `progress.ts`, `protocol.ts`, `stream-client.ts` (14 files —
   verify the list against `ls src/offscreen/` at edit time). Add concern rows
   for the model picker/catalog, idle policy, and `<think>` stripping
   (`src/think-strip.ts`). Keep the table markdownlint-valid.
1. **docs/development.md:** the project-tree code block comment at ~line 60 says
   `src/offscreen/ # client, protocol, stream-client, dispatch, busy-gate` —
   update it to reflect the broader module set (it need not list all 14 inline,
   but must not imply only 5 exist; either list them or say "client, protocol,
   ladder, catalog, model-pref, idle-policy, capability, diagnostic, … (see
   docs/architecture.md)"). Verify the actual file list at edit time.
1. Run markdownlint on every edited file; confirm lychee-relevant internal links
   (e.g. new cross-links to architecture.md) resolve.

**Verification Checklist:**

- [x] README "Using it" documents the gear popover (select-then-Load) and the
      idle timeout (5/15/60/Never, default 15).
- [x] README "Configuration" notes the runtime picker/idle settings alongside
      `.env.json`.
- [x] README no longer claims automatic GPU-memory rebuild/retry; it describes
      the load-time ladder + manual recovery + memory warning + Clear (matches
      `offscreen.ts` / `src/session.ts`).
- [x] `docs/configuration.md` has a model-picker + idle-release section and
      mentions `<think>` stripping for reasoning models.
- [x] `docs/architecture.md` "What lives where" enumerates the `src/offscreen/`
      modules (verified against `ls src/offscreen/`) and adds picker/idle/
      think-strip concern rows.
- [x] `docs/development.md` tree comment no longer implies only 5 offscreen
      modules.
- [x] `grep -ri "picker\|gear" README.md docs/configuration.md
      docs/architecture.md` now returns matches.
- [x] markdownlint passes on all edited files; no broken internal links.

**Testing Instructions:** `npx markdownlint-cli2 README.md docs/configuration.md
docs/architecture.md docs/development.md`; spot-check internal links resolve.

**Commit Message Template:**

```text
docs: document 0.4.0 model picker, idle release, and think-stripping in prose

The gear popover, configurable idle resource release, and reasoning-model
<think> stripping shipped in 0.4.0 but lived only in CHANGELOG/ROADMAP. Add
prose to README and docs/configuration.md, complete the src/offscreen/ module
inventory in architecture.md/development.md, and correct the README's stale
automatic GPU-memory rebuild claim (the auto-rebuild guard was removed).
```

## Task 4.4 — Repair stale line anchors and the apiKey off-by-2 (LOW drift)

**Goal:** prose is accurate but ~8 numeric `offscreen.ts:NN` / `session.ts:NN`
anchors in `docs/architecture.md` and `docs/prompt-api.md` drifted, plus
`docs/configuration.md:90` says `prompt-api-polyfill.js:189` (actual 191). Also
correct the `prompt-api.md` claim that "there is no monitor/downloadprogress
wiring" — 0.4.0 added it (ADR-R10, `broadcastProgress`, the
`STREAM_PROGRESS` port).

**Files to Modify:**

- `docs/configuration.md` (the `apiKey` paragraph: `:189` → `:191`)
- `docs/architecture.md` (offscreen state anchors)
- `docs/prompt-api.md` (offscreen.ts/session.ts anchors + the
  monitor/downloadprogress claim)

**Prerequisites:** Phase 1/2 landed, since line numbers shift if those phases
edited the files (Phase 1 reworded the offscreen comment; Phase 2 may have edited
offscreen.ts/session.ts). RE-VERIFY every anchor against the CURRENT files at
edit time — do not trust the numbers below blindly; they were correct on
2026-05-27 pre-Phase-1.

**Implementation Steps:**

1. Re-derive each anchor from the current source (grep the literal, read the line
   number). The 2026-05-27 mapping (verify, then apply the CURRENT number):
   - `docs/configuration.md` apiKey: `prompt-api-polyfill.js:189` → `:191`
     (the `if (config && config.apiKey)` line is 191 in the vendored file).
   - `docs/architecture.md`: dynamic import `offscreen.ts:76-79` → the
     `import('@huggingface/transformers')` / polyfill import lines (~126-127);
     `window.TRANSFORMERS_CONFIG` `offscreen.ts:83` → the assignment (~132);
     `heavyPromise=null offscreen.ts:93` → the catch null (~142);
     `sessionPromise=null offscreen.ts:127` → the catch null (~200).
   - `docs/prompt-api.md`: dynamic import `offscreen.ts:76-79` → (~126-127);
     `offscreen.ts:83` TRANSFORMERS_CONFIG → (~132); SYSTEM_INSTRUCTION literal
     `offscreen.ts:59` → (~80); `buildInitialPrompts` `offscreen.ts:100` →
     (~149); `Loading model… 0s ... session.ts:682-690` → the warmHint/elapsed
     lines (~1269 and ~1282-1286).
1. For each, update the anchor to the current line; KEEP the quoted code/literal
   (it is accurate — only the number drifted).
1. **prompt-api.md monitor claim:** the doc states "There is no
   `monitor`/`downloadprogress` wiring and no percentage UI." This is now FALSE —
   `offscreen.ts` passes a `monitor` into `LanguageModel.create()` and
   `broadcastProgress` relays `downloadprogress` over the `STREAM_PROGRESS` port
   to the panel, which renders "Downloading model NN%" (ADR-R10, shipped 0.3.0).
   Reword that paragraph to describe the actual phased download-progress wiring
   (real percent → indeterminate "Loading into GPU…" → elapsed counter fallback),
   matching `docs/configuration.md`'s "Phased first-run download progress"
   description and `src/session.ts`'s `runWarm`. Verify against code before
   writing.
1. After editing, sweep both docs for any remaining `offscreen.ts:` /
   `session.ts:` anchor and confirm each points at the right current line.
1. markdownlint + lychee (no link targets change, but confirm).

**Verification Checklist:**

- [x] `docs/configuration.md` apiKey anchor is the current
      `prompt-api-polyfill.js` line for `if (config && config.apiKey)` (191 on
      2026-05-27).
- [x] Every `offscreen.ts:NN` / `session.ts:NN` anchor in architecture.md and
      prompt-api.md points at the correct CURRENT line (re-derived, not copied).
- [x] prompt-api.md no longer claims there is no monitor/downloadprogress wiring;
      it describes the phased progress that ships.
- [x] markdownlint passes; no broken links.

**Testing Instructions:** for each anchor, `grep -n "<literal>" <source file>`
and confirm the doc number matches. `npx markdownlint-cli2 docs/configuration.md
docs/architecture.md docs/prompt-api.md`.

**Commit Message Template:**

```text
docs: refresh drifted source anchors and the download-progress claim

Update the ~8 offscreen.ts/session.ts line anchors in architecture.md and
prompt-api.md (prose was accurate, line numbers drifted), fix the apiKey
polyfill anchor (189 -> 191), and correct prompt-api.md's stale "no
monitor/downloadprogress wiring" note (phased progress shipped in 0.3.0).
```

## Task 4.5 — Add the `alarms` permission to privacy and store docs (LOW gap)

**Goal:** the `alarms` permission (added 0.4.0, in `manifest.json` permissions
`["storage","offscreen","alarms"]`) is not explained in `PRIVACY.md` /
`docs/privacy.md` and is missing from `docs/chrome-web-store.md`'s permission
justifications.

**Files to Modify:**

- `docs/privacy.md` (the "Permissions, explained" table)
- `PRIVACY.md` (the "Permissions" list)
- `docs/chrome-web-store.md` (the "Permission justifications" list)

**Prerequisites:** none.

**Implementation Steps:**

1. Confirm `manifest.json` lists `"alarms"` in `permissions` (it does:
   `["storage", "offscreen", "alarms"]`).
1. **docs/privacy.md:** add an `alarms` row to the "Permissions, explained"
   table: it schedules the idle resource-release timer (measured from the last
   generation so it survives MV3 service-worker eviction) that closes the
   offscreen document to reclaim VRAM. No data leaves the device; the alarm only
   fires a local check.
1. **PRIVACY.md:** add an `alarms` bullet to the "Permissions" list with the same
   user-facing explanation (idle release timer; reclaims memory; nothing
   transmitted).
1. **docs/chrome-web-store.md:** add an `**`alarms`**` justification bullet to
   the "Permission justifications" list — phrase it for the store dashboard
   (schedules an inactivity timer to release the in-memory model and reclaim
   memory; eviction-safe via `chrome.alarms`; no network access).
1. Keep each consistent with the others (same rationale, audience-appropriate
   wording). markdownlint compliance (table rows aligned; list blank-line rules).

**Verification Checklist:**

- [x] `docs/privacy.md` permissions table includes an `alarms` row.
- [x] `PRIVACY.md` permissions list includes an `alarms` bullet.
- [x] `docs/chrome-web-store.md` permission justifications include `alarms`.
- [x] All three explanations are consistent (idle release / memory reclamation /
      eviction-safe / no network).
- [x] markdownlint passes on all three.

**Testing Instructions:** `grep -n "alarms" docs/privacy.md PRIVACY.md
docs/chrome-web-store.md` (each returns a match); `npx markdownlint-cli2` on the
three files.

**Commit Message Template:**

```text
docs(privacy): document the alarms permission added in 0.4.0

The alarms permission backs the idle resource-release timer but was missing
from PRIVACY.md, docs/privacy.md, and the chrome-web-store permission
justifications. Explain it consistently across all three (eviction-safe idle
release that reclaims VRAM; no data leaves the device).
```

## Task 4.6 — Clear version-stale labels and the Web-Store status contradiction (structure/minor)

**Goal:** `docs/transform.md` carries version-stale labels ("queued for v0.3.0",
"the project is now on 0.2.4", a "v0.3.0 follow-ups" list) while the project is on
0.4.0; the scope limits still hold (only the version labels are stale). README
says "This isn't on the Chrome Web Store" while ROADMAP (the pinned source of
truth) says v0.3.0 is on the Web Store.

**Files to Modify:**

- `docs/transform.md` (version labels only — NOT the scope content)
- `README.md` (the "Install (from source)" intro line, ~line 44)

**Prerequisites:** none (README "Highlights"/"Using it" edits from Task 4.3 are in
a different section; this touches the Install intro).

**Implementation Steps:**

1. **docs/transform.md:** update the version-stale labels without changing the
   scope facts (the scope limits still hold — `selection-rewrite.ts` still
   excludes `<input>`/`<textarea>`/`contenteditable`). Specifically:
   - "Out of scope (queued for v0.3.0)" → drop the version pin or update it; the
     items are still out of scope, so state that without an outdated version.
   - "the rewrite shipped in v0.2.3 (the project is now on 0.2.4)" → update the
     "now on" version to 0.4.0 (or remove the parenthetical "now on" clause,
     which is the kind of label that re-drifts every release).
   - "## v0.3.0 follow-ups" heading + list → relabel as general "Follow-ups" /
     "Possible future work" so it does not claim a shipped version's backlog;
     verify which items, if any, have since shipped (e.g. confirm
     input/contenteditable support is still NOT shipped — `selection-rewrite.ts`
     still excludes them, per transform.md's own scope section). Keep only
     genuinely-still-pending items.
   - Re-verify each version claim before editing (read `package.json` version =
     0.4.0; read `selection-rewrite.ts` to confirm the scope exclusions still
     hold).
1. **README.md install intro (~line 44):** "This isn't on the Chrome Web Store."
   ROADMAP.md (pinned source of truth, ADR-5) says v0.3.0 is on the Web Store.
   Resolve the contradiction by pinning ONE source of truth. Since live listing
   state is not verifiable from the repo and ROADMAP asserts it IS listed, change
   the README line to not contradict ROADMAP — e.g. frame the section as "To run
   the current source / latest build" (build-from-source instructions are valid
   regardless of listing state) rather than asserting it is NOT on the store. Do
   not assert a store URL the repo cannot confirm; the safe, non-contradictory
   wording is to present from-source install as one path without the false "isn't
   on the Web Store" claim.
1. markdownlint + lychee on both files.

**Verification Checklist:**

- [x] `docs/transform.md` has no "queued for v0.3.0" / "now on 0.2.4" stale
      labels; scope facts (input/contenteditable still out of scope) are
      unchanged and re-verified against `selection-rewrite.ts`.
- [x] `docs/transform.md` "v0.3.0 follow-ups" heading no longer pins a shipped
      version; remaining items are genuinely pending.
- [x] README's Install intro no longer contradicts ROADMAP's Web-Store status;
      it does not assert an unverifiable store URL.
- [x] `package.json` version (0.4.0) is consistent with any version reference
      touched.
- [x] markdownlint passes; no broken links.

**Testing Instructions:** `grep -n "v0.3.0\|0.2.4\|Chrome Web Store" docs/transform.md
README.md` and confirm no stale claim remains; `npx markdownlint-cli2` on both.

**Commit Message Template:**

```text
docs: clear version-stale labels and the Web Store status contradiction

transform.md still pinned v0.3.0/0.2.4 labels (the project is on 0.4.0; the
scope facts are unchanged) and README claimed the extension isn't on the Web
Store while ROADMAP says it is. Update the labels and reframe the install
intro so it no longer contradicts the pinned source of truth.
```

## Phase Verification

- [x] `npx markdownlint-cli2` passes on every edited markdown file.
- [x] lychee finds no broken links (no internal link targets removed).
- [x] `grep -n "QWEN3_08B\|Two live" CHANGELOG.md` empty;
      `grep -n "Qwen3.5-0.8B" docs/configuration.md` empty.
- [x] `grep -ri "picker\|gear" README.md docs/configuration.md
      docs/architecture.md` returns matches.
- [x] `grep -n "alarms" docs/privacy.md PRIVACY.md docs/chrome-web-store.md` each
      returns a match.
- [x] If Phase 2 added a test file, `docs/testing.md`'s test-file table is
      accurate (`npm test` keeps `tests/docs-config.test.ts` green).
- [x] `npm test` still green (the docs-config drift-guard and any docs-truth
      tests pass).
- [x] Atomic commits per task (4.1–4.6), conventional `docs(...)` format, no
      `Co-Authored-By`.
