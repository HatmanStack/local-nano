# Phase 1 — [HYGIENIST] Cleanup: Noise, Lint, IDE Artifacts, Dependency Declaration

## Phase Goal

Remove debug noise shipped to production, add missing `.gitignore` entries,
declare the `onnxruntime-web` build-time dependency explicitly, and replace the
`innerHTML` pattern in the typing indicator with DOM-safe construction.

These are all strictly subtractive or non-breaking additions with zero risk to
runtime behavior. They must land before structural changes so subsequent commits
are not polluted with cleanup diffs.

**Success criteria:**

- `content.ts` no longer emits per-chunk `console.log` for streamed tokens
- `.gitignore` covers `.vscode/`, `.idea/`, `.DS_Store`, `Thumbs.db`
- `onnxruntime-web` is listed in `package.json` devDependencies
- `src/ui/messages.ts:makeTypingIndicator` uses `createElement` instead of `innerHTML`
- `npm run typecheck`, `npm run coverage`, and `npm run build` all pass
- All 27 existing tests still pass

**Token estimate:** ~8k tokens

## Prerequisites

- Phase-0 read and understood (conventions, commit format)
- Working `npm install` environment
- No other phases in progress

## Task 1.1 — Remove Per-Chunk Streaming Logs

**Goal:** Delete the `console.log` that fires on every streamed token (finding M1
from health-audit). Keep the two informational logs: the "heavy modules loaded"
confirmation and the stream-done timing summary. Also keep the `console.error`
on session creation failure.

**Files:**

- `content.ts`

**Prerequisites:** None

**Implementation Steps:**

1. Open `content.ts`.
1. Locate `content.ts:257` — the line that reads:
   `console.log(\`[local-nano] chunk ${chunkCount}:\`, JSON.stringify(value));`
   Delete this line entirely.
1. Also delete the `chunkCount` increment on the line just above it
   (`chunkCount++;`) because `chunkCount` is no longer used outside the
   stream-done log.
1. On the stream-done log at line 248:
   `console.log(\`[local-nano] stream done after ${chunkCount} chunks...`
   — update to remove the chunk count from the message since the variable is now
   gone. Change to:
   `console.log(\`[local-nano] stream done in ${(performance.now() - t0).toFixed(0)}ms\`);`
1. Delete the `let chunkCount = 0;` variable declaration at line 244.
1. Keep the `firstChunk` tracking and the "first token at" log — those are
   useful timing diagnostics, not noisy per-token spam.

**Verification Checklist:**

- [x] `content.ts` no longer contains `JSON.stringify(value)` in the stream loop
- [x] `content.ts` no longer declares `chunkCount`
- [x] `console.log('[local-nano] heavy modules loaded` line is still present
- [x] `console.log('[local-nano] first token at` line is still present
- [x] `console.log('[local-nano] stream done` line is still present (updated message)
- [x] `npm run typecheck` passes

**Testing Instructions:**

```bash
npm run typecheck
npm test
```

No new test needed — the change is a pure log removal.

**Commit Message Template:**

```text
fix(content): remove per-chunk streaming console.log

- Deleted per-token JSON.stringify log that fired on every streamed chunk
- Removed now-unused chunkCount variable
- Updated stream-done log to report ms only (chunk count no longer tracked)
- Kept first-token timing and heavy-modules-loaded diagnostics
```

---

## Task 1.2 — Add IDE and OS Artifacts to `.gitignore`

**Goal:** Add `.vscode/`, `.idea/`, `.DS_Store`, and `Thumbs.db` to `.gitignore`
to prevent accidental commits of editor and OS artifacts (finding M6 from
health-audit, partially stale but `.gitignore` gap remains).

**Files:**

- `.gitignore`

**Prerequisites:** None

**Implementation Steps:**

1. Open `.gitignore`.
1. Append the following block after the existing four lines:

   ```text
   # IDE
   .vscode/
   .idea/

   # OS
   .DS_Store
   Thumbs.db
   ```

**Verification Checklist:**

- [x] `.gitignore` contains `.vscode/`
- [x] `.gitignore` contains `.idea/`
- [x] `.gitignore` contains `.DS_Store`
- [x] `.gitignore` contains `Thumbs.db`
- [x] Existing entries (`node_modules/`, `dist/`, `coverage/`, `.env.json`) are unchanged

**Testing Instructions:**

```bash
# Verify no tracked files are accidentally removed
git status
```

**Commit Message Template:**

```text
chore(git): add IDE and OS artifacts to .gitignore

- Added .vscode/ and .idea/ to prevent committing editor configs
- Added .DS_Store and Thumbs.db to prevent macOS/Windows OS artifacts
```

---

## Task 1.3 — Declare `onnxruntime-web` as an Explicit Dev Dependency

**Goal:** Add `onnxruntime-web` to `package.json` `devDependencies` so that
`build.mjs` has a declared, auditable dependency on the package whose dist files
it copies (finding H4 from health-audit).

**Files:**

- `package.json`

**Prerequisites:** None

**Implementation Steps:**

1. Run `npm ls onnxruntime-web` to discover the currently resolved version
   in `package-lock.json`:

   ```bash
   npm ls onnxruntime-web
   ```

1. Note the resolved version string (e.g., `1.26.0-dev.20260416-b7804b056c`).
1. Add an entry to `devDependencies` in `package.json` using the exact version
   pinned in the lockfile. Because this is a pre-release dev build, use the
   full version string. For example:

   ```json
   "onnxruntime-web": "1.26.0-dev.20260416-b7804b056c"
   ```

   The exact string must match what `npm ls onnxruntime-web` reports.
1. Run `npm install` to update `package-lock.json` with the explicit dependency
   entry. Confirm `npm install` exits with no errors.
1. Run `npm run build` to confirm the ORT copy step still works.

**Verification Checklist:**

- [x] `package.json` devDependencies contains `onnxruntime-web`
- [x] `npm install` exits 0
- [x] `npm run build` exits 0 and `dist/ort/` contains 8 files (4 variant × 2 ext)
- [x] `npm run typecheck` passes
- [x] `npm test` passes

**Testing Instructions:**

```bash
npm install
npm run typecheck
npm test
npm run build
ls dist/ort/ | wc -l   # should print 8
```

**Commit Message Template:**

```text
chore(build): declare onnxruntime-web as explicit devDependency

- build.mjs copies ORT wasm files from node_modules/onnxruntime-web/dist/
  but the package was previously only a transitive dep of @huggingface/transformers
- An @huggingface/transformers upgrade that changes its ORT peer would silently
  break the build; explicit pin makes the dependency auditable and breakage obvious
```

---

## Task 1.4 — Replace `innerHTML` in `makeTypingIndicator`

**Goal:** Replace the `innerHTML` assignment in `src/ui/messages.ts:makeTypingIndicator`
with explicit `createElement` calls, making the pattern consistent with the rest
of the codebase (finding L1 from health-audit).

**Files:**

- `src/ui/messages.ts`

**Prerequisites:** None

**Implementation Steps:**

1. Open `src/ui/messages.ts`.
1. Replace the current `makeTypingIndicator` implementation:

   ```ts
   export function makeTypingIndicator(doc: Document = document): HTMLElement {
     const wrap = doc.createElement('span');
     wrap.innerHTML =
       '<span class="ln-dot"></span><span class="ln-dot"></span><span class="ln-dot"></span>';
     return wrap;
   }
   ```

   With the DOM-safe equivalent:

   ```ts
   export function makeTypingIndicator(doc: Document = document): HTMLElement {
     const wrap = doc.createElement('span');
     for (let idx = 0; idx < 3; idx++) {
       const dot = doc.createElement('span');
       dot.className = 'ln-dot';
       wrap.appendChild(dot);
     }
     return wrap;
   }
   ```

1. Do not change the function signature or export name.

**Verification Checklist:**

- [x] `src/ui/messages.ts` no longer contains `innerHTML`
- [x] `npm run typecheck` passes
- [x] `npm test` passes — the existing test `'renders three .ln-dot spans'` still passes
  (it only checks `querySelectorAll('.ln-dot').length === 3`, which the new
  implementation satisfies)

**Testing Instructions:**

```bash
npm run typecheck
npm test
```

The existing test in `tests/ui-messages.test.ts` covers this fully — no new
test required.

**Commit Message Template:**

```text
refactor(ui): replace innerHTML in makeTypingIndicator with createElement

- Removes the only innerHTML usage in the codebase
- Consistent with renderMessage which builds all nodes via createElement
- No XSS risk was present (hardcoded string), but the pattern inconsistency
  was a maintenance hazard for future contributors
```

---

## Phase Verification

After all four tasks are committed:

```bash
npm run typecheck
npm run coverage
npm run build
```

All three must pass. Confirm:

- `content.ts` has no `JSON.stringify(value)` call in the stream loop
- `.gitignore` has four new entries
- `package.json` devDependencies has `onnxruntime-web`
- `src/ui/messages.ts` has no `innerHTML`
- All 27 tests pass
- Coverage thresholds met (lines/statements/functions 75%, branches 70%)
