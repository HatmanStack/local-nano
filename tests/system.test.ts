import { describe, expect, it } from 'vitest';
import { SYSTEM_INSTRUCTION } from '../src/system.js';

describe('SYSTEM_INSTRUCTION', () => {
  it('is a non-empty string', () => {
    expect(typeof SYSTEM_INSTRUCTION).toBe('string');
    expect(SYSTEM_INSTRUCTION.length).toBeGreaterThan(0);
  });

  it('mentions that the user is reading a webpage', () => {
    expect(SYSTEM_INSTRUCTION).toMatch(/webpage/i);
  });
});
