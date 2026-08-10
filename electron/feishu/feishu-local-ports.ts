import type {
  CreateTaskInput,
  LocalAppState,
  Task,
  TaskFilter,
  TaskMutationResult,
} from '../../src/shared/models';
import type { LocalStore } from '../services/local-store';
import type { TaskService } from '../services/task-service';
import type {
  FeishuLocalStorePort,
  FeishuTaskServicePort,
} from './feishu-task-adapter';

/**
 * Production bridge from the desktop TaskService to the deliberately smaller
 * surface used by Feishu sync. Explicit forwarding keeps method `this`
 * binding intact and prevents the integration layer from depending on the
 * rest of TaskService's API.
 */
export class FeishuTaskServicePortAdapter implements FeishuTaskServicePort {
  constructor(private readonly taskService: TaskService) {}

  getTask(id: string, includeDeleted?: boolean): Promise<Task | undefined> {
    return this.taskService.getTask(id, includeDeleted);
  }

  listTasks(filter?: TaskFilter): Promise<Task[]> {
    return this.taskService.listTasks(filter);
  }

  createTask(input: CreateTaskInput): Promise<TaskMutationResult> {
    return this.taskService.createTask(input);
  }
}

/** Production bridge from LocalStore to Feishu's transactional state port. */
export class FeishuLocalStorePortAdapter implements FeishuLocalStorePort {
  constructor(private readonly localStore: LocalStore) {}

  transact<Result>(
    mutator: (draft: LocalAppState) => Result | Promise<Result>,
  ): Promise<Result> {
    return this.localStore.transact(mutator);
  }
}

export interface CreateFeishuLocalPortsOptions {
  taskService: TaskService;
  /** The LocalStore backing taskService. */
  localStore: LocalStore;
}

export interface FeishuLocalPorts {
  taskService: FeishuTaskServicePort;
  localStore: FeishuLocalStorePort;
}

export interface FeishuPendingMutationTarget {
  accountId?: string;
  notifyLocalUpsert(localId: string): Promise<void>;
  notifyLocalDelete(localId: string): Promise<void>;
  notifyLocalComplete(localId: string, completed?: boolean): Promise<void>;
}

export interface FeishuPendingMutationSyncTarget<Result>
  extends FeishuPendingMutationTarget {
  shouldSync: boolean;
  syncNow(): Promise<Result>;
}

export interface FeishuPendingMutationFlushResult<Result> {
  pendingCount: number;
  syncResult?: Result;
}

/**
 * Converts TaskService's durable pending marker into the matching Feishu queue
 * operation. Keeping this deterministic bridge outside the UI debounce makes
 * it reusable by manual sync and straightforward to regression-test.
 */
export async function enqueuePendingFeishuTaskChanges(
  taskService: Pick<FeishuTaskServicePort, 'listTasks'>,
  target: FeishuPendingMutationTarget,
): Promise<number> {
  const pending = (
    await taskService.listTasks({
      sourceTypes: ['feishu'],
      includeDeleted: true,
    })
  )
    .filter((task) => task.sync.status === 'pending')
    // `type: 'feishu'` alone does not prove which account the user selected.
    // Never infer that an accountless historical task belongs to the current
    // connection: keep it pending until a deliberate migration can bind it.
    .filter(
      (task) =>
        Boolean(target.accountId) && task.source.accountId === target.accountId,
    );

  for (const task of pending) {
    if (task.deletedAt) await target.notifyLocalDelete(task.id);
    else if (task.status === 'completed') {
      await target.notifyLocalComplete(task.id, true);
    } else {
      await target.notifyLocalUpsert(task.id);
    }
  }
  return pending.length;
}

/**
 * Persists every pending Feishu mutation first, then immediately starts one
 * sync pass when the connection's auto-sync policy allows it. When offline or
 * disconnected, the queue remains durable and can be drained later.
 */
export async function flushPendingFeishuTaskChanges<Result>(
  taskService: Pick<FeishuTaskServicePort, 'listTasks'>,
  target: FeishuPendingMutationSyncTarget<Result>,
): Promise<FeishuPendingMutationFlushResult<Result>> {
  const pendingCount = await enqueuePendingFeishuTaskChanges(
    taskService,
    target,
  );
  if (pendingCount === 0 || !target.shouldSync) return { pendingCount };
  return { pendingCount, syncResult: await target.syncNow() };
}

/**
 * Creates the pair that can be spread directly into FeishuRuntimeFactoryOptions.
 */
export function createFeishuLocalPorts(
  options: CreateFeishuLocalPortsOptions,
): FeishuLocalPorts {
  return {
    taskService: new FeishuTaskServicePortAdapter(options.taskService),
    localStore: new FeishuLocalStorePortAdapter(options.localStore),
  };
}
