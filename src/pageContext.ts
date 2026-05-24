export const PAGE_CONTEXT_BODY_LIMIT = 1500;

export function pageContext(
  doc: Pick<Document, 'title'> & { body: { innerText: string } },
  loc: Pick<Location, 'href'>,
  limit: number = PAGE_CONTEXT_BODY_LIMIT,
): string {
  // Slice a generous raw window BEFORE collapsing whitespace. The regex
  // ran over the entire innerText previously, so a multi-megabyte page
  // normalized megabytes just to keep `limit` chars. `limit * 8` is wide
  // enough that whitespace collapse can never shrink the window below
  // `limit`, while bounding the regex work regardless of page size.
  const raw = doc.body.innerText.slice(0, limit * 8);
  const body = raw.replace(/\s+/g, ' ').slice(0, limit);
  return `Page: ${doc.title}\nURL: ${loc.href}\n\n${body}`;
}
