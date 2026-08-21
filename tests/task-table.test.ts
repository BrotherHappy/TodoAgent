import { describe, expect, it } from "vitest";

import {
  taskTableDateLabel,
  taskTablePriorityLabels,
  taskTableSyncLabel,
} from "../src/renderer/TaskTable";

describe("task table projection", () => {
  it("keeps today dates compact and prefers deadlines over private planning", () => {
    const today = new Date("2026-08-21T09:00:00+08:00");
    expect(
      taskTableDateLabel(
        {
          dueAt: "2026-08-21T18:30:00+08:00",
          dueAtIsAllDay: false,
          plannedDate: "2026-08-21",
          deferUntil: undefined,
        },
        today,
      ),
    ).toContain("截止 今天");
    expect(
      taskTableDateLabel(
        {
          dueAt: undefined,
          dueAtIsAllDay: false,
          plannedDate: "2026-08-21",
          deferUntil: undefined,
        },
        today,
      ),
    ).toBe("计划 今天");
  });

  it("falls back to defer and no-date labels", () => {
    const today = new Date("2026-08-21T09:00:00+08:00");
    expect(
      taskTableDateLabel(
        {
          dueAt: undefined,
          dueAtIsAllDay: false,
          plannedDate: undefined,
          deferUntil: "2026-08-25",
        },
        today,
      ),
    ).toBe("稍后 2026-08-25");
    expect(
      taskTableDateLabel(
        {
          dueAt: undefined,
          dueAtIsAllDay: false,
          plannedDate: undefined,
          deferUntil: undefined,
        },
        today,
      ),
    ).toBe("未安排");
  });

  it("exposes stable priority and sync labels for the table", () => {
    expect(taskTablePriorityLabels.urgent).toBe("紧急");
    expect(taskTablePriorityLabels.none).toBe("无");
    expect(taskTableSyncLabel("permission-denied")).toBe("权限不足");
    expect(taskTableSyncLabel("remote-deleted")).toBe("远端已删除");
  });
});

