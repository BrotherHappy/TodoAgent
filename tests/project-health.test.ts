import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import { buildProjectHealthSummaries } from "../src/renderer/project-health";

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

describe("project health projection", () => {
  it("explains blocked work, overdue work, capacity, and the next task", () => {
    const summaries = buildProjectHealthSummaries(
      [
        task("blocked", {
          title: "先解决依赖",
          projectId: "Alpha",
          dependencyIds: ["missing-dependency"],
          plannedDate: "2026-08-19",
          dueAt: "2026-08-19",
          estimatedMinutes: 60,
          priority: "urgent",
        }),
        task("planned", {
          projectId: "Alpha",
          plannedDate: "2026-08-22",
          dueAt: "2026-08-22",
          estimatedMinutes: 120,
          priority: "low",
        }),
        task("done", {
          projectId: "Alpha",
          status: "completed",
          completedAt: "2026-08-18T10:00:00.000Z",
        }),
      ],
      { anchor: "2026-08-19", today: "2026-08-20", capacityMinutes: 120 },
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      projectId: "Alpha",
      weekStart: "2026-08-17",
      weekEnd: "2026-08-23",
      openCount: 2,
      completedCount: 1,
      dueThisWeekCount: 2,
      overdueCount: 1,
      blockedCount: 1,
      unplannedCount: 0,
      plannedOpenMinutes: 180,
      capacityMinutes: 120,
      capacityRatio: 1.5,
      status: "blocked",
      statusLabel: "有阻塞",
      signal: "1 项任务被依赖卡住",
      nextTask: expect.objectContaining({ id: "blocked" }),
    });
  });

  it("sorts health signals by urgency and keeps deleted or unprojected tasks out", () => {
    const summaries = buildProjectHealthSummaries(
      [
        task("quiet", { projectId: "Quiet" }),
        task("steady", {
          projectId: "Steady",
          startAt: "2026-08-21T02:00:00.000Z",
          estimatedMinutes: 45,
        }),
        task("deleted", { projectId: "Gone", deletedAt: "2026-08-19T00:00:00.000Z" }),
        task("no-project"),
      ],
      { anchor: "2026-08-19", today: "2026-08-19" },
    );

    expect(summaries.map((summary) => [summary.projectId, summary.status])).toEqual([
      ["Quiet", "quiet"],
      ["Steady", "steady"],
    ]);
    expect(summaries[0]?.signal).toContain("尚未排时间");
    expect(summaries[1]?.scheduledOpenMinutes).toBe(45);
  });

  it("treats missing dependencies as blocking and caps invalid capacity safely", () => {
    const summary = buildProjectHealthSummaries(
      [task("item", { projectId: "Alpha", dependencyIds: ["unknown"] })],
      { anchor: "2026-08-19", capacityMinutes: 0 },
    )[0];
    expect(summary?.blockedCount).toBe(1);
    expect(summary?.capacityMinutes).toBe(2400);
    expect(summary?.estimatedOpenMinutes).toBe(30);
  });
});
