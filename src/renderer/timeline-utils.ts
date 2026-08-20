import type { Task } from "../shared/models";

/** The compact desktop timeline deliberately uses a half-hour rhythm. */
export const TIMELINE_START_HOUR = 8;
export const TIMELINE_END_HOUR = 22;
export const TIMELINE_SLOT_MINUTES = 30;

export interface TimelinePlacement {
  task: Task;
  startAt: string;
  endAt: string;
  startMinute: number;
  durationMinutes: number;
  slotMinute: number;
  source: "time-block" | "start-time";
}

export interface TimelineSlot {
  minute: number;
  label: string;
  startAt: string;
}

export interface WeeklyReviewSummary {
  weekStart: string;
  weekEnd: string;
  scheduledCount: number;
  completedCount: number;
  overdueCount: number;
  unscheduledCount: number;
  focusMinutes: number;
  nextWeekCandidates: Task[];
}

export const localDateKey = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const addLocalDays = (value: string, amount: number): string => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  date.setDate(date.getDate() + amount);
  return localDateKey(date);
};

/** Monday-first calendar keys used by the compact week overview. */
export const weekDateKeys = (anchor: string): string[] => {
  const [year, month, day] = anchor.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  const mondayOffset = (date.getDay() + 6) % 7;
  const start = addLocalDays(anchor, -mondayOffset);
  return Array.from({ length: 7 }, (_, index) => addLocalDays(start, index));
};

const temporalDateKey = (value?: string): string | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : localDateKey(date);
};

const taskDateKey = (task: Task): string | undefined => {
  if (task.status === "completed" && task.completedAt) {
    const completed = temporalDateKey(task.completedAt);
    if (completed) return completed;
  }
  if (task.timeBlock?.startAt) {
    const blockStart = temporalDateKey(task.timeBlock.startAt);
    if (blockStart) return blockStart;
  }
  if (task.startAt) {
    const start = temporalDateKey(task.startAt);
    if (start) return start;
  }
  if (task.plannedDate) return task.plannedDate;
  if (task.dueAt) {
    const due = temporalDateKey(task.dueAt);
    if (due) return due;
  }
  return undefined;
};

export const tasksForWeekDay = (
  tasks: readonly Task[],
  dateKey: string,
): Task[] =>
  tasks
    .filter((task) => !task.deletedAt && taskDateKey(task) === dateKey)
    .sort((left, right) => {
      const leftTime = left.timeBlock?.startAt ?? left.startAt ?? left.dueAt ?? "";
      const rightTime = right.timeBlock?.startAt ?? right.startAt ?? right.dueAt ?? "";
      return (
        leftTime.localeCompare(rightTime) ||
        left.privateOrder - right.privateOrder ||
        left.title.localeCompare(right.title, "zh-CN")
      );
    });

export const weeklyReviewSummary = (
  tasks: readonly Task[],
  anchor: string,
  today = localDateKey(),
): WeeklyReviewSummary => {
  const dates = weekDateKeys(anchor);
  const weekStart = dates[0] ?? anchor;
  const weekEnd = dates[dates.length - 1] ?? anchor;
  const inWeek = (value?: string): boolean => Boolean(value && value >= weekStart && value <= weekEnd);
  const open = tasks.filter((task) => task.status === "open" && !task.deletedAt);
  const completed = tasks.filter(
    (task) => task.status === "completed" && !task.deletedAt && inWeek(temporalDateKey(task.completedAt)),
  );
  const scheduled = open.filter((task) => {
    const date = task.timeBlock?.startAt ?? task.startAt;
    return Boolean(date && inWeek(temporalDateKey(date)));
  });
  const datedOpen = open.filter((task) => {
    const date = taskDateKey(task);
    return Boolean(date && inWeek(date));
  });
  const unscheduledCount = Math.max(0, datedOpen.length - scheduled.length);
  const overdueCount = open.filter((task) => {
    const due = temporalDateKey(task.dueAt);
    return Boolean(due && due < today);
  }).length;
  const focusMinutes = tasks.reduce((total, task) => {
    if (task.status !== "completed" || !inWeek(temporalDateKey(task.completedAt))) return total;
    return total + (task.actualMinutes ?? Math.round((task.focusElapsedSeconds ?? 0) / 60));
  }, 0);
  const nextWeekCandidates = open
    .filter((task) => taskDateKey(task) === undefined || (taskDateKey(task) ?? "") > weekEnd)
    .sort((left, right) => {
      const rank = (value: Task["priority"]): number => ({ urgent: 0, high: 1, medium: 2, low: 3, none: 4 })[value];
      return rank(left.priority) - rank(right.priority) || left.privateOrder - right.privateOrder;
    })
    .slice(0, 3);
  return {
    weekStart,
    weekEnd,
    scheduledCount: scheduled.length,
    completedCount: completed.length,
    overdueCount,
    unscheduledCount,
    focusMinutes,
    nextWeekCandidates,
  };
};

export const formatTimelineDate = (value: string): string => {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(year, month - 1, day, 12, 0, 0, 0));
};

export const formatClock = (minute: number): string => {
  const hour = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

export const localIsoAt = (dateKey: string, minute: number): string => {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  date.setMinutes(minute);
  return date.toISOString();
};

export const timelineSlots = (dateKey: string): TimelineSlot[] => {
  const start = TIMELINE_START_HOUR * 60;
  const end = TIMELINE_END_HOUR * 60;
  return Array.from(
    { length: (end - start) / TIMELINE_SLOT_MINUTES },
    (_, index) => {
      const minute = start + index * TIMELINE_SLOT_MINUTES;
      return {
        minute,
        label: formatClock(minute),
        startAt: localIsoAt(dateKey, minute),
      };
    },
  );
};

const localMinuteOnDate = (value: string, dateKey: string): number | undefined => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || localDateKey(date) !== dateKey) return undefined;
  return date.getHours() * 60 + date.getMinutes();
};

const safeDuration = (task: Task, fallbackMinutes: number): number => {
  if (task.timeBlock) {
    const start = new Date(task.timeBlock.startAt).getTime();
    const end = new Date(task.timeBlock.endAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return Math.max(5, Math.round((end - start) / 60_000));
    }
  }
  return task.estimatedMinutes && task.estimatedMinutes > 0
    ? Math.round(task.estimatedMinutes)
    : fallbackMinutes;
};

/** Returns a scheduled placement only; planned/due-only tasks remain inbox-like. */
export const taskTimelinePlacement = (
  task: Task,
  dateKey: string,
  fallbackMinutes = 30,
): TimelinePlacement | undefined => {
  if (task.status !== "open" || task.deletedAt) return undefined;
  if (task.timeBlock && !task.startAtIsAllDay) {
    const startMinute = localMinuteOnDate(task.timeBlock.startAt, dateKey);
    if (startMinute !== undefined) {
      const endAt = task.timeBlock.endAt;
      const durationMinutes = safeDuration(task, fallbackMinutes);
      return {
        task,
        startAt: task.timeBlock.startAt,
        endAt,
        startMinute,
        durationMinutes,
        slotMinute:
          Math.floor(startMinute / TIMELINE_SLOT_MINUTES) * TIMELINE_SLOT_MINUTES,
        source: "time-block",
      };
    }
  }
  if (task.startAt && !task.startAtIsAllDay) {
    const startMinute = localMinuteOnDate(task.startAt, dateKey);
    if (startMinute !== undefined) {
      const durationMinutes = safeDuration(task, fallbackMinutes);
      return {
        task,
        startAt: task.startAt,
        endAt: localIsoAt(dateKey, startMinute + durationMinutes),
        startMinute,
        durationMinutes,
        slotMinute:
          Math.floor(startMinute / TIMELINE_SLOT_MINUTES) * TIMELINE_SLOT_MINUTES,
        source: "start-time",
      };
    }
  }
  return undefined;
};

export const scheduledTimelineTasks = (
  tasks: readonly Task[],
  dateKey: string,
  fallbackMinutes = 30,
): TimelinePlacement[] =>
  tasks
    .map((task) => taskTimelinePlacement(task, dateKey, fallbackMinutes))
    .filter((value): value is TimelinePlacement => value !== undefined)
    .sort(
      (left, right) =>
        left.startMinute - right.startMinute ||
        left.task.privateOrder - right.task.privateOrder ||
        left.task.title.localeCompare(right.task.title, "zh-CN"),
    );

export const unscheduledTimelineTasks = (
  tasks: readonly Task[],
  dateKey: string,
  fallbackMinutes = 30,
): Task[] =>
  tasks
    .filter((task) => task.status === "open" && !task.deletedAt)
    .filter((task) => {
      const placement = taskTimelinePlacement(task, dateKey, fallbackMinutes);
      if (placement) return false;
      const planned = task.plannedDate === dateKey;
      const due = task.dueAt ? localDateKey(new Date(task.dueAt)) === dateKey : false;
      return planned || due;
    })
    .sort(
      (left, right) =>
        left.privateOrder - right.privateOrder ||
        left.title.localeCompare(right.title, "zh-CN"),
    );
