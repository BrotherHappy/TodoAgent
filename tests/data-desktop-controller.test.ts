// @vitest-environment node

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DataDesktopController,
  DataDesktopControllerError,
  type DataDesktopClock,
  type DataDesktopDialogPort,
  type DataDesktopErrorCode,
  type DataDesktopFilePort,
  type DataFileInfo,
} from '../electron/services/data-desktop-controller';
import {
  DataPortabilityService,
  type DataPortabilityRepository,
  type DataPortabilitySnapshot,
  type ImportConflictStrategy,
} from '../electron/services/data-portability-service';
import { createEmptyLocalAppState, type Task } from '../src/shared/models';
import { defaultSettings } from '../src/shared/settings';

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

const snapshot = (tasks: Task[] = []): DataPortabilitySnapshot => {
  const taskState = createEmptyLocalAppState();
  taskState.tasks = Object.fromEntries(tasks.map((task) => [task.id, clone(task)]));
  return {
    taskState,
    settings: clone(defaultSettings),
    permissionAudit: [],
  };
};

class MemoryRepository implements DataPortabilityRepository {
  state: DataPortabilitySnapshot;
  reads = 0;
  commits = 0;
  failCommit = false;

  constructor(initial: DataPortabilitySnapshot) {
    this.state = clone(initial);
  }

  async readSnapshot(): Promise<DataPortabilitySnapshot> {
    this.reads += 1;
    return clone(this.state);
  }

  async transact<Result>(
    mutator: (draft: DataPortabilitySnapshot) => Result | Promise<Result>,
  ): Promise<Result> {
    const draft = clone(this.state);
    const result = await mutator(draft);
    if (this.failCommit) throw new Error('ATOMIC_COMMIT_FAILED');
    this.state = draft;
    this.commits += 1;
    return result;
  }
}

interface MemoryFileEntry {
  kind: DataFileInfo['kind'];
  contents: string;
}

const systemError = (code: string, message = code): Error & { code: string } =>
  Object.assign(new Error(message), { code });

class MemoryFiles implements DataDesktopFilePort {
  readonly entries = new Map<string, MemoryFileEntry>();
  readonly infoOverrides = new Map<string, DataFileInfo>();
  readonly statErrors = new Map<string, unknown>();
  readonly readErrors = new Map<string, unknown>();
  readonly operations: string[] = [];
  readonly statCalls: string[] = [];
  readonly readCalls: Array<{ filePath: string; maxBytes: number }> = [];
  replaceError?: unknown;
  writeError?: unknown;

  setFile(filePath: string, contents: string): void {
    this.entries.set(filePath, { kind: 'file', contents });
  }

  setDirectory(filePath: string): void {
    this.entries.set(filePath, { kind: 'directory', contents: '' });
  }

  contents(filePath: string): string | undefined {
    return this.entries.get(filePath)?.contents;
  }

  async stat(filePath: string): Promise<DataFileInfo> {
    this.statCalls.push(filePath);
    const failure = this.statErrors.get(filePath);
    if (failure !== undefined) throw failure;
    const override = this.infoOverrides.get(filePath);
    if (override !== undefined) return clone(override);
    const entry = this.entries.get(filePath);
    if (entry === undefined) throw systemError('ENOENT');
    return {
      kind: entry.kind,
      size: Buffer.byteLength(entry.contents, 'utf8'),
    };
  }

  async readText(filePath: string, maxBytes: number): Promise<string> {
    this.readCalls.push({ filePath, maxBytes });
    const failure = this.readErrors.get(filePath);
    if (failure !== undefined) throw failure;
    const entry = this.entries.get(filePath);
    if (entry === undefined) throw systemError('ENOENT');
    if (entry.kind !== 'file') throw systemError('EISDIR');
    if (Buffer.byteLength(entry.contents, 'utf8') > maxBytes) throw systemError('EFBIG');
    return entry.contents;
  }

  async writeTextDurable(filePath: string, contents: string): Promise<void> {
    this.operations.push(`write:${filePath}`);
    if (this.writeError !== undefined) throw this.writeError;
    if (this.entries.has(filePath)) throw systemError('EEXIST');
    this.entries.set(filePath, { kind: 'file', contents });
  }

  async replaceFile(sourcePath: string, targetPath: string): Promise<void> {
    this.operations.push(`replace:${sourcePath}->${targetPath}`);
    if (this.replaceError !== undefined) throw this.replaceError;
    const source = this.entries.get(sourcePath);
    if (source === undefined) throw systemError('ENOENT');
    this.entries.set(targetPath, clone(source));
    this.entries.delete(sourcePath);
  }

  async removeFile(filePath: string): Promise<void> {
    this.operations.push(`remove:${filePath}`);
    this.entries.delete(filePath);
  }
}

class MemoryDialogs implements DataDesktopDialogPort {
  exportSelection?: string;
  importSelection?: string;
  exportCalls = 0;
  importCalls = 0;

  async chooseExportPath(): Promise<string | undefined> {
    this.exportCalls += 1;
    return this.exportSelection;
  }

  async chooseImportPath(): Promise<string | undefined> {
    this.importCalls += 1;
    return this.importSelection;
  }
}

class MutableClock implements DataDesktopClock {
  #milliseconds = Date.parse('2026-08-09T12:00:00.000Z');

  now(): Date {
    return new Date(this.#milliseconds);
  }

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }
}

interface HarnessOptions {
  initial?: DataPortabilitySnapshot;
  files?: MemoryFiles;
  dialogs?: MemoryDialogs;
  clock?: MutableClock;
  createToken?: () => string;
  maxImportBytes?: number;
  maxExportBytes?: number;
  previewTtlMs?: number;
  maxPendingPreviews?: number;
}

const createHarness = (options: HarnessOptions = {}) => {
  const repository = new MemoryRepository(options.initial ?? snapshot());
  const files = options.files ?? new MemoryFiles();
  const dialogs = options.dialogs ?? new MemoryDialogs();
  const clock = options.clock ?? new MutableClock();
  let tokenSequence = 0;
  const controller = new DataDesktopController({
    dataRepository: repository,
    files,
    dialogs,
    clock,
    createToken: options.createToken ?? (() => {
      tokenSequence += 1;
      return `desktop-token-${String(tokenSequence).padStart(16, '0')}`;
    }),
    createCopyId: (kind, originalId, attempt) =>
      `${kind}-copy-${originalId}-${attempt}`,
    maxImportBytes: options.maxImportBytes,
    maxExportBytes: options.maxExportBytes,
    previewTtlMs: options.previewTtlMs,
    maxPendingPreviews: options.maxPendingPreviews,
  });
  return { controller, repository, files, dialogs, clock };
};

const portableJson = async (tasks: Task[]): Promise<string> => {
  const repository = new MemoryRepository(snapshot(tasks));
  return new DataPortabilityService({
    repository,
    now: () => new Date('2026-08-09T12:00:00.000Z'),
  }).exportJson({ include: { settings: false, permissionAudit: false } });
};

const expectErrorCode = async (
  promise: Promise<unknown>,
  code: DataDesktopErrorCode,
): Promise<DataDesktopControllerError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DataDesktopControllerError);
    expect((error as DataDesktopControllerError).code).toBe(code);
    return error as DataDesktopControllerError;
  }
  throw new Error(`Expected ${code}, but the operation succeeded.`);
};

const readyPreview = async (
  controller: DataDesktopController,
  filePath: string,
) => {
  const result = await controller.previewImport(filePath);
  if (result.status !== 'ready') throw new Error('Expected a ready preview.');
  return result;
};

describe('DataDesktopController export files', () => {
  it('adds the default extension and publishes through a same-directory atomic replacement', async () => {
    const harness = createHarness({
      initial: snapshot([makeTask('task-1', 'Export me')]),
    });
    const selectedPath = '/tmp/todo-agent-backups/sunday';

    const result = await harness.controller.exportToFile(
      { pretty: false, include: { permissionAudit: false } },
      selectedPath,
    );

    expect(result).toMatchObject({
      status: 'exported',
      filePath: `${selectedPath}.todo-agent.json`,
    });
    if (result.status !== 'exported') throw new Error('Expected an exported result.');
    const exported = harness.files.contents(result.filePath);
    expect(exported).toBeDefined();
    const bundle = JSON.parse(exported ?? '{}');
    expect(bundle.data.tasks[0].title).toBe('Export me');
    expect(bundle.data.settings.ai.authMode).toBe('bearer');
    expect(result.bytes).toBe(Buffer.byteLength(exported ?? '', 'utf8'));

    expect(harness.files.operations).toHaveLength(2);
    const writePath = harness.files.operations[0]?.slice('write:'.length);
    expect(path.dirname(writePath ?? '')).toBe(path.dirname(result.filePath));
    expect(path.basename(writePath ?? '')).toMatch(/^\.sunday\.todo-agent\.json\..+\.tmp$/);
    expect(harness.files.operations[1]).toBe(`replace:${writePath}->${result.filePath}`);
    expect(harness.files.entries.has(writePath ?? '')).toBe(false);
  });

  it('returns a side-effect-free cancellation before reading current data', async () => {
    const harness = createHarness({ initial: snapshot([makeTask('task-1', 'Untouched')]) });

    await expect(harness.controller.exportToFile()).resolves.toEqual({ status: 'cancelled' });

    expect(harness.dialogs.exportCalls).toBe(1);
    expect(harness.repository.reads).toBe(0);
    expect(harness.files.operations).toEqual([]);
  });

  it('preserves the previous target and cleans its temporary file when replacement fails', async () => {
    const harness = createHarness({ initial: snapshot([makeTask('task-1', 'New export')]) });
    const targetPath = '/tmp/todo-agent-backups/existing.json';
    harness.files.setFile(targetPath, 'old-data-that-must-survive');
    harness.files.replaceError = systemError('EIO');

    await expectErrorCode(
      harness.controller.exportToFile({}, targetPath),
      'EXPORT_WRITE_FAILED',
    );

    expect(harness.files.contents(targetPath)).toBe('old-data-that-must-survive');
    const temporaryPath = harness.files.operations
      .find((operation) => operation.startsWith('write:'))
      ?.slice('write:'.length);
    expect(temporaryPath).toBeDefined();
    expect(harness.files.entries.has(temporaryPath ?? '')).toBe(false);
    expect(harness.files.operations.at(-1)).toBe(`remove:${temporaryPath}`);
  });

  it('never removes an unrelated file when exclusive temporary creation finds a collision', async () => {
    const token = 'collision-token-0000000000';
    const harness = createHarness({
      initial: snapshot([makeTask('task-1', 'Export')]),
      createToken: () => token,
    });
    const targetPath = '/tmp/todo-agent-backups/collision.json';
    const temporaryPath = `/tmp/todo-agent-backups/.collision.json.${token}.tmp`;
    harness.files.setFile(temporaryPath, 'unrelated-existing-data');

    await expectErrorCode(
      harness.controller.exportToFile({}, targetPath),
      'EXPORT_WRITE_FAILED',
    );

    expect(harness.files.contents(temporaryPath)).toBe('unrelated-existing-data');
    expect(harness.files.contents(targetPath)).toBeUndefined();
    expect(harness.files.operations).toEqual([`write:${temporaryPath}`]);
  });

  it('rejects unsafe paths, unsupported extensions, and oversized exports before writing', async () => {
    const harness = createHarness({
      initial: snapshot([makeTask('task-1', 'Large enough')]),
      maxExportBytes: 32,
    });

    await expectErrorCode(harness.controller.exportToFile({}, 'relative.json'), 'INVALID_PATH');
    await expectErrorCode(harness.controller.exportToFile({}, path.parse('/').root), 'INVALID_PATH');
    await expectErrorCode(
      harness.controller.exportToFile({}, '/tmp/todo-agent-backup.exe'),
      'INVALID_EXTENSION',
    );
    await expectErrorCode(
      harness.controller.exportToFile({}, '/tmp/todo-agent-backup.json'),
      'FILE_TOO_LARGE',
    );
    expect(harness.files.operations).toEqual([]);
  });
});

describe('DataDesktopController import file boundary', () => {
  it('returns conflict previews for every supported strategy from one selected file', async () => {
    const importedJson = await portableJson([makeTask('task-1', 'Imported title')]);
    const harness = createHarness({
      initial: snapshot([makeTask('task-1', 'Current title')]),
    });
    const filePath = '/tmp/imports/tasks.todo-agent.json';
    harness.files.setFile(filePath, importedJson);

    const preview = await readyPreview(harness.controller, filePath);

    expect(preview.filePath).toBe(filePath);
    expect(preview.bytes).toBe(Buffer.byteLength(importedJson, 'utf8'));
    expect(preview.previewToken.length).toBeGreaterThanOrEqual(16);
    expect(preview.strategies.skip).toMatchObject({
      strategy: 'skip',
      tasks: { incoming: 1, skip: 1 },
    });
    expect(preview.strategies.overwrite).toMatchObject({
      strategy: 'overwrite',
      tasks: { incoming: 1, overwrite: 1 },
    });
    expect(preview.strategies.copy).toMatchObject({
      strategy: 'copy',
      tasks: { incoming: 1, copy: 1 },
    });
    expect(harness.repository.reads).toBe(3);
    expect(harness.files.readCalls).toEqual([{ filePath, maxBytes: 25 * 1024 * 1024 }]);
  });

  it('supports import-dialog cancellation without touching files or data', async () => {
    const harness = createHarness();

    await expect(harness.controller.previewImport()).resolves.toEqual({ status: 'cancelled' });

    expect(harness.dialogs.importCalls).toBe(1);
    expect(harness.files.statCalls).toEqual([]);
    expect(harness.repository.reads).toBe(0);
  });

  it('maps extension, kind, size, absence, permission, and schema failures to stable codes', async () => {
    const validJson = await portableJson([makeTask('task-1', 'Imported')]);
    const harness = createHarness({ maxImportBytes: Buffer.byteLength(validJson, 'utf8') - 1 });

    await expectErrorCode(
      harness.controller.previewImport('/tmp/imports/tasks.txt'),
      'INVALID_EXTENSION',
    );
    expect(harness.files.statCalls).toEqual([]);

    const missingPath = '/tmp/imports/missing.json';
    await expectErrorCode(harness.controller.previewImport(missingPath), 'FILE_NOT_FOUND');

    const deniedPath = '/tmp/imports/denied.json';
    harness.files.statErrors.set(deniedPath, systemError('EACCES'));
    await expectErrorCode(harness.controller.previewImport(deniedPath), 'FILE_ACCESS_DENIED');

    const directoryPath = '/tmp/imports/directory.json';
    harness.files.setDirectory(directoryPath);
    await expectErrorCode(harness.controller.previewImport(directoryPath), 'FILE_NOT_REGULAR');

    const oversizedPath = '/tmp/imports/oversized.json';
    harness.files.setFile(oversizedPath, validJson);
    await expectErrorCode(harness.controller.previewImport(oversizedPath), 'FILE_TOO_LARGE');
    expect(harness.files.readCalls.some(({ filePath }) => filePath === oversizedPath)).toBe(false);

    const invalidPath = '/tmp/imports/invalid.json';
    harness.files.setFile(invalidPath, '{"not":"a portable bundle"}');
    await expectErrorCode(harness.controller.previewImport(invalidPath), 'IMPORT_INVALID');

    expect(harness.repository.commits).toBe(0);
  });
});

describe('DataDesktopController preview authorization', () => {
  it('commits the selected strategy once and ignores mutations to the returned preview object', async () => {
    const importedJson = await portableJson([makeTask('task-1', 'Imported title')]);
    const harness = createHarness({
      initial: snapshot([makeTask('task-1', 'Current title')]),
    });
    const filePath = '/tmp/imports/overwrite.json';
    harness.files.setFile(filePath, importedJson);
    const preview = await readyPreview(harness.controller, filePath);
    preview.strategies.overwrite.digest = 'tampered-by-renderer';

    const committed = await harness.controller.commitImport(
      preview.previewToken,
      'overwrite',
    );

    expect(committed.status).toBe('imported');
    expect(committed.result.tasks.overwrite).toBe(1);
    expect(harness.repository.state.taskState.tasks['task-1']?.title).toBe('Imported title');
    expect(harness.repository.commits).toBe(1);
    await expectErrorCode(
      harness.controller.commitImport(preview.previewToken, 'overwrite'),
      'PREVIEW_ALREADY_USED',
    );
    expect(harness.repository.commits).toBe(1);
  });

  it('keeps the previewed bytes even if the selected file changes before commit', async () => {
    const originalJson = await portableJson([makeTask('task-1', 'Previewed title')]);
    const changedJson = await portableJson([makeTask('task-1', 'Changed on disk')]);
    const harness = createHarness();
    const filePath = '/tmp/imports/toctou.json';
    harness.files.setFile(filePath, originalJson);
    const preview = await readyPreview(harness.controller, filePath);
    harness.files.setFile(filePath, changedJson);

    await harness.controller.commitImport(preview.previewToken, 'overwrite');

    expect(harness.repository.state.taskState.tasks['task-1']?.title).toBe('Previewed title');
    expect(harness.files.readCalls).toHaveLength(1);
  });

  it('rejects stale previews, consumes them before failure, and leaves data uncommitted', async () => {
    const importedJson = await portableJson([makeTask('task-1', 'Imported title')]);
    const harness = createHarness();
    const filePath = '/tmp/imports/stale.json';
    harness.files.setFile(filePath, importedJson);
    const preview = await readyPreview(harness.controller, filePath);
    harness.repository.state.taskState.tasks.concurrent = makeTask(
      'concurrent',
      'Created after preview',
    );

    await expectErrorCode(
      harness.controller.commitImport(preview.previewToken, 'overwrite'),
      'PREVIEW_STALE',
    );
    expect(harness.repository.commits).toBe(0);
    expect(harness.repository.state.taskState.tasks['task-1']).toBeUndefined();
    await expectErrorCode(
      harness.controller.commitImport(preview.previewToken, 'overwrite'),
      'PREVIEW_ALREADY_USED',
    );
  });

  it('does not consume a preview for an invalid strategy, but does consume it on commit failure', async () => {
    const importedJson = await portableJson([makeTask('task-1', 'Imported')]);
    const harness = createHarness();
    const filePath = '/tmp/imports/failure.json';
    harness.files.setFile(filePath, importedJson);
    const preview = await readyPreview(harness.controller, filePath);

    await expectErrorCode(
      harness.controller.commitImport(
        preview.previewToken,
        'merge' as ImportConflictStrategy,
      ),
      'INVALID_STRATEGY',
    );
    harness.repository.failCommit = true;
    await expectErrorCode(
      harness.controller.commitImport(preview.previewToken, 'overwrite'),
      'IMPORT_COMMIT_FAILED',
    );
    expect(harness.repository.commits).toBe(0);
    await expectErrorCode(
      harness.controller.commitImport(preview.previewToken, 'overwrite'),
      'PREVIEW_ALREADY_USED',
    );
  });

  it('cancels a preview without a transaction and reports cancellation on later use', async () => {
    const importedJson = await portableJson([makeTask('task-1', 'Imported')]);
    const harness = createHarness();
    const filePath = '/tmp/imports/cancel.json';
    harness.files.setFile(filePath, importedJson);
    const preview = await readyPreview(harness.controller, filePath);

    expect(harness.controller.cancelPreview(preview.previewToken)).toBe(true);
    expect(harness.controller.cancelPreview(preview.previewToken)).toBe(false);
    expect(harness.repository.commits).toBe(0);
    await expectErrorCode(
      harness.controller.commitImport(preview.previewToken, 'skip'),
      'PREVIEW_CANCELLED',
    );
    expect(harness.repository.commits).toBe(0);
  });

  it('expires previews at the TTL boundary and distinguishes unknown tokens', async () => {
    const importedJson = await portableJson([makeTask('task-1', 'Imported')]);
    const harness = createHarness({ previewTtlMs: 1_000 });
    const filePath = '/tmp/imports/expiry.json';
    harness.files.setFile(filePath, importedJson);
    const preview = await readyPreview(harness.controller, filePath);
    harness.clock.advance(1_000);

    await expectErrorCode(
      harness.controller.commitImport(preview.previewToken, 'skip'),
      'PREVIEW_EXPIRED',
    );
    await expectErrorCode(
      harness.controller.commitImport('unknown-preview-token', 'skip'),
      'PREVIEW_NOT_FOUND',
    );
    expect(harness.repository.commits).toBe(0);
  });

  it('expires the oldest preview when the pending-preview capacity is reached', async () => {
    const firstJson = await portableJson([makeTask('task-1', 'First')]);
    const secondJson = await portableJson([makeTask('task-2', 'Second')]);
    const harness = createHarness({ maxPendingPreviews: 1 });
    harness.files.setFile('/tmp/imports/first.json', firstJson);
    harness.files.setFile('/tmp/imports/second.json', secondJson);
    const first = await readyPreview(harness.controller, '/tmp/imports/first.json');
    const second = await readyPreview(harness.controller, '/tmp/imports/second.json');

    await expectErrorCode(
      harness.controller.commitImport(first.previewToken, 'skip'),
      'PREVIEW_EXPIRED',
    );
    await harness.controller.commitImport(second.previewToken, 'skip');
    expect(harness.repository.state.taskState.tasks['task-2']?.title).toBe('Second');
  });
});
