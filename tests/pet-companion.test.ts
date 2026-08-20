import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import { defaultSettings } from "../src/shared/settings";
import {
  buildPetProactiveSuggestion,
  proactiveBudgetAvailable,
  proactiveMessagesForDate,
  shouldSuppressPetProactive,
} from "../src/renderer/pet-companion";

const makeTask = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
  id,
  source: { type: "local" },
  title,
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
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  ...overrides,
});

describe("pet companion proactive behavior", () => {
  it("respects focus, meeting, mute, fullscreen and overnight quiet hours", () => {
    const settings = structuredClone(defaultSettings);
    settings.notifications.quietHoursEnabled = true;
    settings.notifications.quietHoursStart = "22:00";
    settings.notifications.quietHoursEnd = "08:00";
    expect(
      shouldSuppressPetProactive({
        settings,
        now: new Date("2026-08-15T23:30:00"),
        focusActive: false,
      }),
    ).toBe(true);
    expect(
      shouldSuppressPetProactive({
        settings: defaultSettings,
        now: new Date("2026-08-15T12:00:00"),
        focusActive: true,
      }),
    ).toBe(true);
  });

  it("prioritizes sync and weather warnings, then offers a gentle morning brief", () => {
    const now = new Date("2026-08-15T08:00:00");
    expect(
      buildPetProactiveSuggestion({
        now,
        tasks: [],
        petName: "小序",
        syncProblem: true,
      }).kind,
    ).toBe("sync");
    expect(
      buildPetProactiveSuggestion({ now, tasks: [], petName: "小序" }).kind,
    ).toBe("morning");
  });

  it("keeps the renderer companion budget aligned to the local calendar day", () => {
    const messages = [
      { shownAt: "2026-08-15T01:00:00.000Z" },
      { shownAt: "2026-08-15T04:00:00.000Z" },
      { shownAt: "2026-08-14T04:00:00.000Z" },
    ];
    const now = new Date("2026-08-15T12:00:00.000Z");
    expect(proactiveMessagesForDate(messages, now)).toBe(2);
    expect(proactiveBudgetAvailable(messages, 2, now)).toBe(false);
    expect(proactiveBudgetAvailable(messages, 0, now)).toBe(true);
  });

  it("returns a deterministic actionable task card with an explanation", () => {
    const tasks = [
      makeTask("later", "整理资料", {
        priority: "urgent",
        dueAt: "2026-08-17T12:00:00.000Z",
      }),
      makeTask("blocked", "提交发布", {
        priority: "urgent",
        dueAt: "2026-08-15T10:00:00.000Z",
        dependencyIds: ["unfinished"],
      }),
      makeTask("first", "回复客户", {
        priority: "high",
        plannedDate: "2026-08-15",
      }),
      makeTask("unfinished", "先完成准备", { plannedDate: "2026-08-15" }),
    ];
    const suggestion = buildPetProactiveSuggestion({
      now: new Date("2026-08-15T08:00:00"),
      tasks,
      petName: "小序",
    });
    expect(suggestion.nextTask).toEqual({
      taskId: "first",
      taskTitle: "回复客户",
      reason: "已经安排在今天",
    });
    expect(suggestion.message).toContain("回复客户");
  });

  it("does not recommend deleted or completed tasks", () => {
    const tasks = [
      makeTask("done", "已完成", { status: "completed", priority: "urgent" }),
      makeTask("deleted", "已删除", { deletedAt: "2026-08-15T07:00:00.000Z", priority: "urgent" }),
      makeTask("open", "可以开始", { priority: "low" }),
    ];
    const suggestion = buildPetProactiveSuggestion({
      now: new Date("2026-08-15T13:00:00"),
      tasks,
      petName: "小序",
    });
    expect(suggestion.nextTask?.taskId).toBe("open");
  });

  it("allows a task once every known dependency is completed", () => {
    const tasks = [
      makeTask("done", "准备材料", { status: "completed" }),
      makeTask("dependent", "提交申请", {
        dependencyIds: ["done"],
        dueAt: "2026-08-15T16:00:00.000Z",
      }),
    ];
    const suggestion = buildPetProactiveSuggestion({
      now: new Date("2026-08-15T13:00:00"),
      tasks,
      petName: "小序",
    });
    expect(suggestion.nextTask?.taskId).toBe("dependent");
  });

  it("uses the user's transparent urgency weights when choosing the next task", () => {
    const tasks = [
      makeTask("planned", "今天计划", {
        plannedDate: "2026-08-15",
        priority: "medium",
        estimatedMinutes: 90,
      }),
      makeTask("quick", "五分钟小事", {
        priority: "low",
        estimatedMinutes: 5,
      }),
    ];
    const suggestion = buildPetProactiveSuggestion({
      now: new Date("2026-08-15T08:00:00"),
      tasks,
      petName: "小序",
      urgencyWeights: {
        deadline: 0,
        plannedToday: 0,
        priority: 0,
        quickWin: 100,
      },
    });
    expect(suggestion.nextTask?.taskId).toBe("quick");
  });

  it("removes task references from proactive copy in privacy mode", () => {
    const suggestion = buildPetProactiveSuggestion({
      now: new Date("2026-08-15T08:00:00"),
      tasks: [makeTask("private", "不应泄露的标题", { plannedDate: "2026-08-15" })],
      petName: "小序",
      privacyMode: true,
    });
    expect(suggestion.nextTask).toBeUndefined();
    expect(suggestion.message).not.toContain("不应泄露的标题");
  });
});
