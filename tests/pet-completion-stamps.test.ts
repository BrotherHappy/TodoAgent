import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import type { PetReward } from "../src/shared/pet-types";
import { projectPetCompletionStamps } from "../src/renderer/pet-completion-stamps";

const task = (patch: Partial<Task>): Task => ({
  id: patch.id ?? "task-1",
  source: { type: "local" },
  title: patch.title ?? "整理下一步",
  notes: "",
  privateNotes: "",
  status: patch.status ?? "open",
  priority: patch.priority ?? "medium",
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

const reward = (sourceId: string): PetReward => ({
  id: `reward-${sourceId}`,
  idempotencyKey: `task:${sourceId}:completed`,
  source: "task",
  sourceId,
  experience: 5,
  intimacy: 1,
  grantedAt: "2026-08-21T01:00:00.000Z",
});

describe("projectPetCompletionStamps", () => {
  it("projects today's completed tasks first and marks reconciled rewards", () => {
    const now = new Date(2026, 7, 21, 12, 0);
    const today = new Date(2026, 7, 21, 10, 30).toISOString();
    const yesterday = new Date(2026, 7, 20, 18, 0).toISOString();
    const result = projectPetCompletionStamps(
      [
        task({ id: "old", title: "旧任务", status: "completed", completedAt: yesterday }),
        task({ id: "today", title: "今天完成", status: "completed", completedAt: today }),
        task({ id: "open", title: "未完成" }),
      ],
      [reward("today")],
      now,
    );

    expect(result.todayCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.stamps.map((stamp) => stamp.taskId)).toEqual(["today", "old"]);
    expect(result.stamps[0]).toMatchObject({
      label: "今日盖章",
      icon: "✦",
      rewardRecorded: true,
      isToday: true,
    });
    expect(result.stamps[1]).toMatchObject({
      label: "完成印记",
      icon: "✓",
      rewardRecorded: false,
      isToday: false,
    });
  });

  it("ignores deleted, invalid and duplicate snapshots, and honors the cap", () => {
    const result = projectPetCompletionStamps(
      [
        task({ id: "a", status: "completed", completedAt: "2026-08-21T10:00:00.000Z" }),
        task({ id: "a", title: "重复快照", status: "completed", completedAt: "2026-08-21T10:01:00.000Z" }),
        task({ id: "deleted", status: "completed", completedAt: "2026-08-21T09:00:00.000Z", deletedAt: "2026-08-21T09:30:00.000Z" }),
        task({ id: "invalid", status: "completed", completedAt: "not-a-date" }),
        task({ id: "b", status: "completed", completedAt: "2026-08-21T08:00:00.000Z" }),
      ],
      [],
      new Date("2026-08-21T12:00:00.000Z"),
      1,
    );

    expect(result.totalCount).toBe(2);
    expect(result.stamps).toHaveLength(1);
    expect(result.stamps[0]?.taskId).toBe("a");
  });
});

