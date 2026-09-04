const DEFAULT_STORAGE_KEY = "todo-agent:global-search-history:v1";
const MAX_ENTRIES = 8;
const MAX_QUERY_LENGTH = 160;

const normalizeQuery = (value: string): string =>
  value.replace(/\0/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_QUERY_LENGTH);

const parse = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const query = normalizeQuery(item);
    if (!query || seen.has(query.toLocaleLowerCase())) continue;
    seen.add(query.toLocaleLowerCase());
    entries.push(query);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
};

export function readGlobalSearchHistory(
  storageKey = DEFAULT_STORAGE_KEY,
): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > 8_000) return [];
    return parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function rememberGlobalSearch(
  query: string,
  storageKey = DEFAULT_STORAGE_KEY,
): string[] {
  const normalized = normalizeQuery(query);
  if (!normalized) return readGlobalSearchHistory(storageKey);
  const entries = [normalized, ...readGlobalSearchHistory(storageKey).filter(
    (entry) => entry.toLocaleLowerCase() !== normalized.toLocaleLowerCase(),
  )].slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(storageKey, JSON.stringify(entries));
  } catch {
    // Private browsing or a full storage quota should not block search.
  }
  return entries;
}

export function clearGlobalSearchHistory(
  storageKey = DEFAULT_STORAGE_KEY,
): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Ignore unavailable storage; the in-memory search remains usable.
  }
}
