# Phase 5: Evaluation Remediation [IMPLEMENTER]

## Phase Goal

Close the five evaluation remediation targets that require code: make Stop
actually halt ONNX generation (Defensiveness, vendored edit), bound page-context
extraction by slicing before normalizing (Performance), serialize the shared
offscreen session so concurrent streams cannot interleave (Performance), give
context-size a single source of truth via the polyfill's real `contextWindow`
(Pragmatism, vendored edit), and close the `isFirstTurn` cross-URL gap by
re-seeding on restore (Creativity). Two of these edit the vendored polyfill and
are flagged as careful, additive, degrade-safe changes per ADR-R4 and ADR-R3.

Success criteria: pressing Stop threads an abort into the backend generator;
`pageContext` slices a bounded raw window before the full-string regex; a second
concurrent stream on the offscreen port is rejected (or queued) with a clear
"busy" signal rather than interleaving; the polyfill `contextWindow` reflects a
model-real value; opening the panel on a new URL re-seeds the session with that
URL's restored history via the existing `rebuildSession` plumbing; all tests
pass and new behavior has coverage where it lives in `src/`.

Estimated tokens: ~30k.

## Prerequisites

- Phases 1-4 complete (shared stream runner exists; logging gated; offscreen
  listener consolidated).
- Re-read: `offscreen.ts` `onConnect` (`:269-353`), `src/pageContext.ts`,
  `src/session.ts` restore/clearConversation/recordSentTurn, the vendored
  `prompt-api-polyfill.js` streaming path (`:782` `promptStreaming`, `:942`
  `generateContentStream` call, `:103-105` `contextWindow`), and
  `vendor/.../backends/transformers.js` `generateContentStream` (`:197-272`).
- ADR-R3 (context size) and ADR-R4 (abort threading) in Phase-0.

## Tasks

### Task 5.1: Slice page context before normalizing (Performance, LOW)

**Goal:** `pageContext` (`src/pageContext.ts:8`) runs `.replace(/\s+/g,' ')`
over the entire `document.body.innerText` before slicing to 1500. On a large
page that normalizes megabytes to discard all but 1500 chars. Slice a generous
raw window first, then normalize, then slice to the final limit (`eval`
Performance).

**Files to Modify/Create:**

- `src/pageContext.ts`
- `tests/pageContext.test.ts`

**Implementation Steps:**

1. Introduce a raw cap, e.g. `const RAW_SCAN_LIMIT = limit * 8;` (generous
   enough that whitespace collapse cannot shrink a 1500-char window below the
   limit while bounding work regardless of page size). Compute
   `const raw = doc.body.innerText.slice(0, RAW_SCAN_LIMIT);` then
   `const body = raw.replace(/\s+/g, ' ').slice(0, limit);`.
1. Preserve the exact output format string (`Page: ${title}\nURL: ${href}\n\n
   ${body}`) and the default `limit = PAGE_CONTEXT_BODY_LIMIT`.
1. The result for any realistic page is identical to before (the first
   `RAW_SCAN_LIMIT` chars contain far more than 1500 post-collapse chars); only
   the work done on huge pages changes.

**Verification Checklist:**

- Output for a small page is byte-identical to the pre-change output.
- A synthetic huge `innerText` (e.g. 2 MB) produces the same final body as
  slicing the first `RAW_SCAN_LIMIT` chars would, and does not normalize the
  whole string.
- `npm run typecheck` exits 0.

**Testing Instructions:** Extend `tests/pageContext.test.ts`: existing
truncation/whitespace/format tests must still pass; add a large-input case
asserting the body length is capped at `limit` and the format is intact. (You
cannot directly assert "didn't normalize the whole string" in a unit test;
asserting correctness of the bounded output is sufficient.)

**Commit Message Template:**

```text
perf(pageContext): slice a bounded raw window before normalizing

pageContext collapsed whitespace over the entire body innerText before
slicing to 1500. Slice a generous raw window first, then normalize, then
cap. Output is unchanged for real pages; work is bounded on huge ones.
```

### Task 5.2: Serialize the shared offscreen session (Performance, MEDIUM)

**Goal:** `offscreen.ts onConnect` (`:269`) accepts any number of ports, each
calling `session.promptStreaming` concurrently against the single shared session
whose polyfill mutates a shared `#history`. Two tabs streaming at once interleave
on one ONNX generator and corrupt history (`eval` Performance / CRITICAL FAILURE
POINTS). Add an offscreen-side busy gate so a second concurrent `stream/request`
is cleanly rejected with a "busy" `StreamDone { ok:false }` rather than starting
a second generation.

**Design constraint (ADR-R2):** Preserve the single-shared-session design; do
not spawn a second session or extract a helper module that re-introduces the
reverted `heavy.ts` shape. The gate is local state in `offscreen.ts`.

**Files to Modify/Create:**

- `offscreen.ts`
- a small pure helper + test under `src/offscreen/` for the gate logic
  (ADR-R5), e.g. `src/offscreen/busy-gate.ts` + `tests/offscreen-busy-gate.test.ts`.

**Implementation Steps:**

1. Decide policy: reject-when-busy (simpler, matches the eval's "rejects with a
   clear busy error or queues"). Choose reject for v1; a queue is more code and
   YAGNI for a single-user extension where concurrent two-tab streaming is an
   edge case. Document the choice in a comment.
1. Add a module-scope boolean `generationInFlight` in `offscreen.ts`. In the
   `onConnect` `stream/request` handler: if `generationInFlight` is already
   true, immediately post `StreamDone { type: STREAM_DONE, id, ok: false, error:
   'busy: another generation is in progress' }` and return without starting a
   read loop. Otherwise set `generationInFlight = true` and clear it in the
   existing `finally` (alongside `activeAborts.delete(id)`).
1. Extract the decision into `src/offscreen/busy-gate.ts` as a tiny testable
   unit if it helps, e.g. a class with `tryAcquire(): boolean` and `release():
   void`; otherwise keep the boolean inline and rely on the manual smoke test.
   Prefer the extracted gate so there is a unit test (ADR-R5).
1. Ensure the client surfaces the busy error usefully: `streamOverPort` already
   rejects with `new Error(message.error)` on `ok:false`, and the session send
   paths render the error in the bubble. Confirm the busy message reads
   acceptably in a bubble; adjust wording if needed (keep it short).
1. Do not change the abort/disconnect handling; busy is orthogonal.

**Verification Checklist:**

- A single stream works exactly as before.
- While one stream is in flight, a second `stream/request` (different `id`,
  same or different port) gets a `StreamDone ok:false` with the busy error and
  does not start a second `promptStreaming`.
- The gate is released on success, on error, and on abort/disconnect (check the
  `finally` and the `onDisconnect` path both clear it).
- `npm run typecheck`, `npm run lint:ci`, `npm run build` pass.

**Testing Instructions:** Unit-test the extracted `busy-gate` (`tryAcquire`
returns true once then false until `release`). The `offscreen.ts` wiring is
outside coverage (ADR-R5); cover it via the gate unit test and a manual
two-tab smoke note. If `tests/offscreen-client.test.ts` can be extended to
assert the client surfaces an `ok:false` busy `StreamDone` as a rejected
`streamPrompt`, add that.

**Commit Message Template:**

```text
fix(offscreen): reject concurrent streams on the shared session

The single shared polyfill session mutates one #history; two ports
streaming at once interleaved on one generator and corrupted history. A
busy gate rejects a second concurrent stream/request with a clear error
instead of starting a second generation.
```

### Task 5.3: Thread AbortSignal into backend generation (Defensiveness, MEDIUM, VENDORED)

**Goal:** Make Stop halt ONNX decoding, not just the consumer loop. Today
`prompt-api-polyfill.js` checks `aborted` in the `for await` loop and calls
`stream.return()` (`:952-958`), but
`TransformersBackend.generateContentStream(contents)`
(`vendor/.../backends/transformers.js:197-272`) launches `generator(prompt,
{...})` (`:227-231`) with no signal, so generation runs to `max_new_tokens` in
the background. Thread the caller's `AbortSignal` from
`promptStreaming(input, options)` through to the transformers.js `generator`
call (`eval` Defensiveness; CRITICAL FAILURE POINT).

**CRITICAL — vendored-file caution (ADR-R4):** This edits two vendored files.
The change must be additive and degrade-safe: if the running
`@huggingface/transformers` version ignores or rejects the signal/criteria
option, generation must behave exactly as today (run to completion), never
throw a new error. Keep edits minimal and comment each as a local delta so the
Phase-7 resync-procedure update can list them.

**Files to Modify/Create:**

- `vendor/prompt-api-polyfill/prompt-api-polyfill.js`
- `vendor/prompt-api-polyfill/backends/transformers.js`

**Implementation Steps:**

1. In `prompt-api-polyfill.js`, the `promptStreaming` ReadableStream `start`
   already has `const signal = options.signal;` (`:820`). The call to
   `_this.#backend.generateContentStream(requestContents)` (`:942`) passes no
   signal. Pass it through: `_this.#backend.generateContentStream(requestContents,
   signal)`. This is one argument addition.
1. In `backends/transformers.js`, change `generateContentStream(contents)` to
   `generateContentStream(contents, signal)`. Thread `signal` into the
   `generator(prompt, {...})` options (`:227`). `@huggingface/transformers`
   supports cancellation via a `stopping_criteria` callback and/or by passing
   the model's generation a signal. Use the lowest-risk supported mechanism:
   add a `stopping_criteria` function (or the version's `signal` option if the
   installed v4 supports it) that returns true once `signal?.aborted` is set,
   so the decode loop stops at the next step. Wrap the option in a guard so when
   `signal` is undefined the call is byte-identical to today.
1. Verify against the installed `@huggingface/transformers` (`^4.2.0`) API:
   inspect `node_modules/@huggingface/transformers` for the supported
   stopping-criteria / abort surface before committing to the exact option name.
   If v4 does not expose a usable stopping hook, fall back to the consumer-loop
   `stream.return()` already present and document that the backend cannot be
   interrupted on this version (do not invent an unsupported option). Record the
   finding in the commit body either way.
1. Keep the existing `generationPromise.catch` and `isDone` handling intact; an
   aborted generation should resolve/settle the async generator cleanly (the
   consumer loop's `aborted` check at `:953` still returns and calls
   `stream.return()`).
1. The offscreen side already owns the `AbortController` (`offscreen.ts:285`)
   and passes `{ signal: controller.signal }` into `promptStreaming`
   (`offscreen.ts:298`). No offscreen change is needed beyond confirming the
   signal reaches the polyfill (it does).

**Verification Checklist:**

- `promptStreaming` passes `signal` to `generateContentStream`.
- `generateContentStream` threads a guard into the `generator` call that stops
  decoding when the signal aborts, and is a no-op (identical to today) when no
  signal is given.
- With no signal, the generated prompt/options object is unchanged.
- `npm run build` succeeds (Biome does not lint `vendor/`, but the bundle must
  still build). `npm run typecheck` passes (the `.d.ts` shim for the polyfill is
  unchanged; no TS signature change is required since the offscreen
  `LanguageModelSession` interface already declares `promptStreaming(input,
  options?: { signal?: AbortSignal })`).

**Testing Instructions:** The real generator never runs under Vitest, so assert
the app-side contract: the offscreen handler passes `controller.signal` into
`promptStreaming` (already true). For the vendored change, the proof is the
manual smoke test: load unpacked, start a long generation on a real WebGPU
session, press Stop, and confirm the GPU returns to idle within a step or two
(observe via console timing or system GPU monitor) rather than continuing to
2048 tokens. Document this smoke step; it cannot be unit-tested.

**Commit Message Template:**

```text
fix(polyfill): thread AbortSignal into backend generation

Stop previously broke only the consumer loop; the transformers generator
ran to max_new_tokens in the background, the OOM the thresholds guard
against. promptStreaming now passes its signal into
generateContentStream, which stops decoding at the next step. No-op when
no signal is given. Degrades to prior behavior if the installed
transformers version lacks a stop hook.
```

### Task 5.4: Single source of truth for context size (Pragmatism, MEDIUM, VENDORED)

**Goal:** The polyfill's `contextWindow` getter returns a hardcoded `1000000`
(`prompt-api-polyfill.js:103-105`), far above the model's real ~128K window, so
its overflow guard (`:712`/`:913`) never protects at the real boundary. Per
ADR-R3, set `contextWindow` to a model-real value so the built-in overflow event
becomes meaningful, and keep the app's advisory char-heuristic as the practical
guard.

**CRITICAL — corrected finding:** The real window is ~128K, NOT 8-32k, and the
guard is NOT dead code (it fires above 1,000,000). Do not "fix" anything based
on the original (struck) claims. Do not change the model name.

**Files to Modify/Create:**

- `vendor/prompt-api-polyfill/prompt-api-polyfill.js`

**Implementation Steps:**

1. Change the `get contextWindow()` return from `1000000` to a model-real value.
   Use `131072` (128K) as the constant, with a comment noting it reflects the
   `gemma-4-E2B-it-ONNX` context window per its Hugging Face model card and that
   the upstream literal was `1000000`. Mark it as a local vendored delta for the
   resync procedure.
1. Do NOT change `measureContextUsage` (it measures only the passed input, not
   accumulated history — see ADR-R3 for why driving the app warning from it was
   rejected). Do NOT change the app's `estimateHistoryTokens` heuristic; it
   stays the practical guard.
1. Confirm the overflow guards at `:712`/`:913`/`:1054` now compare against
   `131072` and will dispatch `contextoverflow` / throw `QuotaExceededError` at
   the real boundary instead of 1M. This is a safety improvement, not a behavior
   change for normal sessions (which stay well under 128K).

**Verification Checklist:**

- `get contextWindow()` returns `131072` with an explanatory comment.
- No other polyfill code path that assumed `1000000` breaks (search for
  `1000000` literals used as `contextWindow` and confirm they read the getter,
  not a separate literal — the `error.quota = ...` lines already read
  `_this.contextWindow`, so they update automatically).
- `npm run build` succeeds; `npm run typecheck` passes.

**Testing Instructions:** Not unit-testable (the polyfill is not loaded in
tests). The change is a value correction; verify by reading the surrounding
guard code that all overflow comparisons read the getter. Manual smoke test:
normal sessions behave identically (they never approach 128K).

**Commit Message Template:**

```text
fix(polyfill): set contextWindow to the model-real 128K value

The getter returned a hardcoded 1,000,000 so the overflow guard only
fired far above the model's real ~128K window. Setting it to 131072 makes
the built-in overflow event meaningful at the real boundary. The app's
char-heuristic warning stays the practical early guard.
```

### Task 5.5: Close the isFirstTurn cross-URL gap via re-seed (Creativity, MEDIUM)

**Goal:** `isFirstTurn` (`session.ts:220-226`) is only applied once per
content-script lifetime, but the single offscreen session is shared across
tabs/URLs. After `restore()` re-renders a new URL's prior history, the offscreen
session has no knowledge of it, so page context for a new URL is never seeded.
Wire `restore()` to re-seed the model with the restored history via the existing
`rebuildSession(history)` plumbing (`offscreen.ts:129-138`, client
`rebuildSession`), and reset `isFirstTurn` appropriately (`eval` Creativity /
Concerns).

**Design constraint (ADR-R2):** Use the already-existing `rebuildSession`
plumbing; do not invent a new offscreen channel. Respect the memory-budget
constraints: re-seeding rebuilds the single session (no second session), and the
seed history is bounded by `MAX_HISTORY` already.

**Files to Modify/Create:**

- `src/session.ts`
- `tests/session.test.ts`

**Implementation Steps:**

1. In `restore()`, after loading and rendering history, if the restored history
   is non-empty, call the client `rebuildSession(history)` with the restored
   turns mapped to `HistoryTurn[]` (`role: 'user' | 'model'`, dropping any
   `system` entries — `HistoryTurn` only accepts user/model, and the offscreen
   `buildInitialPrompts` maps `model → assistant`). This re-seeds the single
   offscreen session with this URL's conversation so a follow-up has context.
1. Because the session is now seeded with this URL's history, set `isFirstTurn`
   so the next send still prefixes page context for a fresh-but-restored URL
   appropriately. Decide the precise semantics: the page-context prefix should
   be sent once for the current URL. Simplest correct behavior: after a re-seed
   on restore, leave `isFirstTurn = true` so the first new turn includes the
   page-context prefix for the current URL (the restored history gives
   conversational continuity; the prefix gives current-page grounding). Document
   this in the existing `NOTE(isFirstTurn)` comment, updating it to reflect that
   restore now re-seeds.
1. Handle failure gracefully: `rebuildSession` can reject (offscreen not ready,
   load failure). Wrap in try/catch; on failure, fall back to current behavior
   (rendered history only, no seed) and `console.warn` via the gated logger. Do
   not block panel open on the re-seed; it can run after rendering. Consider
   running it as a non-awaited best-effort after `renderMessage` so the UI is
   responsive, but ensure a later send does not race a half-built session — if
   sequencing is a concern, await the re-seed before enabling send, mirroring
   how `ensureWarm` gates state. Keep it simple: await the re-seed inside
   `restore()` but guard with try/catch so a failure degrades silently.
1. Update `clearConversation` interaction: it already calls `rebuildSession([])`
   and resets `isFirstTurn = true`; ensure the new restore-seed path does not
   double-seed (restore runs once at init; clear runs on user action). No
   conflict expected, but verify the `warnedAboutHistory` / `cumulativeSentChars`
   resets remain correct after a restore-seed (the restored turns were sent in a
   prior lifetime, so `cumulativeSentChars` legitimately starts at 0 for the new
   lifetime — leave it).

**Verification Checklist:**

- On panel open for a URL with stored history, `rebuildSession` is called once
  with the restored user/model turns (system entries dropped), via the existing
  client function.
- A re-seed failure degrades to render-only and logs via the gated logger; it
  does not throw out of `restore()`.
- The `NOTE(isFirstTurn)` comment is updated to describe the new behavior.
- `npm run typecheck`, `npm run lint:ci` pass; existing `session.test.ts`
  restore/Clear/concurrency tests pass (adjust only assertions that asserted the
  old no-seed behavior).

**Testing Instructions:** In `tests/session.test.ts`, seed
`chromeMock.storage.local.store[key]` with a few user/model entries, mock the
client `rebuildSession` (it goes through `chrome.runtime.sendMessage`), init the
session, toggle the panel open, and assert a `REBUILD_SESSION_REQUEST` was sent
with the mapped history (system entries excluded). Add a case where the rebuild
request resolves `ok:false` and assert `restore()` still renders and does not
throw.

**Commit Message Template:**

```text
feat(session): re-seed the offscreen session on restore for cross-URL context

The shared offscreen session knew nothing about a restored URL's history,
so asking about a new page after chatting on another lost grounding.
restore() now re-seeds via the existing rebuildSession plumbing (user/model
turns only); failures degrade to render-only.
```

### Task 5.6: Offscreen test coverage for extracted seams

**Goal:** The offscreen entry holds the most operationally risky code with 0%
coverage (`health` finding 6). Per ADR-R5, raise confidence by ensuring the
seams extracted in this plan (`classifyOffscreenMessage` from Phase-3,
`busy-gate` from Task 5.2) and the client/protocol layer have tests, rather than
adding `offscreen.ts` to the coverage set.

**Files to Modify/Create:**

- `tests/offscreen-dispatch.test.ts` (Phase-3, confirm exists and is thorough).
- `tests/offscreen-busy-gate.test.ts` (Task 5.2, confirm exists).
- Optionally extend `tests/offscreen-client.test.ts` for the busy `ok:false`
  path and the `gpu-info` conservative-shape path.

**Implementation Steps:**

1. Audit the new seams' tests for completeness (each request kind, the busy
   acquire/release cycle, the client's handling of `ok:false`).
1. Do NOT lower coverage thresholds and do NOT add `offscreen.ts` to
   `vitest.config.ts` `include`. The seams are in `src/offscreen/` which is
   already in the coverage set, so their tests count toward the gate naturally.

**Verification Checklist:**

- `src/offscreen/dispatch.ts` and `src/offscreen/busy-gate.ts` have direct unit
  tests covering all branches.
- `npm run coverage` stays at or above 75/80 with the new `src/offscreen` code
  fully exercised.

**Testing Instructions:** `npm run coverage`; confirm the new `src/offscreen`
modules report high coverage and no threshold regression.

**Commit Message Template:**

```text
test(offscreen): cover extracted dispatch and busy-gate seams

The offscreen entry stays outside the coverage set, but the logic
extracted from it (message classify, busy gate) now lives in
src/offscreen and is unit-tested across all branches.
```

## Phase Verification

- Stop threads an abort into the backend (or documents the version limitation);
  pageContext is bounded; concurrent streams are rejected; `contextWindow` is
  128K; restore re-seeds the session.
- `npm run typecheck`, `npm run lint:ci`, `npm run coverage`, `npm run build`
  all pass.
- Manual smoke test confirms: Stop returns the GPU to idle quickly; a two-tab
  concurrent send shows the busy message; chatting about page B after page A
  grounds in B.

Integration points: Phase-7 docs describe the abort threading and contextWindow
deltas in the resync procedure and the preflight/loading-counter behavior.

Known limitations: the busy gate rejects rather than queues (v1 choice); the
abort fix is bounded by the installed transformers.js stop-hook support; the
context-size fix corrects the boundary but the app heuristic remains the
practical early-warning.
