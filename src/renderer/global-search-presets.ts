export interface GlobalSearchPreset {
  id: string;
  name: string;
  query: string;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_STORAGE_KEY = "todo-agent:global-search-presets:v1";
const MAX_PRESETS = 12;
const MAX_NAME_LENGTH = 48;
const MAX_QUERY_LENGTH = 160;

const normalize = (value: string, maxLength: number): string =>
  value.replace(/\0/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maxLength);

const timestamp = (): string => new Date().toISOString();

const safeId = (): string => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to a non-secret local identifier.
  }
  return `search-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const parse = (value: unknown): GlobalSearchPreset[] => {
  if (!Array.isArray(value)) return [];
  const entries: GlobalSearchPreset[] = [];
  const seenIds = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.length > 160 || seenIds.has(candidate.id)) continue;
    const name = typeof candidate.name === "string" ? normalize(candidate.name, MAX_NAME_LENGTH) : "";
    const query = typeof candidate.query === "string" ? normalize(candidate.query, MAX_QUERY_LENGTH) : "";
    if (!name || !query) continue;
    const createdAt = typeof candidate.createdAt === "string" && Number.isFinite(Date.parse(candidate.createdAt))
      ? new Date(candidate.createdAt).toISOString()
      : timestamp();
    const updatedAt = typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt))
      ? new Date(candidate.updatedAt).toISOString()
      : createdAt;
    seenIds.add(candidate.id);
    entries.push({ id: candidate.id, name, query, createdAt, updatedAt });
    if (entries.length >= MAX_PRESETS) break;
  }
  return entries;
};

const readRaw = (storageKey: string): GlobalSearchPreset[] => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > 40_000) return [];
    return parse(JSON.parse(raw));
  } catch {
    return [];
  }
};

const writeRaw = (entries: readonly GlobalSearchPreset[], storageKey: string): void => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(entries.slice(0, MAX_PRESETS)));
  } catch {
    // A full or unavailable storage area must not block the search surface.
  }
};

export function readGlobalSearchPresets(
  storageKey = DEFAULT_STORAGE_KEY,
): GlobalSearchPreset[] {
  return readRaw(storageKey);
}

export function saveGlobalSearchPreset(
  name: string,
  query: string,
  storageKey = DEFAULT_STORAGE_KEY,
): GlobalSearchPreset[] {
  const normalizedName = normalize(name, MAX_NAME_LENGTH);
  const normalizedQuery = normalize(query, MAX_QUERY_LENGTH);
  if (!normalizedName || !normalizedQuery) return readRaw(storageKey);
  const now = timestamp();
  const entries = readRaw(storageKey);
  const existing = entries.find(
    (entry) => entry.query.toLocaleLowerCase() === normalizedQuery.toLocaleLowerCase(),
  );
  const next = existing
    ? entries.map((entry) =>
        entry.id === existing.id
          ? { ...entry, name: normalizedName, query: normalizedQuery, updatedAt: now }
          : entry,
      )
    : [{
        id: safeId(),
        name: normalizedName,
        query: normalizedQuery,
        createdAt: now,
        updatedAt: now,
      }, ...entries];
  writeRaw(next, storageKey);
  return readRaw(storageKey);
}

export function removeGlobalSearchPreset(
  id: string,
  storageKey = DEFAULT_STORAGE_KEY,
): GlobalSearchPreset[] {
  const next = readRaw(storageKey).filter((entry) => entry.id !== id);
  writeRaw(next, storageKey);
  return readRaw(storageKey);
}

export function clearGlobalSearchPresets(
  storageKey = DEFAULT_STORAGE_KEY,
): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Ignore unavailable storage.
  }
}
