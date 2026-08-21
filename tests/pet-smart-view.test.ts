import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import { filterTasksForPetView } from "../src/renderer/pet-smart-view";
import type { SmartViewDefinition } from "../src/renderer/smart-views";

const task = ({ id, title, ...overrides }: Partial<Task> & Pick<Task, "id" | "title">): Task => ({
  id,
  title,
  notes: "",
  privateNotes: "",
  status: "open",
  priority: "medium",
  tags: [],
  contexts: [],
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
  source: { type: "local" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const view = (overrides: Partial<SmartViewDefinition> = {}): SmartViewDefinition => ({
  id: "view-1",
  name: "测试视图",
  route: "all",
  priority: "all",
  projectId: "all",
  tag: "all",
  context: "all",
  dateFilter: "any",
  sort: "manual",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

describe("filterTasksForPetView", () => {
  it("filters by project, source, tag and case-insensitive context", () => {
    const tasks = [
      task({ id: "match", title: "办公室发布", projectId: "work", tags: ["发布"], contexts: ["办公室"], source: { type: "feishu" } }),
      task({ id: "other-project", title: "私人发布", projectId: "home", tags: ["发布"], contexts: ["办公室"], source: { type: "feishu" } }),
      task({ id: "other-source", title: "本地发布", projectId: "work", tags: ["发布"], contexts: ["办公室"], source: { type: "local" } }),
    ];
    expect(filterTasksForPetView(tasks, view({ projectId: "work", tag: "发布", context: "办公室", sourceType: "feishu" }))).toHaveLength(1);
    expect(filterTasksForPetView(tasks, view({ projectId: "work", tag: "发布", context: "办公室", sourceType: "feishu" }))[0]?.id).toBe("match");
  });

  it("applies date filters and stable saved-view sorting", () => {
    const tasks = [
      task({ id: "later", title: "稍后", dueAt: "2026-08-24T10:00:00.000Z", priority: "high" }),
      task({ id: "today", title: "今天", dueAt: "2026-08-20T10:00:00.000Z", priority: "medium" }),
      task({ id: "overdue", title: "逾期", dueAt: "2026-08-19T10:00:00.000Z", priority: "urgent" }),
    ];
    expect(filterTasksForPetView(tasks, view({ dateFilter: "overdue", sort: "priority" }), new Date("2026-08-20T08:00:00+08:00")).map((item) => item.id)).toEqual(["overdue"]);
    expect(filterTasksForPetView(tasks, view({ dateFilter: "next-7-days", sort: "due" }), new Date("2026-08-20T08:00:00+08:00")).map((item) => item.id)).toEqual(["later"]);
  });

  it("never returns completed or deleted tasks", () => {
    const tasks = [
      task({ id: "open", title: "开放" }),
      task({ id: "done", title: "完成", status: "completed" }),
      task({ id: "deleted", title: "删除", deletedAt: "2026-08-20T00:00:00.000Z" }),
    ];
    expect(filterTasksForPetView(tasks, view()).map((item) => item.id)).toEqual(["open"]);
  });

  it("preserves the saved collection route before applying its extra filters", () => {
    const tasks = [
      task({ id: "today", title: "今天计划", plannedDate: "2026-08-20" }),
      task({ id: "inbox", title: "暂存" }),
      task({ id: "future", title: "未来", dueAt: "2026-08-24T10:00:00.000Z" }),
    ];
    const today = new Date("2026-08-20T08:00:00+08:00");
    expect(filterTasksForPetView(tasks, view({ route: "today" }), today).map((item) => item.id)).toEqual(["today"]);
    expect(filterTasksForPetView(tasks, view({ route: "inbox" }), today).map((item) => item.id)).toEqual(["inbox"]);
  });

  it("lets the pet surface only locally flagged tasks", () => {
    const tasks = [
      task({ id: "flagged", title: "重点", flagged: true }),
      task({ id: "ordinary", title: "普通" }),
    ];
    expect(filterTasksForPetView(tasks, view({ flagged: true })).map((item) => item.id)).toEqual(["flagged"]);
  });
});
