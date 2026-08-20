import {
  calendarBusyBlocksForDate,
  calendarEventsForDate,
  type CalendarBusyBlock,
  type CalendarEvent,
} from "../shared/calendar-events";

export interface MorningCalendarSummary {
  events: CalendarEvent[];
  blocks: CalendarBusyBlock[];
  busyMinutes: number;
}

/** Build the small, read-only agenda projection used by the Today brief. */
export function buildMorningCalendarSummary(
  events: readonly CalendarEvent[],
  date: string,
): MorningCalendarSummary {
  const blocks = calendarBusyBlocksForDate(events, date);
  return {
    events: calendarEventsForDate(events, date),
    blocks,
    busyMinutes: blocks.reduce(
      (total, block) => total + Math.max(0, block.endMinutes - block.startMinutes),
      0,
    ),
  };
}
