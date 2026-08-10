import type {
  ReminderActionEvent,
  ReminderCandidate,
  ReminderDelivery,
  ReminderRuntimeState,
} from '../../src/shared/reminders';
import {
  emptyReminderRuntimeState,
  normalizeCustomSnoozeUntil,
} from '../../src/shared/reminders';
import type { NotificationSettings } from '../../src/shared/settings';

export interface ReminderStateStore {
  load(): Promise<ReminderRuntimeState | undefined>;
  save(state: ReminderRuntimeState): Promise<void>;
}

export interface ReminderNotificationSink {
  show(delivery: ReminderDelivery): Promise<void> | void;
  cancel(id: string): Promise<void> | void;
}

export interface ReminderSchedulerOptions {
  stateStore: ReminderStateStore;
  sink: ReminderNotificationSink;
  settings: () => NotificationSettings;
  onAction: (event: ReminderActionEvent) => Promise<void> | void;
  now?: () => Date;
}

const localDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const minutesOfDay = (date: Date): number => date.getHours() * 60 + date.getMinutes();

function timeToMinutes(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function isWithinQuietHours(now: Date, settings: NotificationSettings): boolean {
  if (!settings.quietHoursEnabled) return false;
  const current = minutesOfDay(now);
  const start = timeToMinutes(settings.quietHoursStart);
  const end = timeToMinutes(settings.quietHoursEnd);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function deliveryKey(candidate: ReminderCandidate): string {
  return `${candidate.id}:${candidate.scheduledAt}`;
}

function actionsFor(candidate: ReminderCandidate): ReminderDelivery['actions'] {
  if (candidate.kind === 'task') {
    return [
      { id: 'complete', label: '完成' },
      { id: 'snooze-10m', label: '10 分钟后' },
      { id: 'open', label: '打开' },
    ];
  }
  if (candidate.kind === 'agent-approval') return [{ id: 'open', label: '查看请求' }];
  return [{ id: 'open', label: '打开' }, { id: 'dismiss', label: '今日不再提醒' }];
}

export class ReminderScheduler {
  readonly #stateStore: ReminderStateStore;
  readonly #sink: ReminderNotificationSink;
  readonly #settings: () => NotificationSettings;
  readonly #onAction: ReminderSchedulerOptions['onAction'];
  readonly #now: () => Date;
  #state: ReminderRuntimeState = emptyReminderRuntimeState();
  #candidates = new Map<string, ReminderCandidate>();

  constructor(options: ReminderSchedulerOptions) {
    this.#stateStore = options.stateStore;
    this.#sink = options.sink;
    this.#settings = options.settings;
    this.#onAction = options.onAction;
    this.#now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    this.#state = (await this.#stateStore.load()) ?? emptyReminderRuntimeState();
  }

  async replaceCandidates(candidates: ReminderCandidate[]): Promise<void> {
    const next = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    for (const id of this.#candidates.keys()) {
      if (!next.has(id)) await this.#sink.cancel(id);
    }
    this.#candidates = next;
  }

  async tick(): Promise<ReminderDelivery[]> {
    const now = this.#now();
    const settings = this.#settings();
    if (!settings.enabled || settings.mutedUntil && new Date(settings.mutedUntil) > now) return [];
    if (isWithinQuietHours(now, settings)) return [];

    const due = [...this.#candidates.values()]
      .filter((candidate) => this.#isDue(candidate, now))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    if (!due.length) return [];

    const taskDue = due.filter((candidate) => candidate.kind === 'task');
    const deliveries: ReminderDelivery[] = [];
    if (taskDue.length > 3) {
      const summary: ReminderDelivery = {
        id: `missed:${localDateKey(now)}:${now.getHours()}`,
        title: `你有 ${taskDue.length} 个待处理提醒`,
        body: taskDue.slice(0, 3).map((candidate) => candidate.title).join('、'),
        kind: 'missed-summary',
        actions: [{ id: 'open', label: '查看 Today' }],
      };
      await this.#sink.show(summary);
      deliveries.push(summary);
      taskDue.forEach((candidate) => this.#markDelivered(candidate, now));
    } else {
      for (const candidate of due) {
        if (candidate.kind === 'morning-brief' && this.#state.lastMorningBriefDate === localDateKey(now)) {
          this.#markDelivered(candidate, now);
          continue;
        }
        if (candidate.kind === 'sync-risk' && this.#state.lastRiskNoticeDate === localDateKey(now)) {
          this.#markDelivered(candidate, now);
          continue;
        }
        const delivery: ReminderDelivery = {
          id: candidate.id,
          taskId: candidate.taskId,
          title: candidate.title,
          body: candidate.body,
          kind: candidate.kind,
          actions: actionsFor(candidate),
        };
        await this.#sink.show(delivery);
        deliveries.push(delivery);
        this.#markDelivered(candidate, now);
        if (candidate.kind === 'morning-brief') this.#state.lastMorningBriefDate = localDateKey(now);
        if (candidate.kind === 'sync-risk') this.#state.lastRiskNoticeDate = localDateKey(now);
      }
    }
    await this.#stateStore.save(this.#state);
    return deliveries;
  }

  async handleAction(event: ReminderActionEvent): Promise<void> {
    const now = this.#now();
    const candidate = this.#candidates.get(event.reminderId);
    let snoozeUntil: string | undefined;
    if (event.action === 'snooze-until') {
      if (candidate === undefined) {
        throw new RangeError('Cannot snooze an unknown reminder.');
      }
      snoozeUntil = normalizeCustomSnoozeUntil(event.snoozeUntil, now);
    } else if (
      event.action === 'snooze-10m' ||
      event.action === 'snooze-1h' ||
      event.action === 'tomorrow'
    ) {
      const delay = event.action === 'snooze-10m'
        ? 10 * 60_000
        : event.action === 'snooze-1h'
          ? 60 * 60_000
          : 24 * 60 * 60_000;
      snoozeUntil = new Date(now.getTime() + delay).toISOString();
    }
    if (snoozeUntil !== undefined) {
      // One canonical value per reminder makes repeated custom choices
      // idempotent and survives process restarts through ReminderStateStore.
      this.#state.snoozedUntil[event.reminderId] = snoozeUntil;
      delete this.#state.delivered[deliveryKey(candidate ?? {
        id: event.reminderId,
        title: '',
        body: '',
        kind: 'task',
        scheduledAt: '',
      })];
    }
    if (event.action === 'dismiss') {
      this.#state.dismissed[event.reminderId] = (this.#state.dismissed[event.reminderId] ?? 0) + 1;
    }
    await this.#stateStore.save(this.#state);
    await this.#onAction(event);
  }

  async cancel(reminderId: string): Promise<void> {
    this.#candidates.delete(reminderId);
    delete this.#state.snoozedUntil[reminderId];
    await this.#sink.cancel(reminderId);
    await this.#stateStore.save(this.#state);
  }

  #isDue(candidate: ReminderCandidate, now: Date): boolean {
    if (candidate.completed) return false;
    const scheduled = new Date(candidate.scheduledAt);
    if (Number.isNaN(scheduled.getTime()) || scheduled > now) return false;
    const snoozed = this.#state.snoozedUntil[candidate.id];
    if (snoozed && new Date(snoozed) > now) return false;
    return !this.#state.delivered[deliveryKey(candidate)];
  }

  #markDelivered(candidate: ReminderCandidate, now: Date): void {
    this.#state.delivered[deliveryKey(candidate)] = now.toISOString();
    delete this.#state.snoozedUntil[candidate.id];
  }
}
