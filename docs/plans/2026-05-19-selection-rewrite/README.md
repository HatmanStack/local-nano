# Plan: Selection-driven in-place rewrite (v0.2.3)

## Overview

Bring back the v0.2.0 capability of editing highlighted prose on the page with
the on-device model, redesigned against the memory budget that killed that
release. The user highlights text, types an editing instruction into the
existing chat input, and the model rewrites the selection in place. Tokens
stream directly into the DOM, replacing the original text as they arrive.

The architecture differs from v0.2.0 in three load-bearing ways. First, it
reuses the single offscreen `LanguageModel` session that already powers chat;
no `LanguageModel.create()` call lands a second model in WebGPU memory.
Second, the selection payload is hard-capped at ~700 chars (selection plus
~200 chars of surrounding context on each side). Third, a per-call soft cap
on `max_new_tokens` is computed from a real token count via a new offscreen
`count` channel, with a heuristic fallback if the round-trip exceeds 100ms.

Transforms are treated as normal turns in the same chat thread. The
instruction and rewritten text both flow through the existing `streamPrompt`
path, land in the polyfill history, and persist to `chrome.storage.local`
under the same per-URL key. The chat panel renders them as user/model
bubbles. The model bubble for a transform carries a single "Undo" button
that restores the original DOM range from a JS-memory snapshot. No
preview-then-apply UI, no context menus, no new hotkeys.

## Prerequisites

- Node 20 (see `.nvmrc`). Use the version pinned there.
- `npm ci` from a clean clone. Project uses npm, not pnpm or yarn.
- Familiarity with the v0.2.2 offscreen-document architecture. Read
  `src/session.ts`, `src/offscreen/client.ts`, `src/offscreen/protocol.ts`,
  `src/offscreen/stream-client.ts`, and `offscreen.ts` before starting.
- `npm run typecheck`, `npm test -- --run`, `npm run build`, and
  `npm run lint:ci` must pass clean on a fresh clone before any plan work
  begins. If they don't, stop and report.

## Phase Summary

| Phase | Goal | Token Estimate |
| ----- | ---- | -------------- |
| 0 | Foundation: ADRs, conventions, polyfill constraint decisions, testing strategy | ~7,000 |
| 1 | Implementation: protocol extension, transform module, session integration, undo, tests, docs | ~45,000 |

The work fits a single implementation phase. Phase-0 is the law; Phase-1 is
the build.

## Navigation

- [Phase-0](./Phase-0.md) — Foundation
- [Phase-1](./Phase-1.md) — Implementation
- [feedback.md](./feedback.md) — Reviewer feedback log
- [brainstorm.md](./brainstorm.md) — Source brainstorm
