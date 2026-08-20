import { describe, expect, it } from "vitest";
import {
  calendarBusyBlocksForDate,
  calendarBusyMinutesForDate,
  calendarEventsForDate,
  mergeCalendarEvents,
  parseIcsCalendar,
} from "../src/shared/calendar-events";

const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:meeting-1@example.test
DTSTART:20260820T100000
DTEND:20260820T113000
SUMMARY:团队\\,同步
END:VEVENT
BEGIN:VEVENT
UID:all-day@example.test
DTSTART;VALUE=DATE:20260820
DTEND;VALUE=DATE:20260821
SUMMARY:休假日
END:VEVENT
BEGIN:VEVENT
UID:cancelled@example.test
DTSTART:20260820T120000
DTEND:20260820T123000
STATUS:CANCELLED
SUMMARY:已取消
END:VEVENT
END:VCALENDAR`;

describe("local calendar events", () => {
  it("parses timed and all-day events, unfolds text, and skips cancelled entries", () => {
    const events = parseIcsCalendar(ics, "工作日历");
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.summary)).toEqual(["休假日", "团队,同步"]);
    expect(events[0]?.sourceName).toBe("工作日历");
    expect(events[0]?.allDay).toBe(true);
  });

  it("clips events crossing midnight and computes merged busy minutes", () => {
    const events = parseIcsCalendar(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:cross
DTSTART:20260819T233000
DTEND:20260820T003000
SUMMARY:跨夜会议
END:VEVENT
BEGIN:VEVENT
UID:overlap
DTSTART:20260820T000000
DTEND:20260820T010000
SUMMARY:重叠安排
END:VEVENT
END:VCALENDAR`);
    expect(calendarEventsForDate(events, "2026-08-20")).toHaveLength(2);
    expect(calendarBusyBlocksForDate(events, "2026-08-20").map((block) => [block.startMinutes, block.endMinutes])).toEqual([
      [0, 30],
      [0, 60],
    ]);
    expect(calendarBusyMinutesForDate(events, "2026-08-20", 9 * 60, 18 * 60)).toBe(0);
    expect(calendarBusyMinutesForDate(events, "2026-08-20", 0, 120)).toBe(60);
  });

  it("merges repeat imports idempotently and caps invalid records", () => {
    const events = parseIcsCalendar(ics, "工作日历");
    expect(mergeCalendarEvents(events, events)).toHaveLength(2);
    expect(mergeCalendarEvents([], [{ ...events[0]!, endAt: "invalid" }])).toEqual([]);
  });
});
