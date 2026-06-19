# Feature: Model Picker + Idle Resource Release

## Overview

Two post-0.3.0 features, designed together because they ride the same
single-shared-session offscreen lifecycle and the same teardown/re-warm
machinery.

**Model picker.** Today the model is fixed: `.env.json` sets the primary model
(`onnx-community/gemma-4-E2B-it-ONNX`) and the fallback ladder
(`src/offscreen/ladder.ts`) auto-walks its dtype/device tiers. This feature adds
a user-facing **gear/settings popover** in the panel header that lets the user
pick a model from a **curated catalog** that spans smaller→larger options, with
gemma-4-E2B as the default. The user picks a *model only* — there is no dtype
control. The existing capability classifier + fallback ladder still auto-steps
dtype/device (capable → lean) within the chosen model until one loads, so the
"cycle through the dtypes/stipulations" behavior stays automatic rather than
becoming a busy manual UI. Selection is a preference (separate storage key that
survives extension updates); switching is **select-then-explicit-Load** so a
multi-GB reload never happens on a stray click.

**Idle resource release.** Today the offscreen model is never freed: once warmed
it holds multi-GB of WebGPU buffers for the whole browser session (close only
hides the panel; the doc is destroyed only on a tier switch or manual Retry).
This feature frees the model — **hard release**: the service worker closes the
whole offscreen document — after an **inactivity timeout measured from the last
generation**, implemented with `chrome.alarms` so it survives service-worker
eviction. The timeout is **user-configurable in the same gear popover** (default
15 min, with a "Never" opt-out). Re-warm happens on next use and must be
recoverable from the send path, not just panel-open.

Both features collapse onto **one teardown + re-warm operation guarded by one
lock**: a model switch and an idle release are the same thing (close the doc,
re-warm against the resolved model/tier). The existing `recreateOffscreen()` +
`ensureWarm()` path (used by Retry) is the seam they share.

## Decisions

1. **One combined spec** for model picker + idle release. Rationale: both modify
   the single-shared-session offscreen lifecycle and share the recreate+re-warm
   path; designing them apart would surface the same lock/lifecycle questions
   twice.
2. **Curated catalog only** — no arbitrary Hugging Face model IDs. Rationale:
   unvetted models fail in confusing ways (the `GatherBlockQuantized` WASM op
   trap, OOM); the catalog keeps every option to a combination `docs/models.md`
   has actually exercised.
3. **Model-only selection — no dtype/device UI.** The user picks a model; the
   existing ladder auto-steps dtype/device (capable → lean) until one loads.
   Rationale (user): a dtype picker "feels too busy"; the auto-fallback already
   does the stepping well. This *revises* an earlier "pin a dtype" idea that was
   discussed and dropped.
4. **Catalog is a both-directions spectrum** from gemma-4-E2B (default). Smaller
   direction uses the already-vetted Qwen3.5-0.8B and Qwen2.5-0.5B. The larger
   direction (anything bigger than gemma-4-E2B) is **gated behind a
   manual-smoke-vetting flag**, exactly like the existing `SMALLER_MODEL_ENABLED`
   precedent — a larger model is listed/selectable only after a WebGPU smoke pass
   confirms it loads and answers. Rationale: CI cannot exercise WebGPU; shipping
   an untested larger model risks the v0.2.0-style OOM.
5. **gemma-4-E2B stays the default**; "no preference set" = today's
   capability-based auto-pick. Rationale: zero behavior change for users who
   never open the picker.
6. **Selection persisted under a separate `chrome.storage.local` key** (e.g.
   `local-nano:model-pref:v1`), independent of the per-device `CapabilityRecord`.
   Rationale: `CapabilityRecord` is invalidated on every extension-version bump
   (`capability-store.ts:87`); a user's model choice is a preference, not a
   device fact, and must survive updates. The per-device known-good/known-bad
   record already namespaces by model (model name is part of `tierKey`), so it
   keeps working per-model unchanged.
7. **Select-then-explicit-Load** for switching. Selecting marks the preference;
   a "Load" / "Apply" button triggers the teardown + re-warm. Rationale: a switch
   is a multi-GB reload; an explicit action guards against accidental reloads.
   Reuses `recreateOffscreen()` + `ensureWarm()`.
8. **Hard release** for idle teardown: the SW closes the whole offscreen document
   (`closeOffscreen()`, `src/background/offscreen.ts`). Rationale: a soft
   `session.destroy()` that keeps the doc/device alive may not promptly reclaim
   all WebGPU buffers; closing the document tears down its entire JS context and
   definitively frees VRAM — which is what the observed memory crash needs.
9. **Inactivity timer measured from the last generation**, implemented with
   `chrome.alarms`. Rationale: the MV3 service worker is evicted after ~30s idle,
   so an in-SW `setTimeout` never fires; a Chrome-held alarm wakes the SW to act.
   Measuring from last generation (not panel-open) means a panel left open while
   the user is away still releases — that is the leak scenario, and the ROADMAP
   already accepts the one-time reload on return.
10. **The SW owns the close; the offscreen doc never closes itself.** Rationale:
    the SW caches `documentReady`; a self-closing doc leaves that flag stale and
    re-introduces the "sticky-flag silent death" that ROADMAP workstream #1 just
    fixed. The SW resets the flag inside `closeOffscreen()`.
11. **Verify-idle before releasing.** When the alarm fires, the SW confirms no
    generation is in flight (the offscreen `generationGate` / `activeAborts` in
    `offscreen.ts`) before closing; if busy, reschedule. Each new generation
    resets the alarm to `now + timeout`.
12. **Re-warm recoverable from the send path.** After a hard release, a send from
    a still-alive (possibly backgrounded) content script must trigger a recreate
    + warm rather than erroring into a closed doc. Today only the panel-open
    `ensureWarm` creates the doc; the send path assumes it exists.
13. **Idle timeout configurable in the gear popover** — options e.g.
    `5 min / 15 min / 60 min / Never`, **default 15 min**. "Never" is the opt-out
    for users on large machines. Stored alongside the model preference.
14. **One teardown/re-warm mechanism with one lock** shared by idle-release and
    model-switch (they are the same operation), serialized so an idle alarm and a
    user "Load" cannot race.

## Scope: In

- A gear/settings popover in the panel header (mounts like the existing
  Copy-diagnostic control, via the `header` dep in `SessionDeps`).
- A curated model catalog (new pure module) listing each supported model with
  display metadata and its ordered dtype/device tiers.
- A build-time gate for larger-than-default models, mirroring
  `SMALLER_MODEL_ENABLED` (default off until manually smoke-vetted).
- Model-preference persistence in a new `chrome.storage.local` key that survives
  extension-version bumps; default = capability-based auto-pick.
- Wiring the chosen model into ladder assembly so the chosen model heads the
  ladder and the existing auto-fallback steps its dtypes/devices.
- A "Load" control that performs the switch via `recreateOffscreen()` +
  `ensureWarm()`.
- Idle release: `chrome.alarms`-driven inactivity timeout from last generation;
  SW-owned hard close; verify-idle-before-close; alarm reset on each generation.
- Re-warm-on-return recoverable from both panel-open and the send path.
- A user-configurable idle timeout (incl. "Never") in the popover.
- A single serialized teardown/re-warm path shared by switch + idle-release.

## Scope: Out

- **No dtype/device picker UI** (decision 3) — dtype stays automatic.
- **No arbitrary HF model IDs** (decision 2).
- **No larger model shipped live** until its manual WebGPU smoke-vetting passes
  (decision 4) — the gate ships off.
- **No per-site / per-URL model selection** — selection is global (one
  preference), unlike per-URL chat history.
- **No last-panel-close or tab-close trigger** — inactivity-from-last-generation
  is the only release trigger this build (last-panel-close needs cross-tab
  visibility tracking + a reliable tab-close signal; explicitly deferred).
- **No soft release** (keep-doc, destroy-session-only) — hard close only.
- **Not a crash handler.** A full browser/GPU/Dawn crash is not catchable by the
  extension; idle-release reduces sustained memory pressure but does not
  "gracefully handle" a crash. On recurrence, capture the Copy diagnostic +
  `chrome://gpu` (per ROADMAP) to distinguish memory pressure from a driver
  fault.
- **No change to the primary default model** or to the existing per-device
  known-good/known-bad persistence semantics.

## Open Questions

- **Exact larger-model candidate(s)** for the gated catalog rung — which
  specific model(s) above gemma-4-E2B to list (behind the gate) as the
  smoke-vetting target. Can be decided at planning/vetting time; the gate ships
  off regardless.
- **Per-model popover metadata** — proposed: display name, approx download size,
  and a one-line note sourced from `docs/models.md` (e.g. "smallest, runs on
  CPU"). Confirm the exact fields during planning.
- **Alarm granularity vs. the shortest timeout option** — `chrome.alarms`
  minimum period is ~1 min; confirm the smallest offered timeout (5 min) sits
  comfortably above it (it does).
- **Switch while a generation is streaming** — presumably the "Load" button is
  disabled / the switch waits while a stream is in flight (same verify-idle gate
  as the alarm). Confirm the UX (block vs. abort-then-switch).

## Relevant Codebase Context

- `src/offscreen/ladder.ts` — pure ladder: `Tier` (modelName/device/dtype),
  `tierKey`, `PRIMARY_MODEL`, `PRIMARY_LADDER`, `assembleLadder({capability,
  smallerEnabled})`, `nextAction`/`firstTierIndex` reducer, `applyTierToConfig`,
  and the `SMALLER_MODEL_ENABLED` gate + `isSmallerModelEnabled()` seam. The
  catalog/picker extends this module's data; the reducer is model-agnostic and
  needs no change.
- `src/offscreen/capability.ts` — `classifyCapability(GpuInfoSnapshot)` →
  `'capable' | 'weak'`, single 1 GiB `CAPABLE_MIN_BUFFER_BYTES` boundary. Drives
  starting-tier selection within the chosen model.
- `src/offscreen/capability-store.ts` — per-device record at
  `CAPABILITY_KEY = 'local-nano:capability:v1'`, `SCHEMA_VERSION`,
  invalidated on schema/extension-version mismatch (`:87`). The new model
  preference must be a *separate* key (decision 6). `tierKey` already namespaces
  known-good/known-bad by model.
- `src/session.ts` — `initSession`, `ensureWarm()` (`:1025`, the ladder walk:
  preflight `getGpuInfo`, `assembleLadder`, the reducer loop, `recreateOffscreen`
  between rungs, terminal/network failure UI), the header-mounted Copy-diagnostic
  affordance (`makeCopyDiagnosticAffordance`, `:990`, inserted via the `header`
  dep at `:1236`), `clearConversation` (an existing destroy+rebuild precedent),
  `warmStarted`/`modelReady` flags, and the toggle listener that hides the panel
  (`:1244`) and calls `ensureWarm()` on open.
- `offscreen.ts` — the offscreen entry: `loadHeavy()` (sets
  `window.TRANSFORMERS_CONFIG`; **must run before** any tier override),
  `ensureSession()`, `handleWarmup()` (`:354`, applies the tier override),
  `rebuildSession()`, the single `onMessage` dispatcher (`:416`), the stream port
  with `generationGate` / `activeAborts` (the verify-idle signal source), and the
  progress port.
- `src/background/offscreen.ts` — the SW offscreen owner: `ensureOffscreen()` /
  `closeOffscreen()` and the cached `documentReady` flag. The idle-release close
  and the alarm handler live here.
- `src/offscreen/client.ts` — panel→offscreen transport: `warmupSession`,
  `recreateOffscreen`, `streamPrompt`, `getGpuInfo`, `subscribeProgress`,
  `countTokens`, `rebuildSession`.
- `.env.json` — base config (`apiKey`/`device`/`dtype`/`modelName`), tier 0 of
  the primary ladder. The picker overrides model in-memory, never on disk.
- `docs/models.md` — the field guide / source of catalog entries and per-model
  notes (vetted dtype/device cells, the WASM `GatherBlockQuantized` trap, the
  "Smaller-model fallback rung (gated)" section that documents the
  `SMALLER_MODEL_ENABLED` pattern this feature reuses).
- `ROADMAP.md` — "Next priority (post-0.3.0): idle resource release" section is
  the grounding for the idle half; this spec implements it.

## Technical Constraints

(Carried from the project's standing constraints; all still apply.)

1. **Single shared offscreen `LanguageModel` session — never two concurrently.**
   v0.2.0 was reverted for `VK_ERROR_OUT_OF_DEVICE_MEMORY` from a second session.
   The switch/idle-release teardown must fully tear down before the next load
   begins (force-recreate the document; do not overlap loads).
2. **MV3 service-worker eviction (~30s idle)** — long delays require
   `chrome.alarms`, not `setTimeout`. The SW restarts on demand (message/alarm),
   losing in-memory state each time, so any persistent state lives in storage or
   the alarm itself.
3. **`documentReady` staleness** — only the SW closes the doc, and it must reset
   the flag (or verify liveness via `chrome.offscreen.hasDocument()`); a
   self-closing doc re-introduces the sticky-flag silent death (ROADMAP #1).
4. **`handleWarmup` ordering** — `loadHeavy()` resets
   `window.TRANSFORMERS_CONFIG` to the base import; it must run **before** the
   per-tier override, or every rung loads the base config. Any picker code path
   that re-warms must preserve this ordering.
5. **Do not patch the vendored polyfill** (`vendor/prompt-api-polyfill/`) — work
   through its public surface only (e.g. the `monitor`/`downloadprogress`
   events).
6. **CI cannot exercise WebGPU.** Model load, the larger-model gate, and the
   idle-release/re-warm cycle are verifiable only by manual smoke test; gate the
   larger-model rung and release on the manual matrix. Keep the pure seams
   (ladder, capability, catalog) unit-testable.
7. **100% on-device / private** — the only network use is the one-time HF
   model-weights download (cached after first load); a model switch to an
   un-downloaded catalog model incurs a one-time download for that model.
8. **Text-in/text-out only** — unchanged.
