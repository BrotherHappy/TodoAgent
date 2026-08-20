import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import { localIsoAt } from "../src/renderer/timeline-utils";
import {
  buildWorkCycleMetrics,
  formatCycleMinutes,
  workCycleFor,
} from "../src/renderer/work-cycles";

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

describe("work cycles", () => {
  it("starts on Monday and scales capacity across a two-week cycle", () => {
    expect(workCycleFor("2026-08-20", 1, 300)).toEqual({
      startDate: "2026-08-17",
      endDate: "2026-08-23",
      weeks: 1,
      capacityMinutes: 300,
    });
    expect(workCycleFor("2026-08-20", 2, 300)).toMatchObject({
      startDate: "2026-08-17",
      endDate: "2026-08-30",
      weeks: 2,
      capacityMinutes: 600,
    });
  });

  it("separates timed work, planned-but-unscheduled work, and candidates", () => {
    const cycle = workCycleFor("2026-08-20", 1, 240);
    const metrics = buildWorkCycleMetrics([
      makeTask("有时间", { startAt: localIsoAt("2026-08-18", 9 * 60), estimatedMinutes: 60 }),
      makeTask("待排", { plannedDate: "2026-08-19", estimatedMinutes: 90 }),
      makeTask("截止候选", { dueAt: localIsoAt("2026-08-20", 18 * 60), estimatedMinutes: 45 }),
      makeTask("无日期候选", { priority: "high", estimatedMinutes: 30 }),
      makeTask("未来任务", { plannedDate: "2026-08-31", estimatedMinutes: 120 }),
      makeTask("本周期完成", { status: "completed", completedAt: localIsoAt("2026-08-18", 16 * 60) }),
    ], cycle);

    expect(metrics.scheduledTasks.map((task) => task.id)).toEqual(["有时间"]);
    expect(metrics.unscheduledTasks.map((task) => task.id)).toEqual(["待排"]);
    expect(metrics.plannedMinutes).toBe(150);
    expect(metrics.remainingMinutes).toBe(90);
    expect(metrics.loadRatio).toBeCloseTo(0.625);
    expect(metrics.completedTasks.map((task) => task.id)).toEqual(["本周期完成"]);
    expect(metrics.candidateTasks.map((task) => task.id)).toEqual(["无日期候选", "截止候选", "待排"]);
    expect(metrics.openTasks.map((task) => task.id)).toEqual(["截止候选", "待排", "有时间"]);
  });

  it("sorts candidates by priority, due date, manual order, and title", () => {
    const cycle = workCycleFor("2026-08-20", 1, 240);
    const metrics = buildWorkCycleMetrics([
      makeTask("普通", { priority: "low" }),
      makeTask("紧急无日期", { priority: "urgent" }),
      makeTask("高优先级晚截止", { priority: "high", dueAt: localIsoAt("2026-08-22", 12 * 60) }),
      makeTask("高优先级早截止", { priority: "high", dueAt: localIsoAt("2026-08-21", 12 * 60) }),
    ], cycle);
    expect(metrics.candidateTasks.map((task) => task.id)).toEqual([
      "紧急无日期",
      "高优先级早截止",
      "高优先级晚截止",
      "普通",
    ]);
  });

  it("does not let deleted tasks or overdue assigned work distort the cycle", () => {
    const cycle = workCycleFor("2026-08-20", 1, 120);
    const metrics = buildWorkCycleMetrics([
      makeTask("已删除", { deletedAt: "2026-08-19T00:00:00.000Z", plannedDate: "2026-08-18", estimatedMinutes: 120 }),
      makeTask("已安排", { plannedDate: "2026-08-18", estimatedMinutes: 90 }),
      makeTask("逾期截止", { dueAt: localIsoAt("2026-08-10", 12 * 60), estimatedMinutes: 45 }),
    ], cycle);
    expect(metrics.plannedMinutes).toBe(90);
    expect(metrics.openTasks.map((task) => task.id)).toEqual(["逾期截止", "已安排"]);
    expect(metrics.overloadMinutes).toBe(0);
    expect(metrics.candidateTasks.map((task) => task.id)).toEqual(["逾期截止", "已安排"]);
  });

  it("formats compact capacity labels", () => {
    expect(formatCycleMinutes(45)).toBe("45 分钟");
    expect(formatCycleMinutes(120)).toBe("2 小时");
    expect(formatCycleMinutes(155)).toBe("2 小时 35 分钟");
  });
});
