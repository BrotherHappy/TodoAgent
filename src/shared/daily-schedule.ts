import type { Task } from "./models";
import {
  calendarBusyBlocksForDate,
  type CalendarBusyBlock,
  type CalendarEvent,
} from "./calendar-events";

export type DailyScheduleSlotSource = "existing-block" | "suggested";
export type DailyScheduleConflict =
  | "outside-window"
  | "overlap"
  | "buffer"
  | "calendar";
export type DailyScheduleUnscheduledReason =
  | "no-room"
  | "fixed-outside-window"
  | "invalid-time";

export interface DailyScheduleInput {
  task: Pick<Task, "id" | "title" | "timeBlock" | "startAt" | "startAtIsAllDay">;
  estimatedMinutes: number;
}

export interface DailyScheduleOptions {
  date: string;
  availableStartMinutes: number;
  availableEndMinutes: number;
  bufferMinutes: number;
  /** Read-only reservations imported from a local calendar. */
  calendarEvents?: readonly CalendarEvent[];
}

export interface DailyScheduleSlot {
  taskId: string;
  taskTitle: string;
  startMinutes: number;
  endMinutes: number;
  estimatedMinutes: number;
  source: DailyScheduleSlotSource;
  conflict?: DailyScheduleConflict;
}

export interface DailyScheduleUnscheduled {
  taskId: string;
  taskTitle: string;
  estimatedMinutes: number;
  reason: DailyScheduleUnscheduledReason;
}

export interface DailyScheduleResult {
  slots: DailyScheduleSlot[];
  /** Calendar reservations are rendered separately from task slots. */
  busyBlocks: CalendarBusyBlock[];
  unscheduled: DailyScheduleUnscheduled[];
  scheduledMinutes: number;
  effectiveWindowMinutes: number;
  calendarBusyMinutes: number;
}

interface Interval {
  start: number;
  end: number;
  taskId: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localMinutes(value: string | undefined, date: string): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || localDateKey(parsed) !== date) return undefined;
  return parsed.getHours() * 60 + parsed.getMinutes();
}

function validMinute(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 1_439;
}

function normalizedOptions(options: DailyScheduleOptions): DailyScheduleOptions {
  const fallbackStart = 9 * 60;
  const fallbackEnd = 18 * 60;
  const start = validMinute(options.availableStartMinutes)
    ? options.availableStartMinutes
    : fallbackStart;
  const end = validMinute(options.availableEndMinutes) && options.availableEndMinutes > start
    ? options.availableEndMinutes
    : fallbackEnd;
  const buffer = Number.isFinite(options.bufferMinutes)
    ? Math.max(0, Math.min(180, Math.round(options.bufferMinutes)))
    : 0;
  return { ...options, availableStartMinutes: start, availableEndMinutes: end, bufferMinutes: buffer };
}

function fixedInterval(
  input: DailyScheduleInput,
  date: string,
): { start: number; end: number } | undefined {
  if (input.task.startAtIsAllDay) return undefined;
  const start = localMinutes(input.task.timeBlock?.startAt ?? input.task.startAt, date);
  if (start === undefined) return undefined;
  const explicitEnd = localMinutes(input.task.timeBlock?.endAt, date);
  const end = explicitEnd ?? start + input.estimatedMinutes;
  if (!Number.isFinite(end) || end <= start) return undefined;
  return { start, end };
}

function sortSlots(slots: DailyScheduleSlot[]): DailyScheduleSlot[] {
  return [...slots].sort(
    (left, right) =>
      left.startMinutes - right.startMinutes ||
      left.endMinutes - right.endMinutes ||
      left.taskId.localeCompare(right.taskId),
  );
}

/**
 * Creates a read-only time-block proposal for the selected Today tasks.
 * Existing explicit time blocks are kept in place; other tasks are packed in
 * order into the available window while leaving the requested transition
 * buffer. This function never mutates tasks or creates an operation.
 */
export function buildDailySchedule(
  inputs: readonly DailyScheduleInput[],
  rawOptions: DailyScheduleOptions,
): DailyScheduleResult {
  const options = normalizedOptions(rawOptions);
  const effectiveWindowMinutes = Math.max(
    0,
    options.availableEndMinutes - options.availableStartMinutes,
  );
  const unique = new Map<string, DailyScheduleInput>();
  inputs.forEach((input) => {
    if (input.task.id && !unique.has(input.task.id)) unique.set(input.task.id, input);
  });

  const slots: DailyScheduleSlot[] = [];
  const unscheduled: DailyScheduleUnscheduled[] = [];
  const fixedIntervals: Interval[] = [];
  const flexible: DailyScheduleInput[] = [];
  const busyBlocks = calendarBusyBlocksForDate(options.calendarEvents ?? [], options.date);
  const calendarIntervals: Interval[] = busyBlocks.map((block) => ({
    start: block.startMinutes,
    end: block.endMinutes,
    taskId: `calendar:${block.id}`,
  }));
  const reservedIntervals = [...calendarIntervals];

  for (const input of unique.values()) {
    const estimate = Math.max(1, Math.round(input.estimatedMinutes));
    const fixed = fixedInterval(input, options.date);
    if (!fixed) {
      flexible.push({ ...input, estimatedMinutes: estimate });
      continue;
    }
    const outsideWindow =
      fixed.start < options.availableStartMinutes || fixed.end > options.availableEndMinutes;
    const overlapsCalendar = calendarIntervals.some(
      (interval) => fixed.start < interval.end && fixed.end > interval.start,
    );
    const overlapsTask = fixedIntervals.some(
      (interval) => fixed.start < interval.end && fixed.end > interval.start,
    );
    const conflict: DailyScheduleConflict | undefined = outsideWindow
      ? "outside-window"
      : overlapsCalendar
        ? "calendar"
        : overlapsTask
          ? "overlap"
          : undefined;
    slots.push({
      taskId: input.task.id,
      taskTitle: input.task.title,
      startMinutes: fixed.start,
      endMinutes: fixed.end,
      estimatedMinutes: Math.max(1, fixed.end - fixed.start),
      source: "existing-block",
      conflict,
    });
    if (fixed.end > options.availableStartMinutes && fixed.start < options.availableEndMinutes) {
      const interval = { start: fixed.start, end: fixed.end, taskId: input.task.id };
      fixedIntervals.push(interval);
      reservedIntervals.push(interval);
    }
  }

  reservedIntervals.sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = options.availableStartMinutes;
  for (const input of flexible) {
    const estimate = Math.max(1, Math.round(input.estimatedMinutes));
    let candidate = cursor;
    let placed = false;
    for (const interval of reservedIntervals) {
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
      unscheduled.push({
        taskId: input.task.id,
        taskTitle: input.task.title,
        estimatedMinutes: estimate,
        reason: "no-room",
      });
      continue;
    }
    const slot: DailyScheduleSlot = {
      taskId: input.task.id,
      taskTitle: input.task.title,
      startMinutes: candidate,
      endMinutes: candidate + estimate,
      estimatedMinutes: estimate,
      source: "suggested",
    };
    slots.push(slot);
    const interval = { start: slot.startMinutes, end: slot.endMinutes, taskId: slot.taskId };
    fixedIntervals.push(interval);
    reservedIntervals.push(interval);
    reservedIntervals.sort((left, right) => left.start - right.start || left.end - right.end);
    cursor = slot.endMinutes + options.bufferMinutes;
  }

  const sortedSlots = sortSlots(slots);
  const scheduledMinutes = sortedSlots.reduce(
    (total, slot) => total + slot.estimatedMinutes,
    0,
  );
  return {
    slots: sortedSlots,
    busyBlocks,
    unscheduled,
    scheduledMinutes,
    effectiveWindowMinutes,
    calendarBusyMinutes: busyBlocks.reduce(
      (total, block) => total + Math.max(0, block.endMinutes - block.startMinutes),
      0,
    ),
  };
}

export function formatDailyScheduleTime(minutes: number): string {
  const safe = Math.max(0, Math.min(1_439, Math.round(minutes)));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function isDailyScheduleDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return !Number.isNaN(parsed.getTime()) && localDateKey(parsed) === value;
}
