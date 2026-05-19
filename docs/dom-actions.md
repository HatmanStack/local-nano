# DOM-Aware Actions

In v0.2, `local-nano` is no longer just a chat panel that opens with a
hotkey. The extension now acts on the user's current selection or whole
page via a right-click menu and a small set of keyboard shortcuts. Every
action — read-side ("ask about this", "summarize this page") and
write-side (rewrite, translate, simplify, summarize in place) — runs
through the same on-device model used by the chat panel. Nothing about
this feature changes the network story.

## Menu structure

The right-click menu surfaces one or more top-level entries (and one
or two submenu groups) depending on the context — text selection,
editable field, or anywhere on the page. The labels below match what
Chrome renders verbatim; they come from the canonical id-to-label
table in `src/transform-prompts.ts`.

```text
| Menu item                                                         | Context                     | Behavior                                                                       |
| ----------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| Ask local-nano about this                                         | selection                   | Prefill chat input with the selection wrapped as context; user types question  |
| Summarize this page                                               | page (right-click anywhere) | Synthetic chat turn; page excerpt auto-prepended on first turn                 |
| Rewrite ▸ Improve writing                                         | editable                    | Preview + apply rewrite that improves clarity and flow                         |
| Rewrite ▸ Make shorter                                            | editable                    | Preview + apply rewrite that compresses                                        |
| Rewrite ▸ Make formal                                             | editable                    | Preview + apply rewrite in formal register                                     |
| Rewrite ▸ Fix grammar                                             | editable                    | Preview + apply grammar/spelling/punctuation fix                               |
| Translate / Simplify / Summarize in place ▸ To English            | selection                   | Preview + apply translation to English                                         |
| Translate / Simplify / Summarize in place ▸ To Spanish            | selection                   | Preview + apply translation to Spanish                                         |
| Translate / Simplify / Summarize in place ▸ To French             | selection                   | Preview + apply translation to French                                          |
| Translate / Simplify / Summarize in place ▸ Simplify              | selection                   | Preview + apply simpler-language rewrite                                       |
| Translate / Simplify / Summarize in place ▸ Summarize             | selection                   | Preview + apply 1-3 sentence summary                                           |
```

The `Rewrite` group is shown when the active selection lives inside an
`<input>`, `<textarea>`, or `contenteditable` element. The
`Translate / Simplify / Summarize in place` group is shown for any
selection (editable or read-only prose).

## Hotkeys

Chrome's manifest caps an extension at four `commands`. One slot is
already used by the panel toggle; the remaining three are assigned to
the most common selection-aware actions. Users can rebind any of these
at `chrome://extensions/shortcuts` without rebuilding.

```text
| Command id           | Default chord (Linux/Win) | Default chord (Mac) | Action                                       |
| -------------------- | ------------------------- | ------------------- | -------------------------------------------- |
| toggle_ai_palette    | Ctrl+Shift+K              | Cmd+Shift+K         | Open/close the chat panel                    |
| ask_about_selection  | Ctrl+Shift+L              | Cmd+Shift+L         | Ask about current selection                  |
| rewrite_selection    | Ctrl+Shift+I              | Cmd+Shift+I         | Rewrite current selection (Improve writing)  |
| translate_selection  | Ctrl+Shift+U              | Cmd+Shift+U         | Translate current selection to English       |
```

The other rewrite variants (Make shorter, Make formal, Fix grammar) and
the other translate / simplify / summarize variants are reachable only
via the right-click menu in v0.2 because the 4-command cap is already
exhausted.

## Preview-then-apply UX

Write-side actions (rewrite, translate, simplify, summarize in place)
never mutate the page until the user explicitly approves the result.

1. The panel switches into Preview mode. The captured selection text is
   shown on top; the streamed model output renders below as it arrives.
1. `Apply` is disabled while the stream is in flight and enabled when
   the stream completes.
1. Pressing `Apply` replaces the captured `Range` (or `<input>` /
   `<textarea>` selection offsets) in the page DOM with the model
   output. The panel returns to chat mode.
1. Pressing `Discard` — or pressing `Escape` while the preview is
   focused — clears the preview without touching the page. If a stream
   is still in flight, it is aborted first.
1. Browser-native undo (`Ctrl+Z` on Linux/Win, `Cmd+Z` on Mac) works on
   the Apply step for `<input>`, `<textarea>`, and `contenteditable`
   targets because the apply layer uses `setRangeText` and
   `execCommand('insertText')`. For read-only prose, the apply step is
   a direct DOM mutation; the browser's native undo stack does not
   cover it.

Selections are capped at 1500 characters (the same limit as the page
context excerpt). If the captured selection exceeds the cap, the
Preview renders an error message ("Selection too long. Maximum 1500
characters.") instead of starting the model — no tokens are spent on
input that the model cannot meaningfully process within the budget.

Only one transform may stream at a time. Triggering a new transform
while another is in flight aborts the in-flight stream and starts the
new one — consistent with the chat panel's existing Send/Stop
semantics.

## Privacy

The selection text and the chat input both become part of the prompt
to the on-device model. They do **not** leave your machine. The new
`contextMenus` permission is a UI-only Chrome API and grants no
additional network access. See [privacy.md](privacy.md) for the full
network egress story and the updated permissions table.

## Known limitations

- Selections inside cross-origin iframes are not supported in v0.2
  (top-frame selections only).
- Translation languages are hardcoded to English, Spanish, and French.
  Configurable language sets are deferred to v0.3.
- `contenteditable` widgets that intercept native input events
  (Notion, Google Docs, some rich-text frameworks) may behave
  unexpectedly during Apply. The apply layer uses
  `execCommand('insertText')` and falls back to direct `Range`
  mutation when that fails, but framework-specific guarantees are out
  of scope.
- If the page DOM mutates between the right-click snapshot and the
  Apply click, the captured `Range` may point to changed content.
  Re-anchoring after mutation is out of scope for v0.2.
- Only one transform may stream at a time; triggering a new transform
  aborts the in-flight one.
- The right-click menu currently shows v0.2 entries only on selection,
  page, and editable contexts. Right-click on images, links, or other
  non-text contexts is out of scope.

## How to add a new action

The action surface is intentionally data-driven so adding a new
right-click entry is a five-step change.

1. Add a new string literal to the `ActionId` union in
   `src/transform-prompts.ts`.
1. Add an `ActionDescriptor` entry to `ACTION_DESCRIPTORS` with the
   appropriate `kind`, `label`, `parentLabel`, and `systemPrompt`. The
   `parentLabel` field is the literal submenu title; descriptors that
   share a `parentLabel` group into one submenu in Chrome.
1. Add a test in `tests/transform-prompts.test.ts` for the new prompt
   (or extend the existing "every action has a prompt" sweep).
1. If the action needs a new hotkey, add it to `manifest.json`'s
   `commands` block — but be aware that Chrome caps a manifest at 4
   commands, and three of those slots are already used. Also add the
   command-to-action mapping in `src/background/handler.ts`'s
   `COMMAND_TO_ACTION` table.
1. If the action introduces a brand-new `kind` (something other than
   `chat`, `page-chat`, `transform-editable`, or `transform-readonly`),
   extend the `switch` in `descriptorToMenuProps`
   (`src/background/menus.ts`) and the `switch` in `dispatchAction`
   (`src/dom-actions.ts`). Actions that fit an existing `kind` need no
   content-script changes.

## Architecture pointer

Lower-level dataflow is described in [architecture.md](architecture.md).
The transform module is `src/transform.ts`; the action schema and
prompts live in `src/transform-prompts.ts`; the apply layer is
`src/dom-apply.ts`; the preview component is `src/ui/preview.ts`.
