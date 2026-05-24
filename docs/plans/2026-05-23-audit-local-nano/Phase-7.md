# Phase 7: Documentation [DOC-ENGINEER]

## Phase Goal

Bring every public doc into line with the post-remediation code: the offscreen
refactor (model host moved out of the content script in 0.2.2), the real
heavy-load and config-injection locations, the elapsed-counter loading UI (not a
percentage), the actual system-instruction seeding, the trimmed manifest
permissions, the correct bundle-size file, the corrected load-from-root path and
version lag in transform.md, the open manifest-name vs branding inconsistency,
the icon source, the models.md `q4 → q4f16` dtype, and the undocumented preflight
advisory. Also update the resync procedure and any code-reference doc lines for
the surfaces deleted in Phase-1 and the vendored deltas added in Phase-5.

This phase makes NO code change. Respect every corrected finding: do not touch
the model name anywhere; the web-store zip is local clutter (already deleted);
`apiKey` is read by the polyfill (clarify, do not call it "nothing reads it").

Success criteria: each finding below is resolved in the named doc; markdownlint
and lychee pass; the `docs/testing.md` table lists every current test file (so
the Phase-6 guard passes); cross-references resolve.

Estimated tokens: ~26k.

## Prerequisites

- Phases 1-6 complete. The docs must describe the final code state:
  `src/system.ts` gone (Task 1.1), `dot_env.json` gone (Task 1.3), the
  contextWindow and abort vendored deltas present (Phase-5), the busy gate and
  restore re-seed present (Phase-5).
- Re-read each target doc section before editing it; the line numbers below are
  from the audit and may have shifted.

## Tasks

### Task 7.1: Rewrite architecture.md for the offscreen design

**Goal:** `docs/architecture.md` predates the 0.2.2 offscreen refactor. It says
the content script "owns the chat UI and runs the model" and the data-flow art
shows `content.ts` lazy-loading heavy modules and building the session. The
model actually loads in `offscreen.ts` (`loadHeavy`/`ensureSession`); the
content script streams to it over a port via `src/offscreen/client.ts`. The
session-lifecycle variable table (`:90-97`) and ADR-004 reference closure vars
(`session`, `creating`, `heavyLoadPromise`) that no longer exist. (doc DRIFT-1,
DRIFT-2, DRIFT-3, STALE-2; `health` finding 3 docs; `eval` Onboarding.)

**Files to Modify/Create:**

- `docs/architecture.md`

**Implementation Steps:**

1. Update the "three moving pieces" list: background SW (hotkey), content script
   (owns the chat UI; does NOT run the model), the offscreen document (hosts the
   single long-lived `LanguageModel` session), and the vendored polyfill. The
   offscreen document is the actual model host and must be named.
1. Redraw/rewrite the data-flow diagram so the heavy load and session live in
   the offscreen document, with the content script streaming over a
   `chrome.runtime.Port` via `src/offscreen/client.ts`, and the SW ensuring the
   offscreen document exists (`src/background/offscreen.ts`). Keep it as a
   fenced ```text block.
1. Fix the "Content script" section: it does NOT call `loadHeavy()`. Move that
   description to the offscreen document. `content.ts` imports only
   `src/selection-rewrite.js`, `src/session.js`, `src/ui/state.js`.
1. Fix `TRANSFORMERS_CONFIG` wiring: `offscreen.ts:20` does `import
   transformersConfig from './.env.json'` and `offscreen.ts:71` sets
   `window.TRANSFORMERS_CONFIG`. The content script never touches the config.
   Update the "Prompt API polyfill" subsection accordingly.
1. Replace the stale "Session Lifecycle (post-extraction)" variable table: the
   model session lives in `offscreen.ts` (`sessionPromise`, `heavyPromise`), not
   in `initSession`'s closure. Rewrite the table to the real offscreen state and
   the real `session.ts` closure state (`history`, `activeAbort`, `isFirstTurn`,
   `warmStarted`, `modelReady`, `historyThreshold`, `cumulativeSentChars`,
   `warnedAboutHistory`). Remove `session`, `creating`, `heavyLoadPromise`.
1. Update the "Known Lifecycle Limitations" / `isFirstTurn` section to reflect
   the Phase-5 change: `restore()` now re-seeds the offscreen session with the
   restored URL's history via `rebuildSession`, so cross-URL continuity is
   handled; the page-context prefix is still sent once per URL. Do not claim a
   gap that no longer exists.
1. Update ADR-004: it references `heavyLoadPromise` reset-on-failure in
   `session.ts`. The equivalent live behavior is `offscreen.ts`'s `heavyPromise`
   / `sessionPromise` being nulled on failure (`offscreen.ts:81,115`). Reframe
   ADR-004 around the offscreen promises, or note the variable moved.
1. Fix the "What lives where" table row `System instruction | src/system.ts` —
   `src/system.ts` was deleted (Phase-1). The live system instruction is the
   literal in `offscreen.ts`. Update the row to point at `offscreen.ts` (the
   seeded literal) or remove the row.

**Verification Checklist:**

- No sentence claims the content script runs/loads the model.
- The offscreen document appears in the prose, the diagram, and the lifecycle
  table.
- No reference to `session`, `creating`, `heavyLoadPromise`, or `src/system.ts`
  remains.
- markdownlint passes on the file (fenced blocks tagged, headings clean).

**Testing Instructions:** `npx markdownlint-cli2 docs/architecture.md`; eyeball
the diagram renders sensibly. Confirm cross-links still resolve (lychee in CI).

**Commit Message Template:**

```text
docs(architecture): rewrite for the offscreen-document model host

The doc predated the 0.2.2 offscreen refactor: it claimed the content
script ran the model and listed closure vars that no longer exist. Reflect
the offscreen session host, the real config-injection point, the restore
re-seed, and drop the deleted src/system.ts reference.
```

### Task 7.2: Fix prompt-api.md drift and the resync procedure

**Goal:** `docs/prompt-api.md` attributes the heavy load and config injection to
`content.ts` (they are in `offscreen.ts`), claims `initialPrompts` seeds from
`src/system.ts` (deleted; the seed is the offscreen literal), describes a
`monitor`/`downloadprogress` "Loading NN%" UI that does not exist, and says
`content.ts` imports the module-exported `LanguageModel` directly (the offscreen
doc does). Also add the Phase-5 vendored deltas to the resync procedure. (doc
DRIFT-2, DRIFT-3, DRIFT-5, DRIFT-6; `health` findings.)

**Files to Modify/Create:**

- `docs/prompt-api.md`

**Implementation Steps:**

1. "How it's wired in": change the `content.ts` lazy-import snippet attribution
   to `offscreen.ts` (the `Promise.all([import('@huggingface/transformers'),
   import('./vendor/.../prompt-api-polyfill.js')])` lives at `offscreen.ts:64-67`).
   Config flows via `offscreen.ts` setting `window.TRANSFORMERS_CONFIG` from
   `.env.json`, not `content.ts`.
1. Fix the `initialPrompts` bullet: the session is seeded with the hardcoded
   literal in `offscreen.ts` (`'You are a helpful assistant. Answer concisely
   and directly.'`), NOT `SYSTEM_INSTRUCTION` from `src/system.ts` (deleted).
   Remove the `src/system.ts` link.
1. Fix the `monitor(target)` / `downloadprogress` / "Loading model… NN%" bullet:
   there is no percentage UI and no `monitor`/`downloadprogress` wiring in the
   app. The warmup hint is a live elapsed-seconds counter (`session.ts:632-639`),
   `'Loading model… 0s'` ticking up. Rewrite the bullet to describe the elapsed
   counter (and that after ~45s it appends remedies). Note the polyfill backend
   still emits download progress internally, but the app does not consume it.
1. "When native lands": the claim that `content.ts` imports the module-exported
   `LanguageModel` directly is true behavior but happens in the offscreen
   document, not content.ts. Update the location.
1. Resync procedure: add the Phase-5 vendored deltas so a future upstream pull
   re-applies them:
   - `prompt-api-polyfill.js`: `get contextWindow()` returns `131072` (was
     `1000000` upstream); and `promptStreaming` passes `options.signal` into
     `generateContentStream`.
   - `backends/transformers.js`: `generateContentStream(contents, signal)`
     threads the signal into the `generator(...)` stop hook.
   Keep the existing deltas (trimmed registry, removed iframe block,
   `max_new_tokens: 2048`).
1. The `apiKey` is not discussed here; leave it to configuration.md (Task 7.5).

**Verification Checklist:**

- No `content.ts`-attributed heavy-load or config-injection claim remains.
- No `src/system.ts` reference; the seed is described as the offscreen literal.
- The loading-UI description is the elapsed counter, not a percentage.
- The resync procedure lists the contextWindow and abort-signal deltas.
- markdownlint passes.

**Testing Instructions:** `npx markdownlint-cli2 docs/prompt-api.md`; lychee in
CI checks the (now-removed) `src/system.ts` link is gone and remaining links
resolve.

**Commit Message Template:**

```text
docs(prompt-api): correct wiring, seeding, loading UI, and resync deltas

Heavy load and config injection are in offscreen.ts, not content.ts; the
session is seeded from the offscreen literal, not the deleted system.ts;
the loading UI is an elapsed counter, not Loading NN%. Resync procedure now
lists the contextWindow and abort-signal vendored deltas.
```

### Task 7.3: Fix the loading-UI claim in models.md and development.md

**Goal:** `docs/models.md:29` and `docs/development.md:45` both describe
"`Loading model… NN%` during weight download." That percentage UI was removed;
the app shows an elapsed counter (doc DRIFT-4, shared with Task 7.2).

**Files to Modify/Create:**

- `docs/models.md`
- `docs/development.md`

**Implementation Steps:**

1. In `models.md`, the WASM section line about a three-dot animation and
   `Loading model… NN%`: keep the three-dot/generating note, change the
   weight-download description to the elapsed-seconds counter.
1. In `development.md` "Debugging" → "Model download progress": rewrite to
   describe the elapsed counter (`Loading model… Ns`) rather than a percentage;
   keep the host-permission troubleshooting note.

**Verification Checklist:**

- No "`Loading model… NN%`" string remains in either doc.
- markdownlint passes.

**Testing Instructions:** `grep -rn "NN%" docs/` returns nothing;
markdownlint clean.

**Commit Message Template:**

```text
docs: replace the removed Loading NN% UI with the elapsed counter

models.md and development.md still described a percentage download
readout. The app shows a ticking elapsed-seconds counter.
```

### Task 7.4: Fix the bundle-size file in development.md

**Goal:** `docs/development.md:70` says `dist/content.js` is ~1.5 MB because it
inlines Transformers.js. Since the 0.2.2 offscreen move, `dist/content.js` is
~41 KB; the ~1.5 MB bundle is `dist/offscreen.js` (doc DRIFT-8). Also update the
project-layout map (`:49-66`) which omits `offscreen.ts` and still lists
`src/system.ts`.

**Files to Modify/Create:**

- `docs/development.md`

**Implementation Steps:**

1. "A word on the bundle size": the heavy runtime now lands in
   `dist/offscreen.js` (~1.5 MB), not `dist/content.js` (~41 KB, the thin
   per-page script). Rewrite accordingly; keep the "model weights fetched at
   runtime, not bundled" note.
1. Project layout map: add `offscreen.ts` (offscreen document entry) and
   `offscreen.html`; add `src/offscreen/` (client, protocol, stream-client, and
   the new dispatch/busy-gate); add `src/selection-rewrite.ts` and
   `src/session.ts`; remove `src/system.ts` (deleted). Keep it representative,
   not exhaustive.

**Verification Checklist:**

- The bundle-size paragraph names `dist/offscreen.js` as the heavy bundle and
  `dist/content.js` as thin.
- The layout map includes `offscreen.ts` and omits `src/system.ts`.
- markdownlint passes.

**Testing Instructions:** Optionally `npm run build` then `ls -la dist/` to
confirm the sizes cited are in the right ballpark; markdownlint clean.

**Commit Message Template:**

```text
docs(development): correct the heavy-bundle file and layout map

dist/content.js is thin (~41 KB) since the model moved offscreen; the
~1.5 MB bundle is dist/offscreen.js. Update the bundle note and the
project-layout map (add offscreen.ts, drop deleted system.ts).
```

### Task 7.5: Fix privacy.md permissions and configuration.md apiKey/dot_env

**Goal:** `docs/privacy.md:24-33` lists removed permissions (`activeTab`,
`scripting`, `cdn.jsdelivr.net`) and omits `offscreen`; the manifest permissions
are only `["storage", "offscreen"]` with three huggingface host permissions (doc
DRIFT-7). In `docs/configuration.md`, clarify `apiKey` is read by the polyfill
(not "nothing reads it") and remove the `dot_env.json` reference (deleted in
Phase-1) (doc CONFIG-DRIFT-2, and the dot_env mention at `:76`).

**Files to Modify/Create:**

- `docs/privacy.md`
- `docs/configuration.md`

**Implementation Steps:**

1. privacy.md permissions table: remove the `activeTab` and `scripting` rows and
   the `cdn.jsdelivr.net` host-permission row; add a `offscreen` row ("Hosts the
   long-lived LLM session in an offscreen document"). Keep `storage` and the two
   huggingface host rows (`huggingface.co` / `*.huggingface.co`, and
   `cdn-lfs.huggingface.co`). Update the `<all_urls>` paragraph if it referenced
   removed perms.
1. privacy.md `:8` "cdn.jsdelivr.net, in fallback paths only" bullet: the
   manifest no longer grants `cdn.jsdelivr.net`. Remove that outbound-traffic
   bullet (or note the ORT files are bundled and no jsdelivr permission is
   declared). Keep the model-weights and host-page bullets.
1. privacy.md "What stays on your machine": add the offscreen document to the
   local-processing description (prompts go to the in-page client which streams
   to the offscreen session; nothing leaves the device).
1. configuration.md `apiKey` section (`:53-55`): it currently says "Unused by
   the Transformers.js backend" and explains it is kept for upstream cloud
   backends. Sharpen: the field IS read by the vendored polyfill
   (`prompt-api-polyfill.js:181`, `if (config && config.apiKey)`) but the
   Transformers.js backend ignores it, so `"dummy"` is a deliberate placeholder
   the polyfill reads and the backend never uses. Do NOT call it "nothing reads
   it." Do NOT remove the field from `.env.example.json`.
1. configuration.md "Other knobs" (`:76`): it points readers at
   `vendor/prompt-api-polyfill/dot_env.json` as a reference template. That file
   was deleted (Phase-1). Remove the reference; if a reference template is still
   wanted, describe the `env` block inline or point at the polyfill's
   `backends/defaults.js`. Keep the "not read at runtime; live config comes from
   `.env.json`" framing for the `env` block itself.

**Verification Checklist:**

- privacy.md permissions table matches `manifest.json` exactly (`storage`,
  `offscreen`, the three huggingface hosts; no `activeTab`/`scripting`/jsdelivr).
- configuration.md describes `apiKey` as polyfill-read / backend-ignored
  placeholder; no claim that nothing reads it; field stays in the example.
- No `dot_env.json` reference remains in configuration.md.
- markdownlint and lychee pass.

**Testing Instructions:** Cross-check the table against `manifest.json`;
`grep -rn "dot_env" docs/` returns nothing; `grep -rn "activeTab\|scripting"
docs/privacy.md` returns nothing; markdownlint clean.

**Commit Message Template:**

```text
docs: align privacy permissions and clarify apiKey/dot_env

privacy.md listed removed permissions (activeTab, scripting, jsdelivr) and
omitted offscreen. configuration.md called apiKey unread and pointed at the
deleted vendored dot_env.json. Match the trimmed manifest, clarify apiKey is
read by the polyfill but ignored by the backend, and drop the dot_env ref.
```

### Task 7.6: Fix transform.md load path, version lag, and naming

**Goal:** `docs/transform.md:91` says "Load the unpacked extension from
`dist/`" which is wrong (manifest.json is at repo root; loading `dist/` fails)
and contradicts README/development. The doc is framed around v0.2.3 while the
feature shipped at 0.2.4. (doc STRUCTURE-2, STRUCTURE-3.)

**Files to Modify/Create:**

- `docs/transform.md`

**Implementation Steps:**

1. Verification step 1 (`:91`): change "Load the unpacked extension from
   `dist/`" to load from the repository root (match README "pick this
   repository's root directory" and development.md "load `local-nano/`").
1. Version framing: the "Out of scope for v0.2.3" / "v0.2.3 is the rewrite"
   lines (`:45,57,87`) predate 0.2.4. Update to the current version (0.2.4) and
   reframe "shipped in" rather than "v0.2.3". Do not invent a changelog; align
   with `manifest.json`/`package.json` version `0.2.4` and the CHANGELOG.
1. If the doc still references `finalize()` or any Phase-1/Phase-5 changed
   behavior, reconcile (the rewrite path no longer calls `finalize()`; the
   single-shared-session and 2048 cap statements remain accurate).

**Verification Checklist:**

- No instruction to load from `dist/`; the load path is the repo root.
- No stale "v0.2.3 out of scope" framing for a feature now shipped at 0.2.4.
- markdownlint passes.

**Testing Instructions:** `grep -rn "from .dist/.\|dist/\`" docs/transform.md`
returns no load-from-dist instruction; cross-check version against
`package.json`.

**Commit Message Template:**

```text
docs(transform): fix load-from-root path and 0.2.4 version framing

transform.md told users to load the unpacked extension from dist/, but
manifest.json lives at repo root. Fix the load path to match README and
update the v0.2.3 framing to the shipped 0.2.4.
```

### Task 7.7: Resolve the manifest name vs branding and icon source in chrome-web-store.md

**Goal:** `manifest.json:3` name is `"Local AI Cmd"` while all branding (README,
repo, `content.ts:45` title `'Local AI'`, hero art "LOCAL NANO") differs.
`docs/chrome-web-store.md:7,49` flag the open "Local AI Cmd vs Local Nano"
decision; `:46` says icons are "generated from `icons/icon.svg` via `npm run
icons`" but `make-icons.mjs` uses ffmpeg from `icon-source.png` and there is no
`icons/icon.svg` (doc STRUCTURE-3 naming; doc "Minor extra DRIFT" icon source).

**Files to Modify/Create:**

- `docs/chrome-web-store.md`
- (Decision only; do NOT change `manifest.json` name in this doc phase — see
  step 1.)

**Implementation Steps:**

1. The manifest name vs branding is a real, still-open product decision, not a
   doc bug to silently "fix." Do NOT change `manifest.json` (that is a product
   choice for the owner). In chrome-web-store.md, keep the decision flagged but
   make it accurate: state the current manifest name (`Local AI Cmd`), the
   branding (local-nano / "Local AI" panel title), and that the name decision is
   open. Ensure the doc does not assert a resolution that has not happened.
1. Icon source (`:46`): correct the asset-checklist line. Icons are generated
   from `icons/icon-source.png` via ffmpeg in `scripts/make-icons.mjs` (run with
   `npm run icons`); there is no `icons/icon.svg`. Update the line to name
   `icon-source.png` and ffmpeg.
1. The build-and-upload `~19 MB` zip note and `npm run package` path are
   accurate; leave them.

**Verification Checklist:**

- The icon-source line names `icons/icon-source.png` + ffmpeg, not a
  nonexistent `icons/icon.svg`.
- The name-decision text is accurate and still flags it as open; no false claim
  that it is resolved.
- markdownlint passes.

**Testing Instructions:** Confirm `icons/icon-source.png` exists
(`ls icons/`) and `icons/icon.svg` does not; markdownlint clean.

**Commit Message Template:**

```text
docs(chrome-web-store): fix icon source and keep the name decision honest

Icons come from icons/icon-source.png via ffmpeg (make-icons.mjs), not a
nonexistent icon.svg. Keep the Local AI Cmd vs Local Nano name decision
flagged as open and accurate against the current manifest.
```

### Task 7.8: Fix models.md TL;DR dtype q4 → q4f16

**Goal:** `docs/models.md:11-13` TL;DR recommends `dtype: "q4"` for the two
WebGPU rows, but the project moved off `q4` (it hits a SIGILL) to `q4f16` (the
live default in `.env.json` and `docs/configuration.md:48`). The detailed row at
`:101` lists `webgpu + q4 … Current default`, contradicting the real `q4f16`
default. (doc STALE-EXAMPLE-1.)

**CRITICAL:** Only the dtype is stale. The model NAME on these rows is correct
(`gemma-4-E2B-it-ONNX` and `Qwen3.5-0.8B-ONNX`) — do NOT change it.

**Files to Modify/Create:**

- `docs/models.md`

**Implementation Steps:**

1. TL;DR table rows 1 and 2 (`:11,12`): change `dtype: "q4"` to `dtype:
   "q4f16"`. Leave the model names and the WASM row (`q8`) unchanged.
1. "Models we tried" table: the `gemma-4-E2B-it-ONNX | webgpu + q4 | … Current
   default` row (`:101`) is contradicted by the real `q4f16` default. Reconcile:
   either change that row's setup to `webgpu + q4f16` and keep "Current default,"
   or keep the historical `q4` observation row but remove the "Current default"
   label and add/clarify a `q4f16` row as the default. Prefer: relabel so
   `q4f16` is the documented current default and the `q4` SIGILL caveat from
   configuration.md is consistent. Keep the model name.
1. Cross-check against `docs/configuration.md:48` (the `q4` SIGILL warning) and
   the CHANGELOG 0.2.4 note so the three agree.

**Verification Checklist:**

- The TL;DR WebGPU rows recommend `q4f16`, not `q4`.
- No row labels `q4` as the current default; the current default is `q4f16`.
- Model names are unchanged.
- markdownlint passes.

**Testing Instructions:** `grep -n "q4\b" docs/models.md` to confirm remaining
`q4` mentions are historical/caveat context, not the recommended default;
markdownlint clean.

**Commit Message Template:**

```text
docs(models): correct TL;DR dtype to q4f16 (q4 SIGILLs)

The TL;DR recommended q4 for WebGPU and labeled a q4 row "current default,"
but the project moved to q4f16 after the q4 ONNX kernel SIGILL. Update the
dtype; model names are unchanged.
```

### Task 7.9: Document the preflight device-capability advisory

**Goal:** The user-visible preflight advisory (`src/session.ts:90-100`,
`preflightWarning` — "Heads up: no hardware WebGPU adapter…") is undocumented in
any user doc; only CHANGELOG 0.2.4 mentions the warmup indicator (doc GAP-1).

**Files to Modify/Create:**

- `docs/configuration.md` (or `docs/models.md`, whichever fits the user's
  troubleshooting flow — choose `configuration.md` near the `device`/`dtype`
  guidance, since the advisory tells users to switch to `wasm`).

**Implementation Steps:**

1. Add a short subsection (a few sentences) describing the preflight advisory:
   when the panel opens, the extension queries the WebGPU adapter before the
   heavy load; if no hardware adapter is found (software fallback) or the
   adapter's max buffer is too small, it shows a one-time "Heads up…" system
   message advising `"device": "wasm"` in `.env.json`. Note it is advisory only
   (the load is still attempted). Tie it to the existing `device`/`dtype` docs.
1. Do not over-document; one short subsection. This is a minor gap.

**Verification Checklist:**

- A user doc describes the preflight advisory and the `wasm` remedy.
- markdownlint passes.

**Testing Instructions:** markdownlint clean; the wording matches the actual
`preflightWarning` strings in `src/session.ts`.

**Commit Message Template:**

```text
docs(configuration): document the preflight device-capability advisory

The "Heads up: no hardware WebGPU adapter" preflight message was
user-visible but undocumented. Add a short subsection near device/dtype
guidance describing it and the wasm remedy.
```

### Task 7.10: Update the docs/testing.md test-file table

**Goal:** `docs/testing.md:16-24` lists 7 test files; the suite has more
(`selection-rewrite.test.ts`, `offscreen-client.test.ts`,
`offscreen-protocol.test.ts`, `stream-client.test.ts`,
`background-offscreen.test.ts`, plus the new `offscreen-dispatch.test.ts` and
`offscreen-busy-gate.test.ts` from Phases 3/5), and `system.test.ts` was deleted
(Phase-1). Update the table to list every current `tests/*.test.ts` so the
Phase-6 guard (Task 6.3) passes (`eval` Onboarding / Maintenance Drag, doc
freshness). This task MUST be landed with or immediately after Task 6.3.

**Files to Modify/Create:**

- `docs/testing.md`

**Implementation Steps:**

1. Enumerate the final test files on disk (`ls tests/*.test.ts`) AFTER all code
   phases: it includes at least `history`, `pageContext`, `ui-messages`,
   `ui-state`, `background-handler`, `background-offscreen`, `session`,
   `selection-rewrite`, `offscreen-client`, `offscreen-protocol`,
   `stream-client`, `docs-config`, `offscreen-dispatch`, `offscreen-busy-gate`,
   and EXCLUDES the deleted `system`. Confirm the exact list at implementation
   time.
1. Rewrite the table to list every one with a short "Covers" description. Use
   the `tests/<name>.test.ts` path form (the Phase-6 guard matches that form).
1. Remove the `tests/system.test.ts` row (deleted). Add a row for each
   currently-missing file.
1. Run the Phase-6 guard locally (`npx vitest run tests/docs-config.test.ts`)
   and confirm it passes after this edit.

**Verification Checklist:**

- Every `tests/*.test.ts` on disk appears in the table; no nonexistent file is
  listed (no `system.test.ts` row).
- `npx vitest run tests/docs-config.test.ts` passes (the Phase-6 guard is
  green).
- markdownlint passes (table formatting valid).

**Testing Instructions:** `npx vitest run tests/docs-config.test.ts` green;
`ls tests/*.test.ts` matched against the table by eye.

**Commit Message Template:**

```text
docs(testing): list every test file in the table

The testing-doc table listed 7 of the test files and included the deleted
system.test.ts. List every current tests/*.test.ts so the docs-config
freshness guard passes.
```

## Phase Verification

- Every documentation finding above is resolved in the named file.
- markdownlint (`docs/**/*.md`, README, CHANGELOG, excluding `docs/plans/**`)
  passes; lychee link-check passes; no broken or stale code references remain.
- The Phase-6 docs-table guard passes (Task 7.10 + Task 6.3 agree).
- The model name is unchanged everywhere; `apiKey` is described as polyfill-read;
  no doc references the deleted `src/system.ts` or `dot_env.json`.

Integration points: this phase depends on all code phases being final so the
docs describe the shipped state. Task 7.10 is paired with Phase-6 Task 6.3.

Known limitations: the architecture diagram is ASCII; it conveys the offscreen
topology but is not a rendered graphic. The manifest name decision is left open
by design (a product choice, not a doc fix).
