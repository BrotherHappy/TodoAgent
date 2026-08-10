import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FeishuLocalStorePortAdapter,
  FeishuTaskServicePortAdapter,
  createFeishuLocalPorts,
  enqueuePendingFeishuTaskChanges,
  flushPendingFeishuTaskChanges,
} from '../electron/feishu/feishu-local-ports';
import type {
  FeishuLocalStorePort,
  FeishuTaskServicePort,
} from '../electron/feishu/feishu-task-adapter';
import { LocalStore } from '../electron/services/local-store';
import { TaskService } from '../electron/services/task-service';

const testDirectories: string[] = [];

async function createFixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'todo-agent-feishu-local-ports-'),
  );
  testDirectories.push(directory);

  const counters = { task: 0, operation: 0, draft: 0 };
  const localStore = new LocalStore(directory);
  const taskService = new TaskService(localStore, {
    clock: () => new Date('2026-08-09T10:00:00.000Z'),
    timeZone: 'UTC',
    idGenerator: (prefix) => `${prefix}-${++counters[prefix]}`,
  });
  await taskService.initialize();

  return { localStore, taskService };
}

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Feishu production local port adapters', () => {
  it('exposes TaskService create, list, and deleted-task lookup semantics', async () => {
    const { taskService } = await createFixture();
    const port: FeishuTaskServicePort = new FeishuTaskServicePortAdapter(
      taskService,
    );

    const created = await port.createTask({
      title: '  Synced through the bridge  ',
      source: {
        type: 'feishu',
        accountId: 'work-account',
        externalId: 'remote-task-1',
      },
      sync: { status: 'synced' },
    });

    await expect(port.getTask(created.task.id)).resolves.toMatchObject({
      id: created.task.id,
      title: 'Synced through the bridge',
      source: { type: 'feishu', accountId: 'work-account' },
    });
    await expect(
      port.listTasks({ sourceTypes: ['feishu'], accountIds: ['work-account'] }),
    ).resolves.toHaveLength(1);

    await taskService.moveToTrash(created.task.id);
    await expect(port.getTask(created.task.id)).resolves.toBeUndefined();
    await expect(port.getTask(created.task.id, true)).resolves.toMatchObject({
      id: created.task.id,
      deletedAt: '2026-08-09T10:00:00.000Z',
    });
  });

  it('preserves LocalStore transaction results, persistence, and rollback', async () => {
    const { localStore, taskService } = await createFixture();
    const created = await taskService.createTask({ title: 'Private metadata' });
    const port: FeishuLocalStorePort = new FeishuLocalStorePortAdapter(
      localStore,
    );

    const result = await port.transact((draft) => {
      draft.tasks[created.task.id].privateNotes = 'kept local';
      return { updatedTaskId: created.task.id };
    });

    expect(result).toEqual({ updatedTaskId: created.task.id });
    await expect(taskService.getTask(created.task.id)).resolves.toMatchObject({
      privateNotes: 'kept local',
    });

    await expect(
      port.transact((draft) => {
        draft.tasks[created.task.id].privateNotes = 'must roll back';
        throw new Error('stop transaction');
      }),
    ).rejects.toThrow('stop transaction');
    await expect(taskService.getTask(created.task.id)).resolves.toMatchObject({
      privateNotes: 'kept local',
    });
  });

  it('creates a runtime-ready pair backed by the same production services', async () => {
    const { localStore, taskService } = await createFixture();
    const ports = createFeishuLocalPorts({ taskService, localStore });

    const created = await ports.taskService.createTask({ title: 'Runtime task' });
    await ports.localStore.transact((draft) => {
      draft.tasks[created.task.id].sync.status = 'pending';
    });

    await expect(ports.taskService.getTask(created.task.id)).resolves.toMatchObject(
      {
        title: 'Runtime task',
        sync: { status: 'pending' },
      },
    );
  });

  it('routes durable pending tasks to exact upsert, complete, and delete queue operations', async () => {
    const { taskService } = await createFixture();
    const source = (externalId: string, accountId = 'work-account') => ({
      type: 'feishu' as const,
      accountId,
      externalId,
    });
    const open = (
      await taskService.createTask({
        title: 'Pending update',
        source: source('remote-open'),
        sync: { status: 'pending' },
      })
    ).task;
    const completed = (
      await taskService.createTask({
        title: 'Pending completion',
        source: source('remote-completed'),
        status: 'completed',
        sync: { status: 'pending' },
      })
    ).task;
    const deleted = (
      await taskService.createTask({
        title: 'Pending deletion',
        source: source('remote-deleted'),
        sync: { status: 'synced' },
      })
    ).task;
    await taskService.moveToTrash(deleted.id);
    await taskService.createTask({
      title: 'Different account',
      source: source('remote-other', 'other-account'),
      status: 'completed',
      sync: { status: 'pending' },
    });
    const accountless = (
      await taskService.createTask({
        title: 'Historical task without an account binding',
        // A source label without an account must never be inferred to belong
        // to the currently connected account and uploaded without consent.
        source: { type: 'feishu' },
        sync: { status: 'pending' },
      })
    ).task;

    const calls: Array<
      ['upsert' | 'complete' | 'delete', string, boolean?]
    > = [];
    const count = await enqueuePendingFeishuTaskChanges(taskService, {
      accountId: 'work-account',
      notifyLocalUpsert: async (id) => {
        calls.push(['upsert', id]);
      },
      notifyLocalComplete: async (id, value) => {
        calls.push(['complete', id, value]);
      },
      notifyLocalDelete: async (id) => {
        calls.push(['delete', id]);
      },
    });

    expect(count).toBe(3);
    expect(calls).toEqual([
      ['upsert', open.id],
      ['complete', completed.id, true],
      ['delete', deleted.id],
    ]);
    await expect(taskService.getTask(accountless.id)).resolves.toMatchObject({
      source: { type: 'feishu' },
      sync: { status: 'pending' },
    });
  });

  it('immediately syncs new, completed, and reopened Feishu tasks but never local tasks', async () => {
    const { taskService } = await createFixture();
    const source = (externalId?: string) => ({
      type: 'feishu' as const,
      accountId: 'work-account',
      externalId,
    });
    const created = (
      await taskService.createTask({
        title: 'Create remotely now',
        source: source(),
      })
    ).task;
    const completed = (
      await taskService.createTask({
        title: 'Complete remotely now',
        source: source('remote-complete'),
        sync: { status: 'synced' },
      })
    ).task;
    await taskService.completeTask(completed.id);
    const reopened = (
      await taskService.createTask({
        title: 'Reopen remotely now',
        source: source('remote-reopen'),
        status: 'completed',
        sync: { status: 'synced' },
      })
    ).task;
    await taskService.reopenTask(reopened.id);
    await taskService.createTask({ title: 'Keep this task local' });

    const calls: Array<
      ['upsert' | 'complete' | 'delete' | 'sync', string?, boolean?]
    > = [];
    const result = await flushPendingFeishuTaskChanges(taskService, {
      accountId: 'work-account',
      shouldSync: true,
      notifyLocalUpsert: async (id) => {
        calls.push(['upsert', id]);
      },
      notifyLocalComplete: async (id, value) => {
        calls.push(['complete', id, value]);
      },
      notifyLocalDelete: async (id) => {
        calls.push(['delete', id]);
      },
      syncNow: async () => {
        calls.push(['sync']);
        return 'synced';
      },
    });

    expect(result).toEqual({ pendingCount: 3, syncResult: 'synced' });
    expect(calls).toEqual([
      ['upsert', created.id],
      ['complete', completed.id, true],
      ['upsert', reopened.id],
      ['sync'],
    ]);
  });

  it('keeps Feishu changes queued without a network sync when auto-sync cannot run', async () => {
    const { taskService } = await createFixture();
    const task = (
      await taskService.createTask({
        title: 'Queue while disconnected',
        source: { type: 'feishu', accountId: 'work-account' },
      })
    ).task;
    const calls: string[] = [];

    const result = await flushPendingFeishuTaskChanges(taskService, {
      accountId: 'work-account',
      shouldSync: false,
      notifyLocalUpsert: async (id) => {
        calls.push(`queue:${id}`);
      },
      notifyLocalComplete: async () => undefined,
      notifyLocalDelete: async () => undefined,
      syncNow: async () => {
        calls.push('sync');
        return 'unexpected';
      },
    });

    expect(result).toEqual({ pendingCount: 1 });
    expect(calls).toEqual([`queue:${task.id}`]);
  });
});
