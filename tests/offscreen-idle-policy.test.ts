import { describe, expect, it } from 'vitest';
import {
  alarmWhen,
  decideIdleAction,
  IDLE_ALARM_NAME,
  shouldScheduleOnTouch,
} from '../src/offscreen/idle-policy.js';

describe('IDLE_ALARM_NAME', () => {
  it('is the single frozen named alarm string', () => {
    expect(IDLE_ALARM_NAME).toBe('local-nano:idle-release');
  });
});

describe('alarmWhen', () => {
  it('returns now + timeoutMinutes * 60_000', () => {
    expect(alarmWhen(1000, 5)).toBe(1000 + 300000);
  });

  it('handles a zero base time', () => {
    expect(alarmWhen(0, 15)).toBe(900000);
  });

  it('handles the 60-min option', () => {
    expect(alarmWhen(2000, 60)).toBe(2000 + 3_600_000);
  });
});

describe('decideIdleAction', () => {
  it('reschedules with the same delay when busy', () => {
    expect(decideIdleAction({ busy: true, timeoutMinutes: 15 })).toEqual({
      kind: 'reschedule',
      delayMinutes: 15,
    });
  });

  it('closes when idle with a finite timeout', () => {
    expect(decideIdleAction({ busy: false, timeoutMinutes: 15 })).toEqual({ kind: 'close' });
  });

  it('noops when the timeout is null ("Never"), even if idle', () => {
    expect(decideIdleAction({ busy: false, timeoutMinutes: null })).toEqual({ kind: 'noop' });
  });

  it('noops when the timeout is null even while busy (release disabled)', () => {
    expect(decideIdleAction({ busy: true, timeoutMinutes: null })).toEqual({ kind: 'noop' });
  });
});

describe('shouldScheduleOnTouch', () => {
  it('is false for null ("Never")', () => {
    expect(shouldScheduleOnTouch(null)).toBe(false);
  });

  it('is true for a finite timeout', () => {
    expect(shouldScheduleOnTouch(5)).toBe(true);
    expect(shouldScheduleOnTouch(15)).toBe(true);
    expect(shouldScheduleOnTouch(60)).toBe(true);
  });
});
