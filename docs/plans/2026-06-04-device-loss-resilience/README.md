# Plan: 0.4.3 Root-Cause WebGPU Device-Loss Resilience

## Overview

A user-reported ChromeOS repro surfaces a "no response" failure that 0.4.2
catches reactively but does not prevent: switch tabs, reopen the panel, send a
message, see "Loading model..." for ~10 seconds, then watch every send produce
an empty stream. The 0.4.2 fix renders "Generation failed" on the second empty
stream but does not stop the underlying WebGPU device from being lost in the
first place.

0.4.3 attacks the root cause across three complementary layers. (a) An
authoritative zero-chunk detector inside the offscreen stream handler converts
an empty stream into a typed terminal failure that the existing
`classifyFailure` recovery path handles, instead of relying on the panel side
to guess from the return value. (b) A `navigator.gpu` monkey-patch installed at
the top of the offscreen document captures the `GPUDevice` handle as it flows
through to the vendored polyfill, attaches a `device.lost` listener that marks
the offscreen session poisoned, pushes a `SESSION_POISONED` signal to the
service worker, and lazily rebuilds on the next `ENSURE_OFFSCREEN_REQUEST` so
the next user send runs on a healthy session. (c) A panel-pin port from the
content script to the service worker, plus a long-lived SW-to-offscreen pin
port, prevents Chrome's 30-second no-port reap from closing the offscreen
document while any panel is open, which eliminates the lifetime window the
device-loss bug needs.

0.4.2's panel-side empty-success retry stays in place as the outermost safety
net so any path that still slips through (e.g. a `device.lost` event that
never fires) surfaces a clear failure message rather than a silent "no
response".

## Prerequisites

- Node version pinned in `.nvmrc` (currently 20). Use `nvm use` before running
  any command.
- `npm ci` from a clean clone. The project uses npm.
- Familiarity with the offscreen-document architecture. Read `offscreen.ts`
  (repo root), `src/session.ts`, `src/background/offscreen.ts`,
  `src/offscreen/client.ts`, `src/offscreen/protocol.ts`,
  `src/offscreen/stream-client.ts`, `src/offscreen/dispatch.ts`,
  `src/offscreen/failure.ts`, `src/offscreen/busy-gate.ts`, and
  `src/offscreen/diagnostic.ts` before starting.
- `npm run typecheck`, `npx vitest run`, `npm run build`, and `npm run lint:ci`
  must pass clean on a fresh clone before any plan work begins. If they do
  not, stop and report.
- Read `Phase-0.md` in full first. It is the law for every later phase.

## Phase Summary

| Phase | Goal | Token Estimate |
| ----- | ---- | -------------- |
| 0 | Foundation: ADRs (4 open questions resolved), conventions, testing strategy | ~9,000 |
| 1 | Layer C: authoritative zero-chunk detection in offscreen stream handler + `classifyFailure` extension | ~22,000 |
| 2 | Layer A: `navigator.gpu` monkey-patch, `GPUDevice.lost` listener, poisoned-state push, lazy recovery on ensure | ~38,000 |
| 3 | Layer B: panel-pin port (content -> SW) and SW-pinned offscreen port to outlast Chrome's 30s reap | ~28,000 |
| 4 | Diagnostic `deviceLostAt` field, version bump 0.4.2 -> 0.4.3, CHANGELOG entry | ~12,000 |

Each phase leaves the build green and the extension usable on its own. Phase 1
ships defensible value alone (the panel will see typed failures instead of
silent empties). Phases 2, 3, 4 deepen the protection.

## Phase Sequencing Rationale

- **Phase 1 first.** It is the smallest, most isolated change (one offscreen
  handler edit + one classifier extension + a new wire string), with no SW or
  content-script coupling. Landing it first gives every later phase a typed
  signal to lean on.
- **Phase 2 next.** Captures the device handle and ships the poisoned-state
  recovery primitive. Depends on Phase 1's typed failure for the integration
  test that proves a `device.lost` event leads to a clean rebuild on the next
  send.
- **Phase 3 layers** the SW-pin port on top, which is purely a lifetime
  guarantee — it does not change any other behavior, but it slots cleanly
  above Phase 2 because Phase 2 already validated the SW-to-offscreen
  poisoned-state push pattern this phase mimics for its pin port.
- **Phase 4 closes** with the diagnostic field, the version bump, and the
  CHANGELOG entry. Version bump is intentionally last so a broken intermediate
  phase never ships a `0.4.3` build.

## What is out of scope

- Modifying `vendor/prompt-api-polyfill/` (hard constraint, decision 5).
- Passing a custom `GPUDevice` into ORT or Transformers.js.
- Proactive background rebuild on `device.lost` (rejected; decision 2).
- Always-pinned offscreen lifetime (rejected; decision 3).
- In-place ORT session rebuild without recreating the offscreen document.
- Removing the 0.4.2 panel-side empty-return retry (it is the outer safety
  net).
- A "model reloading" notice broadcast to open panels on device loss.
- A "cancel an in-flight load" affordance (separate ROADMAP item).
- WebGPU end-to-end CI testing. CI cannot exercise WebGPU; the real-device
  path is manual-smoke on the ChromeOS repro.
- Vision / multimodal capability.

## Navigation

- [Phase-0](./Phase-0.md) — Foundation, ADRs, conventions
- [Phase-1](./Phase-1.md) — Layer C: authoritative zero-chunk detection
- [Phase-2](./Phase-2.md) — Layer A: device.lost listener + poisoned-state recovery
- [Phase-3](./Phase-3.md) — Layer B: panel-pin lifetime extension
- [Phase-4](./Phase-4.md) — Diagnostic field + version bump + CHANGELOG
- [feedback.md](./feedback.md) — Reviewer feedback log
- [brainstorm.md](./brainstorm.md) — Source brainstorm
