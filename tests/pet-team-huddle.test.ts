import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import type { PetCompanion } from "../src/shared/pet-types";
import { buildPetTeamPlan, pickPetTeamTask } from "../src/renderer/pet-team-huddle";

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

const companions: PetCompanion[] = [
  { id: "bird", kind: "paper-bird", name: "小纸", personality: "energetic", unlockedAt: "2026-08-21T08:00:00.000Z" },
  { id: "moth", kind: "moon-moth", name: "月蛾", personality: "quiet", unlockedAt: "2026-08-21T08:00:00.000Z" },
];

describe("pet team huddle", () => {
  it("chooses an open task by deadline, then priority and duration", () => {
    const chosen = pickPetTeamTask([
      task("later", { dueAt: "2026-08-25T10:00:00.000Z", priority: "urgent" }),
      task("soon", { dueAt: "2026-08-22T10:00:00.000Z", priority: "low" }),
      task("done", { status: "completed", dueAt: "2026-08-21T10:00:00.000Z" }),
    ]);
    expect(chosen?.id).toBe("soon");
  });

  it("assigns presentation-only roles while retaining one task fact", () => {
    const plan = buildPetTeamPlan(task("整理研究资料"), companions);
    expect(plan).toMatchObject({ task: { id: "整理研究资料" }, members: [{ role: "scout" }, { role: "guard" }] });
    expect(plan?.summary).toContain("任务状态仍只由 Todo Agent 记录");
  });

  it("does not create a plan for completed or companion-less tasks", () => {
    expect(buildPetTeamPlan(task("已完成", { status: "completed" }), companions)).toBeUndefined();
    expect(buildPetTeamPlan(task("没有伙伴"), [])).toBeUndefined();
  });
});
