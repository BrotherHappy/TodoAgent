import {
  CALENDAR_EVENTS_STORAGE_KEY,
  mergeCalendarEvents,
  type CalendarEvent,
} from "../shared/calendar-events";

export function readCalendarEvents(): CalendarEvent[] {
  try {
    const raw = localStorage.getItem(CALENDAR_EVENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return mergeCalendarEvents([], parsed as CalendarEvent[]);
  } catch {
    return [];
  }
}

export function writeCalendarEvents(events: readonly CalendarEvent[]): void {
  try {
    localStorage.setItem(
      CALENDAR_EVENTS_STORAGE_KEY,
      JSON.stringify(mergeCalendarEvents([], events)),
    );
  } catch {
    // A locked-down storage area should not make task planning unusable.
  }
}
