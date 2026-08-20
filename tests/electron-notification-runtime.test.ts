// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { NotificationConstructorOptions } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createElectronNotificationRuntimeWithBindings,
  type ElectronNativeNotification,
  type ElectronNotificationBindings,
  type NotificationOpenRequest,
} from '../electron/services/electron-notification-runtime';
import type {
  InAppNotificationEvent,
  NotificationTimerAdapter,
} from '../electron/services/notification-controller';
import { LocalStore } from '../electron/services/local-store';
import { ReminderRuntimeStore } from '../electron/services/reminder-runtime-store';
import { SettingsService } from '../electron/services/settings-service';
import { TaskService } from '../electron/services/task-service';

const testDirectories: string[] = [];

class FakeTimers implements NotificationTimerAdapter {
  readonly setInterval = vi.fn(
    (_callback: () => void, _milliseconds: number): unknown => 1,
  );
  readonly clearInterval = vi.fn((_handle: unknown): void => undefined);
}

class FakeNativeNotification implements ElectronNativeNotification {
  readonly show = vi.fn(() => {
    if (this.failureMessage !== undefined) {
      this.failedListeners.forEach((listener) => listener(this.failureMessage!));
      return;
    }
    this.shownListeners.forEach((listener) => listener());
  });

  readonly close = vi.fn(() => {
    this.closedListeners.forEach((listener) => listener());
  });

  private readonly shownListeners: Array<() => void> = [];
  private readonly clickListeners: Array<() => void> = [];
  private readonly actionListeners: Array<(actionIndex: number) => void> = [];
  private readonly closedListeners: Array<() => void> = [];
  private readonly failedListeners: Array<(message: string) => void> = [];

  constructor(readonly failureMessage?: string) {}

  onShown(listener: () => void): void {
    this.shownListeners.push(listener);
  }

  onClick(listener: () => void): void {
    this.clickListeners.push(listener);
  }

  onAction(listener: (actionIndex: number) => void): void {
    this.actionListeners.push(listener);
  }

  onClosed(listener: () => void): void {
    this.closedListeners.push(listener);
  }

  onFailed(listener: (message: string) => void): void {
    this.failedListeners.push(listener);
  }

  click(): void {
    this.clickListeners.forEach((listener) => listener());
  }

  action(index: number): void {
    this.actionListeners.forEach((listener) => listener(index));
  }
}

function createFakeBindings(options: {
  supported?: boolean;
  platform?: NodeJS.Platform;
  failureMessage?: string;
} = {}) {
  const notifications: Array<{
    options: NotificationConstructorOptions;
    native: FakeNativeNotification;
  }> = [];
  const removed: string[] = [];
  const badges: string[] = [];
  const bindings: ElectronNotificationBindings = {
    platform: options.platform ?? 'darwin',
    isNotificationSupported: vi.fn(() => options.supported ?? true),
    createNotification: vi.fn((notificationOptions) => {
      const native = new FakeNativeNotification(options.failureMessage);
      notifications.push({ options: structuredClone(notificationOptions), native });
      return native;
    }),
    removeDeliveredNotification: vi.fn((id) => { removed.push(id); }),
    setDockBadge: vi.fn((text) => { badges.push(text); }),
  };
  return { bindings, notifications, removed, badges };
}

async function createFixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'todo-agent-electron-notifications-'),
  );
  testDirectories.push(directory);
  let now = new Date('2026-08-09T09:00:00.000Z');
  const counters = { task: 0, operation: 0, draft: 0 };
  const localStore = new LocalStore(path.join(directory, 'data'));
  const taskService = new TaskService(localStore, {
    clock: () => new Date(now),
    timeZone: 'UTC',
    idGenerator: (prefix) => `${prefix}-${++counters[prefix]}`,
  });
  await taskService.initialize();

  const settingsService = new SettingsService(directory, {
    isAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8'),
  });
  await settingsService.load();
  const initialSettings = settingsService.get();
  await settingsService.replace({
    ...initialSettings,
    notifications: {
      ...initialSettings.notifications,
      morningBrief: false,
      quietHoursEnabled: false,
    },
  });

  return {
    directory,
    taskService,
    settingsService,
    now: () => new Date(now),
    setNow: (value: string) => { now = new Date(value); },
  };
}

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Electron notification production runtime', () => {
  it('reads TaskService, shows a native notification, maps open/complete, and badges the macOS dock', async () => {
    const fixture = await createFixture();
    const native = createFakeBindings();
    const opens: NotificationOpenRequest[] = [];
    const taskChanges = vi.fn();
    const inAppEvents: InAppNotificationEvent[] = [];
    const runtime = createElectronNotificationRuntimeWithBindings({
      userDataPath: fixture.directory,
      taskService: fixture.taskService,
      settingsService: fixture.settingsService,
      onInAppNotification: (event) => { inAppEvents.push(event); },
      onOpen: (request) => { opens.push(request); },
      onTasksChanged: taskChanges,
      timeZone: () => 'UTC',
      clock: { now: fixture.now },
      timers: new FakeTimers(),
    }, native.bindings);

    const started = await runtime.start();
    expect(started.candidateCount).toBe(0);
    expect(native.badges.at(-1)).toBe('');

    const created = await fixture.taskService.createTask({
      title: '提交周报',
      dueAt: '2026-08-09T09:00:00.000Z',
    });
    const refreshed = await runtime.refresh('task-change');

    expect(refreshed.deliveryCount).toBe(1);
    expect(native.notifications).toHaveLength(1);
    expect(native.notifications[0]?.options).toMatchObject({
      id: `task:${created.task.id}:due`,
      title: '提交周报',
      body: '任务已到截止时间',
      silent: false,
    });
    expect(native.notifications[0]?.options.actions).toEqual([
      { type: 'button', text: '完成' },
      { type: 'button', text: '10 分钟后' },
      { type: 'button', text: '明天提醒' },
      { type: 'button', text: '打开' },
      { type: 'button', text: '今天不再提醒' },
    ]);
    expect(native.badges.at(-1)).toBe('1');
    expect(inAppEvents).toEqual([]);

    native.notifications[0]!.native.click();
    await vi.waitFor(() => {
      expect(opens).toEqual([expect.objectContaining({
        reminderId: `task:${created.task.id}:due`,
        taskId: created.task.id,
      })]);
    });

    native.notifications[0]!.native.action(0);
    await vi.waitFor(async () => {
      expect((await fixture.taskService.getTask(created.task.id))?.status)
        .toBe('completed');
      expect(taskChanges).toHaveBeenCalledOnce();
      expect(native.notifications[0]!.native.close).toHaveBeenCalled();
      expect(native.badges.at(-1)).toBe('');
    });

    await runtime.stop();
    expect(runtime.isStarted).toBe(false);
  });

  it('uses SettingsService and the in-app callback when banners are disabled', async () => {
    const fixture = await createFixture();
    const current = fixture.settingsService.get();
    await fixture.settingsService.replace({
      ...current,
      notifications: { ...current.notifications, banners: false },
    });
    await fixture.taskService.createTask({
      title: '只在应用内显示',
      dueAt: '2026-08-09T09:00:00.000Z',
    });
    const native = createFakeBindings();
    const inAppEvents: InAppNotificationEvent[] = [];
    const runtime = createElectronNotificationRuntimeWithBindings({
      userDataPath: fixture.directory,
      taskService: fixture.taskService,
      settingsService: fixture.settingsService,
      onInAppNotification: (event) => { inAppEvents.push(event); },
      onOpen: () => undefined,
      timeZone: () => 'UTC',
      clock: { now: fixture.now },
      timers: new FakeTimers(),
    }, native.bindings);

    await runtime.start();

    expect(native.notifications).toHaveLength(0);
    expect(inAppEvents).toContainEqual(expect.objectContaining({
      type: 'delivery',
      reason: 'banners-disabled',
    }));
    const deliveryEvent = inAppEvents.find(
      (event): event is Extract<InAppNotificationEvent, { type: 'delivery' }> =>
        event.type === 'delivery',
    );
    expect(deliveryEvent?.delivery.actions).toContainEqual({
      id: 'tomorrow',
      label: '明天提醒',
    });
    expect(native.badges.at(-1)).toBe('1');
    await runtime.stop();
  });

  it.each([
    { supported: false, failureMessage: undefined, reason: 'unsupported' },
    { supported: true, failureMessage: 'native toast failed', reason: 'platform-error' },
  ] as const)(
    'falls back in-app for $reason native delivery',
    async ({ supported, failureMessage, reason }) => {
      const fixture = await createFixture();
      await fixture.taskService.createTask({
        title: '需要兜底',
        dueAt: '2026-08-09T09:00:00.000Z',
      });
      const native = createFakeBindings({ supported, failureMessage });
      const inAppEvents: InAppNotificationEvent[] = [];
      const errors: string[] = [];
      const runtime = createElectronNotificationRuntimeWithBindings({
        userDataPath: fixture.directory,
        taskService: fixture.taskService,
        settingsService: fixture.settingsService,
        onInAppNotification: (event) => { inAppEvents.push(event); },
        onOpen: () => undefined,
        timeZone: () => 'UTC',
        clock: { now: fixture.now },
        timers: new FakeTimers(),
        onError: (_error, operation) => { errors.push(operation); },
      }, native.bindings);

      await runtime.start();

      expect(inAppEvents).toContainEqual(expect.objectContaining({
        type: 'delivery',
        reason,
      }));
      if (failureMessage !== undefined) {
        expect(errors).toContain('notification-show');
      }
      await runtime.stop();
    },
  );

  it('persists snooze and tomorrow actions without changing the task', async () => {
    const fixture = await createFixture();
    const created = await fixture.taskService.createTask({
      title: '稍后处理',
      dueAt: '2026-08-09T09:00:00.000Z',
    });
    const reminderId = `task:${created.task.id}:due`;
    const native = createFakeBindings();
    const runtime = createElectronNotificationRuntimeWithBindings({
      userDataPath: fixture.directory,
      taskService: fixture.taskService,
      settingsService: fixture.settingsService,
      onInAppNotification: () => undefined,
      onOpen: () => undefined,
      timeZone: () => 'UTC',
      clock: { now: fixture.now },
      timers: new FakeTimers(),
    }, native.bindings);
    await runtime.start();

    native.notifications[0]!.native.action(1);
    const persistedStore = new ReminderRuntimeStore({
      directory: path.join(fixture.directory, 'reminders'),
    });
    await vi.waitFor(async () => {
      expect((await persistedStore.load())?.snoozedUntil[reminderId])
        .toBe('2026-08-09T09:10:00.000Z');
    });

    native.notifications[0]!.native.action(2);
    await vi.waitFor(async () => {
      expect((await persistedStore.load())?.snoozedUntil[reminderId])
        .toBe('2026-08-10T09:00:00.000Z');
    });
    expect((await fixture.taskService.getTask(created.task.id))?.status)
      .toBe('open');

    await runtime.stop();
  });

  it('persists a custom snooze through the runtime facade and app restart', async () => {
    const fixture = await createFixture();
    const created = await fixture.taskService.createTask({
      title: '指定时间再提醒',
      dueAt: '2026-08-09T09:00:00.000Z',
    });
    const reminderId = `task:${created.task.id}:due`;
    const firstNative = createFakeBindings();
    const firstRuntime = createElectronNotificationRuntimeWithBindings({
      userDataPath: fixture.directory,
      taskService: fixture.taskService,
      settingsService: fixture.settingsService,
      onInAppNotification: () => undefined,
      onOpen: () => undefined,
      timeZone: () => 'UTC',
      clock: { now: fixture.now },
      timers: new FakeTimers(),
    }, firstNative.bindings);
    await firstRuntime.start();
    expect(firstNative.notifications).toHaveLength(1);

    await firstRuntime.snoozeUntil(
      reminderId,
      '2026-08-09T17:45:00.000+08:00',
    );
    await firstRuntime.stop();
    const persistedStore = new ReminderRuntimeStore({
      directory: path.join(fixture.directory, 'reminders'),
    });
    expect((await persistedStore.load())?.snoozedUntil).toEqual({
      [reminderId]: '2026-08-09T09:45:00.000Z',
    });

    const restartedNative = createFakeBindings();
    const restartedRuntime = createElectronNotificationRuntimeWithBindings({
      userDataPath: fixture.directory,
      taskService: fixture.taskService,
      settingsService: fixture.settingsService,
      onInAppNotification: () => undefined,
      onOpen: () => undefined,
      timeZone: () => 'UTC',
      clock: { now: fixture.now },
      timers: new FakeTimers(),
    }, restartedNative.bindings);
    await restartedRuntime.start();
    expect(restartedNative.notifications).toHaveLength(0);

    fixture.setNow('2026-08-09T09:45:00.000Z');
    await restartedRuntime.refresh('timer');
    await restartedRuntime.refresh('timer');
    expect(restartedNative.notifications).toHaveLength(1);
    expect((await persistedStore.load())?.snoozedUntil).toEqual({});
    expect((await fixture.taskService.getTask(created.task.id))?.status)
      .toBe('open');

    await restartedRuntime.stop();
  });

  it('does not call dock APIs outside macOS', async () => {
    const fixture = await createFixture();
    await fixture.taskService.createTask({
      title: 'Windows reminder',
      dueAt: '2026-08-09T09:00:00.000Z',
    });
    const native = createFakeBindings({ platform: 'win32' });
    const runtime = createElectronNotificationRuntimeWithBindings({
      userDataPath: fixture.directory,
      taskService: fixture.taskService,
      settingsService: fixture.settingsService,
      onInAppNotification: () => undefined,
      onOpen: () => undefined,
      timeZone: () => 'UTC',
      clock: { now: fixture.now },
      timers: new FakeTimers(),
    }, native.bindings);

    await runtime.start();

    expect(native.badges).toEqual([]);
    expect(native.notifications).toHaveLength(1);
    await runtime.stop();
  });
});
