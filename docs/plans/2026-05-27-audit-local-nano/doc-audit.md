---
type: doc-health
date: 2026-05-27
plan: 2026-05-27-audit-local-nano
scope: all docs (README, docs/**, CHANGELOG, ROADMAP, PRIVACY); docs/plans/** assessed lightly
stack: js/ts
note: CI already runs markdownlint + lychee — do NOT add them; this audit is content drift/gaps/stale only
totals: { drift: 3, gaps: 1, stale: 1, broken_links: 0, stale_line_anchors: 8, structure: 2 }
---

## DOCUMENTATION AUDIT

### SUMMARY
- Docs scanned: 14 user-facing (README, PRIVACY, CHANGELOG, ROADMAP, docs/{architecture, chrome-web-store, configuration, contributing, development, models, privacy, prompt-api, testing, transform}) + docs/plans/** (light).
- Findings: 3 drift, 1 gap, 1 stale recommendation, 0 broken internal links, ~8 stale line-ref anchors, 1 config off-by-2.

### DRIFT (doc ≠ code)

1. **HIGH — `CHANGELOG.md:15` → `src/offscreen/catalog.ts`** — The 0.4.0 "Curated model catalog" entry says **"Two live entries — gemma-4-E2B + Qwen2.5-0.5B"** and names gate flags **`QWEN3_08B_ENABLED`, `LARGER_MODEL_ENABLED`**. The shipped catalog has **THREE live entries** (Qwen2.5-0.5B, **Qwen3-0.6B**, gemma-4-E2B) and **`QWEN3_08B_ENABLED` does not exist** (only `LARGER_MODEL_ENABLED` in catalog.ts + `SMALLER_MODEL_ENABLED` in ladder.ts). ROADMAP.md correctly says "3 live models" — the CHANGELOG is the outlier. *(Confirmed by orchestrator: the CHANGELOG 0.4.0 entry was written before the catalog finalized and never updated.)*
2. **LOW — `docs/configuration.md:90`** — claims the polyfill reads `apiKey` at `prompt-api-polyfill.js:189`; actual line is **191** (quoted code correct; off-by-2).
3. **LOW — `docs/architecture.md` & `docs/prompt-api.md`** — ~8 stale numeric `offscreen.ts:NN` / `session.ts:NN` line anchors (prose/literals still accurate, anchors drifted): dynamic import `:76-79`→**126-127**; TRANSFORMERS_CONFIG `:83`→**132**; SYSTEM_INSTRUCTION `:59`→**80**; `heavyPromise=null :93`→**142**; `sessionPromise=null :127`→**200**; `Loading model… 0s session.ts:682-690`→**1269/1282**.

### GAPS (code exists, no doc)

1. **HIGH — the entire 0.4.0 user-facing feature set is undocumented in prose.** `grep "picker"/"gear"` returns nothing in README/configuration/architecture/development/transform. The shipped **model picker / gear popover** (`catalog.ts`, `model-pref.ts`), **idle resource release** (`idle-policy.ts`, `alarms` permission, 5/15/60/Never default 15), and **`<think>` stripping** (`think-strip.ts`) appear only in CHANGELOG/ROADMAP. README "Using it" + "Configuration" still describe a model fixed by `.env.json` with no mention of the gear popover or idle timeout. `docs/architecture.md`'s "What lives where" table and `docs/development.md:60`'s `src/offscreen/` list omit 9 of the 14 modules now in that directory (catalog, ladder, model-pref, idle-policy, capability, capability-store, diagnostic, think-strip, …).

### STALE (doc recommends code/model that no longer works)

1. **HIGH — `docs/configuration.md:29`** — still lists `onnx-community/Qwen3.5-0.8B-ONNX` as a recommended `modelName`. `docs/models.md` and ROADMAP now document this exact model as REJECTED (it's `Qwen3_5ForConditionalGeneration` with a `vision_config` — a vision-language model the text-only polyfill cannot load). The configuration.md recommendation directly contradicts the field-guide finding and would send a user to a model that fails to load.

### STRUCTURE / MINOR

1. **`docs/transform.md:45,57-58,108`** — version-stale: "Out of scope (queued for v0.3.0)", "the project is now on 0.2.4", a "v0.3.0 follow-ups" list. Project is on **0.4.0**; the scope limits still hold (selection-rewrite.ts still excludes inputs/contenteditable) — only the version labels are stale.
2. **`README.md:44`** — "This isn't on the Chrome Web Store" vs ROADMAP.md "v0.3.0 is on the Web Store" + existing `web-store/local-nano-v0.4.0.zip`. **Low-confidence** (live listing state not verifiable from the repo); pin one source of truth.
3. **LOW gap — the `alarms` permission** (added 0.4.0) is not explained in `PRIVACY.md` / `docs/privacy.md`, and is omitted from `docs/chrome-web-store.md:33-36` permission justifications.

### VERIFIED ACCURATE (no action)
- README install/dev steps ↔ package.json scripts (build/watch/typecheck/test/coverage/icons/package) all match.
- manifest permissions `["storage","offscreen","alarms"]` + HF host_permissions covered by privacy docs (except `alarms`, above).
- `docs/configuration.md:49` fallback-ladder order matches `PRIMARY_LADDER`.
- `docs/models.md` TL;DR + catalog (gemma default, Qwen2.5 wasm-only, Qwen3-0.6B small-WebGPU) matches catalog.ts/ladder.ts exactly.
- `docs/testing.md` test-file table complete (25 files), self-policed by the `tests/docs-config.test.ts` drift-guard.
- `prompt-api.md` polyfill claims (contextWindow 131072, max_new_tokens 2048, backends registered) verified against vendored source; its polyfill line-refs are accurate (only offscreen.ts/session.ts anchors drifted).
- No broken internal markdown links anywhere.
