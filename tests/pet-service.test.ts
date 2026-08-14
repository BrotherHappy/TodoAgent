// @vitest-environment node

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PetService } from "../electron/services/pet-service";
import type { Task } from "../src/shared/models";
import type { PetEvent } from "../src/shared/pet-types";

function completedTask(id: string, priority: Task["priority"] = "medium"): Task {
  return {
    id,
    source: { type: "local" },
    title: `完成 ${id}`,
    notes: "",
    privateNotes: "",
    status: "completed",
    priority,
    tags: [],
    dependencyIds: [],
    assigneeIds: [],
    followerIds: [],
    attachments: [],
    links: [],
    customFields: {},
    reminders: [],
    completedAt: "2026-08-15T01:00:00.000Z",
    focusElapsedSeconds: 0,
    privateOrder: 0,
    sync: { status: "local" },
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T01:00:00.000Z",
  };
}

describe("PetService", () => {
  it("persists an absolute-time focus session and restores it after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-focus-"));
    let now = Date.parse("2026-08-15T01:00:00.000Z");
    const first = new PetService({ userDataPath: root, now: () => now });
    await first.initialize();
    await first.startFocus({
      mode: "pomodoro",
      taskId: "task-1",
      taskTitle: "写测试",
      preset: {
        focusMinutes: 25,
        shortBreakMinutes: 5,
        longBreakMinutes: 15,
        cycles: 4,
      },
    });
    now += 71_000;
    expect(first.snapshot().focus?.elapsedSeconds).toBe(71);
    expect(first.snapshot().focus?.remainingSeconds).toBe(1_429);

    const restored = new PetService({ userDataPath: root, now: () => now });
    await restored.initialize();
    expect(restored.snapshot().focus?.taskTitle).toBe("写测试");
    expect(restored.snapshot().focus?.elapsedSeconds).toBe(71);
  });

  it("finishes a timed phase exactly once, grants an idempotent reward and advances to break", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-tick-"));
    let now = Date.parse("2026-08-15T02:00:00.000Z");
    const events: PetEvent[] = [];
    const service = new PetService({
      userDataPath: root,
      now: () => now,
      onEvent: (event) => events.push(event),
    });
    await service.initialize();
    await service.startFocus({
      mode: "pomodoro",
      preset: {
        focusMinutes: 1,
        shortBreakMinutes: 1,
        longBreakMinutes: 1,
        cycles: 2,
      },
    });
    now += 60_000;
    await service.tick();
    const completed = service.snapshot();
    expect(completed.focus?.status).toBe("awaiting-completion");
    expect(completed.focusHistory).toHaveLength(1);
    expect(completed.rewards.filter((reward) => reward.source === "focus")).toHaveLength(1);
    await service.tick();
    expect(service.snapshot().focusHistory).toHaveLength(1);
    expect(service.snapshot().rewards.filter((reward) => reward.source === "focus")).toHaveLength(1);

    await service.advanceFocus();
    expect(service.snapshot().focus).toMatchObject({
      phase: "short-break",
      status: "running",
      cycle: 1,
    });
    expect(events.some((event) => event.type === "focus-phase-completed")).toBe(true);
    expect(events.some((event) => event.type === "reward-granted")).toBe(true);
  });

  it("reconciles completed-task rewards idempotently and keeps growth positive-only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-reward-"));
    const service = new PetService({ userDataPath: root });
    await service.initialize();
    const tasks = [completedTask("a", "urgent"), completedTask("b", "low")];
    await service.reconcileCompletedTasks(tasks);
    const first = service.snapshot();
    expect(first.rewards).toHaveLength(2);
    expect(first.profile.experience).toBe(28);
    expect(first.profile.attributes.organization).toBe(3);
    await service.reconcileCompletedTasks(tasks);
    expect(service.snapshot().profile.experience).toBe(28);
    expect(service.snapshot().rewards).toHaveLength(2);
  });

  it("creates editable diaries and only stores memories after an explicit call", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-journal-"));
    const service = new PetService({ userDataPath: root, initialName: "团团" });
    await service.initialize();
    expect(service.snapshot().memories).toHaveLength(0);
    const diary = await service.generateDiary({
      localDate: "2026-08-15",
      completedTasks: [completedTask("write")],
      weatherSummary: "上海 晴 29℃",
    });
    expect(diary.content).toContain("完成了 1 件事");
    const edited = await service.updateDiary(diary.id, {
      title: "我的一天",
      content: "这是我确认后的内容。",
    });
    expect(edited.userEdited).toBe(true);
    const memory = await service.addMemory({
      kind: "preference",
      content: "我喜欢上午做深度工作",
    });
    expect(memory.approvedByUser).toBe(true);
    await service.updateMemory(memory.id, { enabled: false });
    expect(service.snapshot().memories[0]?.enabled).toBe(false);
    expect(await service.deleteDiary(diary.id)).toBe(true);
    expect(await service.deleteMemory(memory.id)).toBe(true);
  });
});
