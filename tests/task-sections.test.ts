import { describe, expect, it } from "vitest";
import { groupTasksBySection } from "../src/renderer/task-sections";
import {
  readTaskSectionCollapseState,
  taskSectionGroupKey,
  toggleTaskSectionCollapse,
  writeTaskSectionCollapseState,
} from "../src/renderer/task-section-state";
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

  it("keeps collapse state separate from task data and toggles it immutably", () => {
    const groupKey = taskSectionGroupKey("open", "本周发布");
    const initial = { "all:local": ["completed:旧"] };
    const collapsed = toggleTaskSectionCollapse(
      initial,
      "all:local",
      groupKey,
      true,
    );
    expect(initial).toEqual({ "all:local": ["completed:旧"] });
    expect(collapsed["all:local"]).toEqual(["completed:旧", groupKey]);
    const expanded = toggleTaskSectionCollapse(
      collapsed,
      "all:local",
      groupKey,
      false,
    );
    expect(expanded["all:local"]).toEqual(["completed:旧"]);
  });

  it("round-trips valid collapse state and ignores malformed storage", () => {
    const storage = new Map<string, string>();
    const adapter: Storage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
      clear: () => void storage.clear(),
      key: (index) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
    };
    writeTaskSectionCollapseState(
      { "all:local": ["open:本周发布", "open:本周发布", "  "] },
      adapter,
    );
    expect(readTaskSectionCollapseState(adapter)).toEqual({
      "all:local": ["open:本周发布"],
    });
    adapter.setItem("todoAgentTaskSectionCollapsed", "{bad json");
    expect(readTaskSectionCollapseState(adapter)).toEqual({});
  });
});
