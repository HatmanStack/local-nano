export const PAGE_CONTEXT_BODY_LIMIT = 1500;

export function pageContext(
  doc: Pick<Document, 'title'> & { body: { innerText: string } },
  loc: Pick<Location, 'href'>,
  limit: number = PAGE_CONTEXT_BODY_LIMIT,
): string {
  const body = doc.body.innerText.replace(/\s+/g, ' ').slice(0, limit);
  return `Page: ${doc.title}\nURL: ${loc.href}\n\n${body}`;
}
