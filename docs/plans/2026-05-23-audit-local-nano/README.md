# Audit Remediation Plan: local-nano

This plan remediates the findings from three intake audits run on 2026-05-23
against `local-nano`, a Chrome MV3 extension that runs on-device LLMs in a
hidden offscreen document via Transformers.js + ONNX Runtime Web behind
Google's vendored Prompt API polyfill. The three inputs are the health audit
(`health-audit.md`: 0 critical, 3 high, 8 medium, 7 low), the 12-pillar
evaluation (`eval.md`: 6 of 12 pillars below the 9/10 bar), and the
documentation audit (`doc-audit.md`: 8 drift, 1 gap, 3 stale examples, 3
structure issues).

The intake docs were corrected after the original audit. Several original
findings were false positives, struck and reframed with
`(Corrected 2026-05-23: ...)` notes. This plan respects every correction: the
model name `onnx-community/gemma-4-E2B-it-ONNX` is real and is never changed;
the `web-store/*.zip` is an untracked local artifact (an `rm`, not a
git-history operation); the `apiKey` field is read by the vendored polyfill and
is documented, not removed; the dev-only npm advisories are out of scope; and
the context-window number is treated as ~128K, not 8-32k.

Work is sequenced in four bands matching the pipeline's implementer/reviewer
handles: subtractive cleanup first (HYGIENIST), then code fixes (IMPLEMENTER),
then additive guardrails (FORTIFIER), then documentation (DOC-ENGINEER). Every
phase title carries exactly one band tag. Cleanup lands before structural fixes
so later phases edit a smaller, deduplicated surface; guardrails land after the
code they guard; docs land last so they describe the post-remediation reality.

## Prerequisites

- Node.js (repo `.nvmrc` pins `20`; local dev has run on `v24`). Use the
  version manager already on the machine.
- `npm ci` to install from the committed `package-lock.json`.
- `cp .env.example.json .env.json` before running typecheck/tests/build (CI
  does the same).
- Working knowledge of the commands in Phase-0 under "Project Conventions".

## Phase Summary

| Phase | Tag | Goal | Token Estimate |
|-------|-----|------|----------------|
| [Phase-0](Phase-0.md) | n/a | Architecture, conventions, testing strategy, commit format | n/a |
| [Phase-1](Phase-1.md) | HYGIENIST | Delete dead code: `src/system.ts` + test, `finalize()` no-op, vendored `dot_env.json`, stale web-store zip | ~12k |
| [Phase-2](Phase-2.md) | HYGIENIST | Deduplicate button `cssText`; gate production `console.log` behind a `DEBUG` flag | ~14k |
| [Phase-3](Phase-3.md) | IMPLEMENTER | Consolidate the three offscreen `onMessage` listeners into one dispatcher (HIGH-1) | ~16k |
| [Phase-4](Phase-4.md) | IMPLEMENTER | Extract the shared chat/ask/rewrite stream lifecycle (HIGH-2); per-element history validation; storage quota handling | ~22k |
| [Phase-5](Phase-5.md) | IMPLEMENTER | Eval remediation: abort-stops-generation (vendored), pageContext slice-before-normalize, shared-session serialization, context-size source-of-truth, isFirstTurn cross-URL re-seed; offscreen test coverage | ~30k |
| [Phase-6](Phase-6.md) | FORTIFIER | Re-enable `noExplicitAny` with one scoped ignore; CI `node-version-file: .nvmrc`; extend `docs-config.test.ts` to guard the testing.md table | ~14k |
| [Phase-7](Phase-7.md) | DOC-ENGINEER | All documentation drift, gap, stale-example, and structure fixes | ~26k |

## Navigation

- [Phase-0: Architecture and Conventions](Phase-0.md)
- [Phase-1: Dead-code removal](Phase-1.md)
- [Phase-2: Duplication and console gating](Phase-2.md)
- [Phase-3: Offscreen listener consolidation](Phase-3.md)
- [Phase-4: Stream-lifecycle extraction and storage hardening](Phase-4.md)
- [Phase-5: Evaluation remediation](Phase-5.md)
- [Phase-6: Guardrails](Phase-6.md)
- [Phase-7: Documentation](Phase-7.md)

## Feedback

Plan-review feedback is logged in [feedback.md](feedback.md) tagged
`PLAN_REVIEW`. Do not overwrite that file; it ships with the empty template.
