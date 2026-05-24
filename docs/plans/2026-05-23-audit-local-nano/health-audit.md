---
type: repo-health
date: 2026-05-23
goal: General health check
---

# Codebase Health Audit: local-nano

## Configuration
- **Goal:** General health check — scan all 4 debt vectors equally
- **Scope:** Full repo, no constraints
- **Existing Tooling:** Biome (lint + format, `biome.json`), TypeScript strict typecheck (`tsc --noEmit`), Vitest + v8 coverage (75/80% gate), GitHub Actions CI (`.github/workflows/ci.yml`) running lint → markdownlint → lychee link-check → typecheck → coverage → build, dependabot auto-merge. Partial: no pre-commit hooks.
- **Constraints:** None
- **Deployment target:** Local/desktop — Chrome browser extension running local LLM inference (no server). Operational debt framed around client-side concerns: model load failures, device-capability handling, memory/GPU constraints, message-passing across extension contexts.

## Summary
- Overall health: **GOOD**
- Total findings: **0 critical, 3 high, 8 medium, 7 low**
- Biggest structural risk: The `sendChat`/`sendAsk`/`sendRewrite` paths in `src/session.ts` are near-identical 60–80 line copies of the same stream-render-finalize lifecycle, so any bugfix must be applied three times by hand.
- Biggest operational risk: Three separate `chrome.runtime.onMessage.addListener` callbacks in `offscreen.ts` each return `false` for unrecognized messages — the MV3 multi-listener footgun where a non-matching async listener can race the channel and drop `sendResponse`.

## Tech Debt Ledger

### CRITICAL
None.

### HIGH

1. **[Operational]** `offscreen.ts:212-223`, `225-243`, `248-267`
   - **The Debt:** Three independent `onMessage` listeners are registered. Each does `if (!isXRequest(msg)) return false;` and returns `true` only when it owns the message. This is the MV3 multi-listener / `sendResponse` race: with several listeners on the same event, Chrome keeps the channel open only if *some* listener returns `true` synchronously, and mixed sync-`false`/async-`true` returns across multiple listeners are fragile (only one listener may call `sendResponse`, and a `false`-returning listener running after the async one can close the port early). The GPU-info / count-tokens / rebuild handlers are siblings that could interfere; consolidating into one dispatcher would be safer.
   - **The Risk:** Intermittent "malformed reply from offscreen" / dropped responses that are nearly impossible to reproduce, manifesting as spurious warmup or token-count failures on some Chrome builds.

2. **[Structural]** `src/session.ts:291-353` (`sendChat`), `356-408` (`sendAsk`), `410-472` (`sendRewrite`)
   - **The Debt:** Three functions duplicate the same scaffold: `addMessage('user', …)` → create response bubble + typing indicator → `new AbortController()` → `setGeneratingState` → identical `onChunk` first-chunk handling → identical `try/catch (AbortError vs message)` block → identical `finally` (remove indicator, empty-response fallback, push model entry, persist, `setIdleState`, clear `activeAbort`, `i.focus()`). The catch and finally blocks are byte-for-byte copies across all three.
   - **The Risk:** Divergence bugs — `sendChat` already carries first-turn/warmup logic the others lack, and `recordSentTurn` is called in subtly different places (always in chat, gated on `askSucceeded`/`succeeded` in the others). A fix to one path silently leaves the other two stale.

3. **[Hygiene]** `src/system.ts:1-5` + `tests/system.test.ts`
   - **The Debt:** `src/system.ts` exports `SYSTEM_INSTRUCTION` (a rich, webpage-aware system prompt) that is imported by **nothing in production** — only by `tests/system.test.ts`. The system prompt actually used by the model is a *different, terser* string hardcoded in `offscreen.ts:55` (`'You are a helpful assistant. Answer concisely and directly.'`). The module is dead code, and its test gives false confidence that a webpage-aware instruction ships.
   - **The Risk:** The test asserts the prompt "mentions webpage," but the live model never receives that instruction. Dead module + misleading test coverage.

### MEDIUM

4. **[Hygiene]** `web-store/local-nano-v0.2.3.zip` (19 MB, **untracked** local artifact)
   - **The Debt:** A 19 MB built store artifact sits in the working tree. It is **not** committed — `git ls-files web-store/` returns nothing and `git check-ignore` confirms `.gitignore:16` (`web-store/`) ignores it. It is also stale (v0.2.3 vs current 0.2.4).
   - **The Risk:** Low — local-only clutter, not in git history. Worth deleting to avoid confusion, but there is no repo-bloat or history problem here. *(Corrected 2026-05-23: the original finding claimed this was committed/baked into history; it is not.)*

5. **[Operational]** `src/history.ts:16-19` + `src/session.ts:154-158`
   - **The Debt:** `saveHistory` writes to `chrome.storage.local` with no handling for `QUOTA_BYTES` limits. History is capped at 200 entries (`MAX_HISTORY`) but each entry is unbounded in length, with no per-key byte check or `getBytesInUse` guard. A failed write only `console.error`s.
   - **The Risk:** On pages with large turns, `storage.local.set` can reject with a quota error that is logged but never surfaced; history silently stops persisting.

6. **[Hygiene]** `content.ts`, `background.ts`, `offscreen.ts` (root entry points) — zero test coverage
   - **The Debt:** Coverage (92%) is measured only against `src/`. The three root entry files — including all of `offscreen.ts`'s 355 lines of message-handling, the `loadHeavy`/`ensureSession`/`rebuildSession` logic, and `collectGpuInfo` — are excluded from the report and imported by no test. `offscreen.ts` holds the most operationally risky code (model load, stream loop, GPU probing).
   - **The Risk:** The highest-risk client code (model lifecycle, device probing, stream backpressure) has no automated guard; regressions only surface in manual browser testing.

7. **[Architectural]** `offscreen.ts:11-18`, `:20` + `src/offscreen/protocol.ts`
   - **The Debt:** `offscreen.ts:11-18` documents that the heavy-module load is duplicated rather than extracted ("v0.2 went down that path with `src/heavy.ts` and was reverted"). The `LanguageModelSession`/`LoadedHeavy`/`OnnxWasmEnv` interfaces and wasm-path wiring live inline. Accepted tradeoff, but the polyfill contract is described by ad-hoc local interfaces in two places.
   - **The Risk:** A polyfill API change (e.g. `measureContextUsage` signature) must be tracked in untyped `as unknown` casts in multiple files with no shared type to fail the build.

8. **[Operational]** `src/offscreen/client.ts:163-175` (`warmupSession`) coupling to `measureContextUsage`
   - **The Debt:** Warmup probes model readiness by calling count-tokens with empty text, relying on the offscreen handler calling `ensureSession()` first. The code's own comment (`client.ts:141-161`) flags that a future polyfill making `measureContextUsage` lazier would make this probe resolve *before* the model is loaded, silently moving the multi-GB load cost onto the user's first prompt.
   - **The Risk:** A dependency bump (`@huggingface/transformers` is `^4.2.0`, floating) could break the warmup contract with no test catching it.

9. **[Operational]** `src/session.ts:220-306` `isFirstTurn` cross-URL context bug (documented)
   - **The Debt:** `NOTE(isFirstTurn)` at line 220 documents that the page-context prefix is only applied on the first turn of the content-script lifetime, but the single long-lived offscreen session is shared across tabs/URLs. After `restore()` re-renders prior history, the offscreen session has no knowledge of it, so page context for a *new* URL in the same session is never sent.
   - **The Risk:** Asking about page B after chatting about page A gives answers grounded in A's context (or none) — a correctness gap in the core "ask about this page" feature.

10. **[Operational]** `offscreen.ts:64-67` floating dynamic-import of multi-GB dependency without an upper-bound timeout
    - **The Debt:** `loadHeavy` does `Promise.all([import('@huggingface/transformers'), import(polyfill)])` and, by design, there is no timeout on the load path (`client.ts:152` "NO TIMEOUT"). If `LanguageModel.create()` hangs without rejecting (the documented "only unhandled case"), the offscreen `sessionPromise` is stuck forever and every subsequent `ensureSession()` awaits the same dead promise.
    - **The Risk:** A wedged WebGPU init poisons the singleton; recovery requires reloading the whole extension (which the UI does tell the user, mitigating it).

11. **[Hygiene]** Production `console.log` noise — `offscreen.ts:72,293,318,355`, `src/session.ts:316,327,651` etc.
    - **The Debt:** Multiple unconditional `console.log` calls ship in production builds (prompt lengths, timings, "listener ready", first-token latency, full threshold dumps), not gated behind a debug flag. (`console.debug` in session.ts:213/215 is appropriately leveled.)
    - **The Risk:** Leaks prompt/response lengths and timing to the page's console on every turn; minor info-exposure and console clutter in a content-script context shared with the host page.

### LOW

12. **[Hygiene]** `src/session.ts:236-289`, `532-547` — inline `style.cssText` button styling duplicated verbatim (`'padding: 2px 8px; …background: #444; color: #eee; border: 1px solid #666; border-radius: 4px;'`) across `makeActionButton`, the Clear button, and the history-pressure button with no shared constant.

13. **[Architectural]** `background.ts:20-25` assigns `ensureOffscreen`/`sendPrompt`/etc. onto `globalThis` for SW DevTools convenience. Documented, but it's production code existing solely for manual debugging and is untyped (`as unknown as Record<string, unknown>`).

14. **[Hygiene]** `.env.json` is git-ignored yet byte-identical to `.env.example.json` (both `"apiKey": "dummy"`). The `apiKey` field **is** read — by the vendored polyfill at `vendor/prompt-api-polyfill/prompt-api-polyfill.js:181` (`if (config && config.apiKey)`). The transformers backend doesn't require a real key, so `"dummy"` is an intentional placeholder, not dead config. *(Corrected 2026-05-23: the original finding called it "unused / vestigial"; the polyfill does reference it.)*

15. **[Structural]** `src/offscreen/protocol.ts` — every message type repeats the same `typeof value !== 'object' || value === null` + `as Record<string, unknown>` guard preamble across 8 type predicates. Correct but mechanically duplicated; a shared `isRecord` helper would remove ~16 repeated lines.

16. **[Hygiene]** `src/selection-rewrite.ts:352-356` — `finalize()` is a documented no-op ("Reserved for future commit-or-rollback behaviour"). Speculative dead surface; `rewrite.finalize()` is called in `session.ts:464` but does nothing.

17. **[Operational]** `offscreen.ts:200-209` — the `catch` in `collectGpuInfo` after `requestAdapter()` throws returns `isFallback: false` (optimistic), while the no-adapter branch returns `isFallback: true`. A throwing adapter query is reported as healthy, which can suppress the `preflightWarning` advisory on a genuinely broken GPU.

18. **[Hygiene]** `vendor/prompt-api-polyfill/dot_env.json` is tracked and is a second copy of the env config inside vendored third-party code; likely a stale vendored artifact (runtime config comes from repo-root `.env.json` via `offscreen.ts:20`).

## Quick Wins
1. `rm web-store/local-nano-v0.2.3.zip` — delete the stale 19 MB local build artifact (it is untracked/gitignored, so no `git` action is needed) (< 5 min).
2. `src/system.ts` + `tests/system.test.ts` — delete the dead module and its misleading test, or wire `SYSTEM_INSTRUCTION` into `offscreen.ts:55` to replace the terse inline string (< 30 min).
3. Extract the duplicated button `cssText` (finding 12) into one `BUTTON_CSS` constant in `src/session.ts` (< 15 min).
4. Gate the unconditional `console.log`s behind a single `DEBUG` const so production builds are quiet (finding 11) (< 1 hour).
5. Document that `apiKey: "dummy"` is a deliberate placeholder read by the polyfill but unused by the transformers backend (finding 14) — do **not** remove it (< 15 min).

## Automated Scan Results
- **Build / typecheck / tests:** `tsc --noEmit` exits 0 (clean). `vitest run --coverage` → 13 files, 207 tests, all passing. Coverage 92.05% stmts / 83.25% branch on `src/` — but root entry points (`content.ts`, `background.ts`, `offscreen.ts`) are outside the measured set and have **0% test coverage**.
- **Dead code:** No `knip` in toolchain; manual analysis found one fully dead production module (`src/system.ts`, finding 3), one speculative no-op (`selection-rewrite.ts finalize`, finding 16), and a likely-stale vendored `dot_env.json` (finding 18). No unused imports flagged by Biome.
- **Vulnerability scan (`npm audit`):** **6 moderate** advisories (re-run verified 2026-05-23), all **dev-only / transitive** and not shippable — the `esbuild` ≤0.24 dev-server advisory cascading through `vite` → `vite-node` / `@vitest/mocker` → `vitest` → `@vitest/coverage-v8`. `esbuild`'s dev server isn't used (build is one-shot); the fix is a major `vitest` bump. No runtime-dependency vulnerabilities. Dependabot auto-merge is configured. *(Corrected 2026-05-23: the original finding said "3 moderate"; the actual count is 6.)*
- **Secrets scan:** No real secrets. `.env.json`/`.env.example.json` contain only `"apiKey": "dummy"` (placeholder; read by the polyfill at `prompt-api-polyfill.js:181` but not a real credential). `.env.json` is git-ignored; CI provisions it from the example. No high-entropy strings or credentials in source or sampled history.
- **Git hygiene:** `.gitignore` sensible. `well_done.jpg` (327 KB) is tracked (a doc/hero asset, likely deliberate). `web-store/*.zip` is **not** tracked (gitignored, working-tree only). Commit history clean and conventional-commit styled (75/82 subjects conform; the 7 exceptions are merges + genesis commits). *(Corrected 2026-05-23: the original finding listed the web-store zip as tracked.)*
