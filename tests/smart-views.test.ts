import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../src/shared/models";
import {
  createSmartView,
  readSmartViews,
  SMART_VIEWS_STORAGE_KEY,
  sortSmartViewTasks,
  writeSmartViews,
  priorityReason,
} from "../src/renderer/smart-views";

const baseTask: Pick<Task, "priority" | "dependencyIds" | "sync"> = {
  priority: "none",
  dependencyIds: [],
  sync: { status: "local" },
};

describe("smart views and explainable priority", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("persists valid saved views and ignores malformed entries", () => {
    const view = createSmartView({
      name: "  本周高优先级  ",
      route: "all",
      priority: "high",
      projectId: "研究",
      sourceType: "feishu",
    }, "2026-08-19T08:00:00.000Z");
    expect(view?.name).toBe("本周高优先级");
    expect(view?.sourceType).toBe("feishu");
    expect(view?.context).toBe("all");
    writeSmartViews([view!, { bad: true } as never]);
    expect(readSmartViews()).toEqual([view]);
    window.localStorage.setItem(SMART_VIEWS_STORAGE_KEY, "not-json");
    expect(readSmartViews()).toEqual([]);
  });

  it("does not create an unnamed view and keeps the list bounded", () => {
    expect(createSmartView({ name: " ", route: "today", priority: "all", projectId: "all" })).toBeUndefined();
    const views = Array.from({ length: 30 }, (_, index) => createSmartView({
      name: `view-${index}`,
      route: "all",
      priority: "all",
      projectId: "all",
    })!);
    writeSmartViews(views);
    expect(readSmartViews()).toHaveLength(24);
  });

  it("explains urgency using deterministic signals in a stable order", () => {
    const now = new Date("2026-08-19T10:00:00.000Z");
    expect(priorityReason({ ...baseTask, priority: "high" }, now)).toBe("高优先级");
    expect(priorityReason({ ...baseTask, dueAt: "2026-08-19T09:00:00.000Z" }, now)).toBe("已逾期");
    expect(priorityReason({ ...baseTask, plannedDate: "2026-08-19" }, now)).toBe("今天计划");
    expect(priorityReason({ ...baseTask, dependencyIds: ["parent"] }, now)).toBe("有前置关系");
    expect(priorityReason({ ...baseTask, sync: { status: "conflict" } }, now)).toBe("需要同步留意");
  });

  it("persists tag and date filters while upgrading older saved views", () => {
    const current = createSmartView({
      name: "逾期发布",
      route: "all",
      priority: "high",
      projectId: "发布",
      tag: "release",
      context: "办公室",
      dateFilter: "overdue",
    }, "2026-08-20T08:00:00.000Z");
    expect(current).toMatchObject({ tag: "release", context: "办公室", dateFilter: "overdue" });
    writeSmartViews([current!]);
    expect(readSmartViews()[0]).toMatchObject({ tag: "release", context: "办公室", dateFilter: "overdue" });

    window.localStorage.setItem(
      SMART_VIEWS_STORAGE_KEY,
      JSON.stringify([
        {
          id: "legacy-view",
          name: "旧版视图",
          route: "all",
          priority: "all",
          projectId: "all",
          createdAt: "2026-08-19T08:00:00.000Z",
          updatedAt: "2026-08-19T08:00:00.000Z",
        },
      ]),
    );
    expect(readSmartViews()[0]).toMatchObject({
      id: "legacy-view",
      tag: "all",
      context: "all",
      dateFilter: "any",
      sort: "manual",
    });
  });

  it("sorts saved-view results deterministically without mutating the snapshot", () => {
    const tasks = [
      {
        id: "low",
        title: "Zeta",
        priority: "low",
        dueAt: "2026-08-22T09:00:00.000Z",
        createdAt: "2026-08-20T09:00:00.000Z",
      },
      {
        id: "urgent",
        title: "Alpha",
        priority: "urgent",
        dueAt: "2026-08-24T09:00:00.000Z",
        createdAt: "2026-08-20T10:00:00.000Z",
      },
      {
        id: "no-due",
        title: "Beta",
        priority: "medium",
        createdAt: "2026-08-20T11:00:00.000Z",
      },
    ] as const;
    expect(sortSmartViewTasks(tasks, "priority").map((task) => task.id)).toEqual([
      "urgent",
      "no-due",
      "low",
    ]);
    expect(sortSmartViewTasks(tasks, "due").map((task) => task.id)).toEqual([
      "low",
      "urgent",
      "no-due",
    ]);
    expect(sortSmartViewTasks(tasks, "title").map((task) => task.id)).toEqual([
      "urgent",
      "no-due",
      "low",
    ]);
    expect(sortSmartViewTasks(tasks, "created").map((task) => task.id)).toEqual([
      "no-due",
      "urgent",
      "low",
    ]);
    expect(sortSmartViewTasks(tasks, "manual").map((task) => task.id)).toEqual([
      "low",
      "urgent",
      "no-due",
    ]);
    expect(tasks.map((task) => task.id)).toEqual(["low", "urgent", "no-due"]);
  });
});
