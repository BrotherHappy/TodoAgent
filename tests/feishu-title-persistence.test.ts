// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalStore } from '../electron/services/local-store';
import { TaskService } from '../electron/services/task-service';
import { FeishuStateStore } from '../electron/feishu/feishu-state-store';
import { FeishuTaskAdapter } from '../electron/feishu/feishu-task-adapter';
import { FeishuSyncService, type FeishuApplicationRemoteApi } from '../electron/feishu/feishu-sync-service';
import type { FeishuTaskV2 } from '../src/shared/feishu-types';

it('keeps both real state files readable after incomplete pulls and repairs legacy title loss from disk without a network write', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'todo-feishu-title-persistence-'));
  try {
    const now = () => Date.parse('2026-08-31T10:00:00Z');
    const remotes = new Map<string, FeishuTaskV2>();
    for (let i = 0; i < 8; i++) remotes.set(`remote-${i}`, { guid: `remote-${i}`, summary: `Known task ${i}`, status: 'open', tasklists: [] });
    const forbiddenWrite = vi.fn(async (): Promise<never> => { throw new Error('No remote writes are allowed in title recovery'); });
    const readTask = vi.fn(async (guid: string) => structuredClone(remotes.get(guid)!));
    const remote: FeishuApplicationRemoteApi = {
      listAllTasks: async () => [...remotes.values()].map(task => structuredClone(task)), getTask: readTask,
      createTask: forbiddenWrite, updateTask: forbiddenWrite, deleteTask: forbiddenWrite,
      completeTask: forbiddenWrite, reopenTask: forbiddenWrite, addTaskMembers: forbiddenWrite, removeTaskMembers: forbiddenWrite,
    };
    const open = () => {
      const localStore = new LocalStore(path.join(directory, 'tasks'));
      const taskService = new TaskService(localStore, { clock: () => new Date(now()), timeZone: 'UTC' });
      const stateStore = new FeishuStateStore(path.join(directory, 'feishu'));
      const adapter = new FeishuTaskAdapter({ taskService, localStore, accountId: 'test', now });
      const sync = new FeishuSyncService({ remote, adapter, stateStore, now });
      return { localStore, taskService, stateStore, adapter, sync };
    };
    const first = open();
    await first.taskService.initialize();
    expect((await first.sync.syncNow({ forceFull: true })).pulled).toBe(8);
    const id = (await first.stateStore.load())!.localIdByGuid['remote-2'];
    const before = (await first.taskService.getTask(id))!;
    remotes.set('remote-2', { guid: 'remote-2', summary: '', status: 'open', tasklists: [] });
    const result = await first.sync.syncNow({ forceFull: true });
    expect(result).toMatchObject({ pulled: 7, skippedInvalidTasks: 1 });
    expect(await first.taskService.getTask(id)).toEqual(before);
    expect((await first.stateStore.load())!.mappingsByLocalId[id].base.title).toBe('Known task 2');

    await first.localStore.transact(state => { state.tasks[id].title = ''; });
    const readsBeforeRestart = readTask.mock.calls.length;
    const restarted = open();
    await restarted.sync.initialize();
    expect(readTask).toHaveBeenCalledTimes(readsBeforeRestart);
    expect((await restarted.taskService.getTask(id))?.title).toBe('Known task 2');
    const tasks = await restarted.adapter.listAccountTasks();
    const plan = await restarted.taskService.applyTodayPlan({
      date: '2026-08-31', items: tasks.map(task => ({ id: task.id, estimatedMinutes: 30 })), clearTaskIds: [],
      baselines: tasks.map(({ id: taskId, plannedDate, privateOrder, estimatedMinutes }) => ({ id: taskId, plannedDate, privateOrder, estimatedMinutes })),
    });
    expect(plan.changes).toHaveLength(8);
    expect((await restarted.stateStore.load())!.queue).toEqual([]);
    expect(forbiddenWrite).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
