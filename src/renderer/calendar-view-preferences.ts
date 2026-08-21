/** Local-only visibility preferences for calendar sources in the timeline. */

export const CALENDAR_SOURCE_VISIBILITY_STORAGE_KEY =
  "todo-agent:calendar-hidden-sources:v1";

const MAX_SOURCES = 64;
const MAX_SOURCE_NAME_LENGTH = 120;

export const normalizeCalendarSourceName = (value: string): string =>
  value.replace(/\0/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_SOURCE_NAME_LENGTH) || "本地日历";

const uniqueSources = (sources: readonly string[]): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const normalized = normalizeCalendarSourceName(source);
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= MAX_SOURCES) break;
  }
  return result;
};

export function readHiddenCalendarSources(
  storageKey = CALENDAR_SOURCE_VISIBILITY_STORAGE_KEY,
): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > 16_000) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? uniqueSources(parsed.filter((value): value is string => typeof value === "string"))
      : [];
  } catch {
    return [];
  }
}

export function writeHiddenCalendarSources(
  sources: readonly string[],
  storageKey = CALENDAR_SOURCE_VISIBILITY_STORAGE_KEY,
): string[] {
  const next = uniqueSources(sources);
  try {
    if (next.length === 0) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // A locked-down storage area should not make the timeline unusable.
  }
  return next;
}

export function setCalendarSourceHidden(
  sources: readonly string[],
  source: string,
  hidden: boolean,
): string[] {
  const normalized = normalizeCalendarSourceName(source);
  const current = uniqueSources(sources).filter(
    (item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase(),
  );
  return hidden ? [...current, normalized] : current;
}

