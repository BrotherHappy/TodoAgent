import type { PetCompanion, PetCompanionKind } from "../shared/pet-types";
import type { Task } from "../shared/models";

export type PetTeamRole = "scout" | "steady" | "sort" | "guard";

export interface PetTeamMember {
  companion: PetCompanion;
  role: PetTeamRole;
  roleLabel: string;
  line: string;
}

export interface PetTeamPlan {
  task: Task;
  members: PetTeamMember[];
  summary: string;
}

const priorityWeight: Record<Task["priority"], number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

const roleByKind: Record<PetCompanionKind, {
  role: PetTeamRole;
  roleLabel: string;
  line: string;
}> = {
  "paper-bird": { role: "scout", roleLabel: "侦察下一步", line: "我来把第一步递到你手边。" },
  cloudlet: { role: "steady", roleLabel: "稳住节奏", line: "我会替你守住这一小段专注。" },
  "moss-mouse": { role: "sort", roleLabel: "整理上下文", line: "我来把杂乱的线头收拢起来。" },
  "moon-moth": { role: "guard", roleLabel: "安静守护", line: "我会把声音放轻，陪你完成这一段。" },
};

const taskDueTimestamp = (task: Task): number => {
  if (!task.dueAt) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(task.dueAt);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
};

/** Picks one open task without inventing a second task or urgency score. */
export function pickPetTeamTask(tasks: readonly Task[]): Task | undefined {
  return tasks
    .filter((task) => task.status === "open" && !task.deletedAt)
    .slice()
    .sort((left, right) =>
      taskDueTimestamp(left) - taskDueTimestamp(right) ||
      priorityWeight[left.priority] - priorityWeight[right.priority] ||
      (left.estimatedMinutes ?? Number.POSITIVE_INFINITY) - (right.estimatedMinutes ?? Number.POSITIVE_INFINITY) ||
      left.updatedAt.localeCompare(right.updatedAt) ||
      left.id.localeCompare(right.id),
    )[0];
}

export function buildPetTeamPlan(
  task: Task | undefined,
  companions: readonly PetCompanion[],
): PetTeamPlan | undefined {
  if (!task || task.status !== "open" || task.deletedAt || companions.length === 0) return undefined;
  const members = companions.map((companion) => ({
    companion,
    ...roleByKind[companion.kind],
  }));
  const names = members.map((member) => member.companion.name.trim() || "小伙伴").join("、");
  return {
    task,
    members,
    summary: `${names}会一起陪你完成「${task.title}」，但任务状态仍只由 Todo Agent 记录。`,
  };
}
