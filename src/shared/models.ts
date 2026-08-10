export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type IsoDateTime = string;
export type LocalDate = string;
export type TaskId = string;

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
}

export interface TaskAttachment {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  localPath?: string;
  url?: string;
}

export interface TaskLink {
  id: string;
  url: string;
  label?: string;
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
  projectId?: string;
  listId?: string;
  sectionId?: string;
  tags: string[];
  parentId?: TaskId;
  dependencyIds: TaskId[];
  assigneeIds: string[];
  followerIds: string[];
  attachments: TaskAttachment[];
  links: TaskLink[];
  customFields: Record<string, JsonValue>;
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
  projectId?: string;
  listId?: string;
  sectionId?: string;
  tags?: string[];
  parentId?: TaskId;
  dependencyIds?: TaskId[];
  assigneeIds?: string[];
  followerIds?: string[];
  attachments?: TaskAttachment[];
  links?: TaskLink[];
  customFields?: Record<string, JsonValue>;
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

export type TaskView = 'inbox' | 'today' | 'upcoming' | 'all' | 'completed' | 'trash';

export type TaskSortField =
  | 'title'
  | 'priority'
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
  tags?: string[];
  tagMode?: 'any' | 'all';
  priorities?: TaskPriority[];
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
  | 'inbox'
  | 'open'
  | 'completed'
  | 'trash';

export interface TaskViewSection {
  id: TaskViewSectionId;
  tasks: Task[];
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
  | 'move-to-today'
  | 'focus'
  | 'reorder-today'
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
}

export interface LocalAppState {
  schemaVersion: 1;
  revision: number;
  tasks: Record<TaskId, Task>;
  drafts: Record<string, TaskDraft>;
  operations: TaskOperation[];
}

export interface TaskMutationResult {
  task: Task;
  operationId: string;
  generatedTask?: Task;
}

export interface UndoResult {
  operationId: string;
  restoredTasks: Task[];
  removedTaskIds: TaskId[];
}

export const createEmptyLocalAppState = (): LocalAppState => ({
  schemaVersion: 1,
  revision: 0,
  tasks: {},
  drafts: {},
  operations: [],
});
