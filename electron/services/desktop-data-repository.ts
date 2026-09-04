import { isDeepStrictEqual } from 'node:util';

import type { AuditRecord } from '../../src/shared/agent-types';
import type { LocalAppState } from '../../src/shared/models';
import type { AppSettings } from '../../src/shared/settings';
import { AuditLog, type AuditStore } from '../agent/audit-log';
import type {
  DataPortabilityRepository,
  DataPortabilitySnapshot,
} from './data-portability-service';
import type { LocalStore } from './local-store';
import type { SettingsService } from './settings-service';

export type DesktopDataRepositoryErrorCode =
  | 'SNAPSHOT_READ_FAILED'
  | 'SNAPSHOT_UNSTABLE'
  | 'INVALID_SNAPSHOT'
  | 'AUDIT_INVALID'
  | 'AUDIT_READ_ONLY'
  | 'CONCURRENT_MODIFICATION'
  | 'COMMIT_FAILED'
  | 'ROLLBACK_FAILED';

export class DesktopDataRepositoryError extends Error {
  constructor(
    readonly code: DesktopDataRepositoryErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DesktopDataRepositoryError';
  }
}

export type DesktopLocalStorePort = Pick<LocalStore, 'read' | 'transact'>;
export type DesktopSettingsPort = Pick<SettingsService, 'get' | 'replace'>;
export type DesktopAuditLogPort = Pick<AuditLog, 'records' | 'verify'>;
export type DesktopAuditStorePort = Pick<AuditStore, 'readAll'>;

export interface DesktopDataRepositoryOptions {
  localStore: DesktopLocalStorePort;
  settings: DesktopSettingsPort;
  /** Prefer this when the application's AuditLog instance is available. */
  auditLog?: DesktopAuditLogPort;
  /** FileAuditStore and other AuditStore implementations can be read directly. */
  auditStore?: DesktopAuditStorePort;
  /** Number of attempts used to obtain a cross-store stable read. */
  snapshotRetries?: number;
}

const clone = <Value>(value: Value): Value => structuredClone(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const replaceLocalState = (target: LocalAppState, source: LocalAppState): void => {
  target.schemaVersion = 1;
  // LocalStore owns the revision and increments it after the mutator returns.
  target.tasks = clone(source.tasks);
  target.projects = clone(source.projects ?? {});
  target.lists = clone(source.lists ?? {});
  target.drafts = clone(source.drafts);
  target.operations = clone(source.operations);
};

const preserveCredentialReferences = (
  candidate: AppSettings,
  current: AppSettings,
): AppSettings => {
  const next = clone(candidate);
  if (current.ai.credentialId === undefined) delete next.ai.credentialId;
  else next.ai.credentialId = current.ai.credentialId;

  if (current.feishu.tokenCredentialId === undefined) delete next.feishu.tokenCredentialId;
  else next.feishu.tokenCredentialId = current.feishu.tokenCredentialId;

  if (current.feishu.appSecretCredentialId === undefined) {
    delete next.feishu.appSecretCredentialId;
  } else {
    next.feishu.appSecretCredentialId = current.feishu.appSecretCredentialId;
  }
  return next;
};

const assertSnapshotShape = (snapshot: DataPortabilitySnapshot): void => {
  const taskState: unknown = snapshot.taskState;
  const settings: unknown = snapshot.settings;
  if (
    !isRecord(taskState) ||
    taskState.schemaVersion !== 1 ||
    !Number.isSafeInteger(taskState.revision) ||
    Number(taskState.revision) < 0 ||
    !isRecord(taskState.tasks) ||
    (taskState.projects !== undefined && !isRecord(taskState.projects)) ||
    (taskState.lists !== undefined && !isRecord(taskState.lists)) ||
    !isRecord(taskState.drafts) ||
    !Array.isArray(taskState.operations) ||
    !isRecord(settings) ||
    settings.schemaVersion !== 1 ||
    !isRecord(settings.ai) ||
    !isRecord(settings.feishu) ||
    !Array.isArray(snapshot.permissionAudit)
  ) {
    throw new DesktopDataRepositoryError(
      'INVALID_SNAPSHOT',
      'The data transaction produced an invalid snapshot shape.',
    );
  }
  try {
    JSON.stringify(snapshot);
    structuredClone(snapshot);
  } catch (error) {
    throw new DesktopDataRepositoryError(
      'INVALID_SNAPSHOT',
      'The data transaction produced a non-serializable snapshot.',
      error,
    );
  }
};

const expectedCommittedState = (
  baseline: LocalAppState,
  desired: LocalAppState,
): LocalAppState => ({
  schemaVersion: 1,
  revision: baseline.revision + 1,
  tasks: clone(desired.tasks),
  projects: clone(desired.projects ?? {}),
  lists: clone(desired.lists ?? {}),
  drafts: clone(desired.drafts),
  operations: clone(desired.operations),
});

/**
 * Bridges the three production stores used by portable-data import/export.
 *
 * Audit records are intentionally read-only. AuditStore only exposes append,
 * and replacing its hash chain would be neither atomic nor an honest audit
 * operation. A transaction attempting to change the chain fails before any
 * task or settings write.
 *
 * LocalStore provides the serialization lock and atomic task-state publish.
 * Settings are committed while that lock is held. Since the two stores do not
 * share a database transaction, failures use compare-and-restore compensation;
 * rollback never overwrites data that another writer changed in the meantime.
 */
export class DesktopDataRepository implements DataPortabilityRepository {
  readonly auditPolicy = 'read-only-preserve' as const;

  readonly #localStore: DesktopLocalStorePort;
  readonly #settings: DesktopSettingsPort;
  readonly #readAuditRecords: () => Promise<AuditRecord[]>;
  readonly #verifyAuditRecords: (records: AuditRecord[]) => Promise<boolean>;
  readonly #snapshotRetries: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: DesktopDataRepositoryOptions) {
    if ((options.auditLog === undefined) === (options.auditStore === undefined)) {
      throw new TypeError('Exactly one of auditLog or auditStore is required.');
    }
    if (
      !Number.isSafeInteger(options.snapshotRetries ?? 3) ||
      (options.snapshotRetries ?? 3) < 1
    ) {
      throw new TypeError('snapshotRetries must be a positive safe integer.');
    }
    this.#localStore = options.localStore;
    this.#settings = options.settings;
    this.#snapshotRetries = options.snapshotRetries ?? 3;

    if (options.auditLog !== undefined) {
      this.#readAuditRecords = () => options.auditLog!.records();
      this.#verifyAuditRecords = async (records) =>
        (await options.auditLog!.verify(records)).valid;
    } else {
      const store = options.auditStore!;
      const verifier = new AuditLog({
        store: {
          readAll: () => store.readAll(),
          append: async () => {
            throw new Error('AUDIT_READ_ONLY');
          },
        },
      });
      this.#readAuditRecords = () => store.readAll();
      this.#verifyAuditRecords = async (records) => (await verifier.verify(records)).valid;
    }
  }

  readSnapshot(): Promise<DataPortabilitySnapshot> {
    return this.#enqueue(() => this.#readStableSnapshot());
  }

  transact<Result>(
    mutator: (draft: DataPortabilitySnapshot) => Result | Promise<Result>,
  ): Promise<Result> {
    return this.#enqueue(() => this.#transact(mutator));
  }

  async #transact<Result>(
    mutator: (draft: DataPortabilitySnapshot) => Result | Promise<Result>,
  ): Promise<Result> {
    const baseline = await this.#readStableSnapshot();
    const draft = clone(baseline);

    // Deliberately outside the commit try/catch: domain errors such as preview
    // digest mismatches must retain their original type, and no write exists to
    // compensate when a mutator rejects.
    const result = await mutator(draft);
    assertSnapshotShape(draft);

    if (!isDeepStrictEqual(draft.permissionAudit, baseline.permissionAudit)) {
      throw new DesktopDataRepositoryError(
        'AUDIT_READ_ONLY',
        'Permission audit history is append-only and cannot be replaced by import.',
      );
    }

    draft.taskState.schemaVersion = 1;
    draft.taskState.revision = baseline.taskState.revision;
    draft.settings = preserveCredentialReferences(draft.settings, baseline.settings);
    const taskChanged = !isDeepStrictEqual(draft.taskState, baseline.taskState);
    const settingsChanged = !isDeepStrictEqual(draft.settings, baseline.settings);
    if (!taskChanged && !settingsChanged) return result;

    const committedTaskState = expectedCommittedState(baseline.taskState, draft.taskState);
    let settingsAttempted = false;
    let taskWriteStarted = false;

    try {
      await this.#localStore.transact(async (currentTaskState) => {
        if (!isDeepStrictEqual(currentTaskState, baseline.taskState)) {
          throw new DesktopDataRepositoryError(
            'CONCURRENT_MODIFICATION',
            'Task data changed while the data transaction was being prepared.',
          );
        }
        await this.#assertSideStoresUnchanged(baseline);

        if (settingsChanged) {
          // SettingsService mutates its in-memory value before awaiting disk, so
          // this flag must be set before invoking replace.
          settingsAttempted = true;
          const persisted = await this.#settings.replace(clone(draft.settings));
          if (
            !isDeepStrictEqual(persisted, draft.settings) ||
            !isDeepStrictEqual(this.#settings.get(), draft.settings)
          ) {
            throw new Error('SETTINGS_COMMIT_MISMATCH');
          }
        }

        taskWriteStarted = true;
        replaceLocalState(currentTaskState, draft.taskState);
      });
    } catch (commitError) {
      const rollbackErrors: unknown[] = [];
      if (taskWriteStarted) {
        try {
          await this.#rollbackTaskState(baseline.taskState, committedTaskState);
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      if (settingsAttempted) {
        try {
          await this.#rollbackSettings(baseline.settings, draft.settings);
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new DesktopDataRepositoryError(
          'ROLLBACK_FAILED',
          'The data transaction failed and could not be safely restored.',
          new AggregateError([commitError, ...rollbackErrors]),
        );
      }
      if (commitError instanceof DesktopDataRepositoryError) throw commitError;
      throw new DesktopDataRepositoryError(
        'COMMIT_FAILED',
        'The data transaction failed; the previous data was restored.',
        commitError,
      );
    }
    return result;
  }

  async #readStableSnapshot(): Promise<DataPortabilitySnapshot> {
    try {
      for (let attempt = 0; attempt < this.#snapshotRetries; attempt += 1) {
        const taskBefore = await this.#localStore.read();
        const settingsBefore = this.#settings.get();
        const permissionAudit = await this.#readVerifiedAudit();
        const settingsAfter = this.#settings.get();
        const taskAfter = await this.#localStore.read();
        if (
          isDeepStrictEqual(taskBefore, taskAfter) &&
          isDeepStrictEqual(settingsBefore, settingsAfter)
        ) {
          const value = {
            taskState: clone(taskAfter),
            settings: clone(settingsAfter),
            permissionAudit: clone(permissionAudit),
          };
          assertSnapshotShape(value);
          return value;
        }
      }
    } catch (error) {
      if (error instanceof DesktopDataRepositoryError) throw error;
      throw new DesktopDataRepositoryError(
        'SNAPSHOT_READ_FAILED',
        'Unable to read the desktop data snapshot.',
        error,
      );
    }
    throw new DesktopDataRepositoryError(
      'SNAPSHOT_UNSTABLE',
      'Desktop data kept changing while a consistent snapshot was being read.',
    );
  }

  async #readVerifiedAudit(): Promise<AuditRecord[]> {
    const records = await this.#readAuditRecords();
    if (!(await this.#verifyAuditRecords(records))) {
      throw new DesktopDataRepositoryError(
        'AUDIT_INVALID',
        'The permission audit hash chain is invalid.',
      );
    }
    return clone(records);
  }

  async #assertSideStoresUnchanged(baseline: DataPortabilitySnapshot): Promise<void> {
    if (!isDeepStrictEqual(this.#settings.get(), baseline.settings)) {
      throw new DesktopDataRepositoryError(
        'CONCURRENT_MODIFICATION',
        'Settings changed while the data transaction was being prepared.',
      );
    }
    const audit = await this.#readVerifiedAudit();
    if (!isDeepStrictEqual(audit, baseline.permissionAudit)) {
      throw new DesktopDataRepositoryError(
        'CONCURRENT_MODIFICATION',
        'Audit history changed while the data transaction was being prepared.',
      );
    }
    if (!isDeepStrictEqual(this.#settings.get(), baseline.settings)) {
      throw new DesktopDataRepositoryError(
        'CONCURRENT_MODIFICATION',
        'Settings changed while the data transaction was being prepared.',
      );
    }
  }

  async #rollbackTaskState(
    baseline: LocalAppState,
    committed: LocalAppState,
  ): Promise<void> {
    const current = await this.#localStore.read();
    if (isDeepStrictEqual(current, baseline)) return;
    if (!isDeepStrictEqual(current, committed)) {
      throw new DesktopDataRepositoryError(
        'CONCURRENT_MODIFICATION',
        'Task rollback was skipped because another writer changed the data.',
      );
    }
    await this.#localStore.transact((draft) => {
      if (!isDeepStrictEqual(draft, committed)) {
        throw new DesktopDataRepositoryError(
          'CONCURRENT_MODIFICATION',
          'Task rollback was skipped because another writer changed the data.',
        );
      }
      replaceLocalState(draft, baseline);
    });
    const restored = await this.#localStore.read();
    if (
      !isDeepStrictEqual(restored.tasks, baseline.tasks) ||
      !isDeepStrictEqual(restored.drafts, baseline.drafts) ||
      !isDeepStrictEqual(restored.operations, baseline.operations)
    ) {
      throw new Error('TASK_ROLLBACK_MISMATCH');
    }
  }

  async #rollbackSettings(baseline: AppSettings, attempted: AppSettings): Promise<void> {
    const current = this.#settings.get();
    if (isDeepStrictEqual(current, baseline)) return;
    if (!isDeepStrictEqual(current, attempted)) {
      throw new DesktopDataRepositoryError(
        'CONCURRENT_MODIFICATION',
        'Settings rollback was skipped because another writer changed the data.',
      );
    }
    const restored = await this.#settings.replace(clone(baseline));
    if (
      !isDeepStrictEqual(restored, baseline) ||
      !isDeepStrictEqual(this.#settings.get(), baseline)
    ) {
      throw new Error('SETTINGS_ROLLBACK_MISMATCH');
    }
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
