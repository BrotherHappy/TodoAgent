import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import { suggestMorningRollover } from "../src/renderer/morning-rollover";

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
  plannedDate: "2026-08-19",
  privateOrder: 0,
  reminders: [],
  focusElapsedSeconds: 0,
  sync: { status: "local" },
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  ...overrides,
});

describe("suggestMorningRollover", () => {
  it("returns only open plans from earlier local dates and explains the age", () => {
    const result = suggestMorningRollover([
      task("yesterday", { priority: "high" }),
      task("today", { plannedDate: "2026-08-20" }),
      task("completed", { status: "completed" }),
      task("deleted", { deletedAt: "2026-08-19T08:00:00.000Z" }),
    ], "2026-08-20");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      task: { id: "yesterday" },
      plannedDate: "2026-08-19",
      daysAgo: 1,
      reason: "昨天的计划还没完成",
    });
  });

  it("sorts by priority, then deadline, and limits suggestions", () => {
    const result = suggestMorningRollover([
      task("low", { priority: "low", plannedDate: "2026-08-10" }),
      task("urgent", { priority: "urgent", plannedDate: "2026-08-10" }),
      task("deadline", {
        priority: "medium",
        dueAt: "2026-08-20T09:00:00.000Z",
        plannedDate: "2026-08-18",
      }),
      task("another", { plannedDate: "2026-08-17" }),
    ], "2026-08-20", 2);

    expect(result.map((item) => item.task.id)).toEqual(["urgent", "deadline"]);
  });

  it("does not infer a rollover when the date is invalid or suggestions are disabled", () => {
    expect(suggestMorningRollover([task("one")], "not-a-date")).toEqual([]);
    expect(suggestMorningRollover([task("one")], "2026-02-30")).toEqual([]);
    expect(suggestMorningRollover([task("one")], "2026-08-20", 0)).toEqual([]);
  });
});
