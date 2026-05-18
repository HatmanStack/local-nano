import { describe, expect, it } from 'vitest';
import { pageContext, PAGE_CONTEXT_BODY_LIMIT } from '../src/pageContext.js';

describe('pageContext', () => {
  it('formats title, URL, and body', () => {
    const doc = { title: 'T', body: { innerText: 'Hello world' } };
    const loc = { href: 'https://example.com/' };
    expect(pageContext(doc, loc)).toBe('Page: T\nURL: https://example.com/\n\nHello world');
  });

  it('collapses whitespace runs in the body', () => {
    const doc = { title: 'T', body: { innerText: 'a\n\n  b\t\tc' } };
    const loc = { href: 'u' };
    expect(pageContext(doc, loc)).toContain('a b c');
  });

  it('truncates to the default body limit', () => {
    const body = 'x'.repeat(PAGE_CONTEXT_BODY_LIMIT + 500);
    const doc = { title: 'T', body: { innerText: body } };
    const out = pageContext(doc, { href: 'u' });
    const bodyPart = out.split('\n\n', 2)[1];
    expect(bodyPart.length).toBe(PAGE_CONTEXT_BODY_LIMIT);
  });

  it('respects a custom limit', () => {
    const doc = { title: 'T', body: { innerText: 'abcdefghij' } };
    const out = pageContext(doc, { href: 'u' }, 4);
    expect(out.endsWith('\n\nabcd')).toBe(true);
  });
});
