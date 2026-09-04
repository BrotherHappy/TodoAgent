import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import { buildPetReviewSummary } from "../src/renderer/pet-review";

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

describe("pet review", () => {
  it("groups overdue, blocked, and unplanned work while de-duplicating the summary", () => {
    const result = buildPetReviewSummary([
      task("urgent", {
        priority: "urgent",
        dueAt: "2026-08-18",
        dependencyIds: ["missing"],
      }),
      task("unplanned-2"),
      task("done", { status: "completed" }),
    ], "2026-08-19");

    expect(result).toMatchObject({
      localDate: "2026-08-19",
      clear: false,
      headline: "有 2 项任务值得看一眼，可以分几次慢慢处理。",
      nextTask: expect.objectContaining({ id: "urgent" }),
    });
    expect(result.overdue.tasks.map((item) => item.id)).toEqual(["urgent"]);
    expect(result.blocked.tasks.map((item) => item.id)).toEqual(["urgent"]);
    expect(result.unplanned.tasks.map((item) => item.id)).toEqual(["urgent", "unplanned-2"]);
    expect(result.tasks.map((item) => item.id)).toEqual(["urgent", "unplanned-2"]);
  });

  it("does not flag tasks with a future plan or completed dependencies", () => {
    const result = buildPetReviewSummary([
      task("dependency", { status: "completed" }),
      task("scheduled", {
        dependencyIds: ["dependency"],
        startAt: "2026-08-19T10:00:00.000Z",
      }),
      task("future", { plannedDate: "2026-08-21" }),
    ], "2026-08-19");

    expect(result.clear).toBe(true);
    expect(result.tasks).toHaveLength(0);
    expect(result.headline).toContain("没有需要特别整理");
  });

  it("returns an empty review when deleted and completed tasks are the only records", () => {
    const result = buildPetReviewSummary([
      task("deleted", { deletedAt: "2026-08-19T08:00:00.000Z" }),
      task("completed", { status: "completed", dueAt: "2026-08-18" }),
    ], "2026-08-19");
    expect(result.clear).toBe(true);
    expect(result.overdue.tasks).toHaveLength(0);
  });
});
