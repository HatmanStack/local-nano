/**
 * Strip reasoning-model "thinking" blocks from model output.
 *
 * Reasoning models (Qwen3, DeepSeek-R1, etc.) emit a `<think>…</think>` block of
 * chain-of-thought before the final answer. We display only the answer.
 *
 * This is a PURE function over the FULL accumulated raw text, not per-chunk
 * deltas. The streaming caller recomputes the visible text from the whole raw
 * buffer on every chunk, so markers split across chunk boundaries (e.g. `<thi`
 * then `nk>`) resolve naturally as more text arrives — the caller needs no
 * partial-marker state of its own.
 *
 * Rules:
 * - Complete `<think>…</think>` blocks are removed entirely (markers + inner).
 * - An as-yet-unclosed `<think>` (still thinking mid-stream) hides everything
 *   from the marker onward, so reasoning never flashes into view.
 * - A trailing partial of the opening marker (e.g. "<thi" still arriving) is held
 *   back, so the literal "<think>" never flickers before it resolves.
 * - Leading whitespace left where a block was removed is trimmed.
 * - Text with no `<think>` passes through unchanged (non-reasoning models), so
 *   applying this unconditionally is safe.
 *
 * Caveat: a model that legitimately emits a literal "<think>" as content (e.g.
 * answering a question *about* the tag) would have it stripped. That trade-off
 * favors the common reasoning-model case.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

export function stripThink(raw: string): string {
  let out = '';
  let i = 0;
  while (true) {
    const open = raw.indexOf(OPEN, i);
    if (open === -1) {
      out += raw.slice(i);
      break;
    }
    // Keep any text before the block (usually empty for reasoning models).
    out += raw.slice(i, open);
    const close = raw.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) {
      // Unclosed marker: still thinking — drop everything from here on.
      break;
    }
    i = close + CLOSE.length;
  }
  // Hold back a trailing run that could be the start of an opening marker still
  // arriving ("<", "<t", … "<think"), so it doesn't flash before it resolves.
  for (let n = Math.min(OPEN.length - 1, out.length); n > 0; n--) {
    if (out.endsWith(OPEN.slice(0, n))) {
      out = out.slice(0, out.length - n);
      break;
    }
  }
  return out.replace(/^\s+/, '');
}
