# Phase 2 — [IMPLEMENTER] Quick-Win Fixes: Strict Mode, Reader Lock, Persist Error Handling, History Cap

## Phase Goal

Harden the codebase against the five most impactful silent-failure and type-safety
gaps that can each be fixed in isolation — without the larger `content.ts`
decomposition that comes in Phase-3. These fixes collectively lift Defensiveness,
Type Rigor, and Performance pillars.

**Success criteria:**

- `tsconfig.json` has `"strict": true`; all type errors it surfaces are resolved
- `src/history.ts` has no `as unknown as Promise<void>` double-cast
- `content.ts:send()` releases the stream reader in a `finally` block
- `content.ts:persist()` attaches a `.catch()` handler on storage write errors
- `src/history.ts:saveHistory` has a `MAX_HISTORY` eviction guard that trims
  the array before writing
- `docs/contributing.md` no longer blesses `any` usage
- All existing tests pass; `npm run typecheck` passes with `strict: true`

**Token estimate:** ~14k tokens

## Prerequisites

- Phase-1 complete and committed (cleanup done, no pending hygiene noise)
- Working `npm install` environment

## Task 2.1 — Enable `strict: true` and Remove `any` Blessing

**Goal:** Enable TypeScript strict mode (H5). Strict mode enables
`strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`,
`noImplicitAny`, and several others. Fix all resulting type errors. Remove the
`any`-blessing sentence from `docs/contributing.md`.

**Files:**

- `tsconfig.json`
- `content.ts`
- `src/history.ts`
- `docs/contributing.md`

**Prerequisites:** Phase-1 complete

**Implementation Steps:**

1. Open `tsconfig.json`. Change `"strict": false` to `"strict": true`.

1. Run `npm run typecheck` to see all errors introduced by strict mode:

   ```bash
   npm run typecheck 2>&1 | head -60
   ```

1. Fix errors one at a time. The expected set, based on the current codebase:

   **`content.ts` — `loadHeavy` return type annotation contains `any`:**

   The type `Promise<{ LanguageModel: any }>` is not rejected by strict mode
   per se, but `(tfMod.env as any)` casts will still typecheck. The real strict
   errors will be in the `ensureSession` body. Fix the `mon: any` and `e: any`
   catch parameter annotations:
   - `monitor(mon: any)` — change to `monitor(mon: EventTarget)`. The `mon`
     object only needs `addEventListener`; `EventTarget` is the minimal type.
   - `catch (e: any)` in `ensureSession` — change to `catch (e: unknown)` and
     update the body: replace `e?.message || String(e)` with
     `e instanceof Error ? e.message : String(e)`.
   - `catch (err: any)` in `send()` — change to `catch (err: unknown)` and
     update the body: replace `err?.name === 'AbortError'` with
     `err instanceof Error && err.name === 'AbortError'`.

   **`content.ts` — `let s: any = null` session variable:**

   At this point `s` is still `any`. Leave the type as `any` for now — the
   `LanguageModelSession` interface and proper typing of `s` are addressed in
   Phase-3 as part of the session extraction. The compiler will not error on
   `any` under strict mode for this specific case. If it does raise an error,
   add `// eslint-disable-next-line @typescript-eslint/no-explicit-any` (Phase-5
   will configure ESLint) or keep `let s: any = null` as-is.

   **`src/history.ts` — `as unknown as Promise<void>` double-cast (see Task 2.2):**

   The double-cast in `src/history.ts:15` may or may not produce a strict error.
   Task 2.2 removes it regardless.

   **`(tfMod.env as any)` casts in `content.ts:25–26`:**

   These silence compiler errors about accessing internal Transformers.js env
   properties. Keep these `as any` casts; they are at the polyfill boundary
   where no public typings exist. Under `noImplicitAny`, existing explicit
   casts are still allowed.

   **`window as any` in `content.ts:27`:**

   Keep this cast. `window.TRANSFORMERS_CONFIG` is a dynamic global; the cast
   is intentional.

   **`polyfillMod as any` in `content.ts:29`:**

   Keep this cast. The polyfill has no TypeScript declarations.

1. Once all strict errors are resolved, run `npm run typecheck` again and
   confirm it exits with code 0.

1. Open `docs/contributing.md`. Find the sentence on line 20:
   `"Strict mode is off — feel free to lean on \`any\` where the prompt-api polyfill or Transformers.js types aren't pulling their weight."`
   Replace it with:
   `"Strict mode is on. Use \`any\` only at explicit polyfill or Transformers.js boundaries where no types exist — document why with a comment. Do not propagate \`any\` into application logic."`

**Verification Checklist:**

- [x] `tsconfig.json` has `"strict": true`
- [x] `npm run typecheck` exits 0
- [x] `catch (e: unknown)` in `ensureSession`
- [x] `catch (err: unknown)` in `send()`
- [x] `monitor(mon: EventTarget)` in `ensureSession`
- [x] `docs/contributing.md` no longer contains "feel free to lean on `any`"
- [x] All 27 tests pass

**Testing Instructions:**

```bash
npm run typecheck
npm test
```

**Commit Message Template:**

```text
feat(config): enable TypeScript strict mode

- strict: true enables strictNullChecks, noImplicitAny, strictFunctionTypes
- Fixed catch parameters: any -> unknown with instanceof guards
- Fixed monitor callback parameter: any -> EventTarget
- Updated contributing.md: removed the any blessing, replaced with boundary guidance
- Explicit as-any casts at polyfill boundary are preserved and intentional
```

---

## Task 2.2 — Remove Double-Cast in `src/history.ts`

**Goal:** Remove the `as unknown as Promise<void>` double-cast from
`src/history.ts:saveHistory`. `chrome.storage.local.set` already returns
`Promise<void>` per the `@types/chrome` declarations; the cast was defensive
boilerplate that is now unnecessary noise (health-audit quick win #1).

**Files:**

- `src/history.ts`

**Prerequisites:** Task 2.1 complete (strict mode enabled)

**Implementation Steps:**

1. Open `src/history.ts`.
1. Change line 14–15 from:

   ```ts
   export function saveHistory(key: string, history: Entry[]): Promise<void> {
     return chrome.storage.local.set({ [key]: history }) as unknown as Promise<void>;
   }
   ```

   To:

   ```ts
   export function saveHistory(key: string, history: Entry[]): Promise<void> {
     return chrome.storage.local.set({ [key]: history });
   }
   ```

1. Run `npm run typecheck` to confirm the return type is still satisfied.

**Verification Checklist:**

- [x] `src/history.ts` has no `as unknown` cast
- [x] `npm run typecheck` passes
- [x] All history tests pass

**Testing Instructions:**

```bash
npm run typecheck
npm test
```

**Commit Message Template:**

```text
refactor(history): remove redundant double-cast in saveHistory

- chrome.storage.local.set is typed as Promise<void> in @types/chrome
- The as unknown as Promise<void> cast was unnecessary defensive boilerplate
```

---

## Task 2.3 — Release Stream Reader Lock in `finally` Block

**Goal:** Ensure `reader.releaseLock()` is always called after the stream loop
in `send()`, regardless of whether the read completed, was aborted, or errored
(finding H6 from health-audit). This prevents the stream reader from holding a
lock on the underlying `ReadableStream` after an abort or error.

**Files:**

- `content.ts`

**Prerequisites:** Task 2.1 complete (strict mode; catch type changes done)

**Implementation Steps:**

1. Open `content.ts`. Find the `send()` function's inner try block (lines
   ~239–278 after Phase-1 log removal).

1. The current structure is:

   ```ts
   const stream = s.promptStreaming(prompt, { signal: activeAbort.signal });
   const reader = stream.getReader();
   let firstChunk = true;
   while (true) {
     const { done, value } = await reader.read();
     if (done) { ...; break; }
     ...
   }
   ```

   The `reader` is declared inside the outer try block. Move the reader
   acquisition and the read loop into a nested try/finally so the lock
   is always released:

   ```ts
   const stream = s.promptStreaming(prompt, { signal: activeAbort.signal });
   const reader = stream.getReader();
   let firstChunk = true;
   try {
     while (true) {
       const { done, value } = await reader.read();
       if (done) {
         console.log(`[local-nano] stream done in ${(performance.now() - t0).toFixed(0)}ms`);
         break;
       }
       if (firstChunk) {
         console.log(`[local-nano] first token at ${(performance.now() - t0).toFixed(0)}ms`);
         responseEl.textContent = '';
         firstChunk = false;
       }
       modelText += value;
       responseEl.textContent = modelText;
       messages.scrollTop = messages.scrollHeight;
     }
   } finally {
     reader.releaseLock();
   }
   ```

   The outer `catch (err: unknown)` block remains unchanged — it still catches
   both the AbortError and any other error thrown by `reader.read()` after the
   `finally` releases the lock. The `finally` runs before the outer catch's
   re-throw path, which is correct behavior.

1. Run `npm run typecheck` to confirm no new errors.

**Verification Checklist:**

- [x] `content.ts:send()` calls `reader.releaseLock()` in a `finally` block
  nested inside the outer try
- [x] The outer `catch` (err: unknown) block is unchanged
- [x] The outer `finally` (setIdleState, activeAbort = null, i.focus()) is
  unchanged
- [x] `npm run typecheck` passes
- [x] `npm test` passes

**Testing Instructions:**

```bash
npm run typecheck
npm test
```

**Commit Message Template:**

```text
fix(content): release stream reader lock in finally block

- reader.releaseLock() was never called on abort or error paths
- An unreleased lock could prevent session reuse on the next send
- Wrapped read loop in nested try/finally; outer catch and finally unchanged
```

---

## Task 2.4 — Add Error Handling to `persist()`

**Goal:** Attach a `.catch()` handler to `saveHistoryToStorage` inside
`persist()` so that storage quota errors and other `chrome.storage.local.set`
rejections are logged rather than silently swallowed (findings M5, H2 partial).

**Files:**

- `content.ts`

**Prerequisites:** None (independent of Tasks 2.1–2.3)

**Implementation Steps:**

1. Open `content.ts`. Find the `persist()` function at lines ~143–145:

   ```ts
   function persist() {
     saveHistoryToStorage(STORAGE_KEY, history);
   }
   ```

1. Replace it with:

   ```ts
   function persist() {
     saveHistoryToStorage(STORAGE_KEY, history).catch((err: unknown) => {
       console.error('[local-nano] history write failed:', err);
     });
   }
   ```

   Note: `saveHistoryToStorage` returns `Promise<void>`. After Task 2.2, there
   is no cast — the return type is plain `Promise<void>`.

**Verification Checklist:**

- [ ] `persist()` calls `.catch()` on the return value of `saveHistoryToStorage`
- [ ] The catch logs with `console.error` and includes the error object
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

**Testing Instructions:**

```bash
npm run typecheck
npm test
```

**Commit Message Template:**

```text
fix(content): log storage write failures in persist()

- saveHistoryToStorage was called without awaiting or catching
- On chrome.storage.local quota exhaustion the rejection was silently swallowed
- Added .catch() to surface errors via console.error
```

---

## Task 2.5 — Add History Eviction Cap to `saveHistory`

**Goal:** Prevent unbounded `chrome.storage.local` growth by trimming
`history` to the most recent `MAX_HISTORY` entries before writing
(finding M4 from health-audit). The cap belongs in `src/history.ts` so it is
testable and independent of the `content.ts` entry point.

**Files:**

- `src/history.ts`
- `tests/history.test.ts`

**Prerequisites:** Task 2.2 complete (double-cast removed)

**Implementation Steps:**

1. Open `src/history.ts`. Add a named constant before the `saveHistory` function:

   ```ts
   export const MAX_HISTORY = 200;
   ```

   200 entries is a reasonable cap — at ~100 chars average per entry that is
   ~20 KB, well within the 10 MB `chrome.storage.local` quota.

1. Update `saveHistory` to trim before writing:

   ```ts
   export function saveHistory(key: string, history: Entry[]): Promise<void> {
     const trimmed = history.length > MAX_HISTORY
       ? history.slice(-MAX_HISTORY)
       : history;
     return chrome.storage.local.set({ [key]: trimmed });
   }
   ```

   The trimming slices from the end, keeping the most recent entries.

1. Open `tests/history.test.ts`. Add a new `describe` block for `saveHistory`
   edge cases after the existing `saveHistory` describe:

   ```ts
   describe('saveHistory — MAX_HISTORY eviction', () => {
     it('stores at most MAX_HISTORY entries', async () => {
       const entries: Entry[] = Array.from({ length: MAX_HISTORY + 10 }, (_, k) => ({
         role: 'user' as Role,
         text: `msg ${k}`,
       }));
       await saveHistory('k', entries);
       const stored = chromeMock.storage.local.store['k'] as Entry[];
       expect(stored.length).toBe(MAX_HISTORY);
     });

     it('keeps the most recent entries when trimming', async () => {
       const entries: Entry[] = Array.from({ length: MAX_HISTORY + 5 }, (_, k) => ({
         role: 'user' as Role,
         text: `msg ${k}`,
       }));
       await saveHistory('k', entries);
       const stored = chromeMock.storage.local.store['k'] as Entry[];
       expect(stored[0].text).toBe(`msg 5`);
       expect(stored[stored.length - 1].text).toBe(`msg ${MAX_HISTORY + 4}`);
     });

     it('does not trim when under the cap', async () => {
       const entries: Entry[] = [{ role: 'user', text: 'hi' }];
       await saveHistory('k', entries);
       const stored = chromeMock.storage.local.store['k'] as Entry[];
       expect(stored.length).toBe(1);
     });
   });
   ```

   Also add `MAX_HISTORY` to the import line at the top of `tests/history.test.ts`:

   ```ts
   import {
     loadHistory,
     saveHistory,
     storageKey,
     MAX_HISTORY,
     type Entry,
     type Role,
   } from '../src/history.js';
   ```

   Note: `Role` is already re-exported as a type from `src/history.ts`. Import
   it here for the test factory function.

**Verification Checklist:**

- [ ] `src/history.ts` exports `MAX_HISTORY = 200`
- [ ] `saveHistory` trims to `MAX_HISTORY` entries before writing
- [ ] Three new tests in `tests/history.test.ts` cover: over-cap trim, correct
  tail kept, under-cap passthrough
- [ ] `npm run typecheck` passes
- [ ] `npm run coverage` passes and all thresholds are met
- [ ] All tests pass (30 total after the 3 new ones)

**Testing Instructions:**

```bash
npm run typecheck
npm run coverage
```

**Commit Message Template:**

```text
feat(history): add MAX_HISTORY eviction cap to saveHistory

- Unbounded history growth would eventually exhaust chrome.storage.local quota
  (10 MB total) causing silent save failures
- saveHistory now trims to the 200 most-recent entries before writing
- Exported MAX_HISTORY constant for testability
- Added 3 tests covering over-cap trim, tail preservation, and under-cap passthrough
```

---

## Phase Verification

After all five tasks are committed:

```bash
npm run typecheck
npm run coverage
npm run build
```

All three must exit 0. Confirm:

- `tsconfig.json` has `"strict": true`
- `src/history.ts`: no double-cast, exports `MAX_HISTORY`, trims in `saveHistory`
- `content.ts`: `catch (err: unknown)`, `reader.releaseLock()` in finally,
  `persist()` has `.catch()`
- `docs/contributing.md`: no "feel free to lean on `any`" sentence
- Test count is 30 (27 original + 3 new history eviction tests)
- Coverage thresholds met
