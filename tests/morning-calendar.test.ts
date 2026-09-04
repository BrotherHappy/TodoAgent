import { describe, expect, it } from "vitest";
import { buildMorningCalendarSummary } from "../src/renderer/morning-calendar";

describe("morning calendar summary", () => {
  it("projects only today's events and totals overlapping reservations", () => {
    const event = (id: string, start: string, end: string, summary: string) => ({
      id,
      summary,
      startAt: start,
      endAt: end,
      allDay: false,
      sourceName: "工作日历",
    });
    const result = buildMorningCalendarSummary([
      event("one", "2026-08-20T10:00:00.000Z", "2026-08-20T11:00:00.000Z", "会议"),
      event("two", "2026-08-20T10:30:00.000Z", "2026-08-20T12:00:00.000Z", "重叠会议"),
      event("other", "2026-08-21T10:00:00.000Z", "2026-08-21T11:00:00.000Z", "明天"),
    ], "2026-08-20");
    expect(result.events.map((item) => item.summary)).toEqual(["会议", "重叠会议"]);
    expect(result.blocks).toHaveLength(2);
    expect(result.busyMinutes).toBe(150);
  });

  it("keeps all-day events visible as a full-day reservation", () => {
    const localStart = new Date(2026, 7, 20, 0, 0, 0, 0).toISOString();
    const localEnd = new Date(2026, 7, 21, 0, 0, 0, 0).toISOString();
    const result = buildMorningCalendarSummary([{
      id: "all-day",
      summary: "休假",
      startAt: localStart,
      endAt: localEnd,
      allDay: true,
      sourceName: "个人日历",
    }], "2026-08-20");
    expect(result.blocks[0]).toMatchObject({ startMinutes: 0, endMinutes: 1_440, allDay: true });
    expect(result.busyMinutes).toBe(1_440);
  });
});
