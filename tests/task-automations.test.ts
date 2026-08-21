import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import {
  createTaskAutomationRule,
  matchesTaskAutomation,
  normalizeTaskAutomationRules,
  taskAutomationPatch,
  taskAutomationDeadlineDue,
  taskAutomationDeadlineLabel,
  taskAutomationScheduleDue,
  taskAutomationScheduleLabel,
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
    expect(normalizeTaskAutomationRules([
      { ...valid, trigger: "scheduled" },
      {
        ...valid,
        trigger: "scheduled",
        schedule: { frequency: "weekly", time: "08:30", weekdays: [1, 5] },
      },
    ])).toHaveLength(1);
    expect(normalizeTaskAutomationRules([
      { ...valid, trigger: "deadline-approaching" },
      { ...valid, trigger: "deadline-approaching", deadlineWindowMinutes: 60 },
      { ...valid, trigger: "task-created", deadlineWindowMinutes: 60 },
    ])).toHaveLength(1);
    expect(normalizeTaskAutomationRules([
      {
        ...valid,
        condition: { anyOf: [{ projectId: "project-a" }, { tag: "发布" }] },
      },
      { ...valid, id: "empty-any", condition: { anyOf: [{}] } },
      { ...valid, id: "nested-any", condition: { anyOf: [{ anyOf: [{ tag: "发布" }] }] } },
      { ...valid, id: "unknown-condition", condition: { tag: "发布", arbitrary: "value" } },
      {
        ...valid,
        id: "too-many-any",
        condition: { anyOf: Array.from({ length: 6 }, (_, index) => ({ tag: `tag-${index}` })) },
      },
    ])).toHaveLength(1);
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
    const alternative = rule({
      condition: {
        source: "feishu",
        anyOf: [{ projectId: "project-1" }, { tag: "未命中" }],
      },
    });
    expect(matchesTaskAutomation(alternative, target)).toBe(true);
    expect(matchesTaskAutomation(
      rule({
        condition: {
          source: "feishu",
          anyOf: [{ projectId: "project-2" }, { tag: "未命中" }],
        },
      }),
      target,
    )).toBe(false);
    expect(matchesTaskAutomation(
      rule({ condition: { source: "local", anyOf: [{ projectId: "project-1" }] } }),
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

  it("evaluates daily and weekly schedules once per local period", () => {
    const daily = rule({
      trigger: "scheduled",
      schedule: { frequency: "daily", time: "09:00" },
    });
    const friday = new Date(2026, 7, 21, 9, 1);
    expect(taskAutomationScheduleDue(daily, new Date(2026, 7, 21, 8, 59))).toBe(false);
    expect(taskAutomationScheduleDue(daily, friday)).toBe(true);
    expect(taskAutomationScheduleDue(
      rule({
        trigger: "scheduled",
        schedule: {
          frequency: "daily",
          time: "09:00",
          lastRunAt: friday.toISOString(),
        },
      }),
      new Date(2026, 7, 21, 12, 0),
    )).toBe(false);
    const weekly = rule({
      trigger: "scheduled",
      schedule: { frequency: "weekly", time: "10:00", weekdays: [1, 3, 5] },
    });
    expect(taskAutomationScheduleDue(weekly, friday)).toBe(false);
    expect(taskAutomationScheduleDue(weekly, new Date(2026, 7, 19, 10, 0))).toBe(true);
    expect(taskAutomationScheduleLabel(weekly.schedule!)).toBe("周一、周三、周五 10:00");
  });

  it("applies due schedules only to open tasks and reports one consumed period", async () => {
    const open = task("open", { source: { type: "feishu" }, tags: ["发布"] });
    const completed = task("done", { status: "completed" });
    const calls: Array<{ id: string; patch: unknown }> = [];
    const scheduled = rule({
      trigger: "scheduled",
      condition: { source: "feishu", tag: "发布" },
      schedule: { frequency: "daily", time: "09:00" },
      action: { kind: "set-flagged", value: true },
    });
    const service = new TaskAutomationService(
      {
        updateTask: async (id, patch) => {
          calls.push({ id, patch });
          return { task: { ...open, ...patch } };
        },
      },
      () => [scheduled],
    );
    const result = await service.applyScheduled(
      [open, completed],
      new Date(2026, 7, 21, 9, 1),
    );
    expect(result.scheduledRuleIds).toEqual(["rule-1"]);
    expect(result.applied).toBe(1);
    expect(result.taskIds).toEqual(["open"]);
    expect(calls).toEqual([{ id: "open", patch: { flagged: true } }]);
  });

  it("detects a local lead window without treating overdue work as approaching", () => {
    const now = new Date("2026-08-21T09:00:00.000Z");
    const deadline = rule({
      trigger: "deadline-approaching",
      deadlineWindowMinutes: 60,
    });
    expect(taskAutomationDeadlineLabel(120)).toBe("截止前 2 小时");
    expect(taskAutomationDeadlineDue(
      deadline,
      task("soon", { dueAt: "2026-08-21T09:45:00.000Z" }),
      now,
    )).toBe(true);
    expect(taskAutomationDeadlineDue(
      deadline,
      task("later", { dueAt: "2026-08-21T11:00:00.000Z" }),
      now,
    )).toBe(false);
    expect(taskAutomationDeadlineDue(
      deadline,
      task("late", { dueAt: "2026-08-21T08:59:00.000Z" }),
      now,
    )).toBe(false);
    expect(taskAutomationDeadlineDue(
      deadline,
      task("done", { status: "completed", dueAt: "2026-08-21T09:30:00.000Z" }),
      now,
    )).toBe(false);
    expect(taskAutomationDeadlineDue(
      deadline,
      task("all-day", { dueAt: new Date(2026, 7, 21, 0, 0, 0).toISOString(), dueAtIsAllDay: true }),
      new Date(2026, 7, 21, 23, 30, 0),
    )).toBe(true);
  });

  it("applies deadline rules to open tasks, keeps actions private, and skips no-ops", async () => {
    const now = new Date("2026-08-21T09:00:00.000Z");
    const soon = task("soon", {
      source: { type: "feishu" },
      dueAt: "2026-08-21T09:20:00.000Z",
    });
    const completed = task("done", {
      status: "completed",
      dueAt: "2026-08-21T09:20:00.000Z",
    });
    const calls: Array<{ id: string; patch: unknown }> = [];
    const deadline = rule({
      trigger: "deadline-approaching",
      condition: { source: "feishu" },
      deadlineWindowMinutes: 60,
      action: { kind: "add-tag", value: "快到期" },
    });
    const service = new TaskAutomationService(
      {
        updateTask: async (id, patch) => {
          calls.push({ id, patch });
          return { task: { ...soon, ...patch } };
        },
      },
      () => [deadline],
    );
    const result = await service.applyDeadlineApproaching([soon, completed], now);
    expect(result.applied).toBe(1);
    expect(result.deadlineRuleIds).toEqual(["rule-1"]);
    expect(result.taskIds).toEqual(["soon"]);
    expect(calls).toEqual([{ id: "soon", patch: { tags: ["快到期"] } }]);
    expect(soon.title).toBe("soon");
    expect(soon.dueAt).toBe("2026-08-21T09:20:00.000Z");
    const alreadyTagged = task("tagged", {
      dueAt: "2026-08-21T09:20:00.000Z",
      tags: ["快到期"],
    });
    const noOpCalls: unknown[] = [];
    const noOpService = new TaskAutomationService(
      { updateTask: async (_id, patch) => { noOpCalls.push(patch); return { task: alreadyTagged }; } },
      () => [deadline],
    );
    expect((await noOpService.applyDeadlineApproaching([alreadyTagged], now)).applied).toBe(0);
    expect(noOpCalls).toEqual([]);
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
