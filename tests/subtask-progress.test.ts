import { describe, expect, it } from "vitest";
import { buildSubtaskProgress, subtaskProgressLabel } from "../src/renderer/subtask-progress";

const task = (id: string, parentId?: string, status: "open" | "completed" = "open", deletedAt?: string) => ({
  id,
  parentId,
  status,
  deletedAt,
});

describe("subtask progress", () => {
  it("counts visible children by parent and ignores deleted children", () => {
    const progress = buildSubtaskProgress([
      task("child-1", "parent", "completed"),
      task("child-2", "parent", "open"),
      task("child-deleted", "parent", "completed", "2026-08-20T10:00:00.000Z"),
      task("other", "other-parent", "completed"),
      task("root"),
    ]);
    expect(progress.get("parent")).toEqual({ total: 2, completed: 1 });
    expect(progress.get("other-parent")).toEqual({ total: 1, completed: 1 });
    expect(progress.has("root")).toBe(false);
    expect(subtaskProgressLabel(progress.get("parent"))).toBe("子任务 1/2");
  });

  it("does not invent progress for an empty or missing parent", () => {
    expect(subtaskProgressLabel()).toBeUndefined();
    expect(subtaskProgressLabel({ total: 0, completed: 0 })).toBeUndefined();
  });
});
