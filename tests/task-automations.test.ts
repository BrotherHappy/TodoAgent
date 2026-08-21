import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import {
  createTaskAutomationRule,
  matchesTaskAutomation,
  normalizeTaskAutomationRules,
  taskAutomationPatch,
  taskAutomationTrigger,
  taskAutomationTriggerLabel,
} from "../src/shared/task-automations";
import { TaskAutomationService } from "../electron/services/task-automation-service";

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  source: { type: "local" },
  title: id,
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
  createdAt: "2026-08-21T08:00:00.000Z",
  updatedAt: "2026-08-21T08:00:00.000Z",
  ...patch,
});

const rule = (patch: Partial<Parameters<typeof createTaskAutomationRule>[0]> = {}) =>
  createTaskAutomationRule({
    id: "rule-1",
    name: "新任务加重点",
    trigger: "task-created",
    action: { kind: "set-flagged", value: true },
    ...patch,
  }, "2026-08-21T09:00:00.000Z");

describe("task automation rules", () => {
  it("normalizes malformed settings defensively and caps duplicate rules", () => {
    const valid = rule();
    expect(normalizeTaskAutomationRules([
      valid,
      valid,
      { ...valid, id: "bad", action: { kind: "set-defer-until", value: "not-a-date" } },
    ])).toEqual([valid]);
    expect(normalizeTaskAutomationRules(
      Array.from({ length: 55 }, (_, index) => ({ ...valid, id: `rule-${index}` })),
    )).toHaveLength(50);
  });

  it("matches source and private context conditions", () => {
    const target = task("target", {
      source: { type: "feishu" },
      tags: ["发布"],
      contexts: ["办公室"],
      projectId: "project-1",
      listId: "list-1",
      sectionId: "本周发布",
    });
    const matching = rule({
      condition: {
        source: "feishu",
        projectId: "project-1",
        listId: "list-1",
        sectionId: "本周发布",
        tag: "发布",
        context: "办公室",
      },
    });
    expect(matchesTaskAutomation(matching, target)).toBe(true);
    expect(matchesTaskAutomation(rule({ condition: { source: "local" } }), target)).toBe(false);
    expect(matchesTaskAutomation(
      rule({ condition: { listId: "list-2" } }),
      target,
    )).toBe(false);
  });

  it("detects only creation and open-to-completed edges", () => {
    const open = task("t");
    const completed = task("t", { status: "completed", completedAt: "2026-08-21T10:00:00.000Z" });
    expect(taskAutomationTrigger(undefined, open)).toBe("task-created");
    expect(taskAutomationTrigger(open, completed)).toBe("task-completed");
    expect(taskAutomationTrigger(completed, completed)).toBeUndefined();
    expect(taskAutomationTrigger(open, task("t", { deletedAt: "2026-08-21T10:00:00.000Z" }))).toBeUndefined();
  });

  it("keeps manual rules out of background transition execution", async () => {
    const target = task("target");
    const calls: unknown[] = [];
    const manual = rule({
      trigger: "manual",
      action: { kind: "set-flagged", value: true },
    });
    const service = new TaskAutomationService(
      { updateTask: async (_id, patch) => { calls.push(patch); return { task: target }; } },
      () => [manual],
    );
    expect(taskAutomationTriggerLabel("manual")).toBe("手动应用时");
    expect((await service.applyTransition([], [target])).applied).toBe(0);
    expect(calls).toEqual([]);
  });

  it("creates private patches and skips no-ops", () => {
    const target = task("t", { tags: ["已有"], contexts: ["家"] });
    expect(taskAutomationPatch(rule({ action: { kind: "add-tag", value: "发布" } }), target)).toEqual({ tags: ["已有", "发布"] });
    expect(taskAutomationPatch(rule({ action: { kind: "add-tag", value: "已有" } }), target)).toBeUndefined();
    expect(taskAutomationPatch(rule({ action: { kind: "set-defer-until", value: "2026-08-22" } }), target)).toEqual({ deferUntil: "2026-08-22" });
    expect(taskAutomationPatch(rule({ action: { kind: "set-flagged", value: true } }), task("t", { flagged: true }))).toBeUndefined();
  });

  it("applies matching actions in rule order without touching shared fields", async () => {
    const created = task("new", { title: "保留标题", source: { type: "feishu" } });
    const calls: Array<{ id: string; patch: unknown }> = [];
    const service = new TaskAutomationService(
      {
        updateTask: async (id, patch) => {
          calls.push({ id, patch });
          return { task: { ...created, ...patch } };
        },
      },
      () => [
        rule({ condition: { source: "feishu" }, action: { kind: "set-flagged", value: true } }),
        rule({ id: "rule-2", name: "加标签", condition: { source: "feishu" }, action: { kind: "add-tag", value: "自动" } }),
      ],
    );
    const result = await service.applyTransition([], [created]);
    expect(result.applied).toBe(2);
    expect(calls).toEqual([
      { id: "new", patch: { flagged: true } },
      { id: "new", patch: { tags: ["自动"] } },
    ]);
    expect(created.title).toBe("保留标题");
  });

  it("isolates a failed rule to one task and keeps the failure explainable", async () => {
    const first = task("first");
    const second = task("second");
    const service = new TaskAutomationService(
      {
        updateTask: async (id) => {
          if (id === "first") throw new Error("WRITE_FAILED");
          return { task: second };
        },
      },
      () => [rule()],
    );
    const result = await service.applyTransition([], [first, second]);
    expect(result.applied).toBe(1);
    expect(result.taskIds).toEqual(["second"]);
    expect(result.failures).toEqual([{ taskId: "first", ruleId: "rule-1", error: "WRITE_FAILED" }]);
  });
});
