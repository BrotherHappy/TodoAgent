import { describe, expect, it } from "vitest";
import { buildEveningReview } from "../src/renderer/evening-review";
import type { Task } from "../src/shared/models";

const makeTask = (title: string, overrides: Partial<Task> = {}): Task => ({
  id: title,
  source: { type: "local" },
  title,
  notes: "",
  privateNotes: "",
  status: "open",
  priority: "medium",
  tags: [],
  dependencyIds: [],
  assigneeIds: [],
  followerIds: [],
  attachments: [],
  links: [],
  customFields: {},
  reminders: [],
  focusElapsedSeconds: 0,
  privateOrder: 0,
  sync: { status: "local" },
  createdAt: "2026-08-19T01:00:00.000Z",
  updatedAt: "2026-08-19T01:00:00.000Z",
  ...overrides,
});

describe("evening review", () => {
  it("summarizes completed work, focus, and gentle carry-over facts", () => {
    const review = buildEveningReview(
      [
        makeTask("完成报告", {
          status: "completed",
          plannedDate: "2026-08-19",
          completedAt: "2026-08-19T09:30:00.000Z",
        }),
        makeTask("继续研究", { plannedDate: "2026-08-18" }),
        makeTask("明天再做", { plannedDate: "2026-08-20" }),
      ],
      [
        {
          id: "focus-1",
          sessionId: "session-1",
          phase: "focus",
          cycle: 1,
          plannedSeconds: 1500,
          actualSeconds: 2_700,
          outcome: "completed",
          completedAt: "2026-08-19T10:00:00.000Z",
        },
      ],
      new Date("2026-08-19T04:00:00.000Z"),
    );
    expect(review).toMatchObject({
      localDate: "2026-08-19",
      completedCount: 1,
      focusMinutes: 45,
      remainingCount: 2,
      carryOverCount: 1,
      overdueCount: 1,
      label: "今日进展",
    });
    expect(review.detail).toContain("明天再安排");
  });

  it("uses an evening label without turning an empty day into a penalty", () => {
    const review = buildEveningReview(
      [makeTask("已删除", { deletedAt: "2026-08-19T08:00:00.000Z" })],
      [],
      new Date("2026-08-19T10:00:00.000Z"),
    );
    expect(review.label).toBe("今晚回顾");
    expect(review.completedCount).toBe(0);
    expect(review.headline).toContain("没关系");
  });
});
