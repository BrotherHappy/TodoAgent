import type {
  ReminderAction,
  ReminderActionEvent,
  ReminderCandidate,
  ReminderDelivery,
  ReminderPresetAction,
} from '../../src/shared/reminders';
import { normalizeCustomSnoozeUntil } from '../../src/shared/reminders';
import { defaultSettings, type NotificationSettings } from '../../src/shared/settings';
import {
  ReminderProjector,
  type ReminderSettingsSource,
  type ReminderTaskSource,
} from './reminder-projector';
import {
  ReminderScheduler,
  type ReminderStateStore,
} from './reminder-service';

export type NotificationPermissionStatus =
  | 'granted'
  | 'denied'
  | 'not-determined'
  | 'unsupported';

export interface NotificationInteraction {
  type: 'click' | 'action' | 'close';
  /** Stable action id when the platform supplies it. */
  actionId?: string;
  /** Zero-based index used by Electron/macOS notification action callbacks. */
  actionIndex?: number;
}

export interface NotificationShowOptions {
  silent: boolean;
  onInteraction(event: NotificationInteraction): Promise<void> | void;
}

/** Adapter boundary implemented with Electron Notification + app APIs. */
export interface NotificationPlatformAdapter {
  getPermissionStatus():
    | NotificationPermissionStatus
    | Promise<NotificationPermissionStatus>;
  requestPermission?():
    | NotificationPermissionStatus
    | Promise<NotificationPermissionStatus>;
  show(
    delivery: ReminderDelivery,
    options: NotificationShowOptions,
  ): Promise<void> | void;
  cancel(id: string): Promise<void> | void;
  setBadgeCount(count: number): Promise<void> | void;
}

export type InAppNotificationEvent =
  | {
      type: 'delivery';
      delivery: ReminderDelivery;
      reason:
        | 'unsupported'
        | 'permission-denied'
        | 'permission-not-determined'
        | 'banners-disabled'
        | 'platform-error';
    }
  | { type: 'cancel'; reminderId: string };

export interface InAppNotificationSink {
  emit(event: InAppNotificationEvent): Promise<void> | void;
}

export interface NotificationTimerAdapter {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface NotificationClock {
  now(): Date;
}

export interface NotificationActionContext {
  delivery?: ReminderDelivery;
}

export interface NotificationActionHandler {
  handle(
    event: ReminderActionEvent,
    context: NotificationActionContext,
  ): Promise<void> | void;
}

export type NotificationRefreshTrigger =
  | 'application-start'
  | 'system-wake'
  | 'task-change'
  | 'settings-change'
  | 'timer'
  | 'manual';

export interface NotificationControllerRunResult {
  trigger: NotificationRefreshTrigger;
  candidateCount: number;
  deliveryCount: number;
  badgeCount: number;
  deliveries: ReminderDelivery[];
}

export interface NotificationControllerOptions {
  taskSource: ReminderTaskSource;
  settingsSource: ReminderSettingsSource;
  runtimeStore: ReminderStateStore;
  platform: NotificationPlatformAdapter;
  inApp: InAppNotificationSink;
  actions: NotificationActionHandler;
  timeZone: () => string;
  clock?: NotificationClock;
  timers?: NotificationTimerAdapter;
  intervalMs?: number;
  missedLookbackMs?: number;
  includeDueCandidates?: boolean;
  onError?: (error: unknown, operation: string) => void;
}

export class NotificationControllerStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationControllerStateError';
  }
}

const ACTIONS: readonly ReminderAction[] = [
  'complete',
  'snooze-10m',
  'snooze-1h',
  'tomorrow',
  'open',
  'dismiss',
  'snooze-until',
];

const clone = <Value>(value: Value): Value => structuredClone(value);

export const mapNotificationInteraction = (
  delivery: ReminderDelivery,
  interaction: NotificationInteraction,
): ReminderActionEvent | undefined => {
  // A closed task banner is an explicit “ignored” signal for the gentle
  // backoff rule. Important non-task notices (sync risk, approvals and the
  // morning brief) are never silently counted as ignored task work.
  if (interaction.type === 'close') {
    return delivery.kind === 'task'
      ? { reminderId: delivery.id, action: 'dismiss' }
      : undefined;
  }
  if (interaction.type === 'click') {
    return delivery.actions.some(({ id }) => id === 'open')
      ? { reminderId: delivery.id, action: 'open' }
      : undefined;
  }

  let action = interaction.actionId;
  if (
    action === undefined &&
    Number.isSafeInteger(interaction.actionIndex) &&
    interaction.actionIndex !== undefined &&
    interaction.actionIndex >= 0
  ) {
    action = delivery.actions[interaction.actionIndex]?.id;
  }
  if (
    action === undefined ||
    !ACTIONS.includes(action as ReminderAction) ||
    action === 'snooze-until' ||
    !delivery.actions.some(({ id }) => id === action)
  ) {
    return undefined;
  }
  return {
    reminderId: delivery.id,
    action: action as ReminderPresetAction,
  };
};

const DEFAULT_TIMERS: NotificationTimerAdapter = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const DEFAULT_CLOCK: NotificationClock = { now: () => new Date() };

export class NotificationController {
  readonly #settingsSource: ReminderSettingsSource;
  readonly #platform: NotificationPlatformAdapter;
  readonly #inApp: InAppNotificationSink;
  readonly #actions: NotificationActionHandler;
  readonly #clock: NotificationClock;
  readonly #timers: NotificationTimerAdapter;
  readonly #intervalMs: number;
  readonly #onError?: NotificationControllerOptions['onError'];
  readonly #projector: ReminderProjector;
  readonly #scheduler: ReminderScheduler;

  #settings: NotificationSettings = clone(defaultSettings.notifications);
  #candidates: ReminderCandidate[] = [];
  #deliveries = new Map<string, ReminderDelivery>();
  #queue: Promise<void> = Promise.resolve();
  #started = false;
  #stopping = false;
  #timerActive = false;
  #timerHandle: unknown;
  #generation = 0;
  #lastResult?: NotificationControllerRunResult;

  constructor(options: NotificationControllerOptions) {
    this.#settingsSource = options.settingsSource;
    this.#platform = options.platform;
    this.#inApp = options.inApp;
    this.#actions = options.actions;
    this.#clock = options.clock ?? DEFAULT_CLOCK;
    this.#timers = options.timers ?? DEFAULT_TIMERS;
    this.#intervalMs = options.intervalMs ?? 30_000;
    this.#onError = options.onError;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1) {
      throw new TypeError('Notification intervalMs must be a positive safe integer.');
    }

    const startedAt = this.#clock.now();
    this.#projector = new ReminderProjector({
      taskSource: options.taskSource,
      settingsSource: {
        getNotificationSettings: () => clone(this.#settings),
      },
      timeZone: options.timeZone,
      now: () => this.#clock.now(),
      startedAt,
      missedLookbackMs: options.missedLookbackMs,
      includeDueCandidates: options.includeDueCandidates,
    });
    this.#scheduler = new ReminderScheduler({
      stateStore: options.runtimeStore,
      sink: {
        show: (delivery) => this.#showDelivery(delivery),
        cancel: (id) => this.#cancelDelivery(id),
      },
      settings: () => clone(this.#settings),
      onAction: (event) => this.#actions.handle(event, {
        delivery: this.#deliveries.get(event.reminderId),
      }),
      now: () => this.#clock.now(),
    });
  }

  get isStarted(): boolean {
    return this.#started && !this.#stopping;
  }

  async start(): Promise<NotificationControllerRunResult> {
    return this.#enqueue(async () => {
      if (this.#started && !this.#stopping) {
        return {
          trigger: 'application-start',
          candidateCount: this.#candidates.length,
          deliveryCount: 0,
          badgeCount: this.#lastResult?.badgeCount ?? 0,
          deliveries: [],
        };
      }
      this.#stopping = false;
      await this.#scheduler.load();
      this.#started = true;
      try {
        const result = await this.#runUnlocked('application-start');
        this.#startTimer();
        return result;
      } catch (error) {
        this.#started = false;
        this.#clearTimer();
        throw error;
      }
    });
  }

  /** Refreshes candidates and immediately evaluates newly due work. */
  async refresh(
    trigger: NotificationRefreshTrigger = 'manual',
  ): Promise<NotificationControllerRunResult> {
    return this.#enqueue(async () => {
      this.#requireStarted();
      return this.#runUnlocked(trigger);
    });
  }

  /** Timer entrypoint; projection is refreshed so tomorrow's brief is created. */
  async tick(): Promise<NotificationControllerRunResult> {
    return this.#enqueue(async () => {
      this.#requireStarted();
      return this.#runUnlocked('timer');
    });
  }

  async handleAction(event: ReminderActionEvent): Promise<void> {
    await this.#enqueue(async () => {
      this.#requireStarted();
      const validatedEvent = this.#validateAction(event);
      await this.#scheduler.handleAction(validatedEvent);
      // Completion and other task mutations may have changed projection. Do
      // not tick here: snooze/open actions must never cause an unrelated popup.
      await this.#refreshCandidatesUnlocked();
      await this.#updateBadgeUnlocked();
    });
  }

  /** Typed convenience entrypoint used by the isolated renderer bridge. */
  snoozeUntil(reminderId: string, snoozeUntil: string): Promise<void> {
    return this.handleAction({
      reminderId,
      action: 'snooze-until',
      snoozeUntil,
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#enqueue(async () => {
      this.#generation += 1;
      this.#clearTimer();
      if (this.#started) await this.#scheduler.replaceCandidates([]);
      this.#candidates = [];
      this.#deliveries.clear();
      await this.#setBadgeSafely(0);
      this.#started = false;
      this.#stopping = false;
      this.#lastResult = undefined;
    });
  }

  async #runUnlocked(
    trigger: NotificationRefreshTrigger,
  ): Promise<NotificationControllerRunResult> {
    await this.#refreshCandidatesUnlocked();
    const deliveries = await this.#scheduler.tick();
    const badgeCount = await this.#updateBadgeUnlocked();
    const result: NotificationControllerRunResult = {
      trigger,
      candidateCount: this.#candidates.length,
      deliveryCount: deliveries.length,
      badgeCount,
      deliveries: clone(deliveries),
    };
    this.#lastResult = result;
    return clone(result);
  }

  async #refreshCandidatesUnlocked(): Promise<void> {
    this.#settings = clone(await this.#settingsSource.getNotificationSettings());
    const candidates = await this.#projector.project();
    await this.#scheduler.replaceCandidates(candidates);
    this.#candidates = clone(candidates);
  }

  async #showDelivery(delivery: ReminderDelivery): Promise<void> {
    const safeDelivery = clone(delivery);
    this.#deliveries.set(delivery.id, safeDelivery);
    if (!this.#settings.banners) {
      await this.#inApp.emit({
        type: 'delivery',
        delivery: safeDelivery,
        reason: 'banners-disabled',
      });
      return;
    }

    let permission: NotificationPermissionStatus;
    try {
      permission = await this.#platform.getPermissionStatus();
      if (permission === 'not-determined' && this.#platform.requestPermission !== undefined) {
        permission = await this.#platform.requestPermission();
      }
    } catch (error) {
      this.#reportError(error, 'notification-permission');
      await this.#inApp.emit({
        type: 'delivery',
        delivery: safeDelivery,
        reason: 'platform-error',
      });
      return;
    }

    if (permission !== 'granted') {
      const reason = permission === 'unsupported'
        ? 'unsupported'
        : permission === 'denied'
          ? 'permission-denied'
          : 'permission-not-determined';
      await this.#inApp.emit({ type: 'delivery', delivery: safeDelivery, reason });
      return;
    }

    try {
      await this.#platform.show(safeDelivery, {
        silent: !this.#settings.sound,
        onInteraction: async (interaction) => {
          const action = mapNotificationInteraction(safeDelivery, interaction);
          if (action === undefined) return;
          try {
            await this.handleAction(action);
          } catch (error) {
            this.#reportError(error, 'notification-action');
          }
        },
      });
    } catch (error) {
      this.#reportError(error, 'notification-show');
      await this.#inApp.emit({
        type: 'delivery',
        delivery: safeDelivery,
        reason: 'platform-error',
      });
    }
  }

  async #cancelDelivery(id: string): Promise<void> {
    this.#deliveries.delete(id);
    const results = await Promise.allSettled([
      Promise.resolve(this.#platform.cancel(id)),
      Promise.resolve(this.#inApp.emit({ type: 'cancel', reminderId: id })),
    ]);
    results.forEach((result) => {
      if (result.status === 'rejected') this.#reportError(result.reason, 'notification-cancel');
    });
  }

  async #updateBadgeUnlocked(): Promise<number> {
    if (!this.#settings.enabled || !this.#settings.badge) {
      await this.#setBadgeSafely(0);
      return 0;
    }
    const now = this.#clock.now().getTime();
    const taskIds = new Set(
      this.#candidates
        .filter((candidate) =>
          candidate.kind === 'task' &&
          candidate.taskId !== undefined &&
          !Number.isNaN(Date.parse(candidate.scheduledAt)) &&
          Date.parse(candidate.scheduledAt) <= now,
        )
        .map((candidate) => candidate.taskId!),
    );
    await this.#setBadgeSafely(taskIds.size);
    return taskIds.size;
  }

  async #setBadgeSafely(count: number): Promise<void> {
    try {
      await this.#platform.setBadgeCount(count);
    } catch (error) {
      this.#reportError(error, 'notification-badge');
    }
  }

  #startTimer(): void {
    if (this.#timerActive) return;
    const generation = ++this.#generation;
    this.#timerHandle = this.#timers.setInterval(() => {
      if (!this.#started || this.#stopping || generation !== this.#generation) return;
      void this.tick().catch((error) => this.#reportError(error, 'notification-timer'));
    }, this.#intervalMs);
    this.#timerActive = true;
  }

  #clearTimer(): void {
    if (!this.#timerActive) return;
    this.#timers.clearInterval(this.#timerHandle);
    this.#timerHandle = undefined;
    this.#timerActive = false;
  }

  #validateAction(event: ReminderActionEvent): ReminderActionEvent {
    if (
      typeof event.reminderId !== 'string' ||
      event.reminderId.length === 0 ||
      event.reminderId.length > 512 ||
      !ACTIONS.includes(event.action as ReminderAction)
    ) {
      throw new NotificationControllerStateError('Invalid reminder action event.');
    }
    if (event.action !== 'snooze-until') return clone(event);
    if (!this.#candidates.some(({ id }) => id === event.reminderId)) {
      throw new NotificationControllerStateError('Cannot snooze an unknown reminder.');
    }
    try {
      return {
        reminderId: event.reminderId,
        action: 'snooze-until',
        snoozeUntil: normalizeCustomSnoozeUntil(
          event.snoozeUntil,
          this.#clock.now(),
        ),
      };
    } catch (error) {
      throw new NotificationControllerStateError(
        error instanceof Error ? error.message : 'Invalid custom snooze time.',
      );
    }
  }

  #requireStarted(): void {
    if (!this.#started || this.#stopping) {
      throw new NotificationControllerStateError('Notification controller is not running.');
    }
  }

  #reportError(error: unknown, operation: string): void {
    try {
      this.#onError?.(error, operation);
    } catch {
      // Error reporting must not break notification delivery or cleanup.
    }
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
