# Feedback Log

## Active Feedback

## Resolved Feedback

### CODE_REVIEW: Phase 1 (Layer C, authoritative zero-chunk detection)

Status: RESOLVED
Source: CODE_REVIEW (senior engineer post-implementation review)
Scope: `src/offscreen/stream-finalize.ts`, `offscreen.ts`, `src/offscreen/failure.ts`, `tests/offscreen-stream-finalize.test.ts`, `tests/offscreen-failure.test.ts`, `tests/session.test.ts`, `docs/testing.md`

Resolution: Approved. No changes requested. Tool evidence:

1. Four commits present in task order on main after `f18926c`: `58fc5aa` (refactor extract), `0c7f35b` (fix wire-in), `f11e88f` (fix classifier), `b82fd82` (test integration). Conventional format, atomic, no `Co-Authored-By`/`Generated-By` trailers.
1. `src/offscreen/stream-finalize.ts` is a pure module (imports only the type and `STREAM_DONE` const from `./protocol.js`; no chrome/DOM/side effects). `finalizeStreamDone` logic verified: `aborted` then `'aborted'`; else `chunkCount === 0` then `POISONED_STREAM_ERROR`; else `ok: true`. `POISONED_STREAM_ERROR` equals the exact wire string.
1. `tests/offscreen-stream-finalize.test.ts` holds five real assertions covering all four return branches plus the exact-string check.
1. `offscreen.ts` success tail now calls `finalizeStreamDone({ id, aborted: controller.signal.aborted, chunkCount })`. The catch branch still posts `STREAM_DONE { ok: false, error: errMsg }` directly (unchanged), the abort path flows through the helper via the controller flag (not chunk count), `chunkCount++` per chunk is unchanged, and `generationGate.release()` in the finally is untouched.
1. `TERMINAL_SIGNALS` in `src/offscreen/failure.ts` adds `'no tokens emitted'`; `classifyFailure` substring-matches case-insensitively so the prefix routes the full string to `terminal`. The failure test imports `POISONED_STREAM_ERROR` from `stream-finalize.ts` (no hardcoded duplicate).
1. `git diff f18926c..HEAD -- src/session.ts` is empty. The terminal reactive recovery (line 588 `classifyFailure(err) === 'terminal'` then `reloadModel()`) and the 0.4.2 empty-success retry (line 639 `succeeded && !streamResult && !alreadyRetried`) are both intact and untouched.
1. Never-two-concurrent-loads invariant intact: no diff to `busy-gate`, `src/background/offscreen.ts`, or `protocol.ts`; no `generationGate`/`warmInFlight`/`reWarmInFlight` change in `offscreen.ts`.
1. `vendor/prompt-api-polyfill/` untouched. No vision/multimodal capability added.
1. `docs/testing.md` has the matching row for the new test file; the `tests/docs-config.test.ts` drift guard passes.
1. Validation green run directly (no `tail`): `npm run lint:ci` (exit 0), `npm run typecheck` (exit 0), `npx vitest run` (615 tests, 26 files, exit 0), `npm run build` (exit 0). The markdownlint MD024 errors are pre-existing in the planner's `Phase-N.md` spec docs (repeated section headings across tasks); the implementation touched no plan docs and `docs/testing.md` lints clean.

### PLAN_REVIEW: ADR-3 implies a SW-to-panel SESSION_POISONED broadcast that Phase 2 does not actually plan

Status: RESOLVED
Source: PLAN_REVIEW (tech-lead pre-implementation review)
Scope: `Phase-0.md` ADR-3 vs `Phase-2.md` Task 2.4 deliverables vs `Phase-4.md` Task 4.1 chosen mechanism

Resolution: Rewrote ADR-3 in `Phase-0.md` to describe ONLY the pull-only
`gpu-info` round-trip path that Phase 4 Task 4.1 actually implements, listed
the SW-to-panel broadcast as an explicitly rejected alternative for 0.4.3,
and aligned Phase 4's success criteria + known-limits paragraph so the
single mechanism (preflight pull + diagnostic field) is consistent across
ADR-3, Phase 2 (which does not touch the diagnostic), Phase 4, and the
README.
