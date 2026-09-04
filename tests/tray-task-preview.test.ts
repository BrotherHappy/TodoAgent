import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import { buildTrayTodaySummary } from "../electron/tray-task-preview";

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  source: { type: "local" },
  title: id,
  notes: "",
  privateNotes: "",
  status: "open",
  priority: "none",
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
  createdAt: "2026-08-21T08:00:00.000Z",
  updatedAt: "2026-08-21T08:00:00.000Z",
  ...patch,
});

describe("tray task preview", () => {
  it("keeps only open tasks and caps the preview without changing order", () => {
    expect(
      buildTrayTodaySummary([
        task("第一项"),
        task("已完成", { status: "completed" }),
        task("第二项"),
        task("已删除", { deletedAt: "2026-08-21T09:00:00.000Z" }),
        task("第三项"),
        task("第四项"),
      ]),
    ).toEqual({
      totalOpen: 4,
      tasks: [
        { id: "第一项", title: "第一项" },
        { id: "第二项", title: "第二项" },
        { id: "第三项", title: "第三项" },
      ],
    });
  });

  it("redacts titles in privacy mode and handles blank titles", () => {
    expect(
      buildTrayTodaySummary(
        [task("secret", { title: "   " }), task("visible", { title: "不要泄露" })],
        { privacyMode: true, limit: 5 },
      ),
    ).toEqual({
      totalOpen: 2,
      tasks: [
        { id: "secret", title: "私人任务" },
        { id: "visible", title: "私人任务" },
      ],
    });
  });

  it("normalizes an invalid preview limit", () => {
    expect(buildTrayTodaySummary([task("one"), task("two")], { limit: -4 })).toEqual({
      totalOpen: 2,
      tasks: [],
    });
    expect(buildTrayTodaySummary([task("one"), task("two")], { limit: 99 }).tasks).toHaveLength(2);
  });

  it("keeps native tray labels short", () => {
    const longTitle = "这是一条很长很长的任务标题，用来确认系统托盘菜单不会被一条异常长的文本撑破或遮挡用户的其他菜单项。".repeat(3);
    const preview = buildTrayTodaySummary([task("long", { title: longTitle })]);
    expect(preview.tasks[0]?.title.length).toBe(72);
    expect(preview.tasks[0]?.title.endsWith("…")).toBe(true);
  });
});
