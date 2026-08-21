import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import { localIsoAt } from "../src/renderer/timeline-utils";
import { buildGanttPlan } from "../src/renderer/timeline-gantt";

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
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
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

describe("buildGanttPlan", () => {
  it("projects dated tasks into a clipped two-week window and preserves unplanned work", () => {
    const plan = buildGanttPlan(
      [
        makeTask("跨周任务", {
          projectId: "发布",
          startAt: localIsoAt("2026-08-15", 10 * 60),
          dueAt: localIsoAt("2026-08-21", 18 * 60),
          estimatedMinutes: 90,
          actualMinutes: 45,
        }),
        makeTask("被阻塞", {
          projectId: "发布",
          plannedDate: "2026-08-19",
          dependencyIds: ["missing-dependency"],
        }),
        makeTask("未安排", { projectId: "发布" }),
        makeTask("别的项目", { projectId: "研究", plannedDate: "2026-08-19" }),
        makeTask("已删除", { plannedDate: "2026-08-19", deletedAt: "2026-08-19T00:00:00.000Z" }),
      ],
      "2026-08-19",
      "all",
      "2026-08-19",
    );

    expect(plan.startDate).toBe("2026-08-17");
    expect(plan.endDate).toBe("2026-08-30");
    expect(plan.days).toHaveLength(14);
    expect(plan.days.find((day) => day.date === "2026-08-19")?.isToday).toBe(true);
    expect(plan.datedTaskCount).toBe(3);
    expect(plan.blockedCount).toBe(1);
    expect(plan.unscheduledTasks.map((task) => task.id)).toEqual(["未安排"]);

    const release = plan.groups.find((group) => group.projectId === "发布");
    expect(release?.rows.map((row) => row.task.id)).toEqual(["跨周任务", "被阻塞"]);
    expect(release?.rows[0]?.bar).toMatchObject({
      startDate: "2026-08-15",
      endDate: "2026-08-21",
      startOffset: 0,
      spanDays: 5,
      clippedStart: true,
      clippedEnd: false,
      progressPercent: 50,
    });
    expect(release?.rows[1]?.blocked).toBe(true);
    expect(plan.groups.map((group) => group.label)).toEqual(["发布", "研究"]);
  });

  it("filters by project without hiding undated tasks in that project", () => {
    const plan = buildGanttPlan(
      [
        makeTask("发布任务", { projectId: "发布", plannedDate: "2026-08-19" }),
        makeTask("发布未排", { projectId: "发布" }),
        makeTask("研究任务", { projectId: "研究", plannedDate: "2026-08-19" }),
      ],
      "2026-08-19",
      "发布",
      "2026-08-19",
    );

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.label).toBe("发布");
    expect(plan.groups[0]?.rows.map((row) => row.task.id)).toEqual(["发布任务"]);
    expect(plan.unscheduledTasks.map((task) => task.id)).toEqual(["发布未排"]);
  });
});
