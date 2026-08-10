// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  ReminderProjector,
  ReminderProjectionError,
  projectReminderCandidates,
} from '../electron/services/reminder-projector';
import type { Task } from '../src/shared/models';
import { defaultSettings } from '../src/shared/settings';

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  source: { type: 'local' },
  title: '提交周报',
  notes: '',
  privateNotes: '',
  status: 'open',
  priority: 'medium',
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

describe('projectReminderCandidates', () => {
  it('projects enabled task reminders and deadlines without duplicate delivery', () => {
    const scheduledAt = '2026-08-09T00:50:00.000Z';
    const tasks = [
      makeTask({
        dueAt: scheduledAt,
        reminders: [
          {
            id: 'explicit',
            at: scheduledAt,
            enabled: true,
            source: 'local',
            label: '提前准备',
          },
          {
            id: 'disabled',
            at: '2026-08-09T00:40:00.000Z',
            enabled: false,
            source: 'local',
          },
        ],
      }),
      makeTask({
        id: 'completed',
        status: 'completed',
        completedAt: '2026-08-09T00:00:00.000Z',
        dueAt: scheduledAt,
      }),
      makeTask({ id: 'trash', deletedAt: '2026-08-09T00:00:00.000Z', dueAt: scheduledAt }),
      makeTask({
        id: 'remote-deleted',
        source: { type: 'feishu', externalId: 'remote-1' },
        sync: { status: 'remote-deleted' },
        dueAt: scheduledAt,
      }),
    ];

    const candidates = projectReminderCandidates(tasks, {
      ...defaultSettings.notifications,
      morningBrief: false,
    }, {
      now: new Date('2026-08-09T01:05:00.000Z'),
      startedAt: new Date('2026-08-09T01:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });

    expect(candidates).toEqual([
      {
        id: 'task:task-1:reminder:explicit',
        taskId: 'task-1',
        kind: 'task',
        title: '提交周报',
        body: '提前准备',
        scheduledAt,
        source: 'local',
      },
    ]);
  });

  it('converts the configured morning wall time in the selected IANA zone', () => {
    const candidates = projectReminderCandidates([], {
      ...defaultSettings.notifications,
      morningBrief: true,
      morningBriefTime: '09:00',
    }, {
      now: new Date('2026-08-09T00:30:00.000Z'),
      startedAt: new Date('2026-08-09T00:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        id: 'morning-brief:2026-08-09',
        kind: 'morning-brief',
        scheduledAt: '2026-08-09T01:00:00.000Z',
      }),
    ]);
  });

  it('keeps reminders missed shortly before startup and drops stale ones', () => {
    const tasks = [
      makeTask({
        reminders: [
          {
            id: 'missed',
            at: '2026-08-09T01:30:00.000Z',
            enabled: true,
            source: 'local',
          },
          {
            id: 'stale',
            at: '2026-08-07T01:30:00.000Z',
            enabled: true,
            source: 'local',
          },
          {
            id: 'future',
            at: '2026-08-09T03:00:00.000Z',
            enabled: true,
            source: 'local',
          },
        ],
      }),
    ];
    const candidates = projectReminderCandidates(tasks, {
      ...defaultSettings.notifications,
      morningBrief: false,
    }, {
      now: new Date('2026-08-09T02:05:00.000Z'),
      startedAt: new Date('2026-08-09T02:00:00.000Z'),
      timeZone: 'UTC',
      missedLookbackMs: 24 * 60 * 60_000,
    });

    expect(candidates.map(({ id }) => id)).toEqual([
      'task:task-1:reminder:missed',
      'task:task-1:reminder:future',
    ]);
  });

  it('uses local end-of-day for a date-only deadline', () => {
    const candidates = projectReminderCandidates([
      makeTask({ dueAt: '2026-08-09' }),
    ], {
      ...defaultSettings.notifications,
      morningBrief: false,
    }, {
      now: new Date('2026-08-08T00:00:00.000Z'),
      startedAt: new Date('2026-08-08T00:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });

    expect(candidates[0]?.scheduledAt).toBe('2026-08-09T15:59:00.000Z');
  });

  it('honors the global notification switch and rejects invalid time zones', () => {
    expect(projectReminderCandidates([makeTask({ dueAt: '2026-08-09T01:00:00.000Z' })], {
      ...defaultSettings.notifications,
      enabled: false,
    }, {
      now: new Date('2026-08-09T00:00:00.000Z'),
      startedAt: new Date('2026-08-09T00:00:00.000Z'),
      timeZone: 'UTC',
    })).toEqual([]);

    expect(() => projectReminderCandidates([], defaultSettings.notifications, {
      now: new Date('2026-08-09T00:00:00.000Z'),
      startedAt: new Date('2026-08-09T00:00:00.000Z'),
      timeZone: 'Not/AZone',
    })).toThrow(ReminderProjectionError);
  });
});

describe('ReminderProjector', () => {
  it('loads task and setting dependencies through injected interfaces', async () => {
    const listTasksForReminders = vi.fn(async () => [
      makeTask({ dueAt: '2026-08-09T02:00:00.000Z' }),
    ]);
    const getNotificationSettings = vi.fn(() => ({
      ...defaultSettings.notifications,
      morningBrief: false,
    }));
    const projector = new ReminderProjector({
      taskSource: { listTasksForReminders },
      settingsSource: { getNotificationSettings },
      timeZone: () => 'UTC',
      now: () => new Date('2026-08-09T01:00:00.000Z'),
      startedAt: new Date('2026-08-09T00:30:00.000Z'),
    });

    expect((await projector.project()).map(({ id }) => id)).toEqual(['task:task-1:due']);
    expect(listTasksForReminders).toHaveBeenCalledOnce();
    expect(getNotificationSettings).toHaveBeenCalledOnce();
  });
});
