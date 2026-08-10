import type { RecurrenceRule, Task } from "../../src/shared/models";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidRecurrenceRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecurrenceRuleError";
  }
}

export const isDateOnly = (value: string): boolean =>
  DATE_ONLY_PATTERN.test(value);

const parseTemporal = (value: string): Date => {
  const date = isDateOnly(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : new Date(value);
  if (
    Number.isNaN(date.getTime()) ||
    (isDateOnly(value) && date.toISOString().slice(0, 10) !== value)
  ) {
    throw new InvalidRecurrenceRuleError(`Invalid date: ${value}`);
  }
  return date;
};

const formatTemporal = (date: Date, dateOnly: boolean): string =>
  dateOnly ? date.toISOString().slice(0, 10) : date.toISOString();

const daysInUtcMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

export const validateRecurrenceRule = (
  rule: RecurrenceRule,
): RecurrenceRule => {
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new InvalidRecurrenceRuleError(
      "Recurrence interval must be a positive integer.",
    );
  }

  if (rule.weekdays !== undefined) {
    if (
      rule.frequency !== "weekly" ||
      rule.weekdays.length === 0 ||
      rule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    ) {
      throw new InvalidRecurrenceRuleError(
        "Weekly weekdays must contain values from 0 to 6.",
      );
    }
  }

  if (
    rule.dayOfMonth !== undefined &&
    (rule.frequency !== "monthly" ||
      !Number.isInteger(rule.dayOfMonth) ||
      rule.dayOfMonth < 1 ||
      rule.dayOfMonth > 31)
  ) {
    throw new InvalidRecurrenceRuleError(
      "Monthly dayOfMonth must be between 1 and 31.",
    );
  }

  if (
    rule.maxOccurrences !== undefined &&
    (!Number.isInteger(rule.maxOccurrences) || rule.maxOccurrences < 1)
  ) {
    throw new InvalidRecurrenceRuleError(
      "maxOccurrences must be a positive integer.",
    );
  }

  if (rule.endsAt !== undefined) {
    parseTemporal(rule.endsAt);
  }

  return {
    ...rule,
    weekdays:
      rule.weekdays === undefined
        ? undefined
        : [...new Set(rule.weekdays)].sort((a, b) => a - b),
  };
};

const nextDaily = (current: Date, interval: number): Date => {
  const next = new Date(current);
  next.setUTCDate(next.getUTCDate() + interval);
  return next;
};

const nextWeekly = (current: Date, rule: RecurrenceRule): Date => {
  const weekdays = rule.weekdays;
  if (weekdays === undefined || weekdays.length === 0) {
    return nextDaily(current, rule.interval * 7);
  }

  const currentDay = current.getUTCDay();
  const laterThisWeek = weekdays.find((day) => day > currentDay);
  const dayDelta =
    laterThisWeek === undefined
      ? rule.interval * 7 - currentDay + weekdays[0]
      : laterThisWeek - currentDay;
  return nextDaily(current, dayDelta);
};

const nextMonthly = (current: Date, rule: RecurrenceRule): Date => {
  const targetMonthStart = new Date(
    Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth() + rule.interval,
      1,
      current.getUTCHours(),
      current.getUTCMinutes(),
      current.getUTCSeconds(),
      current.getUTCMilliseconds(),
    ),
  );
  const desiredDay = rule.dayOfMonth ?? current.getUTCDate();
  targetMonthStart.setUTCDate(
    Math.min(
      desiredDay,
      daysInUtcMonth(
        targetMonthStart.getUTCFullYear(),
        targetMonthStart.getUTCMonth(),
      ),
    ),
  );
  return targetMonthStart;
};

const occursAfterEnd = (candidate: Date, rule: RecurrenceRule): boolean => {
  if (rule.endsAt === undefined) {
    return false;
  }
  const end = parseTemporal(rule.endsAt);
  if (isDateOnly(rule.endsAt)) {
    end.setUTCHours(23, 59, 59, 999);
  }
  return candidate.getTime() > end.getTime();
};

/**
 * Returns the next occurrence using a zero-based current occurrence index.
 * The output preserves whether the anchor was a date-only or date-time value.
 */
export const getNextOccurrence = (
  anchor: string,
  inputRule: RecurrenceRule,
  currentOccurrenceIndex = 0,
): string | undefined => {
  const rule = validateRecurrenceRule(inputRule);
  const nextIndex = currentOccurrenceIndex + 1;
  if (rule.maxOccurrences !== undefined && nextIndex >= rule.maxOccurrences) {
    return undefined;
  }

  const current = parseTemporal(anchor);
  const next =
    rule.frequency === "daily"
      ? nextDaily(current, rule.interval)
      : rule.frequency === "weekly"
        ? nextWeekly(current, rule)
        : nextMonthly(current, rule);

  if (occursAfterEnd(next, rule)) {
    return undefined;
  }
  return formatTemporal(next, isDateOnly(anchor));
};

export const shiftTemporal = (
  value: string,
  oldAnchor: string,
  newAnchor: string,
): string => {
  const valueDate = parseTemporal(value);
  const oldDate = parseTemporal(oldAnchor);
  const newDate = parseTemporal(newAnchor);
  const shifted = new Date(
    valueDate.getTime() + (newDate.getTime() - oldDate.getTime()),
  );
  return formatTemporal(shifted, isDateOnly(value));
};

export const getTaskRecurrenceAnchor = (task: Task): string | undefined =>
  task.dueAt ?? task.plannedDate ?? task.startAt ?? task.timeBlock?.startAt;

/** Creates the next local occurrence. Feishu owns generation of its recurring instances. */
export const createNextRecurringTask = (
  task: Task,
  id: string,
  createdAt: string,
  privateOrder: number,
): Task | undefined => {
  if (task.source.type !== "local" || task.recurrence === undefined) {
    return undefined;
  }

  const anchor = getTaskRecurrenceAnchor(task);
  if (anchor === undefined) {
    return undefined;
  }
  const currentIndex = task.recurrenceIndex ?? 0;
  const nextAnchor = getNextOccurrence(anchor, task.recurrence, currentIndex);
  if (nextAnchor === undefined) {
    return undefined;
  }

  const next = JSON.parse(JSON.stringify(task)) as Task;
  next.id = id;
  next.status = "open";
  delete next.completedAt;
  delete next.deletedAt;
  delete next.focusStartedAt;
  next.focusElapsedSeconds = 0;
  next.focusSessions = [];
  next.privateOrder = privateOrder;
  next.recurrenceSeriesId = task.recurrenceSeriesId ?? task.id;
  next.recurrenceIndex = currentIndex + 1;
  next.createdAt = createdAt;
  next.updatedAt = createdAt;
  next.sync = { status: "local" };

  if (next.plannedDate !== undefined) {
    next.plannedDate = shiftTemporal(next.plannedDate, anchor, nextAnchor);
  }
  if (next.startAt !== undefined) {
    next.startAt = shiftTemporal(next.startAt, anchor, nextAnchor);
  }
  if (next.dueAt !== undefined) {
    next.dueAt = shiftTemporal(next.dueAt, anchor, nextAnchor);
  }
  if (next.timeBlock !== undefined) {
    next.timeBlock = {
      startAt: shiftTemporal(next.timeBlock.startAt, anchor, nextAnchor),
      endAt: shiftTemporal(next.timeBlock.endAt, anchor, nextAnchor),
    };
  }
  next.reminders = next.reminders.map((reminder, index) => ({
    ...reminder,
    // Each occurrence owns fresh reminder state. Deriving the id only from the
    // new task id keeps it stable and bounded across long-running series.
    id: `${id}:r:${index}`,
    at: shiftTemporal(reminder.at, anchor, nextAnchor),
  }));

  return next;
};
