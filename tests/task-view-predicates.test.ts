import { describe, expect, it } from "vitest";

import type { Task } from "../src/shared/models";
import { isInboxTask } from "../src/shared/task-view-predicates";

const baseTask = (): Task => ({
  id: "inbox-candidate",
  source: { type: "local" },
  title: "暂存任务",
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
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
});

describe("isInboxTask", () => {
  it("accepts only open tasks without any scheduling or ownership field", () => {
    expect(isInboxTask(baseTask())).toBe(true);

    const excluded = [
      { plannedDate: "2026-08-31" },
      { deferUntil: "2026-09-01" },
      { startAt: "2026-08-31T09:00:00.000Z" },
      { dueAt: "2026-08-31T17:00:00.000Z" },
      { projectId: "project-1" },
      { listId: "list-1" },
      { status: "completed" as const },
      { deletedAt: "2026-08-31T00:01:00.000Z" },
    ];

    for (const patch of excluded) {
      expect(isInboxTask({ ...baseTask(), ...patch })).toBe(false);
    }
  });
});
