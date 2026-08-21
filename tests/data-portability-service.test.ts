// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  DataImportPreviewMismatchError,
  DataImportValidationError,
  DataPortabilityService,
  type DataPortabilityRepository,
  type DataPortabilitySnapshot,
} from '../electron/services/data-portability-service';
import type { AuditRecord } from '../src/shared/agent-types';
import {
  createEmptyLocalAppState,
  type Task,
  type TaskDraft,
  type TaskOperation,
  type TaskProject,
  type TaskList,
} from '../src/shared/models';
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

const makeDraft = (id: string, taskId: string, text: string): TaskDraft => ({
  id,
  kind: 'task-editor',
  taskId,
  text,
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
});

const makeOperation = (id: string, task: Task): TaskOperation => ({
  id,
  kind: 'update',
  createdAt: '2026-08-09T00:00:00.000Z',
  changes: [{ taskId: task.id, before: clone(task), after: clone(task) }],
});

const makeProject = (id: string, name: string): TaskProject => ({
  id,
  name,
  color: 'violet',
  archived: false,
  privateOrder: 0,
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
});

const makeList = (id: string, name: string): TaskList => ({
  id,
  name,
  color: 'green',
  archived: false,
  privateOrder: 0,
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
});

const snapshot = (
  tasks: Task[] = [],
  drafts: TaskDraft[] = [],
  operations: TaskOperation[] = [],
  projects: TaskProject[] = [],
  lists: TaskList[] = [],
): DataPortabilitySnapshot => {
  const taskState = createEmptyLocalAppState();
  taskState.tasks = Object.fromEntries(tasks.map((task) => [task.id, clone(task)]));
  taskState.drafts = Object.fromEntries(drafts.map((draft) => [draft.id, clone(draft)]));
  taskState.operations = clone(operations);
  taskState.projects = Object.fromEntries(projects.map((project) => [project.id, clone(project)]));
  taskState.lists = Object.fromEntries(lists.map((list) => [list.id, clone(list)]));
  return {
    taskState,
    settings: clone(defaultSettings),
    permissionAudit: [],
  };
};

class MemoryPortabilityRepository implements DataPortabilityRepository {
  state: DataPortabilitySnapshot;
  commits = 0;
  failCommit = false;

  constructor(initial: DataPortabilitySnapshot) {
    this.state = clone(initial);
  }

  async readSnapshot(): Promise<DataPortabilitySnapshot> {
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

const serviceFor = (
  repository: MemoryPortabilityRepository,
): DataPortabilityService => new DataPortabilityService({
  repository,
  now: () => new Date('2026-08-09T12:00:00.000Z'),
  createCopyId: (kind, originalId, attempt) => `${kind}-copy-${originalId}-${attempt}`,
});

describe('DataPortabilityService export safety', () => {
  it('renders a readable Markdown task export without private paths or notes by default', async () => {
    const project = makeProject('project-1', '研究项目');
    const list = makeList('list-1', '今天');
    const task = makeTask('task-md', '整理 Markdown 说明', {
      projectId: project.id,
      listId: list.id,
      notes: '公开说明不应出现在默认私人导出中',
      privateNotes: '只给自己看的内容',
      plannedDate: '2026-08-09',
      deferUntil: '2026-08-12',
      estimatedMinutes: 45,
      flagged: true,
      recurrence: { frequency: 'weekly', interval: 1, weekdays: [1, 3, 5] },
      attachments: [{
        id: 'attachment-md',
        name: 'brief.pdf',
        mimeType: 'application/pdf',
        size: 1234,
        localPath: '/Users/secret/brief.pdf',
      }],
    });
    const source = new MemoryPortabilityRepository(
      snapshot([task], [], [], [project], [list]),
    );

    const markdown = await serviceFor(source).exportMarkdown();

    expect(markdown).toContain('# Todo Agent 任务导出');
    expect(markdown).toContain('- [ ] **整理 Markdown 说明**');
    expect(markdown).toContain('项目：研究项目');
    expect(markdown).toContain('预计：45 分钟');
    expect(markdown).toContain('重点标记');
    expect(markdown).toContain('稍后：2026-08-12');
    expect(markdown).toContain('循环：每周（周一、三、五）');
    expect(markdown).not.toContain('公开说明不应出现在默认私人导出中');
    expect(markdown).not.toContain('只给自己看的内容');
    expect(markdown).not.toContain('/Users/secret/brief.pdf');
  });

  it('keeps task notes and safe links when Markdown export explicitly opts out of redaction', async () => {
    const task = makeTask('task-md-none', '发布说明', {
      notes: '## 说明\n\n请查看公开链接。',
      links: [{ id: 'link-1', url: 'https://example.com/docs', label: '文档' }],
    });
    const source = new MemoryPortabilityRepository(snapshot([task]));

    const markdown = await serviceFor(source).exportMarkdown({ redaction: 'none' });

    expect(markdown).toContain('请查看公开链接。');
    expect(markdown).toContain('[文档](https://example.com/docs)');
  });

  it('optionally renders a readable event summary without exporting snapshots', async () => {
    const before = makeTask('task-event', '整理旧标题', {
      privateNotes: '绝不应出现在事件摘要中',
      attachments: [{
        id: 'attachment-event',
        name: 'secret.txt',
        mimeType: 'text/plain',
        localPath: '/Users/secret/secret.txt',
      }],
    });
    const after = {
      ...before,
      title: '整理新标题',
      status: 'completed' as const,
      completedAt: '2026-08-09T13:00:00.000Z',
      updatedAt: '2026-08-09T13:00:00.000Z',
    };
    const operation: TaskOperation = {
      id: 'operation-event',
      kind: 'complete',
      createdAt: '2026-08-09T13:00:00.000Z',
      changes: [{ taskId: before.id, before, after }],
    };
    const source = new MemoryPortabilityRepository(
      snapshot([after], [], [operation]),
    );

    const defaultMarkdown = await serviceFor(source).exportMarkdown();
    expect(defaultMarkdown).not.toContain('任务事件日志');

    const markdown = await serviceFor(source).exportMarkdown({
      include: { operations: true },
    });
    expect(markdown).toContain('## 任务事件日志');
    expect(markdown).toContain('标记完成');
    expect(markdown).toContain('整理新标题');
    expect(markdown).toContain('字段：标题、状态、完成时间');
    expect(markdown).not.toContain('"before"');
    expect(markdown).not.toContain('"after"');
    expect(markdown).not.toContain('整理旧标题');
    expect(markdown).not.toContain('绝不应出现在事件摘要中');
    expect(markdown).not.toContain('/Users/secret/secret.txt');
  });

  it('round-trips local list entities and remaps copied list references', async () => {
    const list = makeList('list-1', '学习');
    const task = makeTask('task-list', '清单任务', { listId: list.id });
    const source = new MemoryPortabilityRepository(snapshot([task], [], [], [], [list]));
    const json = await serviceFor(source).exportJson({ include: { permissionAudit: false } });
    expect(JSON.parse(json).data.lists).toHaveLength(1);

    const target = new MemoryPortabilityRepository(snapshot([], [], [], [], [makeList(list.id, '已有学习')]));
    const result = await serviceFor(target).importJson(json, { strategy: 'copy' });
    const copiedListId = Object.keys(target.state.taskState.lists).find((id) => id !== list.id);
    expect(result.lists.copy).toBe(1);
    expect(copiedListId).toBeTruthy();
    expect(target.state.taskState.tasks['task-list']?.listId).toBe(copiedListId);
  });

  it('round-trips local project entities and remaps copied project references', async () => {
    const project = makeProject('project-1', '发布');
    const task = makeTask('task-project', '项目任务', { projectId: project.id });
    const source = new MemoryPortabilityRepository(snapshot([task], [], [], [project]));
    const json = await serviceFor(source).exportJson({ include: { permissionAudit: false } });
    expect(JSON.parse(json).data.projects).toHaveLength(1);

    const targetProject = makeProject(project.id, '已有发布');
    const target = new MemoryPortabilityRepository(snapshot([], [], [], [targetProject]));
    const result = await serviceFor(target).importJson(json, { strategy: 'copy' });
    const copiedProjectId = Object.keys(target.state.taskState.projects).find((id) => id !== project.id);
    expect(result.projects.copy).toBe(1);
    expect(copiedProjectId).toBeTruthy();
    expect(target.state.taskState.tasks['task-project']?.projectId).toBe(copiedProjectId);
  });

  it.each(['bearer', 'none'] as const)(
    'round-trips the supported %s model authentication mode without credentials',
    async (authMode) => {
      const source = new MemoryPortabilityRepository(snapshot());
      source.state.settings.ai.authMode = authMode;
      source.state.settings.ai.credentialId = 'local-model-credential';

      const json = await serviceFor(source).exportJson({
        include: { permissionAudit: false },
      });
      const bundle = JSON.parse(json) as {
        data: { settings: { ai: Record<string, unknown> } };
      };

      expect(bundle.data.settings.ai.authMode).toBe(authMode);
      expect(bundle.data.settings.ai).not.toHaveProperty('credentialId');
      expect(json).not.toContain('local-model-credential');

      const target = new MemoryPortabilityRepository(snapshot());
      await serviceFor(target).importJson(json, { strategy: 'overwrite' });

      expect(target.state.settings.ai.authMode).toBe(authMode);
      expect(target.state.settings.ai.credentialId).toBeUndefined();
    },
  );

  it('round-trips user-entered model prices without exporting credentials', async () => {
    const source = new MemoryPortabilityRepository(snapshot());
    source.state.settings.ai.pricing = {
      promptUsdPerMillionTokens: 2.5,
      completionUsdPerMillionTokens: 10,
    };
    source.state.settings.ai.fallback.pricing = {
      promptUsdPerMillionTokens: 0,
      completionUsdPerMillionTokens: 0,
    };
    const json = await serviceFor(source).exportJson({
      include: { permissionAudit: false },
    });
    const target = new MemoryPortabilityRepository(snapshot());
    await serviceFor(target).importJson(json, { strategy: 'overwrite' });

    expect(target.state.settings.ai.pricing).toEqual({
      promptUsdPerMillionTokens: 2.5,
      completionUsdPerMillionTokens: 10,
    });
    expect(target.state.settings.ai.fallback.pricing).toEqual({
      promptUsdPerMillionTokens: 0,
      completionUsdPerMillionTokens: 0,
    });
    expect(json).not.toContain('credentialId');
  });

  it('defaults a legacy model authentication mode to Bearer and rejects unknown values', async () => {
    const source = new MemoryPortabilityRepository(snapshot());
    const json = await serviceFor(source).exportJson({
      include: { permissionAudit: false },
    });
    const legacy = JSON.parse(json) as {
      data: { settings: { ai: Record<string, unknown> } };
    };
    delete legacy.data.settings.ai.authMode;

    const target = new MemoryPortabilityRepository(snapshot());
    await serviceFor(target).importJson(JSON.stringify(legacy), { strategy: 'overwrite' });
    expect(target.state.settings.ai.authMode).toBe('bearer');

    const invalid = JSON.parse(json) as {
      data: { settings: { ai: Record<string, unknown> } };
    };
    invalid.data.settings.ai.authMode = 'basic';
    await expect(
      serviceFor(new MemoryPortabilityRepository(snapshot())).previewImport(
        JSON.stringify(invalid),
        'overwrite',
      ),
    ).rejects.toThrow('Expected one of: bearer, none');
  });

  it('imports legacy floating settings as the unique Todo Pet defaults', async () => {
    const source = new MemoryPortabilityRepository(snapshot());
    const bundle = JSON.parse(await serviceFor(source).exportJson()) as {
      data: { settings: { floating: Record<string, unknown>; pet: Record<string, unknown>; agentCapabilities?: Record<string, unknown> } };
    };
    delete bundle.data.settings.floating.hoverExpandDelayMs;
    delete bundle.data.settings.floating.topMode;
    delete bundle.data.settings.floating.selectedTab;
    delete bundle.data.settings.floating.scalePercent;
    delete bundle.data.settings.floating.mousePassthrough;
    delete bundle.data.settings.pet.inputReactionsEnabled;
    delete bundle.data.settings.pet.vacationMode;
    delete bundle.data.settings.agentCapabilities;
    bundle.data.settings.floating.shape = 'capsule';
    const target = new MemoryPortabilityRepository(snapshot());

    await serviceFor(target).importJson(JSON.stringify(bundle), {
      strategy: 'overwrite',
    });

    expect(target.state.settings.floating.hoverExpandDelayMs).toBe(1_000);
    expect(target.state.settings.floating.topMode).toBe('always');
    expect(target.state.settings.floating.selectedTab).toBe('all');
    expect(target.state.settings.floating.scalePercent).toBe(100);
    expect(target.state.settings.floating.mousePassthrough).toBe(false);
    expect(target.state.settings.pet.inputReactionsEnabled).toBe(false);
    expect(target.state.settings.pet.vacationMode).toBe(false);
    expect(target.state.settings.agentCapabilities).toEqual(defaultSettings.agentCapabilities);
    expect(target.state.settings.floating).not.toHaveProperty('shape');
  });

  it.each(['focus-only', 'never'] as const)(
    'normalizes imported legacy %s floating policy to always-on-top',
    async (topMode) => {
      const source = new MemoryPortabilityRepository(snapshot());
      const bundle = JSON.parse(await serviceFor(source).exportJson()) as {
        data: { settings: { floating: { topMode: string } } };
      };
      bundle.data.settings.floating.topMode = topMode;
      const target = new MemoryPortabilityRepository(snapshot());

      await serviceFor(target).importJson(JSON.stringify(bundle), {
        strategy: 'overwrite',
      });

      expect(target.state.settings.floating.topMode).toBe('always');
    },
  );

  it('imports legacy focus settings with safe shield defaults and validates new values', async () => {
    const source = new MemoryPortabilityRepository(snapshot());
    const bundle = JSON.parse(await serviceFor(source).exportJson()) as {
      data: { settings: { focus: Record<string, unknown> } };
    };
    delete bundle.data.settings.focus.shieldMode;
    delete bundle.data.settings.focus.shieldApplications;
    const target = new MemoryPortabilityRepository(snapshot());

    await serviceFor(target).importJson(JSON.stringify(bundle), { strategy: 'overwrite' });
    expect(target.state.settings.focus.shieldMode).toBe('off');
    expect(target.state.settings.focus.shieldApplications).toEqual([]);

    const invalid = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    invalid.data.settings.focus.shieldMode = 'block-other-apps';
    await expect(
      serviceFor(new MemoryPortabilityRepository(snapshot())).previewImport(
        JSON.stringify(invalid),
        'overwrite',
      ),
    ).rejects.toThrow('Expected one of: off, gentle, pause');

    const tooLong = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    tooLong.data.settings.focus.shieldApplications = ['x'.repeat(81)];
    await expect(
      serviceFor(new MemoryPortabilityRepository(snapshot())).previewImport(
        JSON.stringify(tooLong),
        'overwrite',
      ),
    ).rejects.toThrow('Application name is too long');
  });

  it('exports selected domains while applying a non-bypassable credential firewall', async () => {
    const secretTask = makeTask('task-1', 'Private task', {
      notes: 'Authorization: Bearer top-secret-token',
      privateNotes: 'api_key=sk-abcdefghijk',
      attachments: [{
        id: 'attachment-1',
        name: 'local.txt',
        localPath: '/Users/example/private/local.txt',
        url: 'https://example.com/file',
      }],
      customFields: {
        accessToken: 'raw-access-token',
        safe: 'kept',
      },
    });
    const repository = new MemoryPortabilityRepository(snapshot([secretTask]));
    repository.state.settings.ai.credentialId = 'credential-record-1';
    repository.state.settings.feishu.tokenCredentialId = 'feishu-token-record-1';
    repository.state.settings.feishu.appSecretCredentialId = 'feishu-secret-record-1';
    repository.state.permissionAudit = [{
      sequence: 1,
      timestamp: '2026-08-09T00:00:00.000Z',
      previousHash: '0'.repeat(64),
      eventHash: 'f'.repeat(64),
      runId: 'run-1',
      actor: 'model',
      event: 'tool-called',
      arguments: { password: 'hunter2', safe: 'visible' },
    } satisfies AuditRecord];

    const json = await serviceFor(repository).exportJson({ redaction: 'none' });

    expect(json).not.toContain('top-secret-token');
    expect(json).not.toContain('sk-abcdefghijk');
    expect(json).not.toContain('raw-access-token');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('credential-record-1');
    expect(json).not.toContain('feishu-token-record-1');
    expect(json).not.toContain('feishu-secret-record-1');
    expect(json).not.toContain('tokenCredentialId');
    expect(json).not.toContain('credentialId');
    expect(json).not.toContain('/Users/example/private');
    expect(json).toContain('"safe": "kept"');

    const cleanRepository = new MemoryPortabilityRepository(snapshot());
    const preview = await serviceFor(cleanRepository).previewImport(json, 'overwrite');
    expect(preview.tasks.incoming).toBe(1);
    expect(preview.permissionAudit.incoming).toBe(1);
  });

  it('supports selective private and strict diagnostic exports', async () => {
    const task = makeTask('task-1', 'Customer acquisition plan', {
      notes: 'Customer details',
      privateNotes: 'Private thinking',
      tags: ['customer'],
      comments: [{
        id: 'comment-1',
        body: 'Only for this device',
        author: 'user',
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      }],
      researchCards: [{
        id: 'research-1',
        title: 'Source summary',
        url: 'https://example.com/source',
        summary: 'Private research context',
        actionItems: ['Follow up'],
        capturedAt: '2026-08-09T00:00:00.000Z',
      }],
    });
    const repository = new MemoryPortabilityRepository(
      snapshot([task], [makeDraft('draft-1', task.id, 'unfinished thought')]),
    );
    const service = serviceFor(repository);

    const fullBundle = await service.createExport({
      redaction: 'none',
      include: { operations: false, permissionAudit: false },
    });
    expect(fullBundle.data.tasks?.[0]?.researchCards).toMatchObject([
      expect.objectContaining({ title: 'Source summary', actionItems: ['Follow up'] }),
    ]);

    const privateBundle = await service.createExport({
      redaction: 'private',
      include: { operations: false, permissionAudit: false },
    });
    expect(privateBundle.data.tasks?.[0]).toMatchObject({
      title: 'Customer acquisition plan',
      notes: '',
      privateNotes: '',
      customFields: {},
      comments: [],
      researchCards: [],
    });
    expect(privateBundle.data.drafts?.[0]?.text).toBe('[REDACTED]');
    expect(privateBundle.data.operations).toBeUndefined();

    const strictBundle = await service.createExport({ redaction: 'strict' });
    expect(strictBundle.data.tasks?.[0]).toMatchObject({
      title: '[REDACTED]',
      tags: [],
      source: { type: 'local' },
    });
  });
});

describe('DataPortabilityService import validation', () => {
  it('rejects prototype pollution, credential fields, unsupported schema, and unknown attachment paths', async () => {
    const source = new MemoryPortabilityRepository(snapshot([makeTask('task-1', 'Safe')]));
    const safeJson = await serviceFor(source).exportJson();
    const target = new MemoryPortabilityRepository(snapshot());
    const service = serviceFor(target);

    const prototypeBundle = JSON.parse(safeJson) as Record<string, any>;
    Object.defineProperty(
      prototypeBundle.data.tasks[0].customFields,
      '__proto__',
      { value: { polluted: true }, enumerable: true },
    );
    await expect(
      service.previewImport(JSON.stringify(prototypeBundle), 'skip'),
    ).rejects.toBeInstanceOf(DataImportValidationError);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    const credentialBundle = JSON.parse(safeJson) as Record<string, any>;
    credentialBundle.data.tasks[0].customFields.clientSecret = 'malicious-secret';
    await expect(
      service.previewImport(JSON.stringify(credentialBundle), 'skip'),
    ).rejects.toThrow('Credential fields are forbidden');

    const schemaBundle = JSON.parse(safeJson) as Record<string, any>;
    schemaBundle.schemaVersion = 999;
    await expect(
      service.previewImport(JSON.stringify(schemaBundle), 'skip'),
    ).rejects.toThrow('Unsupported import schema');

    const pathBundle = JSON.parse(safeJson) as Record<string, any>;
    pathBundle.data.tasks[0].attachments.push({
      id: 'bad-file',
      name: 'secrets.txt',
      localPath: '../../private/credentials.v1.json',
    });
    await expect(
      service.previewImport(JSON.stringify(pathBundle), 'skip'),
    ).rejects.toThrow('Unknown field: localPath');

    expect(target.commits).toBe(0);
    expect(target.state.taskState.tasks).toEqual({});
  });

  it('rejects duplicate or shared-field Today plan operation snapshots', async () => {
    const task = makeTask('task-plan', 'Private plan');
    const after = clone(task);
    after.plannedDate = '2026-08-09';
    after.updatedAt = '2026-08-09T01:00:00.000Z';
    const operation: TaskOperation = {
      id: 'operation-plan',
      kind: 'plan-today',
      createdAt: '2026-08-09T01:00:00.000Z',
      changes: [{ taskId: task.id, before: clone(task), after }],
    };
    const source = new MemoryPortabilityRepository(
      snapshot([task], [], [operation]),
    );
    const safeBundle = JSON.parse(
      await serviceFor(source).exportJson(),
    ) as Record<string, any>;

    const duplicate = clone(safeBundle);
    duplicate.data.operations[0].changes.push(
      clone(duplicate.data.operations[0].changes[0]),
    );
    await expect(
      serviceFor(new MemoryPortabilityRepository(snapshot())).previewImport(
        JSON.stringify(duplicate),
        'overwrite',
      ),
    ).rejects.toThrow('Operation contains duplicate task changes');

    const sharedField = clone(safeBundle);
    sharedField.data.operations[0].changes[0].after.title = 'Injected title';
    await expect(
      serviceFor(new MemoryPortabilityRepository(snapshot())).previewImport(
        JSON.stringify(sharedField),
        'overwrite',
      ),
    ).rejects.toThrow('Today plan operation changes shared field: title');
  });

  it('pins execution to the exact bytes semantically represented by a preview digest', async () => {
    const source = new MemoryPortabilityRepository(snapshot([makeTask('task-1', 'Safe')]));
    const json = await serviceFor(source).exportJson();
    const target = new MemoryPortabilityRepository(snapshot());
    const service = serviceFor(target);
    const preview = await service.previewImport(json, 'skip');
    const changed = JSON.parse(json) as Record<string, any>;
    changed.data.tasks[0].title = 'Changed after preview';

    await expect(service.importJson(JSON.stringify(changed), {
      strategy: 'skip',
      expectedDigest: preview.digest,
    })).rejects.toBeInstanceOf(DataImportPreviewMismatchError);
    expect(target.commits).toBe(0);

    const freshPreview = await service.previewImport(json, 'skip');
    target.state.taskState.tasks.concurrent = makeTask('concurrent', 'Created after preview');
    await expect(service.importJson(json, {
      strategy: 'skip',
      expectedDigest: freshPreview.digest,
    })).rejects.toBeInstanceOf(DataImportPreviewMismatchError);
    expect(target.commits).toBe(0);
  });
});

describe('DataPortabilityService conflict strategies and atomic commit', () => {
  const importJson = async (): Promise<string> => {
    const importedTask = makeTask('task-1', 'Imported title');
    const newTask = makeTask('task-2', 'New task', { parentId: importedTask.id });
    const imported = snapshot(
      [importedTask, newTask],
      [makeDraft('draft-1', importedTask.id, 'Imported draft')],
      [makeOperation('operation-1', importedTask)],
    );
    imported.settings.theme = 'dark';
    return serviceFor(new MemoryPortabilityRepository(imported)).exportJson({
      include: { permissionAudit: false },
    });
  };

  const targetSnapshot = (): DataPortabilitySnapshot => {
    const current = makeTask('task-1', 'Current title');
    const value = snapshot(
      [current],
      [makeDraft('draft-1', current.id, 'Current draft')],
      [makeOperation('operation-1', current)],
    );
    value.settings.theme = 'system';
    return value;
  };

  it('previews and applies skip without touching conflicting records', async () => {
    const target = new MemoryPortabilityRepository(targetSnapshot());
    const service = serviceFor(target);
    const json = await importJson();
    const preview = await service.previewImport(json, 'skip');

    expect(preview.tasks).toMatchObject({ incoming: 2, create: 1, skip: 1 });
    expect(preview.drafts.skip).toBe(1);
    expect(preview.operations.skip).toBe(1);
    expect(preview.settings.action).toBe('skip');

    const result = await service.importJson(json, {
      strategy: 'skip',
      expectedDigest: preview.digest,
    });
    expect(result.tasks).toMatchObject({ create: 1, skip: 1 });
    expect(target.state.taskState.tasks['task-1']?.title).toBe('Current title');
    expect(target.state.taskState.tasks['task-2']?.title).toBe('New task');
    expect(target.state.taskState.drafts['draft-1']?.text).toBe('Current draft');
    expect(target.state.settings.theme).toBe('system');
    expect(target.commits).toBe(1);
  });

  it('overwrites conflicts and singleton settings in one transaction', async () => {
    const target = new MemoryPortabilityRepository(targetSnapshot());
    const service = serviceFor(target);
    const json = await importJson();

    const result = await service.importJson(json, { strategy: 'overwrite' });

    expect(result.tasks.overwrite).toBe(1);
    expect(result.drafts.overwrite).toBe(1);
    expect(result.operations.overwrite).toBe(1);
    expect(result.settings).toBe('overwritten');
    expect(target.state.taskState.tasks['task-1']?.title).toBe('Imported title');
    expect(target.state.taskState.drafts['draft-1']?.text).toBe('Imported draft');
    expect(target.state.settings.theme).toBe('dark');
    expect(target.commits).toBe(1);
  });

  it('copies conflicting records and remaps task references and operation snapshots', async () => {
    const target = new MemoryPortabilityRepository(targetSnapshot());
    const service = serviceFor(target);
    const json = await importJson();

    const result = await service.importJson(json, { strategy: 'copy' });
    const copiedTaskId = result.copiedTaskIds['task-1'];

    expect(copiedTaskId).toBe('task-copy-task-1-1');
    expect(target.state.taskState.tasks['task-1']?.title).toBe('Current title');
    expect(target.state.taskState.tasks[copiedTaskId]?.title).toBe('Imported title');
    expect(target.state.taskState.tasks['task-2']?.parentId).toBe(copiedTaskId);
    expect(target.state.taskState.drafts['draft-copy-draft-1-1']?.taskId).toBe(copiedTaskId);
    const copiedOperation = target.state.taskState.operations.find(
      ({ id }) => id === 'operation-copy-operation-1-1',
    );
    expect(copiedOperation?.changes[0]?.taskId).toBe(copiedTaskId);
    expect(copiedOperation?.changes[0]?.before?.id).toBe(copiedTaskId);
    expect(target.state.settings.theme).toBe('system');
  });

  it('leaves the entire prior snapshot intact when the atomic repository commit fails', async () => {
    const initial = targetSnapshot();
    const target = new MemoryPortabilityRepository(initial);
    target.failCommit = true;
    const service = serviceFor(target);

    await expect(
      service.importJson(await importJson(), { strategy: 'overwrite' }),
    ).rejects.toThrow('ATOMIC_COMMIT_FAILED');

    expect(target.state).toEqual(initial);
    expect(target.commits).toBe(0);
  });
});
