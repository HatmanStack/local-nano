import { describe, expect, it } from 'vitest';
import { PAGE_CONTEXT_BODY_LIMIT, pageContext } from '../src/pageContext.js';

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

  it('caps the body at the limit for a huge innerText without normalizing the whole string', () => {
    // 2 MB of non-whitespace characters: the body must still cap at the
    // limit and the format header must be intact. The raw window slice
    // bounds the work regardless of page size.
    const body = 'y'.repeat(2 * 1024 * 1024);
    const doc = { title: 'Big', body: { innerText: body } };
    const out = pageContext(doc, { href: 'https://big.example/' });
    expect(out.startsWith('Page: Big\nURL: https://big.example/\n\n')).toBe(true);
    const bodyPart = out.split('\n\n', 2)[1];
    expect(bodyPart.length).toBe(PAGE_CONTEXT_BODY_LIMIT);
    expect(bodyPart).toBe('y'.repeat(PAGE_CONTEXT_BODY_LIMIT));
  });

  it('still collapses whitespace within the bounded window on a large page', () => {
    // Leading whitespace runs inside the raw window must collapse so the
    // final body is the same as slicing post-collapse, not raw.
    const body = `${'a b '.repeat(1000)}${'z'.repeat(2 * 1024 * 1024)}`;
    const doc = { title: 'T', body: { innerText: body } };
    const out = pageContext(doc, { href: 'u' }, 10);
    const bodyPart = out.split('\n\n', 2)[1];
    expect(bodyPart).toBe('a b a b a ');
  });
});
