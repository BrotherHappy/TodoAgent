import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import {
  addLocalDays,
  formatClock,
  localIsoAt,
  scheduledTimelineTasks,
  tasksForWeekDay,
  taskTimelinePlacement,
  timelineSlots,
  timelineNowIndicator,
  unscheduledTimelineTasks,
  weekDateKeys,
  weeklyReviewSummary,
} from "../src/renderer/timeline-utils";

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  source: { type: "local" },
  title: id,
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
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  ...overrides,
});

describe("timeline-utils", () => {
  it("creates half-hour slots and moves across local calendar days", () => {
    expect(formatClock(8 * 60)).toBe("08:00");
    expect(timelineSlots("2026-08-19")).toHaveLength(28);
    expect(timelineSlots("2026-08-19")[0]?.label).toBe("08:00");
    expect(addLocalDays("2026-08-19", 1)).toBe("2026-08-20");
    expect(addLocalDays("2026-08-19", -1)).toBe("2026-08-18");
  });

  it("projects the live clock only onto the selected visible workday", () => {
    const now = new Date(2026, 7, 19, 10, 17, 30);
    const indicator = timelineNowIndicator("2026-08-19", now);
    expect(indicator).toMatchObject({
      minute: 617.5,
      slotMinute: 600,
      label: "10:17",
    });
    expect(indicator?.offsetRatio).toBeCloseTo(17.5 / 30);
    expect(timelineNowIndicator("2026-08-18", now)).toBeUndefined();
    expect(timelineNowIndicator("2026-08-19", new Date(2026, 7, 19, 7, 59))).toBeUndefined();
    expect(timelineNowIndicator("2026-08-19", new Date(2026, 7, 19, 22, 0))).toBeUndefined();
  });

  it("places time blocks and derives an end from a start plus estimate", () => {
    const block = task("block", {
      timeBlock: {
        startAt: localIsoAt("2026-08-19", 9 * 60 + 15),
        endAt: localIsoAt("2026-08-19", 10 * 60 + 15),
      },
    });
    const startOnly = task("start", {
      startAt: localIsoAt("2026-08-19", 14 * 60 + 10),
      estimatedMinutes: 45,
    });
    expect(taskTimelinePlacement(block, "2026-08-19")?.slotMinute).toBe(9 * 60);
    expect(taskTimelinePlacement(block, "2026-08-19")?.durationMinutes).toBe(60);
    expect(taskTimelinePlacement(startOnly, "2026-08-19")?.endAt).toBe(
      localIsoAt("2026-08-19", 14 * 60 + 55),
    );
    expect(taskTimelinePlacement(block, "2026-08-20")).toBeUndefined();
  });

  it("keeps planned and due-only tasks in the unscheduled tray", () => {
    const planned = task("planned", { plannedDate: "2026-08-19" });
    const due = task("due", { dueAt: localIsoAt("2026-08-19", 18 * 60), privateOrder: 1 });
    const scheduled = task("scheduled", {
      plannedDate: "2026-08-19",
      startAt: localIsoAt("2026-08-19", 11 * 60),
    });
    const result = unscheduledTimelineTasks([planned, due, scheduled], "2026-08-19");
    expect(result.map((item) => item.id)).toEqual(["planned", "due"]);
    expect(scheduledTimelineTasks([planned, due, scheduled], "2026-08-19").map((item) => item.task.id)).toEqual(["scheduled"]);
  });

  it("builds a Monday-first week and a truthful review summary", () => {
    const monday = "2026-08-17";
    expect(weekDateKeys("2026-08-19")).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
    ]);
    const completed = task("done", {
      status: "completed",
      completedAt: "2026-08-18T10:00:00.000Z",
      focusElapsedSeconds: 1_800,
    });
    const scheduled = task("scheduled", {
      plannedDate: monday,
      startAt: localIsoAt(monday, 9 * 60),
    });
    const planned = task("planned", { plannedDate: "2026-08-19" });
    const summary = weeklyReviewSummary([completed, scheduled, planned], "2026-08-19", "2026-08-19");
    expect(summary.completedCount).toBe(1);
    expect(summary.scheduledCount).toBe(1);
    expect(summary.unscheduledCount).toBe(1);
    expect(summary.focusMinutes).toBe(30);
    expect(tasksForWeekDay([completed, scheduled], "2026-08-18").map((item) => item.id)).toEqual(["done"]);
  });
});
