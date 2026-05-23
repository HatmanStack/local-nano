# Feedback Log

## Active Feedback

## Resolved Feedback

### FINAL_REVIEW (2026-05-19)

#### Implementation-level

1. **Task 9 manual smoke test deferral is silently dropped.**
   **Resolution:** Added a "Verification status" paragraph to the
   `### Notes` section of `CHANGELOG.md`'s `## [0.2.3]` block and a
   new `## Verification status` section to `docs/transform.md` (just
   above `## v0.3.0 follow-ups`) listing the eight manual smoke-test
   steps that need to be run against a real Chrome + WebGPU build
   before treating the happy path as proven. Markdownlint stays
   green; the rest of the suite is unaffected.

#### Notes (not blockers)

- **Branch policy violation by user instruction.** The Phase-0 "feature
  branch" rule was overridden by the user (commits 92210d9 …
  c7782fc landed directly on `main`). Per the task brief, this is logged
  but not a defect.

- **Minor dead-code smell in `src/selection-rewrite.ts`.** The
  `lastFromEnd` local in `collectBeforeContext` (lines 113, 136, 149) is
  written but never read; only kept alive via a `void lastFromEnd;`
  statement to satisfy the linter. Cosmetic only — remove on the next
  touch of this file, not now.

### PLAN_REVIEW (2026-05-19)

#### Critical Issues

1. **Missing storage round-trip test for rewrite turns.**
   **Resolution:** Added a new test case to Phase-1 Task 5 ("Rewrite send
   on success persists both turns to `chrome.storage.local` under the
   per-URL key") that reads the storage store after the rewrite resolves
   and asserts both the user-instruction entry and the model-rewrite
   entry land under the per-URL key. Cross-referenced the existing
   chat-path coverage at `tests/session.test.ts:248-266` so the
   implementer follows the same shape.

1. **Selection-survival-across-input-focus deferred to manual smoke
   only.** **Resolution:** Picked option (a) from the feedback. Extracted
   the snapshot-decision logic into a new pure function
   `decideSnapshot({ activeEl, inputEl, selection }): SelectionSnapshot |
   null` exported from `src/selection-rewrite.ts`. Phase-1 Task 4 now
   lists `decideSnapshot` in the module surface, has an implementation
   step describing the suppression rule, and adds three unit-test cases:
   returns `null` when `activeEl === inputEl`, returns
   `snapshotSelection(selection)` otherwise, returns `null` when
   `selection` is null. Phase-1 Task 6 was simplified so the
   `selectionchange` handler in `content.ts` is a one-liner that
   delegates to `decideSnapshot`; the suppression rule is no longer
   duplicated in the content script and the load-bearing behavior is
   covered in CI.

1. **Phase-0 / Phase-1 inconsistency on soft-cap prompt units.**
   **Resolution:** Picked tokens (recommended option in the feedback).
   Updated Phase-0 ADR-002 to say "Aim for roughly N **tokens**" so it
   matches Phase-1 Task 4's prompt template and the `softCapTokens`
   variable name. Added a sentence noting that the prompt unit and the
   variable unit now agree, so the model gets one consistent number and
   the implementer has one consistent spec.

#### Suggestions

1. **Placeholder-kludge in the soft-cap computation.** **Resolution:**
   Rewrote Phase-1 Task 5 step 5.iii to count tokens on the content
   payload directly (`${snap.before}\n${snap.text}\n${snap.after}\n${instruction}`)
   rather than on the framed prompt with a placeholder cap. The
   double-build is gone; the count is independent of the cap digit;
   added a short paragraph explaining the choice so a future reviewer
   does not read it as a bug.

1. **Selection preview chip palette mismatch.** **Resolution:** Updated
   Phase-1 Task 5 step 7 to use the existing panel palette
   (`background: #333; color: #eee`) matching the header at
   `content.ts:38`. The chip now reads as part of the panel without a
   new color-decision question.

1. **Cross-reference from ADR-002 to the timeout fallback in ADR-003.**
   **Resolution:** Added a "Fallback behavior when `measureContextUsage`
   is slow" paragraph to Phase-0 ADR-002 that names the 100ms timeout
   and the `Math.ceil(text.length / 3)` heuristic and points to ADR-003
   for the full racing semantics.

1. **Phase-1 Task 2 listener-pattern ambiguity.** **Resolution:**
   Rewrote Task 2's first implementation step to explicitly note that
   either pattern (a second `chrome.runtime.onMessage` listener, or a
   second branch inside the existing rebuild-session listener) is
   acceptable; the plan does not prefer one. The implementer picks
   whichever reads cleaner alongside the surrounding code.
