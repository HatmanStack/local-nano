/**
 * Single source of truth for v0.2 DOM-aware actions.
 *
 * Every action the user can trigger (right-click menu entry or hotkey) is
 * declared once here as an `ActionDescriptor`. The background module
 * iterates `ACTION_DESCRIPTORS` to register the context menu; the
 * content script uses `kind` to decide between chat-mode and preview
 * mode; `runTransform` looks up the per-action system prompt.
 *
 * If you add a new action: extend the `ActionId` union, push a
 * descriptor onto `ACTION_DESCRIPTORS`, and (for write-side actions)
 * supply a `systemPrompt`. The tests in
 * `tests/transform-prompts.test.ts` enforce the table shape.
 */

/**
 * Maximum number of characters the selection (or chat-context wrapper
 * input) may carry. Matches the existing `PAGE_CONTEXT_BODY_LIMIT` so
 * users get a single mental model for token budgets. Exported so
 * Phase-3 callers can pre-flight a selection before dispatching a
 * transform.
 */
export const SELECTION_LIMIT = 1500;

export type ActionId =
  // Read-side (no preview; feed into chat)
  | 'ask_about_selection'
  | 'summarize_page'
  // Write-side, editable target (preview + apply)
  | 'rewrite_improve'
  | 'rewrite_shorter'
  | 'rewrite_formal'
  | 'rewrite_grammar'
  // Write-side, read-only prose target (preview + apply)
  | 'translate_en'
  | 'translate_es'
  | 'translate_fr'
  | 'simplify_in_place'
  | 'summarize_in_place';

/**
 * What the content script does with an action.
 * - `chat`: package the selection into the next chat turn (no preview).
 * - `page-chat`: synthetic chat turn that triggers existing pageContext.
 * - `transform-editable`: preview-then-apply against `<input>`/`<textarea>`/contenteditable.
 * - `transform-readonly`: preview-then-apply against read-only DOM prose.
 */
export type ActionKind = 'chat' | 'page-chat' | 'transform-editable' | 'transform-readonly';

export interface ActionDescriptor {
  id: ActionId;
  kind: ActionKind;
  /** User-visible text in the right-click menu. */
  label: string;
  /**
   * Literal submenu title string Chrome renders (e.g. `'Rewrite'`).
   * Descriptors sharing the same `parentLabel` group into a submenu.
   * Omitting it registers the descriptor as a top-level menu entry.
   */
  parentLabel?: string;
  /** `null` for chat / page-chat kinds — they don't run `runTransform`. */
  systemPrompt: string | null;
}

const REWRITE_IMPROVE_PROMPT =
  "You are a writing assistant. Rewrite the user's text to improve clarity, flow, and word choice while preserving meaning, tone, and approximate length. Output ONLY the rewritten text. Do not include any preamble, commentary, quotation marks, or labels.";

const REWRITE_SHORTER_PROMPT =
  "You are a writing assistant. Rewrite the user's text to be shorter while preserving its meaning and core message. Output ONLY the shortened text. Do not include any preamble, commentary, quotation marks, or labels.";

const REWRITE_FORMAL_PROMPT =
  "You are a writing assistant. Rewrite the user's text in a more formal, professional register while preserving its meaning. Output ONLY the rewritten text. Do not include any preamble, commentary, quotation marks, or labels.";

const REWRITE_GRAMMAR_PROMPT =
  "You are a proofreader. Fix grammar, spelling, and punctuation errors in the user's text while preserving meaning, tone, and style. If the text is already correct, return it unchanged. Output ONLY the corrected text. Do not include any preamble, commentary, quotation marks, labels, or list of changes.";

const TRANSLATE_EN_PROMPT =
  "You are a translator. Translate the user's text into English. If the text is already in English, return it unchanged. Output ONLY the translation. Do not include any preamble, commentary, quotation marks, labels, or source-language text.";

const TRANSLATE_ES_PROMPT =
  "You are a translator. Translate the user's text into Spanish. If the text is already in Spanish, return it unchanged. Output ONLY the translation. Do not include any preamble, commentary, quotation marks, labels, or source-language text.";

const TRANSLATE_FR_PROMPT =
  "You are a translator. Translate the user's text into French. If the text is already in French, return it unchanged. Output ONLY the translation. Do not include any preamble, commentary, quotation marks, labels, or source-language text.";

const SIMPLIFY_PROMPT =
  "You are a writing assistant. Rewrite the user's text in simpler language suitable for a general audience. Preserve the meaning. Output ONLY the simplified text. Do not include any preamble, commentary, quotation marks, or labels.";

const SUMMARIZE_IN_PLACE_PROMPT =
  "You are a writing assistant. Summarize the user's text in 1-3 sentences, preserving the core meaning. Output ONLY the summary. Do not include any preamble, commentary, quotation marks, labels, or bullet lists.";

const REWRITE_PARENT = 'Rewrite';
const TRANSFORM_PARENT = 'Translate / Simplify / Summarize in place';

/**
 * The canonical action table. Each descriptor is deep-frozen so
 * accidental mutation in callers (e.g. overwriting `systemPrompt` at
 * runtime) shows up as a TypeError in strict mode rather than silently
 * corrupting every later transform.
 */
export const ACTION_DESCRIPTORS: readonly ActionDescriptor[] = Object.freeze([
  // Read-side actions — top-level menu entries.
  Object.freeze({
    id: 'ask_about_selection',
    kind: 'chat',
    label: 'Ask local-nano about this',
    systemPrompt: null,
  }),
  Object.freeze({
    id: 'summarize_page',
    kind: 'page-chat',
    label: 'Summarize this page',
    systemPrompt: null,
  }),
  // Rewrite submenu (editable targets).
  Object.freeze({
    id: 'rewrite_improve',
    kind: 'transform-editable',
    label: 'Improve writing',
    parentLabel: REWRITE_PARENT,
    systemPrompt: REWRITE_IMPROVE_PROMPT,
  }),
  Object.freeze({
    id: 'rewrite_shorter',
    kind: 'transform-editable',
    label: 'Make shorter',
    parentLabel: REWRITE_PARENT,
    systemPrompt: REWRITE_SHORTER_PROMPT,
  }),
  Object.freeze({
    id: 'rewrite_formal',
    kind: 'transform-editable',
    label: 'Make formal',
    parentLabel: REWRITE_PARENT,
    systemPrompt: REWRITE_FORMAL_PROMPT,
  }),
  Object.freeze({
    id: 'rewrite_grammar',
    kind: 'transform-editable',
    label: 'Fix grammar',
    parentLabel: REWRITE_PARENT,
    systemPrompt: REWRITE_GRAMMAR_PROMPT,
  }),
  // Read-only transform submenu.
  Object.freeze({
    id: 'translate_en',
    kind: 'transform-readonly',
    label: 'To English',
    parentLabel: TRANSFORM_PARENT,
    systemPrompt: TRANSLATE_EN_PROMPT,
  }),
  Object.freeze({
    id: 'translate_es',
    kind: 'transform-readonly',
    label: 'To Spanish',
    parentLabel: TRANSFORM_PARENT,
    systemPrompt: TRANSLATE_ES_PROMPT,
  }),
  Object.freeze({
    id: 'translate_fr',
    kind: 'transform-readonly',
    label: 'To French',
    parentLabel: TRANSFORM_PARENT,
    systemPrompt: TRANSLATE_FR_PROMPT,
  }),
  Object.freeze({
    id: 'simplify_in_place',
    kind: 'transform-readonly',
    label: 'Simplify',
    parentLabel: TRANSFORM_PARENT,
    systemPrompt: SIMPLIFY_PROMPT,
  }),
  Object.freeze({
    id: 'summarize_in_place',
    kind: 'transform-readonly',
    label: 'Summarize',
    parentLabel: TRANSFORM_PARENT,
    systemPrompt: SUMMARIZE_IN_PLACE_PROMPT,
  }),
]);

/**
 * Look up the descriptor for an action id. Throws if the id is unknown.
 * Used by the background menu registrar and the content-script
 * dispatcher to translate a chrome.contextMenus click into a typed
 * action.
 */
export function actionToDescriptor(actionId: ActionId): ActionDescriptor {
  const match = ACTION_DESCRIPTORS.find((d) => d.id === actionId);
  if (!match) throw new Error(`Unknown action: ${actionId}`);
  return match;
}

/**
 * Look up the system prompt for a transform action. Throws for chat /
 * page-chat ids (their `systemPrompt` is `null`) and for unknown ids —
 * both cases indicate a programming error in the caller.
 */
export function actionToPrompt(actionId: ActionId): string {
  const descriptor = actionToDescriptor(actionId);
  if (descriptor.systemPrompt === null) {
    throw new Error(
      `Action '${actionId}' is a ${descriptor.kind}-kind action and has no system prompt`,
    );
  }
  return descriptor.systemPrompt;
}

export interface SelectionCheck {
  ok: boolean;
  /** Error message suitable for surfacing to the user. */
  error?: string;
}

/**
 * Pure pre-flight check against `SELECTION_LIMIT`. Callers (Preview UI,
 * chat-context packager) use this to surface "selection too long" or
 * "no selection" errors *before* dispatching a transform, so the user
 * sees the limit before any model work begins.
 */
export function checkSelection(text: string): SelectionCheck {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, error: 'No selection.' };
  if (text.length > SELECTION_LIMIT) {
    return {
      ok: false,
      error: `Selection too long. Maximum ${SELECTION_LIMIT} characters.`,
    };
  }
  return { ok: true };
}

/**
 * Build the chat-context wrapper text used by `ask_about_selection`.
 * Returns the exact string prefilled into the chat input. The model
 * consumes this verbatim, so quotation marks inside the selection are
 * not escaped — there is no HTML rendering path.
 */
export function selectionChatPrefill(text: string): string {
  return `Selection: "${text}"\n\nAsk: `;
}
