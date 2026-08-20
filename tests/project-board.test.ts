import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import { buildProjectBoardColumns, projectBoardColumn, projectIdsForBoard } from "../src/renderer/project-board";

const task = (id: string, title: string, patch: Partial<Task> = {}): Task => ({
  id,
  source: { type: "local" },
  title,
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
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  ...patch,
});

describe("project board", () => {
  it("groups project tasks into actionable, blocked and done columns", () => {
    const base = task("a", "先做", { projectId: "项目" });
    const blocked = task("b", "后做", { projectId: "项目", dependencyIds: ["a"] });
    const done = task("c", "完成", { projectId: "项目", status: "completed" });
    const columns = buildProjectBoardColumns([base, blocked, done]);
    expect(columns.map((column) => column.tasks.map((item) => item.title))).toEqual([
      ["先做"],
      ["后做"],
      ["完成"],
    ]);
  });

  it("keeps missing dependencies visibly blocked instead of dropping them", () => {
    const orphan = task("a", "外部依赖", { projectId: "项目", dependencyIds: ["remote"] });
    expect(projectBoardColumn(orphan, new Map([[orphan.id, orphan]]))).toBe("blocked");
  });

  it("filters by project and ignores deleted or unprojected tasks", () => {
    const tasks = [
      task("a", "A", { projectId: "Alpha" }),
      task("b", "B", { projectId: "Beta" }),
      task("c", "C"),
      task("d", "D", { projectId: "Alpha", deletedAt: "2026-08-20T00:00:00.000Z" }),
    ];
    expect(projectIdsForBoard(tasks)).toEqual(["Alpha", "Beta"]);
    expect(buildProjectBoardColumns(tasks, "Alpha").flatMap((column) => column.tasks).map((item) => item.title)).toEqual(["A"]);
  });
});
