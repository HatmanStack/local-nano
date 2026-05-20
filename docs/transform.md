# Selection-driven in-place rewrite

## Overview

Highlight prose on any page, type an editing instruction into the chat
input, and the on-device model rewrites the selected text in place.
Tokens stream directly into the DOM, replacing the original text as they
arrive. The instruction and rewrite become a normal turn in the chat
thread, so the panel keeps a history of edits. A single-level Undo
button on the resulting model bubble restores the original text from a
JS-memory snapshot.

## How to use

1. Highlight a sentence or paragraph on the page.
1. Toggle the panel with `Ctrl+Shift+K` if it is not already open.
1. The input placeholder swaps to `Edit selection…` and a preview chip
   appears above the input.
1. Type an instruction (for example "make this more concise") and press
   Enter. Tokens stream into the highlighted range as they arrive.
1. After streaming completes, an Undo button is added to the model
   bubble. Click it to restore the original text.

To ask a question about the selection without rewriting it, press
`Esc` inside the input. The placeholder swaps to `Ask about
selection…`; sending now produces a normal chat answer and leaves the
DOM untouched. Press `Esc` again to switch back to Edit mode.

## Undo

- Single level. Each rewrite has its own Undo button on its model
  bubble.
- JS-memory only. Reloading the tab or navigating to a new page loses
  any undo history.
- If the page mutates or removes the rewritten node before Undo is
  clicked, the button label changes to `Undo failed` and a console
  warning is logged.

## What's supported

- Plain text-bearing elements (`<p>`, `<div>`, `<li>`, `<span>`,
  headings, blockquotes, and similar).
- Public web pages with standard DOM selections.

Out of scope for v0.2.3 (queued for v0.3.0):

- `<input>` and `<textarea>` selections. These use a different
  selection API and need synthetic `input` events to notify frameworks.
- `contenteditable` regions. Gmail, Google Docs, Notion, and similar
  apps own their own undo stacks and have site-specific IME quirks.
  These selections are detected and silently fall back to chat mode;
  the placeholder does not flip and no rewrite happens.

## Architecture constraints inherited from v0.2.0

The v0.2.0 release shipped the same conceptual feature and was reverted
after a WebGPU OOM regression. v0.2.3 is the rewrite. Three
non-negotiable constraints carry over:

1. **Single offscreen `LanguageModel` session.** Transforms reuse the
   long-lived session created by `offscreen.ts:ensureSession`. No new
   call to `LanguageModel.create()` exists in the diff. A second model
   instance was the v0.2.0 OOM root cause; reusing the chat session
   forecloses it by construction.

1. **Bounded selection payload.** Selection text plus up to 200 chars
   of context before and 200 chars after, with a hard cap of 700 chars
   total on the prompt-side selection text. Larger selections are
   truncated for the prompt but the full original is preserved for
   Undo.

1. **Soft output cap.** The polyfill's transformers backend bakes
   `max_new_tokens: 2048` at session-create time and we accept that
   ceiling. Per call, we compute
   `softCap = max(256, inputTokens * 2)` from a real token count via
   `session.measureContextUsage()`, and embed the number in the
   prompt as a guidance hint. If the polyfill round-trip exceeds
   100ms, we fall back to `Math.ceil(text.length / 3)`. The cap is
   advisory; the bounded selection size plus the prompt hint keep
   real-world outputs well under 2048.

## v0.3.0 follow-ups

- `<input>` / `<textarea>` / `contenteditable` selection support.
- Multi-level undo across multiple rewrites.
- Structural edits (lists, headings, blockquotes) rather than plain
  text-content replacement.
- Persisted undo across navigation.

## Privacy

Selection text never leaves the device. It is processed by the same
offscreen `LanguageModel` session that handles chat, which runs the
model locally in an offscreen document via WebGPU. No outbound network
calls are made by the rewrite path.
