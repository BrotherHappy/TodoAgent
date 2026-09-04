import type { TaskPriority } from './models';

export type ReminderKind = 'task' | 'morning-brief' | 'sync-risk' | 'agent-approval';

/**
 * A small, local explanation for why a reminder is eligible right now.
 *
 * This is deliberately a closed vocabulary rather than model-generated copy:
 * the explanation must remain trustworthy even when AI is disabled or an
 * external task contains untrusted text.
 */
export type ReminderReasonCode =
  | 'explicit'
  | 'deadline'
  | 'morning-brief'
  | 'missed-summary'
  | 'sync-risk'
  | 'agent-approval';

export interface ReminderReason {
  code: ReminderReasonCode;
  label: string;
  detail?: string;
}

export interface ReminderCandidate {
  id: string;
  taskId?: string;
  kind: ReminderKind;
  title: string;
  body: string;
  scheduledAt: string;
  source?: 'local' | 'feishu';
  projectId?: string;
  priority?: TaskPriority;
  completed?: boolean;
  reason?: ReminderReason;
}

export type ReminderPresetAction =
  | 'complete'
  | 'snooze-10m'
  | 'snooze-1h'
  | 'tomorrow'
  | 'open'
  | 'dismiss';

export type ReminderAction = ReminderPresetAction | 'snooze-until';

/**
 * Custom snoozes deliberately have their own discriminated shape so an
 * arbitrary timestamp can never be attached to a different reminder action.
 */
export type ReminderActionEvent =
  | {
      reminderId: string;
      action: ReminderPresetAction;
    }
  | {
      reminderId: string;
      action: 'snooze-until';
      snoozeUntil: string;
    };

/** A custom snooze must be useful, bounded, and safe to persist. */
export const CUSTOM_SNOOZE_MIN_DELAY_MS = 60_000;
export const CUSTOM_SNOOZE_MAX_DELAY_MS = 365 * 24 * 60 * 60_000;

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Validates and normalizes a renderer supplied timestamp against the
 * main-process clock. Callers should persist only the returned value.
 */
export function normalizeCustomSnoozeUntil(
  value: string,
  now: Date,
): string {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !ISO_DATE_TIME_PATTERN.test(value)
  ) {
    throw new RangeError('Custom snooze time must be an ISO-8601 date-time with a time-zone.');
  }
  const nowTimestamp = now.getTime();
  const timestamp = Date.parse(value);
  if (Number.isNaN(nowTimestamp) || Number.isNaN(timestamp)) {
    throw new RangeError('Custom snooze time is invalid.');
  }
  const delay = timestamp - nowTimestamp;
  if (delay < CUSTOM_SNOOZE_MIN_DELAY_MS) {
    throw new RangeError('Custom snooze time must be at least one minute in the future.');
  }
  if (delay > CUSTOM_SNOOZE_MAX_DELAY_MS) {
    throw new RangeError('Custom snooze time cannot be more than 365 days in the future.');
  }
  return new Date(timestamp).toISOString();
}

export interface ReminderDelivery {
  id: string;
  title: string;
  body: string;
  kind: ReminderKind | 'missed-summary';
  taskId?: string;
  actions: Array<{ id: ReminderPresetAction; label: string }>;
  reason?: ReminderReason;
}

export interface ReminderRuntimeState {
  delivered: Record<string, string>;
  dismissed: Record<string, number>;
  snoozedUntil: Record<string, string>;
  /** Delivery timestamps used for the local-day task notification budget. */
  taskNotificationLog: Record<string, string>;
  lastMorningBriefDate?: string;
  lastRiskNoticeDate?: string;
}

export const emptyReminderRuntimeState = (): ReminderRuntimeState => ({
  delivered: {},
  dismissed: {},
  snoozedUntil: {},
  taskNotificationLog: {},
});
