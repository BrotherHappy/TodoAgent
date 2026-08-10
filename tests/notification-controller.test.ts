// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  NotificationController,
  NotificationControllerStateError,
  mapNotificationInteraction,
  type InAppNotificationEvent,
  type NotificationPermissionStatus,
  type NotificationPlatformAdapter,
  type NotificationShowOptions,
  type NotificationTimerAdapter,
} from '../electron/services/notification-controller';
import type { Task } from '../src/shared/models';
import {
  emptyReminderRuntimeState,
  type ReminderDelivery,
  type ReminderRuntimeState,
} from '../src/shared/reminders';
import { defaultSettings, type NotificationSettings } from '../src/shared/settings';

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  source: { type: 'local' },
  title: '提交周报',
  notes: '',
  privateNotes: '',
  status: 'open',
  priority: 'high',
  tags: [],
  dependencyIds: [],
  assigneeIds: [],
  followerIds: [],
  attachments: [],
  links: [],
  customFields: {},
  reminders: [],
  focusElapsedSeconds: 0,
  privateOrder: 0,
  sync: { status: 'local' },
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

class FakeTimers implements NotificationTimerAdapter {
  readonly callbacks = new Map<number, () => void>();
  readonly setInterval = vi.fn((callback: () => void, _milliseconds: number): unknown => {
    const id = this.callbacks.size + 1;
    this.callbacks.set(id, callback);
    return id;
  });
  readonly clearInterval = vi.fn((handle: unknown): void => {
    this.callbacks.delete(Number(handle));
  });
}

interface ShownNotification {
  delivery: ReminderDelivery;
  options: NotificationShowOptions;
}

const createHarness = (options: {
  permission?: NotificationPermissionStatus;
  showError?: Error;
  initialTasks?: Task[];
  settings?: Partial<NotificationSettings>;
} = {}) => {
  let now = new Date('2026-08-09T09:00:00.000Z');
  let tasks = options.initialTasks ?? [];
  let settings: NotificationSettings = {
    ...defaultSettings.notifications,
    morningBrief: false,
    quietHoursEnabled: false,
    ...options.settings,
  };
  let runtimeState: ReminderRuntimeState = emptyReminderRuntimeState();
  let permission = options.permission ?? 'granted';
  const shown: ShownNotification[] = [];
  const cancelled: string[] = [];
  const badges: number[] = [];
  const inAppEvents: InAppNotificationEvent[] = [];
  const actionEvents: Array<{
    reminderId: string;
    action: string;
    taskId?: string;
  }> = [];
  const errors: Array<{ error: unknown; operation: string }> = [];
  const timers = new FakeTimers();
  const loadRuntime = vi.fn(async () => structuredClone(runtimeState));
  const saveRuntime = vi.fn(async (state: ReminderRuntimeState) => {
    runtimeState = structuredClone(state);
  });
  const platform: NotificationPlatformAdapter = {
    getPermissionStatus: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => permission),
    show: vi.fn(async (delivery, showOptions) => {
      if (options.showError !== undefined) throw options.showError;
      shown.push({ delivery: structuredClone(delivery), options: showOptions });
    }),
    cancel: vi.fn(async (id) => { cancelled.push(id); }),
    setBadgeCount: vi.fn(async (count) => { badges.push(count); }),
  };
  const controller = new NotificationController({
    taskSource: {
      listTasksForReminders: async () => structuredClone(tasks),
    },
    settingsSource: {
      getNotificationSettings: async () => structuredClone(settings),
    },
    runtimeStore: { load: loadRuntime, save: saveRuntime },
    platform,
    inApp: {
      emit: async (event) => { inAppEvents.push(structuredClone(event)); },
    },
    actions: {
      handle: async (event, context) => {
        actionEvents.push({
          ...event,
          taskId: context.delivery?.taskId,
        });
        if (event.action === 'complete' && context.delivery?.taskId !== undefined) {
          tasks = tasks.map((task) =>
            task.id === context.delivery?.taskId
              ? {
                  ...task,
                  status: 'completed',
                  completedAt: now.toISOString(),
                }
              : task,
          );
        }
      },
    },
    timeZone: () => 'UTC',
    clock: { now: () => new Date(now) },
    timers,
    intervalMs: 1_000,
    onError: (error, operation) => { errors.push({ error, operation }); },
  });

  return {
    controller,
    timers,
    platform,
    shown,
    cancelled,
    badges,
    inAppEvents,
    actionEvents,
    errors,
    loadRuntime,
    saveRuntime,
    runtimeState: () => runtimeState,
    setNow: (value: string) => { now = new Date(value); },
    setTasks: (value: Task[]) => { tasks = value; },
    setSettings: (value: Partial<NotificationSettings>) => {
      settings = { ...settings, ...value };
    },
    setPermission: (value: NotificationPermissionStatus) => { permission = value; },
  };
};

describe('mapNotificationInteraction', () => {
  const delivery: ReminderDelivery = {
    id: 'reminder-1',
    taskId: 'task-1',
    kind: 'task',
    title: '任务',
    body: '到期',
    actions: [
      { id: 'complete', label: '完成' },
      { id: 'snooze-10m', label: '稍后' },
      { id: 'open', label: '打开' },
    ],
  };

  it('maps Electron click, action id, and action index without guessing unknown actions', () => {
    expect(mapNotificationInteraction(delivery, { type: 'click' })).toEqual({
      reminderId: 'reminder-1',
      action: 'open',
    });
    expect(mapNotificationInteraction(delivery, {
      type: 'action',
      actionId: 'snooze-10m',
    })).toEqual({ reminderId: 'reminder-1', action: 'snooze-10m' });
    expect(mapNotificationInteraction(delivery, {
      type: 'action',
      actionIndex: 0,
    })).toEqual({ reminderId: 'reminder-1', action: 'complete' });
    expect(mapNotificationInteraction(delivery, {
      type: 'action',
      actionId: 'delete-everything',
    })).toBeUndefined();
    expect(mapNotificationInteraction(delivery, { type: 'close' })).toBeUndefined();
  });
});

describe('NotificationController lifecycle', () => {
  it('starts once, delivers once, maintains badge count, and cleans up once', async () => {
    const due = makeTask({
      dueAt: '2026-08-09T09:00:00.000Z',
    });
    const harness = createHarness({ initialTasks: [due] });

    const [first, second] = await Promise.all([
      harness.controller.start(),
      harness.controller.start(),
    ]);

    expect(first.deliveryCount).toBe(1);
    expect(second.deliveryCount).toBe(0);
    expect(harness.shown).toHaveLength(1);
    expect(harness.badges.at(-1)).toBe(1);
    expect(harness.loadRuntime).toHaveBeenCalledOnce();
    expect(harness.timers.setInterval).toHaveBeenCalledOnce();
    expect(harness.controller.isStarted).toBe(true);

    await harness.controller.tick();
    expect(harness.shown).toHaveLength(1);

    await harness.controller.stop();
    await harness.controller.stop();
    expect(harness.timers.clearInterval).toHaveBeenCalledOnce();
    expect(harness.cancelled).toContain('task:task-1:due');
    expect(harness.badges.at(-1)).toBe(0);
    expect(harness.controller.isStarted).toBe(false);
    await expect(harness.controller.tick()).rejects.toBeInstanceOf(
      NotificationControllerStateError,
    );
  });

  it('refreshes immediately for system wake and task-change events', async () => {
    const harness = createHarness();
    await harness.controller.start();
    harness.setNow('2026-08-09T10:00:00.000Z');
    harness.setTasks([
      makeTask({
        reminders: [{
          id: 'missed-on-sleep',
          at: '2026-08-09T09:30:00.000Z',
          enabled: true,
          source: 'local',
        }],
      }),
    ]);

    const wake = await harness.controller.refresh('system-wake');
    expect(wake.deliveryCount).toBe(1);
    expect(harness.shown[0]?.delivery.id).toBe('task:task-1:reminder:missed-on-sleep');

    harness.setTasks([
      ...[makeTask({
        reminders: [{
          id: 'missed-on-sleep',
          at: '2026-08-09T09:30:00.000Z',
          enabled: true,
          source: 'local',
        }],
      })],
      makeTask({ id: 'task-2', dueAt: '2026-08-09T10:00:00.000Z' }),
    ]);
    const taskChange = await harness.controller.refresh('task-change');
    expect(taskChange.deliveryCount).toBe(1);
    expect(harness.shown.at(-1)?.delivery.id).toBe('task:task-2:due');
  });
});

describe('NotificationController delivery and actions', () => {
  it('falls back to an in-app event when system notifications are unsupported', async () => {
    const harness = createHarness({
      permission: 'unsupported',
      initialTasks: [makeTask({ dueAt: '2026-08-09T09:00:00.000Z' })],
    });

    const result = await harness.controller.start();

    expect(result.deliveryCount).toBe(1);
    expect(harness.shown).toHaveLength(0);
    expect(harness.inAppEvents).toContainEqual(expect.objectContaining({
      type: 'delivery',
      reason: 'unsupported',
    }));
    expect(Object.keys(harness.runtimeState().delivered)).toHaveLength(1);
  });

  it('requests undecided permission and falls back when permission is denied', async () => {
    const harness = createHarness({
      permission: 'not-determined',
      initialTasks: [makeTask({ dueAt: '2026-08-09T09:00:00.000Z' })],
    });
    const requestPermission = harness.platform.requestPermission!;
    vi.mocked(requestPermission).mockImplementation(
      async (): Promise<NotificationPermissionStatus> => 'denied',
    );

    await harness.controller.start();

    expect(requestPermission).toHaveBeenCalledOnce();
    expect(harness.inAppEvents).toContainEqual(expect.objectContaining({
      type: 'delivery',
      reason: 'permission-denied',
    }));
  });

  it('maps platform actions, runs the injected task action, refreshes, and clears badge', async () => {
    const harness = createHarness({
      initialTasks: [makeTask({ dueAt: '2026-08-09T09:00:00.000Z' })],
      settings: { sound: false },
    });
    await harness.controller.start();
    expect(harness.shown[0]?.options.silent).toBe(true);

    await harness.shown[0]!.options.onInteraction({
      type: 'action',
      actionIndex: 0,
    });

    expect(harness.actionEvents).toEqual([{
      reminderId: 'task:task-1:due',
      action: 'complete',
      taskId: 'task-1',
    }]);
    expect(harness.cancelled).toContain('task:task-1:due');
    expect(harness.badges.at(-1)).toBe(0);
  });

  it('serializes custom snooze updates, normalizes the timestamp, and redelivers once', async () => {
    const harness = createHarness({
      initialTasks: [makeTask({ dueAt: '2026-08-09T09:00:00.000Z' })],
    });
    await harness.controller.start();

    await Promise.all([
      harness.controller.snoozeUntil(
        'task:task-1:due',
        '2026-08-09T17:10:00.000+08:00',
      ),
      harness.controller.snoozeUntil(
        'task:task-1:due',
        '2026-08-09T17:20:00.000+08:00',
      ),
    ]);

    expect(harness.runtimeState().snoozedUntil).toEqual({
      'task:task-1:due': '2026-08-09T09:20:00.000Z',
    });
    expect(Object.keys(harness.runtimeState().delivered)).toHaveLength(0);
    expect(harness.actionEvents.slice(-2)).toEqual([
      {
        reminderId: 'task:task-1:due',
        action: 'snooze-until',
        snoozeUntil: '2026-08-09T09:10:00.000Z',
        taskId: 'task-1',
      },
      {
        reminderId: 'task:task-1:due',
        action: 'snooze-until',
        snoozeUntil: '2026-08-09T09:20:00.000Z',
        taskId: 'task-1',
      },
    ]);

    harness.setNow('2026-08-09T09:19:59.999Z');
    await harness.controller.tick();
    expect(harness.shown).toHaveLength(1);
    harness.setNow('2026-08-09T09:20:00.000Z');
    await harness.controller.tick();
    await harness.controller.tick();
    expect(harness.shown).toHaveLength(2);
  });

  it.each([
    ['unknown reminder', 'task:unknown:due', '2026-08-09T09:30:00.000Z'],
    ['malformed time', 'task:task-1:due', '09:30'],
    ['too soon', 'task:task-1:due', '2026-08-09T09:00:59.999Z'],
    ['too far away', 'task:task-1:due', '2027-08-09T09:00:00.001Z'],
  ])('rejects custom snooze input with %s before persistence', async (_label, reminderId, snoozeUntil) => {
    const harness = createHarness({
      initialTasks: [makeTask({ dueAt: '2026-08-09T09:00:00.000Z' })],
    });
    await harness.controller.start();
    const before = structuredClone(harness.runtimeState());

    await expect(
      harness.controller.snoozeUntil(reminderId, snoozeUntil),
    ).rejects.toBeInstanceOf(NotificationControllerStateError);
    expect(harness.runtimeState()).toEqual(before);
  });

  it('falls back after a platform show failure without repeating the reminder', async () => {
    const harness = createHarness({
      showError: new Error('native notification failed'),
      initialTasks: [makeTask({ dueAt: '2026-08-09T09:00:00.000Z' })],
    });

    await harness.controller.start();
    await harness.controller.tick();

    expect(harness.inAppEvents).toContainEqual(expect.objectContaining({
      type: 'delivery',
      reason: 'platform-error',
    }));
    expect(harness.errors.map(({ operation }) => operation)).toContain('notification-show');
    expect(Object.keys(harness.runtimeState().delivered)).toHaveLength(1);
    expect(harness.inAppEvents.filter(({ type }) => type === 'delivery')).toHaveLength(1);
  });

  it('honors badge and banner settings independently', async () => {
    const harness = createHarness({
      initialTasks: [makeTask({ dueAt: '2026-08-09T09:00:00.000Z' })],
      settings: { badge: false, banners: false },
    });

    const result = await harness.controller.start();

    expect(result.badgeCount).toBe(0);
    expect(harness.badges.at(-1)).toBe(0);
    expect(harness.shown).toHaveLength(0);
    expect(harness.inAppEvents).toContainEqual(expect.objectContaining({
      type: 'delivery',
      reason: 'banners-disabled',
    }));
  });
});
