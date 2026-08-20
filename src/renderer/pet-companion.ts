import type { Task } from "../shared/models";
import { defaultSettings, type AppSettings, type TaskUrgencyWeights } from "../shared/settings";
import type { ProactiveMessageRecord, WeatherSnapshot } from "../shared/pet-types";

export interface PetCompanionContext {
  settings: AppSettings;
  now: Date;
  focusActive: boolean;
  fullscreen?: boolean;
}

export interface PetProactiveSuggestion {
  kind: "companion" | "planning" | "deadline" | "wellbeing" | "weather" | "sync" | "morning" | "evening";
  action: "wave" | "alert" | "drink" | "think" | "celebrate";
  message: string;
  /** A real task the user can open or start immediately from the bubble. */
  nextTask?: PetNextTask;
}

export interface PetNextTask {
  taskId: string;
  taskTitle: string;
  reason: string;
}

function minutesOfDay(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

function withinQuietHours(settings: AppSettings, now: Date): boolean {
  if (!settings.notifications.quietHoursEnabled) return false;
  const start = minutesOfDay(settings.notifications.quietHoursStart);
  const end = minutesOfDay(settings.notifications.quietHoursEnd);
  if (start === undefined || end === undefined || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function shouldSuppressPetProactive(
  context: PetCompanionContext,
): boolean {
  const { settings, now } = context;
  if (!settings.pet.proactiveMessages) return true;
  if (settings.pet.meetingMode || context.focusActive) return true;
  if (context.fullscreen && settings.floating.hideInFullscreen) return true;
  if (withinQuietHours(settings, now)) return true;
  const mutedUntil = settings.notifications.mutedUntil;
  return Boolean(mutedUntil && new Date(mutedUntil).getTime() > now.getTime());
}

const nextTaskPriority: Record<Task["priority"], number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

const defaultUrgencyWeights: TaskUrgencyWeights = defaultSettings.planning.urgencyWeights;

function taskDatePart(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : value.slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.round((toMs - fromMs) / (24 * 60 * 60_000));
}

function boundedWeight(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : fallback;
}

interface NextTaskSignals {
  deadline: number;
  plannedToday: number;
  priority: number;
  quickWin: number;
}

function nextTaskSignals(task: Task, date: string): NextTaskSignals {
  const due = taskDatePart(task.dueAt);
  let deadlineScore = 0;
  if (due !== undefined) {
    const days = daysBetween(date, due);
    if (days < 0) {
      deadlineScore = 100 + Math.min(50, Math.abs(days) * 10);
    } else if (days === 0) {
      deadlineScore = 100;
    } else if (days <= 7) {
      deadlineScore = Math.max(20, 100 - days * 12);
    }
  }
  const plannedScore = task.plannedDate === date
    ? 100
    : task.plannedDate !== undefined && task.plannedDate < date
      ? 60
      : 0;
  const priorityScore = (nextTaskPriority[task.priority] >= 4
    ? 0
    : ((4 - nextTaskPriority[task.priority]) / 4) * 100);
  const estimate = Number(task.estimatedMinutes);
  const quickWinScore = Number.isFinite(estimate) && estimate > 0
    ? Math.max(0, 100 - Math.min(100, estimate))
    : 0;
  return {
    deadline: deadlineScore,
    plannedToday: plannedScore,
    priority: priorityScore,
    quickWin: quickWinScore,
  };
}

function nextTaskScore(task: Task, date: string, weights: TaskUrgencyWeights): number {
  const signals = nextTaskSignals(task, date);
  return (
    signals.deadline * boundedWeight(weights.deadline, defaultUrgencyWeights.deadline) / 100
    + signals.plannedToday * boundedWeight(weights.plannedToday, defaultUrgencyWeights.plannedToday) / 100
    + signals.priority * boundedWeight(weights.priority, defaultUrgencyWeights.priority) / 100
    + signals.quickWin * boundedWeight(weights.quickWin, defaultUrgencyWeights.quickWin) / 100
  );
}

function taskReason(
  task: Task,
  date: string,
  weights: TaskUrgencyWeights,
): string {
  const signals = nextTaskSignals(task, date);
  const contributions: Array<[number, string]> = [
    [
      signals.deadline * boundedWeight(weights.deadline, defaultUrgencyWeights.deadline),
      taskDatePart(task.dueAt) !== undefined && taskDatePart(task.dueAt)! < date
        ? "已经逾期，先把它往前推进一点"
        : taskDatePart(task.dueAt) === date
          ? "今天截止，适合先处理"
          : "截止日期临近",
    ],
    [signals.plannedToday * boundedWeight(weights.plannedToday, defaultUrgencyWeights.plannedToday), "已经安排在今天"],
    [signals.priority * boundedWeight(weights.priority, defaultUrgencyWeights.priority), "优先级较高"],
    [signals.quickWin * boundedWeight(weights.quickWin, defaultUrgencyWeights.quickWin), "这是当前最容易开始的一项"],
  ];
  const primary = contributions
    .filter(([score]) => score > 0)
    .sort((left, right) => right[0] - left[0])[0];
  return primary?.[1] ?? "这是当前最容易开始的一项";
}

/**
 * Selects one deterministic, actionable task for the pet's “what next?” card.
 * It never changes task state and deliberately skips unresolved dependencies.
 */
export function recommendNextTask(
  tasks: readonly Task[],
  date: string,
  weights: TaskUrgencyWeights = defaultUrgencyWeights,
): PetNextTask | undefined {
  const visible = tasks.filter(
    (task) => task.status === "open" && !task.deletedAt,
  );
  const byId = new Map(
    tasks
      .filter((task) => !task.deletedAt)
      .map((task) => [task.id, task]),
  );
  const actionable = visible.filter((task) =>
    task.dependencyIds.every((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return dependency !== undefined && dependency.status === "completed";
    }),
  );
  // A task without dependencies is actionable; the every() check above would
  // otherwise return false for it only if the source contains invalid data.
  const candidates = actionable.length
    ? actionable
    : visible.filter((task) => task.dependencyIds.length === 0);
  const sorted = [...candidates].sort((left, right) => {
    const leftDue = taskDatePart(left.dueAt) ?? "9999-12-31";
    const rightDue = taskDatePart(right.dueAt) ?? "9999-12-31";
    return (
      nextTaskScore(right, date, weights) - nextTaskScore(left, date, weights) ||
      nextTaskPriority[left.priority] - nextTaskPriority[right.priority] ||
      leftDue.localeCompare(rightDue) ||
      left.privateOrder - right.privateOrder ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
    );
  });
  const task = sorted[0];
  return task
    ? { taskId: task.id, taskTitle: task.title, reason: taskReason(task, date, weights) }
    : undefined;
}

export function buildPetProactiveSuggestion(input: {
  now: Date;
  tasks: readonly Task[];
  weather?: WeatherSnapshot;
  petName: string;
  syncProblem?: boolean;
  privacyMode?: boolean;
  urgencyWeights?: TaskUrgencyWeights;
}): PetProactiveSuggestion {
  const open = input.tasks.filter(
    (task) => task.status === "open" && !task.deletedAt,
  );
  const date = localDate(input.now);
  const overdue = open.filter(
    (task) => task.dueAt && task.dueAt.slice(0, 10) < date,
  );
  const dueToday = open.filter(
    (task) =>
      task.plannedDate === date || task.dueAt?.slice(0, 10) === date,
  );
  const nextTask = input.privacyMode
    ? undefined
    : recommendNextTask(input.tasks, date, input.urgencyWeights);
  const hour = input.now.getHours();
  if (input.syncProblem) {
    return {
      kind: "sync",
      action: "alert",
      message: "飞书同步遇到一点问题。本地任务还在，我可以陪你稍后重试。",
    };
  }
  if (input.weather?.severe) {
    return {
      kind: "weather",
      action: "alert",
      message: `${input.weather.city}今天${input.weather.conditionLabel}，出门前记得留意天气。`,
    };
  }
  if (hour >= 6 && hour < 11) {
    return {
      kind: "morning",
      action: "wave",
      message: nextTask
        ? `早呀！先从「${nextTask.taskTitle}」开始？${nextTask.reason}。`
        : dueToday.length
          ? `早呀！今天有 ${dueToday.length} 件事，先挑一件最值得完成的？`
        : "早呀！今天的任务还很轻，给自己留一点舒服的开始吧。",
      nextTask,
    };
  }
  if (hour >= 18) {
    return {
      kind: "evening",
      action: open.length ? "think" : "celebrate",
      message: open.length
        ? `今天辛苦了。还有 ${open.length} 件未完成，要不要一起挪走不着急的？`
        : "今天的清单已经收好啦。现在可以安心休息。",
    };
  }
  if (overdue.length) {
    return {
      kind: "deadline",
      action: "alert",
      message: nextTask
        ? `有 ${overdue.length} 件事过了计划时间。先处理「${nextTask.taskTitle}」？${nextTask.reason}。`
        : `有 ${overdue.length} 件事过了计划时间。要不要只重新安排，不责怪自己？`,
      nextTask,
    };
  }
  if (open.length >= 7) {
    return {
      kind: "planning",
      action: "think",
      message: nextTask
        ? `清单里有 ${open.length} 件事。先从「${nextTask.taskTitle}」开始，再把今天缩成三件。`
        : `清单里有 ${open.length} 件事。我们可以把今天缩成三件最重要的。`,
      nextTask,
    };
  }
  return {
    kind: "wellbeing",
    action: "drink",
    message: nextTask
      ? `${input.petName}来提醒你：喝口水，转转肩膀；准备好后可以从「${nextTask.taskTitle}」开始。`
      : `${input.petName}来提醒你：喝口水，转转肩膀，再继续也不迟。`,
    nextTask,
  };
}

export function localDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Counts companion messages shown on the device's local calendar day. */
export function proactiveMessagesForDate(
  messages: readonly Pick<ProactiveMessageRecord, "shownAt">[],
  now = new Date(),
): number {
  const date = localDate(now);
  return messages.filter((message) => message.shownAt.slice(0, 10) === date).length;
}

/** Renderer-side advisory check; the main process remains authoritative. */
export function proactiveBudgetAvailable(
  messages: readonly Pick<ProactiveMessageRecord, "shownAt">[],
  dailyLimit: number,
  now = new Date(),
): boolean {
  if (!Number.isFinite(dailyLimit) || dailyLimit <= 0) return true;
  return proactiveMessagesForDate(messages, now) < Math.floor(dailyLimit);
}
