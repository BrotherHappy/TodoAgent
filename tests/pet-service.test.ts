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
  it("stores configurable elastic habits without creating rewards or tasks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-habits-"));
    let now = Date.parse("2026-08-20T08:00:00.000Z");
    const service = new PetService({ userDataPath: root, now: () => now });
    await service.initialize();
    expect(service.snapshot().habits.map((habit) => habit.id)).toEqual([
      "water",
      "stretch",
      "close-loop",
    ]);
    await service.updateHabit("water", { cadenceMinutes: 120, enabled: false });
    await service.completeHabit("stretch");
    now += 31 * 60_000;
    await service.snoozeHabit("close-loop", 30);
    const custom = await service.addHabit({
      label: "看远处",
      hint: "让眼睛离开屏幕一会儿",
      cadenceMinutes: 60,
    });
    expect(custom.habits.find((habit) => habit.id === "water")?.enabled).toBe(false);
    expect(custom.habits.find((habit) => habit.id === "stretch")?.lastCompletedAt).toBeDefined();
    expect(custom.habits.find((habit) => habit.label === "看远处")?.cadenceMinutes).toBe(60);
    expect(custom.rewards).toHaveLength(0);
    expect(await service.deleteHabit("water")).toBe(true);
    expect(service.snapshot().habits.some((habit) => habit.id === "water")).toBe(false);
    const restored = new PetService({ userDataPath: root, now: () => now });
    await restored.initialize();
    expect(restored.snapshot().habits.some((habit) => habit.label === "看远处")).toBe(true);
    expect(restored.snapshot().habits.some((habit) => habit.id === "water")).toBe(false);
  });

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

  it("rewards each kind of direct interaction once per day without creating a click grind", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-interaction-"));
    const now = Date.parse("2026-08-15T06:00:00.000Z");
    const service = new PetService({ userDataPath: root, now: () => now });
    await service.initialize();

    await service.recordInteraction("pet");
    await service.recordInteraction("pet");
    expect(service.snapshot().profile.intimacy).toBe(1);
    expect(service.snapshot().rewards).toHaveLength(1);

    await service.recordInteraction("play");
    await service.recordInteraction("rest");
    expect(service.snapshot().profile.intimacy).toBe(3);
    expect(
      service.snapshot().rewards.map((reward) => reward.sourceId).sort(),
    ).toEqual(["pet", "play", "rest"]);
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
    expect(diary.taskIds).toEqual(["write"]);
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

  it("turns an individual task into an idempotent diary entry without copying its private notes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-task-diary-"));
    const service = new PetService({ userDataPath: root, initialName: "团团" });
    await service.initialize();
    const task = completedTask("task-diary");
    task.privateNotes = "不要写出";

    const first = await service.createDiaryFromTask({
      localDate: "2026-08-15",
      task: { id: task.id, title: task.title, status: task.status },
    });
    expect(first.generation).toBe("user");
    expect(first.taskIds).toEqual([task.id]);
    expect(first.content).toContain(`完成了“${task.title}”`);
    expect(first.content).not.toContain(task.privateNotes);

    const second = await service.createDiaryFromTask({
      localDate: "2026-08-15",
      task: { id: task.id, title: task.title, status: task.status },
    });
    expect(second.id).toBe(first.id);
    expect(service.snapshot().diary).toHaveLength(1);
  });

  it("stores quick-capture notes as local diary entries and deduplicates retries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-capture-diary-"));
    const service = new PetService({ userDataPath: root });
    await service.initialize();

    const first = await service.createDiaryFromCapture({
      localDate: "2026-08-15",
      title: "灵感：给宠物加一个小窝",
      content: "把想法先记下来，晚点再拆成任务。",
      captureId: "capture-1",
    });
    const second = await service.createDiaryFromCapture({
      localDate: "2026-08-15",
      title: "灵感：给宠物加一个小窝（重试）",
      content: "把想法先记下来，晚点再拆成任务。",
      captureId: "capture-1",
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toContain("重试");
    expect(second.taskIds).toBeUndefined();
    expect(second.generation).toBe("user");
    expect(service.snapshot().diary).toHaveLength(1);
  });

  it("keeps diary task links local, unique and current when facts are regenerated", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-journal-links-"));
    const service = new PetService({ userDataPath: root });
    await service.initialize();
    const first = await service.generateDiary({
      localDate: "2026-08-16",
      completedTasks: [completedTask("a"), completedTask("a"), completedTask("b")],
    });
    expect(first.taskIds).toEqual(["a", "b"]);
    const next = await service.generateDiary({
      localDate: "2026-08-16",
      completedTasks: [completedTask("b"), completedTask("c")],
    });
    expect(next.id).toBe(first.id);
    expect(next.taskIds).toEqual(["b", "c"]);
    expect(service.snapshot().diary).toHaveLength(1);
  });

  it("persists appearance changes with safe bounded decorations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-room-"));
    const service = new PetService({ userDataPath: root });
    await service.initialize();
    await service.customize({
      palette: "mint",
      outfit: "explorer",
      roomTheme: "forest-nook",
      decorations: ["plant", "plant", "books"],
    });
    expect(service.snapshot().appearance).toEqual({
      palette: "mint",
      outfit: "explorer",
      roomTheme: "forest-nook",
      decorations: ["plant", "books"],
    });
    const restored = new PetService({ userDataPath: root });
    await restored.initialize();
    expect(restored.snapshot().appearance.outfit).toBe("explorer");
  });

  it("creates one pressure-free daily adventure and rewards its choice exactly once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-adventure-"));
    const service = new PetService({ userDataPath: root, initialName: "团团" });
    await service.initialize();
    const first = await service.dailyAdventure("2026-08-15");
    const same = await service.dailyAdventure("2026-08-15");
    expect(same.id).toBe(first.id);
    await service.completeAdventure(first.id, "organize");
    await service.completeAdventure(first.id, "organize");
    const snapshot = service.snapshot();
    expect(snapshot.adventures).toHaveLength(1);
    expect(snapshot.adventures[0]?.outcome).toContain("团团");
    expect(snapshot.rewards.filter((reward) => reward.source === "adventure")).toHaveLength(1);
    expect(snapshot.inventory.find((item) => item.id === "adventure-star")?.quantity).toBe(1);
    expect(snapshot.inventory.some((item) => item.id === "outfit-explorer")).toBe(true);
    expect(snapshot.inventory.some((item) => item.id === "decoration-books")).toBe(true);
  });

  it("records every mini-game session but only grants one gentle daily reward per game", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-game-"));
    const now = Date.parse("2026-08-15T08:00:00.000Z");
    const service = new PetService({ userDataPath: root, now: () => now });
    await service.initialize();
    await service.recordMiniGame({ game: "star-catch", score: 9, durationSeconds: 20 });
    await service.recordMiniGame({ game: "star-catch", score: 14, durationSeconds: 20 });
    await service.recordMiniGame({ game: "jump-rope", score: 11, durationSeconds: 20 });
    await service.recordMiniGame({ game: "stretch-mirror", score: 4, durationSeconds: 24 });
    expect(service.snapshot().miniGames).toHaveLength(4);
    expect(service.snapshot().rewards.filter((reward) => reward.source === "game")).toHaveLength(3);
    expect(service.snapshot().inventory.some((item) => item.id === "outfit-starlight")).toBe(true);
    expect(service.snapshot().inventory.some((item) => item.id === "action-dance")).toBe(true);
  });

  it("enforces the proactive companion daily budget in the main-process service", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-proactive-budget-"));
    let now = Date.parse("2026-08-15T08:00:00.000Z");
    const service = new PetService({ userDataPath: root, now: () => now });
    await service.initialize();
    const input = { kind: "wellbeing" as const, reason: "喝口水", dismissed: false };
    await service.recordProactiveMessage(input, { dailyLimit: 2, localDate: "2026-08-15" });
    await service.recordProactiveMessage(input, { dailyLimit: 2, localDate: "2026-08-15" });
    await service.recordProactiveMessage(input, { dailyLimit: 2, localDate: "2026-08-15" });
    expect(service.snapshot().proactiveMessages).toHaveLength(2);
    now += 24 * 60 * 60_000;
    await service.recordProactiveMessage(input, { dailyLimit: 2, localDate: "2026-08-16" });
    expect(service.snapshot().proactiveMessages).toHaveLength(3);
  });
});
