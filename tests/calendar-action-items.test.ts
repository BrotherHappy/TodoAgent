import { describe, expect, it } from "vitest";
import { extractCalendarActionItems } from "../src/shared/calendar-action-items";

const event = {
  id: "meeting-actions",
  summary: "项目同步",
  description: "会议记录\n行动项：联系客户；更新方案\n- 确认发布时间",
  startAt: "2026-08-20T10:00:00.000Z",
  endAt: "2026-08-20T10:30:00.000Z",
  allDay: false,
  sourceName: "工作日历",
};

describe("calendar action-item extraction", () => {
  it("extracts explicit action sections and semicolon-separated items", () => {
    const drafts = extractCalendarActionItems(event, "2026-08-20");
    expect(drafts.map((draft) => draft.title)).toEqual([
      "联系客户",
      "更新方案",
      "确认发布时间",
    ]);
    expect(drafts[0]?.notes).toContain("项目同步");
    expect(drafts[0]?.plannedDate).toMatch(/^2026-08-20$/u);
  });

  it("accepts checklist and action-verb bullets without a heading", () => {
    const drafts = extractCalendarActionItems({
      ...event,
      description: "讨论\n[ ] 准备演示稿\n• review the draft\n• 参会人名单",
    });
    expect(drafts.map((draft) => draft.title)).toEqual(["准备演示稿", "review the draft"]);
  });

  it("stays conservative, deduplicates, and caps the preview", () => {
    const drafts = extractCalendarActionItems({
      ...event,
      description: "议程\n- 讨论范围\n行动项：检查接口；检查接口",
    });
    expect(drafts.map((draft) => draft.title)).toEqual(["讨论范围", "检查接口"]);
    expect(extractCalendarActionItems({ ...event, description: "普通会议记录，没有待办" })).toEqual([]);
  });
});
