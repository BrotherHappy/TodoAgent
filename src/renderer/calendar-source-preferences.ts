import { normalizeCalendarSourceName } from "./calendar-view-preferences";

/** Local-only source color preferences for the timeline calendar overlay. */
export const CALENDAR_SOURCE_COLORS_STORAGE_KEY =
  "todo-agent:calendar-source-colors:v1";

const MAX_SOURCES = 64;
const MAX_STORAGE_LENGTH = 16_000;

export const CALENDAR_SOURCE_COLOR_PALETTE = [
  "#5b5ce2",
  "#168c8c",
  "#d56a28",
  "#c04f79",
  "#4d7ac7",
  "#7b5bb8",
  "#4a9e68",
  "#a06a34",
] as const;

export type CalendarSourceColorMap = Record<string, string>;

export function calendarSourceColorKey(source: string): string {
  return normalizeCalendarSourceName(source).toLocaleLowerCase();
}

export function normalizeCalendarSourceColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/u.test(normalized)) return normalized;
  if (/^#[0-9a-f]{3}$/u.test(normalized)) {
    return `#${normalized
      .slice(1)
      .split("")
      .map((digit) => `${digit}${digit}`)
      .join("")}`;
  }
  return undefined;
}

function normalizeColorMap(value: unknown): CalendarSourceColorMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const next: CalendarSourceColorMap = {};
  for (const [source, color] of Object.entries(value)) {
    if (typeof source !== "string" || typeof color !== "string") continue;
    const key = calendarSourceColorKey(source);
    const normalizedColor = normalizeCalendarSourceColor(color);
    if (!key || !normalizedColor || Object.prototype.hasOwnProperty.call(next, key)) continue;
    next[key] = normalizedColor;
    if (Object.keys(next).length >= MAX_SOURCES) break;
  }
  return next;
}

export function readCalendarSourceColors(
  storageKey = CALENDAR_SOURCE_COLORS_STORAGE_KEY,
): CalendarSourceColorMap {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > MAX_STORAGE_LENGTH) return {};
    return normalizeColorMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function writeCalendarSourceColors(
  colors: CalendarSourceColorMap,
  storageKey = CALENDAR_SOURCE_COLORS_STORAGE_KEY,
): CalendarSourceColorMap {
  const next = normalizeColorMap(colors);
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // A locked-down storage area should not make the timeline unusable.
  }
  return next;
}

export function setCalendarSourceColor(
  colors: CalendarSourceColorMap,
  source: string,
  color: string,
): CalendarSourceColorMap {
  const normalizedColor = normalizeCalendarSourceColor(color);
  if (!normalizedColor) return normalizeColorMap(colors);
  const next = normalizeColorMap(colors);
  const key = calendarSourceColorKey(source);
  if (!key) return next;
  next[key] = normalizedColor;
  return normalizeColorMap(next);
}

export function clearCalendarSourceColor(
  colors: CalendarSourceColorMap,
  source: string,
): CalendarSourceColorMap {
  const next = normalizeColorMap(colors);
  delete next[calendarSourceColorKey(source)];
  return next;
}

function sourceHash(source: string): number {
  let hash = 0x811c9dc5;
  for (const character of normalizeCalendarSourceName(source)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function defaultCalendarSourceColor(source: string): string {
  return CALENDAR_SOURCE_COLOR_PALETTE[
    sourceHash(source) % CALENDAR_SOURCE_COLOR_PALETTE.length
  ];
}

export function calendarSourceColor(
  source: string,
  overrides: CalendarSourceColorMap = {},
): string {
  const key = calendarSourceColorKey(source);
  return normalizeCalendarSourceColor(overrides[key]) ?? defaultCalendarSourceColor(source);
}

export function hasCalendarSourceColorOverride(
  source: string,
  overrides: CalendarSourceColorMap,
): boolean {
  const key = calendarSourceColorKey(source);
  return Boolean(normalizeCalendarSourceColor(overrides[key]));
}
