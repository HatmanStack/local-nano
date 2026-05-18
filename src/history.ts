export type Role = 'user' | 'model' | 'system';
export type Entry = { role: Role; text: string };

export function storageKey(loc: Pick<Location, 'origin' | 'pathname'>): string {
  return `local-nano:history:${loc.origin}${loc.pathname}`;
}

export async function loadHistory(key: string): Promise<Entry[]> {
  const data = await chrome.storage.local.get(key);
  const stored = data?.[key];
  return Array.isArray(stored) ? (stored as Entry[]) : [];
}

export function saveHistory(key: string, history: Entry[]): Promise<void> {
  return chrome.storage.local.set({ [key]: history }) as unknown as Promise<void>;
}
