import { describe, expect, it } from "vitest";

import { projectPetGoal, weekRangeFor } from "../src/renderer/pet-goals";
import type { PetGoal, PetHabit } from "../src/shared/pet-types";
import type { Task } from "../src/shared/models";

const task = (id: string, completedAt: string, status: Task["status"] = "completed"): Task => ({
  id,
  source: { type: "local" },
  title: id,
  notes: "",
  privateNotes: "",
  status,
  priority: "medium",
  tags: [],
  dependencyIds: [],
  assigneeIds: [],
  followerIds: [],
  attachments: [],
  links: [],
  customFields: {},
  reminders: [],
  completedAt,
  focusElapsedSeconds: 0,
  privateOrder: 0,
  sync: { status: "local" },
  createdAt: completedAt,
  updatedAt: completedAt,
});

const goal = (metric: PetGoal["metric"]): PetGoal => ({
  id: metric,
  title: "本周目标",
  metric,
  target: metric === "focus-minutes" ? 60 : 2,
  periodStart: "2026-08-17",
  periodEnd: "2026-08-23",
  enabled: true,
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
});

describe("pet goals", () => {
  it("builds a Monday-first current-week range", () => {
    expect(weekRangeFor(new Date(2026, 7, 19))).toEqual({
      periodStart: "2026-08-17",
      periodEnd: "2026-08-23",
    });
  });

  it("projects task, focus and habit facts without storing a second counter", () => {
    const habits: PetHabit[] = [
      { id: "water", label: "喝水", hint: "", cadenceMinutes: 90, enabled: true, lastCompletedAt: "2026-08-18T09:00:00.000Z" },
      { id: "stretch", label: "伸展", hint: "", cadenceMinutes: 120, enabled: true, lastCompletedAt: "2026-08-25T09:00:00.000Z" },
    ];
    expect(projectPetGoal(goal("tasks-completed"), {
      tasks: [task("inside", "2026-08-18T09:00:00.000Z"), task("outside", "2026-08-25T09:00:00.000Z")],
      focusHistory: [],
      habits,
    }).value).toBe(1);
    expect(projectPetGoal(goal("focus-minutes"), {
      tasks: [],
      focusHistory: [
        { id: "focus-1", sessionId: "s1", phase: "focus", cycle: 1, actualSeconds: 1_800, outcome: "completed", completedAt: "2026-08-18T10:00:00.000Z" },
        { id: "focus-2", sessionId: "s2", phase: "focus", cycle: 1, actualSeconds: 900, outcome: "abandoned", completedAt: "2026-08-18T11:00:00.000Z" },
      ],
      habits,
    }).value).toBe(30);
    const habitProgress = projectPetGoal(goal("habit-checkins"), { tasks: [], focusHistory: [], habits });
    expect(habitProgress.value).toBe(1);
    expect(habitProgress.remaining).toBe(1);
    expect(habitProgress.isComplete).toBe(false);
  });

  it("caps the progress bar while preserving the true value", () => {
    const progress = projectPetGoal(
      { ...goal("tasks-completed"), target: 1 },
      { tasks: [task("one", "2026-08-18T09:00:00.000Z"), task("two", "2026-08-19T09:00:00.000Z")], focusHistory: [], habits: [] },
    );
    expect(progress.value).toBe(2);
    expect(progress.ratio).toBe(1);
    expect(progress.remaining).toBe(0);
    expect(progress.isComplete).toBe(true);
  });
});

