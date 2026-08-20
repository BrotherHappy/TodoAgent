import type { Task } from "./models";

/** A read-only carry-over proposal for tasks that do not fit in one day. */
export type MultiDayScheduleSlotSource = "fixed" | "suggested";

export type MultiDayScheduleUnscheduledReason =
  | "past-deadline"
  | "no-capacity"
  | "horizon";

export interface MultiDayScheduleInput {
  task: Pick<
    Task,
    | "id"
    | "title"
    | "timeBlock"
    | "startAt"
    | "startAtIsAllDay"
    | "dueAt"
  >;
  estimatedMinutes: number;
}

export interface MultiDayScheduleOptions {
  startDate: string;
  availableStartMinutes: number;
  availableEndMinutes: number;
  bufferMinutes: number;
  /** Number of weekday capacity windows to preview. Defaults to five. */
  maxWorkdays?: number;
  /** Weekends are omitted from flexible suggestions by default. */
  workdaysOnly?: boolean;
}

export interface MultiDayScheduleSlot {
  date: string;
  taskId: string;
  taskTitle: string;
  startMinutes: number;
  endMinutes: number;
  estimatedMinutes: number;
  source: MultiDayScheduleSlotSource;
  /** A fixed block can remain visible even when it is outside the day window. */
  conflict?: "outside-window" | "overlap";
}

export interface MultiDayScheduleDay {
  date: string;
  slots: MultiDayScheduleSlot[];
  capacityMinutes: number;
  scheduledMinutes: number;
  remainingMinutes: number;
}

export interface MultiDayScheduleUnscheduled {
  taskId: string;
  taskTitle: string;
  estimatedMinutes: number;
  reason: MultiDayScheduleUnscheduledReason;
}

export interface MultiDayScheduleResult {
  days: MultiDayScheduleDay[];
  unscheduled: MultiDayScheduleUnscheduled[];
  scheduledMinutes: number;
  scheduledTaskCount: number;
  horizonEndDate?: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

interface Interval {
  start: number;
  end: number;
}

function assertDate(value: string): string {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new RangeError("Multi-day schedule date must use YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day, 12);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw new RangeError("Multi-day schedule date is not a valid calendar date.");
  }
  return value;
}

function addDays(value: string, amount: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + amount);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function isWeekday(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const weekday = new Date(year, month - 1, day, 12).getDay();
  return weekday !== 0 && weekday !== 6;
}

function localDateKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0"),
  ].join("-");
}

function localMinutes(value: string | undefined, date: string): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || localDateKey(value) !== date) return undefined;
  return parsed.getHours() * 60 + parsed.getMinutes();
}

function fixedDate(input: MultiDayScheduleInput): string | undefined {
  if (input.task.startAtIsAllDay) return undefined;
  return localDateKey(input.task.timeBlock?.startAt ?? input.task.startAt);
}

function dueDate(input: MultiDayScheduleInput): string | undefined {
  return localDateKey(input.task.dueAt);
}

function estimateFor(input: MultiDayScheduleInput): number {
  return Math.max(
    1,
    Number.isFinite(input.estimatedMinutes)
      ? Math.round(input.estimatedMinutes)
      : 30,
  );
}

function fixedInterval(
  input: MultiDayScheduleInput,
  date: string,
): Interval | undefined {
  if (input.task.startAtIsAllDay) return undefined;
  const start = localMinutes(input.task.timeBlock?.startAt ?? input.task.startAt, date);
  if (start === undefined) return undefined;
  const explicitEnd = localMinutes(input.task.timeBlock?.endAt, date);
  const end = explicitEnd ?? start + estimateFor(input);
  return Number.isFinite(end) && end > start ? { start, end } : undefined;
}

function buildDateKeys(
  startDate: string,
  maxWorkdays: number,
  workdaysOnly: boolean,
  fixedDates: ReadonlySet<string>,
): string[] {
  const dates: string[] = [];
  let cursor = startDate;
  let workdayCount = 0;
  let inspected = 0;
  const inspectionLimit = Math.max(14, maxWorkdays * 4 + fixedDates.size + 4);
  while (workdayCount < maxWorkdays && inspected < inspectionLimit) {
    const weekday = isWeekday(cursor);
    if (!workdaysOnly || weekday) {
      dates.push(cursor);
      workdayCount += 1;
    } else if (fixedDates.has(cursor)) {
      // Explicit appointments remain visible even on weekends; they do not
      // consume one of the flexible weekday capacity windows.
      dates.push(cursor);
    }
    cursor = addDays(cursor, 1);
    inspected += 1;
  }
  return dates;
}

function sortSlots(slots: MultiDayScheduleSlot[]): MultiDayScheduleSlot[] {
  return [...slots].sort(
    (left, right) =>
      left.startMinutes - right.startMinutes ||
      left.endMinutes - right.endMinutes ||
      left.taskId.localeCompare(right.taskId),
  );
}

function scheduleDay(
  inputs: readonly MultiDayScheduleInput[],
  options: Pick<
    MultiDayScheduleOptions,
    "availableStartMinutes" | "availableEndMinutes" | "bufferMinutes"
  > & { date: string },
): { slots: MultiDayScheduleSlot[]; unscheduledIds: string[] } {
  const fixedIntervals: Array<Interval & { taskId: string }> = [];
  const flexible: MultiDayScheduleInput[] = [];
  const slots: MultiDayScheduleSlot[] = [];

  for (const input of inputs) {
    const fixed = fixedInterval(input, options.date);
    if (!fixed) {
      flexible.push(input);
      continue;
    }
    const outside =
      fixed.start < options.availableStartMinutes ||
      fixed.end > options.availableEndMinutes;
    const overlap = fixedIntervals.some(
      (interval) => fixed.start < interval.end && fixed.end > interval.start,
    );
    const conflict = outside ? "outside-window" : overlap ? "overlap" : undefined;
    slots.push({
      date: options.date,
      taskId: input.task.id,
      taskTitle: input.task.title,
      startMinutes: fixed.start,
      endMinutes: fixed.end,
      estimatedMinutes: Math.max(1, fixed.end - fixed.start),
      source: "fixed",
      conflict,
    });
    // Keep all fixed intervals occupied, including an outside-window block
    // that partially overlaps the available window.
    fixedIntervals.push({ ...fixed, taskId: input.task.id });
  }

  fixedIntervals.sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = options.availableStartMinutes;
  const unscheduledIds: string[] = [];
  for (const input of flexible) {
    const estimate = estimateFor(input);
    let candidate = cursor;
    let placed = false;
    for (const interval of fixedIntervals) {
      const latestBeforeFixed = interval.start - options.bufferMinutes;
      if (candidate < interval.start && candidate + estimate <= latestBeforeFixed) {
        placed = true;
        break;
      }
      if (candidate < interval.end + options.bufferMinutes) {
        candidate = interval.end + options.bufferMinutes;
      }
    }
    if (!placed && candidate + estimate <= options.availableEndMinutes) placed = true;
    if (!placed) {
      unscheduledIds.push(input.task.id);
      continue;
    }
    slots.push({
      date: options.date,
      taskId: input.task.id,
      taskTitle: input.task.title,
      startMinutes: candidate,
      endMinutes: candidate + estimate,
      estimatedMinutes: estimate,
      source: "suggested",
    });
    fixedIntervals.push({
      start: candidate,
      end: candidate + estimate,
      taskId: input.task.id,
    });
    fixedIntervals.sort((left, right) => left.start - right.start || left.end - right.end);
    cursor = candidate + estimate + options.bufferMinutes;
  }
  return { slots: sortSlots(slots), unscheduledIds };
}

/**
 * Builds a deterministic, read-only carry-over proposal. It never mutates a
 * task, changes `plannedDate`/`timeBlock`, creates an operation, or talks to
 * Feishu. The input order is preserved for flexible tasks, while fixed blocks
 * remain on their original date.
 */
export function buildMultiDaySchedule(
  rawInputs: readonly MultiDayScheduleInput[],
  rawOptions: MultiDayScheduleOptions,
): MultiDayScheduleResult {
  const startDate = assertDate(rawOptions.startDate);
  const availableStartMinutes = Number.isInteger(rawOptions.availableStartMinutes)
    ? Math.max(0, Math.min(1_439, rawOptions.availableStartMinutes))
    : 9 * 60;
  const availableEndMinutes =
    Number.isInteger(rawOptions.availableEndMinutes) &&
    rawOptions.availableEndMinutes > availableStartMinutes
      ? Math.min(1_439, rawOptions.availableEndMinutes)
      : 18 * 60;
  const bufferMinutes = Number.isFinite(rawOptions.bufferMinutes)
    ? Math.max(0, Math.min(180, Math.round(rawOptions.bufferMinutes)))
    : 0;
  const maxWorkdays = Number.isInteger(rawOptions.maxWorkdays)
    ? Math.max(1, Math.min(10, rawOptions.maxWorkdays!))
    : 5;
  const workdaysOnly = rawOptions.workdaysOnly ?? true;
  const unique = new Map<string, MultiDayScheduleInput>();
  for (const input of rawInputs) {
    if (input.task.id && !unique.has(input.task.id)) unique.set(input.task.id, input);
  }
  const inputs = [...unique.values()];
  const fixedDates = new Set(
    inputs
      .map(fixedDate)
      .filter((value): value is string => Boolean(value && value >= startDate)),
  );
  const dates = buildDateKeys(startDate, maxWorkdays, workdaysOnly, fixedDates);
  const remaining = new Map(inputs.map((input) => [input.task.id, input]));
  const days: MultiDayScheduleDay[] = [];
  const unscheduled: MultiDayScheduleUnscheduled[] = [];
  const capacityMinutes = Math.max(
    0,
    availableEndMinutes - availableStartMinutes - bufferMinutes,
  );

  for (const date of dates) {
    const candidates: MultiDayScheduleInput[] = [];
    for (const input of remaining.values()) {
      const fixed = fixedDate(input);
      if (fixed && fixed > date) continue;
      const due = dueDate(input);
      if (due && due < date) {
        unscheduled.push({
          taskId: input.task.id,
          taskTitle: input.task.title,
          estimatedMinutes: estimateFor(input),
          reason: "past-deadline",
        });
        remaining.delete(input.task.id);
        continue;
      }
      if (fixed && fixed === date) {
        candidates.push(input);
      } else if (!fixed || fixed < startDate) {
        candidates.push(input);
      }
    }
    const dayResult = scheduleDay(candidates, {
      date,
      availableStartMinutes,
      availableEndMinutes,
      bufferMinutes,
    });
    const scheduledIds = new Set(dayResult.slots.map((slot) => slot.taskId));
    for (const id of scheduledIds) remaining.delete(id);
    const dayScheduledMinutes = dayResult.slots.reduce(
      (total, slot) => total + slot.estimatedMinutes,
      0,
    );
    days.push({
      date,
      slots: dayResult.slots,
      capacityMinutes,
      scheduledMinutes: dayScheduledMinutes,
      remainingMinutes: Math.max(0, capacityMinutes - dayScheduledMinutes),
    });
  }

  const horizonEndDate = dates[dates.length - 1];
  for (const input of remaining.values()) {
    const fixed = fixedDate(input);
    unscheduled.push({
      taskId: input.task.id,
      taskTitle: input.task.title,
      estimatedMinutes: estimateFor(input),
      reason: fixed && horizonEndDate && fixed > horizonEndDate ? "horizon" : "no-capacity",
    });
  }
  const scheduledMinutes = days.reduce(
    (total, day) => total + day.scheduledMinutes,
    0,
  );
  return {
    days,
    unscheduled,
    scheduledMinutes,
    scheduledTaskCount: Math.max(0, inputs.length - unscheduled.length),
    horizonEndDate,
  };
}
