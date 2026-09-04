// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStore } from '../electron/services/local-store';
import { TaskService, TaskValidationError } from '../electron/services/task-service';
import type { ApplyTodayPlanRequest, Task } from '../src/shared/models';

const directories: string[] = [];
const date = '2026-08-31';
const baselines = (tasks: Task[]) => tasks.map(({ id, plannedDate, privateOrder, estimatedMinutes }) => ({ id, plannedDate, privateOrder, estimatedMinutes }));
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'todo-plan-integrity-'));
  directories.push(directory);
  const store = new LocalStore(directory);
  const service = new TaskService(store, { clock: () => new Date(`${date}T10:00:00Z`), timeZone: 'UTC' });
  await service.initialize();
  return { store, service };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function outsidePlan(task: Task) {
  const { plannedDate, privateOrder, estimatedMinutes, updatedAt, ...other } = task;
  return other;
}

describe('private daily planning data integrity', () => {
  it('arranges all eight reviewed tasks despite legacy missing provider titles, preserving every non-plan field and one-click undo', async () => {
    const { store, service } = await fixture();
    const tasks: Task[] = [];
    for (let i = 0; i < 8; i++) tasks.push((await service.createTask({
      title: `Reviewed task ${i}`, source: { type: 'feishu', accountId: 'test', externalId: `remote-${i}` },
      notes: 'Remote public description', privateNotes: 'Private journal',
      sync: { status: 'synced', lastSyncedAt: `${date}T08:00:00Z` },
    })).task);
    // Reproduce the old pull adapter, which could bypass TaskService and
    // persist a provider response with an empty or invisible title.
    await store.transact(state => {
      state.tasks[tasks[2].id].title = '';
      state.tasks[tasks[5].id].title = '  ';
      state.tasks[tasks[6].id].title = '  Keep the remote spelling  ';
    });
    const before = await Promise.all(tasks.map(async task => (await service.getTask(task.id))!));
    const operation = await service.applyTodayPlan({ date, items: before.map(task => ({ id: task.id, estimatedMinutes: 30 })), clearTaskIds: [], baselines: baselines(before) });
    expect(operation.kind).toBe('plan-today');
    expect(operation.changes).toHaveLength(8);
    for (const [index, task] of before.entries()) {
      const after = (await service.getTask(task.id))!;
      expect(after).toMatchObject({ plannedDate: date, privateOrder: index, estimatedMinutes: 30 });
      expect(outsidePlan(after)).toEqual(outsidePlan(task));
    }
    await service.undo(operation.id);
    for (const task of before) expect(await service.getTask(task.id)).toEqual(task);
  });

  it('can clear, move and reorder private plans without renaming an incomplete imported task', async () => {
    const { store, service } = await fixture();
    const { task } = await service.createTask({ title: 'Cached title', plannedDate: date, source: { type: 'feishu' }, sync: { status: 'synced' } });
    await store.transact(state => { state.tasks[task.id].title = ''; });
    const imported = (await service.getTask(task.id))!;
    await service.applyTodayPlan({ date, items: [], clearTaskIds: [task.id], baselines: baselines([imported]) });
    expect((await service.getTask(task.id))?.plannedDate).toBeUndefined();
    await service.moveToToday(task.id, date);
    await service.reorderToday([task.id], date);
    expect(await service.getTask(task.id)).toMatchObject({ title: '', plannedDate: date, privateOrder: 0, sync: { status: 'synced' } });
  });

  it.each([null, {}, { items: null }, { items: [null], clearTaskIds: [], baselines: [] },
    { items: [{ id: 'x', title: 'Must not patch title' }], clearTaskIds: [], baselines: [{ id: 'x', privateOrder: 0 }] },
    { items: [{ id: 'x', estimatedMinutes: '30' }], clearTaskIds: [], baselines: [{ id: 'x', privateOrder: 0 }] },
  ])('rejects malformed plan input before any task or history write: %j', async request => {
    const { store, service } = await fixture();
    await service.createTask({ title: 'Unchanged' });
    const before = await readFile(store.filePath, 'utf8');
    await expect(service.applyTodayPlan(request as unknown as ApplyTodayPlanRequest)).rejects.toBeInstanceOf(TaskValidationError);
    expect(await readFile(store.filePath, 'utf8')).toBe(before);
  });

  it.each(['', '  ', '\u200b', null, undefined, 12])('still rejects blank or non-text titles on create and rename: %j', async title => {
    const { service } = await fixture();
    const task = (await service.createTask({ title: 'Keep me' })).task;
    await expect(service.createTask({ title: title as string })).rejects.toBeInstanceOf(TaskValidationError);
    if (title !== undefined) {
      await expect(service.updateTask(task.id, { title: title as string })).rejects.toBeInstanceOf(TaskValidationError);
      expect((await service.getTask(task.id))?.title).toBe('Keep me');
    }
  });
});
