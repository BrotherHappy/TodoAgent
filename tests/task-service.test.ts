import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStore } from "../electron/services/local-store";
import { getNextOccurrence } from "../electron/services/recurrence";
import {
  TaskService,
  TaskStateError,
  TaskValidationError,
} from "../electron/services/task-service";

const testDirectories: string[] = [];

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
  it("stores the complete task shape and normalizes user-entered values", async () => {
    const { service } = await createFixture();

    const result = await service.createTask({
      title: "  Ship release  ",
      notes: "Shared description",
      privateNotes: "Personal note",
      priority: "urgent",
      projectId: "product",
      listId: "launch",
      sectionId: "ready",
      tags: [" release ", "release", "desktop"],
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
      dependencyIds: ["dependency"],
      focusElapsedSeconds: 0,
      focusSessions: [],
      estimatedMinutes: 45,
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

  it("supports text search plus source, project, tag, priority, status, and date filters", async () => {
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
});

describe("TaskService mutations, recovery, and recurrence", () => {
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
