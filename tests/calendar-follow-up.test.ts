import { describe, expect, it } from "vitest";
import { buildCalendarFollowUpDraft } from "../src/shared/calendar-follow-up";
import { localIsoAt, localDateKey } from "../src/renderer/timeline-utils";

const date = localDateKey();

describe("calendar follow-up drafts", () => {
  it("creates a local preview with the meeting title, date, and context", () => {
    const draft = buildCalendarFollowUpDraft({
      id: "event-1",
      summary: "产品同步会",
      startAt: localIsoAt(date, 10 * 60),
      endAt: localIsoAt(date, 11 * 60),
      allDay: false,
      sourceName: "工作日历",
    });

    expect(draft).toEqual({
      title: "跟进：产品同步会",
      notes: expect.stringMatching(/会后跟进[\s\S]*工作日历/u),
      plannedDate: date,
    });
  });

  it("keeps an all-day event readable without inventing a time", () => {
    const draft = buildCalendarFollowUpDraft({
      id: "event-2",
      summary: "季度回顾",
      startAt: `${date}T00:00:00.000Z`,
      endAt: `${date}T00:00:00.000Z`,
      allDay: true,
      sourceName: "个人日历",
    }, date);

    expect(draft.title).toBe("跟进：季度回顾");
    expect(draft.plannedDate).toBeTruthy();
    expect(draft.notes).toContain("日期：");
    expect(draft.notes).not.toContain("未知时间");
  });

  it("uses the selected day when an imported event has an invalid start", () => {
    const draft = buildCalendarFollowUpDraft({
      id: "event-3",
      summary: "无效日期事件",
      startAt: "invalid",
      endAt: "invalid",
      allDay: false,
      sourceName: "本地日历",
    }, date);

    expect(draft.plannedDate).toBe(date);
    expect(draft.notes).toContain("未知时间");
  });
});
