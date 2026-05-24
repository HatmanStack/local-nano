import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  classifyLoadFailure,
  isTerminalFailure,
} from '../src/offscreen/failure.js';

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

describe('classifyLoadFailure', () => {
  it('classifies a fetch failure as network', () => {
    expect(classifyLoadFailure(new Error('Failed to fetch'))).toBe('network');
    expect(classifyLoadFailure(new Error('TypeError: Failed to fetch'))).toBe('network');
  });

  it('classifies a NetworkError / network error as network', () => {
    expect(classifyLoadFailure(new Error('NetworkError when attempting to fetch resource'))).toBe(
      'network',
    );
    expect(classifyLoadFailure(new Error('A network error occurred'))).toBe('network');
  });

  it('classifies a Chrome ERR_INTERNET_DISCONNECTED as network', () => {
    expect(classifyLoadFailure(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('network');
  });

  it('classifies a HuggingFace fetch failure as network', () => {
    expect(
      classifyLoadFailure(new Error('Error: failed to fetch from huggingface.co model repo')),
    ).toBe('network');
  });

  it('classifies a non-200 HF status string as network', () => {
    expect(classifyLoadFailure(new Error('Unauthorized access to model file (status 403)'))).toBe(
      'network',
    );
    expect(classifyLoadFailure(new Error('Request failed with status code 503'))).toBe('network');
  });

  it('classifies a download-failed message as network', () => {
    expect(classifyLoadFailure(new Error('Could not load model: download failed'))).toBe('network');
  });

  it('keeps terminal crash signals terminal (network does not shadow them)', () => {
    expect(classifyLoadFailure(new Error('offscreen port disconnected: unknown reason'))).toBe(
      'terminal',
    );
    expect(classifyLoadFailure(new Error('the message channel closed'))).toBe('terminal');
  });

  it('classifies a generic load error as transient', () => {
    expect(classifyLoadFailure(new Error('some generic model error'))).toBe('transient');
    expect(classifyLoadFailure('busy: another generation is in progress')).toBe('transient');
  });

  it('is case-insensitive and handles non-Error inputs', () => {
    expect(classifyLoadFailure('FAILED TO FETCH')).toBe('network');
    expect(classifyLoadFailure(42)).toBe('transient');
    expect(classifyLoadFailure(null)).toBe('transient');
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
