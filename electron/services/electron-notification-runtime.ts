import path from 'node:path';

import type { NotificationConstructorOptions } from 'electron';

import type { ReminderActionEvent, ReminderDelivery } from '../../src/shared/reminders';
import type { NotificationSettings } from '../../src/shared/settings';
import {
  NotificationController,
  type InAppNotificationEvent,
  type NotificationActionContext,
  type NotificationActionHandler,
  type NotificationClock,
  type NotificationControllerRunResult,
  type NotificationInteraction,
  type NotificationPlatformAdapter,
  type NotificationRefreshTrigger,
  type NotificationShowOptions,
  type NotificationTimerAdapter,
} from './notification-controller';
import type {
  ReminderSettingsSource,
  ReminderTaskSource,
} from './reminder-projector';
import { ReminderRuntimeStore } from './reminder-runtime-store';
import type { ReminderStateStore } from './reminder-service';
import type { SettingsService } from './settings-service';
import type { TaskService } from './task-service';

const clone = <Value>(value: Value): Value => structuredClone(value);

/** Minimal native notification handle used to keep the production layer testable. */
export interface ElectronNativeNotification {
  show(): void;
  close(): void;
  onShown(listener: () => void): void;
  onClick(listener: () => void): void;
  onAction(listener: (actionIndex: number) => void): void;
  onClosed(listener: () => void): void;
  onFailed(listener: (message: string) => void): void;
}

/**
 * Electron APIs used by this runtime. The default implementation is loaded
 * from Electron; tests can inject this boundary without displaying a toast.
 */
export interface ElectronNotificationBindings {
  platform: NodeJS.Platform;
  isNotificationSupported(): boolean;
  createNotification(
    options: NotificationConstructorOptions,
  ): ElectronNativeNotification;
  removeDeliveredNotification?(id: string): void;
  setDockBadge?(text: string): void;
}

export type ElectronNotificationRuntimeErrorHandler = (
  error: unknown,
  operation: string,
) => void;

type SupplementalActionHandler = (
  event: ReminderActionEvent,
) => Promise<void> | void;

function reportSafely(
  handler: ElectronNotificationRuntimeErrorHandler | undefined,
  error: unknown,
  operation: string,
): void {
  try {
    handler?.(error, operation);
  } catch {
    // Diagnostics must never interrupt reminder delivery.
  }
}

/** Adds the longer snooze choice exposed by desktop notification surfaces. */
export function withDesktopNotificationActions(
  delivery: ReminderDelivery,
): ReminderDelivery {
  const result = clone(delivery);
  if (
    result.kind === 'task' &&
    !result.actions.some(({ id }) => id === 'tomorrow')
  ) {
    const openIndex = result.actions.findIndex(({ id }) => id === 'open');
    result.actions.splice(openIndex < 0 ? result.actions.length : openIndex, 0, {
      id: 'tomorrow',
      label: '明天提醒',
    });
  }
  return result;
}

/** Native Electron implementation of NotificationController's platform port. */
export class ElectronNotificationPlatformAdapter
implements NotificationPlatformAdapter {
  readonly #bindings: ElectronNotificationBindings;
  readonly #onError?: ElectronNotificationRuntimeErrorHandler;
  readonly #onSupplementalAction?: SupplementalActionHandler;
  readonly #active = new Map<string, ElectronNativeNotification>();

  constructor(
    bindings: ElectronNotificationBindings,
    onError?: ElectronNotificationRuntimeErrorHandler,
    onSupplementalAction?: SupplementalActionHandler,
  ) {
    this.#bindings = bindings;
    this.#onError = onError;
    this.#onSupplementalAction = onSupplementalAction;
  }

  getPermissionStatus(): 'granted' | 'unsupported' {
    // Electron's main-process Notification API has no portable permission
    // request method. A native show failure is caught and routed in-app.
    return this.#bindings.isNotificationSupported()
      ? 'granted'
      : 'unsupported';
  }

  async show(
    delivery: ReminderDelivery,
    options: NotificationShowOptions,
  ): Promise<void> {
    await this.cancel(delivery.id);
    const desktopDelivery = withDesktopNotificationActions(delivery);

    const nativeNotification = this.#bindings.createNotification({
      id: desktopDelivery.id,
      groupId: 'todo-agent-reminders',
      groupTitle: 'Todo Agent',
      title: desktopDelivery.title,
      body: desktopDelivery.body,
      silent: options.silent,
      timeoutType: 'default',
      closeButtonText: '关闭',
      actions: desktopDelivery.actions.map(({ label }) => ({
        type: 'button' as const,
        text: label,
      })),
    });
    this.#active.set(delivery.id, nativeNotification);

    const dispatch = (interaction: NotificationInteraction): void => {
      void Promise.resolve()
        .then(() => options.onInteraction(interaction))
        .catch((error) => {
          reportSafely(this.#onError, error, 'electron-notification-interaction');
        });
    };
    nativeNotification.onClick(() => dispatch({ type: 'click' }));
    nativeNotification.onAction((actionIndex) => {
      const actionId = desktopDelivery.actions[actionIndex]?.id;
      if (actionId === undefined) {
        dispatch({ type: 'action', actionIndex });
        return;
      }
      if (delivery.actions.some(({ id }) => id === actionId)) {
        dispatch({ type: 'action', actionId });
        return;
      }
      void Promise.resolve()
        .then(() => this.#onSupplementalAction?.({
          reminderId: delivery.id,
          action: actionId,
        }))
        .catch((error) => {
          reportSafely(this.#onError, error, 'electron-notification-interaction');
        });
    });
    nativeNotification.onClosed(() => {
      if (this.#active.get(delivery.id) === nativeNotification) {
        this.#active.delete(delivery.id);
      }
      dispatch({ type: 'close' });
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      nativeNotification.onShown(() => {
        if (settled) return;
        settled = true;
        resolve();
      });
      nativeNotification.onFailed((message) => {
        if (this.#active.get(delivery.id) === nativeNotification) {
          this.#active.delete(delivery.id);
        }
        const error = new Error(
          message || `Unable to show notification ${delivery.id}.`,
        );
        if (!settled) {
          settled = true;
          reject(error);
          return;
        }
        reportSafely(this.#onError, error, 'electron-notification-failed');
      });
      try {
        nativeNotification.show();
      } catch (error) {
        if (this.#active.get(delivery.id) === nativeNotification) {
          this.#active.delete(delivery.id);
        }
        settled = true;
        reject(error);
      }
    });
  }

  cancel(id: string): void {
    const notification = this.#active.get(id);
    this.#active.delete(id);
    let firstError: unknown;
    try {
      notification?.close();
    } catch (error) {
      firstError = error;
    }
    try {
      this.#bindings.removeDeliveredNotification?.(id);
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  }

  setBadgeCount(count: number): void {
    if (this.#bindings.platform !== 'darwin') return;
    this.#bindings.setDockBadge?.(count > 0 ? String(count) : '');
  }
}

/** Production task projection source backed by TaskService. */
export class TaskServiceReminderTaskSource implements ReminderTaskSource {
  constructor(private readonly taskService: TaskService) {}

  listTasksForReminders() {
    return this.taskService.listTasks();
  }
}

/** Production notification settings source backed by SettingsService. */
export class SettingsServiceReminderSettingsSource
implements ReminderSettingsSource {
  constructor(private readonly settingsService: SettingsService) {}

  getNotificationSettings(): NotificationSettings {
    return this.settingsService.get().notifications;
  }
}

export interface NotificationOpenRequest {
  reminderId: string;
  taskId?: string;
  delivery?: ReminderDelivery;
}

export interface TaskNotificationActionHandlerOptions {
  taskService: TaskService;
  onOpen(request: NotificationOpenRequest): Promise<void> | void;
  onTasksChanged?(): Promise<void> | void;
}

/**
 * Applies task mutations for reminder actions. Snooze, tomorrow and dismiss
 * are already persisted by ReminderScheduler before this handler is invoked.
 */
export class TaskNotificationActionHandler
implements NotificationActionHandler {
  readonly #taskService: TaskService;
  readonly #onOpen: TaskNotificationActionHandlerOptions['onOpen'];
  readonly #onTasksChanged?: TaskNotificationActionHandlerOptions['onTasksChanged'];

  constructor(options: TaskNotificationActionHandlerOptions) {
    this.#taskService = options.taskService;
    this.#onOpen = options.onOpen;
    this.#onTasksChanged = options.onTasksChanged;
  }

  async handle(
    event: ReminderActionEvent,
    context: NotificationActionContext,
  ): Promise<void> {
    if (event.action === 'open') {
      await this.#onOpen({
        reminderId: event.reminderId,
        taskId: context.delivery?.taskId,
        delivery: context.delivery === undefined
          ? undefined
          : clone(context.delivery),
      });
      return;
    }

    if (event.action !== 'complete' || context.delivery?.taskId === undefined) {
      return;
    }

    const task = await this.#taskService.getTask(context.delivery.taskId);
    // Native notifications can outlive their task; stale/repeated actions are
    // intentionally idempotent.
    if (task === undefined || task.status === 'completed') return;
    await this.#taskService.completeTask(task.id);
    await this.#onTasksChanged?.();
  }
}

export interface ElectronNotificationRuntimeOptions {
  userDataPath: string;
  taskService: TaskService;
  settingsService: SettingsService;
  onInAppNotification(
    event: InAppNotificationEvent,
  ): Promise<void> | void;
  onOpen(request: NotificationOpenRequest): Promise<void> | void;
  onTasksChanged?(): Promise<void> | void;
  timeZone?: () => string;
  runtimeStore?: ReminderStateStore;
  clock?: NotificationClock;
  timers?: NotificationTimerAdapter;
  intervalMs?: number;
  missedLookbackMs?: number;
  includeDueCandidates?: boolean;
  onError?: ElectronNotificationRuntimeErrorHandler;
}

/** Main-process lifecycle facade intended for startApplication wiring. */
export class ElectronNotificationRuntime {
  constructor(private readonly controller: NotificationController) {}

  get isStarted(): boolean {
    return this.controller.isStarted;
  }

  start(): Promise<NotificationControllerRunResult> {
    return this.controller.start();
  }

  refresh(
    trigger: NotificationRefreshTrigger = 'manual',
  ): Promise<NotificationControllerRunResult> {
    return this.controller.refresh(trigger);
  }

  handleAction(event: ReminderActionEvent): Promise<void> {
    return this.controller.handleAction(event);
  }

  snoozeUntil(reminderId: string, snoozeUntil: string): Promise<void> {
    return this.controller.snoozeUntil(reminderId, snoozeUntil);
  }

  stop(): Promise<void> {
    return this.controller.stop();
  }
}

/** Synchronous assembly seam used by tests and alternative Electron hosts. */
export function createElectronNotificationRuntimeWithBindings(
  options: ElectronNotificationRuntimeOptions,
  bindings: ElectronNotificationBindings,
): ElectronNotificationRuntime {
  let controller: NotificationController | undefined;
  const platform = new ElectronNotificationPlatformAdapter(
    bindings,
    options.onError,
    (event) => controller?.handleAction(event),
  );
  const runtimeStore = options.runtimeStore ?? new ReminderRuntimeStore({
    directory: path.join(options.userDataPath, 'reminders'),
  });
  const actionHandler = new TaskNotificationActionHandler({
    taskService: options.taskService,
    onOpen: options.onOpen,
    onTasksChanged: options.onTasksChanged,
  });
  controller = new NotificationController({
    taskSource: new TaskServiceReminderTaskSource(options.taskService),
    settingsSource: new SettingsServiceReminderSettingsSource(
      options.settingsService,
    ),
    runtimeStore,
    platform,
    inApp: {
      emit: async (event) => {
        try {
          await options.onInAppNotification(
            event.type === 'delivery'
              ? {
                  ...clone(event),
                  delivery: withDesktopNotificationActions(event.delivery),
                }
              : clone(event),
          );
        } catch (error) {
          reportSafely(options.onError, error, 'in-app-notification');
        }
      },
    },
    actions: actionHandler,
    timeZone: options.timeZone ?? (
      () => Intl.DateTimeFormat().resolvedOptions().timeZone
    ),
    clock: options.clock,
    timers: options.timers,
    intervalMs: options.intervalMs,
    missedLookbackMs: options.missedLookbackMs,
    includeDueCandidates: options.includeDueCandidates,
    onError: options.onError,
  });
  return new ElectronNotificationRuntime(controller);
}

async function loadElectronNotificationBindings(): Promise<ElectronNotificationBindings> {
  const electron = await import('electron');
  return {
    platform: process.platform,
    isNotificationSupported: () => electron.Notification.isSupported(),
    createNotification: (options) => {
      const notification = new electron.Notification(options);
      return {
        show: () => notification.show(),
        close: () => notification.close(),
        onShown: (listener) => {
          notification.on('show', () => listener());
        },
        onClick: (listener) => {
          notification.on('click', () => listener());
        },
        onAction: (listener) => {
          notification.on('action', (details, legacyActionIndex) => {
            listener(
              Number.isSafeInteger(details.actionIndex)
                ? details.actionIndex
                : legacyActionIndex,
            );
          });
        },
        onClosed: (listener) => {
          notification.on('close', () => listener());
        },
        onFailed: (listener) => {
          notification.on('failed', (_event, error) => listener(error));
        },
      };
    },
    removeDeliveredNotification: process.platform === 'darwin'
      ? (id) => electron.Notification.remove(id)
      : undefined,
    setDockBadge: process.platform === 'darwin'
      ? (text) => electron.app.dock?.setBadge(text)
      : undefined,
  };
}

/**
 * Production factory. Call after `app.whenReady()` so Notification and dock
 * APIs are available.
 */
export async function createElectronNotificationRuntime(
  options: ElectronNotificationRuntimeOptions,
): Promise<ElectronNotificationRuntime> {
  return createElectronNotificationRuntimeWithBindings(
    options,
    await loadElectronNotificationBindings(),
  );
}
