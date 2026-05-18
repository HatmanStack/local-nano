# Phase 3 — [IMPLEMENTER] Session Extraction: `content.ts` Decomposition

## Phase Goal

Extract the session lifecycle, streaming, history wiring, and toggle handler
from `content.ts` into a new `src/session.ts` module with injected dependencies.
This makes the most complex business logic in the extension independently
testable, removes the god-module pattern, types the session object, deduplicates
the color token, and shares the message protocol type.

`content.ts` after this phase becomes a thin bootstrap: it creates the DOM,
calls `initSession(deps)`, and that's it.

**Success criteria:**

- `src/session.ts` exports `initSession(deps: SessionDeps): void`
- `content.ts` is ≤ 160 lines (DOM construction + `initSession` call only)
- `let s: any = null` is gone; session is typed via `LanguageModelSession` interface
- `content.ts` toggle handler uses `TOGGLE_MESSAGE` from `src/background/handler.ts`
  instead of checking the raw string `'toggle'`
- Color token `#0a5fa3` is defined once in `src/ui/state.ts:IDLE_BG` and
  imported; the hardcoded hex in `content.ts` is removed
- `isFirstTurn` lifecycle bug (M7) is documented in a code comment
- `npm run typecheck` passes with `strict: true`
- All existing 30 tests pass; `npm run coverage` passes

**Token estimate:** ~22k tokens

## Prerequisites

- Phase-2 complete and committed
- `tsconfig.json` has `"strict": true`
- 30 tests passing

## Task 3.1 — Define `LanguageModelSession` Interface

**Goal:** Create a typed interface for the `LanguageModel` session object so the
compiler can enforce null checks and method signatures, lifting Type Rigor and
Architecture pillars (eval.md Architecture 8→9 target).

**Files:**

- `src/session.ts` (new file)

**Prerequisites:** None

**Implementation Steps:**

1. Create `src/session.ts` with just the interface and no other logic yet.
   The interface captures only the methods actually used in `content.ts`:

   ```ts
   /**
    * Minimal typed surface for a LanguageModel session returned by the
    * Prompt API polyfill. Only the methods called in this extension are
    * declared; the full spec surface is larger.
    */
   export interface LanguageModelSession {
     promptStreaming(
       input: string,
       options?: { signal?: AbortSignal },
     ): ReadableStream<string>;
     destroy(): void;
   }
   ```

   Note: `destroy()` is not yet called in the current codebase but is part of
   the Prompt API spec and will be used when the panel is closed. Declare it now
   to make the interface accurate.

1. Run `npm run typecheck` — the file is not imported anywhere yet, but it
   should typecheck cleanly.

**Verification Checklist:**

- [x] `src/session.ts` exists with `LanguageModelSession` interface
- [x] `npm run typecheck` passes

**Commit Message Template:**

```text
feat(session): add LanguageModelSession interface

- Types the promptStreaming and destroy methods from the Prompt API spec
- Replaces the let s: any = null session variable pattern in subsequent tasks
```

---

## Task 3.2 — Extract Session Logic into `src/session.ts`

**Goal:** Move `loadHeavy`, `ensureSession`, `send`, `restore`, `addMessage`,
`persist`, the toggle listener, `activeAbort`, `isFirstTurn`, `creating`, and
the session variable out of `content.ts` into `src/session.ts` with injected
DOM dependencies. `content.ts` will call `initSession(deps)` to wire everything up.

**Files:**

- `src/session.ts`
- `content.ts`

**Prerequisites:** Task 3.1 complete

**Implementation Steps:**

Read `content.ts` in full (already done by this point in the plan) before
editing. The extraction proceeds in this order: define the deps interface,
implement `initSession`, then strip `content.ts`.

**Step 1: Define `SessionDeps` in `src/session.ts`**

After the `LanguageModelSession` interface, add:

```ts
import {
  storageKey,
  loadHistory as loadHistoryFromStorage,
  saveHistory as saveHistoryToStorage,
  type Entry,
  type Role,
} from './history.js';
import { pageContext } from './pageContext.js';
import { SYSTEM_INSTRUCTION } from './system.js';
import { makeTypingIndicator, renderMessage } from './ui/messages.js';
import { setIdleState, setGeneratingState } from './ui/state.js';
import { TOGGLE_MESSAGE } from './background/handler.js';
import transformersConfigType from '../.env.json';

// The transformers config shape — imported for type only; actual import
// happens at build time in content.ts.
type TransformersConfig = typeof transformersConfigType;

/**
 * DOM elements and values that content.ts provides at injection time.
 * session.ts does not touch document directly.
 */
export interface SessionDeps {
  root: HTMLElement;
  messages: HTMLElement;
  input: HTMLInputElement;
  actionBtn: HTMLButtonElement;
  transformersConfig: TransformersConfig;
  location: Pick<Location, 'origin' | 'pathname' | 'href'>;
  document: Pick<Document, 'title'> & { body: { innerText: string } };
}
```

**Step 2: Move module-level state into `initSession` closure**

Below `SessionDeps`, add the complete `initSession` implementation. All
module-scope variables from `content.ts` (`heavyLoadPromise`, `s`, `creating`,
`isFirstTurn`, `history`, `activeAbort`) become local variables inside
`initSession`'s closure:

```ts
export function initSession(deps: SessionDeps): void {
  const { root, messages, input: i, actionBtn, transformersConfig, location, document } = deps;
  const STORAGE_KEY = storageKey(location);

  // ---- Heavy module loader (lazy, singleton) ----
  let heavyLoadPromise: Promise<{ LanguageModel: { create: (opts: unknown) => Promise<LanguageModelSession> } }> | null = null;

  function loadHeavy() {
    if (heavyLoadPromise) return heavyLoadPromise;
    heavyLoadPromise = (async () => {
      const [tfMod, polyfillMod] = await Promise.all([
        import('@huggingface/transformers'),
        import('../vendor/prompt-api-polyfill/prompt-api-polyfill.js'),
      ]);
      const ortPath = chrome.runtime.getURL('dist/ort/');
      (tfMod.env as unknown as { backends: { onnx: { wasm: { wasmPaths: string; numThreads: number } } } })
        .backends.onnx.wasm.wasmPaths = ortPath;
      (tfMod.env as unknown as { backends: { onnx: { wasm: { numThreads: number } } } })
        .backends.onnx.wasm.numThreads = 1;
      (window as Record<string, unknown>).TRANSFORMERS_CONFIG = transformersConfig;
      console.log('[local-nano] heavy modules loaded; ORT wasmPaths =', ortPath);
      return { LanguageModel: (polyfillMod as { LanguageModel: { create: (opts: unknown) => Promise<LanguageModelSession> } }).LanguageModel };
    })();
    return heavyLoadPromise;
  }

  // ---- History ----
  let history: Entry[] = [];

  function persist() {
    saveHistoryToStorage(STORAGE_KEY, history).catch((err: unknown) => {
      console.error('[local-nano] history write failed:', err);
    });
  }

  async function restore(): Promise<void> {
    history = await loadHistoryFromStorage(STORAGE_KEY);
    for (const entry of history) renderMessage(messages, entry.role, entry.text);
  }

  function addMessage(role: Role, text: string): HTMLElement {
    const el = renderMessage(messages, role, text);
    if (role !== 'system') {
      history.push({ role, text });
      persist();
    }
    return el;
  }

  // ---- Session state ----
  let session: LanguageModelSession | null = null;
  let creating = false;
  // NOTE(isFirstTurn): This flag is not reset after restore() re-renders prior
  // history. The restored messages are displayed in the UI but the new session
  // has no access to them (the polyfill creates a fresh context). This means
  // follow-up messages after a page reload produce contextless responses.
  // Fixing this requires either replaying history into the session's
  // initialPrompts on creation, or disabling isFirstTurn-based page context
  // injection when prior history exists. Tracked as M7 — deferred to a future
  // iteration because the correct fix depends on polyfill replay support.
  let isFirstTurn = true;

  async function ensureSession() {
    if (session || creating) return;
    creating = true;
    i.disabled = true;
    const status = addMessage('system', 'Loading model…');
    try {
      const { LanguageModel } = await loadHeavy();
      const created = await LanguageModel.create({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: [{ role: 'system', content: SYSTEM_INSTRUCTION }],
        monitor(mon: EventTarget) {
          mon.addEventListener('downloadprogress', (e) => {
            const ev = e as Event & { loaded: number };
            const v = ev.loaded;
            const label = v <= 1 ? `${Math.round(v * 100)}%` : `${(v / 1_000_000).toFixed(1)} MB`;
            status.textContent = `Loading model… ${label}`;
          });
        },
      });
      session = created;
      status.textContent = 'Ready.';
      i.disabled = false;
    } catch (e: unknown) {
      console.error('[local-nano] LanguageModel.create failed:', e);
      status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      // Reset heavyLoadPromise so the user can retry by closing and reopening
      // the panel. Without this, every subsequent ensureSession call returns
      // the same rejected promise and the failure is permanent for the tab.
      heavyLoadPromise = null;
      i.disabled = false;
    } finally {
      creating = false;
    }
  }

  // ---- Send / Stop ----
  let activeAbort: AbortController | null = null;

  async function send() {
    if (!i.value.trim() || !session || activeAbort) return;
    const text = i.value.trim();
    i.value = '';
    addMessage('user', text);
    const responseEl = renderMessage(messages, 'model', '');
    const indicator = makeTypingIndicator();
    responseEl.appendChild(indicator);
    const prompt = isFirstTurn
      ? `${pageContext(document, location)}\n\n---\n\n${text}`
      : text;
    isFirstTurn = false;

    activeAbort = new AbortController();
    setGeneratingState(actionBtn, i);

    let modelText = '';
    try {
      const t0 = performance.now();
      const stream = session.promptStreaming(prompt, { signal: activeAbort.signal });
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
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        modelText = modelText + (modelText ? '\n\n[stopped]' : '[stopped]');
        responseEl.textContent = modelText;
      } else {
        modelText = String(err);
        responseEl.textContent = modelText;
      }
    } finally {
      if (modelText) {
        history.push({ role: 'model', text: modelText });
        persist();
      }
      setIdleState(actionBtn, i);
      activeAbort = null;
      i.focus();
    }
  }

  // ---- Event wiring ----
  actionBtn.addEventListener('click', () => {
    if (activeAbort) {
      activeAbort.abort();
    } else {
      void send();
    }
  });

  i.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  // ---- Toggle listener ----
  let convertedAnchor = false;
  chrome.runtime.onMessage.addListener((m: typeof TOGGLE_MESSAGE) => {
    if (m.a !== TOGGLE_MESSAGE.a) return;
    if (!root) return;
    if (root.style.display === 'none') {
      root.style.display = 'flex';
      if (!convertedAnchor) {
        const rect = root.getBoundingClientRect();
        root.style.left = rect.left + 'px';
        root.style.right = 'auto';
        convertedAnchor = true;
      }
      i.focus();
      void ensureSession();
    } else {
      root.style.display = 'none';
    }
  });

  // ---- Initial restore ----
  void restore();
}
```

**Step 3: Update `content.ts`**

Replace the content of `content.ts` with only:

1. The `import` block (same as before for the `src/` modules, but remove
   `history`, `pageContext`, `system`, `ui/*`, `state` — those are now imported
   inside `session.ts`). The only imports left in `content.ts` are:
   - `transformersConfig` from `./.env.json`
   - `initSession, type SessionDeps` from `./src/session.js`

1. The animation `<style>` injection (unchanged)

1. The DOM construction block (unchanged, ~60 lines)

1. The dragging logic (unchanged, ~20 lines)

1. The close-button listener (unchanged, 1 line)

1. The `actionBtn` background color: replace the hardcoded `#0a5fa3` hex with
   `IDLE_BG` imported from `./src/ui/state.js`. This deduplicates the color
   token (eval.md Code Quality finding).

1. The `initSession(deps)` call at the end:

   ```ts
   import transformersConfig from './.env.json';
   import { initSession } from './src/session.js';
   import { IDLE_BG } from './src/ui/state.js';

   // ... style, DOM construction, drag listeners ...

   actionBtn.style.background = IDLE_BG;  // replaces hardcoded #0a5fa3

   initSession({
     root,
     messages,
     input,
     actionBtn,
     transformersConfig,
     location,
     document,
   });
   ```

   Note: rename the `i` element to `input` in `content.ts` to match the
   `SessionDeps` field name, addressing finding M3 (terse variable names).

   Also rename `messages` scroll container — it's already named `messages`,
   which is fine. The `root` and `header` variables are also already
   descriptive.

**Step 5: Handle the `as any` casts on `tfMod.env`**

In `src/session.ts`, the `loadHeavy` function accesses Transformers.js internals.
The casts needed are:

```ts
(tfMod.env as unknown as TransformersEnv).backends.onnx.wasm.wasmPaths = ortPath;
(tfMod.env as unknown as TransformersEnv).backends.onnx.wasm.numThreads = 1;
```

Add a local type alias at the top of the function (or file) to avoid repeated
verbose casts:

```ts
interface OnnxWasmEnv {
  backends: { onnx: { wasm: { wasmPaths: string; numThreads: number } } };
}
```

Then:

```ts
(tfMod.env as unknown as OnnxWasmEnv).backends.onnx.wasm.wasmPaths = ortPath;
(tfMod.env as unknown as OnnxWasmEnv).backends.onnx.wasm.numThreads = 1;
```

This is cleaner than the existing `as any` and still intentional at the
polyfill boundary.

**Verification Checklist:**

- [ ] `src/session.ts` exports `LanguageModelSession`, `SessionDeps`, `initSession`
- [ ] `content.ts` is ≤ 160 lines
- [ ] `content.ts` does not contain `heavyLoadPromise`, `ensureSession`, `send`,
  `activeAbort`, `isFirstTurn`, `creating`, `persist`, `addMessage`, `restore`
- [ ] `content.ts` does not contain `let s:` or `let session:`
- [ ] `content.ts` does not contain the raw string `'toggle'` in a message check
- [ ] `content.ts` does not contain the hardcoded hex `#0a5fa3` for the button
  (it imports `IDLE_BG` from `src/ui/state.ts`)
- [ ] `src/session.ts` contains the `isFirstTurn` comment documenting M7 behavior
- [ ] `heavyLoadPromise = null` is inside the `catch` block in `ensureSession`
  (H1 fix — irrecoverable rejected promise)
- [ ] `i.disabled = true` is set before loading and `i.disabled = false` is set
  in both success and catch paths (H2 fix — silent drop during load)
- [ ] `npm run typecheck` passes
- [ ] All 30 existing tests pass

**Testing Instructions:**

```bash
npm run typecheck
npm test
npm run build
```

Also verify `dist/content.js` is generated (the IIFE bundle still compiles from
the updated `content.ts`).

**Commit Message Template:**

```text
refactor(content): extract session logic into src/session.ts

- Moved loadHeavy, ensureSession, send, restore, addMessage, persist,
  toggle listener, and all session state into src/session.ts
- content.ts is now a thin DOM bootstrap (~130 lines)
- Session typed via LanguageModelSession interface (no more let s: any)
- H1 fix: heavyLoadPromise reset to null on creation failure to allow retry
- H2 fix: input disabled during model load to prevent silent message drop
- M3 fix: renamed input element from i to input in content.ts
- Color token deduplicated: actionBtn uses IDLE_BG from src/ui/state.ts
- Message protocol: toggle check uses TOGGLE_MESSAGE.a from handler.ts
- M7: isFirstTurn lifecycle bug documented in code comment
```

---

## Task 3.3 — Add Architecture Decision Record to `docs/architecture.md`

**Goal:** Document the session lifecycle and module-global state decisions in
`docs/architecture.md` as an ADR section. This partially substitutes for the
invisible development history (Git Hygiene pillar) and satisfies the Onboarding
remediation target from eval.md.

**Files:**

- `docs/architecture.md`

**Prerequisites:** Task 3.2 complete

**Implementation Steps:**

1. Append the following section to `docs/architecture.md`:

```markdown
## Session Lifecycle (post-extraction)

After the Phase-3 refactor, session state lives entirely inside the closure
returned by `initSession()` in `src/session.ts`. Key variables:

| Variable | Type | Description |
|----------|------|-------------|
| `session` | `LanguageModelSession \| null` | The active polyfill session; null before first successful `ensureSession()` call |
| `creating` | `boolean` | Guards against concurrent `ensureSession()` calls |
| `isFirstTurn` | `boolean` | True until the first `send()` in a session |
| `heavyLoadPromise` | `Promise \| null` | Memoizes the dynamic import; reset to null on failure to allow retry |
| `activeAbort` | `AbortController \| null` | Non-null while a stream is in progress |
| `history` | `Entry[]` | In-memory history array, persisted on every user/model turn |

### Known Lifecycle Limitations

**`isFirstTurn` and page reload (M7):** When a page is reloaded, `restore()`
re-renders prior history entries from `chrome.storage.local` into the message
list. However, `isFirstTurn` stays `true` — the new polyfill session has no
knowledge of those restored entries. Sending a follow-up message after reload
will include the page context prefix again (as if it were the first turn) and
the model will respond without memory of the prior conversation.

The correct fix is to replay the restored history into `LanguageModel.create`'s
`initialPrompts`. This requires the polyfill to accept user/model turns in
`initialPrompts`, which it does — but replaying could be expensive for long
histories and is deferred pending user feedback on whether continuity across
reloads is a desired feature.

## Architecture Decision Records

### ADR-001: Why `content.ts` compiles as IIFE

MV3 content scripts cannot be ESM modules — they are injected into host pages
that may not be module-aware. `build.mjs` sets `format: 'iife'` for
`content.ts`. The `src/` modules are bundled in by esbuild at build time.
`background.ts` uses `format: 'esm'` because service workers support ESM.

### ADR-002: Why ORT wasm files are copied to `dist/ort/`

MV3 content-script CSP forbids `eval()` and remote dynamic imports. Transformers.js
normally fetches ONNX Runtime Web wasm files from `jsdelivr.net` at runtime.
Bundling them locally and serving via `chrome.runtime.getURL` is the only
compliant path. The `web_accessible_resources` entry in `manifest.json` exposes
`dist/ort/*` to the content script's page context.

### ADR-003: Why the polyfill is vendored instead of npm-installed

The published `prompt-api-polyfill@0.1.0` npm package ships only the Firebase
backend. The Transformers.js backend only exists on `main` in the upstream
GitHub repo. Additionally, we modify the polyfill (strip unused backends, remove
iframe-injection observer, raise max_new_tokens) in ways incompatible with
version-locked npm deps. Vendoring keeps the diffs visible in this repo.

### ADR-004: Why `heavyLoadPromise` is reset to null on failure

If `loadHeavy()` or `LanguageModel.create()` fails, the rejected promise must
not be cached. Without resetting, every subsequent `ensureSession()` call
returns the same rejected promise and the extension is permanently broken in
that tab without a page reload. Resetting to null allows the next panel open to
retry the full load sequence.
```

**Verification Checklist:**

- [ ] `docs/architecture.md` has a "Session Lifecycle (post-extraction)" section
- [ ] The session variable table is present
- [ ] ADR-001 through ADR-004 are present
- [ ] M7 lifecycle limitation is documented

**Commit Message Template:**

```text
docs(architecture): add session lifecycle section and ADRs

- Documents session state variables after src/session.ts extraction
- Documents isFirstTurn/M7 lifecycle limitation and why fix is deferred
- ADR-001: IIFE vs ESM content script constraint
- ADR-002: ORT wasm local bundling rationale
- ADR-003: polyfill vendoring rationale
- ADR-004: heavyLoadPromise reset-on-failure rationale
```

---

## Phase Verification

After all tasks are committed:

```bash
npm run typecheck
npm run coverage
npm run build
```

All three must exit 0.

Confirm:

- `content.ts` is ≤ 160 lines, has no business logic
- `src/session.ts` exists with `LanguageModelSession`, `SessionDeps`, `initSession`
- `docs/architecture.md` has session lifecycle section and 4 ADRs
- All 30 tests pass (no tests were added in this phase; Phase-4 adds them)
- `dist/content.js` is generated by `npm run build`
