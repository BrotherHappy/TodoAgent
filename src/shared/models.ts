export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type IsoDateTime = string;
export type LocalDate = string;
export type TaskId = string;

/** A local project context. Feishu tasklists remain provider-owned and are
 * represented by the task's source.tasklist binding; this entity is private
 * to Todo Agent and is safe to use for both local and Feishu tasks. */
export type TaskProjectColor = 'violet' | 'blue' | 'green' | 'amber' | 'rose' | 'slate';

export interface TaskProject {
  id: string;
  name: string;
  color: TaskProjectColor;
  archived: boolean;
  privateOrder: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CreateProjectInput {
  name: string;
  color?: TaskProjectColor;
}

export interface UpdateProjectInput {
  name?: string;
  color?: TaskProjectColor;
  archived?: boolean;
  privateOrder?: number;
}

export interface DeleteProjectResult {
  projectId: string;
  clearedTaskIds: TaskId[];
}

/** A private Todo Agent list. Unlike a Feishu tasklist binding, this is a
 * local grouping that can be used without changing provider-owned fields. */
export type TaskListColor = TaskProjectColor;

export interface TaskList {
  id: string;
  name: string;
  color: TaskListColor;
  archived: boolean;
  privateOrder: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CreateListInput {
  name: string;
  color?: TaskListColor;
}

export interface UpdateListInput {
  name?: string;
  color?: TaskListColor;
  archived?: boolean;
  privateOrder?: number;
}

export interface DeleteListResult {
  listId: string;
  clearedTaskIds: TaskId[];
}

export type TaskStatus = 'open' | 'completed' | 'cancelled';
export type TaskPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export type TaskSourceType = 'local' | 'feishu';

/**
 * A deliberate, provider-owned Task v2 tasklist association.  This is kept
 * separately from the product's generic `listId`/`sectionId`: free-form
 * local list names must never be mistaken for a Feishu GUID and uploaded.
 *
 * An empty object is meaningful. It records that a known Feishu association
 * was explicitly cleared, while an omitted value means this task has no
 * provider-managed tasklist binding.
 */
export interface FeishuTasklistBinding {
  tasklistGuid?: string;
  sectionGuid?: string;
}

export interface TaskSource {
  type: TaskSourceType;
  accountId?: string;
  tenantId?: string;
  /**
   * Opaque local binding to one authorized provider identity. It prevents an
   * editable account label from moving a task into another user's sync queue.
   */
  syncIdentityId?: string;
  externalId?: string;
  remoteVersion?: string;
  /** Present only after an explicit Task v2 tasklist mapping is known. */
  tasklist?: FeishuTasklistBinding;
}

export type TaskSyncStatus =
  | 'local'
  | 'synced'
  | 'pending'
  | 'syncing'
  | 'offline'
  | 'failed'
  | 'conflict'
  | 'read-only'
  | 'permission-denied'
  | 'remote-deleted';

export interface TaskSyncMetadata {
  status: TaskSyncStatus;
  lastSyncedAt?: IsoDateTime;
  error?: string;
  conflictFields?: string[];
  tombstone?: {
    deletedAt: IsoDateTime;
    confirmedAt?: IsoDateTime;
  };
}

export interface TaskReminder {
  id: string;
  at: IsoDateTime;
  enabled: boolean;
  source: 'local' | 'feishu';
  label?: string;
}

export interface TaskTimeBlock {
  startAt: IsoDateTime;
  endAt: IsoDateTime;
}

export interface TaskFocusSession {
  id: string;
  startedAt: IsoDateTime;
  endedAt: IsoDateTime;
  elapsedSeconds: number;
  /**
   * Older focus sessions omit this field. Manual work-log entries mark it so
   * the inspector can distinguish a typed log from a Pomodoro session while
   * keeping both entries in the same local timeline.
   */
  source?: 'focus' | 'manual';
}

export interface RecordWorkLogInput {
  /** Whole minutes for one manually recorded work segment. */
  minutes: number;
  /** Defaults to the current time; useful for correcting a past entry. */
  endedAt?: IsoDateTime;
}

export interface TaskAttachment {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  localPath?: string;
  url?: string;
}

/** A deliberately bounded, renderer-safe local attachment preview. Paths and
 * file handles never cross the IPC boundary. */
export type TaskAttachmentPreview =
  | {
      kind: "text";
      name: string;
      mimeType: string;
      content: string;
      bytes: number;
    }
  | {
      kind: "image";
      name: string;
      mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      dataUrl: string;
      bytes: number;
    }
  | {
      kind: "unsupported";
      name: string;
      mimeType?: string;
      reason: "binary" | "too-large" | "unsupported";
      bytes?: number;
    };

export interface TaskLink {
  id: string;
  url: string;
  label?: string;
}

/** A private discussion entry attached to one task. Comments are intentionally
 * local-only: they provide a lightweight journal for the user and Agent
 * without pretending to be a Feishu comment or changing provider data. */
export type TaskCommentAuthor = "user" | "agent";

export interface TaskComment {
  id: string;
  body: string;
  author: TaskCommentAuthor;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/**
 * A compact, local-only research capture attached to a task.  It is designed
 * for Agent research and human notes without pretending to be a Feishu field:
 * the source URL, summary and action items stay in Todo Agent's private
 * context and are never sent through the Feishu adapter.
 */
export interface TaskResearchCard {
  id: string;
  title: string;
  url?: string;
  summary: string;
  actionItems: string[];
  capturedAt: IsoDateTime;
}

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number;
  /** Sunday is 0 and Saturday is 6. Only used by weekly rules. */
  weekdays?: number[];
  /** 1-31. Values beyond a month's final day are clamped. */
  dayOfMonth?: number;
  endsAt?: LocalDate | IsoDateTime;
  maxOccurrences?: number;
}

export type RecurrenceEditScope = 'this' | 'future' | 'series';

export type FeishuCompletionMode = 'single' | 'any-assignee' | 'all-assignees';
export type TaskMemberRole = 'assignee' | 'follower' | 'viewer';

export interface Task {
  id: TaskId;
  source: TaskSource;
  title: string;
  notes: string;
  privateNotes: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** A private, independent attention marker inspired by Flagged views. */
  flagged?: boolean;
  /**
   * A private availability date. Tasks deferred into the future stay out of
   * Today until this date and are never written back to Feishu.
   */
  deferUntil?: LocalDate;
  projectId?: string;
  listId?: string;
  sectionId?: string;
  tags: string[];
  /** User-defined, local-only contexts such as office, home or errands. */
  contexts?: string[];
  parentId?: TaskId;
  dependencyIds: TaskId[];
  assigneeIds: string[];
  followerIds: string[];
  attachments: TaskAttachment[];
  links: TaskLink[];
  customFields: Record<string, JsonValue>;
  /** Optional for compatibility with tasks written before local comments
   * existed. TaskService normalizes missing values to an empty array. */
  comments?: TaskComment[];
  /** Optional for compatibility with tasks written before research cards. */
  researchCards?: TaskResearchCard[];
  plannedDate?: LocalDate;
  startAt?: IsoDateTime;
  /**
   * Preserves Feishu Task v2's `start.is_all_day` semantics. The flag is
   * meaningful only while `startAt` is present; timed tasks omit it.
   */
  startAtIsAllDay?: boolean;
  dueAt?: IsoDateTime;
  /**
   * Preserves Feishu Task v2's `due.is_all_day` semantics. The flag is
   * meaningful only while `dueAt` is present; timed tasks omit it.
   */
  dueAtIsAllDay?: boolean;
  timeBlock?: TaskTimeBlock;
  reminders: TaskReminder[];
  completedAt?: IsoDateTime;
  recurrence?: RecurrenceRule;
  recurrenceSeriesId?: string;
  recurrenceIndex?: number;
  estimatedMinutes?: number;
  actualMinutes?: number;
  focusStartedAt?: IsoDateTime;
  focusElapsedSeconds: number;
  /** Optional for compatibility with state written before focus history existed. */
  focusSessions?: TaskFocusSession[];
  privateOrder: number;
  completionMode?: FeishuCompletionMode;
  currentUserRole?: TaskMemberRole;
  currentUserCompleted?: boolean;
  sync: TaskSyncMetadata;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt?: IsoDateTime;
}

export interface CreateTaskInput {
  title: string;
  source?: TaskSource;
  notes?: string;
  privateNotes?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  flagged?: boolean;
  deferUntil?: LocalDate;
  projectId?: string;
  listId?: string;
  sectionId?: string;
  tags?: string[];
  contexts?: string[];
  parentId?: TaskId;
  dependencyIds?: TaskId[];
  assigneeIds?: string[];
  followerIds?: string[];
  attachments?: TaskAttachment[];
  links?: TaskLink[];
  customFields?: Record<string, JsonValue>;
  comments?: TaskComment[];
  researchCards?: TaskResearchCard[];
  plannedDate?: LocalDate;
  startAt?: IsoDateTime;
  startAtIsAllDay?: boolean;
  dueAt?: IsoDateTime;
  dueAtIsAllDay?: boolean;
  timeBlock?: TaskTimeBlock;
  reminders?: TaskReminder[];
  completedAt?: IsoDateTime;
  recurrence?: RecurrenceRule;
  recurrenceSeriesId?: string;
  recurrenceIndex?: number;
  estimatedMinutes?: number;
  actualMinutes?: number;
  focusStartedAt?: IsoDateTime;
  focusElapsedSeconds?: number;
  focusSessions?: TaskFocusSession[];
  privateOrder?: number;
  completionMode?: FeishuCompletionMode;
  currentUserRole?: TaskMemberRole;
  currentUserCompleted?: boolean;
  sync?: TaskSyncMetadata;
}

type MutableTaskFields = Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

/** Passing null clears an optional field or resets an array/object field. */
export type UpdateTaskInput = {
  [Key in keyof MutableTaskFields]?: MutableTaskFields[Key] | null;
};

export type TaskView =
  | 'inbox'
  | 'today'
  | 'upcoming'
  | 'deferred'
  | 'all'
  | 'completed'
  | 'trash';

export type TaskSortField =
  | 'title'
  | 'priority'
  | 'deferUntil'
  | 'plannedDate'
  | 'startAt'
  | 'dueAt'
  | 'privateOrder'
  | 'createdAt'
  | 'updatedAt';

export interface TaskSort {
  field: TaskSortField;
  direction?: 'asc' | 'desc';
}

export interface TaskFilter {
  view?: TaskView;
  text?: string;
  sourceTypes?: TaskSourceType[];
  accountIds?: string[];
  projectIds?: string[];
  listIds?: string[];
  /** Keep only tasks with one of these local section headings. */
  sectionIds?: string[];
  tags?: string[];
  tagMode?: 'any' | 'all';
  contexts?: string[];
  contextMode?: 'any' | 'all';
  priorities?: TaskPriority[];
  /** Keep only tasks explicitly marked for attention. */
  flagged?: boolean;
  statuses?: TaskStatus[];
  plannedFrom?: LocalDate;
  plannedTo?: LocalDate;
  dueFrom?: IsoDateTime;
  dueTo?: IsoDateTime;
  includeDeleted?: boolean;
  sort?: TaskSort[];
  now?: IsoDateTime;
}

export type TaskViewSectionId =
  | 'overdue'
  | 'due-today'
  | 'planned-today'
  | 'upcoming'
  | 'deferred'
  | 'inbox'
  | 'open'
  | 'completed'
  | 'trash';

export interface TaskViewSection {
  id: TaskViewSectionId;
  tasks: Task[];
}

export interface TodayPlanItem {
  id: TaskId;
  /**
   * A private effort estimate used by Todo Agent's daily plan. This never
   * changes a provider-owned due date or other shared Feishu field.
   */
  estimatedMinutes?: number;
}

export interface TodayPlanBaseline {
  id: TaskId;
  plannedDate?: LocalDate;
  privateOrder: number;
  estimatedMinutes?: number;
}

export interface ApplyTodayPlanRequest {
  /** Defaults to, and when supplied must still equal, the service's local today. */
  date?: LocalDate;
  /** Selected Today tasks in the exact order the user approved. */
  items: TodayPlanItem[];
  /** Tasks the user explicitly removed from a previous private Today plan. */
  clearTaskIds: TaskId[];
  /** Private planning fields as shown when the user reviewed this plan. */
  baselines: TodayPlanBaseline[];
}

export interface TaskDraft {
  id: string;
  kind: 'quick-capture' | 'task-editor' | 'agent';
  text: string;
  taskId?: TaskId;
  data?: JsonValue;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface SaveDraftInput {
  id?: string;
  kind: TaskDraft['kind'];
  text: string;
  taskId?: TaskId;
  data?: JsonValue;
}

export type TaskOperationKind =
  | 'create'
  | 'update'
  | 'complete'
  | 'reopen'
  | 'bulk'
  | 'move-to-today'
  | 'focus'
  | 'work-log'
  | 'skip-recurring'
  | 'reorder-today'
  | 'plan-today'
  | 'trash'
  | 'restore'
  | 'purge';

export interface TaskSnapshotChange {
  taskId: TaskId;
  before: Task | null;
  after: Task | null;
}

export interface TaskOperation {
  id: string;
  kind: TaskOperationKind;
  createdAt: IsoDateTime;
  changes: TaskSnapshotChange[];
  undoneAt?: IsoDateTime;
  /** Monotonic local transaction order used when multiple undos share a timestamp. */
  undoneSequence?: number;
  /** Set when a new task mutation makes this undone operation non-redoable. */
  redoInvalidatedAt?: IsoDateTime;
}

/** A renderer-safe pointer to the latest undoable task operation. */
export type TaskOperationSummary = Pick<
  TaskOperation,
  "id" | "kind" | "createdAt"
>;

/** A renderer-safe, task-scoped view of the local mutation log.  History
 * intentionally exposes changed field names rather than before/after task
 * snapshots, so private notes, provider metadata and attachment paths never
 * need to cross the IPC boundary just to render an audit timeline. */
export interface TaskHistoryEntry {
  taskId: TaskId;
  operationId: string;
  kind: TaskOperationKind;
  createdAt: IsoDateTime;
  undoneAt?: IsoDateTime;
  changedFields: string[];
}

export interface LocalAppState {
  schemaVersion: 1;
  revision: number;
  tasks: Record<TaskId, Task>;
  projects: Record<string, TaskProject>;
  lists: Record<string, TaskList>;
  drafts: Record<string, TaskDraft>;
  operations: TaskOperation[];
}

export interface TaskMutationResult {
  task: Task;
  operationId: string;
  generatedTask?: Task;
}

export type BulkTaskTagEditMode = "replace" | "add" | "remove";

/** Private task attributes that can be edited in one reviewed batch. */
export interface BulkTaskEditPatch {
  priority?: TaskPriority;
  flagged?: boolean;
  projectId?: string | null;
  listId?: string | null;
  tags?: {
    mode: BulkTaskTagEditMode;
    values: string[];
  };
}

/** A reviewed, atomic action over a set of already identified tasks.  The
 * renderer must show the target list before sending this request; the main
 * process re-checks every target in one transaction so a half-applied batch
 * cannot be mistaken for success. */
export type BulkTaskAction =
  | { kind: "complete"; completedAt?: IsoDateTime }
  | { kind: "reopen" }
  | { kind: "move-to-today"; date?: LocalDate }
  | { kind: "trash" }
  | { kind: "restore" }
  | { kind: "edit"; patch: BulkTaskEditPatch };

export interface BulkTaskBaseline {
  id: TaskId;
  updatedAt: IsoDateTime;
}

export interface BulkTaskRequest {
  ids: TaskId[];
  action: BulkTaskAction;
  /** Optional for trusted callers; the desktop UI always sends it to detect
   * a background sync or edit between preview and confirmation. */
  baselines?: BulkTaskBaseline[];
}

export interface UndoResult {
  operationId: string;
  restoredTasks: Task[];
  removedTaskIds: TaskId[];
}

export interface RedoResult {
  operationId: string;
  restoredTasks: Task[];
  removedTaskIds: TaskId[];
}

export const createEmptyLocalAppState = (): LocalAppState => ({
  schemaVersion: 1,
  revision: 0,
  tasks: {},
  projects: {},
  lists: {},
  drafts: {},
  operations: [],
});
