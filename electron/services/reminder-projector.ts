import type { Task } from '../../src/shared/models';
import type { ReminderCandidate, ReminderReason } from '../../src/shared/reminders';
import type { NotificationSettings } from '../../src/shared/settings';

export interface ReminderTaskSource {
  listTasksForReminders(): Promise<readonly Task[]>;
}

export interface ReminderSettingsSource {
  getNotificationSettings(): NotificationSettings | Promise<NotificationSettings>;
}

export interface ReminderProjectorOptions {
  taskSource: ReminderTaskSource;
  settingsSource: ReminderSettingsSource;
  timeZone: () => string;
  now?: () => Date;
  startedAt?: Date;
  /** How far before process start a missed reminder remains actionable. */
  missedLookbackMs?: number;
  includeDueCandidates?: boolean;
}

export interface ReminderProjectionContext {
  now: Date;
  startedAt: Date;
  timeZone: string;
  missedLookbackMs?: number;
  includeDueCandidates?: boolean;
}

export class ReminderProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderProjectionError';
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const OFFSET_DATE_TIME = /(Z|[+-]\d{2}:?\d{2})$/i;

const assertFiniteDate = (date: Date, field: string): void => {
  if (Number.isNaN(date.getTime())) {
    throw new ReminderProjectionError(`${field} is not a valid date-time.`);
  }
};

const zonedFormatter = (timeZone: string): Intl.DateTimeFormat => {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    // Force eager validation because some engines defer it until formatting.
    formatter.format(new Date(0));
    return formatter;
  } catch {
    throw new ReminderProjectionError(`Unknown IANA time zone: ${timeZone}`);
  }
};

const getZonedParts = (
  instant: Date,
  timeZone: string,
  formatter = zonedFormatter(timeZone),
): ZonedParts => {
  const values = new Map(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  const value = (key: Intl.DateTimeFormatPartTypes): number => values.get(key) ?? Number.NaN;
  const parts: ZonedParts = {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
  if (Object.values(parts).some((part) => !Number.isFinite(part))) {
    throw new ReminderProjectionError('Unable to resolve local time-zone components.');
  }
  return parts;
};

const localDateKey = (instant: Date, timeZone: string): string => {
  const { year, month, day } = getZonedParts(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** Converts wall-clock parts in an IANA zone to an absolute instant. */
const fromZonedParts = (parts: ZonedParts, timeZone: string): Date => {
  const desiredAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = desiredAsUtc;
  const formatter = zonedFormatter(timeZone);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = getZonedParts(new Date(candidate), timeZone, formatter);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = desiredAsUtc - actualAsUtc;
    if (correction === 0) return new Date(candidate);
    candidate += correction;
  }
  // A nonexistent DST wall time resolves to the first valid instant after the
  // gap, which is preferable to silently dropping the reminder.
  return new Date(candidate);
};

const parseLocalDate = (value: string, field: string): ZonedParts => {
  const match = DATE_ONLY.exec(value);
  if (match === null) throw new ReminderProjectionError(`${field} must use YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new ReminderProjectionError(`${field} is not a calendar date.`);
  }
  return { year, month, day, hour: 0, minute: 0, second: 0 };
};

const parseScheduledAt = (value: string, timeZone: string, field: string): Date => {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly !== null) {
    const parts = parseLocalDate(value, field);
    return fromZonedParts({ ...parts, hour: 23, minute: 59, second: 0 }, timeZone);
  }
  if (OFFSET_DATE_TIME.test(value)) {
    const date = new Date(value);
    assertFiniteDate(date, field);
    return date;
  }
  const local = LOCAL_DATE_TIME.exec(value);
  if (local !== null) {
    const parts: ZonedParts = {
      year: Number(local[1]),
      month: Number(local[2]),
      day: Number(local[3]),
      hour: Number(local[4]),
      minute: Number(local[5]),
      second: Number(local[6] ?? 0),
    };
    const calendar = parseLocalDate(
      `${local[1]}-${local[2]}-${local[3]}`,
      field,
    );
    if (
      parts.hour > 23 ||
      parts.minute > 59 ||
      parts.second > 59 ||
      calendar.year !== parts.year
    ) {
      throw new ReminderProjectionError(`${field} has an invalid local time.`);
    }
    return fromZonedParts(parts, timeZone);
  }
  throw new ReminderProjectionError(`${field} must be ISO-8601.`);
};

const morningInstant = (
  localDate: string,
  time: string,
  timeZone: string,
): Date => {
  const date = parseLocalDate(localDate, 'morningBriefDate');
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (match === null || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new ReminderProjectionError('morningBriefTime must use HH:mm.');
  }
  return fromZonedParts(
    { ...date, hour: Number(match[1]), minute: Number(match[2]) },
    timeZone,
  );
};

const isEligibleTask = (task: Task): boolean =>
  task.status === 'open' &&
  task.deletedAt === undefined &&
  task.sync.status !== 'remote-deleted';

const isActionableAroundStartup = (
  scheduledAt: Date,
  context: ReminderProjectionContext,
): boolean => {
  if (scheduledAt >= context.startedAt) return true;
  const lookback = context.missedLookbackMs ?? 24 * 60 * 60_000;
  return scheduledAt.getTime() >= context.startedAt.getTime() - lookback;
};

const morningBody = (
  tasks: readonly Task[],
  localToday: string,
  timeZone: string,
): string => {
  let overdue = 0;
  let today = 0;
  tasks.filter(isEligibleTask).forEach((task) => {
    const dueDate = task.dueAt === undefined
      ? undefined
      : localDateKey(parseScheduledAt(task.dueAt, timeZone, 'task.dueAt'), timeZone);
    if (dueDate !== undefined && dueDate < localToday) overdue += 1;
    if (dueDate === localToday || task.plannedDate === localToday) today += 1;
  });
  if (overdue === 0 && today === 0) return '今天暂无到期或计划任务。';
  return `${overdue} 项逾期 · ${today} 项今日任务`;
};

export const projectReminderCandidates = (
  tasks: readonly Task[],
  settings: NotificationSettings,
  inputContext: ReminderProjectionContext,
): ReminderCandidate[] => {
  assertFiniteDate(inputContext.now, 'now');
  assertFiniteDate(inputContext.startedAt, 'startedAt');
  if (
    inputContext.missedLookbackMs !== undefined &&
    (!Number.isFinite(inputContext.missedLookbackMs) || inputContext.missedLookbackMs < 0)
  ) {
    throw new ReminderProjectionError('missedLookbackMs cannot be negative.');
  }
  // Validate once even when no candidate is generated.
  zonedFormatter(inputContext.timeZone);
  if (!settings.enabled) return [];

  const candidates: ReminderCandidate[] = [];
  for (const task of tasks) {
    if (!isEligibleTask(task)) continue;
    const explicitTimes = new Set<number>();
    for (const reminder of task.reminders) {
      if (!reminder.enabled) continue;
      const scheduled = parseScheduledAt(
        reminder.at,
        inputContext.timeZone,
        `task ${task.id} reminder ${reminder.id}`,
      );
      if (!isActionableAroundStartup(scheduled, inputContext)) continue;
      explicitTimes.add(scheduled.getTime());
      candidates.push({
        id: `task:${task.id}:reminder:${reminder.id}`,
        taskId: task.id,
        kind: 'task',
        title: task.title,
        body: reminder.label?.trim() || '任务提醒',
        scheduledAt: scheduled.toISOString(),
        source: reminder.source,
        ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
        priority: task.priority,
        reason: {
          code: 'explicit',
          label: '你设置的提醒',
          ...(reminder.label?.trim()
            ? { detail: `提醒内容：${reminder.label.trim()}` }
            : { detail: '这是任务上的本地提醒时间。' }),
        } satisfies ReminderReason,
      });
    }

    if ((inputContext.includeDueCandidates ?? true) && task.dueAt !== undefined) {
      const scheduled = parseScheduledAt(
        task.dueAt,
        inputContext.timeZone,
        `task ${task.id} dueAt`,
      );
      if (
        !explicitTimes.has(scheduled.getTime()) &&
        isActionableAroundStartup(scheduled, inputContext)
      ) {
        candidates.push({
          id: `task:${task.id}:due`,
          taskId: task.id,
          kind: 'task',
          title: task.title,
          body: '任务已到截止时间',
          scheduledAt: scheduled.toISOString(),
          source: task.source.type,
          ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
          priority: task.priority,
          reason: {
            code: 'deadline',
            label: '任务已到截止时间',
            detail: '截止时间已到，先决定完成、稍后处理，或打开任务查看详情。',
          } satisfies ReminderReason,
        });
      }
    }
  }

  const today = localDateKey(inputContext.now, inputContext.timeZone);
  if (settings.morningBrief) {
    const scheduled = morningInstant(
      today,
      settings.morningBriefTime,
      inputContext.timeZone,
    );
    if (isActionableAroundStartup(scheduled, inputContext)) {
      candidates.push({
        id: `morning-brief:${today}`,
        kind: 'morning-brief',
        title: '今日任务简报',
        body: morningBody(tasks, today, inputContext.timeZone),
        scheduledAt: scheduled.toISOString(),
        reason: {
          code: 'morning-brief',
          label: '每日晨间简报',
          detail: '根据今天的逾期与计划任务生成，不会自动修改任务。',
        } satisfies ReminderReason,
      });
    }
  }

  const unique = new Map<string, ReminderCandidate>();
  candidates.forEach((candidate) => {
    if (!unique.has(candidate.id)) unique.set(candidate.id, candidate);
  });
  return [...unique.values()]
    .sort((left, right) =>
      left.scheduledAt.localeCompare(right.scheduledAt) || left.id.localeCompare(right.id),
    )
    .map((candidate) => structuredClone(candidate));
};

export class ReminderProjector {
  readonly #taskSource: ReminderTaskSource;
  readonly #settingsSource: ReminderSettingsSource;
  readonly #timeZone: () => string;
  readonly #now: () => Date;
  readonly #startedAt: Date;
  readonly #missedLookbackMs: number;
  readonly #includeDueCandidates: boolean;

  constructor(options: ReminderProjectorOptions) {
    this.#taskSource = options.taskSource;
    this.#settingsSource = options.settingsSource;
    this.#timeZone = options.timeZone;
    this.#now = options.now ?? (() => new Date());
    this.#startedAt = new Date(options.startedAt ?? this.#now());
    this.#missedLookbackMs = options.missedLookbackMs ?? 24 * 60 * 60_000;
    this.#includeDueCandidates = options.includeDueCandidates ?? true;
  }

  async project(): Promise<ReminderCandidate[]> {
    const [tasks, settings] = await Promise.all([
      this.#taskSource.listTasksForReminders(),
      this.#settingsSource.getNotificationSettings(),
    ]);
    return projectReminderCandidates(tasks, settings, {
      now: this.#now(),
      startedAt: this.#startedAt,
      timeZone: this.#timeZone(),
      missedLookbackMs: this.#missedLookbackMs,
      includeDueCandidates: this.#includeDueCandidates,
    });
  }
}
