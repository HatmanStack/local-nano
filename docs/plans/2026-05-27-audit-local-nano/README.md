# Unified Audit Remediation — 2026-05-27-audit-local-nano

This plan remediates findings from three audits of `local-nano` (a TypeScript
Chrome MV3 extension that runs an on-device LLM in-browser): a repo-health audit
(0 critical, 0 high, 4 medium, 5 low), a 12-pillar code evaluation (two pillars
below the 9/10 gate: Pragmatism and Performance), and a documentation-drift audit
(3 drift, 1 gap, 1 stale recommendation, plus stale anchors and minor structure
items). All three intake documents live alongside this README:
[`health-audit.md`](health-audit.md), [`eval.md`](eval.md),
[`doc-audit.md`](doc-audit.md).

The codebase is in excellent health — there are NO critical or high code
findings. This is polish and pre-release remediation, not a rescue. The work is
deliberately small and sequenced so cleanup lands before structural fixes,
structural fixes before guardrails, and documentation last. Two hard product
invariants govern every code change: (1) two model loads must NEVER overlap (a
v0.2.0 bug caused `VK_ERROR_OUT_OF_DEVICE_MEMORY`), and (2) the vendored polyfill
under `vendor/prompt-api-polyfill/` is treated as upstream and is never patched.
The single highest-value code change — Pragmatism (8→9) — actually STRENGTHENS
invariant (1) by enforcing it through the `BusyGate` mechanism rather than a
caller contract.

The plan is intentionally compact: four phases, each scoped to the genuinely
worthwhile findings. Some low-severity findings are documented as WONTFIX with
rationale (see Phase-0) rather than padded into busywork. Phases are
branch-agnostic; the implementer commits atomically with conventional-commit
messages (no `Co-Authored-By` trailer — see Phase-0).

## Prerequisites

- Node per `.nvmrc`; `npm install` already run; `.env.json` present (copy from
  `.env.example.json` if missing).
- Working tree clean except the three untracked screenshots Phase 1 handles.
- Familiarity with the validation gates (run them DIRECTLY, never piped to
  `tail` — see Phase-0): `npm run lint:ci`, `npm run typecheck`, `npm test`,
  `npm run build`.

## Phase summary

| Phase | Tag | Goal | Token Estimate |
|-------|-----|------|----------------|
| [Phase 1](Phase-1.md) | [HYGIENIST] | Subtractive cleanup: gitignore the stray screenshots, reset `activeTier` in `rebuildSession`, reword the stale offscreen comment | ~12k |
| [Phase 2](Phase-2.md) | [IMPLEMENTER] | Code fixes: gate-enforce the single-load invariant (Pragmatism 8→9), incremental `stripThink` (Performance 8→9), unify `Tier`/`WarmupTier` | ~40k |
| [Phase 3](Phase-3.md) | [FORTIFIER] | Additive guardrail: `.gitignore` ignore-pattern verification + dev-dep advisory WONTFIX record | ~8k |
| [Phase 4](Phase-4.md) | [DOC-ENGINEER] | Documentation fixes: CHANGELOG/configuration drift, 0.4.0 feature prose, stale anchors, alarms permission, version-stale labels | ~38k |

## Navigation

- [Phase-0: ADRs, conventions, testing strategy, WONTFIX rationale](Phase-0.md)
- [Phase-1: HYGIENIST — cleanup](Phase-1.md)
- [Phase-2: IMPLEMENTER — code fixes](Phase-2.md)
- [Phase-3: FORTIFIER — guardrails](Phase-3.md)
- [Phase-4: DOC-ENGINEER — documentation](Phase-4.md)
- [feedback.md: review channel (PLAN_REVIEW)](feedback.md)
