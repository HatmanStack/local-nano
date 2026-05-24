import { describe, expect, it } from 'vitest';
import { classifyFailure, isTerminalFailure } from '../src/offscreen/failure.js';

describe('classifyFailure', () => {
  it('classifies the stream-client unknown-reason disconnect as terminal', () => {
    expect(classifyFailure(new Error('offscreen port disconnected: unknown reason'))).toBe(
      'terminal',
    );
  });

  it('classifies a closed message channel as terminal', () => {
    expect(classifyFailure(new Error('The message channel closed before a response'))).toBe(
      'terminal',
    );
  });

  it('classifies a closed message port as terminal', () => {
    expect(classifyFailure(new Error('The message port closed before a reply was received'))).toBe(
      'terminal',
    );
  });

  it('classifies a missing receiving end as terminal', () => {
    expect(
      classifyFailure(new Error('Could not establish connection. Receiving end does not exist.')),
    ).toBe('terminal');
  });

  it('classifies a generic port-disconnected message as terminal', () => {
    expect(classifyFailure(new Error('offscreen port disconnected: foo'))).toBe('terminal');
  });

  it('classifies a document crash message as terminal', () => {
    expect(classifyFailure(new Error('the offscreen document crashed during load'))).toBe(
      'terminal',
    );
  });

  it('classifies the busy gate rejection as transient', () => {
    expect(classifyFailure(new Error('busy: another generation is in progress'))).toBe('transient');
  });

  it('classifies a generic model error as transient', () => {
    expect(classifyFailure('some generic model error')).toBe('transient');
  });

  it('classifies a document message without crash wording as transient', () => {
    expect(classifyFailure(new Error('document body innerText was empty'))).toBe('transient');
  });

  it('handles non-Error inputs', () => {
    expect(classifyFailure('the message channel closed')).toBe('terminal');
    expect(classifyFailure(42)).toBe('transient');
    expect(classifyFailure(undefined)).toBe('transient');
    expect(classifyFailure(null)).toBe('transient');
  });

  it('is case-insensitive', () => {
    expect(classifyFailure(new Error('THE MESSAGE CHANNEL CLOSED'))).toBe('terminal');
  });
});

describe('isTerminalFailure', () => {
  it('returns true for terminal failures', () => {
    expect(isTerminalFailure(new Error('offscreen port disconnected: unknown reason'))).toBe(true);
  });

  it('returns false for transient failures', () => {
    expect(isTerminalFailure(new Error('busy: another generation is in progress'))).toBe(false);
    expect(isTerminalFailure('plain string')).toBe(false);
  });
});
