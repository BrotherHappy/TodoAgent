// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ReminderScheduler } from '../electron/services/reminder-service';
import { emptyReminderRuntimeState, type ReminderDelivery, type ReminderRuntimeState } from '../src/shared/reminders';
import { defaultSettings } from '../src/shared/settings';

const createHarness = (now: Date) => {
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
    settings: () => structuredClone(defaultSettings.notifications),
    onAction,
    now: () => now,
  });
  return { scheduler, shown, onAction, state: () => state };
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
