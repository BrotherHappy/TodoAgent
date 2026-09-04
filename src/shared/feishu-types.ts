import type { FeishuTasklistBinding, Task } from "./models";

export const FEISHU_OPEN_API_BASE_URL = "https://open.feishu.cn/open-apis";
export const FEISHU_AUTHORIZE_URL =
  "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
export const FEISHU_TOKEN_URL =
  "https://open.feishu.cn/open-apis/authen/v2/oauth/token";

/**
 * Relay is the appropriate production mode for a shared application secret.
 * User-owned direct modes instead load a per-user secret from OS-backed secure
 * storage, so no shared secret is shipped in the desktop or mobile binary. The
 * relay contract deliberately mirrors Feishu's paths below `/feishu`.
 */
export interface FeishuRelayAuthConfig {
  mode: "relay";
  relayBaseUrl: string;
  redirectUri: string;
  /** Optional when the relay injects the Feishu app id itself. */
  clientId?: string;
}

/**
 * Low-level direct-secret OAuth config. Callers must opt in explicitly and
 * must never populate it from a shared secret embedded in a distributable
 * binary. Desktop direct modes may construct it transiently from a user-owned
 * credential loaded from OS-backed secure storage.
 */
export interface FeishuLocalDevelopmentAuthConfig {
  mode: "local-development";
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  acknowledgeInsecureLocalCredentials: true;
}

export type FeishuAuthConfig =
  | FeishuRelayAuthConfig
  | FeishuLocalDevelopmentAuthConfig;

export interface FeishuOAuthSession {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

export interface FeishuOAuthCallback {
  code: string;
  state: string;
}

export interface FeishuTokenSet {
  accessToken: string;
  refreshToken?: string;
  /** The authorized user's Feishu open_id, when returned by OAuth. */
  openId?: string;
  /** Tenant identity returned by OAuth on surfaces that expose it. */
  tenantKey?: string;
  /**
   * Opaque, non-secret digest of the OAuth app/relay configuration. Added by
   * the desktop identity binder so a token cannot be restored under another
   * client id.
   */
  appIdentityId?: string;
  tokenType: string;
  scope: string[];
  /** Absolute Unix time in milliseconds. */
  expiresAt: number;
  /** Absolute Unix time in milliseconds. */
  refreshTokenExpiresAt?: number;
}

/**
 * Implementations should store tokens in the operating system credential vault.
 * compareAndSwap is required because Feishu refresh tokens rotate and are
 * single-use: only the refresh request that still owns `expectedRefreshToken`
 * may commit its replacement token pair.
 */
export interface FeishuTokenStore {
  read(): Promise<FeishuTokenSet | undefined>;
  compareAndSwap(
    expectedRefreshToken: string | undefined,
    next: FeishuTokenSet,
  ): Promise<boolean>;
  clear?(): Promise<void>;
}

export type FeishuFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface FeishuApiEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

export interface FeishuTaskTimestamp {
  /** Feishu Task v2 represents Unix time as a millisecond string. */
  timestamp: string;
  is_all_day: boolean;
}

export type FeishuTaskMemberRole = "assignee" | "follower";

export interface FeishuTaskMember {
  id: string;
  /** Task v2 can return `app` members; locally editable ids represent users. */
  type?: "user" | "app";
  role: FeishuTaskMemberRole;
  name?: string;
}

export interface FeishuTaskAssigneeState {
  id: string;
  /** Present when this assignee has completed their part of a co-sign task. */
  completed_at?: string;
}

/** A Task v2 tasklist/section membership returned by tasklist APIs. */
export interface FeishuTasklistMembership {
  tasklist_guid: string;
  section_guid?: string;
}

export interface FeishuTaskV2 {
  guid: string;
  task_id?: string;
  summary: string;
  description?: string;
  start?: FeishuTaskTimestamp;
  due?: FeishuTaskTimestamp;
  completed_at?: string;
  created_at?: string;
  updated_at?: string;
  status?: string;
  /** 1 = all assignees co-sign; 2 = any assignee can complete the task. */
  mode?: 1 | 2;
  members?: FeishuTaskMember[];
  assignee_related?: FeishuTaskAssigneeState[];
  creator?: FeishuTaskMember;
  /**
   * Returned by tasklist actions on current Task v2 surfaces. The sync layer
   * may also enrich a normal task response using listTasklists(). Undefined
   * means the collection is unknown, never an inferred empty collection.
   */
  tasklists?: FeishuTasklistMembership[];
  extra?: string;
}

export interface FeishuTaskListPage {
  items: FeishuTaskV2[];
  page_token?: string;
  has_more: boolean;
}

/** A Task v2 list that the authorized identity can read. */
export interface FeishuAccessibleTasklist {
  guid: string;
  name?: string;
}

export interface FeishuAccessibleTasklistPage {
  items: FeishuAccessibleTasklist[];
  page_token?: string;
  has_more: boolean;
}

export interface FeishuCreateTaskPayload {
  summary: string;
  description?: string;
  start?: FeishuTaskTimestamp;
  due?: FeishuTaskTimestamp;
  members?: FeishuTaskMember[];
}

export interface FeishuPatchTaskFields {
  summary?: string;
  description?: string;
  start?: FeishuTaskTimestamp;
  due?: FeishuTaskTimestamp;
}

export interface FeishuPatchTaskPayload {
  task: FeishuPatchTaskFields;
  update_fields: string[];
}

export interface FeishuListTasksOptions {
  completed?: boolean;
  pageSize?: number;
}

export interface FeishuTaskApi {
  listAllTasks(options?: FeishuListTasksOptions): Promise<FeishuTaskV2[]>;
  /**
   * Enumerates tasks visible through every readable tasklist. Implementations
   * may omit this capability when the account has only the basic task scope;
   * the sync layer will then keep the safe `my_tasks` fallback.
   */
  listAllAccessibleTasks?(): Promise<FeishuTaskV2[]>;
  getTask(taskGuid: string): Promise<FeishuTaskV2>;
  createTask(
    task: FeishuCreateTaskPayload,
    clientToken: string,
  ): Promise<FeishuTaskV2>;
  updateTask(
    taskGuid: string,
    patch: FeishuPatchTaskPayload,
  ): Promise<FeishuTaskV2>;
  /**
   * Task v2 deliberately exposes membership as additive/removal actions,
   * rather than a PATCH-able task property. Keeping that boundary in the API
   * makes a partial local member list unable to replace unrelated members.
   */
  addTaskMembers(
    taskGuid: string,
    members: FeishuTaskMember[],
  ): Promise<FeishuTaskV2>;
  removeTaskMembers(
    taskGuid: string,
    members: FeishuTaskMember[],
  ): Promise<FeishuTaskV2>;
  /** Lists every accessible Task v2 tasklist containing this task. */
  listTasklists?(taskGuid: string): Promise<FeishuTasklistMembership[]>;
  /** Adds the task to an explicit tasklist (and optional section). */
  addTaskToTasklist?(
    taskGuid: string,
    tasklist: FeishuTasklistMembership,
  ): Promise<FeishuTaskV2>;
  /** Removes the task from one explicit tasklist. */
  removeTaskFromTasklist?(
    taskGuid: string,
    tasklistGuid: string,
  ): Promise<FeishuTaskV2>;
  deleteTask(taskGuid: string): Promise<void>;
  completeTask(taskGuid: string): Promise<FeishuTaskV2>;
  reopenTask(taskGuid: string): Promise<FeishuTaskV2>;
}

export type FeishuSyncedTaskField =
  | "title"
  | "notes"
  | "startAt"
  | "dueAt"
  | "status"
  /** Feishu Task v2 members with the `assignee` role. */
  | "assigneeIds"
  /** Feishu Task v2 members with the `follower` role. */
  | "followerIds"
  /**
   * An atomic tasklist + section pair. It deliberately does not reuse the
   * product's free-form listId/sectionId fields.
   */
  | "tasklist";

/** A merge value is a scalar, canonical member-id set, or explicit tasklist. */
export type FeishuSyncFieldValue =
  | string
  | string[]
  | FeishuTasklistBinding
  | undefined;

/** Only fields that have an explicit Task v2 mapping belong in this snapshot. */
export interface FeishuTaskSyncSnapshot {
  title: string;
  notes: string;
  startAt?: string;
  /** Mirrors Task v2 `start.is_all_day`; omitted for timed/unset starts. */
  startAtIsAllDay?: boolean;
  dueAt?: string;
  /** Mirrors Task v2 `due.is_all_day`; omitted for timed/unset due dates. */
  dueAtIsAllDay?: boolean;
  status: "open" | "completed";
  /**
   * Omitted only for a state file written before membership sync existed. New
   * snapshots always use canonical, sorted arrays. Keeping these optional lets
   * the state-store migrate old mappings without inventing a membership base.
   */
  assigneeIds?: string[];
  followerIds?: string[];
  /**
   * Empty means a known remote clear. Undefined means no unambiguous
   * tasklist collection was available, so it must not clear local state.
   */
  tasklist?: FeishuTasklistBinding;
}

export interface FeishuFieldConflict {
  field: FeishuSyncedTaskField;
  base: FeishuSyncFieldValue;
  local: FeishuSyncFieldValue;
  remote: FeishuSyncFieldValue;
  /** Present for a start/due conflict when the corresponding value is all-day. */
  baseIsAllDay?: boolean;
  localIsAllDay?: boolean;
  remoteIsAllDay?: boolean;
}

export interface FeishuThreeWayMergeResult {
  merged: FeishuTaskSyncSnapshot;
  /** Fields to send to Feishu. */
  localChanges: FeishuSyncedTaskField[];
  /** Fields to apply to the local task. */
  remoteChanges: FeishuSyncedTaskField[];
  conflicts: FeishuFieldConflict[];
}

export type FeishuSyncOperationKind = "create" | "update" | "delete";

export interface FeishuSyncQueueItem {
  id: string;
  taskId: string;
  kind: FeishuSyncOperationKind;
  /** Stable across retries; required for idempotent Task v2 creates. */
  clientToken?: string;
  enqueuedAt: string;
  attempts: number;
  lastError?: string;
}

/** A file/database-backed implementation is injected by the Electron layer. */
export interface FeishuSyncQueueStore {
  load(): Promise<FeishuSyncQueueItem[]>;
  save(items: readonly FeishuSyncQueueItem[]): Promise<void>;
}

/** Local task and merge-base persistence are also injected for testability. */
export interface FeishuSyncTaskStore {
  get(taskId: string): Promise<Task | undefined>;
  save(task: Task): Promise<void>;
  getBase(taskId: string): Promise<FeishuTaskSyncSnapshot | undefined>;
  saveBase(taskId: string, snapshot: FeishuTaskSyncSnapshot): Promise<void>;
}

export type FeishuSyncResult =
  | { status: "synced"; task: Task }
  | { status: "conflict"; task: Task; conflicts: FeishuFieldConflict[] }
  | { status: "deleted"; task: Task };
