/**
 * A single-slot busy gate for the shared offscreen session.
 *
 * The offscreen document holds ONE long-lived polyfill session whose
 * internal `#history` is mutated by each `promptStreaming` call. Two
 * ports (e.g. two tabs) streaming at once would interleave on that one
 * ONNX generator and corrupt the shared history. This gate lets the
 * `onConnect` handler reject a second concurrent `stream/request` with a
 * clear "busy" signal instead of starting a second generation.
 *
 * Policy: reject-when-busy (not queue). A queue is more code and YAGNI
 * for a single-user extension where concurrent two-tab streaming is an
 * edge case. The single-shared-session design is preserved (ADR-R2): the
 * gate is just local state, not a second session.
 *
 * Extracted from `offscreen.ts` so the acquire/release decision is
 * unit-testable without loading the offscreen entry (ADR-R5).
 */
export class BusyGate {
  #inFlight = false;

  /**
   * Try to claim the single slot. Returns true and marks the gate busy
   * when it was free; returns false (without changing state) when a
   * generation is already in flight.
   */
  tryAcquire(): boolean {
    if (this.#inFlight) return false;
    this.#inFlight = true;
    return true;
  }

  /** Release the slot. Idempotent: releasing an already-free gate is a no-op. */
  release(): void {
    this.#inFlight = false;
  }

  /** True while a generation holds the slot. */
  get busy(): boolean {
    return this.#inFlight;
  }
}
