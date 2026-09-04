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
  lead: PetTeamMember;
  summary: string;
}

export interface PetTeamBriefingStep {
  id: string;
  member: PetTeamMember;
  title: string;
}

export interface PetTeamRouteStop {
  task: Task;
  position: number;
  estimatedMinutes: number;
  isCurrent: boolean;
}

export interface PetTeamRoute {
  stops: PetTeamRouteStop[];
  totalEstimatedMinutes: number;
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

const briefingTitleByRole: Record<PetTeamRole, string> = {
  scout: "先找一个落点",
  sort: "收拢需要的线头",
  steady: "守住一小段节奏",
  guard: "把干扰放轻",
};

const briefingRoleOrder: PetTeamRole[] = ["scout", "sort", "steady", "guard"];

const taskDueTimestamp = (task: Task): number => {
  if (!task.dueAt) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(task.dueAt);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
};

const taskEstimatedMinutes = (task: Task): number => {
  if (!Number.isFinite(task.estimatedMinutes) || (task.estimatedMinutes ?? 0) <= 0) return 30;
  return Math.max(1, Math.round(task.estimatedMinutes ?? 30));
};

const sortPetTeamTasks = (tasks: readonly Task[]): Task[] => tasks
  .filter((task) => task.status === "open" && !task.deletedAt)
  .slice()
  .sort((left, right) =>
    taskDueTimestamp(left) - taskDueTimestamp(right) ||
    priorityWeight[left.priority] - priorityWeight[right.priority] ||
    taskEstimatedMinutes(left) - taskEstimatedMinutes(right) ||
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.id.localeCompare(right.id),
  );

/** Picks one open task without inventing a second task or urgency score. */
export function pickPetTeamTask(tasks: readonly Task[]): Task | undefined {
  return sortPetTeamTasks(tasks)[0];
}

/**
 * Projects a short, current-first route for the huddle. This is a local
 * preview only: it never schedules, completes, or batches the listed tasks.
 */
export function buildPetTeamRoute(
  tasks: readonly Task[],
  currentTaskId?: string,
  maxStops = 3,
): PetTeamRoute {
  const sorted = sortPetTeamTasks(tasks);
  const current = currentTaskId ? sorted.find((task) => task.id === currentTaskId) : undefined;
  const ordered = current
    ? [current, ...sorted.filter((task) => task.id !== current.id)]
    : sorted;
  const limit = Number.isFinite(maxStops) ? Math.min(5, Math.max(1, Math.floor(maxStops))) : 3;
  const stops = ordered.slice(0, limit).map((task, index) => ({
    task,
    position: index + 1,
    estimatedMinutes: taskEstimatedMinutes(task),
    isCurrent: task.id === current?.id || (!current && index === 0),
  }));
  return {
    stops,
    totalEstimatedMinutes: stops.reduce((total, stop) => total + stop.estimatedMinutes, 0),
  };
}

export function buildPetTeamPlan(
  task: Task | undefined,
  companions: readonly PetCompanion[],
  preferredLeadId?: string,
): PetTeamPlan | undefined {
  if (!task || task.status !== "open" || task.deletedAt || companions.length === 0) return undefined;
  const members = companions.map((companion) => ({
    companion,
    ...roleByKind[companion.kind],
  }));
  const lead =
    members.find((member) => member.companion.id === preferredLeadId) ?? members[0];
  if (!lead) return undefined;
  const names = members.map((member) => member.companion.name.trim() || "小伙伴").join("、");
  return {
    task,
    members,
    lead,
    summary: `${names}会一起陪你完成「${task.title}」，但任务状态仍只由 Todo Agent 记录。`,
  };
}

/**
 * Builds a presentation-only, deterministic briefing for the current huddle.
 * It explains how companions will accompany one task; it does not create
 * subtasks, invoke an Agent, or imply that any role has executed work.
 */
export function buildPetTeamBriefing(plan: PetTeamPlan): PetTeamBriefingStep[] {
  const remaining = plan.members
    .filter((member) => member.companion.id !== plan.lead.companion.id)
    .slice()
    .sort((left, right) =>
      briefingRoleOrder.indexOf(left.role) - briefingRoleOrder.indexOf(right.role) ||
      left.companion.id.localeCompare(right.companion.id),
    );
  return [plan.lead, ...remaining].map((member, index) => ({
    id: `${member.role}-${member.companion.id}`,
    member,
    title: briefingTitleByRole[member.role],
  })).map((step, index) => ({
    ...step,
    id: `${index + 1}-${step.id}`,
  }));
}
