# Plan: DOM-Aware Actions (v0.2.0)

**Plan ID:** `2026-05-18-dom-aware-actions`
**Date:** 2026-05-18
**Repo:** `/home/christophergalliart/projects/local-nano`
**Source intake:** [`brainstorm.md`](brainstorm.md)
**Target release:** v0.2.0

## Overview

v0.1.x of `local-nano` is a per-tab chat panel that opens with a hotkey and
auto-prepends a 1500-character body excerpt on the first turn. v0.2 makes the
extension *DOM-aware*: users right-click on a selection (or trigger a hotkey),
and the extension either feeds that selection into the chat or transforms it
in place with a preview-then-apply UX. All inference still runs on-device.

This plan delivers four sub-features as a coherent v0.2:

1. **Selection-aware chat** (`Ask local-nano about this`) — selection text is
   packaged into the next chat turn.
1. **Page summary action** (`Summarize this page`) — synthetic user turn that
   uses the existing `pageContext()` plumbing.
1. **Inline rewrite** for `<input>` / `<textarea>` / `contenteditable` — preview
   the rewrite in the panel, then Apply replaces the captured `Range` in the
   page DOM.
1. **In-place transform** for read-only prose — translate / simplify /
   summarize a selection with the same preview-then-apply UX.

The architecture extends the existing MV3 surface: `chrome.contextMenus` is
registered from the background service worker, `chrome.tabs.sendMessage`
delivers the chosen action to the content script, and a new `runTransform`
path in the session module creates ephemeral `LanguageModel` sessions per
action with task-specific system prompts. The long-lived chat session and
existing per-URL history are untouched.

## Prerequisites

- Node.js 20+ (`node --version`)
- `npm install` run successfully
- Chrome 120+ available for manual smoke testing
- `.env.json` present at repo root (copy from `.env.example.json`)
- `npm run lint:ci && npm run typecheck && npm run coverage && npm run build`
  all exit 0 on the starting branch (v0.1.1 baseline)
- Read [Phase-0.md](Phase-0.md) before starting any task

## Phase Summary

| Phase | Tag | Goal | Approx Tokens | Approx Commits |
|-------|-----|------|---------------|----------------|
| Phase-0 | — | Architecture decisions, conventions, ADRs, testing strategy | n/a (read-only) | 0 |
| Phase-1 | IMPLEMENTER | Transform module: prompts, `runTransform`, action schema | ~28k | 4 |
| Phase-2 | IMPLEMENTER | Manifest + background: `contextMenus` permission, menu registration, command routing | ~22k | 4 |
| Phase-3 | IMPLEMENTER | Content script: selection capture, dispatch, preview UI, DOM apply | ~42k | 6 |
| Phase-4 | DOC-ENGINEER | Docs (`docs/dom-actions.md`, privacy, README, CHANGELOG); manifest version bump | ~10k | 3 |

**Total estimated commits:** ~17

## Navigation

| File | Role |
|------|------|
| [Phase-0.md](Phase-0.md) | Architecture decisions, project conventions, testing strategy |
| [Phase-1.md](Phase-1.md) | `[IMPLEMENTER]` Transform module and action schema |
| [Phase-2.md](Phase-2.md) | `[IMPLEMENTER]` Manifest, context-menu registration, command routing |
| [Phase-3.md](Phase-3.md) | `[IMPLEMENTER]` Content-script selection capture, preview UI, DOM apply |
| [Phase-4.md](Phase-4.md) | `[DOC-ENGINEER]` Docs and changelog |
| [feedback.md](feedback.md) | Plan Reviewer and Code Reviewer feedback channel |
| [brainstorm.md](brainstorm.md) | Source intake document |

## Scope Recap

### In

- `chrome.contextMenus` integration registered from the background worker
- New hotkeys (capped at Chrome's 4-command manifest limit; one slot already
  used by `toggle_ai_palette`)
- Selection snapshot via `Range.cloneRange()` (plus offset snapshot for
  `<input>` / `<textarea>`)
- Preview UI in the panel for write-side actions (Apply / Discard)
- Ephemeral `LanguageModel` sessions per transform, sharing the cached heavy
  modules
- DOM apply layer with three branches: `<input>`/`<textarea>`,
  `contenteditable`, read-only prose
- Unit tests for every new `src/` module; jsdom-level end-to-end flow tests
- `docs/dom-actions.md` plus privacy and README updates
- CHANGELOG `[0.2.0]` section

### Out

- Configurable translation languages (hardcoded EN/ES/FR — `.env.json`-driven
  in v0.3)
- Floating action button next to selection
- Streaming directly into the page (preview-then-apply is the only write path)
- Multi-step or chained transforms
- Custom undo stack for read-only prose mutations
- Re-anchoring after DOM mutation between right-click and Apply
- Multiple concurrent transforms (new transform aborts in-flight one)
- Right-click on images / links / non-text contexts
- Voice or non-text input
- Agentic / multi-step DOM manipulation
- Custom user prompts per action
- Selections inside cross-origin iframes (top-frame selections only)

## Definition of Done

The plan is complete when every phase passes its Phase Verification section
and the following all hold on the working branch:

1. `npm run lint:ci` exits 0
1. `npm run typecheck` exits 0
1. `npm run coverage` exits 0 with thresholds met
   (`lines/statements/functions >= 75%`, `branches >= 80%`)
1. `npm run build` exits 0 and produces `dist/content.js` and
   `dist/background.js`
1. `npx markdownlint-cli2 "docs/*.md" "README.md" "CHANGELOG.md"` exits 0
1. The loaded unpacked extension passes the manual smoke checklist documented
   in Phase-4
1. `manifest.json` and `package.json` both report `0.2.0`
1. `CHANGELOG.md` has a populated `[0.2.0]` section
