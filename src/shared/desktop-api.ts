import type {
  CreateTaskInput,
  RecurrenceEditScope,
  SaveDraftInput,
  Task,
  TaskDraft,
  TaskFilter,
  TaskId,
  TaskMutationResult,
  TaskOperation,
  TaskSyncStatus,
  TaskViewSection,
  UndoResult,
  UpdateTaskInput,
} from "./models";
import type {
  FeishuSyncedTaskField,
  FeishuSyncFieldValue,
} from "./feishu-types";
import type { QuickCaptureResult } from "./quick-capture";
import type { ReminderActionEvent, ReminderDelivery } from "./reminders";
import type {
  AgentRunEvent,
  AgentRunState,
  ApprovalChoice,
  AuditRecord,
  EffectPlan,
  FullAccessLease,
  FullAccessToolScope,
} from "./agent-types";
import type { AppSettings, PublicCredentialState } from "./settings";

export interface UpdateTaskRequest {
  id: TaskId;
  patch: UpdateTaskInput;
  recurrenceScope?: RecurrenceEditScope;
}

export interface CompleteTaskRequest {
  id: TaskId;
  completedAt?: string;
}

export interface MoveToTodayRequest {
  id: TaskId;
  date?: string;
}

export interface TaskDesktopApi {
  create(input: CreateTaskInput): Promise<TaskMutationResult>;
  get(id: TaskId, includeDeleted?: boolean): Promise<Task | undefined>;
  list(filter?: TaskFilter): Promise<Task[]>;
  sections(filter?: TaskFilter): Promise<TaskViewSection[]>;
  update(request: UpdateTaskRequest): Promise<TaskMutationResult>;
  complete(request: CompleteTaskRequest): Promise<TaskMutationResult>;
  reopen(id: TaskId): Promise<TaskMutationResult>;
  moveToToday(request: MoveToTodayRequest): Promise<TaskMutationResult>;
  startFocus(id: TaskId): Promise<TaskMutationResult>;
  pauseFocus(id: TaskId): Promise<TaskMutationResult>;
  resetFocus(id: TaskId): Promise<TaskMutationResult>;
  reorderToday(taskIds: TaskId[]): Promise<TaskOperation>;
  moveToTrash(id: TaskId): Promise<TaskMutationResult>;
  restore(id: TaskId): Promise<TaskMutationResult>;
  purge(id: TaskId): Promise<TaskOperation>;
  undo(operationId?: string): Promise<UndoResult>;
  saveDraft(input: SaveDraftInput): Promise<TaskDraft>;
  getDraft(id: string): Promise<TaskDraft | undefined>;
  listDrafts(): Promise<TaskDraft[]>;
  deleteDraft(id: string): Promise<boolean>;
}

export interface AppInfo {
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  isPackaged: boolean;
  secureStorageAvailable: boolean;
}

export interface SetCredentialRequest {
  kind: PublicCredentialState["kind"];
  value: string;
  id?: string;
}

export interface SettingsDesktopApi {
  get(): Promise<AppSettings>;
  replace(settings: AppSettings): Promise<AppSettings>;
  listCredentials(): Promise<PublicCredentialState[]>;
  setCredential(request: SetCredentialRequest): Promise<PublicCredentialState>;
  deleteCredential(id: string): Promise<boolean>;
}

export interface ShellDesktopApi {
  getInfo(): Promise<AppInfo>;
  showMain(route?: string): Promise<void>;
  showQuickCapture(): Promise<void>;
  hideCurrentWindow(): Promise<void>;
  setFloatingVisible(visible: boolean): Promise<AppSettings>;
  setFloatingExpanded(expanded: boolean): Promise<void>;
  setLaunchAtLogin(enabled: boolean): Promise<AppSettings>;
  openExternal(url: string): Promise<void>;
}

export interface CaptureDesktopApi {
  parse(text: string): Promise<QuickCaptureResult>;
}

export interface AgentChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentSendRequest {
  /** Optional caller-generated correlation ID for matching live events. */
  runId?: string;
  /**
   * Stable renderer-local chat session ID. It is not persisted and lets the
   * main process safely associate a one-turn source clarification with the
   * conversation that initiated it.
   */
  conversationId?: string;
  message: string;
  history?: AgentChatMessage[];
}

/**
 * A system-generated receipt for a Feishu mutation executed by Agent. It is
 * intentionally independent from model prose: only the local sync engine may
 * advance its status from pending to synced or failed.
 */
export type AgentFeishuSyncAction =
  | "created"
  | "updated"
  | "completed"
  | "reopened"
  | "deleted"
  | "restored";

export interface AgentFeishuSyncReceipt {
  taskId: TaskId;
  action: AgentFeishuSyncAction;
  status: TaskSyncStatus;
}

export interface AgentSendResult {
  runId: string;
  state: Extract<
    AgentRunState,
    "completed" | "failed" | "cancelled" | "partial" | "external-effect"
  >;
  assistantText: string;
  errorCode?: string;
  /**
   * Present only for trusted Feishu task mutations. Renderers can refresh the
   * referenced task after task-change notifications, so this receipt changes
   * when background sync succeeds or fails without trusting model text.
   */
  feishuSyncReceipts?: AgentFeishuSyncReceipt[];
}

export interface MorningBriefRequest {
  trigger: "automatic" | "manual";
}

export type MorningBriefResultCode =
  | "GENERATED"
  | "ALREADY_GENERATED_TODAY"
  | "MORNING_BRIEF_DISABLED"
  | "AI_DISABLED"
  | "AI_NOT_CONFIGURED"
  | "MODEL_DATA_SCOPE_DISABLED"
  | "NO_TASKS"
  | "MODEL_REQUEST_FAILED";

export interface MorningBriefResult {
  source: "ai" | "local-fallback";
  code: MorningBriefResultCode;
  localDate: string;
  summary?: string;
  generatedAt?: string;
}

export interface AgentApprovalView {
  approvalId: string;
  runId: string;
  toolName: string;
  effects: EffectPlan;
  expiresAt: string;
}

export interface AgentStatus {
  enabled: boolean;
  configured: boolean;
  activeRunIds: string[];
  pendingApprovals: AgentApprovalView[];
  fullAccessLease?: FullAccessLease;
}

export interface ModelUsageStatus {
  /** Calendar day in the device's current local timezone (YYYY-MM-DD). */
  localDate: string;
  timezone: string;
  /** Sum of provider-reported usage.total_tokens for this local day. */
  usedTokens: number;
  /** null means the local token limit is disabled. */
  dailyTokenLimit: number | null;
  remainingTokens: number | null;
  blocked: boolean;
  blockedReason?:
    | "daily-token-limit-reached"
    | "provider-usage-unavailable"
    | "usage-state-unavailable";
  reportedRequestCount: number;
  unreportedRequestCount: number;
  lastUpdatedAt?: string;
  accounting: "none" | "provider-reported" | "partial" | "unavailable";
  /** A completed request can cross the boundary; subsequent runs are blocked. */
  enforcement: "block-new-runs-at-or-over-limit";
  cost: {
    configuredDailyLimitUsd: number | null;
    mode: "not-enforced";
    reason: "MODEL_PRICING_NOT_CONFIGURED";
  };
}

export interface ModelConnectionTestResult {
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  code: string;
  message: string;
  retryable: boolean;
  endpointOrigin?: string;
  model?: string;
  /** Exact usage reported by the provider for the test request, if present. */
  reportedTotalTokens?: number;
  usage: ModelUsageStatus;
}

export interface AgentApprovalResponse {
  approvalId: string;
  choice: ApprovalChoice;
}

export interface FullAccessLeaseRequest {
  durationMinutes: number;
  scopes: FullAccessToolScope[];
}

export interface AgentDesktopApi {
  status(): Promise<AgentStatus>;
  modelUsage(): Promise<ModelUsageStatus>;
  testModelConnection(): Promise<ModelConnectionTestResult>;
  send(request: AgentSendRequest): Promise<AgentSendResult>;
  morningBrief(request: MorningBriefRequest): Promise<MorningBriefResult>;
  respondToApproval(response: AgentApprovalResponse): Promise<boolean>;
  stop(runId?: string): Promise<number>;
  audit(limit?: number): Promise<AuditRecord[]>;
  createFullAccessLease(
    request: FullAccessLeaseRequest,
  ): Promise<FullAccessLease>;
  revokeFullAccess(): Promise<void>;
}

export type FeishuConnectionState =
  | "unconfigured"
  | "disconnected"
  | "authorizing"
  | "connected"
  | "syncing"
  | "error";

export interface FeishuErrorView {
  code: string;
  message: string;
  retryable: boolean;
}

export interface FeishuStatusView {
  state: FeishuConnectionState;
  configured: boolean;
  connected: boolean;
  polling: boolean;
  accountId?: string;
  mode?:
    | "personal-direct"
    | "existing-direct"
    | "relay"
    | "local-development";
  authorizationStep?: "app-registration" | "account-authorization";
  oauthExpiresAt?: string;
  lastSyncAt?: string;
  lastError?: FeishuErrorView;
}

export type FeishuConfigureRequest =
  | {
      mode: "personal-direct";
      accountId: string;
      tokenCredentialId: string;
      clientId: string;
      appSecretCredentialId: string;
    }
  | {
      mode: "existing-direct";
      accountId: string;
      tokenCredentialId: string;
      clientId: string;
      appSecretCredentialId: string;
    }
  | {
      mode: "relay";
      accountId: string;
      tokenCredentialId: string;
      relayBaseUrl: string;
      clientId?: string;
    }
  | {
      mode: "local-development";
      accountId: string;
      tokenCredentialId: string;
      clientId: string;
      appSecretCredentialId: string;
      acknowledgeInsecureLocalCredentials: true;
    };

export interface FeishuOAuthStartView {
  authorizeUrl: string;
  expiresAt: string;
}

export interface FeishuConflictFieldView {
  field: FeishuSyncedTaskField;
  base?: FeishuSyncFieldValue;
  local?: FeishuSyncFieldValue;
  remote?: FeishuSyncFieldValue;
  /** Time-slot metadata for an all-day start/due conflict. */
  baseIsAllDay?: boolean;
  localIsAllDay?: boolean;
  remoteIsAllDay?: boolean;
}

export interface FeishuConflictView {
  localId: string;
  guid: string;
  fields: FeishuConflictFieldView[];
  detectedAt: string;
}

export interface FeishuSyncReportView {
  pushed: number;
  pulled: number;
  deleted: number;
  conflicts: FeishuConflictView[];
  offline: boolean;
  usedFullSync: boolean;
  cursor?: string;
  /** Sanitized run-level state; use this instead of treating every non-offline run as success. */
  issue?: {
    code:
      | "NETWORK_UNAVAILABLE"
      | "RATE_LIMITED"
      | "AUTH_REQUIRED"
      | "PERMISSION_DENIED"
      | "SYNC_FAILED";
    retryable: boolean;
  };
}

export type FeishuConflictDecisionView =
  | "keep-local"
  | "use-feishu"
  | "duplicate";

export interface FeishuConflictResolutionView {
  decision: FeishuConflictDecisionView;
  task: Task;
  duplicate?: Task;
}

export interface FeishuDesktopApi {
  status(): Promise<FeishuStatusView>;
  configure(request: FeishuConfigureRequest): Promise<FeishuStatusView>;
  beginPersonalConnect(): Promise<FeishuOAuthStartView>;
  beginOAuth(): Promise<FeishuOAuthStartView>;
  cancelOAuth(): Promise<FeishuStatusView>;
  disconnect(): Promise<FeishuStatusView>;
  syncNow(forceFull?: boolean): Promise<FeishuSyncReportView>;
  listConflicts(): Promise<FeishuConflictView[]>;
  resolveConflict(
    localId: string,
    decision: FeishuConflictDecisionView,
  ): Promise<FeishuConflictResolutionView>;
}

export type InAppNotificationView =
  | {
      type: "delivery";
      delivery: ReminderDelivery;
      reason:
        | "unsupported"
        | "permission-denied"
        | "permission-not-determined"
        | "banners-disabled"
        | "platform-error";
    }
  | { type: "cancel"; reminderId: string };

export interface NotificationDesktopApi {
  handleAction(event: ReminderActionEvent): Promise<void>;
  snoozeUntil(reminderId: string, snoozeUntil: string): Promise<void>;
  refresh(): Promise<void>;
}

export type DataRedactionView = "none" | "private" | "strict";
export type DataImportStrategyView = "skip" | "overwrite" | "copy";

export interface DataExportRequestView {
  redaction?: DataRedactionView;
  include?: Partial<{
    tasks: boolean;
    drafts: boolean;
    operations: boolean;
    settings: boolean;
    permissionAudit: boolean;
  }>;
}

export type DataExportResultView =
  | { status: "cancelled" }
  | { status: "exported"; filePath: string; bytes: number };

export interface DataCategoryPlanView {
  incoming: number;
  conflicts: string[];
  create: number;
  overwrite: number;
  skip: number;
  copy: number;
}

export interface DataImportPreviewView {
  digest: string;
  strategy: DataImportStrategyView;
  exportedAt: string;
  redaction: DataRedactionView;
  tasks: DataCategoryPlanView;
  drafts: DataCategoryPlanView;
  operations: DataCategoryPlanView;
  settings: {
    included: boolean;
    differs: boolean;
    action: "none" | "overwrite" | "skip";
  };
  permissionAudit: {
    incoming: number;
    existing: number;
    action: "none" | "replace" | "skip";
  };
  warnings: string[];
}

export type DataPreviewResultView =
  | { status: "cancelled" }
  | {
      status: "ready";
      previewToken: string;
      expiresAt: string;
      filePath: string;
      bytes: number;
      strategies: Record<DataImportStrategyView, DataImportPreviewView>;
    };

export interface DataImportResultView {
  digest: string;
  strategy: DataImportStrategyView;
  tasks: Omit<DataCategoryPlanView, "conflicts">;
  drafts: Omit<DataCategoryPlanView, "conflicts">;
  operations: Omit<DataCategoryPlanView, "conflicts">;
  settings: "none" | "overwritten" | "skipped";
  permissionAudit: "none" | "replaced" | "skipped";
  copiedTaskIds: Record<string, string>;
}

export interface DataDesktopApi {
  exportToFile(request?: DataExportRequestView): Promise<DataExportResultView>;
  previewImport(): Promise<DataPreviewResultView>;
  commitImport(
    previewToken: string,
    strategy: DataImportStrategyView,
  ): Promise<{ status: "imported"; result: DataImportResultView }>;
  cancelPreview(previewToken: string): Promise<boolean>;
  clearLocalData(request: {
    tasks: boolean;
    drafts: boolean;
    operations: boolean;
    resetSettings: boolean;
  }): Promise<{
    status: "cancelled" | "cleared";
    tasks: number;
    drafts: number;
    operations: number;
    settingsReset: boolean;
  }>;
}

export interface DesktopEventApi {
  onTasksChanged(listener: () => void): () => void;
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void;
  onNavigation(listener: (route: string) => void): () => void;
  onQuickCaptureFocus(listener: () => void): () => void;
  onShortcutError(listener: (shortcut: string) => void): () => void;
  onAgentEvent(listener: (event: AgentRunEvent) => void): () => void;
  onAgentApproval(listener: (approval: AgentApprovalView) => void): () => void;
  onFeishuStatus(listener: (status: FeishuStatusView) => void): () => void;
  onNotification(listener: (event: InAppNotificationView) => void): () => void;
}

export interface DesktopApi {
  tasks: TaskDesktopApi;
  settings: SettingsDesktopApi;
  shell: ShellDesktopApi;
  capture: CaptureDesktopApi;
  agent: AgentDesktopApi;
  feishu: FeishuDesktopApi;
  notifications: NotificationDesktopApi;
  data: DataDesktopApi;
  events: DesktopEventApi;
}

export const DESKTOP_CHANNELS = {
  taskCreate: "tasks:create",
  taskGet: "tasks:get",
  taskList: "tasks:list",
  taskSections: "tasks:sections",
  taskUpdate: "tasks:update",
  taskComplete: "tasks:complete",
  taskReopen: "tasks:reopen",
  taskMoveToToday: "tasks:move-to-today",
  taskStartFocus: "tasks:start-focus",
  taskPauseFocus: "tasks:pause-focus",
  taskResetFocus: "tasks:reset-focus",
  taskReorderToday: "tasks:reorder-today",
  taskTrash: "tasks:trash",
  taskRestore: "tasks:restore",
  taskPurge: "tasks:purge",
  taskUndo: "tasks:undo",
  draftSave: "drafts:save",
  draftGet: "drafts:get",
  draftList: "drafts:list",
  draftDelete: "drafts:delete",
  settingsGet: "settings:get",
  settingsReplace: "settings:replace",
  credentialList: "credentials:list",
  credentialSet: "credentials:set",
  credentialDelete: "credentials:delete",
  shellGetInfo: "shell:get-info",
  shellShowMain: "shell:show-main",
  shellShowQuick: "shell:show-quick",
  shellHideCurrent: "shell:hide-current",
  shellSetFloatingVisible: "shell:set-floating-visible",
  shellSetFloatingExpanded: "shell:set-floating-expanded",
  shellSetLaunchAtLogin: "shell:set-launch-at-login",
  shellOpenExternal: "shell:open-external",
  captureParse: "capture:parse",
  agentStatus: "agent:status",
  agentModelUsage: "agent:model-usage",
  agentModelConnectionTest: "agent:model-connection-test",
  agentSend: "agent:send",
  agentMorningBrief: "agent:morning-brief",
  agentApprovalRespond: "agent:approval-respond",
  agentStop: "agent:stop",
  agentAudit: "agent:audit",
  agentFullAccessCreate: "agent:full-access-create",
  agentFullAccessRevoke: "agent:full-access-revoke",
  feishuStatus: "feishu:status",
  feishuConfigure: "feishu:configure",
  feishuBeginPersonalConnect: "feishu:begin-personal-connect",
  feishuBeginOAuth: "feishu:begin-oauth",
  feishuCancelOAuth: "feishu:cancel-oauth",
  feishuDisconnect: "feishu:disconnect",
  feishuSyncNow: "feishu:sync-now",
  feishuConflicts: "feishu:conflicts",
  feishuResolveConflict: "feishu:resolve-conflict",
  notificationAction: "notifications:action",
  notificationSnoozeUntil: "notifications:snooze-until",
  notificationRefresh: "notifications:refresh",
  dataExport: "data:export",
  dataPreviewImport: "data:preview-import",
  dataCommitImport: "data:commit-import",
  dataCancelPreview: "data:cancel-preview",
  dataClearLocal: "data:clear-local",
  eventTasksChanged: "event:tasks-changed",
  eventSettingsChanged: "event:settings-changed",
  eventNavigation: "navigation:route",
  eventQuickCaptureFocus: "quick-capture:focus",
  eventShortcutError: "system:shortcut-error",
  eventAgentRun: "event:agent-run",
  eventAgentApproval: "event:agent-approval",
  eventFeishuStatus: "event:feishu-status",
  eventNotification: "event:notification",
} as const;

declare global {
  interface Window {
    desktopApi?: DesktopApi;
  }
}
