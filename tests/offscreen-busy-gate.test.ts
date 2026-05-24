import { describe, expect, it } from 'vitest';
import { BusyGate } from '../src/offscreen/busy-gate.js';

describe('BusyGate', () => {
  it('acquires the slot the first time and reports busy', () => {
    const gate = new BusyGate();
    expect(gate.busy).toBe(false);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.busy).toBe(true);
  });

  it('rejects a second acquire while the slot is held', () => {
    const gate = new BusyGate();
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    // A rejected acquire does not change state.
    expect(gate.busy).toBe(true);
  });

  it('frees the slot on release so the next acquire succeeds', () => {
    const gate = new BusyGate();
    gate.tryAcquire();
    gate.release();
    expect(gate.busy).toBe(false);
    expect(gate.tryAcquire()).toBe(true);
  });

  it('release is idempotent', () => {
    const gate = new BusyGate();
    gate.release(); // releasing a free gate is a no-op
    expect(gate.busy).toBe(false);
    gate.tryAcquire();
    gate.release();
    gate.release();
    expect(gate.busy).toBe(false);
    expect(gate.tryAcquire()).toBe(true);
  });

  it('supports repeated acquire/release cycles', () => {
    const gate = new BusyGate();
    for (let i = 0; i < 3; i++) {
      expect(gate.tryAcquire()).toBe(true);
      expect(gate.tryAcquire()).toBe(false);
      gate.release();
    }
  });
});
