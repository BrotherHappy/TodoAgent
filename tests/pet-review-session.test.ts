import { describe, expect, it } from "vitest";
import { buildPetReviewSessionItems } from "../src/renderer/pet-review-session";
import type { Task } from "../src/shared/models";

const task = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
  id,
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
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  ...overrides,
});

describe("pet review session", () => {
  it("keeps the factual review order and explains every reason", () => {
    const items = buildPetReviewSessionItems(
      [
        task("blocked", "先完成依赖", { dependencyIds: ["missing"] }),
        task("overdue", "过期任务", { dueAt: "2026-08-08T09:00:00.000Z", priority: "urgent" }),
        task("unplanned", "还没安排"),
      ],
      "2026-08-09",
    );
    expect(items.map((item) => item.task.id)).toEqual(["overdue", "unplanned", "blocked"]);
    expect(items.find((item) => item.task.id === "overdue")?.reasons).toEqual(["逾期", "待排时间"]);
    expect(items.find((item) => item.task.id === "blocked")?.reasons).toEqual(["被阻塞", "待排时间"]);
  });

  it("does not include completed or deleted tasks", () => {
    const items = buildPetReviewSessionItems([
      task("done", "已完成", { status: "completed" }),
      task("deleted", "已删除", { deletedAt: "2026-08-09T00:00:00.000Z" }),
      task("open", "开放任务"),
    ], "2026-08-09");
    expect(items.map((item) => item.task.id)).toEqual(["open"]);
  });
});
