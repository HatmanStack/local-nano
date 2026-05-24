# Phase 3: Offscreen Listener Consolidation [IMPLEMENTER]

## Phase Goal

Consolidate the three independent `chrome.runtime.onMessage.addListener`
callbacks in `offscreen.ts` (gpu-info at `:212-223`, rebuild-session at
`:225-243`, count-tokens at `:248-267`) into a single dispatching listener.
This removes the MV3 multi-listener / `sendResponse` race: with several
listeners on one event, a non-matching listener that returns `false` after the
matching async listener has taken ownership can close the channel early and drop
`sendResponse` on some Chrome builds (`health` HIGH-1).

Success criteria: exactly one `chrome.runtime.onMessage.addListener` exists in
`offscreen.ts`; it routes each request type to its handler, returns `true` only
when it owns the message, and returns `false`/`undefined` for everything else;
the stream `onConnect` listener is untouched; behavior is otherwise identical;
build and typecheck pass; the dispatch logic has unit coverage via an extracted
helper.

Estimated tokens: ~16k.

## Prerequisites

- Phase-1 and Phase-2 complete.
- Understand the three current handlers and their request guards
  (`isGpuInfoRequest`, `isRebuildSessionRequest`, `isCountTokensRequest`) in
  `src/offscreen/protocol.ts`.

## Tasks

### Task 3.1: Extract a pure dispatch helper into src/offscreen

**Goal:** Per ADR-R5, put the testable routing logic in a `src/`-resident
module so it can be unit-tested without loading `offscreen.ts`. Create
`src/offscreen/dispatch.ts` exporting a function that, given a raw message,
returns which handler kind owns it (or `null`).

**Files to Modify/Create:**

- Create `src/offscreen/dispatch.ts`.
- Create `tests/offscreen-dispatch.test.ts`.

**Prerequisites:** none beyond Phase-2.

**Implementation Steps:**

1. In `src/offscreen/dispatch.ts`, import the three request guards from
   `./protocol.js`. Export a discriminator:

   ```ts
   export type OffscreenRequestKind = 'gpu-info' | 'rebuild-session' | 'count-tokens';

   export function classifyOffscreenMessage(msg: unknown): OffscreenRequestKind | null {
     if (isGpuInfoRequest(msg)) return 'gpu-info';
     if (isRebuildSessionRequest(msg)) return 'rebuild-session';
     if (isCountTokensRequest(msg)) return 'count-tokens';
     return null;
   }
   ```

1. This module has no Chrome or polyfill dependency — only the protocol guards
   (already pure). It is unit-testable in jsdom.

**Verification Checklist:**

- [x] `classifyOffscreenMessage` returns the correct kind for each well-formed
  request and `null` for unrelated/malformed messages (including the
  ensure-offscreen and stream messages, which the offscreen `onMessage`
  listener must NOT own).
- [x] `npm run typecheck` exits 0.

**Testing Instructions:** In `tests/offscreen-dispatch.test.ts`, assert each of
the three request shapes maps to its kind, and that an
`EnsureOffscreenRequest`, a `StreamRequest`, `null`, `{}`, and a random object
all map to `null`. Use the protocol `const` tags to build valid requests.

**Commit Message Template:**

```text
refactor(offscreen): extract pure message-classify helper

classifyOffscreenMessage routes raw messages to a request kind without
any Chrome/polyfill dependency, so the dispatch logic is unit-testable
ahead of consolidating the three onMessage listeners.
```

### Task 3.2: Replace the three onMessage listeners with one dispatcher

**Goal:** Collapse the three `addListener` calls into a single listener that
uses `classifyOffscreenMessage`, runs the matching async handler, and returns
`true` only for an owned message (so the channel stays open for the async
`sendResponse`), otherwise `false`.

**Files to Modify/Create:**

- `offscreen.ts`

**Prerequisites:** Task 3.1.

**Implementation Steps:**

1. Keep the three async handler bodies (`collectGpuInfo` → reply,
   `rebuildSession(msg.history)` → reply, `ensureSession()` +
   `measureContextUsage` → reply). Move each into a small local async function
   that takes the typed message and `sendResponse` and posts the correct
   success/failure response shape (preserve the exact response `type` constants
   and error-string handling already present).
1. Register ONE `chrome.runtime.onMessage.addListener((msg, _sender,
   sendResponse) => { ... })`:
   - `const kind = classifyOffscreenMessage(msg); if (!kind) return false;`
   - `switch (kind)` to the right handler, narrowing `msg` with the same guard
     (call the guard again inside the case for type-narrowing, or cast through
     the guard). Each case kicks off its async handler (fire-and-forget with
     `.then(...)` as today) and the listener returns `true`.
   - For `count-tokens`, preserve the comment that failures here do not destroy
     or rebuild the session (best-effort).
1. Preserve the exact error formatting: `err instanceof Error ? err.message :
   String(err)` and the `ok:false` response per channel.
1. Route any diagnostic logging through the `debugLog`/`dbg` gate from Phase-2.
1. Do NOT touch `chrome.runtime.onConnect.addListener` (the stream port). It is
   a different event and is not part of this race.
1. Confirm the offscreen document still answers all three request types: the
   single listener returns `true` synchronously whenever it owns the message,
   which is exactly what keeps the async channel open. Returning `false` for
   unowned messages lets the SW's own ensure-listener (in
   `src/background/offscreen.ts`, a different context) field its messages —
   note these run in different contexts, but the single-listener pattern is the
   correct MV3 shape regardless.

**Verification Checklist:**

- `offscreen.ts` contains exactly one `chrome.runtime.onMessage.addListener`.
- The single listener returns `true` for gpu-info, rebuild-session, and
  count-tokens requests and `false` for anything else.
- Each response posts the same `type` constant and `ok` shape as before.
- `npm run typecheck` exits 0; `npm run lint:ci` clean; `npm run build`
  succeeds and emits `dist/offscreen.js`.

**Testing Instructions:** The listener body lives in `offscreen.ts` (outside the
coverage set per ADR-R5), so coverage comes from Task 3.1's
`classifyOffscreenMessage` tests. For confidence that response shapes are
unchanged, the existing `tests/offscreen-client.test.ts` (which drives the
client side via `chromeMock.runtime.sendMessage`) continues to pass with no
change. Manual smoke test: load unpacked, open the panel, confirm warmup
(count-tokens), the history-threshold sizing (gpu-info), and Clear conversation
(rebuild-session) all still work and no "malformed reply from offscreen" appears
in the console.

**Commit Message Template:**

```text
fix(offscreen): consolidate three onMessage listeners into one dispatcher

Three sibling listeners each returned false for non-owned messages,
risking the MV3 sendResponse race where a false-returning listener
closes the channel before the async owner replies. A single dispatching
listener returns true only for owned messages. Behavior is otherwise
identical.
```

## Phase Verification

- One `onMessage` listener in `offscreen.ts`; `onConnect` untouched.
- All three request/response round-trips behave as before (verified by the
  unchanged client tests and the manual smoke test).
- `npm run typecheck`, `npm run lint:ci`, `npm run coverage`, `npm run build`
  pass.

Integration points: Phase-5 adds offscreen-side serialization to the
`onConnect` stream handler; this phase deliberately leaves `onConnect` alone so
the two changes stay reviewable in isolation.

Known limitations: `offscreen.ts` itself remains outside coverage thresholds;
the extracted classifier is the unit-tested seam.
