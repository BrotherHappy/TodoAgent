// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { Task } from '../src/shared/models';
import type {
  FeishuCreateTaskPayload,
  FeishuListTasksOptions,
  FeishuPatchTaskPayload,
  FeishuSyncQueueItem,
  FeishuSyncQueueStore,
  FeishuSyncTaskStore,
  FeishuTaskApi,
  FeishuTaskMember,
  FeishuTaskSyncSnapshot,
  FeishuTaskV2,
} from '../src/shared/feishu-types';
import { FeishuNetworkError } from '../electron/feishu/feishu-client';
import {
  FeishuSyncEngine,
  buildFeishuCreatePayload,
  buildFeishuPatchPayload,
  remoteTaskToFeishuSnapshot,
  threeWayMergeFeishuTask,
} from '../electron/feishu/sync-engine';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'local-1',
    source: { type: 'local' },
    title: 'Public title',
    notes: 'Public description',
    privateNotes: 'PRIVATE JOURNAL ENTRY',
    status: 'open',
    priority: 'urgent',
    tags: ['PRIVATE-TAG'],
    dependencyIds: [],
    assigneeIds: [],
    followerIds: [],
    attachments: [],
    links: [],
    customFields: { agentPlan: 'PRIVATE AGENT PLAN' },
    plannedDate: '2026-08-10',
    reminders: [],
    estimatedMinutes: 90,
    actualMinutes: 12,
    focusStartedAt: '2026-08-09T11:00:00.000Z',
    focusElapsedSeconds: 720,
    privateOrder: 99,
    sync: { status: 'local' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<FeishuTaskSyncSnapshot> = {},
): FeishuTaskSyncSnapshot {
  return {
    title: 'Base title',
    notes: 'Base notes',
    status: 'open',
    ...overrides,
  };
}

function remoteTask(overrides: Partial<FeishuTaskV2> = {}): FeishuTaskV2 {
  return {
    guid: 'remote-guid',
    summary: 'Public title',
    description: 'Public description',
    status: 'open',
    updated_at: 'remote-version-1',
    ...overrides,
  };
}

class MemoryQueueStore implements FeishuSyncQueueStore {
  items: FeishuSyncQueueItem[] = [];
  saves: FeishuSyncQueueItem[][] = [];

  async load(): Promise<FeishuSyncQueueItem[]> {
    return this.items.map((item) => ({ ...item }));
  }

  async save(items: readonly FeishuSyncQueueItem[]): Promise<void> {
    this.items = items.map((item) => ({ ...item }));
    this.saves.push(this.items.map((item) => ({ ...item })));
  }
}

class MemoryTaskStore implements FeishuSyncTaskStore {
  readonly tasks = new Map<string, Task>();
  readonly bases = new Map<string, FeishuTaskSyncSnapshot>();
  readonly saves: Task[] = [];

  constructor(task: Task, base?: FeishuTaskSyncSnapshot) {
    this.tasks.set(task.id, task);
    if (base) this.bases.set(task.id, { ...base });
  }

  async get(taskId: string): Promise<Task | undefined> {
    return this.tasks.get(taskId);
  }

  async save(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
    this.saves.push(task);
  }

  async getBase(taskId: string): Promise<FeishuTaskSyncSnapshot | undefined> {
    const value = this.bases.get(taskId);
    return value ? { ...value } : undefined;
  }

  async saveBase(
    taskId: string,
    value: FeishuTaskSyncSnapshot,
  ): Promise<void> {
    this.bases.set(taskId, { ...value });
  }
}

class FakeFeishuApi implements FeishuTaskApi {
  remote = remoteTask();
  createTokens: string[] = [];
  createPayloads: FeishuCreateTaskPayload[] = [];
  patches: FeishuPatchTaskPayload[] = [];
  memberAdds: FeishuTaskMember[][] = [];
  memberRemoves: FeishuTaskMember[][] = [];
  deletes = 0;
  completes = 0;
  reopens = 0;
  createFailure?: Error;
  getTaskHook?: () => Promise<void>;

  async listAllTasks(
    _options?: FeishuListTasksOptions,
  ): Promise<FeishuTaskV2[]> {
    return [this.remote];
  }

  async getTask(_taskGuid: string): Promise<FeishuTaskV2> {
    await this.getTaskHook?.();
    return { ...this.remote };
  }

  async createTask(
    task: FeishuCreateTaskPayload,
    clientToken: string,
  ): Promise<FeishuTaskV2> {
    this.createTokens.push(clientToken);
    this.createPayloads.push(structuredClone(task));
    if (this.createFailure) throw this.createFailure;
    this.remote = {
      ...this.remote,
      guid: 'created-remote-guid',
      summary: task.summary,
      description: task.description,
      start: task.start,
      due: task.due,
    };
    return { ...this.remote };
  }

  async updateTask(
    _taskGuid: string,
    patch: FeishuPatchTaskPayload,
  ): Promise<FeishuTaskV2> {
    this.patches.push(structuredClone(patch));
    if (patch.update_fields.includes('summary')) {
      this.remote.summary = patch.task.summary ?? '';
    }
    if (patch.update_fields.includes('description')) {
      this.remote.description = patch.task.description ?? '';
    }
    if (patch.update_fields.includes('start')) this.remote.start = patch.task.start;
    if (patch.update_fields.includes('due')) this.remote.due = patch.task.due;
    return { ...this.remote };
  }

  async addTaskMembers(
    _taskGuid: string,
    members: FeishuTaskMember[],
  ): Promise<FeishuTaskV2> {
    this.memberAdds.push(structuredClone(members));
    const existing = this.remote.members ?? [];
    const seen = new Set(existing.map((member) => `${member.role}\u0000${member.id}`));
    this.remote.members = [
      ...existing,
      ...members.filter((member) => {
        const key = `${member.role}\u0000${member.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    ];
    return { ...this.remote, members: structuredClone(this.remote.members) };
  }

  async removeTaskMembers(
    _taskGuid: string,
    members: FeishuTaskMember[],
  ): Promise<FeishuTaskV2> {
    this.memberRemoves.push(structuredClone(members));
    const remove = new Set(members.map((member) => `${member.role}\u0000${member.id}`));
    this.remote.members = (this.remote.members ?? []).filter(
      (member) => !remove.has(`${member.role}\u0000${member.id}`),
    );
    return { ...this.remote, members: structuredClone(this.remote.members) };
  }

  async deleteTask(_taskGuid: string): Promise<void> {
    this.deletes += 1;
  }

  async completeTask(_taskGuid: string): Promise<FeishuTaskV2> {
    this.completes += 1;
    this.remote.completed_at = String(NOW);
    this.remote.status = 'completed';
    return { ...this.remote };
  }

  async reopenTask(_taskGuid: string): Promise<FeishuTaskV2> {
    this.reopens += 1;
    delete this.remote.completed_at;
    this.remote.status = 'open';
    return { ...this.remote };
  }
}

describe('Feishu payload privacy boundary', () => {
  it('uses an allow-list so private planning data never enters a create payload', () => {
    const task = makeTask({
      startAt: '2026-08-09T13:00:00.000Z',
      dueAt: '2026-08-09T14:00:00.000Z',
    });
    const payload = buildFeishuCreatePayload(task, {
      currentUserOpenId: 'ou_current_user',
    });
    const serialized = JSON.stringify(payload);

    expect(payload).toEqual({
      summary: 'Public title',
      description: 'Public description',
      start: { timestamp: String(Date.parse(task.startAt!)), is_all_day: false },
      due: { timestamp: String(Date.parse(task.dueAt!)), is_all_day: false },
      members: [{ id: 'ou_current_user', type: 'user', role: 'assignee' }],
    });
    for (const forbidden of [
      'privateNotes',
      'plannedDate',
      'priority',
      'tags',
      'privateOrder',
      'estimatedMinutes',
      'actualMinutes',
      'focusStartedAt',
      'focusElapsedSeconds',
      'customFields',
      'PRIVATE JOURNAL ENTRY',
      'PRIVATE AGENT PLAN',
      'PRIVATE-TAG',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('can explicitly clear a remote time without serializing local-only fields', () => {
    expect(
      buildFeishuPatchPayload(snapshot({ dueAt: undefined }), ['dueAt']),
    ).toEqual({ task: {}, update_fields: ['due'] });
  });

  it('preserves Task v2 all-day semantics for create, patch, and time clears', () => {
    const task = makeTask({
      startAt: '2026-08-10T00:00:00.000Z',
      startAtIsAllDay: true,
      dueAt: '2026-08-11T00:00:00.000Z',
      dueAtIsAllDay: true,
    });
    expect(buildFeishuCreatePayload(task)).toMatchObject({
      start: {
        timestamp: String(Date.parse(task.startAt!)),
        is_all_day: true,
      },
      due: {
        timestamp: String(Date.parse(task.dueAt!)),
        is_all_day: true,
      },
    });

    expect(
      buildFeishuPatchPayload(
        snapshot({
          startAt: task.startAt,
          startAtIsAllDay: true,
          dueAt: undefined,
          // A stale flag must never turn a cleared due time into an invalid
          // Task v2 payload.
          dueAtIsAllDay: true,
        }),
        ['startAt', 'dueAt'],
      ),
    ).toEqual({
      task: {
        start: {
          timestamp: String(Date.parse(task.startAt!)),
          is_all_day: true,
        },
      },
      update_fields: ['start', 'due'],
    });
  });
});

describe('Feishu completion mapping', () => {
  it('imports all-day flags only for valid remote timestamps', () => {
    const start = '2026-08-10T00:00:00.000Z';
    const due = '2026-08-11T00:00:00.000Z';
    expect(
      remoteTaskToFeishuSnapshot(
        remoteTask({
          start: { timestamp: String(Date.parse(start)), is_all_day: true },
          due: { timestamp: String(Date.parse(due)), is_all_day: false },
        }),
      ),
    ).toMatchObject({
      startAt: start,
      startAtIsAllDay: true,
      dueAt: due,
    });
    expect(
      remoteTaskToFeishuSnapshot(
        remoteTask({
          start: { timestamp: '0', is_all_day: true },
        }),
      ).startAtIsAllDay,
    ).toBeUndefined();
  });

  it.each([
    ['todo with zero timestamp', { status: 'todo', completed_at: '0' }, 'open'],
    ['open with padded zero', { status: 'open', completed_at: ' 0 ' }, 'open'],
    ['done without timestamp', { status: 'done' }, 'completed'],
    ['completed without timestamp', { status: 'completed' }, 'completed'],
    [
      'positive completion timestamp',
      { status: 'todo', completed_at: String(NOW) },
      'completed',
    ],
  ] as const)('maps %s as %s', (_label, overrides, expected) => {
    expect(remoteTaskToFeishuSnapshot(remoteTask(overrides)).status).toBe(
      expected,
    );
  });

  it.each(['-1', 'not-a-timestamp', '', '   '])(
    'does not treat invalid completion timestamp %j as completed',
    (completedAt) => {
      expect(
        remoteTaskToFeishuSnapshot(
          remoteTask({ status: 'todo', completed_at: completedAt }),
        ).status,
      ).toBe('open');
    },
  );
});

describe('three-way Feishu merge', () => {
  it('combines independent local and remote field edits', () => {
    const base = snapshot();
    const local = snapshot({ title: 'Local title' });
    const remote = snapshot({ notes: 'Remote notes' });

    expect(threeWayMergeFeishuTask(base, local, remote)).toEqual({
      merged: snapshot({ title: 'Local title', notes: 'Remote notes' }),
      localChanges: ['title'],
      remoteChanges: ['notes'],
      conflicts: [],
    });
  });

  it('surfaces a divergent same-field edit instead of overwriting either side', () => {
    const result = threeWayMergeFeishuTask(
      snapshot(),
      snapshot({ title: 'Local title' }),
      snapshot({ title: 'Remote title' }),
    );
    expect(result.merged.title).toBe('Local title');
    expect(result.localChanges).toEqual([]);
    expect(result.remoteChanges).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        field: 'title',
        base: 'Base title',
        local: 'Local title',
        remote: 'Remote title',
      },
    ]);
  });

  it('treats a timestamp and its all-day flag as one conflict-safe time slot', () => {
    const base = snapshot({ startAt: '2026-08-10T00:00:00.000Z' });
    const local = snapshot({
      startAt: '2026-08-10T00:00:00.000Z',
      startAtIsAllDay: true,
    });
    const remote = snapshot({ startAt: '2026-08-11T00:00:00.000Z' });

    const result = threeWayMergeFeishuTask(base, local, remote);
    expect(result.merged).toMatchObject({
      startAt: '2026-08-10T00:00:00.000Z',
      startAtIsAllDay: true,
    });
    expect(result.localChanges).toEqual([]);
    expect(result.remoteChanges).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        field: 'startAt',
        base: '2026-08-10T00:00:00.000Z',
        local: '2026-08-10T00:00:00.000Z',
        remote: '2026-08-11T00:00:00.000Z',
        localIsAllDay: true,
      },
    ]);
  });

  it('writes an all-day-only local change as a start update', () => {
    const base = snapshot({ startAt: '2026-08-10T00:00:00.000Z' });
    const local = snapshot({
      startAt: '2026-08-10T00:00:00.000Z',
      startAtIsAllDay: true,
    });
    const result = threeWayMergeFeishuTask(base, local, base);

    expect(result.localChanges).toEqual(['startAt']);
    expect(buildFeishuPatchPayload(result.merged, result.localChanges)).toEqual({
      task: {
        start: {
          timestamp: String(Date.parse('2026-08-10T00:00:00.000Z')),
          is_all_day: true,
        },
      },
      update_fields: ['start'],
    });
  });
});

describe('FeishuSyncEngine', () => {
  it('pushes local fields, pulls remote fields and preserves private fields', async () => {
    const base = snapshot();
    const localTask = makeTask({
      source: { type: 'feishu', externalId: 'remote-guid' },
      title: 'Local title',
      notes: 'Base notes',
      sync: { status: 'pending' },
    });
    const store = new MemoryTaskStore(localTask, base);
    const client = new FakeFeishuApi();
    client.remote = remoteTask({
      summary: 'Base title',
      description: 'Remote notes',
    });
    const engine = new FeishuSyncEngine({
      client,
      taskStore: store,
      queueStore: new MemoryQueueStore(),
      now: () => NOW,
    });

    const result = await engine.syncTask(localTask.id);
    expect(result.status).toBe('synced');
    expect(client.patches).toEqual([
      { task: { summary: 'Local title' }, update_fields: ['summary'] },
    ]);
    const saved = store.tasks.get(localTask.id)!;
    expect(saved.title).toBe('Local title');
    expect(saved.notes).toBe('Remote notes');
    expect(saved.privateNotes).toBe('PRIVATE JOURNAL ENTRY');
    expect(saved.plannedDate).toBe('2026-08-10');
    expect(store.bases.get(localTask.id)).toMatchObject({
      title: 'Local title',
      notes: 'Remote notes',
    });
  });

  it('marks a same-field conflict and performs no remote write', async () => {
    const base = snapshot();
    const localTask = makeTask({
      source: { type: 'feishu', externalId: 'remote-guid' },
      title: 'Local title',
      notes: 'Base notes',
      sync: { status: 'pending' },
    });
    const store = new MemoryTaskStore(localTask, base);
    const client = new FakeFeishuApi();
    client.remote = remoteTask({
      summary: 'Remote title',
      description: 'Base notes',
    });
    const engine = new FeishuSyncEngine({
      client,
      taskStore: store,
      queueStore: new MemoryQueueStore(),
      now: () => NOW,
    });

    const result = await engine.syncTask(localTask.id);
    expect(result.status).toBe('conflict');
    expect(client.patches).toHaveLength(0);
    expect(store.tasks.get(localTask.id)?.sync).toMatchObject({
      status: 'conflict',
      conflictFields: ['title'],
    });
  });

  it('serializes concurrent syncs for the same task', async () => {
    const task = makeTask({
      source: { type: 'feishu', externalId: 'remote-guid' },
      sync: { status: 'pending' },
    });
    const store = new MemoryTaskStore(task, snapshot({
      title: 'Public title',
      notes: 'Public description',
    }));
    const client = new FakeFeishuApi();
    let active = 0;
    let maximumActive = 0;
    client.getTaskHook = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    };
    const engine = new FeishuSyncEngine({
      client,
      taskStore: store,
      queueStore: new MemoryQueueStore(),
      now: () => NOW,
    });

    await Promise.all([engine.syncTask(task.id), engine.syncTask(task.id)]);
    expect(maximumActive).toBe(1);
  });

  it('persists an idempotent create across offline retries', async () => {
    const task = makeTask();
    const taskStore = new MemoryTaskStore(task);
    const queueStore = new MemoryQueueStore();
    const client = new FakeFeishuApi();
    client.createFailure = new FeishuNetworkError('offline');
    let id = 0;
    const engine = new FeishuSyncEngine({
      client,
      taskStore,
      queueStore,
      accountId: 'account-1',
      now: () => NOW,
      createId: () => `generated-${++id}`,
    });

    const queued = await engine.enqueue(task.id, 'create');
    expect(queued.clientToken).toBe('generated-2');
    await expect(engine.drain()).resolves.toEqual([]);
    expect(queueStore.items).toHaveLength(1);
    expect(queueStore.items[0]).toMatchObject({
      clientToken: 'generated-2',
      attempts: 1,
      lastError: 'offline',
    });
    expect(taskStore.tasks.get(task.id)?.sync.status).toBe('offline');

    client.createFailure = undefined;
    await expect(engine.drain()).resolves.toHaveLength(1);
    expect(client.createTokens).toEqual(['generated-2', 'generated-2']);
    expect(queueStore.items).toEqual([]);
    const saved = taskStore.tasks.get(task.id)!;
    expect(saved.source).toMatchObject({
      type: 'feishu',
      accountId: 'account-1',
      externalId: 'created-remote-guid',
    });
    expect(saved.privateNotes).toBe('PRIVATE JOURNAL ENTRY');
    expect(JSON.stringify(client.createPayloads)).not.toContain('PRIVATE AGENT PLAN');
    expect(queueStore.saves.length).toBeGreaterThanOrEqual(3);
  });
});
