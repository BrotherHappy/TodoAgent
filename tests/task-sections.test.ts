import { describe, expect, it } from "vitest";
import { groupTasksBySection } from "../src/renderer/task-sections";
import type { Task } from "../src/shared/models";

const task = (id: string, sectionId?: string): Task =>
  ({
    id,
    title: id,
    source: { type: "local" },
    notes: "",
    privateNotes: "",
    status: "open",
    priority: "none",
    ...(sectionId === undefined ? {} : { sectionId }),
    tags: [],
    dependencyIds: [],
    assigneeIds: [],
    followerIds: [],
    attachments: [],
    links: [],
    customFields: {},
    plannedDate: undefined,
    reminders: [],
    focusElapsedSeconds: 0,
    privateOrder: 0,
    sync: { status: "local" },
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  }) as Task;

describe("local task section headings", () => {
  it("keeps first-seen heading order and task order", () => {
    const groups = groupTasksBySection([
      task("a", "本周发布"),
      task("b"),
      task("c", "本周发布"),
      task("d", "下周"),
    ]);
    expect(groups.map((group) => [group.label, group.tasks.map((item) => item.id)])).toEqual([
      ["本周发布", ["a", "c"]],
      [undefined, ["b"]],
      ["下周", ["d"]],
    ]);
  });

  it("treats whitespace-only headings as ungrouped", () => {
    const groups = groupTasksBySection([task("a", "  ")]);
    expect(groups).toMatchObject([{ id: "__ungrouped__", tasks: [{ id: "a" }] }]);
    expect(groups[0]?.label).toBeUndefined();
  });
});
