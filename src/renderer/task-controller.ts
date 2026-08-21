import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApplyTodayPlanRequest,
  BulkTaskRequest,
  CreateTaskInput,
  RecurrenceEditScope,
  Task,
  TaskFilter,
  TaskId,
  TaskMutationResult,
  TaskView,
  TaskViewSection,
  TaskSourceType,
  UpdateTaskInput,
} from "../shared/models";

const localDate = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const demoTask = (
  id: string,
  title: string,
  overrides: Partial<Task> = {},
): Task => {
  const now = new Date().toISOString();
  return {
    id,
    source: { type: "local" },
    title,
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
    plannedDate: localDate(),
    reminders: [],
    focusElapsedSeconds: 0,
    privateOrder: 0,
    sync: { status: "local" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

const demoTasks: Task[] = [
  demoTask("demo-client", "回复客户问题", {
    priority: "high",
    privateOrder: 0,
  }),
  demoTask("demo-release", "写版本说明", {
    source: { type: "feishu", externalId: "demo-release" },
    dueAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
    sync: { status: "synced" },
    privateOrder: 1,
  }),
  demoTask("demo-announce", "发布公告", {
    source: { type: "feishu", externalId: "demo-announce" },
    dueAt: new Date(Date.now() + 7 * 60 * 60_000).toISOString(),
    dependencyIds: ["demo-release"],
    sync: { status: "synced" },
    privateOrder: 2,
  }),
];

function fallbackMatchesView(task: Task, view: TaskView): boolean {
  if (view === "trash") return Boolean(task.deletedAt);
  if (task.deletedAt) return false;
  if (view === "completed") return task.status === "completed";
  if (view === "all") return true;
  if (view === "inbox")
    return !task.plannedDate && !task.dueAt && !task.projectId;
  if (view === "upcoming")
    return Boolean(task.plannedDate && task.plannedDate > localDate());
  return (
    task.status === "open" &&
    (task.plannedDate === localDate() ||
      Boolean(task.dueAt && task.dueAt.slice(0, 10) <= localDate()))
  );
}

function fallbackSections(tasks: Task[], view: TaskView): TaskViewSection[] {
  if (view !== "today")
    return [
      {
        id:
          view === "trash"
            ? "trash"
            : view === "completed"
              ? "completed"
              : view === "upcoming"
                ? "upcoming"
                : view === "inbox"
                  ? "inbox"
                  : "open",
        tasks,
      },
    ];
  const overdue = tasks.filter(
    (task) => task.dueAt && task.dueAt.slice(0, 10) < localDate(),
  );
  const dueToday = tasks.filter(
    (task) => task.dueAt?.slice(0, 10) === localDate(),
  );
  const planned = tasks.filter(
    (task) => !dueToday.includes(task) && task.plannedDate === localDate(),
  );
  return [
    { id: "overdue", tasks: overdue },
    { id: "due-today", tasks: dueToday },
    { id: "planned-today", tasks: planned },
  ].filter((section) => section.tasks.length) as TaskViewSection[];
}

export interface TaskController {
  tasks: Task[];
  sections: TaskViewSection[];
  selected?: Task;
  selectedId?: TaskId;
  loading: boolean;
  error?: string;
  lastOperationId?: string;
  select(id?: TaskId): void;
  refresh(): Promise<void>;
  create(
    input: CreateTaskInput,
    options?: { selectCreated?: boolean },
  ): Promise<TaskMutationResult | undefined>;
  update(
    id: TaskId,
    patch: UpdateTaskInput,
    recurrenceScope?: RecurrenceEditScope,
  ): Promise<string | undefined>;
  toggleComplete(
    task: Task,
    options?: { selectUpdated?: boolean },
  ): Promise<string | undefined>;
  moveToToday(id: TaskId): Promise<string | undefined>;
  startFocus(id: TaskId): Promise<string | undefined>;
  pauseFocus(id: TaskId): Promise<string | undefined>;
  resetFocus(id: TaskId): Promise<string | undefined>;
  trash(id: TaskId): Promise<string | undefined>;
  restore(id: TaskId): Promise<string | undefined>;
  purge(id: TaskId): Promise<string | undefined>;
  reorderToday(taskIds: TaskId[]): Promise<string | undefined>;
  applyTodayPlan(request: ApplyTodayPlanRequest): Promise<string | undefined>;
  applyBulkTaskAction(request: BulkTaskRequest): Promise<string | undefined>;
  undo(operationId?: string): Promise<void>;
}

export function useTaskController(
  view: TaskView,
  search: string,
  sourceType?: TaskSourceType,
): TaskController {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sections, setSections] = useState<TaskViewSection[]>([]);
  const [selectedId, setSelectedId] = useState<TaskId>();
  // A detail edit can intentionally move a task out of the active filtered
  // list (for example, planning a Today task for tomorrow). Keep the task
  // being edited available to the inspector instead of collapsing it midway
  // through the user's edit.
  const [selectedTask, setSelectedTask] = useState<Task>();
  const selectedIdRef = useRef<TaskId | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [lastOperationId, setLastOperationId] = useState<string>();
  const [fallback, setFallback] = useState<Task[]>(demoTasks);
  // A task list and its sections must describe the same read. Keeping a
  // monotonically increasing request id also prevents a slow, older refresh
  // (for example one triggered by the task-changed broadcast) from replacing
  // a newer post-save snapshot.
  const refreshRequestRef = useRef(0);
  // A fast sequence such as editing a date and immediately toggling “全天”
  // creates overlapping IPC calls. Their responses can arrive out of order;
  // only the newest mutation may directly replace the selected inspector task.
  const mutationRequestRef = useRef(0);
  // Electron invokes from a renderer are asynchronous. Without a per-editor
  // write queue, two quick blur saves can arrive at the main process in the
  // reverse order, leaving the earlier date in persistent storage. Preserve
  // the user's input order while allowing reads and unrelated UI work to run.
  const updateQueueRef = useRef<Promise<void>>(Promise.resolve());
  const api = window.desktopApi?.tasks;

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      if (api) {
        const filter: TaskFilter = {
          view,
          text: search || undefined,
          sourceTypes: sourceType ? [sourceType] : undefined,
        };
        // Do not read `list` and `sections` in parallel: an edit between those
        // two IPC reads can otherwise give the inspector a newer task while
        // the visible list still renders its old section snapshot. Sections
        // already contain every task for the active filter, so they are the
        // single authoritative snapshot for this controller.
        const nextSections = await api.sections(filter);
        const nextTasks = nextSections.flatMap((section) => section.tasks);
        if (requestId !== refreshRequestRef.current) return;
        const currentSelection = selectedIdRef.current;
        const visibleSelection = currentSelection
          ? nextTasks.find((task) => task.id === currentSelection)
          : undefined;
        let nextSelection = visibleSelection;
        if (currentSelection && !visibleSelection && typeof api.get === "function") {
          // A filtered-out task is still a valid selection. `get(..., true)`
          // also lets a concurrent trash/restore operation clear an inspector
          // whose deletion state no longer belongs in the active view. Other
          // filter changes (for example, moving Today to tomorrow) keep the
          // editor open so a multi-field edit is not interrupted.
          const fetchedSelection = await api.get(currentSelection, true);
          if (requestId !== refreshRequestRef.current) return;
          const deletionMatchesView =
            view === "trash"
              ? Boolean(fetchedSelection?.deletedAt)
              : !fetchedSelection?.deletedAt;
          nextSelection = deletionMatchesView
            ? fetchedSelection
            : undefined;
        }
        if (!currentSelection) nextSelection = nextTasks[0];
        setTasks(nextTasks);
        setSections(nextSections);
        selectedIdRef.current = nextSelection?.id;
        setSelectedId(nextSelection?.id);
        setSelectedTask(nextSelection);
      } else {
        const query = search.trim().toLocaleLowerCase();
        const next = fallback
          .filter((task) => fallbackMatchesView(task, view))
          .filter((task) => !sourceType || task.source.type === sourceType)
          .filter(
            (task) =>
              !query ||
              `${task.title} ${task.notes} ${task.tags.join(" ")}`
                .toLocaleLowerCase()
                .includes(query),
          );
        if (requestId !== refreshRequestRef.current) return;
        const currentSelection = selectedIdRef.current;
        const nextSelection = currentSelection
          ? fallback.find((task) => task.id === currentSelection)
          : next[0];
        setTasks(next);
        setSections(fallbackSections(next, view));
        selectedIdRef.current = nextSelection?.id;
        setSelectedId(nextSelection?.id);
        setSelectedTask(nextSelection);
      }
    } catch (reason) {
      if (requestId !== refreshRequestRef.current) return;
      setError(reason instanceof Error ? reason.message : "读取任务失败");
    } finally {
      if (requestId === refreshRequestRef.current) setLoading(false);
    }
  }, [api, fallback, search, sourceType, view]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!window.desktopApi) return undefined;
    return window.desktopApi.events.onTasksChanged(() => {
      void refresh();
    });
  }, [refresh]);

  const applyFallback = useCallback((id: TaskId, patch: Partial<Task>) => {
    setFallback((current) =>
      current.map((task) =>
        task.id === id
          ? { ...task, ...patch, updatedAt: new Date().toISOString() }
          : task,
      ),
    );
  }, []);

  const create = useCallback(
    async (
      input: CreateTaskInput,
      options?: { selectCreated?: boolean },
    ) => {
      const selectCreated = options?.selectCreated !== false;
      if (api) {
        const mutationRequest = ++mutationRequestRef.current;
        const result = await api.create(input);
        if (mutationRequest !== mutationRequestRef.current) return result;
        setLastOperationId(result.operationId);
        if (selectCreated) {
          selectedIdRef.current = result.task.id;
          setSelectedId(result.task.id);
        }
        await refresh();
        if (selectCreated && mutationRequest === mutationRequestRef.current) {
          selectedIdRef.current = result.task.id;
          setSelectedId(result.task.id);
          setSelectedTask(result.task);
        }
        return result;
      }
      const task = demoTask(crypto.randomUUID(), input.title, {
        ...input,
        source: input.source ?? { type: "local" },
        notes: input.notes ?? "",
        privateNotes: input.privateNotes ?? "",
        status: input.status ?? "open",
        priority: input.priority ?? "medium",
        tags: input.tags ?? [],
        plannedDate: input.plannedDate,
        dueAt: input.dueAt,
        sync:
          input.source?.type === "feishu"
            ? { status: "pending" }
            : { status: "local" },
      });
      setFallback((current) => [task, ...current]);
      if (selectCreated) {
        selectedIdRef.current = task.id;
        setSelectedId(task.id);
        setSelectedTask(task);
      }
      return undefined;
    },
    [api, refresh],
  );

  const update = useCallback(
    async (
      id: TaskId,
      patch: UpdateTaskInput,
      recurrenceScope?: RecurrenceEditScope,
    ) => {
      if (api) {
        const mutationRequest = ++mutationRequestRef.current;
        const write = async (): Promise<string | undefined> => {
          const result = await api.update({ id, patch, recurrenceScope });
          if (mutationRequest !== mutationRequestRef.current)
            return result.operationId;
          setLastOperationId(result.operationId);
          await refresh();
          if (mutationRequest === mutationRequestRef.current) {
            selectedIdRef.current = result.task.id;
            setSelectedId(result.task.id);
            setSelectedTask(result.task);
          }
          return result.operationId;
        };
        // Continue after a rejected earlier write: a corrected subsequent
        // value must not be blocked behind a validation failure.
        const queued = updateQueueRef.current.then(write, write);
        updateQueueRef.current = queued.then(
          () => undefined,
          () => undefined,
        );
        return queued;
      }
      applyFallback(id, patch as Partial<Task>);
      return undefined;
    },
    [api, applyFallback, refresh],
  );

  const reorderToday = useCallback(
    async (taskIds: TaskId[]) => {
      if (taskIds.length < 2) return undefined;
      if (api) {
        const operation = await api.reorderToday(taskIds);
        setLastOperationId(operation.id);
        await refresh();
        return operation.id;
      }
      const positions = new Map(taskIds.map((id, index) => [id, index]));
      setFallback((current) =>
        current.map((task) =>
          positions.has(task.id)
            ? {
                ...task,
                privateOrder: positions.get(task.id)!,
                updatedAt: new Date().toISOString(),
              }
            : task,
        ),
      );
      return undefined;
    },
    [api, refresh],
  );

  const applyTodayPlan = useCallback(
    async (request: ApplyTodayPlanRequest) => {
      if (api) {
        const operation = await api.applyTodayPlan(request);
        setLastOperationId(operation.id);
        await refresh();
        return operation.id;
      }
      const selected = new Map(
        request.items.map((item, index) => [item.id, { item, index }]),
      );
      const cleared = new Set(request.clearTaskIds);
      const plannedDate = request.date ?? localDate();
      setFallback((current) =>
        current.map((task) => {
          const plan = selected.get(task.id);
          if (plan) {
            return {
              ...task,
              plannedDate,
              privateOrder: plan.index,
              estimatedMinutes:
                plan.item.estimatedMinutes ?? task.estimatedMinutes,
              updatedAt: new Date().toISOString(),
            };
          }
          if (cleared.has(task.id)) {
            return {
              ...task,
              plannedDate: undefined,
              updatedAt: new Date().toISOString(),
            };
          }
          return task;
        }),
      );
      return undefined;
    },
    [api, refresh],
  );

  const applyBulkTaskAction = useCallback(
    async (request: BulkTaskRequest) => {
      if (api) {
        const operation = await api.applyBulkTaskAction(request);
        setLastOperationId(operation.id);
        await refresh();
        return operation.id;
      }
      const selected = new Set(request.ids);
      const now = new Date().toISOString();
      setFallback((current) =>
        current.map((task) => {
          if (!selected.has(task.id)) return task;
          if (request.action.kind === "complete") {
            return {
              ...task,
              status: "completed",
              completedAt: request.action.completedAt ?? now,
              updatedAt: now,
            };
          }
          if (request.action.kind === "reopen") {
            return {
              ...task,
              status: "open",
              completedAt: undefined,
              updatedAt: now,
            };
          }
          if (request.action.kind === "move-to-today") {
            return {
              ...task,
              plannedDate: request.action.date ?? localDate(),
              updatedAt: now,
            };
          }
          if (request.action.kind === "edit") {
            const { patch } = request.action;
            let tags = task.tags;
            if (patch.tags !== undefined) {
              tags = patch.tags.mode === "replace"
                ? [...patch.tags.values]
                : patch.tags.mode === "add"
                  ? [...new Set([...tags, ...patch.tags.values])]
                  : tags.filter((tag) => !patch.tags?.values.includes(tag));
            }
            return {
              ...task,
              ...(patch.priority === undefined ? {} : { priority: patch.priority }),
              ...(patch.projectId === undefined ? {} : { projectId: patch.projectId ?? undefined }),
              ...(patch.listId === undefined ? {} : { listId: patch.listId ?? undefined }),
              tags,
              updatedAt: now,
            };
          }
          if (request.action.kind === "trash") {
            return { ...task, deletedAt: now, updatedAt: now };
          }
          return { ...task, deletedAt: undefined, updatedAt: now };
        }),
      );
      return undefined;
    },
    [api, refresh],
  );

  const toggleComplete = useCallback(
    async (task: Task, options?: { selectUpdated?: boolean }) => {
      const selectUpdated = options?.selectUpdated !== false;
      if (api) {
        const mutationRequest = ++mutationRequestRef.current;
        const result =
          task.status === "completed"
            ? await api.reopen(task.id)
            : await api.complete({ id: task.id });
        if (mutationRequest !== mutationRequestRef.current)
          return result.operationId;
        setLastOperationId(result.operationId);
        await refresh();
        if (selectUpdated && mutationRequest === mutationRequestRef.current) {
          selectedIdRef.current = result.task.id;
          setSelectedId(result.task.id);
          setSelectedTask(result.task);
        }
        return result.operationId;
      }
      applyFallback(task.id, {
        status: task.status === "completed" ? "open" : "completed",
        completedAt:
          task.status === "completed" ? undefined : new Date().toISOString(),
      });
      return undefined;
    },
    [api, applyFallback, refresh],
  );

  const runMutation = useCallback(
    async (
      name:
        | "moveToToday"
        | "startFocus"
        | "pauseFocus"
        | "resetFocus"
        | "moveToTrash"
        | "restore",
      id: TaskId,
    ) => {
      if (api) {
        const mutationRequest = ++mutationRequestRef.current;
        const result =
          name === "moveToToday"
            ? await api.moveToToday({ id })
            : await api[name](id);
        if (mutationRequest !== mutationRequestRef.current)
          return result.operationId;
        setLastOperationId(result.operationId);
        await refresh();
        if (mutationRequest !== mutationRequestRef.current)
          return result.operationId;
        if (name === "moveToTrash" || name === "restore") {
          selectedIdRef.current = undefined;
          setSelectedId(undefined);
          setSelectedTask(undefined);
        } else {
          selectedIdRef.current = result.task.id;
          setSelectedId(result.task.id);
          setSelectedTask(result.task);
        }
        return result.operationId;
      }
      if (name === "moveToToday")
        applyFallback(id, { plannedDate: localDate() });
      if (name === "startFocus")
        applyFallback(id, { focusStartedAt: new Date().toISOString() });
      if (name === "pauseFocus")
        applyFallback(id, { focusStartedAt: undefined });
      if (name === "resetFocus")
        applyFallback(id, {
          focusStartedAt: undefined,
          focusElapsedSeconds: 0,
        });
      if (name === "moveToTrash")
        applyFallback(id, { deletedAt: new Date().toISOString() });
      if (name === "restore") applyFallback(id, { deletedAt: undefined });
      return undefined;
    },
    [api, applyFallback, refresh],
  );

  const undo = useCallback(
    async (operationId?: string) => {
      if (!api) return;
      await api.undo(operationId ?? lastOperationId);
      setLastOperationId(undefined);
      await refresh();
    },
    [api, lastOperationId, refresh],
  );

  const purge = useCallback(
    async (id: TaskId) => {
      if (api) {
        ++mutationRequestRef.current;
        await api.purge(id);
        selectedIdRef.current = undefined;
        setSelectedId(undefined);
        setSelectedTask(undefined);
        await refresh();
        return undefined;
      }
      setFallback((current) => current.filter((task) => task.id !== id));
      selectedIdRef.current = undefined;
      setSelectedId(undefined);
      setSelectedTask(undefined);
      return undefined;
    },
    [api, refresh],
  );

  return useMemo(
    () => ({
      tasks,
      sections,
      selected:
        tasks.find((task) => task.id === selectedId) ??
        (selectedTask?.id === selectedId ? selectedTask : undefined),
      selectedId,
      loading,
      error,
      lastOperationId,
      select: (id) => {
        selectedIdRef.current = id;
        setSelectedId(id);
        setSelectedTask(
          id ? tasks.find((task) => task.id === id) : undefined,
        );
      },
      refresh,
      create,
      update,
      toggleComplete,
      moveToToday: (id) => runMutation("moveToToday", id),
      startFocus: (id) => runMutation("startFocus", id),
      pauseFocus: (id) => runMutation("pauseFocus", id),
      resetFocus: (id) => runMutation("resetFocus", id),
      trash: (id) => runMutation("moveToTrash", id),
      restore: (id) => runMutation("restore", id),
      purge,
      reorderToday,
      applyTodayPlan,
      applyBulkTaskAction,
      undo,
    }),
    [
      tasks,
      sections,
      selectedId,
      selectedTask,
      loading,
      error,
      lastOperationId,
      refresh,
      create,
      update,
      toggleComplete,
      runMutation,
      purge,
      reorderToday,
      applyTodayPlan,
      applyBulkTaskAction,
      undo,
    ],
  );
}
