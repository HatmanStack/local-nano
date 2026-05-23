# Phase 0: Foundation

This file is the law for Phase-1. Every implementation choice in Phase-1 must
be consistent with the decisions captured here. Estimated tokens: ~7,000.

## Project Conventions

Inherited from `CLAUDE.md`, the `MEMORY.md` index, and the v0.2.2 codebase.
Do not contradict any of these in Phase-1.

### Toolchain

- **Package manager:** npm. Not pnpm, not yarn. `package-lock.json` is
  authoritative.
- **Node:** version pinned in `.nvmrc` (currently 20). Use `nvm use` before
  running commands.
- **TypeScript:** strict mode is on (see `tsconfig.json`). All new code must
  type-check without `any` escape hatches except where existing code already
  uses them.
- **Linter / formatter:** Biome 2.4.15. Run `npm run lint` (autofix) during
  development and `npm run lint:ci` before commit. Biome rules of note: 2-
  space indent, single quotes, trailing commas, semicolons required,
  100-char line width. `vendor/` is excluded.
- **Test runner:** Vitest + jsdom. Coverage thresholds enforced at 75%
  lines/statements/functions and 80% branches. Coverage is measured on
  `src/**/*.ts` only.
- **Build:** `node build.mjs` (esbuild). Three entry points: `content.ts`
  (IIFE), `background.ts` (ESM module worker), `offscreen.ts` (IIFE). Any
  new module under `src/` is bundled into whichever entry imports it.

### Commands

| Task | Command |
| ---- | ------- |
| Install | `npm ci` |
| Type-check | `npm run typecheck` |
| Test | `npm test -- --run` |
| Test (watch) | `npm run test:watch` |
| Coverage | `npm run coverage` |
| Build | `npm run build` |
| Lint (autofix) | `npm run lint` |
| Lint (CI) | `npm run lint:ci` |

Phase-1 plans run these locally before commit; CI re-runs them on push.

### Git workflow

- Conventional commits. Allowed types: `feat`, `fix`, `refactor`, `test`,
  `docs`, `chore`. Scope is optional but encouraged (e.g. `feat(transform):
  …`).
- Atomic commits. One logical change per commit. Phase-1 explicitly enumerates
  commit boundaries.
- **No `Co-Authored-By` lines.** No `Generated-By` lines. No emojis in
  commit messages.
- **No `--amend`.** Always create a new commit. Pre-commit hook failures get a
  new commit, not an amendment.
- Work on a feature branch. Do not commit directly to `main`. Do not switch
  branches without explicit user instruction.
- Verify the branch with `git branch --show-current` before committing.
  Verify the worktree with `git worktree list` and `pwd` if uncertain.

### Writing style (code comments, docs, commit messages)

- No em dashes. Use commas, periods, semicolons, or parentheses.
- No filler ("It's worth noting", "In terms of", "At the end of the day").
- No fake enthusiasm. No emojis. No exclamation marks.
- Direct and factual. State facts, give instructions, move on.

## Non-negotiable Constraints (from the v0.2.0 post-mortem)

These are surfaced in `MEMORY.md` and the brainstorm. They are the failure
modes that killed v0.2. Any design choice that contradicts them is a planning
defect.

1. **Single `LanguageModel` session, always.** The offscreen document creates
   one session via `LanguageModel.create()` in `ensureSession()` at
   `offscreen.ts:97`. That session is the only one allowed in the codebase.
   Phase-1 must not call `LanguageModel.create()` from any new code path.
   Transforms route through the same `streamPrompt` used by chat.
2. **Cap output length per call.** v0.2.0's session-wide raise from 1024 to
   2048 widened the KV-cache peak and contributed to OOM. The polyfill's
   transformers backend bakes `max_new_tokens: 2048` into `generationConfig`
   at `createSession` time (`vendor/prompt-api-polyfill/backends/
   transformers.js:149`). We cannot lower it per-call through the public
   surface (see ADR-002). We mitigate via prompt-side hints plus a tracked
   soft cap that influences the prompt and gives observable abort behavior.
3. **Selection payload is bounded.** Selection text plus ~200 chars before
   and ~200 chars after. Total ~700 chars max. Anything bigger is truncated
   on the way to the model.
4. **No v0.2.0 module names return.** The following filenames were removed
   at v0.2.1 and must not reappear in Phase-1 even if the new code covers
   conceptually similar ground:
   - `src/transform.ts`
   - `src/transform-prompts.ts`
   - `src/dom-apply.ts`
   - `src/dom-actions.ts`
   - `src/ui/preview.ts`
   - `src/background/menus.ts`
   - `src/heavy.ts`

   Phase-1 introduces `src/selection-rewrite.ts` (not `src/transform.ts`) and
   keeps its DOM helpers private to that module. No separate `dom-apply` or
   `preview` files.

## Architectural Decisions

### ADR-001: Single offscreen session for chat and transforms

**Decision:** Transforms reuse the long-lived offscreen `LanguageModel`
session created in `offscreen.ts`. They are normal `promptStreaming` calls
issued through the existing content-script-facing `streamPrompt` in
`src/offscreen/client.ts`. Their prompts go into the polyfill's internal
`#history` and their results land in `chrome.storage.local` as ordinary
`user` / `model` entries.

**Rationale:** The v0.2.0 failure was driven by a second `LanguageModel`
instance sharing the WebGPU adapter with the chat session. Reusing the chat
session forecloses that mistake by construction. As a side benefit, the
device-loss recovery path from v0.2.2 (zero-chunk detection plus
`rebuildSession` re-seeding) covers transforms for free.

**Tradeoffs:** A transform turn pollutes the chat thread with one
user-instruction bubble and one model-output bubble. This is by design
(decision 4 in the brainstorm) and gives the user a chat-style history of
their edits. The user instruction "rewrite this in passive voice" is stored
alongside the rewritten text, which is acceptable for a single-user local
extension.

### ADR-002: Accept the polyfill's 2048-token output ceiling

**Decision:** Do not patch the polyfill. Accept that `max_new_tokens` is
2048 for every call to `session.promptStreaming` and use two compensating
mechanisms:

1. **Prompt-side hint.** The transform prompt explicitly tells the model
   "Respond with only the rewritten text, no commentary. Keep length close to
   the original." This is observed to work well on Gemma-3-style models for
   rewrite-style tasks.
2. **Soft cap as tracked metadata.** Compute
   `softCap = max(MIN_OUTPUT_TOKENS, inputTokenCount * MAX_OUTPUT_MULTIPLIER)`
   and pass it into the prompt as a numeric hint ("Aim for roughly N
   tokens") plus log it as a console diagnostic. We do not enforce the cap
   via abort today; the hint plus the bounded selection size keeps
   real-world outputs well under 2048. The unit in the prompt text matches
   the unit in the variable (`softCap` is in tokens), so the model gets
   one consistent number and the implementer has one consistent spec.

**Why not patch the polyfill (option b in the brainstorm):** The codebase
explicitly treats `vendor/prompt-api-polyfill/` as upstream code. The
v0.2.2 `offscreen.ts` header comments this rule out loud. A vendor patch
would re-open the maintenance question every time the polyfill is bumped,
and the soft-cap+hint approach is sufficient given the bounded input.

**Fallback behavior when `measureContextUsage` is slow:** The
`inputTokenCount` input to the formula above comes from the offscreen
`count` channel. If that round-trip exceeds 100ms, the client falls back
to a `Math.ceil(text.length / 3)` heuristic (see ADR-003 for the racing
and fallback semantics). The soft cap stays a soft cap either way; the
heuristic is good to within a small constant factor for English prose.

**Constants (named exports from `src/selection-rewrite.ts`):**

```text
MIN_OUTPUT_TOKENS = 256
MAX_OUTPUT_MULTIPLIER = 2
```

Both are top-of-module so adjustment is one-line and discoverable.

### ADR-003: Token counting via offscreen `count` channel with heuristic fallback

**Decision:** Add a `count` channel to the offscreen protocol that calls
the polyfill session's `measureContextUsage(text)` method (the public
surface; the underlying `countTokens` on the backend is private). The
content-script client exposes `countTokens(text): Promise<number>` and
races it against a 100ms timeout. On timeout (or any error), fall back to a
character heuristic: `Math.ceil(text.length / 3)`.

**Rationale:** Brainstorm Open Question 3 flagged that
`session.countTokens()` runs the chat template + tokenizer over the whole
conversation and might add real latency. A round-trip is the correct answer
when it's fast; a heuristic is the correct answer when it's slow. Racing
the two with a fixed budget gives correctness in the common case and
predictable UX in the slow case.

**Polyfill surface used:** `session.measureContextUsage(text)` returns a
`Promise<number>`. Defined at `vendor/prompt-api-polyfill/
prompt-api-polyfill.js:1059`. Internally calls the backend's `countTokens`.
This is the only public token-counting method on the polyfill session.

**Protocol shape:** Mirrors the existing `REBUILD_SESSION_*` channel
(request via `chrome.runtime.sendMessage`, single response). Not a port-
based stream because the result is one number.

### ADR-004: Selection rewrite is a plain DOM operation

**Decision:** Phase-1 supports only plain text-bearing elements (`<p>`,
`<div>`, `<li>`, `<span>`, headings, etc.). Selections inside `<input>`,
`<textarea>`, or `contenteditable` regions are explicitly out of scope and
fall back to chat mode silently (the placeholder does not flip).

**Rationale:** `<input>` / `<textarea>` use a different selection API
(`selectionStart` / `selectionEnd`) and need synthetic `input` events to
notify frameworks. `contenteditable` regions own their own undo stack and
have site-specific IME quirks (Gmail, Docs, Notion all behave differently).
v0.2.0 attempted all three and the per-site quirks compounded the memory
issues into a hard-to-debug release. v0.2.3 keeps the surface small.
v0.3.0 can re-add the other two once the plain-DOM path is rock solid.

**Detection rule:** A selection is "supported" when its
`commonAncestorContainer` (or, for a fully-text-node range, its parent) is
not inside any ancestor that satisfies any of:

- `tagName === 'INPUT'`
- `tagName === 'TEXTAREA'`
- `isContentEditable === true`

If any of those is true, treat the selection as absent for mode-flip
purposes. Phase-1 does this check in the selectionchange handler before
exposing the snapshot to the session.

### ADR-005: In-place streaming with single-level Undo

**Decision:** When the user sends a transform, the captured `Range` is
mutated as the model emits chunks. On the first chunk, the range's
contents are deleted and replaced with an empty text node. Each subsequent
chunk appends to that text node. The original text content plus the
serialized range coordinates (start/end container references + offsets) are
captured before deletion and attached to the model bubble as a JS-memory
slot. The bubble shows an "Undo" button that, on click, replaces the
current contents of the snapshot's container range with the original text.

**Why not preview-then-apply:** v0.2.0 did this and the UI cost was high
for what amounted to a confidence affordance. The Undo button is a
cheaper, post-hoc confidence affordance and matches how the chat panel
already works (the user sees streaming and reacts after).

**Undo limitations:** Single level (no stack). Lost on tab navigation or
content-script reload. If the page mutates the snapshot's container nodes
between rewrite and undo, the button greys out and logs a console warning
rather than throwing. These are acceptable for v0.2.3; v0.3.0 can revisit.

### ADR-006: Esc inside the input toggles Ask mode

**Decision:** With a selection active, the chat input's placeholder is
"Edit selection… (Esc to switch to Ask)". Pressing Esc inside the input
toggles to "Ask about selection… (Esc to switch back to Edit)". In Ask
mode, send wraps the user's text into a prompt that quotes the selection
verbatim but does not mutate the DOM. The selection stays alive (we do not
call `selection.removeAllRanges()` or reset the snapshot). After the turn
completes, mode resets to whichever default applies for the current
selection state.

**Why Esc not Tab or a button:** Esc is the cheapest gesture inside an
input field. It does not steal focus, does not consume a click, and does
not require a new visual control. The brainstorm picked it explicitly
(decision 8).

### ADR-007: Selection capture timing

**Decision:** Listen for `selectionchange` on `document` from `content.ts`.
On each event, compute the current selection's supported-range snapshot (or
null if absent/unsupported) and push it into the session via a new
`onSelectionChange` dependency. The session caches the most recent
snapshot in a closure-scoped variable and uses it at send time. We do
**not** rely on capturing at input-focus time, because clicking into the
input fires a `selectionchange` that clears the page selection before the
focus handler runs.

**Why selectionchange and not focus:** `selectionchange` fires before
focus shifts away from the page, so the snapshot is taken while the
selection still exists. By the time the input is focused, the page
selection is already gone. The brainstorm's open question about
"focus vs mousedown vs selectionchange" resolves to `selectionchange`
based on the public Chrome behavior documentation and the practical
constraint that the user's selection is gone the moment they click into
the chat input.

**Snapshot freshness:** Stored in session state, replaced on every
`selectionchange`. When the user clicks into the input, the
`selectionchange` that fires from the focus shift updates the snapshot to
`null`. We compensate by also debouncing: the snapshot is updated on
selectionchange only if `document.activeElement !== input`. That way the
input click does not clobber the snapshot.

## Testing Strategy

### Mocking the offscreen client

The session test (`tests/session.test.ts`) already mocks the entire
`src/offscreen/client.js` module via `vi.mock(...)` and exposes the resolved
`streamPrompt` calls via a `pending` queue. Phase-1 extends that mock to
include `countTokens` as a `vi.fn()` returning a deterministic number.

For new modules that touch the offscreen client directly, follow the same
`vi.mock('../src/offscreen/client.js', () => ({ ... }))` pattern. Do not
mock `chrome.runtime.connect` or the port machinery; that's the wrong
abstraction layer for transform tests.

### Mocking DOM ranges

`jsdom` provides `document.createRange()`. Selection rewrite tests
construct a fragment, attach it to `document.body`, build a `Range`, and
exercise the rewrite module against that range directly. Do not call
`window.getSelection()` in tests; it is unreliable under jsdom. Instead,
the test passes a pre-built `Range` directly to the module under test.

### Token-count fallback timing

To test the 100ms timeout behavior without real timers, use
`vi.useFakeTimers()` plus `vi.advanceTimersByTimeAsync(101)`. The
`countTokens` mock returns a `Promise` that never resolves; the timer
advance triggers the fallback path. Reset timers in `afterEach`.

### Protocol guard tests

New `COUNT_TOKENS_REQUEST` / `COUNT_TOKENS_RESPONSE` discriminators get
the same shape of tests `tests/offscreen-protocol.test.ts` already applies
to ensure / rebuild / stream constants. Each guard gets accept-cases,
reject-cases for null/missing fields/wrong types, and a stable-constant
assertion.

### What not to test

- Do not test against a real WebGPU device. CI has no GPU.
- Do not test against a real polyfill. The polyfill is in `vendor/`,
  excluded from coverage, and not exercised by the unit suite.
- Do not test undo across a real page navigation. The snapshot's "lost on
  navigation" property is documented behavior, not a test target.

## Conventional Commits

All Phase-1 commits use conventional commits. Suggested types and scopes:

```text
feat(transform): add selection-rewrite module
feat(transform): wire selection capture and mode flip into session
feat(offscreen): add count-tokens channel and countTokens client export
feat(ui): show selection preview chip and undo button on transform bubble
test(transform): cover prompt construction, token cap, in-place stream, undo
docs(transform): document the selection-rewrite UX and constraints
chore(release): bump version and update CHANGELOG for v0.2.3
```

Body bullets describe the why, not the what. Example:

```text
feat(transform): add selection-rewrite module

- Reuses the offscreen LanguageModel session; no second create() call.
- Computes a soft output cap from input token count to keep KV-cache peaks
  predictable on memory-constrained adapters.
- Streams chunks directly into the captured Range so the user sees the
  rewrite happen in place.
```

## Deployment Strategy

This is a Chrome MV3 extension. There is no server-side deployment.

- Build artifacts land in `dist/` via `npm run build`. The unpacked
  extension is loaded from there during development.
- Release is changelog-driven: pushing a new `## [X.Y.Z]` header to `main`
  triggers `.github/workflows/release.yml`, which tags and publishes a
  GitHub release with the extracted notes.
- Phase-1's final commit bumps `package.json` and `manifest.json` to
  `0.2.3` and appends the `## [0.2.3]` section to `CHANGELOG.md`. The
  release workflow handles the rest.
- Do not push tags manually. Do not run the release workflow locally.

## Phase 0 Verification

Phase-0 is documentation only. The implementer reads this file in full
before starting Phase-1 and may re-read it during Phase-1 to settle
ambiguity. No code changes happen in Phase-0; no tests run.

To verify the implementer has internalized the foundation, they should be
able to answer without re-checking:

- Why does Phase-1 not call `LanguageModel.create()`?
- What is the soft cap formula and where do its constants live?
- What happens to the soft cap if the polyfill's `measureContextUsage`
  takes 200ms?
- Why is `contenteditable` out of scope?
- What is the selection-capture event and why?
