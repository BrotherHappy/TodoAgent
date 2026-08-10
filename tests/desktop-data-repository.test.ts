// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AuditLog,
  InMemoryAuditStore,
} from '../electron/agent/audit-log';
import { FileAuditStore } from '../electron/agent/file-audit-store';
import {
  DesktopDataRepository,
  DesktopDataRepositoryError,
  type DesktopDataRepositoryErrorCode,
  type DesktopLocalStorePort,
  type DesktopSettingsPort,
} from '../electron/services/desktop-data-repository';
import {
  DataPortabilityService,
  type DataPortabilitySnapshot,
} from '../electron/services/data-portability-service';
import { LocalStore } from '../electron/services/local-store';
import {
  SettingsService,
  type EncryptionAdapter,
} from '../electron/services/settings-service';
import type { AuditRecord } from '../src/shared/agent-types';
import {
  createEmptyLocalAppState,
  type LocalAppState,
  type Task,
} from '../src/shared/models';
import { defaultSettings, type AppSettings } from '../src/shared/settings';

const clone = <Value>(value: Value): Value => structuredClone(value);

const makeTask = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
  id,
  source: { type: 'local' },
  title,
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
  updatedAt: '2026-08-09T00:00:00.000Z',
  ...overrides,
});

const cloneSettings = (): AppSettings => clone(defaultSettings);

class MemoryLocalStore implements DesktopLocalStorePort {
  state: LocalAppState;
  reads = 0;
  transactions = 0;
  failBeforeCommit = 0;
  failAfterCommit = 0;
  onTransactStart?: () => void | Promise<void>;
  afterFailedCommit?: (state: LocalAppState) => LocalAppState;

  constructor(initial: LocalAppState = createEmptyLocalAppState()) {
    this.state = clone(initial);
  }

  async read(): Promise<LocalAppState> {
    this.reads += 1;
    return clone(this.state);
  }

  async transact<Result>(
    mutator: (draft: LocalAppState) => Result | Promise<Result>,
  ): Promise<Result> {
    this.transactions += 1;
    const hook = this.onTransactStart;
    this.onTransactStart = undefined;
    await hook?.();
    const baselineRevision = this.state.revision;
    const draft = clone(this.state);
    const result = await mutator(draft);
    draft.schemaVersion = 1;
    draft.revision = baselineRevision + 1;
    if (this.failBeforeCommit > 0) {
      this.failBeforeCommit -= 1;
      throw new Error('LOCAL_COMMIT_FAILED_BEFORE_PUBLISH');
    }
    this.state = draft;
    if (this.failAfterCommit > 0) {
      this.failAfterCommit -= 1;
      if (this.afterFailedCommit !== undefined) {
        this.state = clone(this.afterFailedCommit(clone(this.state)));
      }
      throw new Error('LOCAL_COMMIT_FAILED_AFTER_PUBLISH');
    }
    return result;
  }
}

class MemorySettings implements DesktopSettingsPort {
  state: AppSettings;
  replaces = 0;
  failAfterReplace = 0;

  constructor(initial: AppSettings = cloneSettings()) {
    this.state = clone(initial);
  }

  get(): AppSettings {
    return clone(this.state);
  }

  async replace(settings: AppSettings): Promise<AppSettings> {
    this.replaces += 1;
    // Mirrors SettingsService: memory changes before the durable write awaits.
    this.state = clone(settings);
    if (this.failAfterReplace > 0) {
      this.failAfterReplace -= 1;
      throw new Error('SETTINGS_DISK_WRITE_FAILED');
    }
    return this.get();
  }
}

const createAuditLog = async (): Promise<AuditLog> => {
  const log = new AuditLog({
    store: new InMemoryAuditStore(),
    now: () => new Date('2026-08-09T12:00:00.000Z'),
  });
  await log.append({
    runId: 'run-1',
    actor: 'system',
    event: 'repository.test.started',
  });
  return log;
};

const createMemoryHarness = async (options: {
  local?: MemoryLocalStore;
  settings?: MemorySettings;
  auditLog?: AuditLog;
} = {}) => {
  const local = options.local ?? new MemoryLocalStore();
  const settings = options.settings ?? new MemorySettings();
  const auditLog = options.auditLog ?? await createAuditLog();
  const repository = new DesktopDataRepository({
    localStore: local,
    settings,
    auditLog,
  });
  return { repository, local, settings, auditLog };
};

const expectErrorCode = async (
  promise: Promise<unknown>,
  code: DesktopDataRepositoryErrorCode,
): Promise<DesktopDataRepositoryError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopDataRepositoryError);
    expect((error as DesktopDataRepositoryError).code).toBe(code);
    return error as DesktopDataRepositoryError;
  }
  throw new Error(`Expected ${code}, but the operation succeeded.`);
};

const encryption: EncryptionAdapter = {
  isAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^encrypted:/u, ''),
};

const testDirectories: string[] = [];

const createTestDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'todo-agent-data-repository-'));
  testDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('DesktopDataRepository production adapters', () => {
  it('reads and durably commits LocalStore, SettingsService, and AuditLog data', async () => {
    const directory = await createTestDirectory();
    const localStore = new LocalStore(path.join(directory, 'local'));
    await localStore.initialize();
    await localStore.transact((state) => {
      state.tasks.current = makeTask('current', 'Current task');
    });
    const settings = new SettingsService(path.join(directory, 'preferences'), encryption);
    await settings.load();
    const configured = settings.get();
    configured.ai.credentialId = 'ai-live-credential';
    configured.feishu.tokenCredentialId = 'feishu-live-token';
    configured.feishu.appSecretCredentialId = 'feishu-live-app-secret';
    await settings.replace(configured);
    const auditStore = new FileAuditStore({ directory: path.join(directory, 'audit') });
    const auditLog = new AuditLog({
      store: auditStore,
      now: () => new Date('2026-08-09T12:00:00.000Z'),
    });
    await auditLog.append({ runId: 'run-1', actor: 'system', event: 'before-import' });
    const repository = new DesktopDataRepository({ localStore, settings, auditLog });

    const before = await repository.readSnapshot();
    expect(before.taskState.tasks.current?.title).toBe('Current task');
    expect(before.permissionAudit).toHaveLength(1);

    const result = await repository.transact((draft) => {
      draft.taskState.tasks.imported = makeTask('imported', 'Imported task');
      draft.settings.theme = 'dark';
      delete draft.settings.ai.credentialId;
      delete draft.settings.feishu.tokenCredentialId;
      delete draft.settings.feishu.appSecretCredentialId;
      return { applied: true };
    });

    expect(result).toEqual({ applied: true });
    const reopenedLocal = new LocalStore(path.join(directory, 'local'));
    const persistedTasks = await reopenedLocal.load();
    expect(persistedTasks.revision).toBe(2);
    expect(persistedTasks.tasks.imported?.title).toBe('Imported task');
    const reopenedSettings = new SettingsService(path.join(directory, 'preferences'), encryption);
    await reopenedSettings.load();
    expect(reopenedSettings.get()).toMatchObject({
      theme: 'dark',
      ai: { credentialId: 'ai-live-credential' },
      feishu: {
        tokenCredentialId: 'feishu-live-token',
        appSecretCredentialId: 'feishu-live-app-secret',
      },
    });
    expect(await auditLog.records()).toEqual(before.permissionAudit);
  });

  it('accepts FileAuditStore directly and returns detached snapshots', async () => {
    const directory = await createTestDirectory();
    const localStore = new LocalStore(path.join(directory, 'local'));
    await localStore.initialize();
    const settings = new SettingsService(path.join(directory, 'preferences'), encryption);
    await settings.load();
    const auditStore = new FileAuditStore({ directory: path.join(directory, 'audit') });
    const writer = new AuditLog({ store: auditStore });
    await writer.append({ runId: 'run-1', actor: 'user', event: 'user-request' });
    const repository = new DesktopDataRepository({ localStore, settings, auditStore });

    const first = await repository.readSnapshot();
    first.taskState.tasks.injected = makeTask('injected', 'Must stay detached');
    first.settings.theme = 'dark';
    first.permissionAudit[0]!.event = 'tampered-copy';
    const second = await repository.readSnapshot();

    expect(second.taskState.tasks.injected).toBeUndefined();
    expect(second.settings.theme).toBe('system');
    expect(second.permissionAudit[0]?.event).toBe('user-request');
  });

  it('executes a digest-pinned DataPortabilityService import through the adapter', async () => {
    const harness = await createMemoryHarness();
    const sourceState: DataPortabilitySnapshot = {
      taskState: createEmptyLocalAppState(),
      settings: cloneSettings(),
      permissionAudit: [],
    };
    sourceState.taskState.tasks.imported = makeTask('imported', 'Portable task');
    const source = new DataPortabilityService({
      repository: {
        readSnapshot: async () => clone(sourceState),
        transact: async () => {
          throw new Error('SOURCE_IS_READ_ONLY');
        },
      },
      now: () => new Date('2026-08-09T12:00:00.000Z'),
    });
    const json = await source.exportJson({
      include: { settings: false, permissionAudit: false },
    });
    const service = new DataPortabilityService({ repository: harness.repository });
    const preview = await service.previewImport(json, 'overwrite');

    const result = await service.importJson(json, {
      strategy: 'overwrite',
      expectedDigest: preview.digest,
    });

    expect(result.tasks.create).toBe(1);
    expect(harness.local.state.tasks.imported?.title).toBe('Portable task');
    expect(harness.local.state.revision).toBe(1);
  });
});

describe('DesktopDataRepository transaction safety', () => {
  it('keeps audit history read-only and rejects replacement before any write', async () => {
    const harness = await createMemoryHarness();

    await expectErrorCode(
      harness.repository.transact((draft) => {
        draft.taskState.tasks.imported = makeTask('imported', 'Must not persist');
        draft.settings.theme = 'dark';
        draft.permissionAudit = [];
      }),
      'AUDIT_READ_ONLY',
    );

    expect(harness.local.transactions).toBe(0);
    expect(harness.local.state.tasks).toEqual({});
    expect(harness.settings.replaces).toBe(0);
    expect(harness.settings.state.theme).toBe('system');
  });

  it('propagates mutator errors unchanged without touching a store', async () => {
    const harness = await createMemoryHarness();
    const domainError = new Error('PREVIEW_DIGEST_MISMATCH');

    await expect(
      harness.repository.transact((draft) => {
        draft.taskState.tasks.imported = makeTask('imported', 'Must not persist');
        throw domainError;
      }),
    ).rejects.toBe(domainError);

    expect(harness.local.transactions).toBe(0);
    expect(harness.settings.replaces).toBe(0);
  });

  it('restores in-memory settings when their durable write rejects', async () => {
    const settings = new MemorySettings();
    settings.failAfterReplace = 1;
    const harness = await createMemoryHarness({ settings });

    await expectErrorCode(
      harness.repository.transact((draft) => {
        draft.taskState.tasks.imported = makeTask('imported', 'Must roll back');
        draft.settings.theme = 'dark';
      }),
      'COMMIT_FAILED',
    );

    expect(harness.settings.state.theme).toBe('system');
    expect(harness.settings.replaces).toBe(2);
    expect(harness.local.state).toEqual(createEmptyLocalAppState());
  });

  it('rolls settings back when task publishing fails before changing the main state', async () => {
    const local = new MemoryLocalStore();
    local.failBeforeCommit = 1;
    const harness = await createMemoryHarness({ local });

    await expectErrorCode(
      harness.repository.transact((draft) => {
        draft.taskState.tasks.imported = makeTask('imported', 'Must roll back');
        draft.settings.theme = 'dark';
      }),
      'COMMIT_FAILED',
    );

    expect(harness.local.state).toEqual(createEmptyLocalAppState());
    expect(harness.settings.state.theme).toBe('system');
    expect(harness.settings.replaces).toBe(2);
  });

  it('compare-and-restores both stores if task publishing reports failure after publish', async () => {
    const local = new MemoryLocalStore();
    local.failAfterCommit = 1;
    const harness = await createMemoryHarness({ local });

    await expectErrorCode(
      harness.repository.transact((draft) => {
        draft.taskState.tasks.imported = makeTask('imported', 'Must roll back');
        draft.settings.theme = 'dark';
      }),
      'COMMIT_FAILED',
    );

    expect(harness.local.state.tasks).toEqual({});
    expect(harness.local.state.revision).toBe(2);
    expect(harness.settings.state.theme).toBe('system');
    expect(harness.settings.replaces).toBe(2);
  });

  it('never overwrites a third-party task change while compensating a failed commit', async () => {
    const local = new MemoryLocalStore();
    local.failAfterCommit = 1;
    local.afterFailedCommit = (state) => {
      state.tasks.external = makeTask('external', 'Concurrent writer wins');
      return state;
    };
    const harness = await createMemoryHarness({ local });

    await expectErrorCode(
      harness.repository.transact((draft) => {
        draft.taskState.tasks.imported = makeTask('imported', 'Partially committed');
        draft.settings.theme = 'dark';
      }),
      'ROLLBACK_FAILED',
    );

    expect(harness.local.state.tasks.external?.title).toBe('Concurrent writer wins');
    expect(harness.local.state.tasks.imported?.title).toBe('Partially committed');
    expect(harness.settings.state.theme).toBe('system');
  });

  it('detects a concurrent settings update before writing and preserves it', async () => {
    const local = new MemoryLocalStore();
    const settings = new MemorySettings();
    local.onTransactStart = () => {
      settings.state.theme = 'dark';
    };
    const harness = await createMemoryHarness({ local, settings });

    await expectErrorCode(
      harness.repository.transact((draft) => {
        draft.taskState.tasks.imported = makeTask('imported', 'Must not overwrite');
      }),
      'CONCURRENT_MODIFICATION',
    );

    expect(harness.settings.state.theme).toBe('dark');
    expect(harness.settings.replaces).toBe(0);
    expect(harness.local.state.tasks).toEqual({});
  });

  it('serializes concurrent repository transactions without dropping either update', async () => {
    const harness = await createMemoryHarness();

    await Promise.all([
      harness.repository.transact(async (draft) => {
        await Promise.resolve();
        draft.taskState.tasks.first = makeTask('first', 'First');
      }),
      harness.repository.transact((draft) => {
        draft.taskState.tasks.second = makeTask('second', 'Second');
      }),
    ]);

    expect(Object.keys(harness.local.state.tasks).sort()).toEqual(['first', 'second']);
    expect(harness.local.state.revision).toBe(2);
  });
});

describe('DesktopDataRepository audit validation', () => {
  it('rejects a tampered FileAuditStore-compatible source before returning a snapshot', async () => {
    const auditLog = await createAuditLog();
    const records = await auditLog.records();
    records[0]!.event = 'tampered';
    const auditStore = {
      readAll: async (): Promise<AuditRecord[]> => clone(records),
    };
    const repository = new DesktopDataRepository({
      localStore: new MemoryLocalStore(),
      settings: new MemorySettings(),
      auditStore,
    });

    await expectErrorCode(repository.readSnapshot(), 'AUDIT_INVALID');
  });

  it('requires exactly one audit source', async () => {
    const auditLog = await createAuditLog();
    const options = {
      localStore: new MemoryLocalStore(),
      settings: new MemorySettings(),
    };

    expect(() => new DesktopDataRepository(options)).toThrow(TypeError);
    expect(() => new DesktopDataRepository({
      ...options,
      auditLog,
      auditStore: { readAll: () => auditLog.records() },
    })).toThrow(TypeError);
  });
});
