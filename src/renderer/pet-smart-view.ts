import type { Task } from "../shared/models";
import {
  sortSmartViewTasks,
  type SmartViewDateFilter,
  type SmartViewDefinition,
} from "./smart-views";

const localDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const temporalDateKey = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : localDateKey(instant);
};

const matchesDate = (
  task: Task,
  filter: SmartViewDateFilter,
  today: string,
): boolean => {
  if (filter === "any") return true;
  const dates = [temporalDateKey(task.dueAt), task.plannedDate].filter(
    (value): value is string => Boolean(value),
  );
  if (filter === "no-date") return dates.length === 0;
  if (filter === "overdue") return dates.some((value) => value < today);
  if (filter === "today") return dates.some((value) => value === today);
  const horizon = new Date(`${today}T00:00:00`);
  horizon.setDate(horizon.getDate() + 7);
  return dates.some((value) => value > today && value <= localDateKey(horizon));
};

const matchesSavedRoute = (task: Task, route: SmartViewDefinition["route"], today: string): boolean => {
  if (route === "all") return task.status === "open";
  if (route === "today") {
    const due = temporalDateKey(task.dueAt);
    const planned = task.plannedDate;
    const start = temporalDateKey(task.startAt);
    return (
      task.status === "open" &&
      ((due !== undefined && due <= today) ||
        (planned !== undefined && planned <= today) ||
        start === today)
    );
  }
  if (route === "upcoming") {
    const dates = [task.plannedDate, temporalDateKey(task.startAt), temporalDateKey(task.dueAt)]
      .filter((value): value is string => Boolean(value))
      .sort();
    return task.status === "open" && dates[0] !== undefined && dates[0] > today;
  }
  if (route === "deferred") {
    return (
      task.status === "open" &&
      task.deferUntil !== undefined &&
      task.deferUntil > today
    );
  }
  if (route === "inbox") {
    return (
      task.status === "open" &&
      task.projectId === undefined &&
      task.listId === undefined &&
      task.plannedDate === undefined &&
      task.deferUntil === undefined &&
      task.startAt === undefined &&
      task.dueAt === undefined
    );
  }
  // Completed and trash are deliberately not rendered by the pet's open-task
  // panel. Selecting one of those saved views therefore fails closed to empty.
  return false;
};

/**
 * Project a saved main-window view onto the same open-task snapshot used by
 * Todo Pet. This is intentionally a pure read/filter operation: it never
 * creates a second task collection and never changes task or sync fields.
 */
export const filterTasksForPetView = (
  tasks: readonly Task[],
  view: SmartViewDefinition,
  today = new Date(),
): Task[] => {
  const todayKey = localDateKey(today);
  const filtered = tasks.filter(
    (task) =>
      !task.deletedAt &&
      matchesSavedRoute(task, view.route, todayKey) &&
      (view.priority === "all" || task.priority === view.priority) &&
      (!view.flagged || task.flagged === true) &&
      (view.projectId === "all" || task.projectId === view.projectId) &&
      (view.tag === "all" || task.tags.includes(view.tag)) &&
      (view.context === "all" ||
        (task.contexts ?? []).some(
          (context) => context.toLocaleLowerCase() === view.context.toLocaleLowerCase(),
        )) &&
      (!view.sourceType || task.source.type === view.sourceType) &&
      matchesDate(task, view.dateFilter, todayKey),
  );
  return sortSmartViewTasks(filtered, view.sort);
};
