---
type: repo-health
date: 2026-05-27
plan: 2026-05-27-audit-local-nano
goal: general health check (all 4 vectors)
deployment: static / client-side (Chrome MV3 extension)
scope: full repo (vendor/prompt-api-polyfill treated as upstream)
totals: { critical: 0, high: 0, medium: 4, low: 5 }
---

## CODEBASE HEALTH AUDIT

### EXECUTIVE SUMMARY
- **Overall health: EXCELLENT**
- **Biggest structural risk:** `src/session.ts` is a ~1854-line god module — `initSession` is a single ~1600-line closure owning history, selection, streaming, warmup, the ladder walk, three failure-bubble renderers, the gear popover, and the model picker.
- **Biggest operational risk:** None material. The hard safety constraints (single shared session, never-two-concurrent-loads, no auto-fail timer, MV3 SW-eviction-safe idle alarm) are explicitly engineered, serialized under one lock, and well-tested.
- **Total findings:** 0 critical, 0 high, 4 medium, 5 low.

Automated gates all green: `tsc --noEmit` clean, `biome check` clean (66 files), 565/565 tests pass, line coverage 95.32% (thresholds 75/80), `npm audit --omit=dev` = 0 production vulns. No `TODO`/`FIXME`/`@ts-ignore`/stray `console.log`.

### TECH DEBT LEDGER

#### CRITICAL — none
#### HIGH — none

#### MEDIUM

1. **[Structural]** `src/session.ts:242-1853` (`initSession` closure)
   - **Debt:** One function ~1600 lines holding ~20 pieces of mutable closure state (`activeAbort`, `warmStarted`, `modelReady`, `warmInFlight`, `reWarmInFlight`, `activeTier`, `currentModelId`, `pendingModelId`, …) plus the warmup ladder walk, stream lifecycle, three failure renderers, clipboard logic, and the full gear/popover/model-picker UI. ~3x the next-largest file.
   - **Risk:** The central coordination point for the two hardest invariants (never two concurrent loads; never tear down a live stream), enforced by interplay of far-apart closure flags. A future edit to one path can silently violate an invariant another path depends on; no type/test boundary separates them.

2. **[Operational]** `src/session.ts:1223-1228` (+ `content.ts:139` selectionchange, drag listeners)
   - **Debt:** `makeSettingsAffordance` registers a `mousedown` listener on `window.document` never removed; combined with the content script's other document-level listeners, every page (`<all_urls>`) gets permanent listeners whether or not the panel is opened.
   - **Risk:** Per-tab, page-wide listener overhead on every site; a `mousedown` handler fires on every click of every page (early-returns while popover closed). Documented as deliberate, but scales with tabs.

3. **[Hygiene]** `offscreen.ts:52-56`, `src/offscreen/protocol.ts:277-281`, `src/offscreen/ladder.ts:19-23`
   - **Debt:** The tier triple `{modelName, device, dtype}` is redeclared as `Tier` (ladder) and `WarmupTier` (protocol), converted by hand at `offscreen.ts:360-364` and session.ts call sites. Each redeclaration is documented-intentional (wire protocol owns its shape), but `Tier`↔`WarmupTier` are structurally identical.
   - **Risk:** A field addition to a tier must be made in 4+ places; a miss is a silent runtime-shape divergence the type system won't catch across the wire boundary.

4. **[Hygiene]** root `Screenshot 2026-05-24 *.png` (3 untracked files)
   - **Debt:** Three ~65-100 KB screenshots sit untracked in the repo root, referenced nowhere, not in `.gitignore`.
   - **Risk:** Working-tree noise; a stray `git add .` would commit dev-only binaries.

#### LOW

1. **[Operational]** `offscreen.ts:90, 214-223` — `rebuildSession()` nulls `sessionPromise` but leaves module-scoped `activeTier` stale. Currently benign (the destroy-guard's `sessionPromise && …` short-circuits to false post-rebuild), but latent: a future reorder of the guard could let the stale `activeTier` skip the OOM-prevention destroy.
2. **[Operational]** `package.json` dev deps — `npm audit` reports 6 moderate advisories, all in the `vitest → vite` dev chain. Dev/CI-only, zero production exposure; remediation needs a Vitest major bump.
3. **[Hygiene]** `src/session.ts:889-894, 1575-1576` — Several closure vars initialized to a default then overwritten async (`lastGpuInfo`, `currentModelId`/`pendingModelId = DEFAULT_MODEL_ID` overwritten by `syncPopoverFromPref`). Minor readability tax.
4. **[Structural]** `src/offscreen/client.ts:67-77` vs `src/background/offscreen.ts:263-269` — `streamPrompt`/`sendPrompt` declared in two files as near-identical thin wrappers over `streamOverPort` (differ only in injected `ensure` strategy). Genuinely shared logic already lives in `stream-client.ts`; these are 3-line per-context adapters (not dead).
5. **[Hygiene]** `src/offscreen/catalog.ts` `LARGER_ENTRY` — hardcoded placeholder id `onnx-community/LARGER-MODEL-PLACEHOLDER` + fabricated `~3 GB`. Gated off (`LARGER_MODEL_ENABLED=false`), never listed; documented placeholder seam.

### QUICK WINS
1. Add `Screenshot *.png` to `.gitignore` or delete the 3 stray files (< 5 min).
2. Reset `activeTier = null` in `offscreen.ts:rebuildSession()` alongside `sessionPromise = null` (pre-empts LOW-1) (< 15 min).

### AUTOMATED SCAN RESULTS
- **Dead code (knip):** all 11 "unused files" are false positives (3 esbuild entry points per build.mjs + the vendored polyfill); both "unused deps" (`@huggingface/transformers`, `onnxruntime-web`) are false positives (dynamic `import()` at offscreen.ts:126; ORT wasm copied to dist/ort by build.mjs). No genuine dead code.
- **Vulnerabilities:** 0 production, 6 moderate dev-only (vitest/vite).
- **Secrets:** `.env.json` gitignored, only `"apiKey": "dummy"`; no high-entropy strings.
- **Git hygiene:** `.gitignore` sensibly excludes node_modules/dist/coverage/.env.json/web-store/.claude; only gap is the 3 untracked screenshots.
- **Type escape hatches:** 16 `as unknown`/`as any`, all at the untyped polyfill/ONNX/`window.TRANSFORMERS_CONFIG` boundary (offscreen.ts: 6, client.ts: 6), none in pure domain logic.
