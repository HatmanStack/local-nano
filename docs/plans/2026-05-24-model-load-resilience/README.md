# Plan: Model-Load Resilience (ROADMAP #1-#5)

## Overview

`local-nano` loads one shared `LanguageModel` session in an offscreen document
and shares it across tabs. Today that load path has three release-blocking
gaps: it can die silently (the service worker caches a sticky `documentReady`
boolean and never re-checks once the offscreen document crashes), warmup
failures degrade quietly to lazy loading (the user first learns of trouble on
send), and the only load feedback is an elapsed-seconds counter with no real
progress, no recovery, and no capability awareness.

This plan reshapes the load path into a resilient state machine across five
sequential, individually-shippable phases. On a model-LOAD failure the system
auto-walks a fallback ladder (dtype/device tiers within the chosen model, then a
smaller model, then a graceful terminal stop). The model is chosen up front by
device capability so weak devices never download a model they cannot run.
First-run load shows phased progress (a real download percentage, then an
indeterminate "loading into GPU" phase). When the ladder is exhausted the panel
proactively shows an actionable terminal message with a manual Retry that
force-recreates the crashed offscreen document. A rich, copy-only diagnostic is
always available and embedded in failure messages.

The hard line from the seed is preserved: automatic recovery happens only at
LOAD time. A mid-stream or terminal RUNTIME crash never triggers an automatic
rebuild (the removed zero-chunk auto-rebuild guard stays removed). Recovery
there is manual only.

## Prerequisites

- Node version pinned in `.nvmrc` (currently 20). Use `nvm use` before running
  commands.
- `npm ci` from a clean clone. The project uses npm, not pnpm or yarn.
- Familiarity with the offscreen-document architecture. Read `offscreen.ts`
  (repo root), `src/session.ts`, `src/background/offscreen.ts`,
  `src/offscreen/client.ts`, `src/offscreen/protocol.ts`,
  `src/offscreen/stream-client.ts`, `src/offscreen/dispatch.ts`, and
  `src/offscreen/busy-gate.ts` before starting.
- `npm run typecheck`, `npm test -- --run`, `npm run build`, and
  `npm run lint:ci` must pass clean on a fresh clone before any plan work
  begins. If they do not, stop and report.
- Read `Phase-0.md` in full first. It is the law for every later phase.

## Phase Summary

| Phase | Goal | Token Estimate |
| ----- | ---- | -------------- |
| 0 | Foundation: ADRs, conventions, polyfill constraints, testing strategy | ~9,000 |
| 1 | Lifecycle gate: terminal-crash detection, force-recreate, manual Retry, minimal diagnostic | ~55,000 |
| 2 | Fallback ladder: dtype/device tiers within a model, single-session destroy-then-create, tier persistence | ~60,000 |
| 3 | Capability-based model selection + smaller-model ladder rung (model identity gated behind a flag) | ~50,000 |
| 4 | Phased first-run progress (download % then indeterminate GPU-load), offscreen to panel relay, network-failure messaging | ~50,000 |
| 5 | Rich always-available copy-only diagnostic embedded in failure messages | ~35,000 |

Each phase leaves the build green and the extension usable. Phase 1 is the
release gate and is independently shippable; later phases build on it.

## Phase Sequencing Rationale

- **Phase 1 first.** The #1 lifecycle gate (detect terminal crash, recover via
  force-recreate, surface a terminal message proactively at warmup) is the
  release gate and stands alone. It removes the silent-death failure mode
  without depending on any of the later phases.
- **Phase 2 next.** The fallback ladder needs the recreate primitive from
  Phase 1 to recover between rungs that may crash the document. It also
  introduces the runtime tier override and per-device tier persistence.
- **Phase 3** layers capability-based upfront model selection and the
  smaller-model rung on top of the ladder. The actual second model identity is
  gated behind a flag pending manual WebGPU vetting (CI cannot test WebGPU).
- **Phase 4** adds phased download progress through the polyfill `monitor`
  option, relayed offscreen to panel, plus distinct network-failure messaging.
- **Phase 5** generalizes the minimal diagnostic from Phase 1 into a rich,
  always-available, copy-only affordance embedded in failure messages.

## What is out of scope

- ROADMAP #6 (manual cross-env test matrix), #7 (repo audit, stable-vs-dev ORT
  decision, version bump/tag/package), #8 (store compliance). Separate vehicles.
- Any automatic rebuild after a mid-stream or terminal RUNTIME crash.
- Patching the vendored polyfill internals.
- Image input/output (text-only build).
- More than one concurrent `LanguageModel` session.
- Shipping an unvetted smaller model as the live default (Phase 3 lands the
  hook and plumbing; the live model identity is a flagged follow-up task).

## Navigation

- [Phase-0](./Phase-0.md) — Foundation, ADRs, conventions
- [Phase-1](./Phase-1.md) — Lifecycle gate (release gate)
- [Phase-2](./Phase-2.md) — Fallback ladder + tier persistence
- [Phase-3](./Phase-3.md) — Capability model selection + smaller-model rung
- [Phase-4](./Phase-4.md) — Phased first-run progress
- [Phase-5](./Phase-5.md) — Rich copy-only diagnostic
- [feedback.md](./feedback.md) — Reviewer feedback log
- [brainstorm.md](./brainstorm.md) — Source brainstorm
