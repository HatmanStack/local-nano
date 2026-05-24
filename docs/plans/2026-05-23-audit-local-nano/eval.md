---
type: repo-eval
target: 9
role_level: Senior Developer
date: 2026-05-23
pillar_overrides: {}
  # None — require 9/10 on all 12 pillars
---

# Repo Evaluation: local-nano

## Configuration
- **Role Level:** Senior Developer — production-hardened patterns, defensive coding, observability, performance awareness, type rigor
- **Focus Areas:** Balanced across all (Performance, Security, Testing, Architecture) — none weighted above the others
- **Exclusions:** node_modules, dist, coverage, vendor, well_done.jpg, package-lock.json (standard)

## Combined Scorecard

| # | Lens | Pillar | Score | Target | Status |
|---|------|--------|-------|--------|--------|
| 1 | Hire | Problem-Solution Fit | 9/10 | 9 | PASS |
| 2 | Hire | Architecture | 9/10 | 9 | PASS |
| 3 | Hire | Code Quality | 9/10 | 9 | PASS |
| 4 | Hire | Creativity | 8/10 | 9 | NEEDS WORK |
| 5 | Stress | Pragmatism | 8/10 | 9 | NEEDS WORK |
| 6 | Stress | Defensiveness | 7/10 | 9 | NEEDS WORK |
| 7 | Stress | Performance | 6/10 | 9 | NEEDS WORK |
| 8 | Stress | Type Rigor | 8/10 | 9 | NEEDS WORK |
| 9 | Day 2 | Test Value | 9/10 | 9 | PASS |
| 10 | Day 2 | Reproducibility | 9/10 | 9 | PASS |
| 11 | Day 2 | Git Hygiene | 10/10 | 9 | PASS |
| 12 | Day 2 | Onboarding | 8/10 | 9 | NEEDS WORK |

**Pillars at target (≥9):** 6/12
**Pillars needing work (<9):** 6/12
**Lowest:** Performance at 6/10

## Hire Evaluation — The Pragmatist

### VERDICT
- **Decision:** STRONG HIRE
- **Overall Grade:** A
- **One-Line:** A disciplined engineer who treats a hobby browser extension like production software — defensive boundaries, honest comments about what's deferred, and tests that exercise the gnarly async/DOM paths rather than the trivial ones.

### SCORECARD
| Pillar | Score | Evidence |
|--------|-------|----------|
| Problem-Solution Fit | 9/10 | `package.json:28-30` — exactly 2 runtime deps (transformers + onnxruntime); `manifest.json:11` — minimal permissions (`storage`, `offscreen` only), host perms scoped to HF CDN only (`manifest.json:15-19`) |
| Architecture | 9/10 | `src/offscreen/stream-client.ts:43-48` — transport injected via `ensure` callback so SW and content-script share one port implementation with zero per-context branching; `offscreen.ts:104-120` — single long-lived session singleton shared across tabs |
| Code Quality | 9/10 | `src/offscreen/protocol.ts:128-141` — runtime type guards validate every cross-context message field including `Number.isFinite` checks; `src/session.ts:340-353` — finally-block cleanup is single-point and idempotent. Zero `any`, zero `TODO/FIXME` in source |
| Creativity | 8/10 | `src/selection-rewrite.ts:268-288` — tri-state `SnapshotDecision` (`set`/`clear`/`ignore`) that fixed a real focus-clobber bug a naive `T \| null` would hide; `src/session.ts:619-681` — warmup uses a live elapsed counter instead of a hard timeout because a slow multi-GB download is healthy, not a failure |

### HIGHLIGHTS

- **Brilliance:**
  - **Comments encode decisions, not narration.** `offscreen.ts:14-17` documents that a `src/heavy.ts` shared helper was *tried and reverted*, so the duplication is intentional. `src/session.ts:220-226` openly flags the `isFirstTurn` cross-URL continuity gap as a known follow-up rather than hiding it.
  - **Defensive boundaries are consistent.** Every cross-context reply is validated by a type guard before use (`src/offscreen/client.ts:104, 171, 209`), and degradation is graceful — `countTokens` (`client.ts:79-128`) races the round-trip against a 100ms timeout and falls back to `length/3`. `getGpuInfo` (`client.ts:193-225`) resolves to a documented conservative shape on *any* failure path instead of rejecting.
  - **Tests target the hard paths.** 207 tests across 13 files. The `FakePort` harness (`tests/setup.ts:33-90`) drives the offscreen side of streaming, abort, and disconnect; `session.test.ts` is 1208 lines covering history-pressure thresholds, GPU-derived sizing, and Clear-conversation.
  - **Streaming lifecycle is leak-free.** `stream-client.ts:57-66` has a `settled` guard and single `cleanup()`; the offscreen reader loop (`offscreen.ts:300-317`) releases the lock in `finally` and aborts generation if the caller disconnects mid-stream.

- **Concerns:**
  - **DOM rewrite trusts model output as text only (correct, but worth naming).** `selection-rewrite.ts:349` does `target.data += chunk` on a `Text` node (never `innerHTML`). Residual risk is UX: a partial stream that errors mid-rewrite leaves the page mutated, and `finalize()` (`:352-354`) is a documented no-op rather than a commit/rollback gate.
  - **`offscreen.ts` is the one file approaching "too much in one place"** (355 lines hosting heavy-module loading, three `onMessage` channels, GPU introspection, and the stream port). First thing that strains under 10x feature growth.
  - **In-memory chat history vs. polyfill context diverge by design** (`session.ts:220-226, 495-510`). Documented, but the sharpest "this would confuse a new teammate" edge.
  - **`biome.json` sets `noExplicitAny: off`** while the source contains zero `any` — the rule is disabled defensively rather than because it's needed (the only `as any` is `tests/setup.ts:115` for the global chrome mock).

### REMEDIATION TARGETS

- **Creativity (current: 8/10 → target: 9/10)** — Solid pragmatic ingenuity; what keeps it from a 9 is that the cleverness is reactive (each smart bit traces to a documented prior bug) rather than anticipatory.
  - To raise it: address the documented `isFirstTurn` cross-URL gap (`session.ts:220-226`) by unifying the persisted per-URL log with the polyfill seed via the *already-existing* `rebuildSession(history)` plumbing (`offscreen.ts:129-138`).
  - Files: `src/session.ts:160-164, 555-586`, `offscreen.ts:88-102`.
  - "9/10" looks like: opening the panel on a new URL restores *and* re-seeds the model with that URL's history, closing the documented continuity gap.
  - Estimated complexity: MEDIUM
- Problem-Solution Fit / Architecture / Code Quality already at bar (9/10); no action required. Optional Code Quality → 10: add mid-stream-failure rollback to the rewrite path (`selection-rewrite.ts:352-386`, `session.ts:442-471`) and re-enable `noExplicitAny`.

## Stress Evaluation — The Oncall Engineer

### VERDICT
- **Decision:** SENIOR HIRE
- **Seniority Alignment:** Meets the senior bar. The defensive posture is unusually mature for a browser-extension/LLM project: every cross-context boundary is type-guarded, every async handler has an error branch that reports rather than throws, and the git history shows real production scars (SIGILL on q4 kernels, GPU-OOM, hung loads) addressed deliberately.
- **One-Line:** This won't page me at 3am for a crash — it'll page me (if at all) for a runaway background generation or a two-tab race on the shared session, both latent rather than hit on the happy path.

### SCORECARD
| Pillar | Score | Evidence |
|--------|-------|----------|
| Pragmatism | 8/10 | `offscreen.ts:14-18` — deliberate, documented duplication of the heavy-load pattern (reverted `heavy.ts` extraction); `src/session.ts:69-100` — capability-derived thresholds are real engineering, not gold-plating |
| Defensiveness | 7/10 | `src/offscreen/client.ts:193-225` — `getGpuInfo` resolves conservative instead of rejecting; `offscreen.ts:329-342` — stream errors keep the session alive and report. But abort doesn't stop the underlying ONNX generation (`vendor/.../transformers.js:227-248` + polyfill `:952-959`) |
| Performance | 6/10 | `content.ts:155` / `src/pageContext.ts:8` — `document.body.innerText` (forced reflow) + full-string `.replace(/\s+/g,' ')` before `.slice`; single shared session with no concurrency serialization (`offscreen.ts:104-120`, `:269`) |
| Type Rigor | 8/10 | `src/offscreen/protocol.ts` — every wire message has a runtime type guard validating shape AND finiteness (`:128-141`); discriminated unions on `ok` everywhere; `as unknown` confined to unavoidable Chrome/polyfill FFI boundaries (`offscreen.ts:69-71`) |

### CRITICAL FAILURE POINTS
None crash on the happy path. The following are latent but real:

- **Abort does not stop generation** — `vendor/prompt-api-polyfill/prompt-api-polyfill.js:952-959` breaks the *consumer* loop and calls `stream.return()`, but the backend's `generationPromise` (`vendor/.../backends/transformers.js:227-231`) was launched with no `AbortSignal`/`StoppingCriteria` and runs to `max_new_tokens: 2048` (`transformers.js:150`) in the background. Pressing "Stop" frees the UI but the GPU keeps grinding. On a constrained device, hammering Stop+Send spawns overlapping full-length generations — the exact OOM the threshold machinery exists to prevent.
- **No serialization of the shared session** — `offscreen.ts:104-120` is a single `sessionPromise` singleton, intentionally shared across tabs. `onConnect` (`:269`) accepts any number of ports, each calling `session.promptStreaming` concurrently. The polyfill has no busy/queue lock and mutates shared `#history` (`prompt-api-polyfill.js:990-996`). Two tabs streaming at once interleave on one ONNX generator and corrupt each other's history.
- **Polyfill `contextWindow` is hardcoded to 1,000,000** (`prompt-api-polyfill.js:103-105` — verified, returns a literal `1000000`) while the model's real context window is ~128K tokens (per the Hugging Face model card for `gemma-4-E2B-it-ONNX`). The polyfill's overflow guard (`:712`, `:913`) does work, but only triggers above 1,000,000 tokens — far above the model's real ~128K limit — so it does not protect at the real boundary. Practical protection against a too-long session rests on the app's char-count heuristic warning (`src/session.ts:521`), which is advisory and self-suppressing after one fire. *(Corrected 2026-05-23: the original finding stated the real window was "~8–32k" and called the guard "never fires / dead code"; both were wrong — the real window is ~128K and the guard fires above 1M.)*

### HIGHLIGHTS
- **Brilliance:**
  - The protocol layer (`src/offscreen/protocol.ts`) is textbook: discriminated unions keyed on `ok`, runtime guards that check `Number.isFinite` not just `typeof` (`:135-136`), and 53 dedicated guard tests.
  - `countTokens` (`src/offscreen/client.ts:79-128`) races the round-trip against a 100ms timeout and degrades to a heuristic — a transform never blocks on a slow tokenizer.
  - The warmup rewrite (`src/session.ts:619-681`) is hard-won: no hard timeout, a live elapsed counter as proof-of-life, single `clearInterval` cleanup point, and `warmStarted` reset on failure.
  - `decideSnapshot` tri-state (`src/selection-rewrite.ts:268-288`) is a sharp type-design call. `undoRewrite` checks `isConnected` before mutating (`:375`) and uses a `WeakSet` for idempotency (`:55`, `:366`).
- **Concerns:**
  - The history-pressure estimator (`src/session.ts:521`) divides chars by 3 and fires once — a guess layered on a polyfill whose quota guard only triggers above 1M tokens (well above the model's real ~128K window), so the heuristic is effectively the only practical guard.
  - `isFirstTurn` page-context prefix is only applied once per content-script lifetime and is explicitly known-broken across URL changes (`src/session.ts:220-225`).
  - `loadHistory` (`src/history.ts:8-12`) trusts `chrome.storage` shape with a bare `Array.isArray` cast — entries aren't validated per-element.

### REMEDIATION TARGETS

- **Performance (current: 6/10 → target: 9/10)**
  - **What:** (1) Serialize generation on the shared session — add a busy-gate/queue in `offscreen.ts onConnect` (`:269`) so a second port's `stream/request` either rejects with a clear "busy" error or queues, rather than calling `promptStreaming` mid-generation. (2) Reduce page-context cost: `src/pageContext.ts:8` runs `.replace(/\s+/g,' ')` over the *entire* `innerText` before slicing to 1500 — slice first (bounded by a generous raw cap), then normalize.
  - **Files:** `offscreen.ts:269-353`, `src/pageContext.ts:8`, `content.ts:155`.
  - **9/10 looks like:** concurrent streams impossible-by-construction (or cleanly rejected); page-context extraction bounded regardless of page size.
  - **Complexity:** MEDIUM (serialization) / LOW (pageContext)
- **Defensiveness (current: 7/10 → target: 9/10)**
  - **What:** Make Stop actually stop generation, not just the consumer. The polyfill's `generateContentStream` (`vendor/.../backends/transformers.js:197-272`) needs to thread an `AbortSignal` into the transformers.js `generator(prompt, {...})` call via `stopping_criteria` / the signal. The offscreen side already has the `AbortController` (`offscreen.ts:285`); it dies at the polyfill boundary.
  - **Files:** `vendor/prompt-api-polyfill/backends/transformers.js`, `vendor/prompt-api-polyfill/prompt-api-polyfill.js:952`.
  - **9/10 looks like:** clicking Stop returns the GPU to idle within one decode step; rapid Stop+Send cannot stack concurrent generations.
  - **Complexity:** MEDIUM
- **Pragmatism (current: 8/10 → target: 9/10)**
  - **What:** The dead `contextWindow: 1_000_000` guard means the app reimplements overflow protection as a fuzzy char heuristic. Either set the polyfill's `contextWindow` to the model's real value so its overflow event (`:894-898`, `:913`) becomes meaningful, or wire the app's pressure check to `session.measureContextUsage` (real token count) instead of `cumulativeSentChars/3` (`src/session.ts:520-522`).
  - **Files:** `vendor/.../prompt-api-polyfill.js:103`, `src/session.ts:508-530`.
  - **9/10 looks like:** the OOM warning is driven by actual tokenizer counts, not a divide-by-3 estimate.
  - **Complexity:** MEDIUM
- **Type Rigor (current: 8/10 → target: 9/10)**
  - **What:** Validate persisted history per-element in `loadHistory` (`src/history.ts:8-12`) the same way the wire protocol validates messages — a guard confirming each entry has a valid `role ∈ {user,model,system}` and string `text`, dropping malformed entries.
  - **Files:** `src/history.ts:8-12`.
  - **9/10 looks like:** a corrupted/schema-drifted storage blob can never render a malformed bubble.
  - **Complexity:** LOW

## Day 2 Evaluation — The Team Lead

### VERDICT
- **Decision:** TEAM LEAD MATERIAL
- **Collaboration Score:** High
- **One-Line:** A small extension with the process discipline of a much larger team — behavior-first tests, root-cause commit narratives, and honest docs mean a junior could ship a PR on day one.

### SCORECARD
| Pillar | Score | Evidence |
|--------|-------|----------|
| Test Value | 9/10 | `tests/session.test.ts:376-395` ("degrades silently on a warmup failure") and `tests/selection-rewrite.test.ts:347-361` assert observable behavior with real DOM ranges, not implementation. 207 tests, 13 files, zero `*.skip`/`expect(true)` placeholders. `tests/docs-config.test.ts:15` even guards docs against config drift. |
| Reproducibility | 9/10 | `package.json` scripts cover build/test/typecheck/lint/coverage/package; `package-lock.json` committed; `.github/workflows/ci.yml` runs lint→mdlint→linkcheck→typecheck→coverage→build in order; `vitest.config.ts:16-21` enforces 75/80% thresholds. Verified: `npm test` = 207 pass in 1.71s, `npm run build` ~160ms. |
| Git Hygiene | 10/10 | `git log` shows clean Conventional Commits (`feat(warmup):`, `fix(config):`); 75/82 subjects conform, the 7 exceptions are merges + legitimate genesis commits. `22eb999` root-causes a SIGILL to an upstream ONNX kernel with repro and fallback plan. No WIP/fixup/junk commits. |
| Onboarding | 8/10 | `README.md:42-61` gives exact clone→build→load-unpacked steps with the keyboard shortcut; `docs/contributing.md:37` explains *why* the polyfill stays trimmed (privacy); `docs/development.md` has a debugging section and project-layout map. Single-author bus factor (78 commits HatmanStack / 1 CJ) is the main drag. |

### RED FLAGS
- **Bus factor of one.** `git shortlog -sn --no-merges` = 78 HatmanStack, 1 CJ. All architectural "why" lives in commit bodies and docs. Mitigated by the rich written record, but a single point of knowledge.
- **No automated E2E for a browser extension.** `docs/testing.md:12` openly chooses unit-only and relies on "manual smoke tests." The WebGPU/offscreen integration — the riskiest surface — is verified only by hand.
- **No pre-commit hooks.** No husky/lefthook/pre-commit; contributors must remember to run typecheck/coverage/build before pushing. CI catches it, but the local loop is unguarded.

### HIGHLIGHTS
- **Process Win:** The CHANGELOG and commit bodies are a debugging diary. `CHANGELOG.md:8` explains the GPU-OOM guard *removal* with reasoning; `22eb999`'s body documents a SIGILL root-cause + fallback dtypes. A new hire inherits the decision history.
- **Maintenance Drag:** `docs/testing.md:16-24` lists only 7 test files but the suite has 13 — `selection-rewrite.test.ts`, the three `offscreen-*` files, and `stream-client.test.ts` are missing from the table. The doc-vs-config drift test exists for `.env.json` but nothing guards this table.

### REMEDIATION TARGETS

- **Onboarding (current: 8/10 → target: 9/10)**
  - What to change: Lower bus-factor risk by capturing the offscreen/service-worker/content-script message-flow in `docs/architecture.md` as a diagram a junior can trace, and add a 5-minute "first PR" walkthrough to `docs/contributing.md`.
  - Files: `docs/architecture.md`, `docs/contributing.md`, and a freshness guard — extend `tests/docs-config.test.ts` to assert `docs/testing.md`'s table lists every `tests/*.test.ts` file.
  - What 9/10 looks like: a second contributor can navigate the offscreen↔content protocol without reading every commit body, and the testing doc cannot silently fall out of date.
  - Estimated complexity: MEDIUM
- Test Value / Reproducibility / Git Hygiene at target. Optional nits: shared fixture helper for `tests/session.test.ts:31` mock-reset pattern; point CI `setup-node` at `node-version-file: .nvmrc` (currently hardcoded `20` while local ran `v24.15.0`).

## Consolidated Remediation Targets

Prioritized (lowest score first, overlapping findings consolidated):

1. **Performance 6/10 → 9** [MEDIUM/LOW] — Serialize generation on the shared offscreen session (`offscreen.ts:269-353`); slice-before-normalize in page-context extraction (`src/pageContext.ts:8`, `content.ts:155`).
2. **Defensiveness 7/10 → 9** [MEDIUM] — Thread `AbortSignal`/`stopping_criteria` through the polyfill so Stop halts ONNX decoding, not just the consumer loop (`vendor/.../backends/transformers.js`, `prompt-api-polyfill.js:952`). Validate persisted history per-element (`src/history.ts:8-12`) — *also closes Type Rigor.*
3. **Type Rigor 8/10 → 9** [LOW] — Per-element validation in `loadHistory` (`src/history.ts:8-12`); re-enable `noExplicitAny` in `biome.json` with one scoped ignore.
4. **Pragmatism 8/10 → 9** [MEDIUM] — One source of truth for context size: drive the OOM warning from `measureContextUsage` real token counts or set the polyfill's real `contextWindow` (`prompt-api-polyfill.js:103`, `src/session.ts:508-530`).
5. **Creativity 8/10 → 9** [MEDIUM] — Close the `isFirstTurn` cross-URL gap by wiring `restore()` to re-seed the model via the existing `rebuildSession(history)` plumbing (`src/session.ts:160-164, 555-586`, `offscreen.ts:88-138`).
6. **Onboarding 8/10 → 9** [MEDIUM] — Message-flow diagram in `docs/architecture.md`, "first PR" walkthrough in `docs/contributing.md`, and extend `tests/docs-config.test.ts` to guard the testing-doc table against drift.

**Cross-cutting note:** Several Performance/Defensiveness/Pragmatism fixes touch the vendored polyfill (`vendor/prompt-api-polyfill/`) and the single-shared-session design in `offscreen.ts` — these are intentional architectural decisions documented in code comments, so remediation should preserve the documented rationale rather than revert to extracted helpers.
