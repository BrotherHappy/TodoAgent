/**
 * Read-only calendar events used by the timeline and Today planner.
 *
 * Calendar events deliberately stay a small, provider-neutral model.  The
 * first integration is local `.ics` import, so the app can show meetings and
 * reserve their time without asking for a calendar account or writing back
 * to an external provider.
 */
export interface CalendarEvent {
  id: string;
  summary: string;
  /** Optional provider description, kept for local action-item previews. */
  description?: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  sourceName: string;
}

export interface CalendarBusyBlock {
  id: string;
  title: string;
  startMinutes: number;
  endMinutes: number;
  sourceName: string;
  allDay: boolean;
}

const MAX_ICS_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 500;
const MAX_DESCRIPTION_CHARS = 4_000;
const DATE_VALUE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/u;
const DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/u;

function stableId(value: string): string {
  // FNV-1a is enough here: this is only a local UI key, not a security
  // boundary.  Keeping it deterministic makes a repeated import idempotent.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ics-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/giu, "\n")
    .replace(/\\N/gu, "\n")
    .replace(/\\,/gu, ",")
    .replace(/\\;/gu, ";")
    .replace(/\\\\/gu, "\\");
}

function unfoldIcsLines(input: string): string[] {
  const normalized = input.replace(/\r\n?/gu, "\n");
  const lines: string[] = [];
  for (const line of normalized.split("\n")) {
    if (/^[ \t]/u.test(line) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function property(line: string): { name: string; params: string; value: string } | undefined {
  const separator = line.indexOf(":");
  if (separator < 1) return undefined;
  const left = line.slice(0, separator);
  const value = line.slice(separator + 1);
  const [name, ...params] = left.split(";");
  return { name: name.toUpperCase(), params: params.join(";").toUpperCase(), value };
}

function timezoneOffsetMinutes(timeZone: string, instant: Date): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const get = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((asUtc - instant.getTime()) / 60_000);
  } catch {
    return undefined;
  }
}

function parseCalendarValue(
  raw: string,
  params: string,
): { iso: string; allDay: boolean } | undefined {
  const value = raw.trim();
  const dateMatch = DATE_VALUE_PATTERN.exec(value);
  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const local = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (
      local.getFullYear() !== year ||
      local.getMonth() !== month - 1 ||
      local.getDate() !== day
    ) return undefined;
    return { iso: local.toISOString(), allDay: true };
  }
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (match[7]) {
    const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    return Number.isNaN(utc.getTime()) ? undefined : { iso: utc.toISOString(), allDay: false };
  }
  const local = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== day ||
    local.getHours() !== hour
  ) return undefined;
  const tzidMatch = /(?:^|;)TZID=([^;:]+)/u.exec(params);
  if (!tzidMatch) return { iso: local.toISOString(), allDay: false };
  // The runtime's Date constructor cannot directly create an instant in an
  // arbitrary IANA zone.  Start with a UTC wall-clock guess and correct it by
  // the zone's offset at that instant; this handles normal DST transitions
  // and remains deterministic for an imported event.
  const wallClockUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = timezoneOffsetMinutes(tzidMatch[1], wallClockUtc);
  if (offset === undefined) return { iso: local.toISOString(), allDay: false };
  return { iso: new Date(wallClockUtc.getTime() - offset * 60_000).toISOString(), allDay: false };
}

function endForEvent(startAt: string, endValue: string | undefined, endParams: string, allDay: boolean): string {
  if (endValue) {
    const parsed = parseCalendarValue(endValue, endParams);
    if (parsed) return parsed.iso;
  }
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return startAt;
  const end = new Date(start.getTime() + (allDay ? 86_400_000 : 30 * 60_000));
  return end.toISOString();
}

function eventFromProperties(
  values: Map<string, { params: string; value: string }>,
  sourceName: string,
): CalendarEvent | undefined {
  const startValue = values.get("DTSTART");
  if (!startValue) return undefined;
  const start = parseCalendarValue(startValue.value, startValue.params);
  if (!start) return undefined;
  const endValue = values.get("DTEND");
  let endAt = endForEvent(start.iso, endValue?.value, endValue?.params ?? startValue.params, start.allDay);
  const endParsed = new Date(endAt);
  const startParsed = new Date(start.iso);
  if (Number.isNaN(endParsed.getTime()) || endParsed <= startParsed) {
    endAt = new Date(startParsed.getTime() + (start.allDay ? 86_400_000 : 30 * 60_000)).toISOString();
  }
  const summary = unescapeIcs(values.get("SUMMARY")?.value ?? "未命名日历事件").trim() || "未命名日历事件";
  const description = unescapeIcs(values.get("DESCRIPTION")?.value ?? "")
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
  const uid = values.get("UID")?.value.trim();
  const id = stableId(`${uid || summary}|${start.iso}|${endAt}|${sourceName}`);
  return {
    id,
    summary,
    ...(description ? { description } : {}),
    startAt: start.iso,
    endAt,
    allDay: start.allDay,
    sourceName,
  };
}

/** Parse a UTF-8 iCalendar export into a small, provider-neutral model. */
export function parseIcsCalendar(input: string, sourceName = "本地日历"): CalendarEvent[] {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_ICS_BYTES) return [];
  const events: CalendarEvent[] = [];
  let active: Map<string, { params: string; value: string }> | undefined;
  for (const line of unfoldIcsLines(input)) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      active = new Map();
      continue;
    }
    if (upper === "END:VEVENT") {
      if (active) {
        const status = active.get("STATUS")?.value.trim().toUpperCase();
        const transparency = active.get("TRANSP")?.value.trim().toUpperCase();
        if (status !== "CANCELLED" && transparency !== "TRANSPARENT") {
          const event = eventFromProperties(active, sourceName.trim() || "本地日历");
          if (event) events.push(event);
        }
      }
      active = undefined;
      if (events.length >= MAX_EVENTS) break;
      continue;
    }
    if (!active) continue;
    const parsed = property(line.trim());
    if (parsed) active.set(parsed.name, { params: parsed.params, value: parsed.value });
  }
  const unique = new Map<string, CalendarEvent>();
  for (const event of events) unique.set(event.id, event);
  return [...unique.values()].sort((left, right) => left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id));
}

function localDayBounds(date: string): { start: Date; end: Date } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return undefined;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  if (Number.isNaN(start.getTime())) return undefined;
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function localMinutesFor(value: Date, dayStart: Date): number {
  return Math.round((value.getTime() - dayStart.getTime()) / 60_000);
}

/** Return only events intersecting the requested local day. */
export function calendarEventsForDate(events: readonly CalendarEvent[], date: string): CalendarEvent[] {
  const bounds = localDayBounds(date);
  if (!bounds) return [];
  return events
    .filter((event) => {
      const start = new Date(event.startAt).getTime();
      const end = new Date(event.endAt).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && end > bounds.start.getTime() && start < bounds.end.getTime();
    })
    .sort((left, right) => left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id));
}

/** Convert events into clipped local-minute reservations for a day. */
export function calendarBusyBlocksForDate(events: readonly CalendarEvent[], date: string): CalendarBusyBlock[] {
  const bounds = localDayBounds(date);
  if (!bounds) return [];
  return calendarEventsForDate(events, date).flatMap((event) => {
    const startDate = new Date(event.startAt);
    const endDate = new Date(event.endAt);
    const start = Math.max(bounds.start.getTime(), startDate.getTime());
    const end = Math.min(bounds.end.getTime(), endDate.getTime());
    if (!(end > start)) return [];
    return [{
      id: event.id,
      title: event.summary,
      startMinutes: Math.max(0, Math.min(1_440, localMinutesFor(new Date(start), bounds.start))),
      endMinutes: Math.max(0, Math.min(1_440, localMinutesFor(new Date(end), bounds.start))),
      sourceName: event.sourceName,
      allDay: event.allDay,
    }];
  });
}

export function calendarBusyMinutesForDate(
  events: readonly CalendarEvent[],
  date: string,
  availableStartMinutes: number,
  availableEndMinutes: number,
): number {
  const intervals = calendarBusyBlocksForDate(events, date)
    .map((block) => ({
      start: Math.max(block.startMinutes, availableStartMinutes),
      end: Math.min(block.endMinutes, availableEndMinutes),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let cursor = -1;
  for (const interval of intervals) {
    if (interval.end <= cursor) continue;
    if (interval.start > cursor) total += interval.end - interval.start;
    else total += interval.end - cursor;
    cursor = Math.max(cursor, interval.end);
  }
  return total;
}

export function mergeCalendarEvents(
  current: readonly CalendarEvent[],
  incoming: readonly CalendarEvent[],
): CalendarEvent[] {
  const merged = new Map<string, CalendarEvent>();
  for (const event of [...current, ...incoming]) {
    if (!event.id || !event.summary || !event.startAt || !event.endAt) continue;
    const start = new Date(event.startAt);
    const end = new Date(event.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
    merged.set(event.id, { ...event, sourceName: event.sourceName || "本地日历" });
  }
  return [...merged.values()]
    .sort((left, right) => left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id))
    .slice(0, MAX_EVENTS);
}

export const CALENDAR_EVENTS_STORAGE_KEY = "todo-agent:calendar-events:v1";
