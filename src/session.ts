import { TOGGLE_MESSAGE } from './background/handler.js';
import { debugLog } from './debug.js';
import {
  type Entry,
  loadHistory as loadHistoryFromStorage,
  MAX_HISTORY,
  type Role,
  saveHistory as saveHistoryToStorage,
  storageKey,
} from './history.js';
import { CAPABLE_MIN_BUFFER_BYTES, classifyCapability } from './offscreen/capability.js';
import {
  type CapabilitySnapshot,
  clearCapabilityRecord,
  loadCapabilityRecord,
  recordKnownBad,
  recordKnownGood,
} from './offscreen/capability-store.js';
import {
  type CatalogEntry,
  DEFAULT_MODEL_ID,
  findCatalogEntry,
  isLargerModelEnabled,
  listCatalog,
} from './offscreen/catalog.js';
import {
  countTokens,
  getGpuInfo,
  rebuildSession,
  recreateOffscreen,
  streamPrompt,
  subscribeProgress,
  touchIdle,
  warmupSession,
} from './offscreen/client.js';
import { buildDiagnostic, errorInfo, type LadderPathEntry } from './offscreen/diagnostic.js';
import { classifyFailure, classifyLoadFailure } from './offscreen/failure.js';
import {
  assembleLadderForModel,
  firstTierIndex,
  isSmallerModelEnabled,
  nextAction,
  type Tier,
  tierKey,
} from './offscreen/ladder.js';
import {
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  IDLE_TIMEOUT_OPTIONS,
  loadModelPref,
  resolveModelId,
  setIdleTimeoutMinutes,
  setModelId,
} from './offscreen/model-pref.js';
import {
  formatProgressText,
  GPU_LOADING_TEXT,
  nextProgress,
  type ProgressState,
} from './offscreen/progress.js';
import type { GpuInfoSnapshot, HistoryTurn } from './offscreen/protocol.js';
import { pageContext } from './pageContext.js';
import {
  buildAskPrompt,
  buildRewritePrompt,
  MAX_OUTPUT_MULTIPLIER,
  MIN_OUTPUT_TOKENS,
  type SelectionSnapshot,
  streamRewriteIntoRange,
  undoRewrite,
} from './selection-rewrite.js';
import { createThinkStripper } from './think-strip.js';
import { makeTypingIndicator, renderMessage } from './ui/messages.js';
import { setGeneratingState, setIdleState, setLoadingState } from './ui/state.js';

const PLACEHOLDER_CHAT = 'Ask anything about this page (Enter)';
const PLACEHOLDER_EDIT = 'Edit selection… (Esc to switch to Ask)';
const PLACEHOLDER_ASK = 'Ask about selection… (Esc to switch back to Edit)';
const CHIP_MAX_CHARS = 60;

/**
 * Shared style for the small dark action buttons (Undo/Accept on a
 * rewrite, Clear on the history-pressure bubble). Single-sourced so the
 * palette stays consistent; buttons needing extra layout (e.g. the
 * history-pressure Clear's `margin-top`) prepend their own declarations.
 */
const BUTTON_CSS =
  'padding: 2px 8px; font: inherit; cursor: pointer; background: #444; color: #eee; border: 1px solid #666; border-radius: 4px;';

/**
 * Default heuristic threshold (in estimated tokens) for warning when
 * accumulated history risks GPU memory pressure. Used only as a
 * fallback — the actual threshold is normally derived per-session
 * from the queried WebGPU adapter limits (see deriveHistoryThreshold).
 * If `.env.json` defines a `historyTokenWarnThreshold` field, that
 * overrides everything.
 */
const HISTORY_TOKEN_WARN_THRESHOLD_DEFAULT = 1500;

/**
 * The diagnostic's error fields when no failure has occurred (the
 * always-available Copy affordance built before/without any load failure).
 * Reads as `none` rather than a fabricated error.
 */
const NO_ERROR = { errorClass: 'none', errorMessage: 'none' };

/**
 * How long the model-load elapsed counter ticks before it appends
 * "taking longer than usual" remedies. The load is never auto-failed on
 * a timer (a slow first download must not be killed); this only changes
 * the wording so a genuinely stuck load gets actionable guidance.
 */
const WARMUP_SLOW_NOTICE_MS = 45_000;

/**
 * Map a GPU-info snapshot to a token-history warning threshold.
 * Lifted to module scope so it's unit-testable without going through
 * initSession.
 *
 * Reasoning:
 * - WASM device → CPU does the inference, system RAM is in the gigabytes,
 *   raise the threshold so we effectively never warn for normal sessions.
 * - Fallback adapter (Dawn SwANGLE) → very constrained, warn early.
 * - WebGPU with a known maxBufferSize → step down with the adapter:
 *   integrated GPUs cap around 256-512 MiB single buffers, mid-range
 *   discrete sits at 1-2 GiB, high-end and Apple Silicon at 4+ GiB.
 *   These don't map directly to VRAM total but correlate strongly with
 *   hardware class.
 */
export function deriveHistoryThreshold(info: GpuInfoSnapshot): number {
  if (info.configuredThreshold !== null) return info.configuredThreshold;
  if (info.device === 'wasm') return 8000;
  if (info.isFallback) return 800;
  if (info.maxBufferSize === null) return HISTORY_TOKEN_WARN_THRESHOLD_DEFAULT;
  const mb = info.maxBufferSize / (1024 * 1024);
  if (mb < 512) return 1000;
  if (mb < 1024) return 1500;
  if (mb < 2048) return 2500;
  return 4000;
}

/**
 * Preflight capability check. Given the queried GPU info, return an
 * upfront advisory string if the device looks unlikely to load the
 * model on WebGPU — so the user gets a clear heads-up instead of a
 * silent crash mid-load. Returns null when nothing looks wrong.
 * Advisory only: the load is still attempted (the snapshot can
 * false-negative), but the user knows what to try if it fails.
 * Exported for unit testing.
 */
export function preflightWarning(info: GpuInfoSnapshot): string | null {
  if (info.device !== 'webgpu') return null;
  if (info.isFallback) {
    return 'Heads up: no hardware WebGPU adapter detected (software fallback). The model may fail to load on this device — if it does, set "device": "wasm" in .env.json (CPU, slower but reliable).';
  }
  if (info.maxBufferSize !== null && info.maxBufferSize < CAPABLE_MIN_BUFFER_BYTES) {
    const mb = Math.round(info.maxBufferSize / (1024 * 1024));
    return `Heads up: this GPU's max buffer is ~${mb} MiB, which may be too small to load the model. If it fails, try a smaller model or "device": "wasm" in .env.json.`;
  }
  return null;
}

/**
 * True when a storage write rejection looks like a quota exhaustion rather
 * than a transient/unknown failure. `saveHistory` uses the promisified
 * `chrome.storage.local.set`, so a quota failure arrives as a rejected Error
 * whose message mentions QUOTA/quota (`chrome.runtime.lastError` is the
 * callback-era mechanism and is not populated in a Promise `.catch()`).
 * Matching the wording keeps non-quota failures on the console.error path.
 * Exported for unit testing.
 */
export function isQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /quota/i.test(message);
}

/**
 * DOM elements and values that content.ts provides at injection time.
 * session.ts does not touch document directly.
 */
export interface SessionDeps {
  root: HTMLElement;
  /**
   * The draggable panel header bar (content.ts). When provided, the
   * always-available Copy-diagnostic control is inserted here, left of the
   * close button, so it never overlays the close button. Optional: when
   * omitted (e.g. in tests) the control falls back to the panel root.
   */
  header?: HTMLElement;
  messages: HTMLElement;
  input: HTMLInputElement;
  actionBtn: HTMLButtonElement;
  /**
   * Compact chip element above the input showing a preview of the
   * current selection. Owned by content.ts; the session manages content
   * and visibility.
   */
  selectionChip: HTMLElement;
  /**
   * Register a callback for selection-change events. content.ts wires
   * `document.addEventListener('selectionchange', …)` and forwards
   * `decideSnapshot(...)` results here. Snapshot may be null when no
   * supported selection exists.
   */
  onSelectionChange: (cb: (snap: SelectionSnapshot | null) => void) => void;
  location: Pick<Location, 'origin' | 'pathname' | 'href'>;
  document: Pick<Document, 'title'> & { body: { innerText: string } };
}

/**
 * The extension version, or `'unknown'` if the extension context has been
 * invalidated (the extension was reloaded or auto-updated while this content
 * script's tab stayed open). `chrome.runtime.getManifest()` throws synchronously
 * once the context is gone, which — called from a click handler like the
 * Copy-diagnostic button — would otherwise surface as an uncaught error.
 */
function safeManifestVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return 'unknown';
  }
}

/**
 * The handle `initSession` returns so a caller (Phase 3's gear-popover Load
 * control) can drive the serialized teardown + re-warm primitive. Exposed as a
 * controller rather than a free function so each panel instance owns its own
 * in-flight lock and `ensureWarm` closure.
 */
export interface SessionController {
  /**
   * Serialized teardown + re-warm (ADR-P6). Force-recreates the offscreen
   * document and walks the ladder for the resolved model/tier under ONE
   * in-flight lock, so a model switch and any other re-warm trigger can never
   * overlap two loads (constraint 1). Concurrent callers coalesce onto the same
   * in-flight promise. Caller precondition (ADR-P7): do not invoke while a
   * generation is streaming; this primitive will not abort an active stream.
   */
  reloadModel: (opts?: { resetCapability?: boolean }) => Promise<void>;
}

export function initSession(deps: SessionDeps): SessionController {
  const {
    root,
    header,
    messages,
    input: i,
    actionBtn,
    selectionChip,
    onSelectionChange,
    location,
    document,
  } = deps;
  const STORAGE_KEY = storageKey(location);

  // ---- History ----
  let history: Entry[] = [];

  // Keep the in-memory array bounded so a long session doesn't grow it
  // without limit. Storage is already capped in saveHistory, but the
  // in-memory copy can outlive any single persist call.
  function pushEntry(entry: Entry) {
    history.push(entry);
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
  }

  // Fire-and-forget persistence. A quota rejection (chrome.storage.local has
  // a fixed byte budget) previously only reached console.error, so history
  // could silently stop saving on large-turn pages. Surface it once per
  // session as a non-blocking advisory bubble; the turn's output is already
  // rendered, so we never block on a failed write.
  let warnedAboutStorageQuota = false;
  function persist() {
    // Once a quota rejection has been surfaced, stop firing further writes —
    // they would only reject again. clearConversation() resets the flag, so
    // saving resumes once the user frees space.
    if (warnedAboutStorageQuota) return;
    saveHistoryToStorage(STORAGE_KEY, history).catch((err: unknown) => {
      if (isQuotaError(err)) {
        if (!warnedAboutStorageQuota) {
          warnedAboutStorageQuota = true;
          addMessage(
            'system',
            'History is full for this page and stopped saving. Clear the conversation to resume saving.',
          );
        }
        return;
      }
      console.error('[local-nano] history write failed:', err);
    });
  }

  async function restore(): Promise<void> {
    const loaded = await loadHistoryFromStorage(STORAGE_KEY);
    history = loaded.length > MAX_HISTORY ? loaded.slice(-MAX_HISTORY) : loaded;
    for (const entry of history) renderMessage(messages, entry.role, entry.text);

    // Re-seed the single shared offscreen session with THIS URL's restored
    // conversation. The session is shared across tabs/URLs, so without this
    // a follow-up on a restored page would have no conversational context.
    // Map to HistoryTurn[] (user/model only — system entries are transient
    // UI notices and are dropped; the offscreen side maps model→assistant).
    // Awaited so a later send doesn't race a half-built session; guarded so
    // a failure (offscreen not ready, load failure) degrades to render-only.
    // The seed is bounded by MAX_HISTORY already (no second session, ADR-R2).
    const seed: HistoryTurn[] = history
      .filter((e): e is Entry & { role: 'user' | 'model' } => e.role !== 'system')
      .map((e) => ({ role: e.role, text: e.text }));
    if (seed.length > 0) {
      try {
        await rebuildSession(seed);
      } catch (err) {
        // Degrade to render-only: the rendered history still shows, the
        // session just isn't seeded. Do not throw out of restore().
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[local-nano] restore re-seed failed; rendering only:', message);
      }
    }
  }

  function addMessage(role: Role, text: string): HTMLElement {
    const el = renderMessage(messages, role, text);
    if (role !== 'system') {
      pushEntry({ role, text });
      persist();
    }
    return el;
  }

  // ---- Selection state ----
  let currentSelection: SelectionSnapshot | null = null;
  let askMode = false;

  function updatePlaceholder(): void {
    if (!currentSelection) {
      i.placeholder = PLACEHOLDER_CHAT;
      return;
    }
    i.placeholder = askMode ? PLACEHOLDER_ASK : PLACEHOLDER_EDIT;
  }

  function updateChip(): void {
    if (!currentSelection) {
      selectionChip.style.display = 'none';
      selectionChip.textContent = '';
      return;
    }
    const preview =
      currentSelection.text.length > CHIP_MAX_CHARS
        ? `${currentSelection.text.slice(0, CHIP_MAX_CHARS)}…`
        : currentSelection.text;
    selectionChip.textContent = preview;
    selectionChip.style.display = 'block';
  }

  onSelectionChange((snap) => {
    currentSelection = snap;
    if (!snap) askMode = false;
    updatePlaceholder();
    updateChip();
    // Diagnostic at debug level: selectionchange fires continuously
    // while dragging a selection, so this would flood the default
    // console. Surfaced via console.debug — visible when the user
    // raises the DevTools log level to debug while reproducing
    // subsequent-rewrite issues, hidden otherwise.
    if (snap) {
      const preview = snap.text.length > 40 ? `${snap.text.slice(0, 40)}…` : snap.text;
      console.debug(`[local-nano] selection captured: "${preview}"`);
    } else {
      console.debug('[local-nano] selection cleared');
    }
  });

  // ---- Send / Stop ----
  // NOTE(isFirstTurn): restore() now re-seeds the single shared offscreen
  // session with this URL's restored history (see restore()), so the
  // session DOES have conversational context for a restored page. We
  // deliberately leave isFirstTurn = true after a re-seed: the restored
  // turns give continuity, and the first new turn still prefixes the
  // page-context block so the model is grounded in the CURRENT page. The
  // prefix is therefore sent once per content-script lifetime per URL,
  // which is the intended grounding behavior.
  let isFirstTurn = true;
  let activeAbort: AbortController | null = null;

  // Hook the settings popover's Load-button gating into the stream lifecycle so
  // a switch the user queued while a stream was in flight re-enables once the
  // stream settles (ADR-P7). Assigned by the gear-popover block below; a no-op
  // default keeps `runStreamTurn` working before the popover is built.
  let refreshPopoverControls: () => void = () => undefined;

  function makeActionButton(label: string): HTMLButtonElement {
    const btn = window.document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = BUTTON_CSS;
    return btn;
  }

  /**
   * After a rewrite finishes, attach a small Undo + Accept button bar to
   * the model bubble.
   *
   * Undo restores the original text from the snapshot.
   *
   * Accept commits the rewrite. It removes both buttons, clears any
   * stale browser selection that may still be pointing at the
   * now-replaced nodes, and resets session selection state so the next
   * highlight on the page starts from a clean slate — the user
   * reported that subsequent rewrites felt stuck without an explicit
   * "I'm done with this one" signal.
   */
  function attachRewriteActions(modelBubble: HTMLElement, snap: SelectionSnapshot): void {
    const bar = window.document.createElement('div');
    bar.style.cssText = 'margin-top: 6px; display: flex; gap: 6px;';

    const undoBtn = makeActionButton('Undo');
    undoBtn.addEventListener('click', () => {
      const result = undoRewrite(snap);
      undoBtn.disabled = true;
      if (result.ok) {
        undoBtn.textContent = 'Undone';
        debugLog('[local-nano] undo: restored original selection');
      } else {
        undoBtn.textContent = 'Undo failed';
        console.warn(`[local-nano] undo failed: ${result.reason ?? 'unknown'}`);
      }
    });

    const acceptBtn = makeActionButton('Accept');
    acceptBtn.addEventListener('click', () => {
      bar.remove();
      // Clear the page's stale Selection (its Range may reference nodes
      // that were just replaced by the rewrite). Without this, the
      // browser keeps the dangling Selection around and subsequent
      // `selectionchange` events can misfire.
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        // jsdom or restricted contexts may throw; the visible state
        // resets below either way.
      }
      currentSelection = null;
      askMode = false;
      updatePlaceholder();
      updateChip();
      debugLog('[local-nano] rewrite accepted; selection state reset');
    });

    bar.append(undoBtn, acceptBtn);
    modelBubble.appendChild(bar);
  }

  /**
   * Shared stream-render-finalize lifecycle for the three send paths
   * (chat/ask/rewrite). Owns the bubble + typing indicator, the
   * `activeAbort`/`setGeneratingState` setup, the first-chunk reset, the
   * `AbortError`/error `catch`, and the `finally` tail (indicator removal,
   * empty-response fallback, push+persist model entry, `setIdleState`,
   * `activeAbort` reset, `i.focus()`). The per-path differences — chat's
   * first-turn warmup hint, the extra per-chunk hook, the success tail and
   * its differing `recordSentTurn` gating, and ask's mode reset — are passed
   * as explicit options so they read as deliberate, not accidental.
   */
  async function runStreamTurn(opts: {
    /** The fully built prompt to stream (caller frames it). */
    prompt: string;
    /**
     * A system bubble shown for the duration of the turn (chat's first-turn
     * warmup hint). Removed on the first chunk and again in the finally.
     */
    preHint?: HTMLElement | null;
    /**
     * Extra per-chunk hook, run after the shared reset and before the
     * cumulative text is appended. Chat logs first-token timing + removes
     * the warmup hint; rewrite applies the chunk to the page Range.
     */
    onChunk?: (chunk: string) => void;
    /**
     * Per-path success tail, run once on a non-aborted stream. Receives the
     * final model text, the prompt length, and the model bubble so each path
     * models its own `recordSentTurn` gating (chat: always; ask: on success;
     * rewrite: on non-empty) and any extra success-only work (rewrite's
     * action bar, which attaches to the bubble).
     */
    onSuccess?: (modelText: string, promptLen: number, responseEl: HTMLElement) => void;
    /**
     * Always-run tail after the success/error handling, regardless of
     * outcome (ask's one-shot mode reset). Runs inside the finally.
     */
    onFinally?: () => void;
  }): Promise<void> {
    const { prompt, preHint, onChunk: extraOnChunk, onSuccess, onFinally } = opts;
    const responseEl = renderMessage(messages, 'model', '');
    const indicator = makeTypingIndicator();
    responseEl.appendChild(indicator);

    activeAbort = new AbortController();
    setGeneratingState(actionBtn, i);
    // Reset the idle-release window on generation START (decision 9). The SW
    // measures the inactivity timeout from the last generation; firing here
    // re-arms it as soon as a turn begins. Fire-and-forget: never awaited in the
    // hot path, and `touchIdle` already swallows its own errors so a failed
    // schedule cannot break the send.
    void touchIdle();

    // Strip the RAW model output into VISIBLE text incrementally. Reasoning
    // models (Qwen3, etc.) stream a `<think>…</think>` block we must not show;
    // the stripper processes only each chunk's delta while carrying open-block
    // and partial-marker state (robust to markers split across chunk
    // boundaries), so a long think block no longer makes the render loop
    // O(n^2). It returns the new FULL visible text — provably equal to
    // `stripThink` over the whole raw buffer. While the model is still
    // "thinking" the visible text is empty, so we keep the typing indicator up
    // until the first visible token, then swap to the answer.
    let stripper = createThinkStripper();
    let modelText = ''; // visible text (think blocks stripped) — also what we persist
    let shownFirstVisible = false;
    const onChunk = (chunk: string) => {
      const visible = stripper.push(chunk);
      if (visible === modelText) return; // still thinking / held partial marker
      // `visible` extends `modelText` in the normal forward-streaming case; the
      // delta drives the rewrite path's incremental apply. Guard with startsWith
      // so a rare non-prefix recompute never feeds a bogus delta downstream (the
      // full-text render below stays correct regardless).
      const delta = visible.startsWith(modelText) ? visible.slice(modelText.length) : '';
      modelText = visible;
      if (!shownFirstVisible) {
        // First visible token: drop the warmup hint + typing indicator and clear
        // the bubble so the answer renders from a clean slate.
        if (preHint?.parentNode) preHint.remove();
        if (indicator.parentNode) indicator.remove();
        responseEl.textContent = '';
        shownFirstVisible = true;
      }
      if (delta) extraOnChunk?.(delta);
      responseEl.textContent = modelText;
      messages.scrollTop = messages.scrollHeight;
    };
    // Proactive re-warm (ADR-P10): if the model is not ready and no re-warm is
    // already running, warm before streaming. After an idle hard release the
    // document is gone, so a send would otherwise error into a closed document.
    // `ensureWarm` is a no-op when a panel-open warmup is already in flight
    // (`warmStarted` true), so this never double-loads; it only re-walks when the
    // doc was actually released (`warmStarted` reset). Routed so no two loads
    // overlap (ADR-P6): `ensureWarm` is the same single walk the panel-open path
    // and the serialized primitive use.
    if (!modelReady && !reWarmInFlight) {
      try {
        await ensureWarm();
        // runWarm leaves the button in the disabled "Loading" state, and its
        // finally skips the idle-restore while activeAbort is set — so without
        // re-asserting here the Stop affordance would be gone for the ENTIRE
        // stream that follows. Re-apply the generating state, but only when the
        // model actually came up; a failed warm leaves its own terminal/network
        // UI and the stream attempt below drives the reactive recovery.
        if (modelReady) setGeneratingState(actionBtn, i);
      } catch {
        // ensureWarm renders its own failure UI (terminal/network bubble); the
        // stream attempt below will surface a closed-doc error if it is still
        // down, which the reactive path then classifies.
      }
    }

    let succeeded = false;
    // Bound the post-release recovery to a SINGLE retry so a genuinely dead
    // device cannot spin. The reactive path re-warms once on a terminal/closed-
    // document stream failure, then retries the same prompt exactly once; a
    // second failure surfaces the normal error UI (ADR-P10).
    let alreadyRetried = false;
    try {
      await streamPrompt(prompt, { signal: activeAbort.signal, onChunk });
      succeeded = true;
    } catch (err: unknown) {
      const name = (err as { name?: unknown })?.name;
      // Reactive re-warm + single retry (ADR-P10, decision 12). Only a
      // terminal/closed-document failure recovers; an abort or an ordinary
      // (non-terminal) generation error falls straight through to the normal
      // error rendering below, preserving the "no churny auto-rebuild" rule.
      if (name !== 'AbortError' && !alreadyRetried && classifyFailure(err) === 'terminal') {
        alreadyRetried = true;
        try {
          // The failed stream is dead; clear the active-stream guard so the
          // serialized re-warm primitive (ADR-P6) is not blocked by the ADR-P7
          // "never tear down a live stream" early-return. Then re-establish a
          // fresh abort controller for the retried send.
          activeAbort = null;
          await reloadModel();
          activeAbort = new AbortController();
          // Reset the per-attempt accumulators so the retry renders fresh from its
          // first visible token (onChunk clears the bubble on the next one). A
          // fresh stripper drops any partial-marker/open-block state from the
          // dead attempt.
          stripper = createThinkStripper();
          modelText = '';
          shownFirstVisible = false;
          await streamPrompt(prompt, { signal: activeAbort.signal, onChunk });
          succeeded = true;
        } catch (retryErr: unknown) {
          // The single retry also failed: surface it as the normal error UI.
          // No further retry (bounded), preventing a loop on a dead device.
          const retryName = (retryErr as { name?: unknown })?.name;
          if (retryName === 'AbortError') {
            modelText = modelText + (modelText ? '\n\n[stopped]' : '[stopped]');
          } else {
            modelText = retryErr instanceof Error ? retryErr.message : String(retryErr);
          }
          responseEl.textContent = modelText;
        }
      } else if (name === 'AbortError') {
        modelText = modelText + (modelText ? '\n\n[stopped]' : '[stopped]');
        responseEl.textContent = modelText;
      } else {
        modelText = err instanceof Error ? err.message : String(err);
        responseEl.textContent = modelText;
      }
    } finally {
      if (indicator.parentNode) indicator.remove();
      if (preHint?.parentNode) preHint.remove();
      if (!modelText) {
        responseEl.textContent = '(no response — the model returned an empty answer)';
      }
      if (modelText) {
        pushEntry({ role: 'model', text: modelText });
        persist();
      }
      if (succeeded) {
        // A throwing success tail (e.g. rewrite's DOM action-bar attach) must
        // not skip the cleanup below, or the Send button stays stuck in the
        // generating state and activeAbort dangles.
        try {
          onSuccess?.(modelText, prompt.length, responseEl);
        } catch (e) {
          console.error('[local-nano] onSuccess handler threw:', e);
        }
      }
      setIdleState(actionBtn, i);
      activeAbort = null;
      // Re-arm the idle-release window after the LAST token (decision 9): the
      // inactivity countdown starts from the END of generation, not the start.
      // The SW verify-idle reschedules if a stream is still in flight when the
      // alarm fires, so this post-completion touch is what opens the real
      // window. Fire-and-forget; self-swallowing.
      void touchIdle();
      // Re-enable a Load the user queued while this stream was in flight (ADR-P7).
      refreshPopoverControls();
      try {
        onFinally?.();
      } catch (e) {
        console.error('[local-nano] onFinally handler threw:', e);
      }
      i.focus();
    }
  }

  async function sendChat(text: string): Promise<void> {
    addMessage('user', text);
    const wasFirstTurn = isFirstTurn;
    // The panel-open warmup normally covers the model-load wait. The
    // first-turn hint stays only as a fallback for the case where
    // warmup failed silently and the model is loading for the first
    // time on the send path instead.
    const firstTurnHint =
      wasFirstTurn && !modelReady
        ? addMessage('system', 'Loading model… first response can take up to a minute.')
        : null;
    const prompt = isFirstTurn ? `${pageContext(document, location)}\n\n---\n\n${text}` : text;
    isFirstTurn = false;

    const t0 = performance.now();
    let loggedFirstToken = false;
    await runStreamTurn({
      prompt,
      preHint: firstTurnHint,
      onChunk: () => {
        if (!loggedFirstToken) {
          debugLog(`[local-nano] first token at ${(performance.now() - t0).toFixed(0)}ms`);
          loggedFirstToken = true;
        }
      },
      // Chat records the turn unconditionally (the page-context prefix is
      // already in the polyfill's history even on an error/abort).
      onSuccess: (modelText, promptLen) => {
        debugLog(
          `[local-nano] stream done in ${(performance.now() - t0).toFixed(0)}ms, chars=${modelText.length}, prompt.length=${promptLen}`,
        );
        recordSentTurn(promptLen, modelText.length);
      },
    });
  }

  async function sendAsk(instruction: string, snap: SelectionSnapshot): Promise<void> {
    addMessage('user', instruction);
    const prompt = buildAskPrompt(snap, instruction);

    await runStreamTurn({
      prompt,
      // Ask only counts the turn when the stream actually completed.
      onSuccess: (modelText, promptLen) => recordSentTurn(promptLen, modelText.length),
      // Ask mode is one-shot; reset to Edit for the next turn if the
      // selection is still active. Runs regardless of success.
      onFinally: () => {
        askMode = false;
        updatePlaceholder();
      },
    });
  }

  async function sendRewrite(instruction: string, snap: SelectionSnapshot): Promise<void> {
    // Compute the soft cap from the *content* payload, not the framed
    // prompt — the framed prompt embeds the cap number, so counting that
    // would be chicken-and-egg. The framing is short and constant; the
    // delta is well inside the soft cap's margin.
    const payload = `${snap.before}\n${snap.text}\n${snap.after}\n${instruction}`;
    const inputTokens = await countTokens(payload);
    const softCap = Math.max(MIN_OUTPUT_TOKENS, inputTokens * MAX_OUTPUT_MULTIPLIER);
    const prompt = buildRewritePrompt(snap, instruction, softCap);

    addMessage('user', instruction);

    const rewrite = streamRewriteIntoRange(snap);
    await runStreamTurn({
      prompt,
      onChunk: (chunk) => rewrite.applyChunk(chunk),
      // Rewrite attaches the Undo/Accept bar and records the turn only when
      // a non-empty rewrite landed.
      onSuccess: (modelText, promptLen, responseEl) => {
        if (modelText.length > 0) {
          attachRewriteActions(responseEl, snap);
          recordSentTurn(promptLen, modelText.length);
        }
      },
    });
  }

  async function send() {
    if (!i.value.trim() || activeAbort || actionBtn.disabled) return;
    const text = i.value.trim();
    i.value = '';
    const snap = currentSelection;
    if (snap && askMode) {
      // Snapshot reference is fine — ask mode does not mutate the DOM.
      await sendAsk(text, snap);
    } else if (snap) {
      // Detach the snapshot from session state so a later selectionchange
      // does not clobber the in-flight rewrite's anchor.
      currentSelection = null;
      updatePlaceholder();
      updateChip();
      await sendRewrite(text, snap);
    } else {
      await sendChat(text);
    }
    checkHistoryPressure();
  }

  // ---- History pressure tracking ----
  // Once warned, suppress until the user actually clears (or rebuilds);
  // we don't want a warning bubble on every turn after the threshold is
  // crossed. The threshold itself is set per-session from the queried
  // GPU info; until that resolves (or if it fails) we use the default.
  //
  // `cumulativeSentChars` counts characters we actually shipped to the
  // polyfill (full framed prompts + model responses), not just the
  // user-text + model-rewrite that lands in our per-URL chat log. A
  // rewrite turn sends ~700 chars of selection-context framing on top
  // of the user's short instruction, so the polyfill's #history grows
  // much faster than the local `history` array; estimating from
  // `history` alone was undercounting and missing the warning window.
  let warnedAboutHistory = false;
  let historyThreshold = HISTORY_TOKEN_WARN_THRESHOLD_DEFAULT;
  let cumulativeSentChars = 0;

  function recordSentTurn(promptChars: number, responseChars: number): void {
    cumulativeSentChars += promptChars + responseChars;
  }

  function resetSentTotals(): void {
    cumulativeSentChars = 0;
  }

  function estimateHistoryTokens(): number {
    return Math.ceil(cumulativeSentChars / 3);
  }

  function checkHistoryPressure(): void {
    if (warnedAboutHistory) return;
    const tokens = estimateHistoryTokens();
    if (tokens < historyThreshold) return;
    warnedAboutHistory = true;
    attachHistoryPressureBubble(tokens);
  }

  function attachHistoryPressureBubble(tokens: number): void {
    const bubble = addMessage(
      'system',
      `Conversation history is around ${tokens} tokens. WebGPU memory pressure may cause the next turn to fail with an out-of-memory error. Click "Clear conversation" to start fresh — the model will reload (~15–40s).`,
    );
    const btn = window.document.createElement('button');
    btn.textContent = 'Clear conversation';
    btn.style.cssText = `margin-top: 6px; ${BUTTON_CSS}`;
    btn.addEventListener('click', () => {
      bubble.remove();
      void clearConversation();
    });
    bubble.appendChild(window.document.createElement('br'));
    bubble.appendChild(btn);
  }

  /**
   * Rebuild the polyfill session with no prior history and reset all
   * local state that referenced the prior conversation. Slow (~15–40s
   * for the model reload) but reclaims all VRAM and gives the next
   * turn a fresh KV cache.
   */
  async function clearConversation(): Promise<void> {
    setLoadingState(actionBtn, i);
    const hint = addMessage('system', 'Clearing conversation — model is reloading (~15–40s)…');
    try {
      await rebuildSession([]);
      // Reset local state. The persisted chrome.storage entry under the
      // per-URL key is replaced with an empty array so the next panel
      // open doesn't restore the cleared turns.
      history = [];
      isFirstTurn = true;
      warnedAboutHistory = false;
      // Re-enable persistence: the emptied history written by persist() below
      // frees the per-URL storage entry, so the quota advisory no longer applies.
      warnedAboutStorageQuota = false;
      resetSentTotals();
      // Wipe rendered bubbles. Leaves the panel empty so the next turn
      // shows up at the top — matches the user's expectation of "fresh
      // conversation".
      while (messages.firstChild) messages.removeChild(messages.firstChild);
      persist();
      if (hint.parentNode) hint.remove();
      addMessage('system', 'Conversation cleared. The model has a fresh slate.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[local-nano] clearConversation failed:', message);
      if (hint.parentNode) hint.remove();
      addMessage(
        'system',
        `Failed to clear conversation: ${message}. Reloading the extension from chrome://extensions has the same effect.`,
      );
    } finally {
      setIdleState(actionBtn, i);
      i.focus();
    }
  }

  // ---- Event wiring ----
  actionBtn.addEventListener('click', () => {
    if (activeAbort) {
      activeAbort.abort();
    } else {
      void send();
    }
  });

  i.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && currentSelection) {
      e.preventDefault();
      askMode = !askMode;
      updatePlaceholder();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  // ---- Model warmup ----
  // The offscreen polyfill session is lazily created on first use, which
  // would otherwise stall the user's first send for 30–90s while WebGPU
  // uploads the model. Kicking warmup off when the panel first opens
  // lets the load run in the background while the user reads the page
  // or composes their prompt. Idempotent across panel toggles; the
  // offscreen `ensureSession` singleton handles cross-tab dedupe.
  let warmStarted = false;
  let modelReady = false;
  // The in-flight warm walk, or null when none is running. Lets concurrent
  // callers (panel-open, the proactive send-path, and the serialized
  // `reloadModel`) coalesce onto ONE walk, and lets `reloadModel` wait for an
  // in-flight panel-open warm before tearing the document down, so two loads
  // never overlap (constraint 1 / ADR-P6).
  let warmInFlight: Promise<void> | null = null;
  // Captured during the ensureWarm preflight so the failure path can feed the
  // diagnostic the same adapter snapshot the load saw. Conservative default
  // (ADR-R11 / Task 1.4) until the preflight resolves.
  let lastGpuInfo: GpuInfoSnapshot = {
    device: 'webgpu',
    isFallback: false,
    maxBufferSize: null,
    configuredThreshold: null,
  };
  // The tier last attempted and the ordered list of tiers tried this walk with
  // their per-tier outcomes (ADR-R1: the panel owns ladder state). The
  // diagnostic reports the active tier and the full path; persistence keys off
  // the attempted tier. `chosenModel` is the model the ladder selected (the
  // model of the tiers being walked), surfaced in the diagnostic.
  let activeTier: Tier | null = null;
  let ladderPath: LadderPathEntry[] = [];
  let chosenModel: string | null = null;
  // The most recent warmup failure, so the always-available Copy affordance can
  // include it in the on-demand diagnostic. Null before any failure and after a
  // successful load; the diagnostic renders its error fields as `none` then.
  let lastWarmError: unknown = null;

  // Map the queried GPU snapshot to the persistence capability shape (ADR-R7).
  // Drops the configuredThreshold, which is a panel-side derivation knob, not a
  // device-capability fact.
  function capabilitySnapshot(): CapabilitySnapshot {
    return {
      device: lastGpuInfo.device,
      isFallback: lastGpuInfo.isFallback,
      maxBufferSize: lastGpuInfo.maxBufferSize,
    };
  }

  // Append a tier's resolved outcome to the per-walk path (the diagnostic
  // reports it). One entry per attempt, in attempt order.
  function recordPathOutcome(tier: Tier, outcome: LadderPathEntry['outcome']): void {
    ladderPath.push({
      modelName: tier.modelName,
      device: tier.device,
      dtype: tier.dtype,
      outcome,
    });
  }

  /**
   * Render the proactive terminal-failure bubble after the fallback ladder is
   * exhausted (ADR-R4/R5/R11). The model could not be loaded on any tier this
   * device tried, so instead of degrading silently to lazy loading we surface an
   * actionable headline, a line of guidance, the tiers tried, the copy-only
   * diagnostic, and two manual controls. Recovery is manual only: no auto-retry,
   * no timer (constraint 2).
   *
   * "Retry" re-walks the ladder skipping known-bad tiers (so it does not
   * re-crash on the same tier). After a full exhaustion this typically reaches
   * exhaustion again unless the environment changed, so it also offers "Reset
   * and re-detect", which clears the persisted record and re-walks from tier 0.
   * Both force-recreate the offscreen document first (ADR-R3/R4).
   */
  /**
   * Build the diagnostic input from the CURRENT live panel state (ADR-R11).
   * One source of truth for every diagnostic surface (the terminal bubble, the
   * network bubble, the always-available Copy affordance), so the rendered
   * report is consistent. Built on demand, never cached, never auto-sent. When
   * no error has occurred the caller passes `null` and the error fields read as
   * `none`.
   */
  function buildDiagnosticInput(err: unknown) {
    const { errorClass, errorMessage } = err === null ? NO_ERROR : errorInfo(err);
    return {
      device: lastGpuInfo.device,
      isFallback: lastGpuInfo.isFallback,
      maxBufferSize: lastGpuInfo.maxBufferSize,
      chosenModel,
      // The last tier attempted (null only if the walk never started a tier,
      // e.g. a recreate failure before the first load, or no walk has run).
      activeTier: activeTier
        ? { modelName: activeTier.modelName, device: activeTier.device, dtype: activeTier.dtype }
        : null,
      // A fresh copy each build so the diagnostic captures a stable snapshot of
      // the path and never shares the mutable accumulator.
      ladderPath: ladderPath.slice(),
      errorClass,
      errorMessage,
      extensionVersion: safeManifestVersion(),
      userAgent: navigator.userAgent,
    };
  }

  function renderTerminalFailure(err: unknown): void {
    // Record for the always-available Copy affordance so a later copy carries
    // this failure even after the bubble is dismissed.
    lastWarmError = err;
    // classifyFailure annotates the console log; the terminal UI is shown for
    // any exhausted ladder, since the load not completing IS the release-gate
    // scenario this feature removes the silent death from.
    const failureClass = classifyFailure(err);
    const { errorMessage } = errorInfo(err);
    const diagnostic = buildDiagnostic(buildDiagnosticInput(err));
    console.warn(
      `[local-nano] warmup failed (${failureClass}); showing terminal UI:`,
      errorMessage,
    );

    // The human-readable "Tiers tried" line in the message body stays for quick
    // scanning; the structured per-tier outcomes live in the diagnostic block.
    const pathLine =
      ladderPath.length > 0
        ? `Tiers tried: ${ladderPath.map((e) => `${e.modelName}|${e.device}|${e.dtype}`).join(', ')}`
        : null;

    const bubble = addMessage(
      'system',
      [
        "Couldn't load the model on this device.",
        'Try Retry below; if it keeps failing, set "device": "wasm" in .env.json for a slower CPU fallback.',
        ...(pathLine ? [pathLine] : []),
        '',
        diagnostic,
      ].join('\n'),
    );

    // Shared re-walk driver for both controls. Routes through the single
    // serialized teardown + re-warm primitive (ADR-P6) so the terminal Retry,
    // the Reset, the future model switch, and the future idle re-warm all share
    // one path and can never overlap two loads. `resetFirst` clears the
    // persisted record so the walk starts from tier 0 again (Reset and
    // re-detect). `reloadModel` resets the warm flags, force-recreates the
    // document (ADR-R4), then re-runs the ladder via `ensureWarm`.
    const rewalk = (button: HTMLButtonElement, resetFirst: boolean) => {
      button.disabled = true;
      bubble.remove();
      void reloadModel({ resetCapability: resetFirst }).catch((recreateErr) => {
        // A failed recreate/clear (before the walk could start) leaves the panel
        // without a dead button: re-render the terminal message so the user can
        // act again. A failure inside the walk itself is already surfaced by
        // ensureWarm's own terminal rendering.
        renderTerminalFailure(recreateErr);
      });
    };

    const controls = window.document.createElement('div');
    controls.style.cssText = 'margin-top: 6px; display: flex; gap: 6px;';

    const retryBtn = window.document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.style.cssText = BUTTON_CSS;
    retryBtn.addEventListener('click', () => rewalk(retryBtn, false));

    const resetBtn = window.document.createElement('button');
    resetBtn.textContent = 'Reset and re-detect';
    resetBtn.style.cssText = BUTTON_CSS;
    resetBtn.addEventListener('click', () => rewalk(resetBtn, true));

    controls.append(retryBtn, resetBtn);
    bubble.appendChild(controls);
  }

  /**
   * Render the network/download-failure bubble (Phase 4, ADR-R10). Distinct
   * from the device-incapability terminal bubble: the device is capable, only
   * the HF weights fetch failed, so this is a retryable connection error. The
   * Retry re-runs `ensureWarm` against the SAME tier path (no recreate, no
   * ladder walk, no known-bad write) since nothing about the device changed.
   * The diagnostic is embedded too (cheap and useful), but the headline is
   * clearly network-flavored.
   */
  function renderNetworkFailure(err: unknown): void {
    lastWarmError = err;
    const { errorMessage } = errorInfo(err);
    const diagnostic = buildDiagnostic(buildDiagnosticInput(err));
    console.warn('[local-nano] warmup failed (network); showing connection message:', errorMessage);

    const bubble = addMessage(
      'system',
      ["Couldn't download the model. Check your connection and try again.", '', diagnostic].join(
        '\n',
      ),
    );

    const controls = window.document.createElement('div');
    controls.style.cssText = 'margin-top: 6px; display: flex; gap: 6px;';
    const retryBtn = window.document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.style.cssText = BUTTON_CSS;
    retryBtn.addEventListener('click', () => {
      retryBtn.disabled = true;
      bubble.remove();
      // The device is fine; only the download failed. Reset the warm flags and
      // re-run ensureWarm against the same tier path. No recreate (the document
      // is healthy) and the ladder/known-bad state is untouched (constraint 2:
      // single-shot, manual).
      warmStarted = false;
      modelReady = false;
      void ensureWarm();
    });
    controls.appendChild(retryBtn);
    bubble.appendChild(controls);
  }

  /**
   * Copy text to the clipboard (ADR-R11). Prefers the async
   * `navigator.clipboard.writeText`; on rejection or when the API is absent
   * (restricted contexts, older runtimes), falls back to a hidden textarea plus
   * the synchronous `document.execCommand('copy')`. Both paths are wrapped so a
   * failure resolves false rather than throwing. This is the ONLY side effect of
   * the diagnostic: nothing is sent, logged to the network, or persisted.
   */
  async function copyToClipboard(text: string): Promise<boolean> {
    const clip = (navigator as { clipboard?: { writeText?: (t: string) => Promise<void> } })
      .clipboard;
    if (clip?.writeText) {
      try {
        await clip.writeText(text);
        return true;
      } catch {
        // Fall through to the execCommand path below.
      }
    }
    try {
      const ta = window.document.createElement('textarea');
      ta.value = text;
      // Keep it out of the visible layout and off-screen.
      ta.style.cssText = 'position: fixed; top: -9999px; left: -9999px; opacity: 0;';
      window.document.body.appendChild(ta);
      ta.select();
      const ok = window.document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * Build the always-available "Copy diagnostic" affordance (ADR-R11, Task 5.3).
   * Present whenever the panel is open, independent of failure state. On click it
   * builds the diagnostic from the CURRENT live state (the last capability
   * snapshot, the current ladder path and chosen model, the most recent error if
   * any) and copies it locally. Copy-only: nothing is sent or persisted.
   */
  function makeCopyDiagnosticAffordance(): HTMLButtonElement {
    const btn = window.document.createElement('button');
    btn.textContent = 'Copy diagnostic';
    btn.setAttribute('aria-label', 'Copy diagnostic to clipboard');
    // Muted, unobtrusive header control (inserted into the panel header, left of
    // the close button), consistent with BUTTON_CSS but quieter so it never
    // competes with the chat. No absolute positioning: it lives in the header
    // flow, so it never overlays the close button.
    btn.style.cssText =
      'flex-shrink: 0; padding: 1px 6px; font: inherit; font-size: 11px; cursor: pointer; background: transparent; color: #999; border: 1px solid #555; border-radius: 4px;';
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;
    btn.addEventListener('click', () => {
      const text = buildDiagnostic(buildDiagnosticInput(lastWarmError));
      void (async () => {
        const ok = await copyToClipboard(text);
        btn.textContent = ok ? 'Copied' : 'Copy failed';
        if (restoreTimer) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
          btn.textContent = 'Copy diagnostic';
        }, 1500);
      })();
    });
    return btn;
  }

  /**
   * Shared muted-header-control style (the gear button mirrors the
   * Copy-diagnostic affordance: transparent background, muted color, small font,
   * `flex-shrink: 0` so it never crowds the close button).
   */
  const HEADER_CONTROL_CSS =
    'flex-shrink: 0; padding: 1px 6px; font: inherit; font-size: 11px; cursor: pointer; background: transparent; color: #999; border: 1px solid #555; border-radius: 4px;';

  /**
   * The gear/settings affordance (ADR-P6, P7, P11, P12). A muted header button
   * toggles an absolutely-positioned popover anchored under the header. The
   * popover stays inside the panel root so it inherits the panel's fixed
   * positioning and stacking context (the root is `z-index: 2147483647`) and is
   * removed with the panel. Hidden by default; the gear toggles it, and a
   * mousedown outside the popover or the gear closes it.
   *
   * Returns the gear button, the popover element, a `content` container later
   * tasks populate (model list, idle-timeout group, Load button), and `isOpen`/
   * `close` controls. `onOpen` runs each time the popover opens so the content
   * re-reads the latest preference (the current selection re-reads on next open,
   * Task 3.4). The outside-click listener is registered on the document so a
   * press anywhere off the popover dismisses it; it is inert while closed and
   * lives for the content-script lifetime like the panel.
   */
  function makeSettingsAffordance(onOpen: () => void): {
    gearBtn: HTMLButtonElement;
    popover: HTMLElement;
    content: HTMLElement;
    isOpen: () => boolean;
    close: () => void;
  } {
    const gearBtn = window.document.createElement('button');
    gearBtn.textContent = '⚙'; // gear glyph (U+2699)
    gearBtn.setAttribute('aria-label', 'Open model and idle settings');
    gearBtn.style.cssText = HEADER_CONTROL_CSS;

    const popover = window.document.createElement('div');
    popover.setAttribute('data-local-nano-popover', '');
    // Anchored under the header, inside the panel root's fixed/stacking context.
    // Hidden until the gear toggles it.
    popover.style.cssText =
      'display: none; position: absolute; top: 36px; right: 8px; width: 280px; max-height: 70%; overflow-y: auto; background: #2a2a2a; color: #eee; border: 1px solid #555; border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); padding: 10px; z-index: 1; font-size: 12px;';

    // The body later tasks fill (model rows, idle-timeout radios, Load button).
    const content = window.document.createElement('div');
    popover.appendChild(content);

    const isOpen = () => popover.style.display !== 'none';
    const open = () => {
      // Re-render the content from the latest stored preference each open so a
      // prior Load's new selection is reflected (Task 3.4).
      onOpen();
      popover.style.display = 'block';
    };
    const close = () => {
      popover.style.display = 'none';
    };

    gearBtn.addEventListener('click', (e) => {
      // Stop the bubbling so the outside-click listener below does not see this
      // same press and immediately re-close the popover it just opened.
      e.stopPropagation();
      if (isOpen()) close();
      else open();
    });

    // A press anywhere outside the popover and the gear closes it. Registered on
    // the document so a click elsewhere on the page (not just inside the panel)
    // dismisses it, matching the "click outside closes" affordance. The handler
    // is inert while the popover is closed (early-return), so it never interferes
    // with normal page interaction; it lives for the content-script lifetime
    // like the panel itself.
    window.document.addEventListener('mousedown', (e) => {
      if (!isOpen()) return;
      const target = e.target as Node;
      if (popover.contains(target) || gearBtn.contains(target)) return;
      close();
    });

    return { gearBtn, popover, content, isOpen, close };
  }

  /**
   * Attempt a single tier: warm the offscreen session with that
   * model/device/dtype. Resolves on a live session; throws the offscreen error
   * on a catchable load failure (a hard crash drops the channel, which surfaces
   * as a terminal-shaped throw too).
   */
  async function attemptTier(tier: Tier): Promise<void> {
    await warmupSession(tier);
  }

  function ensureWarm(): Promise<void> {
    // Coalesce onto an in-flight walk so panel-open, the proactive send-path,
    // and the serialized `reloadModel` never start a second concurrent load
    // (constraint 1 / ADR-P6). A finished warm (warmStarted true, none in
    // flight) stays a no-op, exactly as before.
    if (warmInFlight) return warmInFlight;
    if (warmStarted) return Promise.resolve();
    warmInFlight = runWarm().finally(() => {
      warmInFlight = null;
    });
    return warmInFlight;
  }

  async function runWarm(): Promise<void> {
    warmStarted = true;
    setLoadingState(actionBtn, i);
    // A live elapsed counter while the model loads. We deliberately do
    // NOT auto-fail on a timer: the first run downloads multi-GB weights
    // and a hard timeout false-fails a slow-but-healthy load (which is
    // exactly what a fixed 30s cap did). The ticking counter is the
    // proof-of-life that a static "Loading" lacked, and after
    // WARMUP_SLOW_NOTICE_MS we append remedies in case it really is
    // stuck — without giving up. The counter ticks across the WHOLE ladder
    // walk: per-rung re-entry does not reset the clock (single startedAt), so
    // the user sees one continuous proof-of-life and never learns about tier
    // internals. A fully exhausted ladder surfaces the terminal bubble below.
    const warmHint = addMessage('system', 'Loading model… 0s');
    const startedAt = Date.now();
    // Phased first-run progress (ADR-R10). `progressPhase` tracks where we are:
    // - 'none': no download frame seen yet; the elapsed counter is the hint
    //   (fallback for a fully cached load or a transport hiccup).
    // - 'downloading': real percent frames are arriving; the hint shows
    //   "Downloading model NN%" and the elapsed counter is suppressed so the
    //   user sees the real percentage, not a competing timer.
    // - 'gpu-loading': the download hit 100% but the session has not resolved;
    //   the hint shows the indeterminate "Loading into GPU…" with the elapsed
    //   counter resumed (the GPU compile/upload phase has no real percentage).
    let progressPhase: 'none' | 'downloading' | 'gpu-loading' = 'none';
    let progress: ProgressState = { percent: 0 };
    const elapsedHint = () => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      return Date.now() - startedAt >= WARMUP_SLOW_NOTICE_MS
        ? `Loading model… ${secs}s. Taking longer than usual. A first run downloads a few GB, so this can be slow — it's still working. If it seems truly stuck, reload the extension from chrome://extensions, or set "device": "wasm" in .env.json for a CPU fallback.`
        : `Loading model… ${secs}s (first run downloads the model; later loads start from cache).`;
    };
    const renderHint = () => {
      if (progressPhase === 'downloading') {
        warmHint.textContent = formatProgressText(progress.percent);
      } else if (progressPhase === 'gpu-loading') {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        warmHint.textContent = `${GPU_LOADING_TEXT} ${secs}s`;
      } else {
        warmHint.textContent = elapsedHint();
      }
    };
    renderHint();
    const ticker = setInterval(renderHint, 1000);
    // Subscribe to download-progress frames for this warmup invocation. Each
    // frame folds through the pure parser; the phase drives the hint text. The
    // subscription is fire-and-forget (no frames => the elapsed counter stays).
    // Cleaned up in the finally so a Retry/Reset re-walk opens a fresh port
    // against the recreated document.
    const unsubscribeProgress = subscribeProgress((loaded, total) => {
      progress = nextProgress(progress, { loaded, total });
      progressPhase = progress.percent >= 100 ? 'gpu-loading' : 'downloading';
      renderHint();
    });
    // Reset the per-walk ladder state so a Retry/Reset re-walk starts clean.
    activeTier = null;
    ladderPath = [];
    chosenModel = null;
    try {
      // Preflight: query the adapter BEFORE the heavy load so an
      // unsupported device gets an upfront advisory instead of a silent
      // crash mid-upload. Doubles as sizing the history threshold.
      // Non-fatal — the default threshold covers the typical case.
      try {
        const info = await getGpuInfo();
        lastGpuInfo = info;
        historyThreshold = deriveHistoryThreshold(info);
        debugLog(
          `[local-nano] history threshold: ${historyThreshold} (device=${info.device}, isFallback=${info.isFallback}, maxBufferSize=${info.maxBufferSize ?? 'n/a'}, configured=${info.configuredThreshold ?? 'n/a'})`,
        );
        const advisory = preflightWarning(info);
        if (advisory) addMessage('system', advisory);
      } catch (gpuErr) {
        // The preflight snapshot failed; keep the conservative lastGpuInfo so
        // the diagnostic still renders if warmup then fails.
        console.warn('[local-nano] gpu-info preflight failed; proceeding:', gpuErr);
      }

      // Classify device capability from the (possibly conservative) snapshot
      // and assemble the ladder accordingly (ADR-R8/R9). The chosen model heads
      // the walk when a preference is stored; otherwise this is identical to the
      // primary-only path (ADR-P4). With the smaller-model flag off and no
      // preference, `assembleLadderForModel` returns the primary ladder
      // unchanged, so the loop below is behaviorally identical to today; the
      // capability verdict only feeds the diagnostic until a flag is enabled.
      const capability = classifyCapability(lastGpuInfo);
      // Resolve the stored model preference into a catalog entry. An empty
      // preference or an unknown/stale stored id resolves to null, which
      // `assembleLadderForModel` treats as "no preference" (today's auto-pick,
      // ADR-P4). The gate seams are read so a future enabled gate surfaces its
      // entry; production gates are off, so only the two non-gated entries
      // resolve.
      const pref = await loadModelPref();
      const prefId = resolveModelId(pref);
      const entry =
        prefId === null
          ? null
          : findCatalogEntry(prefId, {
              largerEnabled: isLargerModelEnabled(),
            });
      const ladder = assembleLadderForModel({
        entry,
        capability,
        smallerEnabled: isSmallerModelEnabled(),
      });
      // The model the ladder selected: the model of the first tier it will
      // walk. Surfaced in the diagnostic so a bug report names the model even
      // when the walk crashes before recording an outcome. With the flag off
      // this is always the primary model.
      chosenModel = ladder.length > 0 ? ladder[0].modelName : null;

      // Drive the pure ladder reducer (ADR-R1/R6). On cold start, skip straight
      // to the persisted known-good tier (or the first non-known-bad tier); on a
      // load failure, record the known-bad tier, force-recreate the document
      // (ADR-R3/R4: never overlap; the prior generator's GPU memory is only freed
      // by recreating the document), then attempt the next rung. On exhaustion,
      // fall through to the terminal bubble.
      const extensionVersion = safeManifestVersion();
      const record = await loadCapabilityRecord(extensionVersion);
      const knownBadKeys = new Set((record?.knownBad ?? []).map(tierKey));
      const knownGoodKey = record?.knownGood ? tierKey(record.knownGood) : null;
      // When the user explicitly chose a model (entry !== null), only honor a
      // persisted known-good tier that belongs to THAT model. The assembled
      // ladder appends other models' tiers after the chosen model's, so a
      // known-good key from a previously-used model would otherwise make
      // firstTierIndex jump past the user's selection and load the old model
      // (ADR-P4: the selection heads the ladder). With no preference
      // (entry === null) the prior behavior is unchanged.
      const effectiveKnownGoodKey =
        entry !== null &&
        knownGoodKey !== null &&
        !entry.tiers.some((t) => tierKey(t) === knownGoodKey)
          ? null
          : knownGoodKey;

      let attemptedIndex = firstTierIndex(ladder, effectiveKnownGoodKey, knownBadKeys);
      let lastError: unknown = null;
      let loaded = false;
      // Set when a tier's failure was a weights-download/network error
      // (constraint 2 + ADR-R10): the device is capable, only the fetch failed,
      // so we show a distinct retryable connection message instead of advancing
      // the ladder, recording known-bad, or showing the terminal bubble.
      let networkFailed = false;

      while (attemptedIndex !== -1) {
        const tier = ladder[attemptedIndex];
        activeTier = tier;
        try {
          await attemptTier(tier);
          recordPathOutcome(tier, 'success');
          await recordKnownGood(extensionVersion, tier, capabilitySnapshot());
          loaded = true;
          break;
        } catch (err) {
          lastError = err;
          const loadClass = classifyLoadFailure(err);
          if (loadClass === 'network') {
            // The device is fine; the download failed. Do NOT record known-bad,
            // do NOT advance the ladder. Show the connection message with a
            // same-tier Retry and stop the walk here.
            recordPathOutcome(tier, 'network');
            debugLog(`[local-nano] tier ${tierKey(tier)} load failed (network); not advancing`);
            networkFailed = true;
            break;
          }
          recordPathOutcome(tier, 'load-failure');
          const failureClass = classifyFailure(err);
          debugLog(`[local-nano] tier ${tierKey(tier)} load failed (${failureClass}); advancing`);
          await recordKnownBad(extensionVersion, tier, capabilitySnapshot());
          knownBadKeys.add(tierKey(tier));
          const action = nextAction({
            ladder,
            attemptedIndex,
            outcome: 'load-failure',
            knownBadKeys,
          });
          if (action.kind === 'exhausted') {
            attemptedIndex = -1;
            break;
          }
          // Another rung remains: force-recreate the document BEFORE the next
          // attempt so the crashed/poisoned document never blocks it and two
          // loads never overlap (ADR-R3/R4). A recreate failure ends the walk.
          await recreateOffscreen();
          attemptedIndex = ladder.indexOf(action.tier);
        }
      }

      if (loaded) {
        modelReady = true;
        // Arm the idle-release window on LOAD, not just on generation. The panel
        // auto-warms on open, so a user who loads the model and walks away
        // WITHOUT chatting would otherwise leave a multi-GB session resident with
        // no release scheduled (touchIdle is also fired on generation start/end).
        // Firing here starts the inactivity countdown from load completion, so an
        // unused model is reclaimed after the configured timeout. Fire-and-forget;
        // touchIdle swallows its own errors so a failed schedule cannot break load.
        void touchIdle();
        // A successful load clears any prior failure from the on-demand
        // diagnostic (the Copy affordance now reports a healthy state).
        lastWarmError = null;
        if (warmHint.parentNode) warmHint.remove();
      } else if (networkFailed) {
        // A weights-download/network failure: distinct retryable connection
        // message (same tier on Retry, no recreate, no ladder walk).
        if (warmHint.parentNode) warmHint.remove();
        warmStarted = false;
        renderNetworkFailure(lastError);
      } else {
        // The ladder is exhausted: surface the terminal bubble with the
        // diagnostic, the tiers tried, and the manual controls. When the walk
        // was pre-exhausted (every tier was already known-bad from a prior run,
        // so the loop never ran and lastError is null), pass a synthetic error
        // so the diagnostic explains why instead of rendering errorMessage:none.
        if (warmHint.parentNode) warmHint.remove();
        warmStarted = false;
        renderTerminalFailure(
          lastError ??
            new Error(
              'All fallback options were already ruled out on this device from a prior run. Use "Reset and re-detect" to try again from the top.',
            ),
        );
      }
    } catch (err) {
      // An out-of-ladder failure (e.g. recreateOffscreen rejected between
      // rungs). Surface the terminal bubble; warmStarted is reset so a later
      // panel toggle can also retry.
      if (warmHint.parentNode) warmHint.remove();
      warmStarted = false;
      renderTerminalFailure(err);
    } finally {
      // Single cleanup point — the interval is cleared exactly once here
      // regardless of success or failure above. The progress subscription is
      // torn down here too, so success, failure, and Retry all release the
      // port (a Retry re-subscribes against the recreated document).
      clearInterval(ticker);
      unsubscribeProgress();
      // Only return to idle if a real send didn't sneak in ahead of us.
      // activeAbort is set inside the send paths, so respect it here.
      if (!activeAbort) setIdleState(actionBtn, i);
    }
  }

  // ---- Serialized teardown + re-warm primitive (ADR-P6, constraint 1) ----
  // A model switch and an idle re-warm are the same operation: tear down the
  // offscreen document (force-recreate) and re-warm against the resolved
  // model/tier. This is the ONE primitive both share, guarded by a single
  // in-flight lock so a user Load and any other re-warm trigger can never run
  // concurrently. The v0.2.0 OOM came from overlapping loads, so serialization
  // is a hard safety property. A re-warm already in flight short-circuits a
  // second request onto the same promise.
  let reWarmInFlight: Promise<void> | null = null;

  /**
   * Tear down and re-warm under one lock (ADR-P6). If a re-warm is already in
   * flight, returns that same promise so concurrent callers coalesce onto one
   * operation (exactly one recreate + one ladder walk run). Otherwise resets the
   * warm flags, optionally clears the persisted capability record (so a Reset
   * re-walks from tier 0), force-recreates the document, and walks the ladder.
   *
   * Caller precondition (ADR-P7): a model switch waits for an in-flight
   * generation rather than aborting it, so the caller (the Phase 3 Load button)
   * must not invoke this while a stream is in flight. This primitive enforces
   * the precondition defensively (early-return while `activeAbort` is set) and
   * NEVER aborts the active stream. It never starts a second `LanguageModel`
   * load: the recreate tears the whole document down first (constraint 1,
   * ADR-R3), and the offscreen side destroys the prior session before creating.
   */
  function reloadModel(opts?: { resetCapability?: boolean }): Promise<void> {
    if (reWarmInFlight) return reWarmInFlight;
    // Never overlap a live generation (ADR-P7): the caller is responsible for
    // waiting, but guard here so a stray call can never tear the document out
    // from under a streaming answer. Resolve as a no-op without aborting.
    if (activeAbort) return Promise.resolve();
    const resetCapability = opts?.resetCapability ?? false;
    reWarmInFlight = (async () => {
      // Serialize against an in-flight panel-open/proactive warm: wait for it to
      // settle before tearing the document down, or the recreate below would
      // overlap a walk in progress (two concurrent loads, the v0.2.0 OOM). The
      // in-flight warm renders its own failure UI, so swallow its rejection here.
      if (warmInFlight) {
        try {
          await warmInFlight;
        } catch {
          // In-flight warm failed and surfaced its own UI; proceed to re-warm.
        }
      }
      // Reset so ensureWarm runs a true re-walk (not a no-op) and the model is
      // treated as not-yet-ready until the walk succeeds.
      warmStarted = false;
      modelReady = false;
      if (resetCapability) await clearCapabilityRecord();
      await recreateOffscreen();
      await ensureWarm();
    })().finally(() => {
      reWarmInFlight = null;
    });
    return reWarmInFlight;
  }

  // ---- Always-available copy-diagnostic affordance (ADR-R11, Task 5.3) ----
  // Present whenever the panel is open, regardless of load state. Copy-only:
  // nothing leaves the device. Inserted into the header (left of the close
  // button) when content.ts supplies it, so it never overlays the close button;
  // falls back to the panel root otherwise (e.g. in tests).
  {
    const copyBtn = makeCopyDiagnosticAffordance();
    if (header) header.insertBefore(copyBtn, header.lastElementChild);
    else root.appendChild(copyBtn);
  }

  // ---- Gear settings popover (Phase 3, ADR-P6/P7/P11/P12) ----
  // The gear button mounts in the header next to the Copy-diagnostic control
  // (left of the close button), mirroring that affordance's header-mount with a
  // root fallback for the no-header test path. The popover lives inside the
  // panel root so it inherits the panel's fixed positioning and is removed with
  // the panel.
  //
  // Popover model-picker state (ADR-P12, select-then-Load). `pendingModelId` is
  // the user's not-yet-applied selection (initialized to the resolved
  // preference, or the default when none is stored); selecting a row only
  // updates it (no persist, no reload). The Load control (Task 3.4) commits it.
  // Re-read from storage on each popover open so a prior Load's new selection
  // shows next time. `currentModelId` is the persisted/resolved current model
  // (the marked row and the Load-enable baseline); `pendingModelId` is the
  // not-yet-applied selection. They are equal on open and after a successful
  // Load; a row click moves `pendingModelId` only.
  let currentModelId = DEFAULT_MODEL_ID;
  let pendingModelId = DEFAULT_MODEL_ID;

  // The currently-selected idle timeout (minutes, or null for "Never"). Unlike
  // the model, the timeout is not a multi-GB action, so it persists immediately
  // on change (ADR-P11); it does not wait for an explicit Load. Initialized from
  // the stored preference on each open. Phase 4 reads the stored value when
  // scheduling the alarm; this phase only persists it (no alarm wired here).
  let selectedIdleMinutes: number | null = DEFAULT_IDLE_TIMEOUT_MINUTES;

  /**
   * Build one selectable model row (ADR-P12): displayName, download size, and
   * the docs/models.md note, marked when it is the pending selection. The
   * default entry is labeled "(default)" (ADR-P4). Clicking the row sets the
   * pending selection only (no persist, no reload) and re-renders so the marker
   * (and the Load button, Task 3.4) reflect the change.
   */
  function buildModelRow(entry: CatalogEntry): HTMLElement {
    const row = window.document.createElement('div');
    row.setAttribute('data-model-id', entry.id);
    row.setAttribute('role', 'radio');
    // Focusable + key-activatable so keyboard users can select a model, not just
    // mouse users (the row is a div, not a native radio input).
    row.setAttribute('tabindex', '0');
    const selected = entry.id === pendingModelId;
    row.setAttribute('aria-checked', selected ? 'true' : 'false');
    row.style.cssText = `padding: 6px 8px; margin-bottom: 4px; border-radius: 4px; cursor: pointer; border: 1px solid ${selected ? '#0a5fa3' : '#444'}; background: ${selected ? '#143a52' : 'transparent'};`;

    const name = window.document.createElement('div');
    name.style.cssText = 'font-weight: 600;';
    name.textContent =
      entry.id === DEFAULT_MODEL_ID ? `${entry.displayName} (default)` : entry.displayName;

    const meta = window.document.createElement('div');
    meta.style.cssText = 'color: #aaa; font-size: 11px; margin-top: 2px;';
    meta.textContent = `${entry.downloadSize} — ${entry.note}`;

    row.append(name, meta);
    const selectRow = () => {
      pendingModelId = entry.id;
      renderPopoverContent();
    };
    row.addEventListener('click', selectRow);
    row.addEventListener('keydown', (e: KeyboardEvent) => {
      // Enter or Space activates the row like a click (radio semantics);
      // preventDefault stops Space from scrolling the popover.
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectRow();
      }
    });
    return row;
  }

  /**
   * Map an idle-timeout option to a stable attribute token: the minute count, or
   * `never` for the null ("release disabled") option. Used as the radio's
   * `data-idle-minutes` value and to derive a unique input id.
   */
  function idleOptionToken(minutes: number | null): string {
    return minutes === null ? 'never' : String(minutes);
  }

  /**
   * Render the idle-timeout radio group (ADR-P11): 5/15/60 min and Never, with
   * the stored/default option preselected. The timeout is not a multi-GB action,
   * so a change persists immediately via `setIdleTimeoutMinutes` (null for
   * Never) and triggers no reload or alarm. Phase 4 re-reads the persisted value
   * on the next `touchIdle`; no live alarm reschedule is required here.
   */
  function renderIdleTimeoutGroup(parent: HTMLElement): void {
    const heading = window.document.createElement('div');
    heading.style.cssText = 'font-weight: 600; margin: 10px 0 6px;';
    heading.textContent = 'Release model after';
    parent.appendChild(heading);

    const groupName = 'local-nano-idle-timeout';
    for (const option of IDLE_TIMEOUT_OPTIONS) {
      const token = idleOptionToken(option.minutes);
      const label = window.document.createElement('label');
      label.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 2px 0;';

      const radio = window.document.createElement('input');
      radio.type = 'radio';
      radio.name = groupName;
      radio.setAttribute('data-idle-minutes', token);
      radio.checked = option.minutes === selectedIdleMinutes;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        selectedIdleMinutes = option.minutes;
        // Persist immediately (ADR-P11). Fire-and-forget; a write failure logs
        // but does not block the UI (the choice is non-critical).
        void setIdleTimeoutMinutes(option.minutes).catch((err: unknown) => {
          console.warn('[local-nano] idle-timeout persist failed:', err);
        });
      });

      const text = window.document.createElement('span');
      text.textContent = option.label;
      label.append(radio, text);
      parent.appendChild(label);
    }
  }

  // The Load control (ADR-P6/P7): a single button reused across re-renders, plus
  // an unobtrusive note shown while a stream blocks the switch. Built once so the
  // refresh logic mutates one element rather than rebuilding it each render.
  const loadBtn = window.document.createElement('button');
  loadBtn.textContent = 'Load';
  loadBtn.setAttribute('data-load-model', '');
  loadBtn.style.cssText = `margin-top: 10px; ${BUTTON_CSS}`;
  const loadNote = window.document.createElement('div');
  loadNote.style.cssText = 'color: #aaa; font-size: 11px; margin-top: 4px; display: none;';
  loadNote.textContent = 'finishing current response…';
  loadBtn.addEventListener('click', () => {
    void applyPendingModel();
  });

  /**
   * Recompute the Load button's enabled state and the in-flight-stream note
   * (ADR-P6/P7). Enabled only when the pending selection differs from the
   * current one AND no stream is in flight (`activeAbort`) AND no re-warm is in
   * flight (`reWarmInFlight`). While a stream blocks the switch, the note
   * explains the wait rather than showing a hard error.
   */
  function refreshLoadControl(): void {
    const differs = pendingModelId !== currentModelId;
    const streaming = activeAbort !== null;
    const reloading = reWarmInFlight !== null;
    loadBtn.disabled = !differs || streaming || reloading;
    loadNote.style.display = differs && streaming ? 'block' : 'none';
  }

  /**
   * Persist the pending model id then run the serialized re-warm primitive
   * (ADR-P6, Phase 2): force-recreate the document and re-walk the ladder, now
   * resolving the new preference in `ensureWarm`. No-op while a stream is in
   * flight (the button is disabled, but guard defensively, ADR-P7) or while a
   * re-warm is already running (coalesced by `reWarmInFlight`). Closes the
   * popover on a successful switch; the standard `ensureWarm` failure UI
   * (terminal/network bubble, progress) covers a failed switch unchanged.
   */
  async function applyPendingModel(): Promise<void> {
    if (pendingModelId === currentModelId) return;
    if (activeAbort) return; // never tear down a live stream (ADR-P7)
    if (reWarmInFlight) return; // a switch is already running
    const target = pendingModelId;
    // Capture the prior stored preference so a failed switch can revert it.
    // setModelId must run BEFORE reloadModel (ensureWarm resolves the model from
    // storage), so we cannot defer the write; instead we undo it on failure so a
    // model that never loaded is not left as the persisted preference.
    const previousStoredId = resolveModelId(await loadModelPref());
    setLoadingState(actionBtn, i);
    refreshLoadControl();
    try {
      await setModelId(target);
      await reloadModel();
      // reloadModel resolves even when the ladder failed to load: ensureWarm
      // renders its own terminal/network bubble and resolves rather than
      // throwing, so promise resolution is NOT proof the model came up. Verify
      // modelReady before committing; on failure, throw so the catch reverts the
      // stored preference and the popover stays open for another choice.
      if (!modelReady) {
        throw new Error('model did not become ready after switch');
      }
      // The switch landed: the new id is the current selection, and the popover
      // re-reads it on next open. Close it now.
      currentModelId = target;
      settings.close();
    } catch (err) {
      // ensureWarm renders its own failure UI; log for the console trail.
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[local-nano] model switch failed:', message);
      // Revert the persisted preference so the next session does not boot into a
      // model that never loaded (storage would otherwise diverge from the
      // unchanged in-memory currentModelId). Fire-and-forget; a revert failure
      // only logs.
      void setModelId(previousStoredId).catch((revertErr: unknown) => {
        console.warn('[local-nano] model preference revert failed:', revertErr);
      });
    } finally {
      // Restore the action button if the re-warm never reached ensureWarm's own
      // idle-restore (e.g. recreateOffscreen threw before the walk ran). Guard on
      // activeAbort exactly like ensureWarm so a stream that started meanwhile is
      // never stomped. refreshLoadControl re-enables the Load button.
      if (!activeAbort) setIdleState(actionBtn, i);
      refreshLoadControl();
    }
  }

  // Expose the refresh to the stream lifecycle (ADR-P7): when a stream settles,
  // `runStreamTurn` calls this so a queued switch re-enables.
  refreshPopoverControls = refreshLoadControl;

  /**
   * Render the popover body from the current state: the visible catalog (gated
   * entries appear only when their gate flag is on, both off in production) as
   * selectable rows, then the idle-timeout group and the Load control. Called on
   * each open (after the preference is read) and whenever the pending selection
   * changes.
   */
  function renderPopoverContent(): void {
    const content = settings.content;
    content.replaceChildren();

    const modelHeading = window.document.createElement('div');
    modelHeading.style.cssText = 'font-weight: 600; margin-bottom: 6px;';
    modelHeading.textContent = 'Model';
    content.appendChild(modelHeading);

    for (const entry of listCatalog()) content.appendChild(buildModelRow(entry));

    renderIdleTimeoutGroup(content);
    content.append(loadBtn, loadNote);
    refreshLoadControl();
  }

  /**
   * Re-read the persisted preference and reset the popover's pending model and
   * selected idle timeout to match, so each open reflects a Load (or timeout
   * change) committed since the last open. An unknown/stale stored model id
   * resolves to the default (ADR-P4) via the catalog gate seams; the idle
   * timeout falls back to the default when unset.
   */
  async function syncPopoverFromPref(): Promise<void> {
    const pref = await loadModelPref();
    const storedId = resolveModelId(pref);
    const resolved =
      storedId !== null &&
      findCatalogEntry(storedId, {
        largerEnabled: isLargerModelEnabled(),
      }) !== null
        ? storedId
        : DEFAULT_MODEL_ID;
    currentModelId = resolved;
    pendingModelId = resolved;
    // Use the loaded value directly: `loadModelPref` already returns the default
    // (15) for a missing/invalid record, so a `null` here is a deliberate
    // "Never" choice, not an unset field, and must not be coerced to the default.
    selectedIdleMinutes = pref.idleTimeoutMinutes;
    renderPopoverContent();
  }

  const settings = makeSettingsAffordance(() => {
    // Fire-and-forget: render synchronously from the prior state first (so the
    // popover is never empty), then refresh once the async preference read
    // resolves. The read is fast (one storage.local.get).
    renderPopoverContent();
    void syncPopoverFromPref();
  });
  if (header) header.insertBefore(settings.gearBtn, header.lastElementChild);
  else root.appendChild(settings.gearBtn);
  root.appendChild(settings.popover);

  // ---- Toggle listener ----
  let convertedAnchor = false;
  chrome.runtime.onMessage.addListener((m: typeof TOGGLE_MESSAGE) => {
    if (m.a !== TOGGLE_MESSAGE.a) return;
    if (root.style.display === 'none') {
      root.style.display = 'flex';
      if (!convertedAnchor) {
        const rect = root.getBoundingClientRect();
        root.style.left = `${rect.left}px`;
        root.style.right = 'auto';
        convertedAnchor = true;
      }
      i.focus();
      void ensureWarm();
    } else {
      root.style.display = 'none';
    }
  });

  // ---- Initial restore ----
  void restore();

  // The controller seam: Phase 3's gear-popover Load control drives the
  // serialized re-warm primitive through this handle. No UI calls it yet.
  return { reloadModel };
}
