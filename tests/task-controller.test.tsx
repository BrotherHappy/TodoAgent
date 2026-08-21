import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../src/shared/desktop-api";
import type {
  Task,
  TaskMutationResult,
  TaskViewSection,
} from "../src/shared/models";
import { useTaskController } from "../src/renderer/task-controller";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function makeTask(dueAt: string): Task {
  return {
    id: "task-date-refresh",
    source: { type: "local" },
    title: "日期刷新验收任务",
    notes: "",
    privateNotes: "",
    status: "open",
    priority: "medium",
    tags: [],
    dependencyIds: [],
    assigneeIds: [],
    followerIds: [],
    attachments: [],
    links: [],
    customFields: {},
    plannedDate: "2026-08-10",
    dueAt,
    reminders: [],
    focusElapsedSeconds: 0,
    privateOrder: 0,
    sync: { status: "local" },
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

afterEach(() => {
  delete window.desktopApi;
});

describe("useTaskController", () => {
  it("keeps the inspector task and visible sections on the newest single snapshot after a date edit", async () => {
    const oldTask = makeTask("2026-08-10T09:00:00.000Z");
    const updatedTask = {
      ...oldTask,
      dueAt: "2026-08-10T10:30:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const initialSections = deferred<TaskViewSection[]>();
    const broadcastSections = deferred<TaskViewSection[]>();
    const oldSnapshot: TaskViewSection[] = [
      { id: "due-today", tasks: [oldTask] },
    ];
    const newSnapshot: TaskViewSection[] = [
      { id: "due-today", tasks: [updatedTask] },
    ];
    const taskListeners = new Set<() => void>();
    const list = vi.fn(async () => [updatedTask]);
    const sections = vi
      .fn<() => Promise<TaskViewSection[]>>()
      .mockImplementationOnce(async () => initialSections.promise)
      .mockImplementationOnce(async () => broadcastSections.promise)
      .mockResolvedValueOnce(newSnapshot);
    const update = vi.fn(async (): Promise<TaskMutationResult> => {
      taskListeners.forEach((listener) => listener());
      return { task: updatedTask, operationId: "operation-date-refresh" };
    });
    window.desktopApi = {
      tasks: { list, sections, update },
      events: {
        onTasksChanged: (listener: () => void) => {
          taskListeners.add(listener);
          return () => taskListeners.delete(listener);
        },
      },
    } as unknown as DesktopApi;

    const { result } = renderHook(() => useTaskController("today", ""));
    await waitFor(() => expect(sections).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(taskListeners.size).toBe(1));

    let save!: Promise<string | undefined>;
    act(() => {
      save = result.current.update(oldTask.id, { dueAt: updatedTask.dueAt });
    });
    await waitFor(() => expect(sections).toHaveBeenCalledTimes(3));
    await act(async () => {
      await save;
    });

    expect(result.current.selected?.dueAt).toBe(updatedTask.dueAt);
    expect(result.current.sections[0]?.tasks[0]?.dueAt).toBe(updatedTask.dueAt);
    expect(list).not.toHaveBeenCalled();

    // The initial route load and the task-change broadcast both complete late.
    // Neither may put the old due label back into the Today section after save.
    await act(async () => {
      initialSections.resolve(oldSnapshot);
      await Promise.resolve();
      broadcastSections.resolve(oldSnapshot);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(result.current.sections[0]?.tasks[0]?.dueAt).toBe(
        updatedTask.dueAt,
      ),
    );
    expect(result.current.selected?.dueAt).toBe(updatedTask.dueAt);
  });

  it("queues a delayed date edit before the newer all-day selection", async () => {
    const initialTask = {
      ...makeTask("2026-08-10T09:00:00.000Z"),
      startAt: "2026-08-10T08:30:00.000Z",
    };
    const dateEditedTask = {
      ...initialTask,
      startAt: "2026-08-11T09:15:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const allDayTask = {
      ...dateEditedTask,
      startAt: "2026-08-11T00:00:00.000Z",
      startAtIsAllDay: true,
      updatedAt: "2026-08-10T00:02:00.000Z",
    };
    const lateDateSave = deferred<TaskMutationResult>();
    const sections = vi
      .fn<() => Promise<TaskViewSection[]>>()
      .mockResolvedValueOnce([{ id: "due-today", tasks: [initialTask] }])
      .mockResolvedValueOnce([{ id: "due-today", tasks: [allDayTask] }]);
    const update = vi
      .fn()
      .mockImplementationOnce(() => lateDateSave.promise)
      .mockResolvedValueOnce({
        task: allDayTask,
        operationId: "operation-toggle-all-day",
      });
    window.desktopApi = {
      tasks: { sections, update },
      events: { onTasksChanged: () => () => undefined },
    } as unknown as DesktopApi;

    const { result } = renderHook(() => useTaskController("today", ""));
    await waitFor(() => expect(result.current.selected?.id).toBe(initialTask.id));

    let dateSave!: Promise<string | undefined>;
    act(() => {
      dateSave = result.current.update(initialTask.id, {
        startAt: dateEditedTask.startAt,
      });
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));

    let allDaySave!: Promise<string | undefined>;
    act(() => {
      allDaySave = result.current.update(initialTask.id, {
        startAt: allDayTask.startAt,
        startAtIsAllDay: true,
      });
    });
    // The second UI change is accepted immediately, but its IPC call must
    // wait so the main process cannot apply the two patches in reverse order.
    expect(update).toHaveBeenCalledTimes(1);

    await act(async () => {
      lateDateSave.resolve({
        task: dateEditedTask,
        operationId: "operation-edit-date",
      });
      await dateSave;
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenLastCalledWith({
      id: initialTask.id,
      patch: {
        startAt: allDayTask.startAt,
        startAtIsAllDay: true,
      },
      recurrenceScope: undefined,
    });
    await act(async () => {
      await allDaySave;
    });

    expect(result.current.tasks[0]).toMatchObject({
      startAt: allDayTask.startAt,
      startAtIsAllDay: true,
    });
    expect(result.current.selected).toMatchObject({
      startAt: allDayTask.startAt,
      startAtIsAllDay: true,
    });
    expect(result.current.lastOperationId).toBe("operation-toggle-all-day");
  });

  it("serializes rapid edits to the same task before dispatching the next IPC update", async () => {
    const initialTask = makeTask("2026-08-10T09:00:00.000Z");
    const firstEditedTask = {
      ...initialTask,
      plannedDate: "2026-08-11",
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const secondEditedTask = {
      ...firstEditedTask,
      plannedDate: "2026-08-12",
      updatedAt: "2026-08-10T00:02:00.000Z",
    };
    const firstSave = deferred<TaskMutationResult>();
    const secondSave = deferred<TaskMutationResult>();
    const sections = vi
      .fn<() => Promise<TaskViewSection[]>>()
      .mockResolvedValueOnce([{ id: "due-today", tasks: [initialTask] }])
      .mockResolvedValueOnce([{ id: "upcoming", tasks: [secondEditedTask] }]);
    const update = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    window.desktopApi = {
      tasks: { sections, update },
      events: { onTasksChanged: () => () => undefined },
    } as unknown as DesktopApi;

    const { result } = renderHook(() => useTaskController("all", ""));
    await waitFor(() => expect(result.current.selected?.id).toBe(initialTask.id));

    let firstOperation!: Promise<string | undefined>;
    let secondOperation!: Promise<string | undefined>;
    act(() => {
      firstOperation = result.current.update(initialTask.id, {
        plannedDate: firstEditedTask.plannedDate,
      });
      secondOperation = result.current.update(initialTask.id, {
        plannedDate: secondEditedTask.plannedDate,
      });
    });

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenNthCalledWith(1, {
      id: initialTask.id,
      patch: { plannedDate: firstEditedTask.plannedDate },
      recurrenceScope: undefined,
    });

    await act(async () => {
      firstSave.resolve({
        task: firstEditedTask,
        operationId: "operation-first-plan",
      });
      await firstOperation;
    });

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenLastCalledWith({
      id: initialTask.id,
      patch: { plannedDate: secondEditedTask.plannedDate },
      recurrenceScope: undefined,
    });

    await act(async () => {
      secondSave.resolve({
        task: secondEditedTask,
        operationId: "operation-second-plan",
      });
      await secondOperation;
    });

    expect(result.current.selected?.plannedDate).toBe(
      secondEditedTask.plannedDate,
    );
    expect(result.current.lastOperationId).toBe("operation-second-plan");
  });

  it("keeps an edited task open and editable when the edit moves it outside the active view", async () => {
    const todayTask = makeTask("2026-08-10T10:00:00.000Z");
    const futureTask = {
      ...todayTask,
      plannedDate: "2026-08-11",
      dueAt: "2026-08-11T10:30:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const futureAllDayTask = {
      ...futureTask,
      dueAt: "2026-08-11T00:00:00.000Z",
      dueAtIsAllDay: true,
      updatedAt: "2026-08-10T00:02:00.000Z",
    };
    const sections = vi
      .fn<() => Promise<TaskViewSection[]>>()
      .mockResolvedValueOnce([{ id: "due-today", tasks: [todayTask] }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const get = vi
      .fn()
      .mockResolvedValueOnce(futureTask)
      .mockResolvedValueOnce(futureAllDayTask);
    const update = vi
      .fn()
      .mockResolvedValueOnce({
        task: futureTask,
        operationId: "operation-move-out-of-view",
      })
      .mockResolvedValueOnce({
        task: futureAllDayTask,
        operationId: "operation-edit-out-of-view",
      });
    window.desktopApi = {
      tasks: { sections, get, update },
      events: { onTasksChanged: () => () => undefined },
    } as unknown as DesktopApi;

    const { result } = renderHook(() => useTaskController("today", ""));
    await waitFor(() => expect(result.current.selected?.id).toBe(todayTask.id));

    await act(async () => {
      await result.current.update(todayTask.id, {
        plannedDate: futureTask.plannedDate,
        dueAt: futureTask.dueAt,
      });
    });

    await waitFor(() =>
      expect(result.current.selected?.dueAt).toBe(futureTask.dueAt),
    );
    expect(result.current.tasks).toHaveLength(0);
    expect(get).toHaveBeenCalledWith(todayTask.id, true);

    await act(async () => {
      await result.current.update(todayTask.id, {
        dueAt: futureAllDayTask.dueAt,
        dueAtIsAllDay: true,
      });
    });

    expect(update).toHaveBeenLastCalledWith({
      id: todayTask.id,
      patch: {
        dueAt: futureAllDayTask.dueAt,
        dueAtIsAllDay: true,
      },
      recurrenceScope: undefined,
    });
    expect(result.current.tasks).toHaveLength(0);
    expect(result.current.selected).toMatchObject({
      dueAt: futureAllDayTask.dueAt,
      dueAtIsAllDay: true,
    });
    expect(get).toHaveBeenLastCalledWith(todayTask.id, true);
  });

  it("clears a stale inspector when the selected task is trashed outside the controller", async () => {
    const task = makeTask("2026-08-10T10:00:00.000Z");
    const trashedTask = {
      ...task,
      deletedAt: "2026-08-10T00:05:00.000Z",
      updatedAt: "2026-08-10T00:05:00.000Z",
    };
    const listeners = new Set<() => void>();
    const sections = vi
      .fn<() => Promise<TaskViewSection[]>>()
      .mockResolvedValueOnce([{ id: "due-today", tasks: [task] }])
      .mockResolvedValueOnce([]);
    const get = vi.fn().mockResolvedValue(trashedTask);
    window.desktopApi = {
      tasks: { sections, get },
      events: {
        onTasksChanged: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as DesktopApi;

    const { result } = renderHook(() => useTaskController("today", ""));
    await waitFor(() => expect(result.current.selected?.id).toBe(task.id));

    act(() => listeners.forEach((listener) => listener()));

    await waitFor(() => expect(result.current.tasks).toHaveLength(0));
    await waitFor(() => expect(result.current.selected).toBeUndefined());
    expect(result.current.selectedId).toBeUndefined();
    expect(get).toHaveBeenCalledWith(task.id, true);
  });

  it("routes skip recurring through the desktop API and refreshes the same task", async () => {
    const task = {
      ...makeTask("2026-08-10T10:00:00.000Z"),
      recurrence: { frequency: "daily" as const, interval: 1 },
      recurrenceSeriesId: "task-date-refresh",
      recurrenceIndex: 0,
      plannedDate: "2026-08-10",
    };
    const skipped = {
      ...task,
      recurrenceIndex: 1,
      plannedDate: "2026-08-11",
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const sections = vi
      .fn<() => Promise<TaskViewSection[]>>()
      .mockResolvedValueOnce([{ id: "due-today", tasks: [task] }])
      .mockResolvedValueOnce([{ id: "upcoming", tasks: [skipped] }]);
    const skipRecurring = vi.fn().mockResolvedValue({
      task: skipped,
      operationId: "operation-skip-recurring",
    });
    window.desktopApi = {
      tasks: { sections, skipRecurring },
      events: { onTasksChanged: () => () => undefined },
    } as unknown as DesktopApi;

    const { result } = renderHook(() => useTaskController("all", ""));
    await waitFor(() => expect(result.current.selected?.id).toBe(task.id));

    await act(async () => {
      await result.current.skipRecurring(task.id);
    });

    expect(skipRecurring).toHaveBeenCalledWith(task.id);
    expect(result.current.selected).toMatchObject({
      id: task.id,
      recurrenceIndex: 1,
      plannedDate: "2026-08-11",
    });
    expect(result.current.lastOperationId).toBe("operation-skip-recurring");
  });
});
