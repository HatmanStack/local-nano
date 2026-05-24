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
import { CAPABLE_MIN_BUFFER_BYTES } from './offscreen/capability.js';
import {
  type CapabilitySnapshot,
  clearCapabilityRecord,
  loadCapabilityRecord,
  recordKnownBad,
  recordKnownGood,
} from './offscreen/capability-store.js';
import {
  countTokens,
  getGpuInfo,
  rebuildSession,
  recreateOffscreen,
  streamPrompt,
  warmupSession,
} from './offscreen/client.js';
import { buildDiagnostic, errorInfo } from './offscreen/diagnostic.js';
import { classifyFailure } from './offscreen/failure.js';
import {
  firstTierIndex,
  nextAction,
  PRIMARY_LADDER,
  type Tier,
  tierKey,
} from './offscreen/ladder.js';
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

export function initSession(deps: SessionDeps): void {
  const {
    root,
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

    let modelText = '';
    let firstChunk = true;
    const onChunk = (chunk: string) => {
      if (firstChunk) {
        if (preHint?.parentNode) preHint.remove();
        responseEl.textContent = '';
        firstChunk = false;
      }
      extraOnChunk?.(chunk);
      modelText += chunk;
      responseEl.textContent = modelText;
      messages.scrollTop = messages.scrollHeight;
    };
    let succeeded = false;
    try {
      await streamPrompt(prompt, { signal: activeAbort.signal, onChunk });
      succeeded = true;
    } catch (err: unknown) {
      const name = (err as { name?: unknown })?.name;
      if (name === 'AbortError') {
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
  // Captured during the ensureWarm preflight so the failure path can feed the
  // diagnostic the same adapter snapshot the load saw. Conservative default
  // (ADR-R11 / Task 1.4) until the preflight resolves.
  let lastGpuInfo: GpuInfoSnapshot = {
    device: 'webgpu',
    isFallback: false,
    maxBufferSize: null,
    configuredThreshold: null,
  };
  // The tier last attempted and the ordered list of tiers tried this walk
  // (ADR-R1: the panel owns ladder state). The terminal diagnostic reports
  // the active tier and the path; persistence keys off the attempted tier.
  let activeTier: Tier | null = null;
  let ladderPath: Tier[] = [];

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
  function renderTerminalFailure(err: unknown): void {
    // classifyFailure annotates the console log; the terminal UI is shown for
    // any exhausted ladder, since the load not completing IS the release-gate
    // scenario this feature removes the silent death from.
    const failureClass = classifyFailure(err);
    const { errorClass, errorMessage } = errorInfo(err);
    const diagnostic = buildDiagnostic({
      device: lastGpuInfo.device,
      isFallback: lastGpuInfo.isFallback,
      maxBufferSize: lastGpuInfo.maxBufferSize,
      // The last tier attempted when the ladder gave up (null only if the walk
      // never started a tier, e.g. a recreate failure before the first load).
      activeTier: activeTier
        ? { modelName: activeTier.modelName, device: activeTier.device, dtype: activeTier.dtype }
        : null,
      errorClass,
      errorMessage,
      extensionVersion: chrome.runtime.getManifest().version,
    });
    console.warn(
      `[local-nano] warmup failed (${failureClass}); showing terminal UI:`,
      errorMessage,
    );

    // Phase 2 carries the ladder path in the message text via a simple join; the
    // structured diagnostic field is deferred to Phase 5.
    const pathLine =
      ladderPath.length > 0 ? `Tiers tried: ${ladderPath.map(tierKey).join(', ')}` : null;

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

    // Shared re-walk driver for both controls. Force-recreates the document
    // (ADR-R4) then re-runs the ladder. `resetFirst` clears the persisted record
    // so the walk starts from tier 0 again (Reset and re-detect).
    const rewalk = (button: HTMLButtonElement, resetFirst: boolean) => {
      button.disabled = true;
      bubble.remove();
      // Reset so ensureWarm runs again; both flags clear so a true retry (not a
      // no-op) happens and the model is treated as not-yet-ready.
      warmStarted = false;
      modelReady = false;
      void (async () => {
        try {
          if (resetFirst) await clearCapabilityRecord();
          await recreateOffscreen();
        } catch (recreateErr) {
          // A failed recreate/clear leaves the panel without a dead button:
          // re-render the terminal message so the user can act again.
          renderTerminalFailure(recreateErr);
          return;
        }
        await ensureWarm();
      })();
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
   * Attempt a single tier: warm the offscreen session with that
   * model/device/dtype. Resolves on a live session; throws the offscreen error
   * on a catchable load failure (a hard crash drops the channel, which surfaces
   * as a terminal-shaped throw too).
   */
  async function attemptTier(tier: Tier): Promise<void> {
    await warmupSession(tier);
  }

  async function ensureWarm(): Promise<void> {
    if (warmStarted) return;
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
    const renderHint = () => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      warmHint.textContent =
        Date.now() - startedAt >= WARMUP_SLOW_NOTICE_MS
          ? `Loading model… ${secs}s. Taking longer than usual. A first run downloads a few GB, so this can be slow — it's still working. If it seems truly stuck, reload the extension from chrome://extensions, or set "device": "wasm" in .env.json for a CPU fallback.`
          : `Loading model… ${secs}s (first run downloads the model; later loads start from cache).`;
    };
    renderHint();
    const ticker = setInterval(renderHint, 1000);
    // Reset the per-walk ladder state so a Retry/Reset re-walk starts clean.
    activeTier = null;
    ladderPath = [];
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

      // Drive the pure ladder reducer (ADR-R1/R6). On cold start, skip straight
      // to the persisted known-good tier (or the first non-known-bad tier); on a
      // load failure, record the known-bad tier, force-recreate the document
      // (ADR-R3/R4: never overlap; the prior generator's GPU memory is only freed
      // by recreating the document), then attempt the next rung. On exhaustion,
      // fall through to the terminal bubble.
      const extensionVersion = chrome.runtime.getManifest().version;
      const record = await loadCapabilityRecord(extensionVersion);
      const knownBadKeys = new Set((record?.knownBad ?? []).map(tierKey));
      const knownGoodKey = record?.knownGood ? tierKey(record.knownGood) : null;

      let attemptedIndex: number | null = firstTierIndex(
        PRIMARY_LADDER,
        knownGoodKey,
        knownBadKeys,
      );
      let lastError: unknown = null;
      let loaded = false;

      while (attemptedIndex !== -1) {
        const tier = PRIMARY_LADDER[attemptedIndex];
        activeTier = tier;
        ladderPath.push(tier);
        try {
          await attemptTier(tier);
          await recordKnownGood(extensionVersion, tier, capabilitySnapshot());
          loaded = true;
          break;
        } catch (err) {
          lastError = err;
          const failureClass = classifyFailure(err);
          debugLog(`[local-nano] tier ${tierKey(tier)} load failed (${failureClass}); advancing`);
          await recordKnownBad(extensionVersion, tier, capabilitySnapshot());
          knownBadKeys.add(tierKey(tier));
          const action = nextAction({
            ladder: PRIMARY_LADDER,
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
          attemptedIndex = PRIMARY_LADDER.indexOf(action.tier);
        }
      }

      if (loaded) {
        modelReady = true;
        if (warmHint.parentNode) warmHint.remove();
      } else {
        // The ladder is exhausted: surface the terminal bubble with the
        // diagnostic, the tiers tried, and the manual controls.
        if (warmHint.parentNode) warmHint.remove();
        warmStarted = false;
        renderTerminalFailure(lastError);
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
      // regardless of success or failure above.
      clearInterval(ticker);
      // Only return to idle if a real send didn't sneak in ahead of us.
      // activeAbort is set inside the send paths, so respect it here.
      if (!activeAbort) setIdleState(actionBtn, i);
    }
  }

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
}
