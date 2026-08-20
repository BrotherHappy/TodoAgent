import { describe, expect, it } from "vitest";
import type { Task, TaskProject } from "../src/shared/models";
import { projectPetChapters } from "../src/renderer/pet-project-chapters";

const task = (patch: Partial<Task>): Task => ({
  id: patch.id ?? crypto.randomUUID(),
  source: { type: "local" },
  title: patch.title ?? "任务",
  notes: "",
  privateNotes: "",
  status: patch.status ?? "open",
  priority: patch.priority ?? "medium",
  projectId: patch.projectId,
  tags: [],
  dependencyIds: [],
  assigneeIds: [],
  followerIds: [],
  attachments: [],
  links: [],
  customFields: {},
  reminders: [],
  focusElapsedSeconds: 0,
  privateOrder: patch.privateOrder ?? 0,
  sync: { status: "local" },
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
  ...patch,
});

const project = (id: string, name: string): TaskProject => ({
  id,
  name,
  color: "violet",
  archived: false,
  privateOrder: 0,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
});

describe("projectPetChapters", () => {
  it("projects progress and the next task without duplicating tasks", () => {
    const chapters = projectPetChapters(
      [
        task({ id: "done", projectId: "p1", status: "completed", title: "已完成" }),
        task({ id: "later", projectId: "p1", title: "稍后做", dueAt: "2026-08-23T00:00:00.000Z" }),
        task({ id: "next", projectId: "p1", title: "先做这件", dueAt: "2026-08-22T00:00:00.000Z" }),
        task({ id: "next", projectId: "p1", title: "重复快照" }),
        task({ id: "deleted", projectId: "p1", deletedAt: "2026-08-21T00:00:00.000Z" }),
      ],
      [project("p1", "发布 Todo Pet")],
    );

    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({
      totalCount: 3,
      completedCount: 1,
      openCount: 2,
      progress: 33,
      nextTaskId: "next",
      nextTaskTitle: "先做这件",
    });
  });

  it("omits archived and unassigned projects and respects the chapter limit", () => {
    const chapters = projectPetChapters(
      [
        task({ id: "a", projectId: "p1" }),
        task({ id: "b", projectId: "p2" }),
        task({ id: "c", projectId: "p3" }),
        task({ id: "d", title: "没有项目" }),
      ],
      [
        project("p1", "Alpha"),
        project("p2", "Beta"),
        { ...project("p3", "Archived"), archived: true },
        { ...project("p4", "Empty"), archived: false },
      ],
      1,
    );

    expect(chapters).toHaveLength(1);
    expect(chapters[0].name).toBe("Alpha");
  });
});
