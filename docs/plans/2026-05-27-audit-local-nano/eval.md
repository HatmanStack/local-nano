---
type: repo-eval
date: 2026-05-27
plan: 2026-05-27-audit-local-nano
role_level: senior
focus: balanced
exclusions: [vendor/prompt-api-polyfill, dist, node_modules, generated]
pillar_overrides: none  # require 9/10 on all 12 pillars
pillars_below_target: [Pragmatism (8), Performance (8)]
---

## CODE EVALUATION (Senior bar) — 12 pillars across 3 lenses

### Aggregate scorecard

| Lens | Pillar | Score |
|------|--------|-------|
| Hire | Problem-Solution Fit | 9/10 |
| Hire | Architecture | 9/10 |
| Hire | Code Quality | 9/10 |
| Hire | Creativity | 9/10 |
| Stress | Pragmatism | **8/10** |
| Stress | Defensiveness | 9/10 |
| Stress | Performance | **8/10** |
| Stress | Type Rigor | 9/10 |
| Day 2 | Test Value | 9/10 |
| Day 2 | Reproducibility | 10/10 |
| Day 2 | Git Hygiene | 9/10 |
| Day 2 | Onboarding | 9/10 |

**Verdicts:** Hire = STRONG HIRE (A). Stress = SENIOR HIRE. Day 2 = TEAM LEAD MATERIAL.
**Below the 9/10 remediation gate:** Pragmatism (8), Performance (8). All others meet/exceed.

---

### HIRE — The Pragmatist (9/9/9/9)
One-line: a genuinely hard problem (on-device LLM in an MV3 sandbox, one shared session across tabs) solved with pure-core logic, unit-testable seams, and 3am-hardened failure handling.
- **Brilliance:** failure taxonomy `src/offscreen/failure.ts:49-124` (NETWORK vs TERMINAL signals, 4xx excluded from retry so a gated 403 advances the ladder); single serialized teardown+re-warm `src/session.ts:1499-1546`; docs-truth-enforcing tests `tests/docs-config.test.ts:36-49`.
- **Concern:** `src/session.ts` 1854-line `initSession` monolith — navigable but the file PRs will contend on at 10x growth.

### STRESS — The Oncall Engineer (8/9/8/9)
One-line: clearly been paged before; one teardown path leans on a caller contract rather than the gate that enforces every other concurrency rule.
- **Critical failure points (verified upheld today, but fragile):**
  1. `offscreen.ts:370-378` — `handleWarmup` tier-change teardown calls `previous?.destroy()` + nulls `sessionPromise` WITHOUT consulting `generationGate.busy`. Upheld only by caller contract (panel `reloadModel` early-returns while `activeAbort` set, ADR-P7; ladder advance recreates the doc). A future second warmup entry point would silently violate the single-load invariant.
  2. `offscreen.ts:331-336` — `handleCountTokens` calls `measureContextUsage` on the shared session without the gate; best-effort with client fallback limits blast radius to a wrong estimate.
- **Concern:** `stripThink` (`src/think-strip.ts:31`) full-buffer `indexOf` rescan per chunk → O(n²) over a long `<think>` block (the one render-loop hot path).

### DAY 2 — The Team Lead (9/10/9/9)
One-line: solo-authored but engineered as if a team already inherited it — drift-guarded docs, behavior-first tests, conventional history, sensible CI ordering.
- **Process wins:** the `docs/testing.md`↔disk drift-guard (`tests/docs-config.test.ts:21-49`); CI cheap-fails-first (lint → markdownlint → lychee → typecheck → coverage → build).
- **Maintenance drag:** `tests/session.test.ts` is ~118 KB / 128 cases in one file (well-sectioned but intimidating).
- Git Hygiene 9 ceiling is structural (single human author); Reproducibility 10 (.nvmrc, lockfile, CI provisions `.env.json` from example).

---

### REMEDIATION TARGETS (pillars < 9/10)

**Pragmatism (8 → 9):** Make the single-load invariant enforced by MECHANISM, not contract. Have `handleWarmup`'s tier-change teardown (`offscreen.ts:370`) and `handleCountTokens` (`offscreen.ts:331`) acquire/assert `generationGate` rather than trusting the caller, so a new entry point cannot reintroduce the v0.2.0 OOM. Files: `offscreen.ts`. Complexity: LOW (reuse `BusyGate`).

**Performance (8 → 9):** Strip only the delta region in `stripThink` instead of rescanning the whole accumulated buffer each chunk — eliminate the O(n²) tail on long reasoning output. Files: `src/think-strip.ts` (incremental variant), `src/session.ts:517-538` (carry offset). Must preserve split-marker-across-chunks correctness. Complexity: MEDIUM.

**At/above target (no remediation required):** Problem-Solution Fit, Architecture, Code Quality, Creativity, Defensiveness, Type Rigor, Test Value, Reproducibility, Git Hygiene, Onboarding. (Optional 10/10 stretch noted by evaluators: decompose the `initSession` monolith; split `tests/session.test.ts`; reword the stale heavy-load-duplication comment at `offscreen.ts:14-17`.)
