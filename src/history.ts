export type Role = 'user' | 'model' | 'system';
export type Entry = { role: Role; text: string };

const ROLES: ReadonlySet<string> = new Set<Role>(['user', 'model', 'system']);

/**
 * Runtime shape guard for a single persisted entry. `chrome.storage` returns
 * whatever was last written, which a schema drift or a corrupt blob could make
 * malformed; mirror the wire-protocol predicates and validate the role enum
 * and the string text so a bad entry never renders as a broken bubble.
 */
function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false;
  const { role, text } = value as { role?: unknown; text?: unknown };
  return typeof role === 'string' && ROLES.has(role) && typeof text === 'string';
}

export function storageKey(loc: Pick<Location, 'origin' | 'pathname'>): string {
  return `local-nano:history:${loc.origin}${loc.pathname}`;
}

export async function loadHistory(key: string): Promise<Entry[]> {
  const data = await chrome.storage.local.get(key);
  const stored = data?.[key];
  if (!Array.isArray(stored)) return [];
  return stored.filter(isEntry);
}

export const MAX_HISTORY = 200;

export function saveHistory(key: string, history: Entry[]): Promise<void> {
  const trimmed = history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history;
  return chrome.storage.local.set({ [key]: trimmed });
}
