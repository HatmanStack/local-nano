/**
 * Pure idle-release decision and alarm-time math (ADR-P9, P11).
 *
 * Isolates the close-vs-reschedule decision and the alarm-time computation as a
 * unit-testable seam with NO Chrome, polyfill, or timer dependency. The service
 * worker supplies `Date.now()` and the stored timeout; this module only
 * computes. Idle release is driven by a single named `chrome.alarms` alarm; the
 * SW reschedules it on each generation (touch-idle) and verifies idle before
 * closing the offscreen document (the document never self-closes).
 */

/** The single named alarm the SW owns for idle release. */
export const IDLE_ALARM_NAME = 'local-nano:idle-release';

/** Compute the absolute alarm time `nowMs + timeoutMinutes * 60_000`. Pure. */
export function alarmWhen(nowMs: number, timeoutMinutes: number): number {
  return nowMs + timeoutMinutes * 60_000;
}

/**
 * The action the SW takes when the idle alarm fires, decided from the offscreen
 * busy state and the configured timeout. Pure.
 *
 * - `null` timeout ("Never"): release is disabled. Returns `noop` (the alarm
 *   should not have been scheduled, but defend in case a stale alarm fires after
 *   the user switched to Never).
 * - busy: reschedule for another full timeout window rather than dropping a
 *   user's in-flight generation.
 * - idle with a finite timeout: close the offscreen document.
 */
export function decideIdleAction(input: {
  busy: boolean;
  timeoutMinutes: number | null;
}): { kind: 'close' } | { kind: 'reschedule'; delayMinutes: number } | { kind: 'noop' } {
  if (input.timeoutMinutes === null) return { kind: 'noop' };
  if (input.busy) return { kind: 'reschedule', delayMinutes: input.timeoutMinutes };
  return { kind: 'close' };
}

/**
 * Whether the SW should (re)schedule the idle alarm on a touch-idle signal:
 * false when the user chose "Never" (`null`), true otherwise. Pure.
 */
export function shouldScheduleOnTouch(timeoutMinutes: number | null): boolean {
  return timeoutMinutes !== null;
}
