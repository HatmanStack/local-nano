# Remediation Plan: local-nano Unified Audit

**Plan ID:** `2026-05-17-audit-local-nano`
**Date:** 2026-05-17
**Repo:** `/home/christophergalliart/projects/local-nano`
**Source audits:** health-audit.md, eval.md, doc-audit.md

## Overview

This plan remediates all findings from a three-audit sweep of the `local-nano`
Chrome MV3 extension (in-browser local LLM inference via Transformers.js +
Prompt API polyfill).

The audit found 0 critical, 6 high, 7 medium, 5 low health findings; 11 of 12
eval pillars below the 9/10 target; and 13 documentation findings across drift,
gaps, config drift, and structure categories.

Work is organized from smallest risk to largest: subtractive cleanup first,
then fixes, then guardrails, then documentation. No phase introduces new
features; all changes are corrective.

## Prerequisites

- Node.js 20+ installed (`node --version`)
- `npm install` run successfully
- Chrome 120+ available for smoke testing
- Git configured with commit signing (if required by repo)
- Read Phase-0 fully before starting any phase

## Pillar Ceiling Notes

Two pillars have realistic ceilings below the 9/10 target. Reviewers must be
aware:

- **Git Hygiene (3/10 today):** The mega-commit history is immutable. Future
  commit discipline and the ADR section added in Phase-3 partially compensate.
  Accept at 7/10 after remediation.
- **Creativity (8/10 today):** At the realistic ceiling for a utility extension.
  The two elegant solutions (right-anchor conversion, MV3 wasm bundling) are
  already in the code. Accept at 8/10.

## Phase Summary

| Phase | Tag | Scope | Key Findings Addressed | Approx Commits |
|-------|-----|-------|----------------------|----------------|
| Phase-0 | — | Architecture decisions, conventions, strategy | All prereqs | 0 (read-only) |
| Phase-1 | HYGIENIST | Remove debug noise, `.gitignore`, dep declaration, `innerHTML` | M1, M6, H4, L1 | 4 |
| Phase-2 | IMPLEMENTER | Strict mode, reader lock, persist error handling, history cap, double-cast | H5, H6, M4, M5, cast | 5 |
| Phase-3 | IMPLEMENTER | Extract `src/session.ts`; type session; deduplicate color; fix H1, H2 | H1, H2, H3, M2, M3, M7 | 2 |
| Phase-4 | IMPLEMENTER | Tests for `src/session.ts`; raise branch threshold | Test Value pillar | 2 |
| Phase-5 | FORTIFIER | Biome lint/format, CI lint step, `.nvmrc`, shared message type | Reproducibility, Code Quality | 4 |
| Phase-6 | DOC-ENGINEER | All doc drift, gap, structure fixes; markdownlint; lychee; cross-ref test | D1–D5, G1–G4, C1, S1–S3 | 6 |

**Total estimated commits:** ~23

## Navigation

| File | Role |
|------|------|
| [Phase-0.md](Phase-0.md) | Architecture decisions, project conventions, stale findings, pillar ceilings |
| [Phase-1.md](Phase-1.md) | `[HYGIENIST]` Cleanup |
| [Phase-2.md](Phase-2.md) | `[IMPLEMENTER]` Quick-win fixes |
| [Phase-3.md](Phase-3.md) | `[IMPLEMENTER]` Session extraction |
| [Phase-4.md](Phase-4.md) | `[IMPLEMENTER]` Session tests |
| [Phase-5.md](Phase-5.md) | `[FORTIFIER]` Lint and tooling |
| [Phase-6.md](Phase-6.md) | `[DOC-ENGINEER]` Documentation fixes |
| [feedback.md](feedback.md) | Plan Reviewer feedback channel |

## Finding Coverage

### Health Audit (health-audit.md)

| Finding | Phase | Task |
|---------|-------|------|
| H1 — irrecoverable rejected promise in `loadHeavy()` | Phase-3 | Task 3.2 |
| H2 — silent message drop during model load | Phase-3 | Task 3.2 |
| H3 — `content.ts` god module | Phase-3 | Task 3.2 |
| H4 — undeclared `onnxruntime-web` transitive dep | Phase-1 | Task 1.3 |
| H5 — `strict: false` | Phase-2 | Task 2.1 |
| H6 — leaked stream reader lock | Phase-2 | Task 2.3 |
| M1 — per-chunk console.log | Phase-1 | Task 1.1 |
| M2 — implicit `window.TRANSFORMERS_CONFIG` coupling | Phase-3 | Task 3.2 (closure isolation) |
| M3 — terse variable names (`i`, `s`, `v`) | Phase-3 | Task 3.2 |
| M4 — unbounded history growth | Phase-2 | Task 2.5 |
| M5 — fire-and-forget storage writes | Phase-2 | Task 2.4 |
| M6 — `.gitignore` gaps | Phase-1 | Task 1.2 |
| M7 — `isFirstTurn` lifecycle bug | Phase-3 | Task 3.2 (documented) |
| L1 — `innerHTML` in typing indicator | Phase-1 | Task 1.4 |
| L2 — npm moderate vulnerabilities | Deferred (dev-only, low risk) | — |
| L3 — `vendor/dot_env.json` false positives | Phase-6 | Task 6.3 (C1) |
| L4 — content.ts excluded from coverage | Phase-4 | Task 4.1 (session.ts added to src/) |
| L5 — redundant ORT config | Phase-3 | Task 3.2 (closure refactor clarifies path) |

### Eval (eval.md)

| Pillar | Current | Target | Phase |
|--------|---------|--------|-------|
| Problem-Solution Fit | 9 | 9 | No work needed |
| Architecture | 8 | 9 | Phase-3 |
| Code Quality | 7 | 9 | Phase-1, Phase-2, Phase-3 |
| Creativity | 8 | 8 (ceiling) | Accept |
| Pragmatism | 8 | 9 | Phase-3 (ensureSession input guard) |
| Defensiveness | 5 | 9 | Phase-2, Phase-3 |
| Performance | 6 | 8 | Phase-1, Phase-2 |
| Type Rigor | 5 | 9 | Phase-2, Phase-3 |
| Test Value | 7 | 9 | Phase-4 |
| Reproducibility | 8 | 9 | Phase-5 |
| Git Hygiene | 3 | 7 (ceiling) | Phase-3 (ADRs), ongoing discipline |
| Onboarding | 8 | 9 | Phase-3 (architecture ADRs), Phase-6 |

### Doc Audit (doc-audit.md)

| Finding | Phase | Task |
|---------|-------|------|
| D1 — polyfill install described backwards | Phase-6 | Task 6.1 |
| D2 — wrong default model in configuration.md | Phase-6 | Task 6.1 |
| D3 — fictional `Thinking…` indicator | Phase-6 | Task 6.1 |
| D4 — missing wildcard host permission in privacy table | Phase-6 | Task 6.1 |
| D5 — manifest version format mismatch | Phase-6 | Task 6.1 |
| G1 — undocumented dependabot-auto-merge workflow | Phase-6 | Task 6.2 |
| G2 — undocumented defaults.js secondary config layer | Phase-6 | Task 6.2 |
| G3 — missing resync procedure | Phase-6 | Task 6.2 |
| G4 — stale polyfill header comment | Phase-6 | Task 6.2 |
| C1 — dot_env.json presented as live config | Phase-6 | Task 6.3 |
| S1 — README nav omits half the docs | Phase-6 | Task 6.3 |
| S2 — README polyfill link wrong repo | Phase-6 | Task 6.3 |
| S3 — contributing.md coverage step unclear | Phase-6 | Task 6.3 |

## Definition of Done

The plan is complete when all phases pass their Phase Verification sections and:

1. `npm run lint:ci && npm run typecheck && npm run coverage && npm run build`
   all exit 0
1. `npx markdownlint-cli2 "**/*.md" --ignore "node_modules/**" --ignore "vendor/**" --ignore "coverage/**"`
   exits 0
1. The finding coverage table above has no unaddressed rows (except the two
   deferred items: L2 npm vulns and the two pillar ceilings)
