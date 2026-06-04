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

/**
 * True when `s` is a non-empty proper prefix of `marker` (e.g. "<thi" for
 * "<think>"). Used to decide whether a trailing run might still resolve into a
 * marker as more bytes arrive, and so must be held back.
 */
function isPartialPrefix(s: string, marker: string): boolean {
  return s.length > 0 && s.length < marker.length && marker.startsWith(s);
}

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

/**
 * An incremental driver, provably equivalent to `stripThink` of the whole
 * accumulated buffer (see the equivalence/property test in
 * `tests/think-strip.test.ts`), but doing only O(delta) work per chunk instead
 * of rescanning the full buffer. Use it when the same stream is processed chunk
 * by chunk on a hot render path; `stripThink` stays the spec/oracle.
 *
 * State carried across chunks:
 * - `committed`: the confirmed outside-block text (raw, before the leading
 *   whitespace trim that `push` applies on output).
 * - `inThink`: whether we are inside an as-yet-unclosed `<think>` block.
 * - `pending`: a trailing run that cannot yet be classified. Outside a block it
 *   is a proper prefix of `<think>` held back so a partial OPEN marker never
 *   flashes; inside a block it is a proper prefix of `</think>` while we wait
 *   for the close marker. Bounded by the marker length, so the held-back tail
 *   is constant size.
 *
 * `committed` never contains a trailing partial OPEN (that lives in `pending`),
 * which is exactly the full-buffer function's hold-back rule, so the visible
 * output matches byte for byte.
 */
export interface ThinkStripper {
  /** Feed the next raw chunk; returns the new FULL visible text (append-only). */
  push(chunk: string): string;
}

export function createThinkStripper(): ThinkStripper {
  let committed = '';
  let inThink = false;
  // Buffer of bytes received but not yet classified (a partial marker run, or
  // the bytes following a `<` that have not yet diverged from / matched a marker).
  let pending = '';

  function consume(): void {
    // Resolve `pending` as far as possible, moving classified bytes into
    // `committed` (when outside a block) or discarding them (inside a block),
    // and leaving only an unresolved partial-marker tail behind.
    while (pending.length > 0) {
      if (!inThink) {
        const lt = pending.indexOf('<');
        if (lt === -1) {
          // No marker start at all — all of it is plain outside text.
          committed += pending;
          pending = '';
          return;
        }
        // Text before the first '<' is plain outside text.
        committed += pending.slice(0, lt);
        pending = pending.slice(lt);
        // `pending` now starts with '<'. Decide if it opens a block, is a
        // partial OPEN to hold back, or is a literal '<' to release.
        if (pending.startsWith(OPEN)) {
          inThink = true;
          pending = pending.slice(OPEN.length);
          continue; // re-enter loop in the in-block branch
        }
        if (isPartialPrefix(pending, OPEN)) {
          // Could still become `<think>` — hold the whole partial back.
          return;
        }
        // A '<' that is not (the start of) a marker: release the '<' to
        // committed and keep scanning the rest for the next marker.
        committed += '<';
        pending = pending.slice(1);
        continue;
      }
      // Inside a block: hide everything until `</think>` completes.
      const close = pending.indexOf(CLOSE);
      if (close !== -1) {
        inThink = false;
        pending = pending.slice(close + CLOSE.length);
        continue; // re-enter loop in the outside branch
      }
      // No complete close marker yet. Discard everything except a trailing run
      // that could be the start of `</think>` arriving across chunks; keep that
      // so the next chunk can complete it.
      for (let n = Math.min(CLOSE.length - 1, pending.length); n >= 1; n--) {
        if (pending.endsWith(CLOSE.slice(0, n))) {
          pending = pending.slice(pending.length - n);
          return;
        }
      }
      pending = '';
      return;
    }
  }

  return {
    push(chunk: string): string {
      pending += chunk;
      consume();
      return committed.replace(/^\s+/, '');
    },
  };
}
