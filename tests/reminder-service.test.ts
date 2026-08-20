// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ReminderScheduler } from '../electron/services/reminder-service';
import { emptyReminderRuntimeState, type ReminderDelivery, type ReminderRuntimeState } from '../src/shared/reminders';
import { defaultSettings } from '../src/shared/settings';

const createHarness = (
  now: Date,
  settingsPatch: Partial<typeof defaultSettings.notifications> = {},
) => {
  let clock = new Date(now);
  let state: ReminderRuntimeState = emptyReminderRuntimeState();
  const shown: ReminderDelivery[] = [];
  const onAction = vi.fn();
  const scheduler = new ReminderScheduler({
    stateStore: {
      load: async () => structuredClone(state),
      save: async (next) => { state = structuredClone(next); },
    },
    sink: {
      show: async (delivery) => { shown.push(delivery); },
      cancel: vi.fn(),
    },
    settings: () => structuredClone({ ...defaultSettings.notifications, ...settingsPatch }),
    onAction,
    now: () => new Date(clock),
  });
  return { scheduler, shown, onAction, state: () => state, setNow: (value: Date) => { clock = new Date(value); } };
};

describe('ReminderScheduler', () => {
  it('delivers a due task once and exposes task actions', async () => {
    const now = new Date('2026-08-09T09:00:00.000Z');
    const { scheduler, shown } = createHarness(now);
    await scheduler.load();
    await scheduler.replaceCandidates([{ id: 'r1', taskId: 't1', kind: 'task', title: '提交周报', body: '今天到期', scheduledAt: now.toISOString() }]);
    await scheduler.tick();
    await scheduler.tick();
    expect(shown).toHaveLength(1);
    expect(shown[0].actions.map((action) => action.id)).toContain('complete');
  });

  it('coalesces more than three missed task reminders', async () => {
    const now = new Date('2026-08-09T09:00:00.000Z');
    const { scheduler, shown } = createHarness(now);
    await scheduler.load();
    await scheduler.replaceCandidates(Array.from({ length: 4 }, (_, index) => ({
      id: `r${index}`,
      taskId: `t${index}`,
      kind: 'task' as const,
      title: `任务 ${index}`,
      body: '错过的提醒',
      scheduledAt: new Date(now.getTime() - 60_000).toISOString(),
    })));
    await scheduler.tick();
    expect(shown).toHaveLength(1);
    expect(shown[0].kind).toBe('missed-summary');
  });

  it('enforces the daily task reminder budget without blocking important notices', async () => {
    const now = new Date('2026-08-09T09:00:00.000Z');
    const { scheduler, shown, state } = createHarness(now, { dailyTaskReminderLimit: 2 });
    await scheduler.load();
    await scheduler.replaceCandidates([
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `budget-${index}`,
        taskId: `task-${index}`,
        kind: 'task' as const,
        title: `预算任务 ${index}`,
        body: '',
        scheduledAt: now.toISOString(),
      })),
      {
        id: 'sync-risk-1',
        kind: 'sync-risk',
        title: '同步需要注意',
        body: '飞书连接需要查看',
        scheduledAt: now.toISOString(),
      },
    ]);
    await scheduler.tick();
    expect(shown.filter((delivery) => delivery.kind === 'task')).toHaveLength(2);
    expect(shown.some((delivery) => delivery.kind === 'sync-risk')).toBe(true);
    expect(Object.keys(state().taskNotificationLog)).toHaveLength(2);
  });

  it('stops resurfacing one task after two ignored reminders', async () => {
    let now = new Date('2026-08-09T09:00:00.000Z');
    const candidate = {
      id: 'ignore-me',
      taskId: 'task-ignore-me',
      kind: 'task' as const,
      title: '连续忽略',
      body: '',
      scheduledAt: now.toISOString(),
    };
    const { scheduler, shown, state, setNow } = createHarness(now);
    await scheduler.load();
    await scheduler.replaceCandidates([candidate]);
    await scheduler.tick();
    await scheduler.handleAction({ reminderId: candidate.id, action: 'dismiss' });
    await scheduler.handleAction({ reminderId: candidate.id, action: 'snooze-10m' });

    now = new Date('2026-08-09T09:10:00.000Z');
    setNow(now);
    await scheduler.tick();
    await scheduler.handleAction({ reminderId: candidate.id, action: 'dismiss' });
    await scheduler.handleAction({ reminderId: candidate.id, action: 'snooze-10m' });

    now = new Date('2026-08-09T09:20:00.000Z');
    setNow(now);
    await scheduler.tick();
    expect(shown).toHaveLength(2);
    expect(state().dismissed[candidate.id]).toBe(2);
    expect(state().delivered[`${candidate.id}:${candidate.scheduledAt}`]).toBeDefined();
  });

  it('applies source policies without consuming the task reminder budget', async () => {
    const now = new Date('2026-08-09T09:00:00.000Z');
    const { scheduler, shown, state } = createHarness(now, {
      taskReminderMinIntervalMinutes: 0,
      taskReminderSourceMode: { local: 'important-only', feishu: 'off' },
      taskReminderProjectMode: { 'project-a': 'normal' },
    });
    await scheduler.load();
    await scheduler.replaceCandidates([
      {
        id: 'local-low', taskId: 'local-low', kind: 'task', title: '低优先级本地', body: '',
        scheduledAt: now.toISOString(), source: 'local', priority: 'low',
      },
      {
        id: 'local-high', taskId: 'local-high', kind: 'task', title: '高优先级本地', body: '',
        scheduledAt: now.toISOString(), source: 'local', priority: 'high',
      },
      {
        id: 'feishu-urgent', taskId: 'feishu-urgent', kind: 'task', title: '飞书紧急', body: '',
        scheduledAt: now.toISOString(), source: 'feishu', projectId: 'project-a', priority: 'urgent',
      },
    ]);
    await scheduler.tick();
    expect(shown.map((delivery) => delivery.id)).toEqual(['local-high', 'feishu-urgent']);
    expect(Object.keys(state().taskNotificationLog)).toHaveLength(2);
  });

  it('spaces different task reminders while allowing the same snoozed reminder through', async () => {
    const now = new Date('2026-08-09T09:00:00.000Z');
    const { scheduler, shown, setNow } = createHarness(now, {
      taskReminderMinIntervalMinutes: 120,
    });
    const first = {
      id: 'interval-first', taskId: 'interval-first', kind: 'task' as const, title: '第一项', body: '',
      scheduledAt: now.toISOString(), source: 'local' as const, priority: 'medium' as const,
    };
    const second = {
      id: 'interval-second', taskId: 'interval-second', kind: 'task' as const, title: '第二项', body: '',
      scheduledAt: now.toISOString(), source: 'local' as const, priority: 'medium' as const,
    };
    await scheduler.load();
    await scheduler.replaceCandidates([first]);
    await scheduler.tick();
    await scheduler.replaceCandidates([first, second]);
    setNow(new Date('2026-08-09T10:00:00.000Z'));
    await scheduler.tick();
    expect(shown.map((delivery) => delivery.id)).toEqual(['interval-first']);
    setNow(new Date('2026-08-09T11:00:00.000Z'));
    await scheduler.tick();
    expect(shown.map((delivery) => delivery.id)).toEqual(['interval-first', 'interval-second']);
  });

  it('respects quiet hours and snooze', async () => {
    const now = new Date('2026-08-09T23:00:00');
    const shown: ReminderDelivery[] = [];
    let state = emptyReminderRuntimeState();
    const scheduler = new ReminderScheduler({
      stateStore: { load: async () => state, save: async (next) => { state = next; } },
      sink: { show: (delivery) => { shown.push(delivery); }, cancel: vi.fn() },
      settings: () => ({ ...defaultSettings.notifications, quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '08:00' }),
      onAction: vi.fn(),
      now: () => now,
    });
    await scheduler.load();
    await scheduler.replaceCandidates([{ id: 'r1', kind: 'task', title: '晚间任务', body: '', scheduledAt: now.toISOString() }]);
    await scheduler.tick();
    expect(shown).toHaveLength(0);
  });

  it('persists a custom snooze across restart and delivers exactly once at the chosen time', async () => {
    let now = new Date('2026-08-09T09:00:00.000Z');
    let state: ReminderRuntimeState = emptyReminderRuntimeState();
    const shown: ReminderDelivery[] = [];
    const candidate = {
      id: 'custom-reminder',
      taskId: 'task-1',
      kind: 'task' as const,
      title: '稍后继续',
      body: '',
      scheduledAt: '2026-08-09T09:00:00.000Z',
    };
    const createScheduler = () => new ReminderScheduler({
      stateStore: {
        load: async () => structuredClone(state),
        save: async (next) => { state = structuredClone(next); },
      },
      sink: {
        show: async (delivery) => { shown.push(delivery); },
        cancel: vi.fn(),
      },
      settings: () => structuredClone(defaultSettings.notifications),
      onAction: vi.fn(),
      now: () => new Date(now),
    });

    const firstProcess = createScheduler();
    await firstProcess.load();
    await firstProcess.replaceCandidates([candidate]);
    await firstProcess.tick();
    expect(shown).toHaveLength(1);

    await firstProcess.handleAction({
      reminderId: candidate.id,
      action: 'snooze-until',
      // An offset is accepted and normalized before persistence.
      snoozeUntil: '2026-08-09T17:30:00.000+08:00',
    });
    await firstProcess.handleAction({
      reminderId: candidate.id,
      action: 'snooze-until',
      snoozeUntil: '2026-08-09T17:30:00.000+08:00',
    });
    expect(state.snoozedUntil).toEqual({
      [candidate.id]: '2026-08-09T09:30:00.000Z',
    });
    expect(state.delivered).toEqual({});

    // Simulates loading reminder-runtime.v1.json in a fresh app process.
    const restarted = createScheduler();
    await restarted.load();
    await restarted.replaceCandidates([candidate]);
    now = new Date('2026-08-09T09:29:59.999Z');
    await restarted.tick();
    expect(shown).toHaveLength(1);

    now = new Date('2026-08-09T09:30:00.000Z');
    await restarted.tick();
    await restarted.tick();
    expect(shown).toHaveLength(2);
    expect(state.snoozedUntil).toEqual({});
    expect(Object.keys(state.delivered)).toHaveLength(1);
  });

  it.each([
    ['malformed', 'tomorrow'],
    ['less than one minute ahead', '2026-08-09T09:00:59.999Z'],
    ['more than 365 days ahead', '2027-08-09T09:00:00.001Z'],
  ])('rejects a custom snooze that is %s without changing state', async (_label, snoozeUntil) => {
    const now = new Date('2026-08-09T09:00:00.000Z');
    const { scheduler, state } = createHarness(now);
    await scheduler.load();
    await scheduler.replaceCandidates([{
      id: 'r1',
      kind: 'task',
      title: '提醒',
      body: '',
      scheduledAt: now.toISOString(),
    }]);

    await expect(scheduler.handleAction({
      reminderId: 'r1',
      action: 'snooze-until',
      snoozeUntil,
    })).rejects.toBeInstanceOf(RangeError);
    expect(state().snoozedUntil).toEqual({});
  });

  it('rejects persisting a custom snooze for an unknown reminder id', async () => {
    const now = new Date('2026-08-09T09:00:00.000Z');
    const { scheduler, state } = createHarness(now);
    await scheduler.load();

    await expect(scheduler.handleAction({
      reminderId: 'not-a-candidate',
      action: 'snooze-until',
      snoozeUntil: '2026-08-09T09:30:00.000Z',
    })).rejects.toBeInstanceOf(RangeError);
    expect(state().snoozedUntil).toEqual({});
  });
});
