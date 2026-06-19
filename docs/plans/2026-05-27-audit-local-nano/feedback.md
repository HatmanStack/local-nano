# Feedback Log

## Verification

VERIFIED (2026-05-27) — all remediated findings confirmed against current code and the full gate suite passes (lint:ci, typecheck, 596/596 tests, coverage 95.38%, build, markdownlint). HEALTH (screenshots gitignored, Tier/WarmupTier unified, rebuildSession activeTier reset, stale comment reworded), EVAL (Pragmatism gate-check enforcement in handleWarmup/handleCountTokens; Performance incremental createThinkStripper proven equivalent to the stripThink oracle), and DOCS (CHANGELOG 3-live-entries, configuration.md rejected-model + apiKey anchor, 0.4.0 feature prose, module inventories, re-derived line anchors, alarms permission, all four download-progress docs consistent) all VERIFIED. WONTFIX items (initSession monolith, page-wide listeners, dev-only npm-audit advisories) properly recorded with rationale. No UNVERIFIED items.

## Active Feedback

## Resolved Feedback

### CODE_REVIEW — Phase 4 — Two surviving "no download-progress / no percentage" claims contradict the fix this phase just landed

Status: RESOLVED (commit `7dea781`)

Resolution: verified the real behavior against `src/session.ts`'s
`renderHint`/`progressPhase` (lines 1273-1312) and `src/offscreen/progress.ts`
(`formatProgressText`/`GPU_LOADING_TEXT`) — the download phase shows a real
`Downloading model NN%` percent, falling back to the elapsed-seconds
`Loading model… Ns` counter only when no progress frame arrives or for a cached
load. Reworded both surviving inverse claims to match: `docs/models.md:29` and
`docs/development.md:52`. markdownlint clean on both; `npm test` green (596
tests / 25 files, docs-config drift-guard passes). The four download-progress
docs (prompt-api.md, configuration.md, models.md, development.md) are now
internally consistent.

Original finding:

Task 4.4 corrected `docs/prompt-api.md` so it no longer claims "there is no
`monitor`/`downloadprogress` wiring and no percentage UI" — it now describes the
phased progress (real `Downloading model NN%` from `formatProgressText`, then the
indeterminate `Loading into GPU…`, then the elapsed fallback). That matches
`src/session.ts:1273-1303`, `src/offscreen/progress.ts:64-68`, the
`broadcastProgress`/`STREAM_PROGRESS` relay (`offscreen.ts:111`,
`src/offscreen/protocol.ts:399-400`), and the freshly-written
`docs/configuration.md` "Phased first-run download progress" prose.

Two other user-facing docs still carry the EXACT inverse claim that 0.3.0 made
false:

1. `docs/models.md:29` — "while the model loads it shows a live elapsed-seconds
   counter (`Loading model… Ns`) rather than a percentage, **since the app does
   not consume download-progress events**."
1. `docs/development.md:52` — "While the model loads the panel shows a live
   elapsed-seconds counter (`Loading model… Ns`), **not a percentage**; after
   ~45s it appends 'taking longer than usual' remedies."

Consider: both were authored by the 2026-05-23 audit (`Phase-7.md` deliberately
wrote "elapsed counter rather than a percentage" across multiple docs when the
percentage UI had been removed), then the 2026-05-24 model-load-resilience plan
re-added phased download progress in 0.3.0 — so these became false at the same
moment the `prompt-api.md` claim did. Reflect on whether shipping 0.4.0 docs that
say in one place "the app does not consume download-progress events" while three
other docs describe exactly that consumption is a coherent release. Think about
whether the `tests/docs-config.test.ts` drift-guard catches prose like this (it
does not — it only policies the test-file table), so nothing else will surface
the contradiction.

This is the same class of finding as Task 4.4's own stated goal, just two
anchors the audit's DRIFT #3 enumeration missed. Folding them in (reword each to
note the download phase shows a real percent, falling back to the elapsed counter
when no frame arrives / for a cached load) keeps the release internally
consistent and is a one-sentence change per file. Verify against
`src/session.ts`'s `renderHint`/`progressPhase` before rewording.
