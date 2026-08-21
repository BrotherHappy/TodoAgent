import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStore } from "../electron/services/local-store";
import { getNextOccurrence } from "../electron/services/recurrence";
import {
  TaskNotFoundError,
  TaskService,
  TaskStateError,
  TaskValidationError,
  UndoConflictError,
} from "../electron/services/task-service";
import type { Task, TodayPlanBaseline } from "../src/shared/models";

const testDirectories: string[] = [];

const planBaselines = (...tasks: Task[]): TodayPlanBaseline[] =>
  tasks.map((task) => ({
    id: task.id,
    plannedDate: task.plannedDate,
    privateOrder: task.privateOrder,
    estimatedMinutes: task.estimatedMinutes,
  }));

const createFixture = async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "todo-agent-task-service-"),
  );
  testDirectories.push(directory);
  let now = new Date("2026-08-09T10:00:00.000Z");
  const counters = { task: 0, operation: 0, draft: 0 };
  const store = new LocalStore(directory);
  const service = new TaskService(store, {
    clock: () => new Date(now),
    timeZone: "UTC",
    idGenerator: (prefix) => `${prefix}-${++counters[prefix]}`,
  });
  await service.initialize();
  return {
    directory,
    service,
    setNow: (value: string) => {
      now = new Date(value);
    },
  };
};

beforeEach(() => {
  testDirectories.length = 0;
});

afterEach(async () => {
  await Promise.all(
    testDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("TaskService views and task data", () => {
  it("creates, orders, archives, and renames local projects", async () => {
    const { service } = await createFixture();
    const first = await service.createProject({ name: "研究", color: "blue" });
    const second = await service.createProject({ name: "发布", color: "amber" });
    expect((await service.listProjects()).map((project) => project.name)).toEqual(["研究", "发布"]);
    await expect(service.createProject({ name: "  研究 " })).rejects.toBeInstanceOf(TaskValidationError);
    const renamed = await service.updateProject(second.id, { name: "上线", archived: true });
    expect(renamed).toMatchObject({ name: "上线", archived: true, color: "amber" });
    expect((await service.listProjects()).map((project) => project.id)).toEqual([first.id]);
    expect((await service.listProjects(true)).map((project) => project.name)).toEqual(["研究", "上线"]);
  });

  it("deletes a project and clears task associations without queuing Feishu changes", async () => {
    const { service } = await createFixture();
    const project = await service.createProject({ name: "迁移" });
    const local = await service.createTask({ title: "本地任务", projectId: project.id });
    const remote = await service.createTask({
      title: "飞书任务",
      projectId: project.id,
      source: { type: "feishu", accountId: "primary", externalId: "remote-1" },
      sync: { status: "synced" },
    });
    const deleted = await service.deleteProject(project.id);
    expect(deleted.clearedTaskIds).toEqual([local.task.id, remote.task.id]);
    expect(await service.listProjects(true)).toEqual([]);
    expect((await service.getTask(local.task.id))?.projectId).toBeUndefined();
    expect((await service.getTask(remote.task.id))?.sync.status).toBe("synced");
    // Project metadata is not a task operation; deletion is deliberately not
    // undoable, so global task undo can never restore a dangling project ID.
    expect((await service.getOperations(1))[0]?.kind).toBe("create");
  });

  it("creates, archives, renames, and deletes local lists atomically", async () => {
    const { service } = await createFixture();
    const list = await service.createList({ name: "学习", color: "blue" });
    const second = await service.createList({ name: "生活", color: "green" });
    expect((await service.listLists()).map((item) => item.name)).toEqual(["学习", "生活"]);
    await expect(service.createList({ name: " 学习 " })).rejects.toBeInstanceOf(TaskValidationError);
    const renamed = await service.updateList(second.id, { name: "健康", archived: true });
    expect(renamed).toMatchObject({ name: "健康", archived: true, color: "green" });
    expect((await service.listLists()).map((item) => item.id)).toEqual([list.id]);
    const local = await service.createTask({ title: "本地清单任务", listId: list.id });
    const remote = await service.createTask({
      title: "飞书清单任务",
      listId: list.id,
      source: { type: "feishu", accountId: "primary", externalId: "remote-list-1" },
      sync: { status: "synced" },
    });
    const deleted = await service.deleteList(list.id);
    expect(deleted.clearedTaskIds).toEqual([local.task.id, remote.task.id]);
    expect(await service.listLists(true)).toEqual([renamed]);
    expect((await service.getTask(local.task.id))?.listId).toBeUndefined();
    expect((await service.getTask(remote.task.id))?.sync.status).toBe("synced");
  });

  it("stores the complete task shape and normalizes user-entered values", async () => {
    const { service } = await createFixture();

    const result = await service.createTask({
      title: "  Ship release  ",
      notes: "Shared description",
      privateNotes: "Personal note",
      priority: "urgent",
      projectId: "product",
      listId: "launch",
      sectionId: " ready ",
      tags: [" release ", "release", "desktop"],
      contexts: [" 办公室 ", "出门"],
      parentId: "parent-task",
      dependencyIds: ["dependency", "dependency"],
      assigneeIds: ["user-1"],
      followerIds: ["user-2"],
      plannedDate: "2026-08-09",
      startAt: "2026-08-09T11:00:00.000Z",
      dueAt: "2026-08-09T12:00:00.000Z",
      timeBlock: {
        startAt: "2026-08-09T10:30:00.000Z",
        endAt: "2026-08-09T11:00:00.000Z",
      },
      reminders: [
        {
          id: "reminder-1",
          at: "2026-08-09T10:15:00.000Z",
          enabled: true,
          source: "local",
        },
      ],
      estimatedMinutes: 45,
      attachments: [{ id: "attachment-1", name: "brief.pdf" }],
      links: [{ id: "link-1", url: "https://example.com" }],
      customFields: { release: 1 },
    });

    expect(result.task).toMatchObject({
      title: "Ship release",
      notes: "Shared description",
      privateNotes: "Personal note",
      status: "open",
      source: { type: "local" },
      sync: { status: "local" },
      tags: ["release", "desktop"],
      contexts: ["办公室", "出门"],
      dependencyIds: ["dependency"],
      focusElapsedSeconds: 0,
      focusSessions: [],
      estimatedMinutes: 45,
      sectionId: "ready",
    });
    expect(result.operationId).toBe("operation-1");
  });

  it("keeps all-day metadata only while its corresponding time exists", async () => {
    const { service } = await createFixture();
    const created = await service.createTask({
      source: { type: "feishu", accountId: "account-1" },
      title: "All-day remote task",
      startAt: "2026-08-10T00:00:00.000Z",
      startAtIsAllDay: true,
      dueAt: "2026-08-11T00:00:00.000Z",
      dueAtIsAllDay: true,
    });
    expect(created.task).toMatchObject({
      startAtIsAllDay: true,
      dueAtIsAllDay: true,
    });

    // Existing time controls update a timestamp without an all-day toggle,
    // which must produce a timed remote slot rather than retain a stale flag.
    const timed = await service.updateTask(created.task.id, {
      startAt: "2026-08-10T09:30:00.000Z",
    });
    expect(timed.task.startAtIsAllDay).toBeUndefined();
    expect(timed.task.dueAtIsAllDay).toBe(true);
    expect(timed.task.sync.status).toBe("pending");

    const cleared = await service.updateTask(created.task.id, { dueAt: null });
    expect(cleared.task.dueAt).toBeUndefined();
    expect(cleared.task.dueAtIsAllDay).toBeUndefined();
  });

  it("builds Today sections in semantic order and sorts within a section", async () => {
    const { service } = await createFixture();
    const overdue = await service.createTask({
      title: "Overdue",
      dueAt: "2026-08-08T23:00:00.000Z",
      privateOrder: 0,
    });
    const lowerPriority = await service.createTask({
      title: "Due today low",
      dueAt: "2026-08-09T18:00:00.000Z",
      priority: "low",
      privateOrder: 0,
    });
    const higherPriority = await service.createTask({
      title: "Due today urgent",
      dueAt: "2026-08-09T20:00:00.000Z",
      priority: "urgent",
      privateOrder: 0,
    });
    const planned = await service.createTask({
      title: "Planned today",
      plannedDate: "2026-08-09",
      privateOrder: 0,
    });
    const completed = await service.createTask({
      title: "Completed today",
      status: "completed",
      completedAt: "2026-08-09T08:00:00.000Z",
      privateOrder: 0,
    });
    await service.createTask({ title: "Future", plannedDate: "2026-08-10" });

    const tasks = await service.listTasks({ view: "today" });
    expect(tasks.map((task) => task.id)).toEqual([
      overdue.task.id,
      higherPriority.task.id,
      lowerPriority.task.id,
      planned.task.id,
      completed.task.id,
    ]);
    const sections = await service.getViewSections({ view: "today" });
    expect(sections.map((section) => section.id)).toEqual([
      "overdue",
      "due-today",
      "planned-today",
      "completed",
    ]);
  });

  it("supports text search plus source, project, tag, context, priority, status, and date filters", async () => {
    const { service } = await createFixture();
    const match = await service.createTask({
      title: "Prepare quarterly review",
      notes: "Include desktop launch metrics",
      source: {
        type: "feishu",
        accountId: "work-account",
        tenantId: "tenant-1",
        externalId: "feishu-task-42",
      },
      sync: { status: "synced" },
      projectId: "product",
      listId: "planning",
      tags: ["review", "desktop"],
      contexts: ["办公室", "深度工作"],
      priority: "high",
      plannedDate: "2026-08-11",
      dueAt: "2026-08-12T12:00:00.000Z",
    });
    await service.createTask({ title: "Buy milk", tags: ["personal"] });

    const result = await service.listTasks({
      text: "launch metrics",
      sourceTypes: ["feishu"],
      accountIds: ["work-account"],
      projectIds: ["product"],
      listIds: ["planning"],
      tags: ["review", "desktop"],
      tagMode: "all",
      contexts: ["办公室", "深度工作"],
      contextMode: "all",
      priorities: ["high"],
      statuses: ["open"],
      plannedFrom: "2026-08-10",
      plannedTo: "2026-08-11",
      dueFrom: "2026-08-12T00:00:00.000Z",
      dueTo: "2026-08-12T23:59:59.999Z",
    });

    expect(result.map((task) => task.id)).toEqual([match.task.id]);
    expect(
      (await service.listTasks({ view: "inbox" })).map((task) => task.title),
    ).toEqual(["Buy milk"]);
    expect(
      (await service.listTasks({ view: "upcoming" })).map((task) => task.id),
    ).toEqual([match.task.id]);
  });

  it("supports a private attention marker without queueing a Feishu write", async () => {
    const { service } = await createFixture();
    const local = await service.createTask({ title: "本地重点任务", flagged: true });
    const ordinary = await service.createTask({ title: "普通本地任务" });
    const remote = await service.createTask({
      title: "飞书重点任务",
      flagged: true,
      source: { type: "feishu", accountId: "primary", externalId: "flagged-remote" },
      sync: { status: "synced" },
    });

    expect((await service.listTasks({ flagged: true })).map((task) => task.id)).toEqual([
      local.task.id,
      remote.task.id,
    ]);

    const updated = await service.updateTask(remote.task.id, { flagged: false });
    expect(updated.task.flagged).toBe(false);
    expect(updated.task.sync.status).toBe("synced");
    expect((await service.listTasks({ flagged: true })).map((task) => task.id)).toEqual([
      local.task.id,
    ]);

    await service.updateTask(ordinary.task.id, { flagged: true });
    expect((await service.listTasks({ flagged: true })).map((task) => task.id)).toEqual([
      local.task.id,
      ordinary.task.id,
    ]);
  });

  it("defers tasks locally until a private availability date", async () => {
    const { service } = await createFixture();
    const deferred = await service.createTask({
      title: "下周再看",
      plannedDate: "2026-08-09",
      deferUntil: "2026-08-12",
    });
    const remote = await service.createTask({
      title: "飞书稍后任务",
      deferUntil: "2026-08-12",
      source: { type: "feishu", accountId: "primary", externalId: "defer-remote" },
      sync: { status: "synced" },
    });

    expect((await service.listTasks({ view: "today" })).map((task) => task.id)).not.toContain(
      deferred.task.id,
    );
    expect((await service.listTasks({ view: "deferred" })).map((task) => task.id)).toEqual([
      deferred.task.id,
      remote.task.id,
    ]);
    expect((await service.listTasks({ view: "upcoming" })).map((task) => task.id)).toContain(
      deferred.task.id,
    );

    const cleared = await service.updateTask(remote.task.id, { deferUntil: null });
    expect(cleared.task.deferUntil).toBeUndefined();
    expect(cleared.task.sync.status).toBe("synced");
    expect(await service.listTasks({ view: "deferred" })).toEqual([
      expect.objectContaining({ id: deferred.task.id }),
    ]);

    const nextDay = await service.updateTask(deferred.task.id, {
      deferUntil: "2026-08-09",
    });
    expect(nextDay.task.deferUntil).toBe("2026-08-09");
    expect(await service.listTasks({ view: "deferred" })).toEqual([]);
  });

  it("keeps manual contexts local and filters them case-insensitively", async () => {
    const { service } = await createFixture();
    const local = await service.createTask({
      title: "出门采购",
      contexts: ["出门", "家"],
    });
    const feishu = await service.createTask({
      title: "飞书会议",
      contexts: ["办公室"],
      source: {
        type: "feishu",
        accountId: "primary",
        externalId: "remote-context",
      },
      sync: { status: "synced" },
    });
    expect((await service.listTasks({ contexts: ["家"] })).map((task) => task.id)).toEqual([local.task.id]);
    expect((await service.listTasks({ contexts: ["办公室"], contextMode: "all" })).map((task) => task.id)).toEqual([feishu.task.id]);
    const updated = await service.updateTask(feishu.task.id, {
      contexts: ["家", "办公室"],
    });
    expect(updated.task.contexts).toEqual(["家", "办公室"]);
    expect(updated.task.sync.status).toBe("synced");
    expect((await service.listTasks({ text: "办公室" })).map((task) => task.id)).toContain(feishu.task.id);
  });

  it("searches private attachment, link, and custom-field metadata without reading files", async () => {
    const { service } = await createFixture();
    const match = await service.createTask({
      title: "研究任务",
      attachments: [
        {
          id: "attachment-1",
          name: "reconfigurable-computing.md",
          mimeType: "text/markdown",
        },
      ],
      links: [
        {
          id: "link-1",
          label: "论文来源",
          url: "https://example.com/reconfigurable",
        },
      ],
      customFields: { venue: "FPGA" },
    });
    await service.createTask({ title: "无关任务" });

    await expect(
      service.listTasks({ text: "reconfigurable-computing.md" }),
    ).resolves.toEqual([expect.objectContaining({ id: match.task.id })]);
    await expect(
      service.listTasks({ text: "论文来源" }),
    ).resolves.toEqual([expect.objectContaining({ id: match.task.id })]);
    await expect(
      service.listTasks({ text: "FPGA" }),
    ).resolves.toEqual([expect.objectContaining({ id: match.task.id })]);
  });

  it("stores local task discussions, searches their text, and never marks Feishu tasks pending", async () => {
    const { service } = await createFixture();
    const created = await service.createTask({
      title: "带上下文的任务",
      comments: [
        {
          id: "comment-1",
          body: "  记得先确认接口契约  ",
          author: "user",
          createdAt: "2026-08-09T10:00:00.000Z",
          updatedAt: "2026-08-09T10:00:00.000Z",
        },
      ],
    });
    expect(created.task.comments).toEqual([
      expect.objectContaining({
        id: "comment-1",
        body: "记得先确认接口契约",
        author: "user",
      }),
    ]);
    await expect(service.listTasks({ text: "接口契约" })).resolves.toEqual([
      expect.objectContaining({ id: created.task.id }),
    ]);

    const feishu = await service.createTask({
      title: "飞书本地讨论",
      source: { type: "feishu", accountId: "primary", externalId: "remote-comment" },
      sync: { status: "synced" },
    });
    const updated = await service.updateTask(feishu.task.id, {
      comments: [
        {
          id: "comment-remote-local",
          body: "只在 Todo Agent 里保留",
          author: "agent",
          createdAt: "2026-08-09T10:00:00.000Z",
          updatedAt: "2026-08-09T10:00:00.000Z",
        },
      ],
    });
    expect(updated.task.sync.status).toBe("synced");
    expect(updated.task.comments?.[0]?.author).toBe("agent");

    await expect(
      service.updateTask(created.task.id, {
        comments: [
          {
            id: "duplicate",
            body: "one",
            author: "user",
            createdAt: "2026-08-09T10:00:00.000Z",
            updatedAt: "2026-08-09T10:00:00.000Z",
          },
          {
            id: "duplicate",
            body: "two",
            author: "user",
            createdAt: "2026-08-09T10:00:00.000Z",
            updatedAt: "2026-08-09T10:00:00.000Z",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(TaskValidationError);
  });

  it("stores private research cards, searches their context, and keeps Feishu synced", async () => {
    const { service } = await createFixture();
    const feishu = await service.createTask({
      title: "竞品研究",
      source: { type: "feishu", accountId: "primary", externalId: "remote-research" },
      sync: { status: "synced" },
      researchCards: [
        {
          id: "research-1",
          title: "定价页摘要",
          url: "https://example.com/pricing",
          summary: "按团队规模分层收费",
          actionItems: ["验证个人版限制"],
          capturedAt: "2026-08-09T10:00:00.000Z",
        },
      ],
    });
    expect(feishu.task.researchCards?.[0]).toMatchObject({
      title: "定价页摘要",
      actionItems: ["验证个人版限制"],
    });
    expect(feishu.task.sync.status).toBe("synced");
    await expect(service.listTasks({ text: "个人版限制" })).resolves.toEqual([
      expect.objectContaining({ id: feishu.task.id }),
    ]);

    const updated = await service.updateTask(feishu.task.id, {
      researchCards: [],
    });
    expect(updated.task.researchCards).toEqual([]);
    expect(updated.task.sync.status).toBe("synced");
    await expect(
      service.createTask({
        title: "不安全研究卡",
        researchCards: [
          {
            id: "bad-url",
            title: "不安全",
            url: "javascript:alert(1)",
            summary: "",
            actionItems: [],
            capturedAt: "2026-08-09T10:00:00.000Z",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(TaskValidationError);
  });

  it("validates calendar dates and time blocks", async () => {
    const { service } = await createFixture();

    await expect(
      service.createTask({ title: "Impossible", plannedDate: "2026-02-30" }),
    ).rejects.toBeInstanceOf(TaskValidationError);
    await expect(
      service.createTask({
        title: "Backwards block",
        timeBlock: {
          startAt: "2026-08-09T11:00:00.000Z",
          endAt: "2026-08-09T10:00:00.000Z",
        },
      }),
    ).rejects.toBeInstanceOf(TaskValidationError);
    await expect(
      service.createTask({
        title: "Backwards task schedule",
        startAt: "2026-08-09T12:00:00.000Z",
        dueAt: "2026-08-09T11:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(TaskValidationError);
  });

  it("prevents dependency cycles while preserving missing imported blockers", async () => {
    const { service } = await createFixture();
    const first = await service.createTask({ title: "先做 A" });
    const second = await service.createTask({ title: "再做 B" });

    await service.updateTask(first.task.id, {
      dependencyIds: [second.task.id, "remote-missing"],
    });
    await expect(
      service.updateTask(second.task.id, { dependencyIds: [first.task.id] }),
    ).rejects.toBeInstanceOf(TaskValidationError);

    const savedFirst = await service.getTask(first.task.id, true);
    const savedSecond = await service.getTask(second.task.id, true);
    expect(savedFirst?.dependencyIds).toEqual([second.task.id, "remote-missing"]);
    expect(savedSecond?.dependencyIds).toEqual([]);
  });
});

describe("TaskService mutations, recovery, and recurrence", () => {
  it("returns a compact task history without exposing task snapshots", async () => {
    const { service } = await createFixture();
    const created = await service.createTask({
      title: "可追溯任务",
      notes: "不要把正文放进历史响应",
      priority: "medium",
    });
    const updated = await service.updateTask(created.task.id, {
      title: "已改标题",
      priority: "high",
    });
    const completed = await service.completeTask(created.task.id);
    await service.undo(completed.operationId);

    const history = await service.getTaskHistory(created.task.id);
    expect(history.map((entry) => entry.kind)).toEqual([
      "complete",
      "update",
      "create",
    ]);
    expect(history[0]).toMatchObject({
      taskId: created.task.id,
      operationId: completed.operationId,
      undoneAt: expect.any(String),
      changedFields: expect.arrayContaining(["status", "completedAt"]),
    });
    expect(history[1]).toMatchObject({
      operationId: updated.operationId,
      changedFields: expect.arrayContaining(["title", "priority"]),
    });
    expect(history[2]?.changedFields).toEqual(["task"]);
    expect(JSON.stringify(history)).not.toContain("不要把正文放进历史响应");
    await expect(service.getTaskHistory(created.task.id, 0)).rejects.toBeInstanceOf(
      TaskValidationError,
    );
  });

  it("applies a reviewed batch atomically and undoes it as one operation", async () => {
    const { service } = await createFixture();
    const first = await service.createTask({ title: "批量一", plannedDate: "2026-08-08" });
    const second = await service.createTask({ title: "批量二", plannedDate: "2026-08-08" });
    const operation = await service.applyBulkTaskAction({
      ids: [first.task.id, second.task.id],
      action: { kind: "move-to-today", date: "2026-08-09" },
      baselines: [
        { id: first.task.id, updatedAt: first.task.updatedAt },
        { id: second.task.id, updatedAt: second.task.updatedAt },
      ],
    });
    expect(operation.kind).toBe("bulk");
    expect(operation.changes).toHaveLength(2);
    expect((await service.getTask(first.task.id))?.plannedDate).toBe("2026-08-09");
    expect((await service.getTask(second.task.id))?.plannedDate).toBe("2026-08-09");
    await service.undo(operation.id);
    expect((await service.getTask(first.task.id))?.plannedDate).toBe("2026-08-08");
    expect((await service.getTask(second.task.id))?.plannedDate).toBe("2026-08-08");
  });

  it("batch-edits private attributes, preserves Feishu sync state, and undoes once", async () => {
    const { service } = await createFixture();
    const project = await service.createProject({ name: "发布" });
    const list = await service.createList({ name: "本周" });
    const local = await service.createTask({
      title: "本地批量编辑",
      priority: "low",
      tags: ["旧", "保留"],
    });
    const remote = await service.createTask({
      title: "飞书批量编辑",
      priority: "low",
      tags: ["旧"],
      source: { type: "feishu", accountId: "primary", externalId: "remote-edit" },
      sync: { status: "synced" },
    });
    const operation = await service.applyBulkTaskAction({
      ids: [local.task.id, remote.task.id],
      action: {
        kind: "edit",
        patch: {
          priority: "high",
          flagged: true,
          projectId: project.id,
          listId: list.id,
          tags: { mode: "add", values: ["新" ] },
        },
      },
      baselines: [
        { id: local.task.id, updatedAt: local.task.updatedAt },
        { id: remote.task.id, updatedAt: remote.task.updatedAt },
      ],
    });
    expect(operation.kind).toBe("bulk");
    expect(operation.changes).toHaveLength(2);
    expect(await service.getTask(local.task.id)).toMatchObject({
      priority: "high",
      flagged: true,
      projectId: project.id,
      listId: list.id,
      tags: ["旧", "保留", "新"],
    });
    expect(await service.getTask(remote.task.id)).toMatchObject({
      priority: "high",
      flagged: true,
      projectId: project.id,
      listId: list.id,
      tags: ["旧", "新"],
      sync: { status: "synced" },
    });
    await service.undo(operation.id);
    const restoredLocal = await service.getTask(local.task.id);
    expect(restoredLocal).toMatchObject({
      priority: "low",
      tags: ["旧", "保留"],
    });
    expect(restoredLocal?.flagged).toBeUndefined();
    expect(restoredLocal?.projectId).toBeUndefined();
    expect(restoredLocal?.listId).toBeUndefined();
    expect(await service.getTask(remote.task.id)).toMatchObject({
      priority: "low",
      tags: ["旧"],
      sync: { status: "synced" },
    });
    expect((await service.getTask(remote.task.id))?.flagged).toBeUndefined();
  });

  it("rejects malformed batch edit patches before touching tasks", async () => {
    const { service } = await createFixture();
    const task = await service.createTask({ title: "批量编辑校验" });
    const operationsBefore = await service.getOperations();
    await expect(
      service.applyBulkTaskAction({
        ids: [task.task.id],
        action: {
          kind: "edit",
          patch: { tags: { mode: "add", values: ["重复", "重复"] } },
        },
        baselines: [{ id: task.task.id, updatedAt: task.task.updatedAt }],
      }),
    ).rejects.toBeInstanceOf(TaskValidationError);
    expect(await service.getTask(task.task.id)).toMatchObject({ tags: [] });
    expect((await service.getOperations()).length).toBe(operationsBefore.length);
  });

  it("rejects a stale batch before changing any selected task", async () => {
    const { service, setNow } = await createFixture();
    const first = await service.createTask({ title: "仍应保持打开" });
    const second = await service.createTask({ title: "先被单独完成" });
    setNow("2026-08-09T10:01:00.000Z");
    await service.completeTask(second.task.id);
    const operationsBefore = await service.getOperations();
    await expect(
      service.applyBulkTaskAction({
        ids: [first.task.id, second.task.id],
        action: { kind: "complete" },
        baselines: [
          { id: first.task.id, updatedAt: first.task.updatedAt },
          { id: second.task.id, updatedAt: second.task.updatedAt },
        ],
      }),
    ).rejects.toThrow("已发生变化");
    expect((await service.getTask(first.task.id))?.status).toBe("open");
    expect((await service.getOperations()).length).toBe(operationsBefore.length);
  });

  it("keeps Feishu shared fields intact when batching private Today placement", async () => {
    const { service } = await createFixture();
    const remote = await service.createTask({
      title: "飞书批量任务",
      notes: "共享备注",
      dueAt: "2026-08-11T12:00:00.000Z",
      source: { type: "feishu", accountId: "primary", externalId: "remote-bulk" },
      sync: { status: "synced" },
      plannedDate: "2026-08-08",
    });
    const operation = await service.applyBulkTaskAction({
      ids: [remote.task.id],
      action: { kind: "move-to-today", date: "2026-08-09" },
      baselines: [{ id: remote.task.id, updatedAt: remote.task.updatedAt }],
    });
    const saved = await service.getTask(remote.task.id);
    expect(saved).toMatchObject({
      title: "飞书批量任务",
      notes: "共享备注",
      dueAt: "2026-08-11T12:00:00.000Z",
      plannedDate: "2026-08-09",
      sync: { status: "synced" },
    });
    expect(operation.changes[0]?.after?.sync).toEqual(operation.changes[0]?.before?.sync);
  });

  it("applies one ordered Today plan atomically with estimates and rolls older private plans forward", async () => {
    const { service } = await createFixture();
    const future = await service.createTask({
      title: "Future candidate",
      plannedDate: "2026-08-12",
      estimatedMinutes: 15,
      privateOrder: 90,
    });
    const rollover = await service.createTask({
      title: "Rollover candidate",
      plannedDate: "2026-08-08",
      privateOrder: 91,
    });
    const unplanned = await service.createTask({
      title: "Unplanned candidate",
      privateOrder: 92,
    });

    const operation = await service.applyTodayPlan({
      date: "2026-08-09",
      items: [
        { id: future.task.id, estimatedMinutes: 50 },
        { id: rollover.task.id, estimatedMinutes: 35 },
        { id: unplanned.task.id, estimatedMinutes: 20 },
      ],
      clearTaskIds: [],
      baselines: planBaselines(future.task, rollover.task, unplanned.task),
    });

    expect(operation).toMatchObject({
      kind: "plan-today",
      changes: [
        { taskId: future.task.id },
        { taskId: rollover.task.id },
        { taskId: unplanned.task.id },
      ],
    });
    expect(await service.getTask(future.task.id)).toMatchObject({
      plannedDate: "2026-08-09",
      estimatedMinutes: 50,
      privateOrder: 0,
    });
    expect(await service.getTask(rollover.task.id)).toMatchObject({
      plannedDate: "2026-08-09",
      estimatedMinutes: 35,
      privateOrder: 1,
    });
    expect(await service.getTask(unplanned.task.id)).toMatchObject({
      plannedDate: "2026-08-09",
      estimatedMinutes: 20,
      privateOrder: 2,
    });
    expect(
      (await service.getViewSections({ view: "today" }))
        .find((section) => section.id === "planned-today")
        ?.tasks.map((task) => task.id),
    ).toEqual([future.task.id, rollover.task.id, unplanned.task.id]);
    expect(
      (await service.getOperations()).filter(
        (candidate) => candidate.kind === "plan-today",
      ),
    ).toEqual([expect.objectContaining({ id: operation.id })]);
  });

  it("accepts a future private plan from the evening review while rejecting past dates", async () => {
    const { service } = await createFixture();
    const task = await service.createTask({
      title: "Tomorrow candidate",
      estimatedMinutes: 30,
      privateOrder: 4,
    });

    const operation = await service.applyTodayPlan({
      date: "2026-08-10",
      items: [{ id: task.task.id }],
      clearTaskIds: [],
      baselines: planBaselines(task.task),
    });
    expect(operation.kind).toBe("plan-today");
    expect((await service.getTask(task.task.id))?.plannedDate).toBe(
      "2026-08-10",
    );

    await expect(
      service.applyTodayPlan({
        date: "2026-08-08",
        items: [{ id: task.task.id }],
        clearTaskIds: [],
        baselines: planBaselines((await service.getTask(task.task.id))!),
      }),
    ).rejects.toBeInstanceOf(TaskStateError);
  });

  it("undoes an entire Today planning session in one operation", async () => {
    const { service } = await createFixture();
    const selected = await service.createTask({
      title: "Select for Today",
      plannedDate: "2026-08-12",
      estimatedMinutes: 10,
      privateOrder: 41,
    });
    const cleared = await service.createTask({
      title: "Remove from private Today plan",
      plannedDate: "2026-08-08",
      estimatedMinutes: 25,
      privateOrder: 42,
    });
    const selectedBefore = await service.getTask(selected.task.id);
    const clearedBefore = await service.getTask(cleared.task.id);

    const operation = await service.applyTodayPlan({
      date: "2026-08-09",
      items: [{ id: selected.task.id, estimatedMinutes: 55 }],
      clearTaskIds: [cleared.task.id],
      baselines: planBaselines(selected.task, cleared.task),
    });
    expect(await service.getTask(selected.task.id)).toMatchObject({
      plannedDate: "2026-08-09",
      estimatedMinutes: 55,
      privateOrder: 0,
    });
    expect(
      (await service.getTask(cleared.task.id))?.plannedDate,
    ).toBeUndefined();

    const undone = await service.undo(operation.id);

    expect(undone.operationId).toBe(operation.id);
    expect(undone.restoredTasks.map((task) => task.id).sort()).toEqual(
      [selected.task.id, cleared.task.id].sort(),
    );
    expect(await service.getTask(selected.task.id)).toEqual(selectedBefore);
    expect(await service.getTask(cleared.task.id)).toEqual(clearedBefore);
    expect(
      (await service.getOperations()).find(
        (candidate) => candidate.id === operation.id,
      )?.undoneAt,
    ).toBeDefined();
  });

  it("keeps confirmed start-only work as a private carry-over on the next day", async () => {
    const { service, setNow } = await createFixture();
    const task = await service.createTask({
      title: "Starts today and may continue",
      startAt: "2026-08-09T11:00:00.000Z",
      plannedDate: "2026-08-12",
      privateOrder: 7,
    });

    await service.applyTodayPlan({
      date: "2026-08-09",
      items: [{ id: task.task.id }],
      clearTaskIds: [],
      baselines: planBaselines(task.task),
    });
    expect((await service.getTask(task.task.id))?.plannedDate).toBe(
      "2026-08-09",
    );

    setNow("2026-08-10T10:00:00.000Z");
    expect(
      (await service.listTasks({ view: "today" })).map((item) => item.id),
    ).toContain(task.task.id);
  });

  it("undoes only plan fields after focus changes and rejects a later plan edit", async () => {
    const { service, setNow } = await createFixture();
    const task = await service.createTask({
      title: "Plan fields stay isolated",
      plannedDate: "2026-08-12",
      estimatedMinutes: 20,
      privateOrder: 8,
    });
    const operation = await service.applyTodayPlan({
      date: "2026-08-09",
      items: [{ id: task.task.id, estimatedMinutes: 45 }],
      clearTaskIds: [],
      baselines: planBaselines(task.task),
    });

    setNow("2026-08-09T10:05:00.000Z");
    await service.startFocus(task.task.id);
    await service.undo(operation.id);
    expect(await service.getTask(task.task.id)).toMatchObject({
      plannedDate: "2026-08-12",
      estimatedMinutes: 20,
      privateOrder: 8,
      focusStartedAt: "2026-08-09T10:05:00.000Z",
    });

    const secondTask = await service.createTask({
      title: "Conflicting plan edit",
      estimatedMinutes: 30,
      privateOrder: 9,
    });
    const secondOperation = await service.applyTodayPlan({
      date: "2026-08-09",
      items: [{ id: secondTask.task.id, estimatedMinutes: 50 }],
      clearTaskIds: [],
      baselines: planBaselines(secondTask.task),
    });
    await service.updateTask(secondTask.task.id, { estimatedMinutes: 60 });
    await expect(service.undo(secondOperation.id)).rejects.toBeInstanceOf(
      UndoConflictError,
    );
  });

  it("rejects stale private planning snapshots and dates", async () => {
    const { service, setNow } = await createFixture();
    const task = await service.createTask({
      title: "Changed while planner is open",
      plannedDate: "2026-08-12",
      estimatedMinutes: 20,
      privateOrder: 10,
    });
    const staleBaseline = planBaselines(task.task);
    await service.updateTask(task.task.id, { estimatedMinutes: 25 });

    await expect(
      service.applyTodayPlan({
        date: "2026-08-09",
        items: [{ id: task.task.id, estimatedMinutes: 40 }],
        clearTaskIds: [],
        baselines: staleBaseline,
      }),
    ).rejects.toBeInstanceOf(TaskStateError);
    expect((await service.getTask(task.task.id))?.plannedDate).toBe(
      "2026-08-12",
    );

    const current = (await service.getTask(task.task.id))!;
    setNow("2026-08-10T00:00:00.000Z");
    await expect(
      service.applyTodayPlan({
        date: "2026-08-09",
        items: [{ id: current.id }],
        clearTaskIds: [],
        baselines: planBaselines(current),
      }),
    ).rejects.toBeInstanceOf(TaskStateError);
  });

  it("rejects invalid Today plans without leaving any partial task or operation changes", async () => {
    const { service } = await createFixture();
    const valid = await service.createTask({
      title: "Must remain unchanged",
      plannedDate: "2026-08-12",
      estimatedMinutes: 15,
      privateOrder: 73,
    });
    const completed = await service.createTask({
      title: "Completed cannot be planned",
      status: "completed",
      completedAt: "2026-08-09T09:00:00.000Z",
    });
    const validBefore = await service.getTask(valid.task.id);
    const operationCountBefore = (await service.getOperations()).length;

    await expect(
      service.applyTodayPlan({
        date: "2026-08-09",
        items: [{ id: valid.task.id }, { id: valid.task.id }],
        clearTaskIds: [],
        baselines: planBaselines(valid.task),
      }),
    ).rejects.toBeInstanceOf(TaskValidationError);
    await expect(
      service.applyTodayPlan({
        date: "2026-08-09",
        items: [],
        clearTaskIds: [valid.task.id, valid.task.id],
        baselines: planBaselines(valid.task),
      }),
    ).rejects.toBeInstanceOf(TaskValidationError);
    await expect(
      service.applyTodayPlan({
        date: "2026-08-09",
        items: [{ id: valid.task.id }],
        clearTaskIds: [valid.task.id],
        baselines: planBaselines(valid.task),
      }),
    ).rejects.toBeInstanceOf(TaskValidationError);

    // The valid task is deliberately processed first. The later completed
    // task must abort and roll back the earlier private planning mutation.
    await expect(
      service.applyTodayPlan({
        date: "2026-08-09",
        items: [{ id: valid.task.id }, { id: completed.task.id }],
        clearTaskIds: [],
        baselines: planBaselines(valid.task, completed.task),
      }),
    ).rejects.toBeInstanceOf(TaskStateError);
    expect(await service.getTask(valid.task.id)).toEqual(validBefore);

    // A missing cleared task is checked after selected items have been
    // mutated inside the transaction, so this also proves full rollback.
    await expect(
      service.applyTodayPlan({
        date: "2026-08-09",
        items: [{ id: valid.task.id, estimatedMinutes: 60 }],
        clearTaskIds: ["task-missing"],
        baselines: [
          ...planBaselines(valid.task),
          { id: "task-missing", privateOrder: 0 },
        ],
      }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);

    expect(await service.getTask(valid.task.id)).toEqual(validBefore);
    expect((await service.getOperations()).length).toBe(operationCountBefore);
    expect(
      (await service.getOperations()).some(
        (candidate) => candidate.kind === "plan-today",
      ),
    ).toBe(false);
  });

  it("keeps Feishu sync metadata and provider-owned fields unchanged while planning privately", async () => {
    const { service } = await createFixture();
    const selected = await service.createTask({
      title: "Remote selected task",
      notes: "Shared description",
      source: {
        type: "feishu",
        accountId: "account-plan",
        externalId: "remote-plan-selected",
      },
      dueAt: "2026-08-12T18:00:00.000Z",
      plannedDate: "2026-08-12",
      estimatedMinutes: 20,
      privateOrder: 81,
      sync: {
        status: "synced",
        lastSyncedAt: "2026-08-09T08:00:00.000Z",
      },
    });
    const cleared = await service.createTask({
      title: "Remote cleared task",
      source: {
        type: "feishu",
        accountId: "account-plan",
        externalId: "remote-plan-cleared",
      },
      dueAt: "2026-08-09T17:00:00.000Z",
      plannedDate: "2026-08-09",
      privateOrder: 82,
      sync: {
        status: "synced",
        lastSyncedAt: "2026-08-09T08:05:00.000Z",
      },
    });
    const selectedBefore = await service.getTask(selected.task.id);
    const clearedBefore = await service.getTask(cleared.task.id);

    const operation = await service.applyTodayPlan({
      date: "2026-08-09",
      items: [{ id: selected.task.id, estimatedMinutes: 65 }],
      clearTaskIds: [cleared.task.id],
      baselines: planBaselines(selected.task, cleared.task),
    });
    const selectedAfter = await service.getTask(selected.task.id);
    const clearedAfter = await service.getTask(cleared.task.id);

    expect(operation.kind).toBe("plan-today");
    expect(selectedAfter).toMatchObject({
      title: selectedBefore!.title,
      notes: selectedBefore!.notes,
      source: selectedBefore!.source,
      dueAt: selectedBefore!.dueAt,
      plannedDate: "2026-08-09",
      estimatedMinutes: 65,
      privateOrder: 0,
      sync: selectedBefore!.sync,
    });
    expect(clearedAfter).toMatchObject({
      title: clearedBefore!.title,
      source: clearedBefore!.source,
      dueAt: clearedBefore!.dueAt,
      sync: clearedBefore!.sync,
    });
    expect(clearedAfter?.plannedDate).toBeUndefined();
    expect(operation.changes).toHaveLength(2);
    operation.changes.forEach((change) => {
      expect(change.after?.sync).toEqual(change.before?.sync);
      expect(change.after?.source).toEqual(change.before?.source);
      expect(change.after?.dueAt).toBe(change.before?.dueAt);
      expect(change.after?.title).toBe(change.before?.title);
      expect(change.after?.notes).toBe(change.before?.notes);
    });
  });

  it("moves tasks through trash, restores them, and safely undoes both actions", async () => {
    const { service } = await createFixture();
    const created = await service.createTask({ title: "Recoverable" });

    const trashed = await service.moveToTrash(created.task.id);
    expect(await service.getTask(created.task.id)).toBeUndefined();
    expect((await service.listTasks({ view: "trash" }))[0]?.id).toBe(
      created.task.id,
    );

    const restored = await service.restoreTask(created.task.id);
    expect((await service.getTask(created.task.id))?.deletedAt).toBeUndefined();

    await service.undo(restored.operationId);
    expect(
      (await service.getTask(created.task.id, true))?.deletedAt,
    ).toBeDefined();

    await service.undo(trashed.operationId);
    expect((await service.getTask(created.task.id))?.title).toBe("Recoverable");
  });

  it("rejects undo when a later change touched the same task", async () => {
    const { service } = await createFixture();
    const created = await service.createTask({ title: "First title" });
    const firstUpdate = await service.updateTask(created.task.id, {
      title: "Second title",
    });
    await service.updateTask(created.task.id, { title: "Third title" });

    await expect(service.undo(firstUpdate.operationId)).rejects.toThrow(
      "changed afterwards",
    );
  });

  it("queues the inverse Feishu mutation when undoing a shared-field change", async () => {
    const { service } = await createFixture();
    const created = await service.createTask({
      title: "Remote title before undo",
      source: {
        type: "feishu",
        accountId: "account-undo",
        externalId: "remote-undo-update",
      },
      sync: { status: "synced" },
    });

    const updated = await service.updateTask(created.task.id, {
      title: "Remote title after undoable change",
    });
    const undone = await service.undo(updated.operationId);

    expect(undone.restoredTasks).toHaveLength(1);
    expect(await service.getTask(created.task.id)).toMatchObject({
      title: "Remote title before undo",
      sync: { status: "pending" },
    });
  });

  it("queues inverse completion and reopen states for Feishu undo", async () => {
    const { service } = await createFixture();
    const open = await service.createTask({
      title: "Remote completion undo",
      source: {
        type: "feishu",
        accountId: "account-undo",
        externalId: "remote-undo-complete",
      },
      sync: { status: "synced" },
    });
    const completed = await service.completeTask(open.task.id);
    await service.undo(completed.operationId);
    expect(await service.getTask(open.task.id)).toMatchObject({
      status: "open",
      sync: { status: "pending" },
    });

    const completedAgain = await service.completeTask(open.task.id);
    const reopened = await service.reopenTask(open.task.id);
    await service.undo(reopened.operationId);
    expect(await service.getTask(open.task.id)).toMatchObject({
      status: "completed",
      sync: { status: "pending" },
    });
    // The second completion is intentionally left in history: it proves the
    // reopen operation was the exact snapshot restored above.
    expect(completedAgain.operationId).toBeTruthy();
  });

  it("keeps an undone Feishu create as a recoverable pending tombstone", async () => {
    const { service } = await createFixture();
    const created = await service.createTask({
      title: "Remote create undo",
      source: {
        type: "feishu",
        accountId: "account-undo",
        externalId: "remote-undo-create",
      },
      sync: { status: "synced" },
    });

    const undone = await service.undo(created.operationId);
    expect(undone.removedTaskIds).toEqual([created.task.id]);
    expect(await service.getTask(created.task.id)).toBeUndefined();
    expect(await service.getTask(created.task.id, true)).toMatchObject({
      source: { type: "feishu", externalId: "remote-undo-create" },
      sync: { status: "pending" },
    });
    expect(
      (await service.getTask(created.task.id, true))?.deletedAt,
    ).toBeDefined();
  });

  it("persists editor drafts and task state across service instances", async () => {
    const { directory, service } = await createFixture();
    const task = await service.createTask({ title: "Persist me" });
    const draft = await service.saveDraft({
      kind: "task-editor",
      taskId: task.task.id,
      text: "unfinished edit",
      data: { cursor: 7 },
    });

    const restarted = new TaskService(new LocalStore(directory), {
      timeZone: "UTC",
    });
    await restarted.initialize();

    expect((await restarted.getTask(task.task.id))?.title).toBe("Persist me");
    expect(await restarted.getDraft(draft.id)).toMatchObject({
      text: "unfinished edit",
      taskId: task.task.id,
      data: { cursor: 7 },
    });
  });

  it("generates the next local recurrence and shifts its private schedule", async () => {
    const { service } = await createFixture();
    const recurring = await service.createTask({
      title: "Month end review",
      plannedDate: "2026-08-31",
      dueAt: "2026-08-31T16:00:00.000Z",
      reminders: [
        {
          id: "reminder",
          at: "2026-08-31T15:30:00.000Z",
          enabled: true,
          source: "local",
        },
      ],
      recurrence: {
        frequency: "monthly",
        interval: 1,
        dayOfMonth: 31,
        maxOccurrences: 2,
      },
    });

    const completed = await service.completeTask(recurring.task.id);

    expect(completed.task.status).toBe("completed");
    expect(completed.generatedTask).toMatchObject({
      status: "open",
      plannedDate: "2026-09-30",
      dueAt: "2026-09-30T16:00:00.000Z",
      recurrenceIndex: 1,
      recurrenceSeriesId: recurring.task.id,
      focusElapsedSeconds: 0,
    });
    expect(completed.generatedTask?.reminders[0]?.at).toBe(
      "2026-09-30T15:30:00.000Z",
    );
    expect(completed.generatedTask?.reminders[0]?.id).toBe(
      `${completed.generatedTask?.id}:r:0`,
    );

    const finalOccurrence = await service.completeTask(
      completed.generatedTask!.id,
    );
    expect(finalOccurrence.generatedTask).toBeUndefined();
  });

  it("skips one local recurrence in place, shifts its schedule, and undoes atomically", async () => {
    const { service } = await createFixture();
    const recurring = await service.createTask({
      title: "跳过本次的周报",
      plannedDate: "2026-08-09",
      startAt: "2026-08-09T09:00:00.000Z",
      dueAt: "2026-08-09T10:00:00.000Z",
      timeBlock: {
        startAt: "2026-08-09T09:00:00.000Z",
        endAt: "2026-08-09T10:30:00.000Z",
      },
      reminders: [
        {
          id: "weekly-reminder",
          at: "2026-08-09T08:45:00.000Z",
          enabled: true,
          source: "local",
        },
      ],
      recurrence: { frequency: "weekly", interval: 1, weekdays: [0] },
    });

    const skipped = await service.skipRecurringTask(recurring.task.id);

    expect(skipped.task).toMatchObject({
      id: recurring.task.id,
      status: "open",
      recurrenceIndex: 1,
      plannedDate: "2026-08-16",
      startAt: "2026-08-16T09:00:00.000Z",
      dueAt: "2026-08-16T10:00:00.000Z",
      timeBlock: {
        startAt: "2026-08-16T09:00:00.000Z",
        endAt: "2026-08-16T10:30:00.000Z",
      },
    });
    expect(skipped.task.reminders[0]?.at).toBe(
      "2026-08-16T08:45:00.000Z",
    );
    expect(skipped.operationId).toBeTruthy();
    expect((await service.getOperations(1))[0]?.kind).toBe("skip-recurring");
    expect((await service.listTasks({ includeDeleted: true })).map((task) => task.id)).toEqual([
      recurring.task.id,
    ]);

    await service.undo(skipped.operationId);
    expect(await service.getTask(recurring.task.id)).toMatchObject({
      recurrenceIndex: 0,
      plannedDate: "2026-08-09",
      startAt: "2026-08-09T09:00:00.000Z",
      dueAt: "2026-08-09T10:00:00.000Z",
    });
    expect((await service.getTask(recurring.task.id))?.reminders[0]?.at).toBe(
      "2026-08-09T08:45:00.000Z",
    );
  });

  it("keeps provider recurrences and unsafe states fail-closed", async () => {
    const { service } = await createFixture();
    const remote = await service.createTask({
      title: "飞书循环",
      dueAt: "2026-08-09T10:00:00.000Z",
      recurrence: { frequency: "daily", interval: 1 },
      source: { type: "feishu", accountId: "primary", externalId: "remote-repeat" },
      sync: { status: "synced" },
    });
    await expect(service.skipRecurringTask(remote.task.id)).rejects.toThrow(
      "飞书循环由飞书负责生成",
    );
    expect(await service.getTask(remote.task.id)).toMatchObject({
      dueAt: "2026-08-09T10:00:00.000Z",
      recurrenceIndex: 0,
      sync: { status: "synced" },
    });

    const final = await service.createTask({
      title: "最后一次",
      plannedDate: "2026-08-09",
      recurrence: { frequency: "daily", interval: 1, maxOccurrences: 1 },
    });
    await expect(service.skipRecurringTask(final.task.id)).rejects.toThrow(
      "最后一次",
    );

    const focused = await service.createTask({
      title: "专注中的循环",
      plannedDate: "2026-08-09",
      recurrence: { frequency: "daily", interval: 1 },
    });
    await service.startFocus(focused.task.id);
    await expect(service.skipRecurringTask(focused.task.id)).rejects.toThrow(
      "请先暂停专注",
    );
    expect((await service.getTask(focused.task.id))?.recurrenceIndex).toBe(0);
  });

  it("edits one occurrence, future occurrences, or the entire recurrence series", async () => {
    const { service } = await createFixture();
    const first = await service.createTask({
      title: "Original",
      plannedDate: "2026-08-09",
      recurrence: { frequency: "daily", interval: 1 },
    });
    const firstCompletion = await service.completeTask(first.task.id);
    const second = firstCompletion.generatedTask!;
    const secondCompletion = await service.completeTask(second.id);
    const third = secondCompletion.generatedTask!;

    await service.updateTask(
      second.id,
      { privateNotes: "future only" },
      "future",
    );
    expect((await service.getTask(first.task.id))?.privateNotes).toBe("");
    expect((await service.getTask(second.id))?.privateNotes).toBe(
      "future only",
    );
    expect((await service.getTask(third.id))?.privateNotes).toBe("future only");

    await service.updateTask(third.id, { title: "Whole series" }, "series");
    expect((await service.getTask(first.task.id))?.title).toBe("Whole series");
    expect((await service.getTask(second.id))?.title).toBe("Whole series");
    expect((await service.getTask(third.id))?.title).toBe("Whole series");
  });

  it("tracks an active focus session without writing private state to sync", async () => {
    const { service, setNow } = await createFixture();
    const task = await service.createTask({
      title: "Focus",
      source: { type: "feishu", externalId: "remote-1" },
      sync: { status: "synced" },
    });

    const started = await service.startFocus(task.task.id);
    expect(started.task.sync.status).toBe("synced");
    setNow("2026-08-09T10:01:31.500Z");
    const paused = await service.pauseFocus(task.task.id);

    expect(paused.task.focusElapsedSeconds).toBe(91);
    expect(paused.task.focusStartedAt).toBeUndefined();
    expect(paused.task.focusSessions).toEqual([
      {
        id: `${task.task.id}:focus:2026-08-09T10:01:31.500Z`,
        startedAt: "2026-08-09T10:00:00.000Z",
        endedAt: "2026-08-09T10:01:31.500Z",
        elapsedSeconds: 91,
      },
    ]);
    expect(paused.task.sync.status).toBe("synced");
    await expect(service.pauseFocus(task.task.id)).rejects.toBeInstanceOf(
      TaskStateError,
    );
  });

  it("marks Feishu assignee and follower edits pending while keeping local organization private", async () => {
    const { service } = await createFixture();
    const task = await service.createTask({
      title: "Member sync boundary",
      source: { type: "feishu", externalId: "remote-members" },
      assigneeIds: ["ou_owner"],
      followerIds: ["ou_follower"],
      sync: { status: "synced" },
    });

    const localOnly = await service.updateTask(task.task.id, {
      projectId: "private-project",
    });
    expect(localOnly.task.sync.status).toBe("synced");

    const changed = await service.updateTask(task.task.id, {
      assigneeIds: ["ou_owner", "ou_new"],
      followerIds: ["ou_follower", "ou_observer"],
    });
    expect(changed.task).toMatchObject({
      assigneeIds: ["ou_owner", "ou_new"],
      followerIds: ["ou_follower", "ou_observer"],
      sync: { status: "pending" },
    });
  });

  it("refuses to misrepresent whole-task completion as a Feishu co-sign personal completion", async () => {
    const { service } = await createFixture();
    const task = await service.createTask({
      title: "Co-sign review",
      source: { type: "feishu", externalId: "remote-cosign" },
      completionMode: "all-assignees",
      currentUserRole: "assignee",
      currentUserCompleted: false,
      sync: { status: "synced" },
    });

    await expect(service.completeTask(task.task.id)).rejects.toThrow(
      /不支持完成会签任务中的“我的部分”/,
    );
    expect((await service.getTask(task.task.id))?.status).toBe("open");
  });

  it("calculates daily, selected-weekday, and month-end recurrence deterministically", () => {
    expect(
      getNextOccurrence("2026-08-09", { frequency: "daily", interval: 3 }),
    ).toBe("2026-08-12");
    expect(
      getNextOccurrence("2026-08-10", {
        frequency: "weekly",
        interval: 1,
        weekdays: [1, 3],
      }),
    ).toBe("2026-08-12");
    expect(
      getNextOccurrence("2027-01-31", {
        frequency: "monthly",
        interval: 1,
        dayOfMonth: 31,
      }),
    ).toBe("2027-02-28");
  });
});
