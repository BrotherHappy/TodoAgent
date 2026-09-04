import type { FocusHistoryRecord } from "../shared/pet-types";
import type { Task } from "../shared/models";

export interface EveningReviewSummary {
  localDate: string;
  completedCount: number;
  focusMinutes: number;
  remainingCount: number;
  overdueCount: number;
  carryOverCount: number;
  label: "今日进展" | "今晚回顾";
  headline: string;
  detail: string;
}
function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function datePart(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : localDateKey(parsed);
}

/**
 * A factual, low-pressure end-of-day summary. It never moves or modifies a
 * task; it only turns today's existing task and focus records into a glance.
 */
export function buildEveningReview(
  tasks: readonly Task[],
  focusHistory: readonly FocusHistoryRecord[],
  now = new Date(),
): EveningReviewSummary {
  const localDate = localDateKey(now);
  const visibleTasks = tasks.filter((task) => !task.deletedAt);
  const completed = visibleTasks.filter(
    (task) =>
      task.status === "completed" &&
      (datePart(task.completedAt) === localDate ||
        datePart(task.plannedDate) === localDate ||
        datePart(task.dueAt) === localDate),
  );
  const open = visibleTasks.filter((task) => task.status === "open");
  const carryOver = open.filter((task) => {
    const planned = datePart(task.plannedDate);
    const due = datePart(task.dueAt);
    return (planned !== undefined && planned < localDate) || (due !== undefined && due < localDate);
  });
  const focusMinutes = Math.round(
    focusHistory
      .filter((entry) => datePart(entry.completedAt) === localDate)
      .reduce((total, entry) => total + Math.max(0, entry.actualSeconds), 0) / 60,
  );
  const overdueCount = carryOver.length;
  const label = now.getHours() >= 18 ? "今晚回顾" : "今日进展";
  const headline =
    completed.length > 0
      ? `今天完成了 ${completed.length} 件事${focusMinutes ? `，还守住了 ${focusMinutes} 分钟专注` : ""}。`
      : focusMinutes > 0
        ? `今天守住了 ${focusMinutes} 分钟专注，进展不只由勾选决定。`
        : "今天还没有记录完成，也没关系，先照顾好自己的节奏。";
  const detail =
    open.length === 0
      ? "任务已经清空，可以放心收尾或去休息。"
      : carryOver.length > 0
        ? `还有 ${open.length} 件未完成，其中 ${carryOver.length} 件可以明天再安排，不需要今晚硬撑。`
        : `还有 ${open.length} 件未完成，挑一件最轻的继续，或者把它们留到明天。`;
  return {
    localDate,
    completedCount: completed.length,
    focusMinutes,
    remainingCount: open.length,
    overdueCount,
    carryOverCount: carryOver.length,
    label,
    headline,
    detail,
  };
}
