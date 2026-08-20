import {
  Activity,
  AlarmClock,
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowUp,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  Clipboard,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  Clock3,
  Cloud,
  CloudCheck,
  CloudOff,
  Command,
  Download,
  ExternalLink,
  EyeOff,
  Eye,
  FileText,
  Filter,
  Focus,
  FolderKanban,
  GitBranch,
  GripVertical,
  Heart,
  Inbox,
  Info,
  Laptop,
  LayoutList,
  ListChecks,
  LockKeyhole,
  Mic,
  MessageCircle,
  MoreHorizontal,
  PanelTop,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Tag,
  Trash2,
  Undo2,
  Upload,
  UserRound,
  WandSparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  JsonValue,
  BulkTaskAction,
  RecurrenceEditScope,
  Task,
  TaskAttachment,
  TaskAttachmentPreview,
  TaskComment,
  TaskHistoryEntry,
  TaskLink,
  TaskPriority,
  TaskProject,
  TaskList,
  TaskResearchCard,
  RecurrenceRule,
  TaskSourceType,
  TaskSyncStatus,
  TaskView,
  TaskViewSectionId,
} from "../shared/models";
import type { AuditRecord } from "../shared/agent-types";
import type { QuickCaptureResult } from "../shared/quick-capture";
import {
  buildDropContextPreview,
  type DropContextPreview,
} from "../shared/drop-context";
import type {
  ReminderDelivery,
  ReminderPresetAction,
} from "../shared/reminders";
import {
  defaultSettings,
  type AiAuthenticationMode,
  type AppSettings,
  type PetTab,
  type TaskUrgencyWeights,
} from "../shared/settings";
import type {
  AgentApprovalView,
  DataImportStrategyView,
  DataPreviewResultView,
  FeishuConfigureRequest,
  FeishuConflictDecisionView,
  FeishuConflictView,
  FeishuSyncReportView,
  FeishuStatusView,
  MorningBriefResult,
  ModelConnectionTestResult,
  ModelUsageStatus,
  SetCredentialRequest,
} from "../shared/desktop-api";
import type {
  FocusSessionView,
  PetAdventure,
  PetDiaryEntry,
  PetMemoryEntry,
  PetSnapshot,
  WeatherSnapshot,
} from "../shared/pet-types";
import { AgentMarkdown } from "./AgentMarkdown";
import {
  buildBulkTaskAgentPrompt,
  buildTaskAgentPrompt,
} from "./task-agent-context";
import {
  FocusEnvironmentSound,
  environmentSoundOptions,
} from "./focus-environment-sound";
import { DailyPlanSheet } from "./DailyPlanSheet";
import { InboxTriageSheet } from "./InboxTriageSheet";
import {
  CommandPalette,
  type CommandPaletteAction,
} from "./CommandPalette";
import { buildDependencyChain } from "./dependency-chain";
import { TimelinePage } from "./TimelinePage";
import {
  localDateTimeInputToIso,
  toLocalDateTimeInput,
} from "./local-datetime";
import { feishuCreationBlockedMessage } from "./feishu-create-guard";
import {
  PetCharacter,
  type PetMood,
  type PetOutfit,
  type PetPalette,
  type PetSeason,
} from "./PetCharacter";
import {
  PetInteractionWheel,
  type FloatingPetGame,
} from "./PetInteractionWheel";
import {
  petInteractionFromPoint,
  type PetAction,
  type PetInteractionKind,
} from "./pet-behavior";
import {
  emptyJumpRopeScore,
  jumpRopeFrame,
  scoreJumpRopeAttempt,
  type JumpRopeScore,
} from "./pet-jump-rope";
import {
  getPetTaskDropTarget,
  petTaskDropTargets,
  type PetTaskDropTargetId,
} from "./pet-task-drop-zones";
import {
  buildPetProactiveSuggestion,
  proactiveBudgetAvailable,
  shouldSuppressPetProactive,
  type PetNextTask,
} from "./pet-companion";
import { useTaskController, type TaskController } from "./task-controller";
import { useAgentChat } from "./use-agent-chat";
import { usePetBehavior } from "./use-pet-behavior";
import {
  parsePetActionPackJson,
  useInstalledPetActionPacks,
} from "./pet-action-packs";
import {
  buildTaskTemplateInputs,
  parseTaskTemplateJson,
  previewTaskTemplate,
  useTaskTemplates,
} from "./task-templates";
import { suggestDailyPlan } from "../shared/daily-planner";
import {
  inferTaskTheme,
  type TaskThemeActionPack,
} from "./task-theme-action-packs";
import { buildEveningReview } from "./evening-review";
import { useVoiceCapture } from "./voice-capture";
import {
  createSmartView,
  priorityReason,
  readSmartViews,
  smartViewSortLabels,
  sortSmartViewTasks,
  writeSmartViews,
  type SmartViewDateFilter,
  type SmartViewDefinition,
  type SmartViewSort,
} from "./smart-views";
import {
  parseSmartViewQuery,
  type SmartViewQueryResult,
} from "./smart-view-query";
import {
  buildSubtaskProgress,
  subtaskProgressLabel,
  type SubtaskProgress,
} from "./subtask-progress";
import {
  formatHabitWait,
  habitState,
  readElasticHabits,
  writeElasticHabits,
  type ElasticHabit,
} from "./elastic-habits";
import { weeklyReviewSummary } from "./timeline-utils";
import {
  checkinCopy,
  normalizeWeeklyCheckin,
  weekStartFor,
  weeklyCheckinPaceLabel,
  type WeeklyCheckinEnergy,
  type WeeklyCheckinPace,
  type WeeklyCheckinRecord,
} from "./weekly-checkin";
import { buildPetReviewSummary } from "./pet-review";
import { feishuSyncVisualState } from "./feishu-status";
import { ProjectPage } from "./ProjectPage";
import { ListPage } from "./ListPage";
import { petSeasonalEventForDate } from "./pet-season";
import {
  applyCompanionStrategy,
  companionStrategyLabels,
  detectCompanionStrategy,
  type CompanionStrategy,
} from "./companion-presets";

type MainRoute =
  | TaskView
  | "pet"
  | "agent"
  | "activity"
  | "timeline"
  | "projects"
  | "lists"
  | "sync"
  | "settings";
type ToastKind = "success" | "error" | "info";
type TaskEditorDirtyField =
  | "title"
  | "notes"
  | "projectId"
  | "listId"
  | "tags"
  | "contexts"
  | "plannedDate"
  | "startAt"
  | "startAtAllDay"
  | "dueAt"
  | "dueAtAllDay"
  | "localReminder";
type CustomFieldType = "text" | "number" | "date" | "url" | "checkbox";

const customFieldTypeLabels: Record<CustomFieldType, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  url: "链接",
  checkbox: "勾选",
};

const urgencyWeightLabels: Array<{
  key: keyof TaskUrgencyWeights;
  label: string;
  description: string;
}> = [
  { key: "deadline", label: "截止日期", description: "逾期、今天或临近截止的任务" },
  { key: "plannedToday", label: "今天计划", description: "已经放入 Today 的任务" },
  { key: "priority", label: "优先级", description: "任务自身的紧急 / 高 / 中 / 低优先级" },
  { key: "quickWin", label: "短任务", description: "预计时长较短、容易马上开始的任务" },
];

interface MainNavigationState {
  route: MainRoute;
  sourceFilter?: TaskSourceType;
  index: number;
}

interface ToastState {
  id: number;
  message: string;
  kind: ToastKind;
  action?: { label: string; run: () => void };
}

type ReadyDataPreview = Extract<DataPreviewResultView, { status: "ready" }>;
const floatingAgentDraftId = "floating-agent-prompt";
const floatingTabStorageKey = "todoAgentFloatingTab";
const floatingPetOnlyStorageKey = "todoAgentFloatingPetOnly";
const mainNavigationStateKey = "todoAgentMainNavigation";

function isPetTab(value: unknown): value is PetTab {
  return (
    value === "all" ||
    value === "today" ||
    value === "focus" ||
    value === "chat" ||
    value === "home"
  );
}

function readFloatingTab(): PetTab {
  try {
    const saved = localStorage.getItem(floatingTabStorageKey);
    // `activity` was the final tab in the legacy capsule. Migrate it to the
    // pet's home instead of discarding the user's remembered navigation.
    if (saved === "activity") return "home";
    return isPetTab(saved) ? saved : "all";
  } catch {
    // A disabled or unavailable storage area must never make the desktop
    // entry unusable. The first-run default remains the all-task overview.
    return "all";
  }
}

function readFloatingPetOnly(): boolean {
  try {
    return localStorage.getItem(floatingPetOnlyStorageKey) === "true";
  } catch {
    return false;
  }
}

const routeTitles: Record<MainRoute, string> = {
  inbox: "暂存",
  today: "今天",
  upcoming: "即将到来",
  all: "全部任务",
  completed: "已完成",
  trash: "回收站",
  pet: "小窝",
  agent: "Agent",
  activity: "动态",
  timeline: "时间线",
  projects: "项目",
  lists: "清单",
  sync: "同步问题",
  settings: "设置",
};

const taskRouteNames = new Set<MainRoute>([
  "inbox",
  "today",
  "upcoming",
  "all",
  "completed",
  "trash",
]);

function isTaskMainRoute(route: MainRoute): route is TaskView {
  return taskRouteNames.has(route);
}

function isMainRoute(value: unknown): value is MainRoute {
  return typeof value === "string" && value in routeTitles;
}

const projectLabel = (id: string | undefined, projects: readonly TaskProject[]): string => {
  if (!id) return "";
  return projects.find((project) => project.id === id)?.name ?? id;
};

const resolveProjectInput = (value: string, projects: readonly TaskProject[]): string => {
  const trimmed = value.trim();
  const match = projects.find(
    (project) => project.id === trimmed || project.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  return match?.id ?? trimmed;
};

const listLabel = (id: string | undefined, lists: readonly TaskList[]): string => {
  if (!id) return "";
  return lists.find((list) => list.id === id)?.name ?? id;
};

const resolveListInput = (value: string, lists: readonly TaskList[]): string => {
  const trimmed = value.trim();
  const match = lists.find(
    (list) => list.id === trimmed || list.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  return match?.id ?? trimmed;
};

function readMainNavigationState(value: unknown): MainNavigationState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[mainNavigationStateKey];
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  if (!isMainRoute(record.route) || !Number.isInteger(record.index)) {
    return undefined;
  }
  const sourceFilter = record.sourceFilter;
  if (
    sourceFilter !== undefined &&
    sourceFilter !== "local" &&
    sourceFilter !== "feishu"
  ) {
    return undefined;
  }
  return {
    route: record.route,
    sourceFilter,
    index: record.index as number,
  };
}

function withMainNavigationState(next: MainNavigationState): Record<string, unknown> {
  const existing =
    window.history.state && typeof window.history.state === "object"
      ? (window.history.state as Record<string, unknown>)
      : {};
  return { ...existing, [mainNavigationStateKey]: next };
}

const sectionTitles: Record<TaskViewSectionId, string> = {
  overdue: "逾期",
  "due-today": "今天到期",
  "planned-today": "今天计划",
  upcoming: "即将到来",
  inbox: "暂存",
  open: "待办",
  completed: "已完成",
  trash: "回收站",
};

const priorityLabels: Record<TaskPriority, string> = {
  none: "无",
  low: "低",
  medium: "中",
  high: "高",
  urgent: "紧急",
};

const taskHistoryOperationLabels: Record<TaskHistoryEntry["kind"], string> = {
  create: "创建任务",
  update: "更新任务",
  complete: "标记完成",
  reopen: "重新打开",
  bulk: "批量操作",
  "move-to-today": "移到今天",
  focus: "专注记录",
  "reorder-today": "调整今日顺序",
  "plan-today": "安排今日计划",
  trash: "移入回收站",
  restore: "恢复任务",
  purge: "永久删除",
};

const taskHistoryFieldLabels: Record<string, string> = {
  task: "任务记录",
  title: "标题",
  notes: "备注",
  privateNotes: "私人备注",
  status: "状态",
  completedAt: "完成时间",
  priority: "优先级",
  projectId: "项目",
  listId: "清单",
  sectionId: "分组",
  tags: "标签",
  contexts: "情境",
  parentId: "父任务",
  dependencyIds: "前置依赖",
  assigneeIds: "负责人",
  followerIds: "关注人",
  attachments: "附件",
  links: "链接",
  customFields: "自定义字段",
  plannedDate: "私人计划日",
  startAt: "开始时间",
  startAtIsAllDay: "开始全天标记",
  dueAt: "截止时间",
  dueAtIsAllDay: "截止全天标记",
  timeBlock: "时间块",
  reminders: "提醒",
  recurrence: "循环规则",
  recurrenceSeriesId: "循环系列",
  recurrenceIndex: "循环序号",
  estimatedMinutes: "预计时长",
  actualMinutes: "实际时长",
  focusStartedAt: "专注状态",
  focusElapsedSeconds: "专注时长",
  focusSessions: "专注记录",
  privateOrder: "排序",
  completionMode: "完成方式",
  currentUserRole: "我的角色",
  currentUserCompleted: "我的完成状态",
  deletedAt: "回收站状态",
  comments: "讨论",
  researchCards: "研究卡",
};

const dateKey = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const relativePlanLabel = (value: string): string => {
  const today = dateKey();
  if (value === today) return "今天";
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (value === dateKey(tomorrow)) return "明天";
  return value;
};

const temporalDateKey = (value?: string): string | undefined => {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : dateKey(instant);
};

const smartViewDateLabels: Record<SmartViewDateFilter, string> = {
  any: "任意日期",
  overdue: "已逾期",
  today: "今天",
  "next-7-days": "未来 7 天",
  "no-date": "无日期",
};

const smartViewMatchesDate = (
  task: Task,
  filter: SmartViewDateFilter,
  today = dateKey(),
): boolean => {
  if (filter === "any") return true;
  const dates = [temporalDateKey(task.dueAt), task.plannedDate].filter(
    (value): value is string => Boolean(value),
  );
  if (filter === "no-date") return dates.length === 0;
  if (filter === "overdue") return dates.some((value) => value < today);
  if (filter === "today") return dates.some((value) => value === today);
  const horizon = new Date(`${today}T00:00:00`);
  horizon.setDate(horizon.getDate() + 7);
  const horizonKey = dateKey(horizon);
  return dates.some((value) => value > today && value <= horizonKey);
};

const isOpenTaskOverdue = (task: Task, today = dateKey()): boolean => {
  const dueDate = temporalDateKey(task.dueAt);
  return (
    task.status === "open" &&
    !task.deletedAt &&
    dueDate !== undefined &&
    dueDate < today
  );
};

function isMacPlatform(): boolean {
  return navigator.platform.toLocaleLowerCase().includes("mac");
}

function formatDateTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function allDayDateInput(value?: string): string {
  return toLocalDateTimeInput(value).slice(0, 10);
}

function allDayDateTimeInput(value: string, isAllDay: boolean): string {
  if (!isAllDay || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  return `${value}T00:00`;
}

function feishuSyncIssueCopy(
  issue: NonNullable<FeishuSyncReportView["issue"]>,
): string {
  switch (issue.code) {
    case "NETWORK_UNAVAILABLE":
      return "当前无法连接飞书，改动已保留并会在网络恢复后继续同步";
    case "RATE_LIMITED":
      return "飞书请求过于频繁，改动已保留并会稍后重试";
    case "AUTH_REQUIRED":
      return "飞书登录已失效，请重新连接";
    case "PERMISSION_DENIED":
      return "当前飞书账号没有执行此操作的权限";
    case "SYNC_FAILED":
      return "飞书同步失败，请检查任务后重试";
  }
}

function humanDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const floatingCarouselIntervalMs = 3_600;

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const mediaQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mediaQuery) return undefined;
    const update = () => setPrefersReducedMotion(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);
  return prefersReducedMotion;
}

function useFloatingTodayCarousel(
  tasks: Task[],
  focusedTask: Task | undefined,
  paused: boolean,
): {
  task?: Task;
  index: number;
  count: number;
  paused: boolean;
  static: boolean;
} {
  const prefersReducedMotion = usePrefersReducedMotion();
  const todayTasks = useMemo(
    () => tasks.filter((task) => task.status === "open" && !task.deletedAt),
    [tasks],
  );
  const taskIds = todayTasks.map((task) => task.id).join("\u0001");
  const [activeTaskId, setActiveTaskId] = useState<string>();
  useEffect(() => {
    setActiveTaskId((currentId) => {
      if (focusedTask?.id) return focusedTask.id;
      if (currentId && todayTasks.some((task) => task.id === currentId)) {
        return currentId;
      }
      return todayTasks[0]?.id;
    });
  }, [focusedTask?.id, taskIds, todayTasks]);

  const activeIndex = Math.max(
    0,
    todayTasks.findIndex((task) => task.id === activeTaskId),
  );
  const activeTask = focusedTask ?? todayTasks[activeIndex];
  const staticCarousel =
    Boolean(focusedTask) || todayTasks.length < 2 || prefersReducedMotion;
  const carouselPaused = paused || staticCarousel;

  useEffect(() => {
    if (carouselPaused) return undefined;
    const timer = window.setInterval(() => {
      setActiveTaskId((currentId) => {
        const currentIndex = todayTasks.findIndex(
          (task) => task.id === currentId,
        );
        return todayTasks[(currentIndex + 1) % todayTasks.length]?.id;
      });
    }, floatingCarouselIntervalMs);
    return () => window.clearInterval(timer);
  }, [carouselPaused, taskIds, todayTasks]);

  return {
    task: activeTask,
    index: activeTask ? activeIndex : 0,
    count: todayTasks.length,
    paused: carouselPaused,
    static: staticCarousel,
  };
}

function FloatingTodayCarousel({
  task,
  index,
  count,
  paused,
  static: staticCarousel,
  privacyMode,
}: {
  task?: Task;
  index: number;
  count: number;
  paused: boolean;
  static: boolean;
  privacyMode: boolean;
}) {
  const title = task ? (privacyMode ? "私人任务" : task.title) : "今天已清空";
  const mode = privacyMode
    ? "private"
    : !task
      ? "empty"
      : staticCarousel
        ? "static"
        : "rotating";
  return (
    <div
      className={`floating-carousel ${staticCarousel || privacyMode ? "is-static" : ""} ${paused ? "is-paused" : ""}`}
      data-carousel-mode={mode}
      data-carousel-paused={paused ? "true" : "false"}
      aria-label={
        privacyMode
          ? "隐私模式：今日任务"
          : task
            ? `今日任务 ${index + 1}/${count}：${task.title}`
            : "今天没有待办"
      }
      aria-live="off"
    >
      <strong className="floating-carousel-item" key={privacyMode ? "private" : task?.id ?? "empty"}>
        {title}
      </strong>
    </div>
  );
}

function feishuRequestFromSettings(
  settings: AppSettings,
): FeishuConfigureRequest | undefined {
  const tokenCredentialId =
    settings.feishu.tokenCredentialId ??
    defaultSettings.feishu.tokenCredentialId!;
  if (settings.feishu.mode === "personal-direct") {
    if (!settings.feishu.clientId || !settings.feishu.appSecretCredentialId) {
      return undefined;
    }
    return {
      mode: "personal-direct",
      accountId: settings.feishu.accountId,
      tokenCredentialId,
      clientId: settings.feishu.clientId,
      appSecretCredentialId: settings.feishu.appSecretCredentialId,
    };
  }
  if (settings.feishu.mode === "existing-direct") {
    if (!settings.feishu.clientId || !settings.feishu.appSecretCredentialId) {
      return undefined;
    }
    return {
      mode: "existing-direct",
      accountId: settings.feishu.accountId,
      tokenCredentialId,
      clientId: settings.feishu.clientId,
      appSecretCredentialId: settings.feishu.appSecretCredentialId,
    };
  }
  if (settings.feishu.mode === "relay") {
    if (!settings.feishu.relayBaseUrl.startsWith("https://")) return undefined;
    return {
      mode: "relay",
      accountId: settings.feishu.accountId,
      tokenCredentialId,
      relayBaseUrl: settings.feishu.relayBaseUrl,
      clientId: settings.feishu.clientId || undefined,
    };
  }
  if (
    !settings.feishu.clientId ||
    !settings.feishu.appSecretCredentialId ||
    !settings.feishu.acknowledgeInsecureLocalCredentials
  )
    return undefined;
  return {
    mode: "local-development",
    accountId: settings.feishu.accountId,
    tokenCredentialId,
    clientId: settings.feishu.clientId,
    appSecretCredentialId: settings.feishu.appSecretCredentialId,
    acknowledgeInsecureLocalCredentials: true,
  };
}

function SourcePill({ source }: { source: TaskSourceType }) {
  return source === "feishu" ? (
    <span className="source-pill feishu">
      <Cloud size={14} aria-hidden="true" />
      飞书
    </span>
  ) : (
    <span className="source-pill">
      <Laptop size={14} aria-hidden="true" />
      本地
    </span>
  );
}

type TaskSyncVisualState = "synced" | "pending" | "conflict" | "error";

function taskSyncVisualState(status: TaskSyncStatus): TaskSyncVisualState {
  if (status === "conflict") return "conflict";
  if (
    ["failed", "permission-denied", "read-only", "remote-deleted"].includes(
      status,
    )
  ) {
    return "error";
  }
  if (["pending", "offline", "syncing"].includes(status)) return "pending";
  return "synced";
}

function taskSyncLabel(status: TaskSyncStatus): string | undefined {
  switch (status) {
    case "pending":
      return "待同步";
    case "offline":
      return "离线待同步";
    case "syncing":
      return "正在同步";
    case "conflict":
      return "同步冲突";
    case "failed":
      return "同步失败";
    case "permission-denied":
      return "权限不足";
    case "read-only":
      return "只读，未写回";
    case "remote-deleted":
      return "飞书已删除";
    default:
      return undefined;
  }
}


function needsFeishuForCosignCompletion(task: Task): boolean {
  return (
    task.source.type === "feishu" &&
    task.status === "open" &&
    task.completionMode === "all-assignees"
  );
}

function canToggleTaskCompletion(task: Task): boolean {
  if (task.source.type === "local") return true;
  if (
    task.currentUserRole === "follower" ||
    task.currentUserRole === "viewer" ||
    ["read-only", "permission-denied"].includes(task.sync.status)
  ) {
    return false;
  }
  return !needsFeishuForCosignCompletion(task);
}

function Brand({ onHome }: { onHome?: () => void }) {
  const content = (
    <>
      <span className="brand-mark">
        <Check size={18} aria-hidden="true" />
      </span>
      <span>Todo Agent</span>
    </>
  );
  return onHome ? (
    <button
      type="button"
      className="app-brand brand-button no-drag"
      onClick={onHome}
      aria-label="返回今天"
    >
      {content}
    </button>
  ) : (
    <div className="app-brand">{content}</div>
  );
}

function Titlebar({
  search,
  onSearch,
  onNew,
  onOpenCommands,
  onHome,
  onBack,
  syncState = "synced",
  children,
}: {
  search?: string;
  onSearch?: (value: string) => void;
  onNew?: () => void;
  onOpenCommands?: () => void;
  onHome?: () => void;
  onBack?: () => void;
  syncState?: TaskSyncVisualState;
  children?: ReactNode;
}) {
  const isMac = isMacPlatform();
  return (
    <header
      className={`app-titlebar drag-region ${isMac ? "is-mac" : "uses-titlebar-overlay"}`}
    >
      {isMac && <span className="native-titlebar-inset" aria-hidden="true" />}
      <Brand onHome={onHome} />
      {onBack && (
        <button
          type="button"
          className="titlebar-back ghost-button no-drag"
          onClick={onBack}
          aria-label="返回上一页"
          title="返回上一页"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          返回
        </button>
      )}
      <div className="titlebar-spacer" />
      {search !== undefined && onSearch && (
        <label className="title-search no-drag">
          <Search size={16} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="搜索任务、项目或标签"
            aria-label="搜索任务"
            data-search-input
          />
          {search ? (
            <button
              type="button"
              className="title-search-clear no-drag"
              onClick={() => onSearch("")}
              aria-label="清除搜索"
              title="清除搜索"
            >
              <X size={15} aria-hidden="true" />
            </button>
          ) : (
            onOpenCommands ? (
              <button
                type="button"
                className="title-search-command no-drag"
                onClick={onOpenCommands}
                aria-label="打开快速命令"
                title="打开快速命令"
              >
                {isMacPlatform() ? "⌘ K" : "Ctrl K"}
              </button>
            ) : (
              <kbd>{isMacPlatform() ? "⌘ K" : "Ctrl K"}</kbd>
            )
          )}
        </label>
      )}
      {children}
      <span
        className={`status-pill ${syncState === "synced" ? "success" : syncState === "conflict" ? "warning" : syncState === "error" ? "danger" : "syncing"}`}
      >
        {syncState === "synced" ? (
          <CloudCheck size={15} />
        ) : syncState === "conflict" ? (
          <AlertTriangle size={15} />
        ) : syncState === "error" ? (
          <ShieldAlert size={15} />
        ) : (
          <RefreshCw size={15} />
        )}
        {syncState === "synced"
          ? "已保存"
          : syncState === "conflict"
            ? "有冲突"
            : syncState === "error"
              ? "同步异常"
            : "待同步"}
      </span>
      {onNew && (
        <button
          type="button"
          className="primary-button no-drag"
          onClick={onNew}
        >
          <Plus size={17} />
          新建
        </button>
      )}
    </header>
  );
}

interface SidebarCounts {
  inbox?: number;
  today?: number;
  upcoming?: number;
  all?: number;
  completed?: number;
  trash?: number;
  local?: number;
  feishu?: number;
  conflicts?: number;
  syncIssues?: number;
}

function useSidebarCounts(): SidebarCounts {
  const [counts, setCounts] = useState<SidebarCounts>({});
  const refreshRequestRef = useRef(0);
  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    const api = window.desktopApi?.tasks;
    if (!api) return;
    const [
      inbox,
      today,
      upcoming,
      all,
      completed,
      trash,
      local,
      feishu,
      visible,
    ] = await Promise.all([
      api.list({ view: "inbox" }),
      api.list({ view: "today" }),
      api.list({ view: "upcoming" }),
      api.list({ view: "all" }),
      api.list({ view: "completed" }),
      api.list({ view: "trash" }),
      api.list({ sourceTypes: ["local"], statuses: ["open"] }),
      api.list({ sourceTypes: ["feishu"], statuses: ["open"] }),
      api.list(),
    ]);
    // Several filtered IPC reads make up one sidebar snapshot. Ignore an
    // older batch if a later task-change refresh has already begun, so a
    // delayed pre-edit count cannot replace the current counts.
    if (requestId !== refreshRequestRef.current) return;
    setCounts({
      inbox: inbox.length,
      today: today.filter((task) => task.status === "open").length,
      upcoming: upcoming.length,
      all: all.length,
      completed: completed.length,
      trash: trash.length,
      local: local.length,
      feishu: feishu.length,
      conflicts: visible.filter((task) => task.sync.status === "conflict")
        .length,
      syncIssues: visible.filter(
        (task) =>
          task.source.type === "feishu" &&
          !["local", "synced"].includes(task.sync.status),
      ).length,
    });
  }, []);
  useEffect(() => {
    void refresh();
    return window.desktopApi?.events.onTasksChanged(() => {
      void refresh();
    });
  }, [refresh]);
  return counts;
}

function useProjects(): {
  projects: TaskProject[];
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
} {
  const [projects, setProjects] = useState<TaskProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    if (!window.desktopApi) {
      setProjects([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      setProjects(await window.desktopApi.tasks.listProjects(true));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取项目失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return window.desktopApi?.events.onTasksChanged(() => {
      void refresh();
    });
  }, [refresh]);
  return { projects, loading, error, refresh };
}

function useLists(): {
  lists: TaskList[];
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
} {
  const [lists, setLists] = useState<TaskList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    if (!window.desktopApi) {
      setLists([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      setLists(await window.desktopApi.tasks.listLists(true));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取清单失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return window.desktopApi?.events.onTasksChanged(() => {
      void refresh();
    });
  }, [refresh]);
  return { lists, loading, error, refresh };
}

function Sidebar({
  route,
  sourceFilter,
  counts,
  onRoute,
  onSource,
}: {
  route: MainRoute;
  sourceFilter?: TaskSourceType;
  counts: SidebarCounts;
  onRoute: (route: MainRoute) => void;
  onSource: (source: TaskSourceType) => void;
}) {
  const item = (
    target: MainRoute,
    icon: ReactNode,
    count?: number,
    extraClass = "",
  ) => (
    <button
      type="button"
      className={`nav-button ${route === target ? "active" : ""} ${extraClass}`}
      onClick={() => onRoute(target)}
    >
      {icon}
      <span>{routeTitles[target]}</span>
      {count !== undefined && count > 0 && (
        <span className="nav-count">{count}</span>
      )}
    </button>
  );
  return (
    <nav className="sidebar" aria-label="主导航">
      <div className="nav-section-label">任务</div>
      {item("inbox", <Inbox size={17} />, counts.inbox)}
      {item("today", <Sun size={17} />, counts.today)}
      {item("upcoming", <CalendarDays size={17} />, counts.upcoming)}
      {item("all", <LayoutList size={17} />, counts.all)}
      {item("completed", <CheckCircle2 size={17} />, counts.completed)}
      {item("trash", <Trash2 size={17} />, counts.trash)}
      <div className="nav-section-label">来源</div>
      <button
        type="button"
        className={`nav-button ${sourceFilter === "local" ? "active" : ""}`}
        onClick={() => onSource("local")}
      >
        <Laptop size={17} />
        <span>本地</span>
        {Boolean(counts.local) && (
          <span className="nav-count">{counts.local}</span>
        )}
      </button>
      <button
        type="button"
        className={`nav-button ${sourceFilter === "feishu" ? "active" : ""}`}
        onClick={() => onSource("feishu")}
      >
        <Cloud size={17} />
        <span>飞书</span>
        {Boolean(counts.feishu) && (
          <span className="nav-count">{counts.feishu}</span>
        )}
      </button>
      {item(
        "sync",
        <AlertTriangle size={17} />,
        counts.syncIssues,
        counts.syncIssues ? "warning" : "",
      )}
      <div className="nav-section-label">工作台</div>
      {item("pet", <UserRound size={17} />)}
      {item("agent", <Sparkles size={17} />)}
      {item("timeline", <CalendarDays size={17} />)}
      {item("projects", <FolderKanban size={17} />)}
      {item("lists", <ListChecks size={17} />)}
      {item("activity", <Activity size={17} />)}
      <div className="sidebar-footer">
        {item("settings", <Settings size={17} />)}
      </div>
    </nav>
  );
}

function MorningBrief({
  controller,
  planningTasks,
  notify,
  onPlanToday,
}: {
  controller: TaskController;
  planningTasks?: Task[];
  notify: (message: string, kind?: ToastKind) => void;
  onPlanToday: () => void;
}) {
  const [aiSummary, setAiSummary] = useState<string>();
  const [aiRefreshing, setAiRefreshing] = useState(false);
  const [shortPlanOpen, setShortPlanOpen] = useState(false);
  const openTasks = controller.tasks.filter(
    (task) => task.status === "open" && !task.deletedAt,
  );
  const overdue = openTasks.filter((task) => isOpenTaskOverdue(task)).length;
  const feishu = openTasks.filter(
    (task) => task.source.type === "feishu",
  ).length;
  const first = openTasks[0];
  const shortPlan = useMemo(
    () =>
      suggestDailyPlan(planningTasks ?? controller.tasks, {
        date: new Date(),
        capacityMinutes: 120,
        maxSuggestedItems: 3,
      }),
    [controller.tasks, planningTasks],
  );
  const localSummary =
    openTasks.length === 0
      ? "今天还没有安排。可以先写下一件最重要的小事。"
      : `${overdue ? `有 ${overdue} 项逾期；` : ""}今天共 ${openTasks.length} 项，其中 ${feishu} 项来自飞书。${first ? `建议先从“${first.title}”开始。` : ""}`;

  const requestAiBrief = useCallback(
    async (trigger: "automatic" | "manual"): Promise<void> => {
      if (!window.desktopApi) return;
      if (trigger === "manual") setAiRefreshing(true);
      try {
        const result: MorningBriefResult =
          await window.desktopApi.agent.morningBrief({ trigger });
        if (result.source === "ai" && result.summary) {
          setAiSummary(result.summary);
          if (trigger === "manual") notify("AI 简报已更新", "success");
          return;
        }
        if (trigger === "manual") {
          const message =
            result.code === "MODEL_DATA_SCOPE_DISABLED"
              ? "请先在设置中允许模型读取任务标题与时间"
              : result.code === "AI_DISABLED" ||
                  result.code === "AI_NOT_CONFIGURED"
                ? "请先完成 AI 模型设置"
                : result.code === "NO_TASKS"
                  ? "今天还没有需要总结的任务"
                  : "AI 暂时不可用，已保留本地简报";
          notify(message, result.code === "NO_TASKS" ? "info" : "error");
        }
      } catch {
        if (trigger === "manual") {
          notify("AI 暂时不可用，已保留本地简报", "error");
        }
      } finally {
        if (trigger === "manual") setAiRefreshing(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    void requestAiBrief("automatic");
  }, [requestAiBrief]);

  const muteForToday = async () => {
    if (!window.desktopApi) {
      notify("今天不再主动提醒");
      return;
    }
    try {
      const settings = await window.desktopApi.settings.get();
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      await window.desktopApi.settings.replace({
        ...settings,
        notifications: {
          ...settings.notifications,
          mutedUntil: tomorrow.toISOString(),
        },
      });
      await window.desktopApi.notifications.refresh();
      notify("主动提醒已暂停到明天", "success");
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "暂时无法暂停提醒",
        "error",
      );
    }
  };
  return (
    <section className="morning-brief" aria-label="晨间简报">
      <div className="brief-title">
        <span className="agent-orb">
          <Sparkles size={18} />
        </span>
        <span>晨间简报</span>
      </div>
      <p className="brief-copy">{aiSummary ?? localSummary}</p>
      <div className="brief-actions">
        <button type="button" className="primary-button" onClick={onPlanToday}>
          <CalendarDays size={15} />
          帮我选今天
        </button>
        {first && (
          <button
            type="button"
            className="soft-button"
            onClick={() => {
              void controller.startFocus(first.id);
              notify(`已开始“${first.title}”`);
            }}
          >
            <Play size={15} />
            开始首项
          </button>
        )}
        <button
          type="button"
          className="ghost-button"
          onClick={() => setShortPlanOpen((value) => !value)}
        >
          <Clock3 size={14} />
          {shortPlanOpen ? "收起 2 小时方案" : "只剩 2 小时？"}
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={aiRefreshing}
          onClick={() => void requestAiBrief("manual")}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {aiRefreshing ? "正在生成…" : "AI 刷新"}
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => void muteForToday()}
        >
          今日不再提醒
        </button>
      </div>
      {shortPlanOpen && (
        <section className="brief-short-plan" aria-label="只剩两小时的替代计划">
          <div className="brief-short-plan-heading">
            <div>
              <strong>如果今天只剩 2 小时</strong>
              <small>
                先处理最紧急、能解锁后续工作的任务；这是只读建议，不会自动改动任务。
              </small>
            </div>
            <span>{shortPlan.totalMinutes} 分钟 / 2 小时</span>
          </div>
          {shortPlan.selectedItems.length > 0 ? (
            <ol>
              {shortPlan.selectedItems.slice(0, 3).map((item) => (
                <li key={item.task.id}>
                  <span className="brief-short-plan-task">
                    <strong>{item.task.title}</strong>
                    <small>{item.primaryReason} · {item.estimatedMinutes} 分钟</small>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="brief-short-plan-empty">目前没有能在两小时内安排的开放任务。</p>
          )}
          <div className="brief-short-plan-actions">
            <button type="button" className="soft-button" onClick={onPlanToday}>
              <CalendarDays size={14} />
              在今日规划中确认
            </button>
            <button type="button" className="ghost-button" onClick={() => setShortPlanOpen(false)}>
              先不安排
            </button>
          </div>
        </section>
      )}
    </section>
  );
}

function TaskRow({
  task,
  selected,
  controller,
  notify,
  moveUp,
  moveDown,
  selectionMode = false,
  selectedForBulk = false,
  onToggleBulk,
  interactionDisabled = false,
  subtaskProgress,
  onAskAgent,
}: {
  task: Task;
  selected: boolean;
  controller: TaskController;
  notify: (
    message: string,
    kind?: ToastKind,
    action?: ToastState["action"],
  ) => void;
  moveUp?: () => void;
  moveDown?: () => void;
  selectionMode?: boolean;
  selectedForBulk?: boolean;
  onToggleBulk?: () => void;
  interactionDisabled?: boolean;
  subtaskProgress?: SubtaskProgress;
  onAskAgent: (prompt: string) => void;
}) {
  const canComplete = canToggleTaskCompletion(task);
  const completionVerb = needsFeishuForCosignCompletion(task)
    ? "请在飞书完成"
    : "完成";
  const toggle = async () => {
    if (!canComplete) return;
    try {
      const operationId = await controller.toggleComplete(task);
      notify(
        task.status === "completed"
          ? "任务已恢复"
          : task.source.type === "feishu"
            ? `${completionVerb} · 正在同步飞书`
            : "任务已完成",
        "success",
        operationId
          ? { label: "撤销", run: () => void controller.undo(operationId) }
          : undefined,
      );
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "暂时无法更新完成状态",
        "error",
      );
    }
  };
  const overdue = isOpenTaskOverdue(task);
  const reason = task.status === "open" ? priorityReason(task) : undefined;
  const subtaskLabel = subtaskProgressLabel(subtaskProgress);
  const classes = [
    "task-row",
    selectionMode ? "bulk-mode" : "",
    selectedForBulk ? "bulk-selected" : "",
    selected ? "selected" : "",
    task.status === "completed" ? "completed" : "",
    task.sync.status === "pending" ? "pending" : "",
    task.sync.status === "conflict" ? "conflict" : "",
    taskSyncVisualState(task.sync.status) === "error" ? "sync-error" : "",
  ].join(" ");
  return (
    <div className={classes} data-task-id={task.id}>
      {selectionMode && onToggleBulk && (
        <input
          className="bulk-select-checkbox"
          type="checkbox"
          checked={selectedForBulk}
          disabled={interactionDisabled}
          onChange={onToggleBulk}
          aria-label={`${selectedForBulk ? "取消选择" : "选择"}${task.title}`}
        />
      )}
      <input
        className="task-checkbox"
        type="checkbox"
        checked={task.status === "completed"}
        disabled={!canComplete || interactionDisabled}
        title={
          needsFeishuForCosignCompletion(task)
            ? "飞书开放接口不能完成会签中的个人部分，请在飞书中操作"
            : undefined
        }
        onChange={() => void toggle()}
        aria-label={`${task.status === "completed" ? "恢复" : completionVerb}${task.title}`}
      />
      <button
        type="button"
        className="task-body"
        aria-pressed={selectionMode ? selectedForBulk : undefined}
        onClick={() =>
          interactionDisabled
            ? undefined
            : selectionMode && onToggleBulk
            ? onToggleBulk()
            : controller.select(task.id)
        }
      >
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          {task.plannedDate && (
            <span className="private">
              私人计划{" "}
              {task.plannedDate === dateKey() ? "今天" : task.plannedDate}
            </span>
          )}
          {task.dueAt && (
            <span className={overdue ? "overdue" : ""}>
              {overdue ? "已逾期 · " : "截止 "}
              {formatDateTime(task.dueAt)}
            </span>
          )}
          {task.estimatedMinutes && (
            <span>预计 {task.estimatedMinutes} 分钟</span>
          )}
          {subtaskLabel && <span className="subtask-progress-label">{subtaskLabel}</span>}
          {(task.contexts ?? []).slice(0, 3).map((context) => (
            <span className="task-context-pill" key={context}>
              {context}
            </span>
          ))}
          {(task.contexts ?? []).length > 3 && (
            <span className="task-context-pill">+{(task.contexts ?? []).length - 3}</span>
          )}
          {task.sync.status === "pending" && <span>待同步</span>}
          {task.sync.status === "conflict" && (
            <span className="overdue">同步冲突</span>
          )}
          {taskSyncVisualState(task.sync.status) === "error" && (
            <span className="overdue">
              {taskSyncLabel(task.sync.status) ?? "同步异常"}
            </span>
          )}
          {reason && (
            <span
              className="task-reason"
              title={`推荐依据：${reason}`}
              aria-label={`推荐依据：${reason}`}
            >
              <Sparkles size={11} aria-hidden="true" /> {reason}
            </span>
          )}
        </span>
      </button>
      <div className="task-actions">
        {moveUp && (
          <button
            type="button"
            className="row-icon-button"
            disabled={interactionDisabled}
            onClick={moveUp}
            aria-label={`上移${task.title}`}
          >
            <ArrowUp size={14} />
          </button>
        )}
        {moveDown && (
          <button
            type="button"
            className="row-icon-button"
            disabled={interactionDisabled}
            onClick={moveDown}
            aria-label={`下移${task.title}`}
          >
            <ChevronDown size={15} />
          </button>
        )}
        {!selectionMode && (
          <button
            type="button"
            className="row-icon-button task-agent-button"
            disabled={interactionDisabled}
            onClick={() => onAskAgent(buildTaskAgentPrompt(task))}
            aria-label={`让 Agent 处理${task.title}`}
            title="让 Agent 处理此任务"
          >
            <MessageCircle size={14} aria-hidden="true" />
          </button>
        )}
        <SourcePill source={task.source.type} />
      </div>
    </div>
  );
}

function TaskListPage({
  route,
  controller,
  planningTasks,
  search,
  navigationKey,
  sourceFilter,
  notify,
  onNew,
  onClearSearch,
  onAskAgent,
  onPlanToday,
  onSourceChange,
}: {
  route: TaskView;
  controller: TaskController;
  planningTasks?: Task[];
  search: string;
  navigationKey: string;
  sourceFilter?: TaskSourceType;
  notify: (
    message: string,
    kind?: ToastKind,
    action?: ToastState["action"],
  ) => void;
  onNew: () => void;
  onClearSearch: () => void;
  onAskAgent: (prompt: string) => void;
  onPlanToday: () => void;
  onSourceChange: (source?: TaskSourceType) => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [inboxTriageOpen, setInboxTriageOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelection, setBulkSelection] = useState<Set<string>>(
    () => new Set(),
  );
  const [bulkPreview, setBulkPreview] = useState<BulkTaskAction>();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "all">(
    "all",
  );
  const [projectFilter, setProjectFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [contextFilter, setContextFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState<SmartViewDateFilter>("any");
  const [sortFilter, setSortFilter] = useState<SmartViewSort>("manual");
  const [projectOptions, setProjectOptions] = useState<string[]>([]);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [contextOptions, setContextOptions] = useState<string[]>([]);
  const [taskSnapshot, setTaskSnapshot] = useState<Task[]>([]);
  const [smartViews, setSmartViews] = useState<SmartViewDefinition[]>(() => readSmartViews());
  const [activeSmartViewId, setActiveSmartViewId] = useState<string>();
  const [smartViewName, setSmartViewName] = useState("");
  const [smartViewQuery, setSmartViewQuery] = useState("");
  const [smartViewQueryResult, setSmartViewQueryResult] =
    useState<SmartViewQueryResult>();
  // A sidebar destination represents a different collection, not a compound
  // search. Secondary filters belong to the current collection so they cannot
  // make the next page look empty while its sidebar count is non-zero.
  useEffect(() => {
    setFilterOpen(false);
    setPriorityFilter("all");
    setProjectFilter("all");
    setTagFilter("all");
    setContextFilter("all");
    setDateFilter("any");
    setSortFilter("manual");
    setActiveSmartViewId(undefined);
    setBulkMode(false);
    setBulkSelection(new Set());
    setBulkPreview(undefined);
    setInboxTriageOpen(false);
    setSmartViewQuery("");
    setSmartViewQueryResult(undefined);
  }, [navigationKey]);
  const applySmartView = (view: SmartViewDefinition) => {
    setPriorityFilter(view.priority);
    setProjectFilter(view.projectId);
    setTagFilter(view.tag);
    setContextFilter(view.context);
    setDateFilter(view.dateFilter);
    setSortFilter(view.sort);
    onSourceChange(view.sourceType);
    setActiveSmartViewId(view.id);
    setFilterOpen(false);
  };
  const saveSmartView = () => {
    const created = createSmartView({
      name: smartViewName,
      route,
      priority: priorityFilter,
      projectId: projectFilter,
      tag: tagFilter,
      context: contextFilter,
      dateFilter,
      sort: sortFilter,
      sourceType: sourceFilter,
    });
    if (!created) {
      notify("请给这个视图起一个 1–60 字的名字", "error");
      return;
    }
    const next = [
      created,
      ...smartViews.filter((view) => view.name !== created.name),
    ].slice(0, 24);
    setSmartViews(next);
    writeSmartViews(next);
    setSmartViewName("");
    setActiveSmartViewId(created.id);
    notify(`已保存视图“${created.name}”`, "success");
  };
  const removeSmartView = (id: string) => {
    const next = smartViews.filter((view) => view.id !== id);
    setSmartViews(next);
    writeSmartViews(next);
    if (activeSmartViewId === id) setActiveSmartViewId(undefined);
    notify("已删除保存的视图", "info");
  };
  const parseSmartViewQueryForPreview = () => {
    const result = parseSmartViewQuery(smartViewQuery, {
      projects: projectOptions,
      tags: tagOptions,
      contexts: contextOptions,
    });
    setSmartViewQueryResult(result);
    if (result.kind === "error") notify(result.value.message, "error");
  };
  const applySmartViewQuery = () => {
    if (smartViewQueryResult?.kind !== "suggestion") return;
    const { filters } = smartViewQueryResult.value;
    setPriorityFilter(filters.priority);
    setProjectFilter(filters.projectId);
    setTagFilter(filters.tag);
    setContextFilter(filters.context);
    setDateFilter(filters.dateFilter);
    setSortFilter(filters.sort);
    onSourceChange(filters.sourceType);
    setActiveSmartViewId(undefined);
    setSmartViewQuery("");
    setSmartViewQueryResult(undefined);
    setFilterOpen(false);
    notify(`已套用筛选：${smartViewQueryResult.value.summary.join(" · ")}`, "success");
  };
  const dateLabel = new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());
  const hour = new Date().getHours();
  const greeting = hour < 11 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  const visibleSections = useMemo(
    () =>
      controller.sections
        .map((section) => ({
          ...section,
          tasks: sortSmartViewTasks(
            section.tasks.filter(
              (task) =>
                (priorityFilter === "all" || task.priority === priorityFilter) &&
                (projectFilter === "all" || task.projectId === projectFilter) &&
                (tagFilter === "all" || task.tags.includes(tagFilter)) &&
                (contextFilter === "all" ||
                  (task.contexts ?? []).some(
                    (context) =>
                      context.toLocaleLowerCase() ===
                      contextFilter.toLocaleLowerCase(),
                  )) &&
                smartViewMatchesDate(task, dateFilter),
            ),
            sortFilter,
          ),
        }))
        .filter((section) => section.tasks.length > 0),
    [
      controller.sections,
      priorityFilter,
      projectFilter,
      tagFilter,
      contextFilter,
      dateFilter,
      sortFilter,
    ],
  );
  useEffect(() => {
    setBulkSelection((current) => {
      const visibleIds = new Set(
        visibleSections.flatMap((section) => section.tasks.map((task) => task.id)),
      );
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleSections]);
  const visibleTasks = useMemo(
    () => visibleSections.flatMap((section) => section.tasks),
    [visibleSections],
  );
  const inboxTriageTasks = useMemo(
    () =>
      controller.tasks.filter(
        (task) =>
          task.status === "open" &&
          !task.deletedAt &&
          !task.plannedDate &&
          !task.projectId &&
          !task.listId,
      ),
    [controller.tasks],
  );
  const selectedBulkTasks = useMemo(
    () => visibleTasks.filter((task) => bulkSelection.has(task.id)),
    [bulkSelection, visibleTasks],
  );
  const allSelectedAreOpen =
    selectedBulkTasks.length > 0 &&
    selectedBulkTasks.every(
      (task) => task.status === "open" && task.deletedAt === undefined,
    );
  const allSelectedAreCompleted =
    selectedBulkTasks.length > 0 &&
    selectedBulkTasks.every(
      (task) => task.status === "completed" && task.deletedAt === undefined,
    );
  const allSelectedCanComplete =
    allSelectedAreOpen && selectedBulkTasks.every(canToggleTaskCompletion);
  const allSelectedCanMoveToToday =
    allSelectedAreOpen &&
    selectedBulkTasks.some((task) => task.plannedDate !== dateKey());
  const allSelectedCanTrash =
    selectedBulkTasks.length > 0 &&
    selectedBulkTasks.every((task) => task.deletedAt === undefined);
  const allSelectedCanRestore =
    selectedBulkTasks.length > 0 &&
    selectedBulkTasks.every((task) => task.deletedAt !== undefined);
  const bulkActionLabel = (action: BulkTaskAction): string => {
    if (action.kind === "complete") return "完成任务";
    if (action.kind === "reopen") return "恢复任务";
    if (action.kind === "move-to-today") return "安排到今天";
    if (action.kind === "trash") return "移入回收站";
    return "恢复出回收站";
  };
  const requestBulkPreview = (action: BulkTaskAction) => {
    if (selectedBulkTasks.length === 0) return;
    setBulkPreview(action);
  };
  const runBulkAction = async () => {
    if (!bulkPreview || selectedBulkTasks.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const operationId = await controller.applyBulkTaskAction({
        ids: selectedBulkTasks.map((task) => task.id),
        action: bulkPreview,
        baselines: selectedBulkTasks.map((task) => ({
          id: task.id,
          updatedAt: task.updatedAt,
        })),
      });
      const label = bulkActionLabel(bulkPreview);
      setBulkPreview(undefined);
      setBulkSelection(new Set());
      setBulkMode(false);
      notify(
        `${selectedBulkTasks.length} 项任务已${label.replace("任务", "")}`,
        "success",
        operationId
          ? { label: "撤销", run: () => void controller.undo(operationId) }
          : undefined,
      );
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "批量操作未完成",
        "error",
      );
    } finally {
      setBulkBusy(false);
    }
  };
  const toggleBulkMode = () => {
    setBulkMode((current) => {
      if (current) {
        setBulkSelection(new Set());
        setBulkPreview(undefined);
      }
      return !current;
    });
  };
  const selectAllVisible = () => {
    setBulkSelection(new Set(visibleTasks.map((task) => task.id)));
  };
  const toggleBulkSelection = (taskId: string) => {
    setBulkPreview(undefined);
    setBulkSelection((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };
  useEffect(() => {
    const applyOptions = (tasks: readonly Task[]) => {
      setTaskSnapshot([...tasks]);
      setProjectOptions(
        [...new Set(tasks.map((task) => task.projectId).filter((value): value is string => Boolean(value)))]
          .sort((a, b) => a.localeCompare(b, "zh-CN")),
      );
      setTagOptions(
        [...new Set(tasks.flatMap((task) => task.tags))]
          .sort((a, b) => a.localeCompare(b, "zh-CN")),
      );
      setContextOptions(
        [...new Set(tasks.flatMap((task) => task.contexts ?? []))]
          .sort((a, b) => a.localeCompare(b, "zh-CN")),
      );
    };
    if (!window.desktopApi) {
      applyOptions(controller.tasks);
      return;
    }
    void window.desktopApi.tasks
      .list({ includeDeleted: false })
      .then(applyOptions);
  }, [controller.tasks]);
  const subtaskProgress = useMemo(
    () => buildSubtaskProgress(taskSnapshot),
    [taskSnapshot],
  );
  const orderedTodayIds = useMemo(
    () =>
      visibleSections
        .flatMap((section) => section.tasks)
        .filter((task) => task.status === "open")
        .map((task) => task.id),
    [visibleSections],
  );
  const moveTodayTask = async (taskId: string, targetTaskId: string) => {
    const index = orderedTodayIds.indexOf(taskId);
    const target = orderedTodayIds.indexOf(targetTaskId);
    if (index < 0 || target < 0) return;
    const next = [...orderedTodayIds];
    [next[index], next[target]] = [next[target], next[index]];
    const operationId = await controller.reorderToday(next);
    notify(
      "Today 顺序已更新",
      "success",
      operationId
        ? { label: "撤销", run: () => void controller.undo(operationId) }
        : undefined,
    );
  };
  const askToReplan = () =>
    onAskAgent(
      `请分析我当前“${routeTitles[route]}”中的 ${controller.tasks.filter((task) => task.status === "open").length} 项未完成任务，结合优先级和截止时间给出可执行的重新规划；先展示方案，未经我确认不要批量修改。`,
    );
  return (
    <main className="content-column">
      <div className="page-heading">
        <div>
          <h1>
            {route === "today"
              ? `${greeting}，今天有 ${controller.tasks.filter((task) => task.status === "open").length} 件事`
              : routeTitles[route]}
          </h1>
          <p>
            {route === "today"
              ? dateLabel
              : search
                ? `“${search}”的搜索结果`
                : "你的任务保持本地优先"}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className={`soft-button bulk-mode-toggle ${bulkMode ? "active" : ""}`}
            aria-pressed={bulkMode}
            onClick={toggleBulkMode}
          >
            <ListChecks size={16} />
            {bulkMode ? "退出选择" : "批量选择"}
          </button>
          {route === "inbox" && inboxTriageTasks.length > 0 && (
            <button
              type="button"
              className="soft-button"
              onClick={() => setInboxTriageOpen(true)}
            >
              <Inbox size={16} />
              整理暂存
            </button>
          )}
          <button
            type="button"
            className="soft-button"
            onClick={route === "today" ? onPlanToday : askToReplan}
          >
            {route === "today" ? (
              <CalendarDays size={16} />
            ) : (
              <WandSparkles size={16} />
            )}
            {route === "today" ? "帮我选今天" : "重新规划"}
          </button>
          <div className="filter-anchor">
            <button
            type="button"
              className={`icon-button ${priorityFilter !== "all" || projectFilter !== "all" || tagFilter !== "all" || contextFilter !== "all" || dateFilter !== "any" || sortFilter !== "manual" ? "active" : ""}`}
              aria-label="筛选"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((value) => !value)}
            >
              <Filter size={17} />
            </button>
            {filterOpen && (
              <div
                className="filter-popover"
                role="dialog"
                aria-label="任务筛选"
              >
                <strong>按优先级筛选</strong>
                <div className="filter-assist">
                  <label htmlFor="smart-view-query">一句话筛选</label>
                  <div className="filter-assist-row">
                    <input
                      id="smart-view-query"
                      className="settings-input"
                      value={smartViewQuery}
                      onChange={(event) => {
                        setSmartViewQuery(event.target.value);
                        setSmartViewQueryResult(undefined);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          parseSmartViewQueryForPreview();
                        }
                      }}
                      placeholder="例如：本周高优先级的飞书任务"
                      maxLength={120}
                      aria-describedby="smart-view-query-hint"
                    />
                    <button
                      type="button"
                      className="soft-button"
                      disabled={!smartViewQuery.trim()}
                      onClick={parseSmartViewQueryForPreview}
                    >
                      解析
                    </button>
                  </div>
                  <small id="smart-view-query-hint">
                    只生成筛选预览，不修改任务；支持日期、优先级、来源、项目、标签和情境。
                  </small>
                  {smartViewQueryResult?.kind === "suggestion" && (
                    <div className="filter-assist-preview" role="status">
                      <span>
                        将筛选：{smartViewQueryResult.value.summary.join(" · ")}
                      </span>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={applySmartViewQuery}
                      >
                        套用
                      </button>
                    </div>
                  )}
                  {smartViewQueryResult?.kind === "error" && (
                    <p className="filter-assist-error" role="alert">
                      {smartViewQueryResult.value.message}
                    </p>
                  )}
                </div>
                <div className="filter-options">
                  {(
                    ["all", "urgent", "high", "medium", "low", "none"] as const
                  ).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={priorityFilter === value ? "active" : ""}
                      onClick={() => {
                        setPriorityFilter(value);
                        setActiveSmartViewId(undefined);
                      }}
                    >
                      {value === "all" ? "全部" : priorityLabels[value]}
                    </button>
                  ))}
                </div>
                <label className="filter-select-label">
                  项目
                  <select
                    className="field-select"
                    value={projectFilter}
                    onChange={(event) => {
                      setProjectFilter(event.target.value);
                      setActiveSmartViewId(undefined);
                    }}
                  >
                    <option value="all">全部项目</option>
                    {projectOptions.map((project) => (
                      <option key={project} value={project}>
                        {project}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter-select-label">
                  标签
                  <select
                    className="field-select"
                    value={tagFilter}
                    onChange={(event) => {
                      setTagFilter(event.target.value);
                      setActiveSmartViewId(undefined);
                    }}
                  >
                    <option value="all">全部标签</option>
                    {tagOptions.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter-select-label">
                  情境
                  <select
                    className="field-select"
                    value={contextFilter}
                    onChange={(event) => {
                      setContextFilter(event.target.value);
                      setActiveSmartViewId(undefined);
                    }}
                  >
                    <option value="all">全部情境</option>
                    {contextOptions.map((context) => (
                      <option key={context} value={context}>
                        {context}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter-select-label">
                  日期
                  <select
                    className="field-select"
                    value={dateFilter}
                    onChange={(event) => {
                      setDateFilter(event.target.value as SmartViewDateFilter);
                      setActiveSmartViewId(undefined);
                    }}
                  >
                    {(Object.keys(smartViewDateLabels) as SmartViewDateFilter[]).map((value) => (
                      <option key={value} value={value}>
                        {smartViewDateLabels[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter-select-label">
                  排序
                  <select
                    className="field-select"
                    value={sortFilter}
                    onChange={(event) => {
                      setSortFilter(event.target.value as SmartViewSort);
                      setActiveSmartViewId(undefined);
                    }}
                  >
                    {(Object.keys(smartViewSortLabels) as SmartViewSort[]).map((value) => (
                      <option key={value} value={value}>
                        {smartViewSortLabels[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="smart-view-save">
                  <label htmlFor="smart-view-name">保存当前筛选</label>
                  <div className="smart-view-save-row">
                    <input
                      id="smart-view-name"
                      className="settings-input"
                      value={smartViewName}
                      onChange={(event) => setSmartViewName(event.target.value)}
                      placeholder="例如：本周高优先级"
                      maxLength={60}
                    />
                    <button
                      type="button"
                      className="soft-button"
                      disabled={!smartViewName.trim()}
                      onClick={saveSmartView}
                    >
                      保存
                    </button>
                  </div>
                </div>
                {smartViews.length > 0 && (
                  <div className="smart-view-manage" aria-label="管理保存的视图">
                    {smartViews.map((view) => (
                      <div key={view.id} className="smart-view-row">
                        <button type="button" onClick={() => applySmartView(view)}>{view.name}</button>
                        <button
                          type="button"
                          className="row-icon-button"
                          aria-label={`删除视图${view.name}`}
                          onClick={() => removeSmartView(view.id)}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="filter-footer">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setPriorityFilter("all");
                      setProjectFilter("all");
                      setTagFilter("all");
                      setContextFilter("all");
                      setDateFilter("any");
                      setSortFilter("manual");
                      setActiveSmartViewId(undefined);
                    }}
                  >
                    清除
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => setFilterOpen(false)}
                  >
                    完成
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {smartViews.length > 0 && (
        <div className="saved-view-strip" aria-label="已保存视图">
          <span>已保存</span>
          {smartViews.map((view) => (
            <button
              type="button"
              key={view.id}
              className={activeSmartViewId === view.id ? "active" : ""}
              onClick={() => applySmartView(view)}
              title={`应用视图：${view.name}`}
            >
              {view.name}
            </button>
          ))}
        </div>
      )}
      {route === "today" && (
        <MorningBrief
          controller={controller}
          planningTasks={planningTasks}
          notify={notify}
          onPlanToday={onPlanToday}
        />
      )}
      {bulkMode && (
        <section className="bulk-toolbar" aria-label="批量操作">
          <div className="bulk-toolbar-heading">
            <div>
              <strong>批量处理</strong>
              <span>
                {selectedBulkTasks.length > 0
                  ? `已选择 ${selectedBulkTasks.length} 项`
                  : "选择任务后预览一次性操作"}
              </span>
            </div>
            <div className="bulk-toolbar-selection-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={selectAllVisible}
                disabled={bulkBusy || visibleTasks.length === 0}
              >
                全选当前列表
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setBulkSelection(new Set())}
                disabled={bulkBusy || selectedBulkTasks.length === 0}
              >
                清除选择
              </button>
              <button
                type="button"
                className="ghost-button task-agent-bulk-button"
                onClick={() =>
                  onAskAgent(buildBulkTaskAgentPrompt(selectedBulkTasks))
                }
                disabled={bulkBusy || selectedBulkTasks.length === 0}
                title="先让 Agent 查看所选任务并给出方案"
              >
                <MessageCircle size={14} aria-hidden="true" />
                让 Agent 处理所选
              </button>
            </div>
          </div>
          <div className="bulk-action-buttons">
            {allSelectedCanComplete && (
              <button
                type="button"
                className="primary-button"
                disabled={bulkBusy}
                onClick={() => requestBulkPreview({ kind: "complete" })}
              >
                <Check size={15} /> 完成
              </button>
            )}
            {allSelectedAreCompleted && (
              <button
                type="button"
                className="soft-button"
                disabled={bulkBusy}
                onClick={() => requestBulkPreview({ kind: "reopen" })}
              >
                <RotateCcw size={15} /> 恢复
              </button>
            )}
            {allSelectedCanMoveToToday && (
              <button
                type="button"
                className="soft-button"
                disabled={bulkBusy}
                onClick={() =>
                  requestBulkPreview({ kind: "move-to-today", date: dateKey() })
                }
              >
                <CalendarDays size={15} /> 安排到今天
              </button>
            )}
            {allSelectedCanTrash && route !== "trash" && (
              <button
                type="button"
                className="ghost-button danger-button"
                disabled={bulkBusy}
                onClick={() => requestBulkPreview({ kind: "trash" })}
              >
                <Trash2 size={15} /> 移入回收站
              </button>
            )}
            {allSelectedCanRestore && route === "trash" && (
              <button
                type="button"
                className="soft-button"
                disabled={bulkBusy}
                onClick={() => requestBulkPreview({ kind: "restore" })}
              >
                <RotateCcw size={15} /> 恢复任务
              </button>
            )}
          </div>
          {bulkPreview && (
            <div className="bulk-preview" role="dialog" aria-label="批量操作预览">
              <div>
                <strong>
                  将对 {selectedBulkTasks.length} 项任务执行“{bulkActionLabel(bulkPreview)}”
                </strong>
                <p>
                  这会作为一次操作保存，可整体撤销。目标：{" "}
                  {selectedBulkTasks
                    .slice(0, 3)
                    .map((task) => task.title)
                    .join("、")}
                  {selectedBulkTasks.length > 3
                    ? ` 等 ${selectedBulkTasks.length} 项`
                    : ""}
                </p>
                {bulkPreview.kind === "trash" && (
                  <small>飞书任务会进入本地同步队列，远端删除仍以同步结果为准。</small>
                )}
              </div>
              <div className="bulk-preview-actions">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={bulkBusy}
                  onClick={() => setBulkPreview(undefined)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={bulkPreview.kind === "trash" ? "danger-button" : "primary-button"}
                  disabled={bulkBusy}
                  onClick={() => void runBulkAction()}
                >
                  {bulkBusy ? "正在处理…" : "确认执行"}
                </button>
              </div>
            </div>
          )}
          {selectedBulkTasks.length > 0 &&
            !allSelectedCanComplete &&
            !allSelectedAreCompleted &&
            !allSelectedCanMoveToToday &&
            !allSelectedCanTrash &&
            !allSelectedCanRestore && (
              <p className="bulk-toolbar-hint">
                当前选择包含不同状态或只读任务，请调整选择后再操作。
              </p>
            )}
        </section>
      )}
      {controller.loading ? (
        <div className="empty-state">
          <div>
            <RefreshCw size={28} />
            <p>正在读取任务…</p>
          </div>
        </div>
      ) : controller.error ? (
        <div className="empty-state">
          <div>
            <AlertTriangle size={32} />
            <h2>暂时无法读取任务</h2>
            <p>{controller.error}</p>
            <button
              type="button"
              className="soft-button"
              onClick={() => void controller.refresh()}
            >
              重试
            </button>
          </div>
        </div>
      ) : visibleSections.length === 0 ? (
        <div className="empty-state">
          <div>
            <span className="feature-icon">
              <ClipboardCheck size={24} />
            </span>
            <h2>
              {search
                ? `没有匹配“${search}”的任务`
                : priorityFilter !== "all" || projectFilter !== "all" || tagFilter !== "all" || contextFilter !== "all" || dateFilter !== "any" || sortFilter !== "manual"
                  ? "没有符合筛选的任务"
                  : route === "completed"
                    ? "还没有已完成任务"
                    : route === "inbox"
                      ? "暂存为空"
                      : "这里很清爽"}
            </h2>
            <p>
              {search
                ? "试试其他关键词，或清除搜索后查看这个列表中的全部任务。"
                : priorityFilter !== "all" || projectFilter !== "all" || tagFilter !== "all" || contextFilter !== "all" || dateFilter !== "any" || sortFilter !== "manual"
                  ? "调整或清除当前筛选后再看看。"
                  : route === "trash"
                    ? "删除的任务会先保留在这里。"
                    : route === "inbox"
                      ? "这里放尚未安排日期、项目或清单的任务；稍后再决定怎么处理。"
                      : "记录一件下一步要做的小事。"}
            </p>
            {search || priorityFilter !== "all" || projectFilter !== "all" || tagFilter !== "all" || contextFilter !== "all" || dateFilter !== "any" || sortFilter !== "manual" ? (
              <button
                type="button"
                className="soft-button"
                onClick={() => {
                  onClearSearch();
                  setPriorityFilter("all");
                  setProjectFilter("all");
                  setTagFilter("all");
                  setContextFilter("all");
                  setDateFilter("any");
                  setActiveSmartViewId(undefined);
                }}
              >
                {search && (priorityFilter !== "all" || projectFilter !== "all" || tagFilter !== "all" || contextFilter !== "all" || dateFilter !== "any" || sortFilter !== "manual")
                  ? "清除搜索和筛选"
                  : search
                    ? "清除搜索"
                    : "清除筛选"}
              </button>
            ) : (
              route !== "trash" && (
                <button
                  type="button"
                  className="primary-button"
                  onClick={onNew}
                >
                  <Plus size={17} />
                  新建任务
                </button>
              )
            )}
          </div>
        </div>
      ) : (
        visibleSections.map((section) => (
          <section key={section.id}>
            <div className="list-toolbar">
              <span>{sectionTitles[section.id]}</span>
              <span className="list-count">{section.tasks.length}</span>
            </div>
            <div className="task-list">
              {section.tasks.map((task, sectionIndex) => {
                const canReorder =
                  route === "today" &&
                  priorityFilter === "all" &&
                  projectFilter === "all" &&
                  tagFilter === "all" &&
                  contextFilter === "all" &&
                  dateFilter === "any" &&
                  sortFilter === "manual";
                return (
                  <TaskRow
                    key={task.id}
                    task={task}
                    selected={controller.selectedId === task.id}
                    controller={controller}
                    notify={notify}
                    selectionMode={bulkMode}
                    selectedForBulk={bulkSelection.has(task.id)}
                    onToggleBulk={() => toggleBulkSelection(task.id)}
                    interactionDisabled={bulkBusy}
                    subtaskProgress={subtaskProgress.get(task.id)}
                    onAskAgent={onAskAgent}
                    moveUp={
                      canReorder && sectionIndex > 0
                        ? () =>
                            void moveTodayTask(
                              task.id,
                              section.tasks[sectionIndex - 1].id,
                            )
                        : undefined
                    }
                    moveDown={
                      canReorder && sectionIndex < section.tasks.length - 1
                        ? () =>
                            void moveTodayTask(
                              task.id,
                              section.tasks[sectionIndex + 1].id,
                            )
                        : undefined
                    }
                  />
                );
              })}
            </div>
          </section>
        ))
      )}
      {inboxTriageOpen && route === "inbox" && (
        <InboxTriageSheet
          tasks={controller.tasks}
          onUpdate={controller.update}
          onComplete={controller.toggleComplete}
          onOpenTask={(taskId) => controller.select(taskId)}
          onClose={() => setInboxTriageOpen(false)}
        />
      )}
    </main>
  );
}

function TaskInspector({
  task,
  controller,
  projects = [],
  lists = [],
  notify,
  onAskAgent,
  onClose,
}: {
  task?: Task;
  controller: TaskController;
  projects?: TaskProject[];
  lists?: TaskList[];
  notify: (message: string, kind?: ToastKind) => void;
  onAskAgent: (prompt: string) => void;
  onClose?: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [projectId, setProjectId] = useState(projectLabel(task?.projectId, projects));
  const [listId, setListId] = useState(listLabel(task?.listId, lists));
  const [tagsText, setTagsText] = useState(task?.tags.join(", ") ?? "");
  const [contextsText, setContextsText] = useState(
    task?.contexts?.join(", ") ?? "",
  );
  const [startAtInput, setStartAtInput] = useState(
    toLocalDateTimeInput(task?.startAt),
  );
  const [dueAtInput, setDueAtInput] = useState(
    toLocalDateTimeInput(task?.dueAt),
  );
  const [startAtAllDay, setStartAtAllDay] = useState(
    task?.startAtIsAllDay === true,
  );
  const [dueAtAllDay, setDueAtAllDay] = useState(
    task?.dueAtIsAllDay === true,
  );
  const [plannedDateInput, setPlannedDateInput] = useState(
    task?.plannedDate ?? "",
  );
  const [localReminderInput, setLocalReminderInput] = useState(
    toLocalDateTimeInput(
      task?.reminders.find((reminder) => reminder.source === "local")?.at,
    ),
  );
  const [linkUrlInput, setLinkUrlInput] = useState("");
  const [linkLabelInput, setLinkLabelInput] = useState("");
  const [researchTitleInput, setResearchTitleInput] = useState("");
  const [researchUrlInput, setResearchUrlInput] = useState("");
  const [researchSummaryInput, setResearchSummaryInput] = useState("");
  const [researchActionsInput, setResearchActionsInput] = useState("");
  const [customFieldKey, setCustomFieldKey] = useState("");
  const [customFieldValue, setCustomFieldValue] = useState("");
  const [customFieldType, setCustomFieldType] = useState<CustomFieldType>("text");
  const [attachmentName, setAttachmentName] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<TaskAttachmentPreview>();
  const [attachmentPreviewSource, setAttachmentPreviewSource] = useState<TaskAttachment>();
  const [previewBusyId, setPreviewBusyId] = useState<string>();
  const [taskHistory, setTaskHistory] = useState<TaskHistoryEntry[]>([]);
  const [taskHistoryLoading, setTaskHistoryLoading] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string>();
  const [editingCommentBody, setEditingCommentBody] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const editingTaskIdRef = useRef<string | undefined>(undefined);
  // A native input can emit a second blur save before the first IPC reply.
  // Per-field revisions stop the older completion from clearing a newer
  // local draft or letting a refreshed task prop overwrite it.
  const dirtyFieldsRef = useRef(new Set<TaskEditorDirtyField>());
  const dirtyRevisionsRef = useRef<
    Partial<Record<TaskEditorDirtyField, number>>
  >({});
  const markDirty = (field: TaskEditorDirtyField): number => {
    dirtyFieldsRef.current.add(field);
    const revision = (dirtyRevisionsRef.current[field] ?? 0) + 1;
    dirtyRevisionsRef.current[field] = revision;
    return revision;
  };
  const currentDirtyRevision = (field: TaskEditorDirtyField): number =>
    dirtyRevisionsRef.current[field] ?? 0;
  const clearDirtyIfCurrent = (
    field: TaskEditorDirtyField,
    revision: number,
  ): void => {
    if (dirtyRevisionsRef.current[field] === revision)
      dirtyFieldsRef.current.delete(field);
  };
  const [showActions, setShowActions] = useState(false);
  const [relatedTasks, setRelatedTasks] = useState<Task[]>([]);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [pendingPatch, setPendingPatch] =
    useState<Parameters<TaskController["update"]>[1]>();
  const [timeBlockStart, setTimeBlockStart] = useState(
    toLocalDateTimeInput(task?.timeBlock?.startAt),
  );
  const [timeBlockEnd, setTimeBlockEnd] = useState(
    toLocalDateTimeInput(task?.timeBlock?.endAt),
  );
  useEffect(() => {
    let active = true;
    const taskChanged = editingTaskIdRef.current !== task?.id;
    if (!taskChanged && task) {
      if (!dirtyFieldsRef.current.has("title")) setTitle(task.title);
      if (!dirtyFieldsRef.current.has("notes")) setNotes(task.notes);
      if (!dirtyFieldsRef.current.has("projectId"))
        setProjectId(projectLabel(task.projectId, projects));
      if (!dirtyFieldsRef.current.has("listId"))
        setListId(listLabel(task.listId, lists));
      if (!dirtyFieldsRef.current.has("tags"))
        setTagsText(task.tags.join(", "));
      if (!dirtyFieldsRef.current.has("contexts"))
        setContextsText((task.contexts ?? []).join(", "));
      if (!dirtyFieldsRef.current.has("startAt"))
        setStartAtInput(toLocalDateTimeInput(task.startAt));
      if (!dirtyFieldsRef.current.has("startAtAllDay"))
        setStartAtAllDay(task.startAtIsAllDay === true);
      if (!dirtyFieldsRef.current.has("dueAt"))
        setDueAtInput(toLocalDateTimeInput(task.dueAt));
      if (!dirtyFieldsRef.current.has("dueAtAllDay"))
        setDueAtAllDay(task.dueAtIsAllDay === true);
      if (!dirtyFieldsRef.current.has("plannedDate"))
        setPlannedDateInput(task.plannedDate ?? "");
      if (!dirtyFieldsRef.current.has("localReminder"))
        setLocalReminderInput(
          toLocalDateTimeInput(
            task.reminders.find((reminder) => reminder.source === "local")?.at,
          ),
        );
    }
    if (!taskChanged || !task || !window.desktopApi)
      return () => {
        active = false;
      };
    editingTaskIdRef.current = task.id;
    dirtyFieldsRef.current.clear();
    dirtyRevisionsRef.current = {};
    setTitle(task.title);
    setNotes(task.notes);
    setProjectId(projectLabel(task.projectId, projects));
    setListId(listLabel(task.listId, lists));
    setTagsText(task.tags.join(", "));
    setContextsText((task.contexts ?? []).join(", "));
    setStartAtInput(toLocalDateTimeInput(task.startAt));
    setStartAtAllDay(task.startAtIsAllDay === true);
    setDueAtInput(toLocalDateTimeInput(task.dueAt));
    setDueAtAllDay(task.dueAtIsAllDay === true);
    setPlannedDateInput(task.plannedDate ?? "");
    setLocalReminderInput(
      toLocalDateTimeInput(
        task.reminders.find((reminder) => reminder.source === "local")?.at,
      ),
    );
    setShowActions(false);
    setPendingPatch(undefined);
    setSubtaskTitle("");
    setLinkUrlInput("");
    setLinkLabelInput("");
    setResearchTitleInput("");
    setResearchUrlInput("");
    setResearchSummaryInput("");
    setResearchActionsInput("");
    setCustomFieldKey("");
    setCustomFieldValue("");
    setCustomFieldType("text");
    setAttachmentName("");
    setAttachmentUrl("");
    setAttachmentPreview(undefined);
    setAttachmentPreviewSource(undefined);
    setPreviewBusyId(undefined);
    setTaskHistory([]);
    setTaskHistoryLoading(false);
    setCommentBody("");
    setEditingCommentId(undefined);
    setEditingCommentBody("");
    setCommentBusy(false);
    setTimeBlockStart(toLocalDateTimeInput(task.timeBlock?.startAt));
    setTimeBlockEnd(toLocalDateTimeInput(task.timeBlock?.endAt));
    void window.desktopApi.tasks
      .getDraft(`task-editor:${task.id}`)
      .then((draft) => {
        if (
          !active ||
          !draft ||
          new Date(draft.updatedAt) <= new Date(task.updatedAt)
        )
          return;
        markDirty("title");
        setTitle(draft.text || task.title);
        const data = draft.data as { notes?: unknown } | undefined;
        if (typeof data?.notes === "string") {
          markDirty("notes");
          setNotes(data.notes);
        }
        notify("已恢复上次未保存的编辑草稿");
      });
    return () => {
      active = false;
    };
  }, [
    notify,
    task?.dueAt,
    task?.id,
    task?.notes,
    task?.plannedDate,
    task?.projectId,
    task?.listId,
    task?.reminders,
    task?.startAt,
    task?.startAtIsAllDay,
    task?.tags,
    task?.title,
    task?.updatedAt,
    task?.dueAtIsAllDay,
    projects,
    lists,
  ]);
  useEffect(() => {
    let active = true;
    const historyApi = window.desktopApi?.tasks.history;
    if (!task || !historyApi) {
      setTaskHistory([]);
      setTaskHistoryLoading(false);
      return () => {
        active = false;
      };
    }
    setTaskHistoryLoading(true);
    void historyApi(task.id, 50)
      .then((entries) => {
        if (active) setTaskHistory(entries);
      })
      .catch(() => {
        // History is an enhancement over the task itself. A failed optional
        // read must not make editing or Feishu synchronization look broken.
        if (active) setTaskHistory([]);
      })
      .finally(() => {
        if (active) setTaskHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [task?.id, task?.updatedAt]);
  useEffect(() => {
    if (
      !task ||
      !window.desktopApi ||
      (title === task.title && notes === task.notes)
    )
      return undefined;
    const timer = window.setTimeout(() => {
      void window.desktopApi?.tasks.saveDraft({
        id: `task-editor:${task.id}`,
        kind: "task-editor",
        taskId: task.id,
        text: title,
        data: { notes },
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [notes, task, title]);
  useEffect(() => {
    let active = true;
    if (!task) {
      setRelatedTasks([]);
      return () => {
        active = false;
      };
    }
    if (window.desktopApi) {
      void window.desktopApi.tasks
        .list({ includeDeleted: false })
        .then((items) => {
          if (active) setRelatedTasks(items);
        });
    } else {
      setRelatedTasks(controller.tasks);
    }
    return () => {
      active = false;
    };
  }, [controller.tasks, task?.id]);
  if (!task)
    return (
      <aside className="inspector inspector-empty" aria-label="任务详情">
        <div className="empty-state">
          <div>
            <Info size={26} />
            <p>选择一项任务查看详情</p>
          </div>
        </div>
      </aside>
    );
  const subtasks = relatedTasks.filter(
    (candidate) => candidate.parentId === task.id && !candidate.deletedAt,
  );
  const completedSubtasks = subtasks.filter(
    (candidate) => candidate.status === "completed",
  ).length;
  const remoteReadOnly =
    task.source.type === "feishu" &&
    (task.currentUserRole === "follower" ||
      task.currentUserRole === "viewer" ||
      ["read-only", "permission-denied"].includes(task.sync.status));
  const canEditSharedFields = !remoteReadOnly;
  const canToggleCompletion = canToggleTaskCompletion(task);
  const completionVerb = needsFeishuForCosignCompletion(task)
    ? "请在飞书完成"
    : "标记完成";
  const applySave = async (
    patch: Parameters<TaskController["update"]>[1],
    recurrenceScope?: RecurrenceEditScope,
  ): Promise<boolean> => {
    try {
      await controller.update(task.id, patch, recurrenceScope);
      await window.desktopApi?.tasks.deleteDraft(`task-editor:${task.id}`);
      notify(
        recurrenceScope && recurrenceScope !== "this"
          ? "循环系列已更新"
          : "更改已保存",
        "success",
      );
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "保存失败", "error");
      return false;
    }
  };
  const saveComments = async (next: TaskComment[]): Promise<boolean> => {
    if (next.length > 100) {
      notify("一项任务最多保留 100 条讨论", "error");
      return false;
    }
    setCommentBusy(true);
    try {
      return await applySave({ comments: next });
    } finally {
      setCommentBusy(false);
    }
  };
  const addTaskComment = async (): Promise<void> => {
    const body = commentBody.trim();
    if (!body) return;
    if (body.length > 10_000) {
      notify("讨论内容不能超过 10000 个字符", "error");
      return;
    }
    const now = new Date().toISOString();
    const saved = await saveComments([
      ...(task.comments ?? []),
      {
        id: crypto.randomUUID(),
        body,
        author: "user",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    if (saved) {
      setCommentBody("");
      notify("讨论已保存到本机", "success");
    }
  };
  const beginCommentEdit = (comment: TaskComment): void => {
    setEditingCommentId(comment.id);
    setEditingCommentBody(comment.body);
  };
  const commitCommentEdit = async (): Promise<void> => {
    if (!editingCommentId) return;
    const body = editingCommentBody.trim();
    if (!body) {
      notify("讨论内容不能为空", "error");
      return;
    }
    if (body.length > 10_000) {
      notify("讨论内容不能超过 10000 个字符", "error");
      return;
    }
    const now = new Date().toISOString();
    const next = (task.comments ?? []).map((comment) =>
      comment.id === editingCommentId
        ? { ...comment, body, updatedAt: now }
        : comment,
    );
    const saved = await saveComments(next);
    if (saved) {
      setEditingCommentId(undefined);
      setEditingCommentBody("");
      notify("讨论已更新", "success");
    }
  };
  const removeTaskComment = async (commentId: string): Promise<void> => {
    const saved = await saveComments(
      (task.comments ?? []).filter((comment) => comment.id !== commentId),
    );
    if (saved) {
      if (editingCommentId === commentId) {
        setEditingCommentId(undefined);
        setEditingCommentBody("");
      }
      notify("讨论已移除，可通过撤销恢复", "success");
    }
  };
  const save = async (
    patch: Parameters<TaskController["update"]>[1],
  ): Promise<boolean> => {
    if (task.recurrenceSeriesId && task.recurrence) {
      setPendingPatch(patch);
      return false;
    }
    return applySave(patch);
  };
  const commitPlannedDate = async (value = plannedDateInput): Promise<void> => {
    if (!dirtyFieldsRef.current.has("plannedDate")) return;
    const revision = currentDirtyRevision("plannedDate");
    // Do not compare only with `task.plannedDate`: that prop can still carry
    // the original value while an earlier blur save is in flight. Saving the
    // explicit final value is a harmless no-op in the ordinary case and
    // guarantees “change → change back” persists the user's last choice.
    const saved = await save({ plannedDate: value || null });
    if (saved) clearDirtyIfCurrent("plannedDate", revision);
  };
  const commitTemporalFields = async (
    values: Partial<{ startAtInput: string; dueAtInput: string }> = {},
  ): Promise<void> => {
    const nextStartAtInput = allDayDateTimeInput(
      values.startAtInput ?? startAtInput,
      startAtAllDay,
    );
    const nextDueAtInput = allDayDateTimeInput(
      values.dueAtInput ?? dueAtInput,
      dueAtAllDay,
    );
    const startAt = localDateTimeInputToIso(nextStartAtInput);
    const dueAt = localDateTimeInputToIso(nextDueAtInput);
    if ((nextStartAtInput && !startAt) || (nextDueAtInput && !dueAt)) {
      notify("请输入有效的开始和截止时间", "error");
      return;
    }
    if (startAt && dueAt && new Date(dueAt) < new Date(startAt)) {
      notify("截止时间不能早于开始时间", "error");
      return;
    }
    const patch: Parameters<TaskController["update"]>[1] = {};
    if (dirtyFieldsRef.current.has("startAt")) {
      patch.startAt = startAt ?? null;
      if (startAt && startAtAllDay) patch.startAtIsAllDay = true;
    }
    if (dirtyFieldsRef.current.has("dueAt")) {
      patch.dueAt = dueAt ?? null;
      if (dueAt && dueAtAllDay) patch.dueAtIsAllDay = true;
    }
    if (!Object.keys(patch).length) return;
    const startAtRevision = currentDirtyRevision("startAt");
    const dueAtRevision = currentDirtyRevision("dueAt");
    const saved = await save(patch);
    if (saved) {
      if ("startAt" in patch)
        clearDirtyIfCurrent("startAt", startAtRevision);
      if ("dueAt" in patch) clearDirtyIfCurrent("dueAt", dueAtRevision);
    }
  };
  const setAllDay = async (
    field: "startAt" | "dueAt",
    enabled: boolean,
  ): Promise<void> => {
    const current = field === "startAt" ? startAtInput : dueAtInput;
    if (!current) {
      notify(enabled ? "请先设置日期，再标记为全天" : "没有可修改的日期", "error");
      return;
    }
    const nextInput = `${allDayDateInput(current)}T00:00`;
    if (field === "startAt") {
      markDirty("startAtAllDay");
      if (enabled) markDirty("startAt");
      setStartAtAllDay(enabled);
      setStartAtInput(nextInput);
    } else {
      markDirty("dueAtAllDay");
      if (enabled) markDirty("dueAt");
      setDueAtAllDay(enabled);
      setDueAtInput(nextInput);
    }
    const allDayField = field === "startAt" ? "startAtAllDay" : "dueAtAllDay";
    const temporalField = field;
    const allDayRevision = currentDirtyRevision(allDayField);
    const temporalRevision = currentDirtyRevision(temporalField);
    const time = localDateTimeInputToIso(nextInput);
    if (!time) {
      notify("请输入有效日期", "error");
      return;
    }
    const saved = await save(
      field === "startAt"
        ? {
            ...(enabled ? { startAt: time, startAtIsAllDay: true } : { startAtIsAllDay: null }),
          }
        : {
            ...(enabled ? { dueAt: time, dueAtIsAllDay: true } : { dueAtIsAllDay: null }),
          },
    );
    if (!saved) {
      if (field === "startAt") {
        clearDirtyIfCurrent("startAtAllDay", allDayRevision);
        if (enabled) clearDirtyIfCurrent("startAt", temporalRevision);
        setStartAtInput(toLocalDateTimeInput(task.startAt));
        setStartAtAllDay(task.startAtIsAllDay === true);
      } else {
        clearDirtyIfCurrent("dueAtAllDay", allDayRevision);
        if (enabled) clearDirtyIfCurrent("dueAt", temporalRevision);
        setDueAtInput(toLocalDateTimeInput(task.dueAt));
        setDueAtAllDay(task.dueAtIsAllDay === true);
      }
    } else {
      clearDirtyIfCurrent(allDayField, allDayRevision);
      if (enabled) clearDirtyIfCurrent(temporalField, temporalRevision);
    }
  };
  const duplicateAsLocal = async () => {
    await controller.create({
      title: `${task.title}（副本）`,
      source: { type: "local" },
      notes: task.notes,
      privateNotes: task.privateNotes,
      priority: task.priority,
      tags: task.tags,
      contexts: task.contexts,
      plannedDate: task.plannedDate,
      startAt: task.startAt,
      dueAt: task.dueAt,
      estimatedMinutes: task.estimatedMinutes,
      comments: task.comments?.map((comment) => ({
        ...comment,
        id: crypto.randomUUID(),
      })),
    });
    setShowActions(false);
    notify("已创建本地副本", "success");
  };
  const openInFeishu = async () => {
    const guid = task.source.externalId;
    if (!guid || !window.desktopApi) {
      notify("这项任务还没有可打开的飞书标识", "error");
      return;
    }
    await window.desktopApi.shell.openExternal(
      `https://applink.feishu.cn/client/todo/detail?guid=${encodeURIComponent(guid)}`,
    );
  };
  const saveToPetDiary = async (): Promise<void> => {
    if (!window.desktopApi?.pet.createDiaryFromTask) {
      notify("当前环境暂不支持写入宠物日记", "error");
      return;
    }
    try {
      await window.desktopApi.pet.createDiaryFromTask(task.id);
      setShowActions(false);
      notify("已把这项任务写入宠物日记", "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "写入宠物日记失败", "error");
    }
  };
  const purge = async () => {
    if (
      !window.confirm(
        `永久删除“${task.title}”？此操作无法撤销，也不会删除飞书远端任务。${subtasks.length ? `它的 ${subtasks.length} 个子任务会保留为独立任务。` : ""}`,
      )
    )
      return;
    await controller.purge(task.id);
    notify("本地任务记录已永久删除", "success");
  };
  const trashTask = async () => {
    if (remoteReadOnly) {
      notify("当前飞书角色没有删除这项任务的权限", "error");
      return;
    }
    const impact = [
      task.source.type === "feishu"
        ? "会尝试删除飞书远端任务，并在离线时排队"
        : "会先移入本地回收站",
      subtasks.length
        ? `${subtasks.length} 个子任务会保留，不会跟随删除`
        : undefined,
    ]
      .filter(Boolean)
      .join("；");
    if (!window.confirm(`删除“${task.title}”？${impact}。确认继续？`)) return;
    await controller.trash(task.id);
    notify(
      task.source.type === "feishu" ? "删除请求已排队同步飞书" : "已移到回收站",
      "success",
    );
  };
  const addSubtask = async () => {
    const nextTitle = subtaskTitle.trim();
    if (!nextTitle) return;
    const parentId = task.id;
    await controller.create({
      title: nextTitle,
      source: { type: "local" },
      parentId,
      projectId: task.projectId,
      plannedDate: task.plannedDate,
      priority: task.priority,
    }, { selectCreated: false });
    setSubtaskTitle("");
    notify("本地子任务已创建", "success");
  };
  const addTaskLink = async (): Promise<void> => {
    const url = linkUrlInput.trim();
    if (!url) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      notify("请输入有效的链接地址", "error");
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      notify("链接只支持 http 或 https 地址", "error");
      return;
    }
    const link: TaskLink = {
      id: crypto.randomUUID(),
      url,
      ...(linkLabelInput.trim() ? { label: linkLabelInput.trim() } : {}),
    };
    const saved = await save({ links: [...task.links, link] });
    if (!saved) return;
    setLinkUrlInput("");
    setLinkLabelInput("");
  };
  const removeTaskLink = async (linkId: string): Promise<void> => {
    await save({ links: task.links.filter((link) => link.id !== linkId) });
  };
  const addResearchCard = async (): Promise<void> => {
    const title = researchTitleInput.trim();
    const summary = researchSummaryInput.trim();
    const actionItems = researchActionsInput
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!title) {
      notify("请先填写研究卡标题", "error");
      return;
    }
    if (title.length > 200 || summary.length > 5_000 || actionItems.some((item) => item.length > 500)) {
      notify("标题最多 200 字，摘要最多 5000 字，每条行动项最多 500 字", "error");
      return;
    }
    if (actionItems.length > 20) {
      notify("一张研究卡最多保留 20 条行动项", "error");
      return;
    }
    const rawUrl = researchUrlInput.trim();
    let url: string | undefined;
    if (rawUrl) {
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        notify("研究来源请输入有效的链接地址", "error");
        return;
      }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        notify("研究来源只支持不带账号密码的 http 或 https 地址", "error");
        return;
      }
      if (rawUrl.length > 2_000) {
        notify("研究来源链接不能超过 2000 个字符", "error");
        return;
      }
      url = rawUrl;
    }
    if ((task.researchCards ?? []).length >= 20) {
      notify("一项任务最多保留 20 张研究卡", "error");
      return;
    }
    const card: TaskResearchCard = {
      id: crypto.randomUUID(),
      title,
      ...(url === undefined ? {} : { url }),
      summary,
      actionItems,
      capturedAt: new Date().toISOString(),
    };
    const saved = await save({ researchCards: [...(task.researchCards ?? []), card] });
    if (!saved) return;
    setResearchTitleInput("");
    setResearchUrlInput("");
    setResearchSummaryInput("");
    setResearchActionsInput("");
    notify("研究卡已保存到本机", "success");
  };
  const removeResearchCard = async (cardId: string): Promise<void> => {
    const saved = await save({
      researchCards: (task.researchCards ?? []).filter((card) => card.id !== cardId),
    });
    if (saved) notify("研究卡已移除，可通过撤销恢复", "success");
  };
  const customFieldValueLabel = (value: JsonValue): string => {
    if (typeof value === "boolean") return value ? "已勾选" : "未勾选";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const addCustomField = async (): Promise<void> => {
    const key = customFieldKey.trim();
    const rawValue = customFieldValue.trim();
    if (!key || (!rawValue && customFieldType !== "checkbox")) {
      notify("请同时填写字段名称和值", "error");
      return;
    }
    if (key.length > 40 || rawValue.length > 500) {
      notify("字段名称最多 40 字，字段值最多 500 字", "error");
      return;
    }
    let value: JsonValue;
    if (customFieldType === "number") {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) {
        notify("数字字段请输入有效数字", "error");
        return;
      }
      value = parsed;
    } else if (customFieldType === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(rawValue)) {
        notify("日期字段请输入有效日期", "error");
        return;
      }
      const parsed = new Date(`${rawValue}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== rawValue) {
        notify("日期字段请输入有效日期", "error");
        return;
      }
      value = rawValue;
    } else if (customFieldType === "url") {
      let parsed: URL;
      try {
        parsed = new URL(rawValue);
      } catch {
        notify("链接字段请输入有效地址", "error");
        return;
      }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        notify("链接字段只支持 http 或 https 地址", "error");
        return;
      }
      value = rawValue;
    } else if (customFieldType === "checkbox") {
      value = rawValue === "true";
    } else {
      value = rawValue;
    }
    const saved = await save({
      customFields: { ...task.customFields, [key]: value },
    });
    if (saved) {
      setCustomFieldKey("");
      setCustomFieldValue("");
      setCustomFieldType("text");
    }
  };
  const removeCustomField = async (key: string): Promise<void> => {
    const next = { ...task.customFields };
    delete next[key];
    await save({ customFields: next });
  };
  const addTaskAttachment = async (): Promise<void> => {
    const url = attachmentUrl.trim();
    if (!url) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      notify("请输入有效的附件地址", "error");
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      notify("附件只支持 http 或 https 地址", "error");
      return;
    }
    const lastPathSegment = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "附件";
    let fallbackName = lastPathSegment;
    try {
      fallbackName = decodeURIComponent(lastPathSegment);
    } catch {
      // Keep the encoded segment as a safe display name for malformed URLs.
    }
    const name = (attachmentName.trim() || fallbackName || "附件").slice(0, 120);
    const attachment: TaskAttachment = {
      id: crypto.randomUUID(),
      name,
      url,
    };
    const saved = await save({ attachments: [...task.attachments, attachment] });
    if (saved) {
      setAttachmentName("");
      setAttachmentUrl("");
    }
  };
  const chooseTaskAttachments = async (): Promise<void> => {
    const api = window.desktopApi?.tasks;
    if (!api?.chooseAttachments) {
      notify("当前环境不支持本地附件选择", "error");
      return;
    }
    setAttachmentBusy(true);
    try {
      const picked = await api.chooseAttachments();
      if (picked.length === 0) return;
      const saved = await save({ attachments: [...task.attachments, ...picked] });
      if (!saved) {
        await Promise.all(
          picked
            .filter((attachment) => attachment.localPath)
            .map((attachment) => api.deleteAttachment(attachment)),
        );
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "添加本地附件失败", "error");
    } finally {
      setAttachmentBusy(false);
    }
  };
  const openTaskAttachment = async (attachment: TaskAttachment): Promise<void> => {
    try {
      if (attachment.localPath) {
        await window.desktopApi?.tasks.openAttachment(attachment);
      } else if (attachment.url) {
        await window.desktopApi?.shell.openExternal(attachment.url);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法打开附件", "error");
    }
  };
  const previewTaskAttachment = async (attachment: TaskAttachment): Promise<void> => {
    if (!attachment.localPath || !window.desktopApi?.tasks.previewAttachment) return;
    setPreviewBusyId(attachment.id);
    try {
      setAttachmentPreview(await window.desktopApi.tasks.previewAttachment(attachment));
      setAttachmentPreviewSource(attachment);
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法预览附件", "error");
    } finally {
      setPreviewBusyId(undefined);
    }
  };
  const removeTaskAttachment = async (attachmentId: string): Promise<void> => {
    const removed = task.attachments.find((attachment) => attachment.id === attachmentId);
    const saved = await save({ attachments: task.attachments.filter((attachment) => attachment.id !== attachmentId) });
    if (saved && removed?.localPath && window.desktopApi?.tasks.deleteAttachment) {
      try {
        await window.desktopApi.tasks.deleteAttachment(removed);
      } catch (error) {
        notify(error instanceof Error ? error.message : "附件已移除，但本地文件清理失败", "error");
      }
    }
  };
  const localReminder = task.reminders.find(
    (reminder) => reminder.source === "local",
  );
  const commitLocalReminder = async (
    value = localReminderInput,
  ): Promise<void> => {
    if (!dirtyFieldsRef.current.has("localReminder")) return;
    const revision = currentDirtyRevision("localReminder");
    const reminderAt = localDateTimeInputToIso(value);
    if (value && !reminderAt) {
      notify("请输入有效的本地提醒时间", "error");
      return;
    }
    const retained = task.reminders.filter(
      (reminder) => reminder.source !== "local",
    );
    const saved = await save({
      reminders: value
        ? [
            ...retained,
            {
              id: localReminder?.id ?? crypto.randomUUID(),
              at: reminderAt!,
              enabled: true,
              source: "local",
            },
        ]
        : retained,
    });
    if (saved) clearDirtyIfCurrent("localReminder", revision);
  };
  const saveTimeBlock = () => {
    if (!timeBlockStart && !timeBlockEnd) {
      void save({ timeBlock: null });
      return;
    }
    if (!timeBlockStart || !timeBlockEnd) return;
    const startAt = localDateTimeInputToIso(timeBlockStart);
    const endAt = localDateTimeInputToIso(timeBlockEnd);
    if (!startAt || !endAt) {
      notify("请输入有效的时间块开始和结束时间", "error");
      return;
    }
    if (new Date(endAt) <= new Date(startAt)) {
      notify("时间块结束时间必须晚于开始时间", "error");
      return;
    }
    void save({ timeBlock: { startAt, endAt } });
  };
  const setRecurrence = (
    frequency: "none" | "daily" | "weekly" | "monthly",
  ) => {
    if (frequency === "none") {
      void save({ recurrence: null });
      return;
    }
    const base = task.plannedDate
      ? new Date(`${task.plannedDate}T12:00:00`)
      : new Date();
    void save({
      recurrence: {
        frequency,
        interval:
          task.recurrence?.frequency === frequency
            ? task.recurrence.interval
            : 1,
        ...(frequency === "weekly"
          ? {
              weekdays:
                task.recurrence?.frequency === "weekly"
                  ? task.recurrence.weekdays
                  : [base.getDay()],
            }
          : {}),
        ...(frequency === "monthly"
          ? {
              dayOfMonth:
                task.recurrence?.frequency === "monthly"
                  ? task.recurrence.dayOfMonth
                  : base.getDate(),
            }
          : {}),
      },
    });
  };
  const descendantIds = new Set<string>();
  let frontier = [task.id];
  while (frontier.length > 0) {
    const children = relatedTasks.filter(
      (candidate) =>
        candidate.parentId &&
        frontier.includes(candidate.parentId) &&
        !descendantIds.has(candidate.id),
    );
    children.forEach((candidate) => descendantIds.add(candidate.id));
    frontier = children.map((candidate) => candidate.id);
  }
  const parentOptions = relatedTasks.filter(
    (candidate) =>
      candidate.id !== task.id &&
      !descendantIds.has(candidate.id) &&
      !candidate.deletedAt,
  );
  const dependencyOptions = relatedTasks
    .filter((candidate) => candidate.id !== task.id && !candidate.deletedAt)
    .sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
  const knownDependencyIds = new Set(
    dependencyOptions.map((candidate) => candidate.id),
  );
  const missingDependencyCount = task.dependencyIds.filter(
    (dependencyId) => !knownDependencyIds.has(dependencyId),
  ).length;
  const incompleteDependencyCount = task.dependencyIds.filter(
    (dependencyId) =>
      relatedTasks.find((candidate) => candidate.id === dependencyId)?.status !==
      "completed",
  ).length;
  const dependencyChain = buildDependencyChain(task, relatedTasks);
  const pendingTemporalChange = Boolean(
    pendingPatch &&
      ["plannedDate", "startAt", "dueAt", "timeBlock", "reminders"].some(
        (field) => field in pendingPatch,
      ),
  );
  return (
    <>
      <aside className="inspector" aria-label="任务详情">
        <div className="inspector-header">
          <span
            className={`status-pill ${taskSyncVisualState(task.sync.status) === "conflict" ? "warning" : taskSyncVisualState(task.sync.status) === "error" ? "danger" : taskSyncVisualState(task.sync.status) === "synced" ? "success" : ""}`}
          >
            {taskSyncVisualState(task.sync.status) === "error" ? (
              <ShieldAlert size={14} />
            ) : taskSyncVisualState(task.sync.status) === "conflict" ? (
              <AlertTriangle size={14} />
            ) : (
              <CircleDot size={14} />
            )}
            {taskSyncVisualState(task.sync.status) === "error"
              ? taskSyncLabel(task.sync.status) ?? "同步异常"
              : taskSyncVisualState(task.sync.status) === "conflict"
                ? "同步冲突"
                : task.status === "completed"
                  ? "已完成"
                  : task.sync.status === "synced"
                    ? "已同步"
                    : task.sync.status === "local"
                      ? "本地"
                      : task.sync.status}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="更多任务操作"
            aria-expanded={showActions}
            onClick={() => setShowActions((value) => !value)}
          >
            <MoreHorizontal size={17} />
          </button>
          {onClose && (
            <button
              type="button"
              className="icon-button inspector-close"
              aria-label="关闭任务详情"
              onClick={onClose}
            >
              <X size={17} />
            </button>
          )}
          {showActions && (
            <div className="inspector-menu">
              <button type="button" onClick={() => void duplicateAsLocal()}>
                创建本地副本
              </button>
              {!task.deletedAt && (
                <button
                  type="button"
                  onClick={() => {
                    void controller.moveToToday(task.id);
                    setShowActions(false);
                    notify("已移到今天", "success");
                  }}
                >
                  移到今天
                </button>
              )}
              <button
                type="button"
                disabled={!canToggleCompletion}
                onClick={() => {
                  void controller
                    .toggleComplete(task)
                    .catch((reason: unknown) =>
                      notify(
                        reason instanceof Error
                          ? reason.message
                          : "暂时无法更新完成状态",
                        "error",
                      ),
                    );
                  setShowActions(false);
                }}
              >
                {task.status === "completed" ? "重新打开" : completionVerb}
              </button>
              <button type="button" onClick={() => void saveToPetDiary()}>
                写入宠物日记
              </button>
              {task.deletedAt && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => void purge()}
                >
                  永久删除本地记录
                </button>
              )}
            </div>
          )}
        </div>
        <div className="detail-title">
          <input
            disabled={!canEditSharedFields}
            value={title}
            onChange={(event) => {
              markDirty("title");
              setTitle(event.target.value);
            }}
            onBlur={() => {
              if (!dirtyFieldsRef.current.has("title")) return;
              const revision = currentDirtyRevision("title");
              const next = title.trim();
              if (!next) {
                setTitle(task.title);
                clearDirtyIfCurrent("title", revision);
                notify("任务标题不能为空", "error");
                return;
              }
              void save({ title: next }).then((saved) => {
                if (saved) clearDirtyIfCurrent("title", revision);
              });
            }}
            aria-label="任务标题"
          />
          <textarea
            disabled={!canEditSharedFields}
            value={notes}
            onChange={(event) => {
              markDirty("notes");
              setNotes(event.target.value);
            }}
            onBlur={() => {
              if (!dirtyFieldsRef.current.has("notes")) return;
              const revision = currentDirtyRevision("notes");
              void save({ notes }).then((saved) => {
                if (saved) clearDirtyIfCurrent("notes", revision);
              });
            }}
            placeholder="添加备注…"
            aria-label="任务备注"
          />
        </div>
        <div className="detail-group">
          <h3>组织</h3>
          <div className="detail-field">
            <label htmlFor="project-id">项目</label>
            <input
              id="project-id"
              className="field-input"
              list="local-project-options"
              value={projectId}
              onChange={(event) => {
                markDirty("projectId");
                setProjectId(event.target.value);
              }}
              onBlur={() => {
                if (!dirtyFieldsRef.current.has("projectId")) return;
                const revision = currentDirtyRevision("projectId");
                const next = resolveProjectInput(projectId, projects);
                void save({ projectId: next || null }).then((saved) => {
                  if (saved) {
                    setProjectId(projectLabel(next, projects));
                    clearDirtyIfCurrent("projectId", revision);
                  }
                });
              }}
              placeholder="未归类"
            />
            <datalist id="local-project-options">
              {projects.filter((project) => !project.archived).map((project) => (
                <option key={project.id} value={project.name} label={project.id} />
              ))}
            </datalist>
            {task.source.type === "feishu" && (
              <small className="field-hint">仅本地，不同步飞书</small>
            )}
          </div>
          <div className="detail-field">
            <label htmlFor="list-id">清单</label>
            <input
              id="list-id"
              className="field-input"
              list="local-list-options"
              value={listId}
              onChange={(event) => {
                markDirty("listId");
                setListId(event.target.value);
              }}
              onBlur={() => {
                if (!dirtyFieldsRef.current.has("listId")) return;
                const revision = currentDirtyRevision("listId");
                const next = resolveListInput(listId, lists);
                void save({ listId: next || null }).then((saved) => {
                  if (saved) {
                    setListId(listLabel(next, lists));
                    clearDirtyIfCurrent("listId", revision);
                  }
                });
              }}
              placeholder="未归类"
            />
            <datalist id="local-list-options">
              {lists.filter((list) => !list.archived).map((list) => (
                <option key={list.id} value={list.name} label={list.id} />
              ))}
            </datalist>
            {task.source.type === "feishu" && (
              <small className="field-hint">仅本地，不同步飞书</small>
            )}
          </div>
          <div className="detail-field">
            <label htmlFor="task-tags">标签</label>
            <input
              id="task-tags"
              className="field-input"
              value={tagsText}
              onChange={(event) => {
                markDirty("tags");
                setTagsText(event.target.value);
              }}
              onBlur={() => {
                if (!dirtyFieldsRef.current.has("tags")) return;
                const revision = currentDirtyRevision("tags");
                const next = [
                  ...new Set(
                    tagsText
                      .split(/[,，]/u)
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  ),
                ];
                void save({ tags: next }).then((saved) => {
                  if (saved) clearDirtyIfCurrent("tags", revision);
                });
              }}
              placeholder="工作, 深度"
            />
            {task.source.type === "feishu" && (
              <small className="field-hint">仅本地，不同步飞书</small>
            )}
          </div>
          <div className="detail-field">
            <label htmlFor="task-contexts">情境</label>
            <input
              id="task-contexts"
              className="field-input"
              value={contextsText}
              onChange={(event) => {
                markDirty("contexts");
                setContextsText(event.target.value);
              }}
              onBlur={() => {
                if (!dirtyFieldsRef.current.has("contexts")) return;
                const revision = currentDirtyRevision("contexts");
                const next = [
                  ...new Map(
                    contextsText
                      .split(/[,，]/u)
                      .map((context) => context.trim().replace(/\s+/gu, " "))
                      .filter(Boolean)
                      .map((context) => [context.toLocaleLowerCase(), context] as const),
                  ).values(),
                ];
                void save({ contexts: next }).then((saved) => {
                  if (saved) clearDirtyIfCurrent("contexts", revision);
                });
              }}
              placeholder="办公室, 家, 出门"
            />
            <small className="field-hint">
              手动情境，用于筛选和宠物建议；不申请定位，不同步飞书
            </small>
          </div>
          <div className="detail-field">
            <label htmlFor="parent-task">父任务</label>
            <select
              id="parent-task"
              className="field-select"
              value={task.parentId ?? ""}
              onChange={(event) =>
                void save({ parentId: event.target.value || null })
              }
            >
              <option value="">无</option>
              {parentOptions.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </option>
              ))}
            </select>
            {task.source.type === "feishu" && (
              <small className="field-hint">仅本地，不同步飞书</small>
            )}
          </div>
          <div className="detail-field">
            <label htmlFor="task-dependencies">依赖（先完成）</label>
            <select
              id="task-dependencies"
              className="field-select dependency-select"
              multiple
              size={Math.min(6, Math.max(3, dependencyOptions.length))}
              value={task.dependencyIds.filter((dependencyId) => knownDependencyIds.has(dependencyId))}
              onChange={(event) => {
                const selected = Array.from(event.currentTarget.selectedOptions).map(
                  (option) => option.value,
                );
                const missing = task.dependencyIds.filter(
                  (dependencyId) => !knownDependencyIds.has(dependencyId),
                );
                void save({ dependencyIds: [...new Set([...missing, ...selected])] });
              }}
              aria-label="任务依赖"
            >
              {dependencyOptions.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title}{candidate.status === "completed" ? " · 已完成" : ""}
                </option>
              ))}
            </select>
            <small className="field-hint">
              {incompleteDependencyCount
                ? `还有 ${incompleteDependencyCount} 项前置任务未完成`
                : "前置任务都已完成"}
              {missingDependencyCount ? `；${missingDependencyCount} 项依赖暂时不可见` : ""}
            </small>
            {task.source.type === "feishu" && (
              <small className="field-hint">仅本地，不同步飞书</small>
            )}
          </div>
          {(dependencyChain.ancestors.length > 0 ||
            dependencyChain.downstream.length > 0 ||
            dependencyChain.missingDependencyIds.length > 0 ||
            dependencyChain.cycleDetected) && (
            <section className="dependency-chain-card" aria-label="任务依赖链">
              <div className="dependency-chain-heading">
                <span>
                  <GitBranch size={14} aria-hidden="true" />
                  执行关系
                </span>
                <small>
                  {dependencyChain.ancestors.length > 0
                    ? `先做 ${dependencyChain.ancestors.length} 项`
                    : dependencyChain.downstream.length > 0
                      ? `后续 ${dependencyChain.downstream.length} 项`
                      : "需要检查"}
                </small>
              </div>
              <div className="dependency-chain-track">
                {dependencyChain.ancestors.map((item) => (
                  <button
                    key={`ancestor-${item.task.id}`}
                    type="button"
                    className={`dependency-chain-node ${item.task.status === "completed" ? "is-complete" : ""}`}
                    onClick={() => controller.select(item.task.id)}
                    title="打开前置任务"
                  >
                    <small>前置</small>
                    <span>{item.task.title}</span>
                  </button>
                ))}
                <span className="dependency-chain-current" aria-current="true">
                  <small>当前</small>
                  <span>{task.title}</span>
                </span>
                {dependencyChain.downstream.map((item) => (
                  <button
                    key={`downstream-${item.task.id}`}
                    type="button"
                    className={`dependency-chain-node ${item.task.status === "completed" ? "is-complete" : ""}`}
                    onClick={() => controller.select(item.task.id)}
                    title="打开后续任务"
                  >
                    <small>后续</small>
                    <span>{item.task.title}</span>
                  </button>
                ))}
              </div>
              {dependencyChain.missingDependencyIds.length > 0 && (
                <p className="dependency-chain-warning">
                  还有 {dependencyChain.missingDependencyIds.length} 项依赖暂时不可见，关系已保留。
                </p>
              )}
              {dependencyChain.cycleDetected && (
                <p className="dependency-chain-warning">
                  检测到循环依赖；这里只展示事实，不会自动改写。
                </p>
              )}
            </section>
          )}
        </div>
        <div className="detail-group">
          <h3>链接与上下文</h3>
          {task.links.length > 0 && (
            <div className="task-link-list" aria-label="任务链接">
              {task.links.map((link) => (
                <div className="task-link-row" key={link.id}>
                  <button
                    type="button"
                    className="task-link-open"
                    onClick={() => void window.desktopApi?.shell.openExternal(link.url)}
                    title={link.url}
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                    <span>{link.label || link.url}</span>
                  </button>
                  <button
                    type="button"
                    className="row-icon-button"
                    aria-label={`移除链接${link.label || link.url}`}
                    onClick={() => void removeTaskLink(link.id)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="task-link-composer">
            <input
              id="task-link-url"
              className="field-input"
              value={linkUrlInput}
              onChange={(event) => setLinkUrlInput(event.target.value)}
              placeholder="https://…"
              aria-label="链接地址"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addTaskLink();
                }
              }}
            />
            <input
              id="task-link-label"
              className="field-input"
              value={linkLabelInput}
              onChange={(event) => setLinkLabelInput(event.target.value)}
              placeholder="名称（可选）"
              aria-label="链接名称"
            />
            <button
              type="button"
              className="soft-button"
              disabled={!linkUrlInput.trim()}
              onClick={() => void addTaskLink()}
            >
              <Plus size={14} aria-hidden="true" />
              添加链接
            </button>
          </div>
          <small className="field-hint">链接只作为任务上下文保存，不会写回飞书。</small>
        </div>
        <div className="detail-group">
          <h3>
            <FileText size={15} aria-hidden="true" />
            研究卡 <span className="section-count">{task.researchCards?.length ?? 0}</span>
          </h3>
          {(task.researchCards ?? []).length > 0 ? (
            <div className="research-card-list" aria-label="任务研究卡">
              {(task.researchCards ?? []).map((card) => (
                <details className="research-card" key={card.id}>
                  <summary>
                    <span className="research-card-summary-title">
                      <FileText size={14} aria-hidden="true" />
                      {card.title}
                    </span>
                    {card.actionItems.length > 0 && (
                      <span className="research-card-count">{card.actionItems.length} 条行动项</span>
                    )}
                  </summary>
                  <div className="research-card-body">
                    {card.url && (
                      <button
                        type="button"
                        className="research-card-source"
                        onClick={() => void window.desktopApi?.shell.openExternal(card.url!)}
                        title={card.url}
                      >
                        <ExternalLink size={13} aria-hidden="true" />
                        <span>{card.url}</span>
                      </button>
                    )}
                    {card.summary && <p className="research-card-summary">{card.summary}</p>}
                    {card.actionItems.length > 0 && (
                      <ul className="research-card-actions">
                        {card.actionItems.map((item, index) => <li key={`${card.id}-${index}`}>{item}</li>)}
                      </ul>
                    )}
                    <div className="research-card-footer">
                      <time dateTime={card.capturedAt}>记录于 {formatDateTime(card.capturedAt)}</time>
                      <button
                        type="button"
                        className="text-button danger-text"
                        aria-label={`移除研究卡${card.title}`}
                        onClick={() => void removeResearchCard(card.id)}
                      >
                        移除
                      </button>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <small className="field-hint research-card-empty">
              把资料来源、摘要和下一步收在任务里，Agent 才能围绕同一上下文继续工作。
            </small>
          )}
          <div className="research-card-composer">
            <input
              className="field-input"
              value={researchTitleInput}
              onChange={(event) => setResearchTitleInput(event.target.value)}
              placeholder="研究卡标题，例如：竞品定价摘要"
              aria-label="研究卡标题"
              maxLength={200}
            />
            <input
              className="field-input"
              value={researchUrlInput}
              onChange={(event) => setResearchUrlInput(event.target.value)}
              placeholder="来源链接（可选）"
              aria-label="研究卡来源链接"
              maxLength={2_000}
            />
            <textarea
              className="field-input field-textarea"
              value={researchSummaryInput}
              onChange={(event) => setResearchSummaryInput(event.target.value)}
              placeholder="摘要（可选）"
              aria-label="研究卡摘要"
              maxLength={5_000}
            />
            <textarea
              className="field-input field-textarea"
              value={researchActionsInput}
              onChange={(event) => setResearchActionsInput(event.target.value)}
              placeholder="行动项（每行一条，可选）"
              aria-label="研究卡行动项"
              maxLength={10_000}
            />
            <button
              type="button"
              className="soft-button"
              disabled={!researchTitleInput.trim()}
              onClick={() => void addResearchCard()}
            >
              <Plus size={14} aria-hidden="true" />
              添加研究卡
            </button>
          </div>
          <small className="field-hint research-card-hint">研究卡是本机私人上下文，不会写回飞书；导出时可选择是否包含。</small>
        </div>
        <div className="detail-group">
          <h3>自定义字段</h3>
          {Object.entries(task.customFields).length > 0 ? (
            <div className="custom-field-list" aria-label="自定义字段列表">
              {Object.entries(task.customFields).map(([key, value]) => (
                <div className="custom-field-row" key={key}>
                  <span className="custom-field-key" title={key}>{key}</span>
                  <span className="custom-field-value" title={customFieldValueLabel(value)}>
                    {customFieldValueLabel(value)}
                  </span>
                  <button
                    type="button"
                    className="row-icon-button"
                    aria-label={`移除自定义字段${key}`}
                    onClick={() => void removeCustomField(key)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <small className="field-hint custom-field-empty">给任务加上客户、版本或其他私人上下文。</small>
          )}
          <div className="custom-field-composer">
            <input
              id="custom-field-key"
              className="field-input"
              value={customFieldKey}
              onChange={(event) => setCustomFieldKey(event.target.value)}
              placeholder="字段名称"
              aria-label="自定义字段名称"
              maxLength={40}
            />
            <select
              id="custom-field-type"
              className="field-select"
              value={customFieldType}
              onChange={(event) => {
                const nextType = event.target.value as CustomFieldType;
                setCustomFieldType(nextType);
                if (nextType === "checkbox" && !customFieldValue) setCustomFieldValue("false");
                if (nextType !== "checkbox" && (customFieldValue === "true" || customFieldValue === "false")) setCustomFieldValue("");
              }}
              aria-label="自定义字段类型"
            >
              {Object.entries(customFieldTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            {customFieldType === "checkbox" ? (
              <select
                id="custom-field-value"
                className="field-select"
                value={customFieldValue || "false"}
                onChange={(event) => setCustomFieldValue(event.target.value)}
                aria-label="自定义字段值"
              >
                <option value="false">未勾选</option>
                <option value="true">已勾选</option>
              </select>
            ) : (
              <input
                id="custom-field-value"
                className="field-input"
                type={customFieldType === "date" ? "date" : customFieldType === "number" ? "number" : "text"}
                value={customFieldValue}
                onChange={(event) => setCustomFieldValue(event.target.value)}
                placeholder={customFieldType === "url" ? "https://…" : customFieldType === "number" ? "例如 30" : "字段值"}
                aria-label="自定义字段值"
                maxLength={500}
                step={customFieldType === "number" ? "any" : undefined}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addCustomField();
                  }
                }}
              />
            )}
            <button
              type="button"
              className="soft-button"
              disabled={!customFieldKey.trim() || (customFieldType !== "checkbox" && !customFieldValue.trim())}
              onClick={() => void addCustomField()}
            >
              <Plus size={14} aria-hidden="true" />
              添加字段
            </button>
          </div>
          <small className="field-hint">仅保存在本地私人上下文，不会写回飞书。</small>
        </div>
        <div className="detail-group">
          <h3>附件</h3>
          {task.attachments.length > 0 ? (
            <div className="task-attachment-list" aria-label="任务附件">
              {task.attachments.map((attachment) => (
                <div className="task-attachment-row" key={attachment.id}>
                  <button
                    type="button"
                    className="task-attachment-open"
                    disabled={!attachment.url && !attachment.localPath}
                    onClick={() => void openTaskAttachment(attachment)}
                    title={attachment.localPath ? "打开本地附件" : attachment.url ?? attachment.name}
                  >
                    <FileText size={14} aria-hidden="true" />
                    <span>{attachment.name}</span>
                  </button>
                  {attachment.localPath && (
                    <button
                      type="button"
                      className="row-icon-button task-attachment-preview"
                      aria-label={`预览附件${attachment.name}`}
                      title="预览附件"
                      disabled={previewBusyId === attachment.id}
                      onClick={() => void previewTaskAttachment(attachment)}
                    >
                      <Eye size={14} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="row-icon-button"
                    aria-label={`移除附件${attachment.name}`}
                    onClick={() => void removeTaskAttachment(attachment.id)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <small className="field-hint task-attachment-empty">添加本地文件，或保存一个文档、设计稿、研究页面的外部引用。</small>
          )}
          <div className="task-attachment-actions">
            <button
              type="button"
              className="soft-button"
              disabled={attachmentBusy}
              onClick={() => void chooseTaskAttachments()}
            >
              <Upload size={14} aria-hidden="true" />
              {attachmentBusy ? "正在添加…" : "选择本地文件"}
            </button>
            <small className="field-hint">文件只复制到本机应用数据目录，不会上传飞书。</small>
          </div>
          <div className="task-attachment-composer">
            <input
              id="task-attachment-name"
              className="field-input"
              value={attachmentName}
              onChange={(event) => setAttachmentName(event.target.value)}
              placeholder="名称（可选）"
              aria-label="附件名称"
              maxLength={120}
            />
            <input
              id="task-attachment-url"
              className="field-input"
              value={attachmentUrl}
              onChange={(event) => setAttachmentUrl(event.target.value)}
              placeholder="https://…"
              aria-label="附件地址"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addTaskAttachment();
                }
              }}
            />
            <button
              type="button"
              className="soft-button"
              disabled={!attachmentUrl.trim()}
              onClick={() => void addTaskAttachment()}
            >
              <Plus size={14} aria-hidden="true" />
              添加附件
            </button>
          </div>
          <small className="field-hint">外部链接和本地附件都只保存在本地私人上下文，不会写回飞书。</small>
        </div>
        <div className="detail-group">
          <h3>计划与时间</h3>
          <div className="detail-field">
            <label htmlFor="planned-date">私人计划</label>
            <input
              id="planned-date"
              className="field-input"
              type="date"
              value={plannedDateInput}
              onChange={(event) => {
                markDirty("plannedDate");
                setPlannedDateInput(event.target.value);
              }}
              onBlur={(event) =>
                void commitPlannedDate(event.currentTarget.value)
              }
            />
            {task.source.type === "feishu" && (
              <small className="field-hint">仅本地，不同步飞书</small>
            )}
          </div>
          <div className="detail-field">
            <label htmlFor="start-at">开始时间</label>
            <div className="field-control-stack">
              <input
                id="start-at"
                className="field-input"
                type={startAtAllDay ? "date" : "datetime-local"}
                disabled={!canEditSharedFields}
                value={
                  startAtAllDay
                    ? allDayDateInput(startAtInput)
                    : startAtInput
                }
                onChange={(event) => {
                  markDirty("startAt");
                  setStartAtInput(
                    allDayDateTimeInput(
                      event.target.value,
                      startAtAllDay,
                    ),
                  );
                }}
                onBlur={(event) =>
                  void commitTemporalFields({
                    startAtInput: event.currentTarget.value,
                  })
                }
              />
              <label className="field-checkbox">
                <input
                  type="checkbox"
                  checked={startAtAllDay}
                  disabled={!canEditSharedFields || !startAtInput}
                  onChange={(event) =>
                    void setAllDay("startAt", event.target.checked)
                  }
                  aria-label="开始时间为全天"
                />
                全天
              </label>
            </div>
          </div>
          <div className="detail-field">
            <label htmlFor="due-at">截止时间</label>
            <div className="field-control-stack">
              <input
                id="due-at"
                className="field-input"
                type={dueAtAllDay ? "date" : "datetime-local"}
                disabled={!canEditSharedFields}
                value={
                  dueAtAllDay ? allDayDateInput(dueAtInput) : dueAtInput
                }
                onChange={(event) => {
                  markDirty("dueAt");
                  setDueAtInput(
                    allDayDateTimeInput(
                      event.target.value,
                      dueAtAllDay,
                    ),
                  );
                }}
                onBlur={(event) =>
                  void commitTemporalFields({
                    dueAtInput: event.currentTarget.value,
                  })
                }
              />
              <label className="field-checkbox">
                <input
                  type="checkbox"
                  checked={dueAtAllDay}
                  disabled={!canEditSharedFields || !dueAtInput}
                  onChange={(event) =>
                    void setAllDay("dueAt", event.target.checked)
                  }
                  aria-label="截止时间为全天"
                />
                全天
              </label>
            </div>
          </div>
          <div className="detail-field">
            <label htmlFor="time-block-start">时间块开始</label>
            <input
              id="time-block-start"
              className="field-input"
              type="datetime-local"
              value={timeBlockStart}
              onChange={(event) => setTimeBlockStart(event.target.value)}
              onBlur={saveTimeBlock}
            />
            {task.source.type === "feishu" && (
              <small className="field-hint">仅本地，不同步飞书</small>
            )}
          </div>
          <div className="detail-field">
            <label htmlFor="time-block-end">时间块结束</label>
            <input
              id="time-block-end"
              className="field-input"
              type="datetime-local"
              value={timeBlockEnd}
              onChange={(event) => setTimeBlockEnd(event.target.value)}
              onBlur={saveTimeBlock}
            />
          </div>
          <div className="detail-field">
            <label htmlFor="priority">优先级</label>
            <select
              id="priority"
              className="field-select"
              value={task.priority}
              onChange={(event) =>
                void save({ priority: event.target.value as TaskPriority })
              }
            >
              {Object.entries(priorityLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {task.source.type === "feishu" && (
              <small className="field-hint">仅本地，不同步飞书</small>
            )}
          </div>
          <div className="detail-field">
            <label htmlFor="estimate">预计分钟</label>
            <input
              id="estimate"
              className="field-input"
              type="number"
              min={0}
              step={5}
              value={task.estimatedMinutes ?? ""}
              onChange={(event) =>
                void save({
                  estimatedMinutes: event.target.value
                    ? Number(event.target.value)
                    : null,
                })
              }
            />
            {task.source.type === "feishu" && (
              <small className="field-hint">仅本地，不同步飞书</small>
            )}
          </div>
          <div className="private-note">
            <EyeOff size={14} />
            项目、标签、父子任务、优先级、预计、私人计划、时间块、排序和专注不会回写飞书
          </div>
        </div>
        <div className="detail-group">
          <h3>提醒与循环</h3>
          <div className="detail-field">
            <label htmlFor="local-reminder">本地提醒</label>
            <input
              id="local-reminder"
              className="field-input"
              type="datetime-local"
              value={localReminderInput}
              onChange={(event) => {
                markDirty("localReminder");
                setLocalReminderInput(event.target.value);
              }}
              onBlur={(event) =>
                void commitLocalReminder(event.currentTarget.value)
              }
            />
          </div>
          <div className="detail-field">
            <label htmlFor="recurrence">循环</label>
            <select
              id="recurrence"
              className="field-select"
              value={task.recurrence?.frequency ?? "none"}
              disabled={task.source.type === "feishu"}
              onChange={(event) =>
                setRecurrence(
                  event.target.value as "none" | "daily" | "weekly" | "monthly",
                )
              }
            >
              <option value="none">不循环</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
          </div>
          {task.recurrence && (
            <div className="detail-field">
              <label htmlFor="recurrence-interval">每隔</label>
              <div className="inline-number">
                <input
                  id="recurrence-interval"
                  className="field-input"
                  type="number"
                  min={1}
                  max={365}
                  value={task.recurrence.interval}
                  disabled={task.source.type === "feishu"}
                  onChange={(event) =>
                    void save({
                      recurrence: {
                        ...task.recurrence!,
                        interval: Math.max(1, Number(event.target.value) || 1),
                      },
                    })
                  }
                />
                <span>
                  {task.recurrence.frequency === "daily"
                    ? "天"
                    : task.recurrence.frequency === "weekly"
                      ? "周"
                      : "月"}
                </span>
              </div>
            </div>
          )}
          {task.source.type === "feishu" && (
            <div className="private-note">
              <EyeOff size={14} />
              这里只新增本地提醒；飞书循环规则保持只读
            </div>
          )}
        </div>
        <div className="detail-group">
          <h3>
            子任务 <span className="section-count">{subtasks.length > 0 ? `${completedSubtasks}/${subtasks.length}` : 0}</span>
          </h3>
          {subtasks.length > 0 && (
            <div
              className="subtask-progress"
              role="progressbar"
              aria-label="子任务完成进度"
              aria-valuemin={0}
              aria-valuemax={subtasks.length}
              aria-valuenow={completedSubtasks}
            >
              <span
                style={{
                  width: `${Math.round((completedSubtasks / subtasks.length) * 100)}%`,
                }}
              />
            </div>
          )}
          <div className="subtask-list">
            {subtasks.map((subtask) => (
              <div className="subtask-row" key={subtask.id}>
                <input
                  className="task-checkbox"
                  type="checkbox"
                  checked={subtask.status === "completed"}
                  onChange={() =>
                    void controller.toggleComplete(subtask, {
                      selectUpdated: false,
                    })
                  }
                  aria-label={`${subtask.status === "completed" ? "恢复" : "完成"}${subtask.title}`}
                />
                <span>{subtask.title}</span>
                <SourcePill source={subtask.source.type} />
              </div>
            ))}
          </div>
          <div className="subtask-composer">
            <input
              className="field-input"
              value={subtaskTitle}
              onChange={(event) => setSubtaskTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addSubtask();
              }}
              placeholder="新增本地子任务…"
              aria-label="新子任务标题"
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => void addSubtask()}
              disabled={!subtaskTitle.trim()}
              aria-label="添加子任务"
            >
              <Plus size={15} />
            </button>
          </div>
        </div>
        <div className="detail-group">
          <h3>来源</h3>
          <div className="detail-field">
            <span>任务来源</span>
            <span>
              <SourcePill source={task.source.type} />
            </span>
          </div>
          <div className="detail-field">
            <span>同步</span>
            <span>
              {task.sync.status === "local" ? "仅此设备" : task.sync.status}
            </span>
          </div>
          {task.source.type === "feishu" && task.currentUserRole && (
            <div className="detail-field">
              <span>我的角色</span>
              <span>
                {task.currentUserRole === "assignee"
                  ? "负责人"
                  : task.currentUserRole === "follower"
                    ? "关注人 · 共享字段只读"
                    : "只读成员"}
              </span>
            </div>
          )}
          {task.source.type === "feishu" && (
            <div className="detail-field">
              <span>飞书清单</span>
              <span>
                {task.source.tasklist === undefined
                  ? "清单信息暂不可读取"
                  : task.source.tasklist.tasklistGuid
                    ? task.source.tasklist.sectionGuid
                      ? "已关联清单与分组"
                      : "已关联飞书清单"
                    : "未关联飞书清单"}
              </span>
            </div>
          )}
          {task.source.type === "feishu" &&
            task.source.tasklist === undefined && (
              <div className="private-note">
                <Info size={14} />
                清单信息以飞书权限为准；本地项目与标签不会映射到这里
              </div>
            )}
          {needsFeishuForCosignCompletion(task) && (
            <div className="detail-field notice-field">
              <span>会签完成</span>
              <span>开放接口不支持完成个人部分，请在飞书中操作</span>
            </div>
          )}
          {task.source.type === "feishu" && (
            <button
              type="button"
              className="ghost-button"
              onClick={() => void openInFeishu()}
            >
              <ExternalLink size={15} />
              在飞书中打开
            </button>
          )}
        </div>
        <div className="detail-group">
          <h3>
            历史 <span className="section-count">{taskHistory.length}</span>
          </h3>
          {taskHistoryLoading ? (
            <div className="task-history-empty" role="status">
              正在读取任务历史…
            </div>
          ) : taskHistory.length === 0 ? (
            <div className="task-history-empty">
              这项任务还没有可显示的本地变更记录。
            </div>
          ) : (
            <ol className="task-history-list" aria-label="任务历史记录">
              {taskHistory.map((entry) => (
                <li className="task-history-row" key={entry.operationId}>
                  <span className="task-history-marker" aria-hidden="true" />
                  <div className="task-history-content">
                    <div className="task-history-heading">
                      <strong>
                        {taskHistoryOperationLabels[entry.kind] ?? entry.kind}
                      </strong>
                      <time dateTime={entry.createdAt}>
                        {formatDateTime(entry.createdAt)}
                      </time>
                    </div>
                    <div className="task-history-fields">
                      {entry.changedFields.map((field) => (
                        <span key={field}>
                          {taskHistoryFieldLabels[field] ?? field}
                        </span>
                      ))}
                    </div>
                    {entry.undoneAt && (
                      <small className="task-history-undone">
                        已于 {formatDateTime(entry.undoneAt)} 撤销
                      </small>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          <small className="field-hint task-history-hint">
            仅显示本机可撤销操作；飞书远端变化仍以同步状态和任务内容为准。
          </small>
        </div>
        <div className="detail-group">
          <h3>
            <MessageCircle size={15} aria-hidden="true" />
            讨论 <span className="section-count">{task.comments?.length ?? 0}</span>
          </h3>
          {(task.comments ?? []).length === 0 ? (
            <div className="task-comments-empty">
              给未来的自己留一句上下文，或让 Agent 接着这里继续工作。
            </div>
          ) : (
            <div className="task-comments-list" aria-label="任务讨论">
              {(task.comments ?? []).map((comment) => (
                <article className="task-comment" key={comment.id}>
                  <div className="task-comment-meta">
                    <strong>{comment.author === "agent" ? "Agent" : "我"}</strong>
                    <time dateTime={comment.updatedAt}>
                      {formatDateTime(comment.updatedAt)}
                    </time>
                    <div className="task-comment-actions">
                      <button
                        type="button"
                        className="text-button"
                        disabled={commentBusy}
                        onClick={() => beginCommentEdit(comment)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="text-button danger-text"
                        disabled={commentBusy}
                        onClick={() => void removeTaskComment(comment.id)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  {editingCommentId === comment.id ? (
                    <div className="task-comment-edit">
                      <textarea
                        className="field-input task-comment-input"
                        value={editingCommentBody}
                        maxLength={10_000}
                        onChange={(event) => setEditingCommentBody(event.target.value)}
                        aria-label="编辑讨论"
                      />
                      <div className="task-comment-edit-actions">
                        <button
                          type="button"
                          className="soft-button"
                          disabled={commentBusy || !editingCommentBody.trim()}
                          onClick={() => void commitCommentEdit()}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={commentBusy}
                          onClick={() => {
                            setEditingCommentId(undefined);
                            setEditingCommentBody("");
                          }}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="task-comment-body">{comment.body}</p>
                  )}
                </article>
              ))}
            </div>
          )}
          <div className="task-comment-composer">
            <textarea
              className="field-input task-comment-input"
              value={commentBody}
              maxLength={10_000}
              disabled={commentBusy}
              onChange={(event) => setCommentBody(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void addTaskComment();
                }
              }}
              placeholder="写下这项任务的上下文…"
              aria-label="新增任务讨论"
            />
            <button
              type="button"
              className="soft-button"
              disabled={commentBusy || !commentBody.trim()}
              onClick={() => void addTaskComment()}
            >
              <Send size={14} aria-hidden="true" />
              {commentBusy ? "保存中…" : "添加讨论"}
            </button>
          </div>
          <small className="field-hint task-comments-hint">
            仅保存在本机；不会写回飞书，也不会在未授权备注范围时提供给 Agent。
          </small>
        </div>
        <div className="detail-group">
          <h3>专注</h3>
          {task.focusStartedAt ? (
            <button
              type="button"
              className="soft-button"
              onClick={() => void controller.pauseFocus(task.id)}
            >
              <Pause size={15} />
              暂停本次计时
            </button>
          ) : (
            <button
              type="button"
              className="soft-button"
              onClick={() => void controller.startFocus(task.id)}
            >
              <Play size={15} />
              开始处理
            </button>
          )}
        </div>
        <div className="detail-group">
          <h3>Agent</h3>
          <button
            type="button"
            className="soft-button"
            onClick={() =>
              onAskAgent(
                `请帮我把任务“${task.title}”拆解成清晰、可执行的下一步。${task.notes ? `背景：${task.notes}` : ""}先给出建议，未经我确认不要创建或修改任务。`,
              )
            }
          >
            <Sparkles size={15} />
            帮我拆解任务
          </button>
        </div>
        <div className="detail-footer">
          {task.deletedAt ? (
            <>
              <button
                type="button"
                className="primary-button"
                onClick={() => void controller.restore(task.id)}
              >
                <RotateCcw size={15} />
                恢复任务
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void purge()}
              >
                <Trash2 size={15} />
                永久删除
              </button>
            </>
          ) : (
            <button
              type="button"
              className="danger-button"
              disabled={remoteReadOnly}
              onClick={() => void trashTask()}
            >
              <Trash2 size={15} />
              {task.source.type === "feishu" ? "删除飞书任务…" : "移到回收站"}
            </button>
          )}
        </div>
      </aside>
      {pendingPatch && (
        <div className="modal-backdrop">
          <div
            className="modal-sheet compact-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recurrence-scope-title"
          >
            <div className="modal-header">
              <span className="feature-icon">
                <RotateCcw size={20} />
              </span>
              <div>
                <h2 id="recurrence-scope-title">将更改应用到哪里？</h2>
                <p>
                  {pendingTemporalChange
                    ? "日期和提醒在不同实例上需要分别计算；当前安全地只修改本次。"
                    : "这是循环任务；请选择本次、从本次起，或整个系列。"}
                </p>
              </div>
            </div>
            <div className="modal-actions recurrence-actions">
              <button
                type="button"
                className="soft-button"
                onClick={() => setPendingPatch(undefined)}
              >
                取消
              </button>
              <span className="action-spacer" />
              <button
                type="button"
                className="soft-button"
                onClick={() => {
                  const patch = pendingPatch;
                  setPendingPatch(undefined);
                  void applySave(patch, "this");
                }}
              >
                仅本次
              </button>
              <button
                type="button"
                className="soft-button"
                disabled={pendingTemporalChange}
                onClick={() => {
                  const patch = pendingPatch;
                  setPendingPatch(undefined);
                  void applySave(patch, "future");
                }}
              >
                本次及以后
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={pendingTemporalChange}
                onClick={() => {
                  const patch = pendingPatch;
                  setPendingPatch(undefined);
                  void applySave(patch, "series");
                }}
              >
                整个系列
              </button>
            </div>
          </div>
        </div>
      )}
      {attachmentPreview && (
        <div
          className="modal-backdrop attachment-preview-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setAttachmentPreview(undefined);
              setAttachmentPreviewSource(undefined);
            }
          }}
        >
          <section
            className="modal-sheet attachment-preview-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="attachment-preview-title"
          >
            <div className="modal-header">
              <span className="feature-icon"><Eye size={19} /></span>
              <div>
                <h2 id="attachment-preview-title">{attachmentPreview.name}</h2>
                <p>
                  {attachmentPreview.kind === "text"
                    ? `${attachmentPreview.mimeType} · ${attachmentPreview.bytes.toLocaleString()} bytes`
                    : attachmentPreview.kind === "image"
                      ? `${attachmentPreview.mimeType} · ${attachmentPreview.bytes.toLocaleString()} bytes`
                      : attachmentPreview.reason === "too-large"
                        ? "文件超过预览大小限制"
                        : "此文件类型暂不支持内置预览"}
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭附件预览"
                onClick={() => {
                  setAttachmentPreview(undefined);
                  setAttachmentPreviewSource(undefined);
                }}
              >
                <X size={16} />
              </button>
            </div>
            <div className="attachment-preview-body">
              {attachmentPreview.kind === "text" ? (
                <pre className="attachment-preview-text">{attachmentPreview.content}</pre>
              ) : attachmentPreview.kind === "image" ? (
                <img className="attachment-preview-image" src={attachmentPreview.dataUrl} alt={attachmentPreview.name} />
              ) : (
                <div className="attachment-preview-empty" role="status">
                  <FileText size={30} aria-hidden="true" />
                  <strong>暂时不能在这里预览</strong>
                  <span>你仍然可以打开原文件查看完整内容。</span>
                </div>
              )}
            </div>
            <div className="modal-actions attachment-preview-actions">
              {attachmentPreviewSource && (
                <button type="button" className="soft-button" onClick={() => void openTaskAttachment(attachmentPreviewSource)}>
                  <ExternalLink size={14} /> 打开原文件
                </button>
              )}
              <span className="action-spacer" />
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setAttachmentPreview(undefined);
                  setAttachmentPreviewSource(undefined);
                }}
              >
                完成
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function NewTaskSheet({
  onClose,
  controller,
  projects = [],
  lists = [],
  notify,
}: {
  onClose: () => void;
  controller: TaskController;
  projects?: TaskProject[];
  lists?: TaskList[];
  notify: (message: string, kind?: ToastKind) => void;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState<TaskSourceType>("local");
  const [plannedDate, setPlannedDate] = useState(dateKey());
  const [startAt, setStartAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [reminderAt, setReminderAt] = useState("");
  const [projectId, setProjectId] = useState("");
  const [listId, setListId] = useState("");
  const [tags, setTags] = useState("");
  const [contexts, setContexts] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [estimatedMinutes, setEstimatedMinutes] = useState("");
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<
    "none" | "daily" | "weekly" | "monthly"
  >("none");
  const [recurrenceInterval, setRecurrenceInterval] = useState(1);
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatusView>();
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    void window.desktopApi?.feishu.status().then(setFeishuStatus);
    return window.desktopApi?.events.onFeishuStatus(setFeishuStatus);
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || submitting) return;
    const blockedFeishuMessage = feishuCreationBlockedMessage(
      source,
      feishuStatus,
    );
    if (blockedFeishuMessage) {
      notify(blockedFeishuMessage, "error");
      return;
    }
    if (startAt && dueAt && new Date(dueAt) < new Date(startAt)) {
      notify("截止时间不能早于开始时间", "error");
      return;
    }
    const startAtIso = localDateTimeInputToIso(startAt);
    const dueAtIso = localDateTimeInputToIso(dueAt);
    const reminderAtIso = localDateTimeInputToIso(reminderAt);
    if ((startAt && !startAtIso) || (dueAt && !dueAtIso) || (reminderAt && !reminderAtIso)) {
      notify("请输入有效的日期和时间", "error");
      return;
    }
    setSubmitting(true);
    try {
      const recurrenceBase = plannedDate
        ? new Date(`${plannedDate}T12:00:00`)
        : new Date();
      await controller.create({
        title: title.trim(),
        notes: notes.trim(),
        source:
          source === "feishu"
            ? { type: "feishu", accountId: feishuStatus?.accountId }
            : { type: "local" },
        plannedDate: plannedDate || undefined,
        startAt: startAtIso,
        dueAt: dueAtIso,
        projectId: resolveProjectInput(projectId, projects) || undefined,
        listId: resolveListInput(listId, lists) || undefined,
        tags: [
          ...new Set(
            tags
              .split(/[,，]/u)
              .map((tag) => tag.trim())
              .filter(Boolean),
          ),
        ],
        contexts: [
          ...new Map(
            contexts
              .split(/[,，]/u)
              .map((context) => context.trim().replace(/\s+/gu, " "))
              .filter(Boolean)
              .map((context) => [context.toLocaleLowerCase(), context] as const),
          ).values(),
        ],
        priority,
        estimatedMinutes: estimatedMinutes ? Number(estimatedMinutes) : undefined,
        reminders: reminderAt
          ? [
              {
                id: crypto.randomUUID(),
                at: reminderAtIso!,
                enabled: true,
                source: "local",
              },
            ]
          : [],
        recurrence:
          source === "local" && recurrenceFrequency !== "none"
            ? {
                frequency: recurrenceFrequency,
                interval: recurrenceInterval,
                ...(recurrenceFrequency === "weekly"
                  ? { weekdays: [recurrenceBase.getDay()] }
                  : {}),
                ...(recurrenceFrequency === "monthly"
                  ? { dayOfMonth: recurrenceBase.getDate() }
                  : {}),
              }
            : undefined,
        sync:
          source === "feishu" ? { status: "pending" } : { status: "local" },
      });
      notify(
        source === "feishu" ? "任务已创建，等待同步飞书" : "任务已创建",
        "success",
      );
      onClose();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "创建任务失败", "error");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        className="modal-sheet new-task-sheet"
        onSubmit={(event) => void submit(event)}
        aria-label="新建任务"
        aria-busy={submitting}
      >
        <div className="modal-header">
          <span className="feature-icon">
            <Plus size={20} />
          </span>
          <div>
            <h2>新建任务</h2>
            <p>本地任务无需登录；飞书任务会在确认连接后同步。</p>
          </div>
        </div>
        <div className="modal-body">
          <div className="detail-field">
            <label htmlFor="new-title">标题</label>
            <input
              id="new-title"
              className="field-input"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="detail-field">
            <label htmlFor="new-notes">备注</label>
            <textarea
              id="new-notes"
              className="field-input field-textarea"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="补充背景、链接或验收条件…"
            />
          </div>
          <div className="detail-field">
            <label htmlFor="new-source">保存到</label>
            <select
              id="new-source"
              className="field-select"
              value={source}
              onChange={(event) => {
                const next = event.target.value as TaskSourceType;
                setSource(next);
                if (next === "feishu") setRecurrenceFrequency("none");
              }}
            >
              <option value="local">本地</option>
              <option value="feishu">飞书</option>
            </select>
          </div>
          <div className="detail-field">
            <label htmlFor="new-project">项目</label>
            <input
              id="new-project"
              className="field-input"
              list="new-local-project-options"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              placeholder="未归类"
            />
            <datalist id="new-local-project-options">
              {projects.filter((project) => !project.archived).map((project) => (
                <option key={project.id} value={project.name} label={project.id} />
              ))}
            </datalist>
          </div>
          <div className="detail-field">
            <label htmlFor="new-list">清单</label>
            <input
              id="new-list"
              className="field-input"
              list="new-local-list-options"
              value={listId}
              onChange={(event) => setListId(event.target.value)}
              placeholder="未归类"
            />
            <datalist id="new-local-list-options">
              {lists.filter((list) => !list.archived).map((list) => (
                <option key={list.id} value={list.name} label={list.id} />
              ))}
            </datalist>
          </div>
          <div className="detail-field">
            <label htmlFor="new-tags">标签</label>
            <input
              id="new-tags"
              className="field-input"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="工作, 深度"
            />
          </div>
          <div className="detail-field">
            <label htmlFor="new-contexts">情境</label>
            <input
              id="new-contexts"
              className="field-input"
              value={contexts}
              onChange={(event) => setContexts(event.target.value)}
              placeholder="办公室, 家, 出门"
            />
            <small className="field-hint">
              手动情境，用于筛选和宠物建议；不申请定位，不同步飞书
            </small>
          </div>
          <div className="detail-field">
            <label htmlFor="new-priority">优先级</label>
            <select
              id="new-priority"
              className="field-select"
              value={priority}
              onChange={(event) =>
                setPriority(event.target.value as TaskPriority)
              }
            >
              {Object.entries(priorityLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="detail-field">
            <label htmlFor="new-date">私人计划</label>
            <input
              id="new-date"
              className="field-input"
              type="date"
              value={plannedDate}
              onChange={(event) => setPlannedDate(event.target.value)}
            />
          </div>
          <div className="detail-field">
            <label htmlFor="new-start">开始时间</label>
            <input
              id="new-start"
              className="field-input"
              type="datetime-local"
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
            />
          </div>
          <div className="detail-field">
            <label htmlFor="new-due">截止时间</label>
            <input
              id="new-due"
              className="field-input"
              type="datetime-local"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
            />
          </div>
          <div className="detail-field">
            <label htmlFor="new-reminder">本地提醒</label>
            <input
              id="new-reminder"
              className="field-input"
              type="datetime-local"
              value={reminderAt}
              onChange={(event) => setReminderAt(event.target.value)}
            />
          </div>
          <div className="detail-field">
            <label htmlFor="new-estimate">预计分钟</label>
            <input
              id="new-estimate"
              className="field-input"
              type="number"
              min={0}
              step={5}
              value={estimatedMinutes}
              onChange={(event) => setEstimatedMinutes(event.target.value)}
            />
          </div>
          <div className="detail-field">
            <label htmlFor="new-recurrence">循环</label>
            <select
              id="new-recurrence"
              className="field-select"
              value={recurrenceFrequency}
              disabled={source === "feishu"}
              onChange={(event) =>
                setRecurrenceFrequency(
                  event.target.value as typeof recurrenceFrequency,
                )
              }
            >
              <option value="none">不循环</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
          </div>
          {recurrenceFrequency !== "none" && (
            <div className="detail-field">
              <label htmlFor="new-recurrence-interval">每隔</label>
              <div className="inline-number">
                <input
                  id="new-recurrence-interval"
                  className="field-input"
                  type="number"
                  min={1}
                  max={365}
                  value={recurrenceInterval}
                  onChange={(event) =>
                    setRecurrenceInterval(
                      Math.max(1, Number(event.target.value) || 1),
                    )
                  }
                />
                <span>
                  {recurrenceFrequency === "daily"
                    ? "天"
                    : recurrenceFrequency === "weekly"
                      ? "周"
                      : "月"}
                </span>
              </div>
            </div>
          )}
          {source === "feishu" && (
            <div className="private-note">
              <EyeOff size={14} />
              飞书循环规则首期只读；本地提醒与私人计划仍可使用
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="soft-button"
            disabled={submitting}
            onClick={onClose}
          >
            取消
          </button>
          <span className="action-spacer" />
          <button
            type="submit"
            className="primary-button"
            disabled={!title.trim() || submitting}
          >
            {submitting
              ? "正在创建…"
              : source === "feishu"
                ? "创建到飞书"
                : "保存到本地"}
          </button>
        </div>
      </form>
    </div>
  );
}

function AgentPage({
  controller,
  notify,
  initialPrompt,
  onPromptConsumed,
}: {
  controller: TaskController;
  notify: (message: string, kind?: ToastKind) => void;
  initialPrompt?: string;
  onPromptConsumed: () => void;
}) {
  const [proposal, setProposal] = useState(false);
  const [permission, setPermission] = useState(false);
  const fallback = async (text: string): Promise<string> => {
    if (/移到明天|改到明天|批量/u.test(text)) {
      setProposal(true);
      return "模型未启用，因此我不会猜测要修改哪些任务。配置模型后，我会先列出影响范围再请求确认。";
    }
    if (/新增|创建|记下/u.test(text)) {
      return /飞书/u.test(text)
        ? "飞书任务不会在模型未启用时降级为本地任务。请先连接飞书并启用模型，或使用“新建”明确创建本地任务。"
        : "模型未启用，我不会把自然语言猜测为任务并直接写入。你可以使用“新建”或快速录入创建本地任务。";
    }
    return `模型未启用。今天这个视图有 ${controller.tasks.filter((task) => task.status === "open").length} 项未完成；启用模型后可用自然语言查询、创建和整理任务。`;
  };
  const chat = useAgentChat({
    initialMessage: `我可以查询、创建和整理任务。当前有 ${controller.tasks.length} 项任务在这个视图里。`,
    onFallback: fallback,
  });
  const {
    messages,
    input,
    setInput,
    isSending,
    runState,
    agentStatus,
    approval,
    activeRunId,
    send,
    stop,
    respondToApproval,
    appendAssistant,
    refreshStatus,
  } = chat;
  const agentThreadRef = useRef<HTMLElement>(null);
  const chatFollowsOutputRef = useRef(true);
  useEffect(() => {
    if (!chatFollowsOutputRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const thread = agentThreadRef.current;
      if (thread) thread.scrollTop = thread.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages]);
  const submitAgentMessage = (): void => {
    chatFollowsOutputRef.current = true;
    void send();
  };
  useEffect(() => {
    if (!initialPrompt) return;
    setInput(initialPrompt);
    onPromptConsumed();
  }, [initialPrompt, onPromptConsumed]);
  const affected = controller.tasks
    .filter((task) => task.source.type === "feishu" && task.status === "open")
    .slice(0, 3);
  const execute = async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    for (const task of affected)
      await controller.update(task.id, { plannedDate: dateKey(tomorrow) });
    setPermission(false);
    setProposal(false);
    appendAssistant(
      `已更新 ${affected.length} 项私人计划；没有改动飞书团队截止时间。`,
    );
    notify("批量操作已完成", "success");
  };
  const stopAgent = async () => {
    try {
      const stopped = await stop();
      await refreshStatus();
      notify(
        stopped
          ? "Agent 已停止；任务提醒与同步继续运行"
          : "当前没有正在运行的 Agent",
        "success",
      );
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "停止 Agent 失败",
        "error",
      );
    }
  };
  return (
    <div className="agent-layout">
      <main
        ref={agentThreadRef}
        className="agent-thread"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={isSending}
        onScroll={(event) => {
          const thread = event.currentTarget;
          chatFollowsOutputRef.current =
            thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
        }}
      >
        <div className="agent-heading">
          <span className="agent-orb">
            <Sparkles size={19} />
          </span>
          <div>
            <h1>任务助理</h1>
            <p>任务优先；所有工具调用都经过权限引擎 · {runState}</p>
          </div>
        </div>
        {messages.map((message, index) => (
          <div
            key={message.id ?? `${message.role}-${index}`}
            className={`message ${message.role === "user" ? "user" : ""} ${message.streaming ? "streaming" : ""}`}
            aria-live={message.streaming ? "polite" : undefined}
            aria-busy={message.streaming || undefined}
          >
            {message.role === "assistant" ? (
              message.text ? (
                <AgentMarkdown text={message.text} />
              ) : (
                <span className="streaming-indicator" role="status">
                  <i />
                  <i />
                  <i />
                  <span className="sr-only">正在生成回答</span>
                </span>
              )
            ) : (
              message.text
            )}
          </div>
        ))}
        {proposal && (
          <div className="action-preview">
            <div className="preview-header">
              <ListChecks size={17} />
              <strong>批量调整计划</strong>
              <span className="impact">
                {affected.length
                  ? `将影响 ${affected.length} 项`
                  : "无可修改任务"}
              </span>
            </div>
            {affected.map((task) => (
              <div key={task.id} className="change-row">
                <div>
                  <strong>{task.title}</strong>
                  <small>{task.plannedDate ?? "未安排"} → 明天</small>
                </div>
                <SourcePill source={task.source.type} />
              </div>
            ))}
            <div className="change-row">
              <div>
                <strong>不会修改</strong>
                <small>飞书截止时间、负责人和任务正文</small>
              </div>
              <span className="status-pill success">私人计划</span>
            </div>
            <div className="preview-actions">
              <button
                type="button"
                className="soft-button"
                onClick={() => setProposal(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!affected.length}
                onClick={() => setPermission(true)}
              >
                检查并执行
              </button>
            </div>
          </div>
        )}
        <div className="composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submitAgentMessage();
              }
            }}
            placeholder="增删改查任务，或让我查资料…"
            aria-label="给 Agent 发消息"
          />
          <button
            type="button"
            className="primary-button"
            disabled={isSending || !input.trim()}
            onClick={submitAgentMessage}
          >
            <Send size={17} />
            {isSending ? "回答中" : "发送"}
          </button>
        </div>
      </main>
      <aside className="agent-context">
        <h2>本次上下文</h2>
        <div className="context-block">
          <h3>模型</h3>
          <div className="context-line">
            {agentStatus?.enabled && agentStatus.configured ? (
              <>
                <Check size={15} />
                已启用自定义模型
              </>
            ) : (
              <>
                <Info size={15} />
                未配置时使用本地任务指令
              </>
            )}
          </div>
        </div>
        <div className="context-block">
          <h3>数据范围</h3>
          <div className="context-line">
            <Check size={15} />
            任务标题和时间
          </div>
          <div className="context-line">
            <EyeOff size={15} />
            默认不包含任务备注
          </div>
          <div className="context-line">
            <EyeOff size={15} />
            默认不包含附件内容
          </div>
        </div>
        <div className="context-block">
          <h3>能力</h3>
          <div className="chip-row">
            <span className="chip">任务读写</span>
            <span className="chip">飞书同步</span>
            <span className="chip">网页研究</span>
            <span className="chip">文件与终端</span>
            <span className="chip">剪贴板与屏幕</span>
          </div>
        </div>
        <div className="context-block">
          <h3>运行</h3>
          <div className="context-line">
            <ShieldCheck size={15} />
            {agentStatus?.fullAccessLease ? "临时全权限" : "标准模式"}
          </div>
          <button
            type="button"
            className="danger-button"
            disabled={!activeRunId}
            onClick={() => void stopAgent()}
          >
            <Square size={14} />
            停止 Agent
          </button>
        </div>
      </aside>
      {permission && (
        <PermissionSheet
          title={`允许 Agent 更新 ${affected.length} 个任务？`}
          onDeny={() => setPermission(false)}
          onAllow={() => void execute()}
        />
      )}
      {approval && (
        <PermissionSheet
          approval={approval}
          title={`允许 Agent 执行 ${approval.toolName}？`}
          onDeny={() => void respondToApproval("deny")}
          onAllow={() => void respondToApproval("once")}
          onAllowForHour={async () => {
            if (
              !window.desktopApi ||
              !["R2", "R3"].includes(approval.effects.risk)
            )
              return;
            try {
              await window.desktopApi.agent.createFullAccessLease({
                durationMinutes: 60,
                scopes: [
                  {
                    toolName: approval.toolName,
                    risks: [approval.effects.risk as "R2" | "R3"],
                    targets: approval.effects.targets,
                  },
                ],
              });
              const settings = await window.desktopApi.settings.get();
              await window.desktopApi.settings.replace({
                ...settings,
                permissionMode: "full-access",
              });
              await respondToApproval("once");
              await refreshStatus();
              notify("已记住这个精确范围 1 小时", "success");
            } catch (reason) {
              notify(
                reason instanceof Error ? reason.message : "未能开启临时全权限",
                "error",
              );
            }
          }}
        />
      )}
    </div>
  );
}

function PermissionSheet({
  title,
  approval,
  onDeny,
  onAllow,
  onAllowForHour,
}: {
  title: string;
  approval?: AgentApprovalView;
  onDeny: () => void;
  onAllow: () => void;
  onAllowForHour?: () => void | Promise<void>;
}) {
  const reviewDescription = !approval
    ? "这是批量操作；请确认精确目标与可逆性。"
    : approval.toolName.startsWith("task_bulk_")
      ? "这是批量操作；请确认每个精确目标与可逆性。"
      : approval.effects.externalEffects.length > 0 ||
          approval.effects.network.length > 0
        ? "这项操作会影响外部服务；请确认目标、写入和网络影响。"
        : "这项操作会修改本地数据；请确认精确目标与可逆性。";
  return (
    <div className="modal-backdrop">
      <div
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-title"
      >
        <div className="modal-header">
          <span className="feature-icon">
            <ShieldAlert size={21} />
          </span>
          <div>
            <h2 id="permission-title">{title}</h2>
            <p>{reviewDescription}</p>
          </div>
        </div>
        <div className="modal-body">
          <div className="permission-row">
            <span>风险等级</span>
            <strong>{approval?.effects.risk ?? "R2 · 批量操作"}</strong>
          </div>
          <div className="permission-row">
            <span>精确目标</span>
            <strong>
              {approval
                ? approval.effects.targets
                    .map((target) => `${target.kind}:${target.value}`)
                    .join("、")
                : "今天视图中的明确匹配任务"}
            </strong>
          </div>
          <div className="permission-row">
            <span>写入</span>
            <strong>
              {approval
                ? approval.effects.writes.join("、") || "无"
                : "私人计划日期"}
            </strong>
          </div>
          <div className="permission-row">
            <span>网络与外部影响</span>
            <strong>
              {approval
                ? [
                    ...approval.effects.network,
                    ...approval.effects.externalEffects,
                  ].join("、") || "无"
                : "不会写入飞书团队字段、文件或网络"}
            </strong>
          </div>
          <div className="permission-row">
            <span>可逆性</span>
            <strong>
              {approval?.effects.reversible === false
                ? "不可自动撤销"
                : "可撤销或无持久变更"}
            </strong>
          </div>
          <div className="permission-row">
            <span>授权范围</span>
            <strong>仅本次</strong>
          </div>
        </div>
        <div className="warning-note">
          <Info size={15} />
          标准模式下，批量、删除或外部修改不会自动记住授权。
        </div>
        <div className="modal-actions">
          <button type="button" className="soft-button" onClick={onDeny}>
            拒绝
          </button>
          <span className="action-spacer" />
          {onAllowForHour && (
            <button
              type="button"
              className="soft-button"
              onClick={() => void onAllowForHour()}
            >
              这个精确范围允许 1 小时
            </button>
          )}
          <button type="button" className="primary-button" onClick={onAllow}>
            仅本次允许并执行
          </button>
        </div>
      </div>
    </div>
  );
}

function ActivityPage({
  controller,
  notify,
}: {
  controller: TaskController;
  notify: (message: string, kind?: ToastKind) => void;
}) {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [selected, setSelected] = useState<AuditRecord>();
  useEffect(() => {
    void window.desktopApi?.agent
      .audit(300)
      .then((value) => setRecords(value.toReversed()));
    return window.desktopApi?.events.onAgentEvent(() => {
      void window.desktopApi?.agent
        .audit(300)
        .then((value) => setRecords(value.toReversed()));
    });
  }, []);
  const exportAudit = async () => {
    try {
      const result = await window.desktopApi?.data.exportToFile({
        redaction: "private",
        include: {
          tasks: false,
          drafts: false,
          operations: false,
          settings: false,
          permissionAudit: true,
        },
      });
      if (result?.status === "exported")
        notify("审计记录已脱敏导出", "success");
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "导出审计失败",
        "error",
      );
    }
  };
  const fallbackItem: AuditRecord = {
    sequence: 0,
    timestamp: new Date().toISOString(),
    previousHash: "",
    eventHash: "",
    runId: "local",
    actor: "system" as const,
    event: "本地任务数据已加载",
    details: { tasks: controller.tasks.length },
  };
  const items: AuditRecord[] = records.length > 0 ? records : [fallbackItem];
  return (
    <main className="content-column">
      <div className="page-heading">
        <div>
          <h1>动态与审计</h1>
          <p>Agent 工具调用经过脱敏，并由哈希链防篡改</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="soft-button"
            onClick={() => void exportAudit()}
          >
            <Download size={16} />
            导出审计
          </button>
        </div>
      </div>
      <div className="task-list">
        {items.map((item) => (
          <div key={`${item.sequence}-${item.eventHash}`} className="task-row">
            <span
              className={`status-pill ${item.outcome === "denied" || item.outcome === "failed" ? "warning" : item.outcome === "success" ? "success" : ""}`}
            >
              {item.outcome === "denied" || item.outcome === "failed" ? (
                <AlertTriangle size={17} />
              ) : item.outcome === "success" ? (
                <CheckCircle2 size={17} />
              ) : (
                <ShieldCheck size={17} />
              )}
            </span>
            <div>
              <strong>
                {item.toolName
                  ? `${item.toolName} · ${item.event}`
                  : item.event}
              </strong>
              <div className="task-meta">
                {formatDateTime(item.timestamp)} · {item.risk ?? item.actor}
                {item.outcome ? ` · ${item.outcome}` : ""}
              </div>
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setSelected(item)}
            >
              详情
            </button>
          </div>
        ))}
      </div>
      {selected && (
        <div className="modal-backdrop">
          <div
            className="modal-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-detail-title"
          >
            <div className="modal-header">
              <span className="feature-icon">
                <ShieldCheck size={20} />
              </span>
              <div>
                <h2 id="audit-detail-title">审计记录 #{selected.sequence}</h2>
                <p>
                  {selected.toolName ?? selected.event} ·{" "}
                  {formatDateTime(selected.timestamp)}
                </p>
              </div>
            </div>
            <div className="modal-body">
              <div className="permission-row">
                <span>运行</span>
                <strong>{selected.runId}</strong>
              </div>
              <div className="permission-row">
                <span>风险与结果</span>
                <strong>
                  {selected.risk ?? "—"} · {selected.outcome ?? "记录"}
                </strong>
              </div>
              <div className="permission-row">
                <span>策略</span>
                <strong>{selected.policyReason ?? "系统事件"}</strong>
              </div>
              <div className="permission-row">
                <span>影响范围</span>
                <strong>
                  {selected.effects
                    ? JSON.stringify(selected.effects)
                    : "无外部影响"}
                </strong>
              </div>
              <div className="permission-row">
                <span>哈希</span>
                <strong className="mono-value">{selected.eventHash}</strong>
              </div>
            </div>
            <div className="modal-actions">
              <span className="action-spacer" />
              <button
                type="button"
                className="primary-button"
                onClick={() => setSelected(undefined)}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function SyncPage({
  notify,
}: {
  notify: (message: string, kind?: ToastKind) => void;
}) {
  const [status, setStatus] = useState<FeishuStatusView>();
  const [conflicts, setConflicts] = useState<FeishuConflictView[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!window.desktopApi) return;
    const next = await window.desktopApi.feishu.status();
    setStatus(next);
    setConflicts(
      next.configured
        ? await window.desktopApi.feishu.listConflicts().catch(() => [])
        : [],
    );
  }, []);
  useEffect(() => {
    void refresh();
    const offStatus = window.desktopApi?.events.onFeishuStatus((next) => {
      setStatus(next);
      if (next.connected) void refresh();
    });
    const offTasks = window.desktopApi?.events.onTasksChanged(() => {
      void refresh();
    });
    return () => {
      offStatus?.();
      offTasks?.();
    };
  }, [refresh]);
  const beginOAuth = async () => {
    if (!window.desktopApi) return;
    if (!status?.configured) {
      await window.desktopApi.shell.showMain("settings");
      notify("先在设置中一键连接飞书，或使用已有飞书应用");
      return;
    }
    setBusy(true);
    try {
      await window.desktopApi.feishu.beginOAuth();
      notify("已在浏览器打开飞书授权；完成后会自动回到已连接状态", "success");
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "无法开始飞书授权",
        "error",
      );
    } finally {
      setBusy(false);
    }
  };
  const sync = async (forceFull = false) => {
    if (!window.desktopApi) return;
    setBusy(true);
    try {
      const report = await window.desktopApi.feishu.syncNow(forceFull);
      if (report.issue) {
        notify(
          feishuSyncIssueCopy(report.issue),
          report.issue.retryable ? "info" : "error",
        );
      } else {
        notify(`同步完成：上传 ${report.pushed}，拉取 ${report.pulled}`, "success");
      }
      await refresh();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "同步失败", "error");
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (
    conflict: FeishuConflictView,
    decision: FeishuConflictDecisionView,
  ) => {
    if (!window.desktopApi) return;
    const externalWrite = decision === "keep-local";
    if (externalWrite && !window.confirm("这会把本地版本写回飞书。确认继续？"))
      return;
    setBusy(true);
    try {
      await window.desktopApi.feishu.resolveConflict(
        conflict.localId,
        decision,
      );
      notify(
        decision === "duplicate"
          ? "已复制为本地任务，飞书版本保持不变"
          : "冲突已解决",
        "success",
      );
      await refresh();
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "冲突处理失败",
        "error",
      );
    } finally {
      setBusy(false);
    }
  };
  const fieldLabels: Record<
    FeishuConflictView["fields"][number]["field"],
    string
  > = {
    title: "标题",
    notes: "备注",
    startAt: "开始时间",
    dueAt: "截止时间",
    status: "完成状态",
    assigneeIds: "负责人",
    followerIds: "关注者",
    tasklist: "飞书清单",
  };
  const formatConflictValue = (
    value: FeishuConflictView["fields"][number]["base"],
  ) => {
    if (Array.isArray(value)) return value.length > 0 ? value.join("、") : "无";
    if (value && typeof value === "object") {
      if (!value.tasklistGuid) return "无";
      return value.sectionGuid ? "已关联清单与分组" : "已关联清单";
    }
    return value || "—";
  };
  const statusVisualState = feishuSyncVisualState(status);
  const statusLabel = status?.lastError
    ? statusVisualState === "pending"
      ? "同步等待处理"
      : "同步异常"
    : status?.state === "connected"
      ? "已连接"
      : status?.state === "syncing"
        ? "同步中"
        : status?.state === "authorizing"
          ? "等待授权"
          : status?.configured
            ? "已配置，未连接"
            : "未配置";
  return (
    <main className="conflict-page">
      <div className="page-heading">
        <div>
          <h1>飞书连接与同步</h1>
          <p>本地任务不会因为连接飞书而自动上传</p>
        </div>
        <div className="page-actions">
          <span
            className={`status-pill ${statusVisualState === "error" ? "danger" : statusVisualState === "pending" ? "warning" : status?.connected ? "success" : ""}`}
          >
            {statusVisualState === "error" ? (
              <ShieldAlert size={15} />
            ) : statusVisualState === "pending" ? (
              <RefreshCw size={15} />
            ) : status?.connected ? (
              <CloudCheck size={15} />
            ) : (
              <Cloud size={15} />
            )}
            {statusLabel}
          </span>
          {status?.connected ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void sync(true)}
            >
              <RefreshCw size={16} />
              立即同步
            </button>
          ) : (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void beginOAuth()}
            >
              <Cloud size={16} />
              {status?.configured ? "连接飞书" : "前往设置"}
            </button>
          )}
        </div>
      </div>
      <section className="morning-brief">
        <div className="brief-title">
          <ShieldCheck size={17} />
          同步范围
        </div>
        <p className="brief-copy">
          只同步标题、描述、开始时间、截止时间、完成状态、负责人、关注者和显式飞书清单；Today、项目、标签、私人排序、时间块和专注状态永不回写。
        </p>
        {status?.lastSyncAt && (
          <small>上次同步：{formatDateTime(status.lastSyncAt)}</small>
        )}
      </section>
      {status?.lastError && (
        <div className="conflict-banner">
          <AlertTriangle size={19} />
          <div>
            <strong>{status.lastError.message}</strong>
            <p>
              {status.lastError.retryable
                ? "改动已保留，可以稍后重试。"
                : `错误代码：${status.lastError.code}`}
            </p>
          </div>
        </div>
      )}
      {conflicts.length === 0 ? (
        <div className="empty-state">
          <div>
            <span className="feature-icon">
              <CloudCheck size={24} />
            </span>
            <h2>没有同步冲突</h2>
            <p>
              {status?.connected
                ? "本地与飞书的公共字段保持一致。"
                : "连接后，这里只显示需要你决定的冲突。"}
            </p>
          </div>
        </div>
      ) : (
        conflicts.map((conflict) => (
          <section key={conflict.localId} className="conflict-card">
            <div className="conflict-banner">
              <AlertTriangle size={19} />
              <div>
                <strong>这项任务在本地和飞书都被修改</strong>
                <p>
                  {conflict.fields.length} 个公共字段需要选择 ·{" "}
                  {formatDateTime(conflict.detectedAt)}
                </p>
              </div>
            </div>
            <div className="conflict-table">
              <div className="conflict-head">
                <div>字段</div>
                <div>原版本</div>
                <div>本地版本</div>
                <div>飞书版本</div>
              </div>
              {conflict.fields.map((field) => (
                <div className="conflict-row" key={field.field}>
                  <div>
                    <strong>{fieldLabels[field.field]}</strong>
                  </div>
                  <div>{formatConflictValue(field.base)}</div>
                  <div>{formatConflictValue(field.local)}</div>
                  <div>{formatConflictValue(field.remote)}</div>
                </div>
              ))}
            </div>
            <div className="conflict-footer">
              <span>私人字段不会参与冲突。</span>
              <span className="footer-spacer" />
              <button
                type="button"
                className="soft-button"
                disabled={busy}
                onClick={() => void resolve(conflict, "duplicate")}
              >
                两份都保留
              </button>
              <button
                type="button"
                className="soft-button"
                disabled={busy}
                onClick={() => void resolve(conflict, "use-feishu")}
              >
                采用飞书
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void resolve(conflict, "keep-local")}
              >
                保留本地并回写
              </button>
            </div>
          </section>
        ))
      )}
    </main>
  );
}

type SettingsSection =
  | "general"
  | "floating"
  | "notifications"
  | "integrations"
  | "ai"
  | "permissions"
  | "privacy";

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
      />
      <span />
    </label>
  );
}

function usePetData() {
  const [snapshot, setSnapshot] = useState<PetSnapshot>();
  const [weather, setWeather] = useState<WeatherSnapshot>();
  const refresh = useCallback(async () => {
    if (!window.desktopApi) return;
    const [nextSnapshot, nextWeather] = await Promise.all([
      window.desktopApi.pet.snapshot(),
      window.desktopApi.pet.weather().catch(() => undefined),
    ]);
    setSnapshot(nextSnapshot);
    setWeather(nextWeather);
  }, []);
  useEffect(() => {
    void refresh();
    return window.desktopApi?.events.onPetEvent((event) => {
      if (event.weather) setWeather(event.weather);
      void refresh();
    });
  }, [refresh]);
  return { snapshot, weather, refresh, setWeather };
}

function focusElapsedNow(focus: FocusSessionView | undefined, now: number): number {
  if (!focus) return 0;
  if (focus.status !== "running" || !focus.startedAt) return focus.elapsedSeconds;
  return (
    focus.accumulatedSeconds +
    Math.max(0, Math.floor((now - new Date(focus.startedAt).getTime()) / 1_000))
  );
}

function focusRemainingNow(
  focus: FocusSessionView | undefined,
  now: number,
): number | undefined {
  if (!focus?.targetSeconds) return undefined;
  return Math.max(0, focus.targetSeconds - focusElapsedNow(focus, now));
}

function clockDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const remainder = safe % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function PetPlayground({
  disabled,
  onComplete,
}: {
  disabled: boolean;
  onComplete: (
    game: "breathing" | "star-catch",
    score: number,
    durationSeconds: number,
  ) => void;
}) {
  const breathingLabels = ["吸气", "停留", "呼气", "停留"] as const;
  const [breathingPhase, setBreathingPhase] = useState<number>();
  const [starRunning, setStarRunning] = useState(false);
  const [starScore, setStarScore] = useState(0);
  const [starSeconds, setStarSeconds] = useState(20);
  const [starPosition, setStarPosition] = useState({ x: 48, y: 48 });
  useEffect(() => {
    if (breathingPhase === undefined) return undefined;
    const timer = window.setTimeout(() => {
      if (breathingPhase >= breathingLabels.length - 1) {
        setBreathingPhase(undefined);
        onComplete("breathing", 4, 16);
      } else {
        setBreathingPhase((current) => (current ?? 0) + 1);
      }
    }, 4_000);
    return () => window.clearTimeout(timer);
  }, [breathingPhase]);
  useEffect(() => {
    if (!starRunning) return undefined;
    const timer = window.setInterval(() => {
      setStarSeconds((seconds) => {
        if (seconds > 1) return seconds - 1;
        window.clearInterval(timer);
        setStarRunning(false);
        setStarScore((score) => {
          onComplete("star-catch", score, 20);
          return score;
        });
        return 0;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [starRunning]);
  const startStars = () => {
    setStarScore(0);
    setStarSeconds(20);
    setStarPosition({ x: 48, y: 48 });
    setStarRunning(true);
  };
  return (
    <div className="pet-games-grid">
      <section className="pet-game-card breathing-game">
        <span className="pet-game-kicker">安静小游戏</span>
        <h2>和我呼吸 16 秒</h2>
        <p>没有连胜和惩罚，只把注意力轻轻带回身体。</p>
        <div
          className={`pet-breathing-orb ${breathingPhase !== undefined ? "is-running" : ""}`}
          data-phase={breathingPhase ?? "idle"}
          aria-live="polite"
        >
          {breathingPhase === undefined ? "准备" : breathingLabels[breathingPhase]}
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={disabled || breathingPhase !== undefined}
          onClick={() => setBreathingPhase(0)}
        >
          <Play size={15} /> 开始呼吸
        </button>
      </section>
      <section className="pet-game-card star-game">
        <span className="pet-game-kicker">反应小游戏</span>
        <h2>接住任务星</h2>
        <p>20 秒轻松点一点，结束后就回到手头的事。</p>
        <div className="pet-star-field" aria-label="接住任务星游戏区">
          {starRunning ? (
            <button
              type="button"
              className="pet-catch-star"
              style={{
                left: `${starPosition.x}%`,
                top: `${starPosition.y}%`,
              }}
              aria-label="接住星星"
              onClick={() => {
                setStarScore((score) => score + 1);
                setStarPosition({
                  x: 10 + Math.round(Math.random() * 78),
                  y: 12 + Math.round(Math.random() * 70),
                });
              }}
            >
              ✦
            </button>
          ) : (
            <span>✦</span>
          )}
          <small>{starRunning ? `${starSeconds}s · ${starScore} 颗` : `最好：${starScore} 颗`}</small>
        </div>
        <button
          type="button"
          className="soft-button"
          disabled={disabled || starRunning}
          onClick={startStars}
        >
          <Sparkles size={15} /> 开始接星星
        </button>
      </section>
    </div>
  );
}

function ElasticHabitsPanel() {
  const [habits, setHabits] = useState<ElasticHabit[]>(() => readElasticHabits());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const update = (id: string, patch: Partial<ElasticHabit>) => {
    setHabits((current) => {
      const next = current.map((habit) => (habit.id === id ? { ...habit, ...patch } : habit));
      writeElasticHabits(next);
      return next;
    });
  };
  return (
    <section className="pet-habits-card" aria-labelledby="elastic-habits-title">
      <div className="pet-section-heading">
        <div>
          <h2 id="elastic-habits-title">弹性习惯</h2>
          <p>在合适的空档轻轻提醒，不追连续、不扣分，也不会打断专注。</p>
        </div>
        <span className="pet-habit-badge">可跳过</span>
      </div>
      <div className="pet-habits-list">
        {habits.map((habit) => {
          const ready = habitState(habit, now) === "ready";
          return (
            <article className={`pet-habit-row ${ready ? "is-ready" : "is-resting"}`} key={habit.id}>
              <span className="pet-habit-dot" aria-hidden="true" />
              <div>
                <strong>{habit.label}</strong>
                <p>{habit.hint}</p>
                <small>{ready ? "现在是一个合适的空档" : formatHabitWait(habit, now)}</small>
              </div>
              <div className="pet-habit-actions">
                <button
                  type="button"
                  className="soft-button"
                  disabled={!ready}
                  onClick={() => update(habit.id, { lastCompletedAt: new Date(now).toISOString(), snoozedUntil: undefined })}
                >
                  {ready ? "完成一次" : "已记下"}
                </button>
                {ready && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => update(habit.id, { snoozedUntil: new Date(now + 30 * 60_000).toISOString() })}
                  >
                    稍后
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function EveningReviewCard({
  tasks,
  focusHistory,
  onPlanTomorrow,
}: {
  tasks: readonly Task[];
  focusHistory: PetSnapshot["focusHistory"];
  onPlanTomorrow?: () => void;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const review = useMemo(
    () => buildEveningReview(tasks, focusHistory, now),
    [focusHistory, now, tasks],
  );
  return (
    <section className="pet-evening-review-card" aria-label={review.label}>
      <div className="pet-section-heading">
        <div>
          <h2>{review.label}</h2>
          <p>{review.headline}</p>
        </div>
        <Clock3 size={18} aria-hidden="true" />
      </div>
      <div className="pet-review-metrics">
        <div><strong>{review.completedCount}</strong><span>完成</span></div>
        <div><strong>{review.focusMinutes}</strong><span>专注分钟</span></div>
        <div><strong>{review.remainingCount}</strong><span>待处理</span></div>
      </div>
      <p className="pet-review-detail">{review.detail}</p>
      {review.remainingCount > 0 && onPlanTomorrow && (
        <div className="pet-evening-review-actions">
          <span>不必今晚硬撑，可以先看一眼明天。</span>
          <button type="button" className="soft-button" onClick={onPlanTomorrow}>
            安排明天
          </button>
        </div>
      )}
    </section>
  );
}

const weeklyCheckinStorageKey = "todo-agent:weekly-checkin";

function readWeeklyCheckin(weekStart: string): WeeklyCheckinRecord | undefined {
  try {
    const raw = localStorage.getItem(weeklyCheckinStorageKey);
    if (!raw) return undefined;
    return normalizeWeeklyCheckin(JSON.parse(raw), weekStart);
  } catch {
    return undefined;
  }
}

function WeeklyCheckinCard({
  tasks,
  notify,
}: {
  tasks: readonly Task[];
  notify: (message: string, kind?: ToastKind) => void;
}) {
  const [now, setNow] = useState(() => new Date());
  const [energy, setEnergy] = useState<WeeklyCheckinEnergy>(3);
  const [pace, setPace] = useState<WeeklyCheckinPace>("steady");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<WeeklyCheckinRecord>();
  const weekStart = useMemo(() => weekStartFor(now), [now]);
  const summary = useMemo(
    () => weeklyReviewSummary(tasks, weekStart),
    [tasks, weekStart],
  );
  const openCount = useMemo(
    () => tasks.filter((task) => !task.deletedAt && task.status === "open").length,
    [tasks],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const previous = readWeeklyCheckin(weekStart);
    setSaved(previous);
    setEnergy(previous?.energy ?? 3);
    setPace(previous?.pace ?? "steady");
    setNote(previous?.note ?? "");
  }, [weekStart]);

  const copy = checkinCopy({
    energy: saved?.energy ?? energy,
    pace: saved?.pace ?? pace,
    completedCount: summary.completedCount,
    openCount,
  });

  const save = () => {
    const record: WeeklyCheckinRecord = {
      weekStart,
      energy,
      pace,
      note: note.trim().slice(0, 300),
      completedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(weeklyCheckinStorageKey, JSON.stringify(record));
    } catch {
      notify("这次没有保存下来，但你仍然可以继续使用。", "error");
      return;
    }
    setSaved(record);
    notify("本周节奏已记下，随时可以调整。", "success");
  };

  return (
    <section className={`pet-weekly-checkin-card ${saved ? "is-saved" : ""}`} aria-label="每周 Check-in">
      <div className="pet-section-heading">
        <div>
          <h2>每周 Check-in</h2>
          <p>{saved ? "本周已记下这份节奏，不需要连续打卡。" : "花半分钟听听自己，再决定这周要走多快。"}</p>
        </div>
        <span className="pet-habit-badge">可选</span>
      </div>
      {saved ? (
        <div className="pet-checkin-saved">
          <div className="pet-checkin-saved-copy">
            <strong>{copy.headline}</strong>
            <p>{copy.detail}</p>
            {saved.note && <small>“{saved.note}”</small>}
          </div>
          <button type="button" className="soft-button" onClick={() => setSaved(undefined)}>调整节奏</button>
        </div>
      ) : (
        <div className="pet-checkin-form">
          <div className="pet-checkin-question">
            <span>今天的能量大概是</span>
            <div className="pet-checkin-energy" role="group" aria-label="今天的能量">
              {([1, 2, 3, 4, 5] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  className={energy === value ? "active" : ""}
                  aria-pressed={energy === value}
                  aria-label={`${value} 分能量`}
                  onClick={() => setEnergy(value)}
                >
                  {value === 1 ? "🌧" : value === 2 ? "🌱" : value === 3 ? "☀" : value === 4 ? "✨" : "🌟"}
                </button>
              ))}
            </div>
          </div>
          <div className="pet-checkin-question">
            <span>这周想用什么节奏</span>
            <div className="pet-checkin-pace" role="group" aria-label="本周节奏">
              {(["gentle", "steady", "full"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  className={pace === value ? "active" : ""}
                  aria-pressed={pace === value}
                  onClick={() => setPace(value)}
                >
                  {weeklyCheckinPaceLabel(value)}
                </button>
              ))}
            </div>
          </div>
          <label className="pet-checkin-note">
            <span>想留一句话吗（可选）</span>
            <input
              value={note}
              maxLength={300}
              placeholder="例如：这周先把早睡守住"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="pet-checkin-footer">
            <p>{copy.headline}</p>
            <button type="button" className="primary-button" onClick={save}>记下本周节奏</button>
          </div>
        </div>
      )}
    </section>
  );
}

function PetReviewCard({
  tasks,
  onNavigate,
}: {
  tasks: readonly Task[];
  onNavigate: (route: MainRoute) => void;
}) {
  const review = useMemo(() => buildPetReviewSummary(tasks), [tasks]);
  const buckets = [review.overdue, review.blocked, review.unplanned];
  return (
    <section className={`pet-review-card ${review.clear ? "is-clear" : ""}`} aria-label="宠物回顾">
      <div className="pet-section-heading">
        <div>
          <h2>宠物回顾</h2>
          <p>{review.clear ? "没有催促，只把值得看一眼的事情留在这里。" : review.headline}</p>
        </div>
        <span className="pet-habit-badge">只读</span>
      </div>
      {review.clear ? (
        <div className="pet-review-clear">
          <CheckCircle2 size={18} aria-hidden="true" />
          <span>今天的任务暂时没有逾期、阻塞或待排时间事项。</span>
        </div>
      ) : (
        <>
          <div className="pet-review-buckets">
            {buckets.map((item) => (
              <button
                type="button"
                className={`pet-review-bucket is-${item.key} ${item.tasks.length ? "has-items" : ""}`}
                key={item.key}
                disabled={!item.tasks.length}
                onClick={() => onNavigate(item.key === "overdue" ? "today" : "all")}
              >
                <strong>{item.tasks.length}</strong>
                <span>{item.label}</span>
                <small>{item.hint}</small>
              </button>
            ))}
          </div>
          {review.nextTask && (
            <div className="pet-review-next">
              <div>
                <span>可以先看</span>
                <strong>{review.nextTask.title}</strong>
              </div>
              <button type="button" className="soft-button" onClick={() => onNavigate("all")}>打开任务</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PetHomePage({
  notify,
  tasks,
  onNavigate,
  onNavigateTask,
  onPlanTomorrow,
}: {
  notify: (message: string, kind?: ToastKind) => void;
  tasks: readonly Task[];
  onNavigate: (route: MainRoute) => void;
  onNavigateTask: (task: Task) => void;
  onPlanTomorrow: () => void;
}) {
  const { snapshot, weather, refresh, setWeather } = usePetData();
  const [section, setSection] = useState<
    "home" | "room" | "adventure" | "play" | "diary" | "memory"
  >("home");
  const [busy, setBusy] = useState(false);
  const [memoryText, setMemoryText] = useState("");
  const [editingDiary, setEditingDiary] = useState<PetDiaryEntry>();
  const [editingMemory, setEditingMemory] = useState<PetMemoryEntry>();
  const [adventure, setAdventure] = useState<PetAdventure>();

  const run = async (operation: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await operation();
      await refresh();
      notify(success, "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "操作失败", "error");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (section !== "adventure" || !window.desktopApi) return;
    void window.desktopApi.pet
      .dailyAdventure()
      .then(setAdventure)
      .catch(() => undefined);
  }, [section, snapshot?.revision]);
  if (!snapshot) {
    return (
      <main className="pet-page loading-page">
        <RefreshCw size={26} />
        正在布置小窝…
      </main>
    );
  }
  const profile = snapshot.profile;
  const hasUnlocked = (itemId: string) =>
    snapshot.inventory.some((item) => item.id === itemId);
  const levelProgress = profile.experience % 100;
  const recentRewards = snapshot.rewards.slice(0, 6);
  return (
    <main className="pet-page">
      <header className="pet-page-heading">
        <div>
          <span className="pet-page-eyebrow">TODO PET HOME</span>
          <h1>{profile.name}的小窝</h1>
          <p>你的任务、专注和共同经历，会在这里留下温和而真实的成长。</p>
        </div>
        <div className="pet-page-character">
          <PetCharacter
            name={profile.name}
            mood={snapshot.focus?.status === "running" ? "focus" : "happy"}
            interactive
            palette={snapshot.appearance.palette}
            outfit={snapshot.appearance.outfit}
          />
        </div>
      </header>
      <nav className="pet-page-tabs" aria-label="小窝导航">
        {([
          ["home", "成长"],
          ["room", "小房间"],
          ["adventure", "今日冒险"],
          ["play", "一起玩"],
          ["diary", "日记"],
          ["memory", "记忆"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={section === value ? "active" : ""}
            onClick={() => setSection(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      {section === "home" && (
        <div className="pet-dashboard">
          <section className="pet-level-card">
            <div className="pet-level-number">Lv.{profile.level}</div>
            <div>
              <strong>
                {profile.stage === "seed"
                  ? "初见精灵"
                  : profile.stage === "companion"
                    ? "默契伙伴"
                    : profile.stage === "partner"
                      ? "执行搭档"
                      : "守护伙伴"}
              </strong>
              <p>亲密度 {profile.intimacy} · 总经验 {profile.experience}</p>
              <div className="pet-level-track" aria-label={`等级进度 ${levelProgress}%`}>
                <i style={{ width: `${levelProgress}%` }} />
              </div>
            </div>
          </section>
          <section className="pet-weather-card">
            <div className="pet-weather-icon">
              {weather?.conditionLabel.includes("雨") ? "☂" : weather?.conditionLabel.includes("雪") ? "❄" : "☀"}
            </div>
            <div>
              <strong>{weather ? `${Math.round(weather.temperatureC)}℃ · ${weather.conditionLabel}` : "天气未开启"}</strong>
              <p>
                {weather
                  ? `${weather.city}${weather.stale ? " · 缓存已过期" : ` · 降水 ${weather.precipitationProbability ?? "—"}%`}`
                  : "可在设置中填写城市，不需要精确定位。"}
              </p>
            </div>
            <button
              type="button"
              className="icon-button"
              disabled={busy}
              aria-label="刷新天气"
              onClick={() =>
                void run(async () => {
                  const next = await window.desktopApi?.pet.refreshWeather(true);
                  setWeather(next);
                }, "天气已更新")
              }
            >
              <RefreshCw size={15} />
            </button>
          </section>
          <section className="pet-attributes-card">
            <h2>成长属性</h2>
            <div className="pet-attribute-grid">
              {([
                ["knowledge", "知识", "📖"],
                ["energy", "活力", "🌱"],
                ["creativity", "创造", "✨"],
                ["organization", "整理", "🧺"],
                ["courage", "勇气", "🧭"],
              ] as const).map(([key, label, icon]) => (
                <div key={key}>
                  <span>{icon}</span>
                  <small>{label}</small>
                  <strong>{profile.attributes[key]}</strong>
                </div>
              ))}
            </div>
          </section>
          <ElasticHabitsPanel />
          <EveningReviewCard
            tasks={tasks}
            focusHistory={snapshot.focusHistory}
            onPlanTomorrow={onPlanTomorrow}
          />
          <WeeklyCheckinCard tasks={tasks} notify={notify} />
          <PetReviewCard tasks={tasks} onNavigate={onNavigate} />
          <section className="pet-rewards-card">
            <div className="pet-section-heading">
              <div>
                <h2>最近收获</h2>
                <p>只奖励真实完成，不会因逾期或中断扣除。</p>
              </div>
            </div>
            {recentRewards.length ? (
              <div className="pet-reward-list">
                {recentRewards.map((reward) => (
                  <div key={reward.id}>
                    <span>{reward.source === "focus" ? "⏱" : reward.source === "task" ? "✓" : "♡"}</span>
                    <div>
                      <strong>{reward.source === "focus" ? "完成专注" : reward.source === "task" ? "完成任务" : "温馨互动"}</strong>
                      <small>{formatDateTime(reward.grantedAt)}</small>
                    </div>
                    <b>+{reward.experience} XP</b>
                  </div>
                ))}
              </div>
            ) : (
              <div className="pet-page-empty">完成第一件任务后，成长记录会出现在这里。</div>
            )}
          </section>
        </div>
      )}

      {section === "room" && (
        <section className="pet-room-section">
          <div className={`pet-room-stage room-${snapshot.appearance.roomTheme}`}>
            <span className="pet-room-window" aria-hidden="true">☁</span>
            {snapshot.appearance.decorations.includes("cloud-lamp") && (
              <span className="pet-room-decoration cloud-lamp" aria-hidden="true">☼</span>
            )}
            {snapshot.appearance.decorations.includes("plant") && (
              <span className="pet-room-decoration room-plant" aria-hidden="true">♧</span>
            )}
            {snapshot.appearance.decorations.includes("books") && (
              <span className="pet-room-decoration room-books" aria-hidden="true">▥</span>
            )}
            <PetCharacter
              name={profile.name}
              mood="happy"
              action="dance"
              interactive
              palette={snapshot.appearance.palette}
              outfit={snapshot.appearance.outfit}
            />
          </div>
          <div className="pet-room-controls">
            <div className="pet-section-heading">
              <div>
                <h2>布置你们的小房间</h2>
                <p>外观只表达陪伴，不与饥饿、连续签到或惩罚绑定。</p>
              </div>
            </div>
            <label>
              <span>身体配色</span>
              <select
                value={snapshot.appearance.palette}
                disabled={busy}
                onChange={(event) =>
                  void run(async () => {
                    await window.desktopApi?.pet.customize({
                      palette: event.target.value as typeof snapshot.appearance.palette,
                    });
                  }, "配色已更换")
                }
              >
                <option value="lavender">薰衣草</option>
                <option value="mint">薄荷云</option>
                <option value="sunset">日落糖</option>
                <option value="midnight">星夜</option>
              </select>
            </label>
            <label>
              <span>服装</span>
              <select
                value={snapshot.appearance.outfit}
                disabled={busy}
                onChange={(event) =>
                  void run(async () => {
                    await window.desktopApi?.pet.customize({
                      outfit: event.target.value as typeof snapshot.appearance.outfit,
                    });
                  }, "服装已更换")
                }
              >
                <option value="none">轻装</option>
                <option value="scarf">暖暖围巾</option>
                <option value="explorer" disabled={!hasUnlocked("outfit-explorer")}>
                  探索帽{hasUnlocked("outfit-explorer") ? "" : " · 完成冒险解锁"}
                </option>
                <option value="starlight" disabled={!hasUnlocked("outfit-starlight")}>
                  星光披风{hasUnlocked("outfit-starlight") ? "" : " · 接住任务星解锁"}
                </option>
              </select>
            </label>
            <label>
              <span>房间主题</span>
              <select
                value={snapshot.appearance.roomTheme}
                disabled={busy}
                onChange={(event) =>
                  void run(async () => {
                    await window.desktopApi?.pet.customize({
                      roomTheme: event.target.value as typeof snapshot.appearance.roomTheme,
                    });
                  }, "房间已布置")
                }
              >
                <option value="cloud-room">云朵工作室</option>
                <option value="forest-nook">森林角落</option>
                <option value="night-library">夜航书房</option>
              </select>
            </label>
            <fieldset>
              <legend>摆件</legend>
              {([[
                "cloud-lamp",
                "云灯",
                "decoration-cloud-lamp",
              ], ["plant", "小植物", "decoration-plant"], ["books", "任务书架", "decoration-books"]] as const).map(([id, label, itemId]) => {
                const enabled = snapshot.appearance.decorations.includes(id);
                const unlocked = hasUnlocked(itemId);
                return (
                  <button
                    key={id}
                    type="button"
                    className={enabled ? "active" : ""}
                    disabled={busy || !unlocked}
                    title={unlocked ? undefined : `${label}尚未解锁`}
                    onClick={() =>
                      void run(async () => {
                        await window.desktopApi?.pet.customize({
                          decorations: enabled
                            ? snapshot.appearance.decorations.filter((item) => item !== id)
                            : [...snapshot.appearance.decorations, id],
                        });
                      }, enabled ? "摆件已收起" : "摆件已放好")
                    }
                  >
                    {enabled ? <Check size={14} /> : <Plus size={14} />} {label}{unlocked ? "" : " · 待解锁"}
                  </button>
                );
              })}
            </fieldset>
          </div>
        </section>
      )}

      {section === "adventure" && (
        <section className="pet-adventure-section">
          <div className="pet-adventure-scene" aria-hidden="true">
            <span>✦</span>
            <PetCharacter
              name={profile.name}
              action={adventure?.completedAt ? "celebrate" : "inspect"}
              emotion={adventure?.completedAt ? "proud" : "curious"}
              palette={snapshot.appearance.palette}
              outfit="explorer"
            />
          </div>
          <article className="pet-adventure-card">
            <span className="pet-game-kicker">{adventure?.localDate ?? "今天"} · 每日一篇，不要求连续</span>
            <h2>{adventure?.title ?? "正在展开地图…"}</h2>
            <p>{adventure?.prompt}</p>
            {adventure?.completedAt ? (
              <div className="pet-adventure-outcome">
                <strong>你们今天选择了：{adventure.choices.find((choice) => choice.id === adventure.selectedChoiceId)?.label}</strong>
                <p>{adventure.outcome}</p>
                <small>获得一颗冒险星与温和成长；错过一天不会失去任何东西。</small>
              </div>
            ) : (
              <div className="pet-adventure-choices">
                {adventure?.choices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    className="soft-button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await window.desktopApi?.pet.completeAdventure(adventure.id, choice.id);
                        const next = await window.desktopApi?.pet.dailyAdventure(adventure.localDate);
                        if (next) setAdventure(next);
                      }, "今日冒险已写入日记")
                    }
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            )}
          </article>
        </section>
      )}

      {section === "play" && (
        <PetPlayground
          disabled={busy}
          onComplete={(game, score, durationSeconds) =>
            void run(async () => {
              await window.desktopApi?.pet.recordMiniGame({
                game,
                score,
                durationSeconds,
              });
            }, game === "breathing" ? "呼吸完成，慢一点也很好" : `接住了 ${score} 颗任务星`)
          }
        />
      )}

      {section === "diary" && (
        <section className="pet-journal-section">
          <div className="pet-section-heading">
            <div>
              <h2>共同日记</h2>
              <p>默认由本地事实模板生成；你可以随时编辑或删除。</p>
            </div>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const entry = await window.desktopApi?.pet.generateDiary();
                  if (entry) setEditingDiary(entry);
                }, "今天的日记已生成")
              }
            >
              <FileText size={16} />
              生成今日日记
            </button>
          </div>
          {editingDiary && (
            <div className="pet-diary-editor">
              <input
                value={editingDiary.title}
                onChange={(event) =>
                  setEditingDiary((current) =>
                    current ? { ...current, title: event.target.value } : current,
                  )
                }
                aria-label="日记标题"
              />
              <textarea
                rows={8}
                value={editingDiary.content}
                onChange={(event) =>
                  setEditingDiary((current) =>
                    current ? { ...current, content: event.target.value } : current,
                  )
                }
                aria-label="日记内容"
              />
              <div>
                <button type="button" className="soft-button" onClick={() => setEditingDiary(undefined)}>取消</button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const saved = await window.desktopApi?.pet.updateDiary(
                        editingDiary.id,
                        { title: editingDiary.title, content: editingDiary.content },
                      );
                      if (saved) setEditingDiary(saved);
                    }, "日记已保存")
                  }
                >
                  保存
                </button>
              </div>
            </div>
          )}
          <div className="pet-diary-list">
            {snapshot.diary.map((entry) => (
              <article key={entry.id}>
                <div>
                  <span>{entry.localDate}</span>
                  <small>{entry.generation === "local-template" ? "本地事实模板" : entry.generation === "model" ? "AI 增强" : "手写"}</small>
                </div>
                <h3>{entry.title}</h3>
                <p>{entry.content}</p>
                {entry.taskIds?.length ? (
                  <div className="pet-diary-task-links" aria-label="日记关联任务">
                    <span>一起完成</span>
                    <div>
                      {entry.taskIds.map((taskId) => {
                        const task = tasks.find((candidate) => candidate.id === taskId);
                        return task ? (
                          <button
                            key={task.id}
                            type="button"
                            className="pet-diary-task-link"
                            onClick={() => onNavigateTask(task)}
                            title="打开任务"
                          >
                            <CheckCircle2 size={13} />
                            <span>{task.title}</span>
                          </button>
                        ) : (
                          <span key={taskId} className="pet-diary-task-missing">
                            任务已移除
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                <footer>
                  <span>完成 {entry.completedTaskCount} · 专注 {Math.round(entry.focusSeconds / 60)} 分钟</span>
                  <button type="button" className="ghost-button" onClick={() => setEditingDiary(entry)}>编辑</button>
                  <button
                    type="button"
                    className="ghost-button danger-text"
                    onClick={() =>
                      void run(async () => {
                        await window.desktopApi?.pet.deleteDiary(entry.id);
                        if (editingDiary?.id === entry.id) setEditingDiary(undefined);
                      }, "日记已删除")
                    }
                  >删除</button>
                </footer>
              </article>
            ))}
            {!snapshot.diary.length && <div className="pet-page-empty">还没有日记。生成今日记录，看看你们一起完成了什么。</div>}
          </div>
        </section>
      )}

      {section === "memory" && (
        <section className="pet-memory-section">
          <div className="pet-section-heading">
            <div>
              <h2>可控记忆</h2>
              <p>只有你明确保存的内容才进入长期记忆，可暂停、编辑或删除。</p>
            </div>
          </div>
          <div className="pet-memory-composer">
            <input
              value={memoryText}
              onChange={(event) => setMemoryText(event.target.value)}
              placeholder={`例如：我喜欢在上午处理需要深度思考的任务`}
              aria-label="新增长期记忆"
            />
            <button
              type="button"
              className="primary-button"
              disabled={busy || !memoryText.trim()}
              onClick={() =>
                void run(async () => {
                  await window.desktopApi?.pet.addMemory({
                    kind: "preference",
                    content: memoryText,
                  });
                  setMemoryText("");
                }, "记忆已保存")
              }
            >
              保存记忆
            </button>
          </div>
          <div className="pet-memory-list">
            {snapshot.memories.map((memory) => (
              <div key={memory.id} className={!memory.enabled ? "is-paused" : ""}>
                <Switch
                  checked={memory.enabled}
                  onChange={(enabled) =>
                    void run(async () => {
                      await window.desktopApi?.pet.updateMemory(memory.id, { enabled });
                    }, enabled ? "记忆已启用" : "记忆已暂停")
                  }
                  label={`${memory.enabled ? "暂停" : "启用"}记忆`}
                />
                {editingMemory?.id === memory.id ? (
                  <input
                    className="pet-memory-edit"
                    value={editingMemory.content}
                    aria-label="编辑记忆"
                    onChange={(event) =>
                      setEditingMemory((current) =>
                        current
                          ? { ...current, content: event.target.value }
                          : current,
                      )
                    }
                  />
                ) : (
                  <p>{memory.content}</p>
                )}
                <small>{memory.kind === "preference" ? "偏好" : memory.kind === "relationship" ? "关系记忆" : "共同经历"} · 用户批准</small>
                <div className="pet-memory-actions">
                  {editingMemory?.id === memory.id ? (
                    <>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => setEditingMemory(undefined)}
                      >取消</button>
                      <button
                        type="button"
                        className="soft-button"
                        disabled={busy || !editingMemory.content.trim()}
                        onClick={() =>
                          void run(async () => {
                            await window.desktopApi?.pet.updateMemory(memory.id, {
                              content: editingMemory.content,
                            });
                            setEditingMemory(undefined);
                          }, "记忆已更新")
                        }
                      >保存</button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setEditingMemory(memory)}
                    >编辑</button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="删除记忆"
                    onClick={() =>
                      void run(async () => {
                        await window.desktopApi?.pet.deleteMemory(memory.id);
                        if (editingMemory?.id === memory.id) setEditingMemory(undefined);
                      }, "记忆已删除")
                    }
                  ><Trash2 size={15} /></button>
                </div>
              </div>
            ))}
            {!snapshot.memories.length && <div className="pet-page-empty">这里是空的。Todo Pet 不会擅自把任务或对话升级为长期记忆。</div>}
          </div>
        </section>
      )}
    </main>
  );
}

function SettingsPage({
  notify,
}: {
  notify: (message: string, kind?: ToastKind) => void;
}) {
  const [section, setSection] = useState<SettingsSection>("general");
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultSettings);
  const projectController = useTaskController("all", "");
  const projectReminderOptions = useMemo(
    () => Array.from(new Set(
      projectController.tasks
        .map((task) => task.projectId?.trim())
        .filter((projectId): projectId is string => Boolean(projectId)),
    )).sort((left, right) => left.localeCompare(right, "zh-CN")).slice(0, 100),
    [projectController.tasks],
  );
  const [apiKey, setApiKey] = useState("");
  const [fallbackApiKey, setFallbackApiKey] = useState("");
  const actionPacks = useInstalledPetActionPacks();
  const taskTemplates = useTaskTemplates();
  const [actionPackJson, setActionPackJson] = useState("");
  const [actionPackError, setActionPackError] = useState("");
  const [taskTemplateJson, setTaskTemplateJson] = useState("");
  const [taskTemplateError, setTaskTemplateError] = useState("");
  const [feishuSecret, setFeishuSecret] = useState("");
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatusView>();
  const [dataPreview, setDataPreview] = useState<ReadyDataPreview>();
  const [modelUsage, setModelUsage] = useState<ModelUsageStatus>();
  const [connectionTest, setConnectionTest] =
    useState<ModelConnectionTestResult>();
  const [importStrategy, setImportStrategy] =
    useState<DataImportStrategyView>("skip");
  const [clearDataSheet, setClearDataSheet] = useState(false);
  const [disconnectSheet, setDisconnectSheet] = useState(false);
  const [clearSelection, setClearSelection] = useState({
    tasks: true,
    drafts: true,
    operations: true,
    resetSettings: false,
  });
  const [markdownIncludesHistory, setMarkdownIncludesHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  const activeAiProvider =
    appSettings.ai.routing === "local-only"
      ? appSettings.ai.fallback
      : appSettings.ai;
  const activeAiModelConfigured = Boolean(activeAiProvider.model.trim());
  const activeAiAuthConfigured =
    activeAiProvider.authMode === "none" || Boolean(activeAiProvider.credentialId);
  const fallbackAiReady =
    appSettings.ai.fallback.enabled &&
    Boolean(appSettings.ai.fallback.model.trim()) &&
    (appSettings.ai.fallback.authMode === "none" ||
      Boolean(appSettings.ai.fallback.credentialId));
  useEffect(() => {
    if (!window.desktopApi) return undefined;
    void window.desktopApi.settings
      .get()
      .then(setAppSettings)
      .catch(() => notify("读取设置失败", "error"));
    void window.desktopApi.feishu.status().then(setFeishuStatus);
    void window.desktopApi.agent
      .modelUsage()
      .then(setModelUsage)
      .catch(() => undefined);
    const offSettings =
      window.desktopApi.events.onSettingsChanged(setAppSettings);
    const offFeishu = window.desktopApi.events.onFeishuStatus(setFeishuStatus);
    return () => {
      offSettings();
      offFeishu();
    };
  }, [notify]);
  const persist = async (
    next: AppSettings,
    message?: string,
  ): Promise<AppSettings | undefined> => {
    setAppSettings(next);
    if (!window.desktopApi) {
      if (message) notify(message, "success");
      return next;
    }
    setSaving(true);
    try {
      const saved = await window.desktopApi.settings.replace(next);
      setAppSettings(saved);
      if (message) notify(message, "success");
      return saved;
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "保存设置失败",
        "error",
      );
      return undefined;
    } finally {
      setSaving(false);
    }
  };
  const update = (patch: Partial<AppSettings>, message?: string) =>
    void persist({ ...appSettings, ...patch }, message);
  const saveApiKey = async () => {
    if (
      appSettings.ai.authMode === "none" ||
      !apiKey.trim() ||
      !window.desktopApi
    )
      return;
    setSaving(true);
    try {
      const credential = await window.desktopApi.settings.setCredential({
        kind: "ai-api-key",
        value: apiKey,
        id: appSettings.ai.credentialId,
      });
      await persist(
        {
          ...appSettings,
          ai: { ...appSettings.ai, credentialId: credential.id },
        },
        "API Key 已加密保存",
      );
      setApiKey("");
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "安全存储不可用",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };
  const saveFallbackApiKey = async () => {
    const fallback = appSettings.ai.fallback;
    if (
      fallback.authMode === "none" ||
      !fallbackApiKey.trim() ||
      !window.desktopApi
    )
      return;
    setSaving(true);
    try {
      const credential = await window.desktopApi.settings.setCredential({
        kind: "ai-api-key",
        value: fallbackApiKey,
        id: fallback.credentialId,
      });
      await persist(
        {
          ...appSettings,
          ai: {
            ...appSettings.ai,
            fallback: { ...fallback, credentialId: credential.id },
          },
        },
        "备用模型 API Key 已加密保存",
      );
      setFallbackApiKey("");
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "备用模型凭据保存失败",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };
  const installActionPack = () => {
    const result = parsePetActionPackJson(actionPackJson);
    if (!result.ok) {
      setActionPackError(result.message);
      return;
    }
    actionPacks.install(result.pack);
    actionPacks.activate(result.pack.id);
    setActionPackJson("");
    setActionPackError("");
    notify(`已安装动作包「${result.pack.name}」`, "success");
  };
  const installTaskTemplate = () => {
    const result = parseTaskTemplateJson(taskTemplateJson);
    if (!result.ok) {
      setTaskTemplateError(result.message);
      return;
    }
    taskTemplates.install(result.template);
    setTaskTemplateJson("");
    setTaskTemplateError("");
    notify(`已安装工作流模板「${result.template.name}」`, "success");
  };
  const testModelConnection = async () => {
    if (!window.desktopApi) return;
    setSaving(true);
    setConnectionTest(undefined);
    try {
      const result = await window.desktopApi.agent.testModelConnection();
      setConnectionTest(result);
      setModelUsage(result.usage);
      notify(
        result.ok ? `模型连接成功 · ${result.latencyMs} ms` : result.message,
        result.ok ? "success" : "error",
      );
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "模型连接测试失败",
        "error",
      );
      setModelUsage(
        await window.desktopApi.agent.modelUsage().catch(() => undefined),
      );
    } finally {
      setSaving(false);
    }
  };
  const connectFeishu = async () => {
    if (!window.desktopApi) return;
    setSaving(true);
    try {
      let next = appSettings;
      if (next.feishu.mode === "personal-direct") {
        const saved = await window.desktopApi.settings.replace(next);
        setAppSettings(saved);
        await window.desktopApi.feishu.beginPersonalConnect();
        notify(
          "已打开飞书确认页；创建专属连接应用后会继续账号授权",
          "success",
        );
        return;
      }
      const storesLocalAppSecret =
        next.feishu.mode === "existing-direct" ||
        next.feishu.mode === "local-development";
      if (storesLocalAppSecret && feishuSecret.trim()) {
        const credentialRequest: SetCredentialRequest = {
          kind: "feishu-app-secret",
          value: feishuSecret,
        };
        if (next.feishu.mode === "local-development") {
          credentialRequest.id = next.feishu.appSecretCredentialId;
        }
        const credential =
          await window.desktopApi.settings.setCredential(credentialRequest);
        next = {
          ...next,
          feishu: {
            ...next.feishu,
            appSecretCredentialId: credential.id,
            tokenCredentialId:
              next.feishu.mode === "existing-direct"
                ? `${credential.id}-token`
                : next.feishu.tokenCredentialId,
            configured: false,
          },
        };
        setAppSettings(next);
        setFeishuSecret("");
      }
      if (
        next.feishu.mode === "existing-direct" &&
        !next.feishu.configured &&
        !feishuSecret.trim()
      ) {
        throw new Error("请填写已有应用的 App Secret；它会加密保存在系统凭据库");
      }
      const request = feishuRequestFromSettings(next);
      if (!request) {
        throw new Error(
          next.feishu.mode === "relay"
            ? "请填写使用 HTTPS 的 OAuth Relay 地址"
            : next.feishu.mode === "existing-direct"
              ? "请填写已有应用的 App ID 和 App Secret"
              : "请填写 App ID、加密保存 App Secret，并确认开发者模式风险",
        );
      }
      const configured = await window.desktopApi.feishu.configure(request);
      setFeishuStatus(configured);
      await window.desktopApi.feishu.beginOAuth();
      notify("飞书授权页已打开；授权完成后会自动开始同步", "success");
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "飞书连接失败",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };
  const disconnectFeishu = async (
    strategy: "keep" | "convert-local" | "remove-cache",
  ) => {
    if (!window.desktopApi) return;
    setSaving(true);
    try {
      const cachedTasks =
        strategy === "keep"
          ? []
          : await window.desktopApi.tasks.list({
              sourceTypes: ["feishu"],
              includeDeleted: true,
            });
      setFeishuStatus(await window.desktopApi.feishu.disconnect());
      for (const task of cachedTasks) {
        if (strategy === "convert-local") {
          const wasDeleted = Boolean(task.deletedAt);
          if (wasDeleted) await window.desktopApi.tasks.restore(task.id);
          await window.desktopApi.tasks.update({
            id: task.id,
            patch: {
              source: { type: "local" },
              sync: { status: "local" },
              completionMode: null,
              currentUserRole: null,
              currentUserCompleted: null,
            },
          });
          if (wasDeleted) await window.desktopApi.tasks.moveToTrash(task.id);
          continue;
        }
        if (!task.deletedAt) {
          await window.desktopApi.tasks.update({
            id: task.id,
            patch: {
              source: { type: "local" },
              sync: { status: "local" },
            },
          });
          await window.desktopApi.tasks.moveToTrash(task.id);
        }
        await window.desktopApi.tasks.purge(task.id);
      }
      setDisconnectSheet(false);
      notify(
        strategy === "keep"
          ? "已断开飞书；本地缓存、映射和冲突记录均已保留"
          : strategy === "convert-local"
            ? `已断开飞书，并将 ${cachedTasks.length} 项缓存转为本地任务`
            : `已断开飞书，并移除 ${cachedTasks.length} 项本机缓存；飞书远端未删除`,
        "success",
      );
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "断开连接失败",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };
  const exportData = async () => {
    if (!window.desktopApi) return;
    setSaving(true);
    try {
      const result = await window.desktopApi.data.exportToFile({
        redaction: "private",
      });
      if (result.status === "exported")
        notify(
          `已安全导出 ${Math.ceil(result.bytes / 1024)} KB 数据`,
          "success",
        );
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "导出失败", "error");
    } finally {
      setSaving(false);
    }
  };
  const exportMarkdownData = async () => {
    if (!window.desktopApi) return;
    setSaving(true);
    try {
      const result = await window.desktopApi.data.exportMarkdownToFile({
        redaction: "private",
        include: {
          tasks: true,
          projects: true,
          lists: true,
          operations: markdownIncludesHistory,
        },
      });
      if (result.status === "exported")
        notify(
          `已导出可读 Markdown${markdownIncludesHistory ? "（含事件摘要）" : ""}（${Math.ceil(result.bytes / 1024)} KB）`,
          "success",
        );
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "Markdown 导出失败",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };
  const previewImport = async () => {
    if (!window.desktopApi) return;
    setSaving(true);
    try {
      const result = await window.desktopApi.data.previewImport();
      if (result.status === "ready") {
        setDataPreview(result);
        setImportStrategy("skip");
      }
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "导入文件无效",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };
  const cancelImport = () => {
    if (dataPreview)
      void window.desktopApi?.data.cancelPreview(dataPreview.previewToken);
    setDataPreview(undefined);
  };
  const commitImport = async () => {
    if (!window.desktopApi || !dataPreview) return;
    setSaving(true);
    try {
      const committed = await window.desktopApi.data.commitImport(
        dataPreview.previewToken,
        importStrategy,
      );
      notify(
        `导入完成：新增 ${committed.result.tasks.create} 项任务`,
        "success",
      );
      setDataPreview(undefined);
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "导入提交失败",
        "error",
      );
      setDataPreview(undefined);
    } finally {
      setSaving(false);
    }
  };
  const clearLocalData = async () => {
    if (!window.desktopApi || !Object.values(clearSelection).some(Boolean))
      return;
    setSaving(true);
    try {
      const result =
        await window.desktopApi.data.clearLocalData(clearSelection);
      if (result.status === "cleared") {
        notify(
          `已清除 ${result.tasks} 项任务、${result.drafts} 份草稿`,
          "success",
        );
        setClearDataSheet(false);
        setAppSettings(await window.desktopApi.settings.get());
      }
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "清除数据失败",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };
  const nav: Array<[SettingsSection, ReactNode, string]> = [
    ["general", <Settings size={17} />, "通用"],
    ["floating", <PanelTop size={17} />, "Todo Pet"],
    ["notifications", <Bell size={17} />, "提醒"],
    ["integrations", <Cloud size={17} />, "飞书"],
    ["ai", <Sparkles size={17} />, "模型与 Agent"],
    ["permissions", <ShieldCheck size={17} />, "权限中心"],
    ["privacy", <LockKeyhole size={17} />, "隐私与数据"],
  ];
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置导航">
        {nav.map(([id, icon, label]) => (
          <button
            key={id}
            type="button"
            className={`nav-button ${section === id ? "active" : ""}`}
            onClick={() => setSection(id)}
          >
            {icon}
            {label}
          </button>
        ))}
      </nav>
      <main className="settings-content" aria-busy={saving}>
        {section === "general" && (
          <section className="settings-section">
            <h1>通用</h1>
            <p>应用行为只保存在当前设备。</p>
            <div className="settings-row">
              <div>
                <strong>外观</strong>
                <p>跟随系统时会自动切换深浅色</p>
              </div>
              <select
                className="settings-input"
                value={appSettings.theme}
                onChange={(event) =>
                  void persist(
                    {
                      ...appSettings,
                      theme: event.target.value as AppSettings["theme"],
                    },
                    "外观已更新",
                  )
                }
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>开机启动</strong>
                <p>登录系统后在后台启动并显示菜单栏/托盘图标</p>
              </div>
              <Switch
                checked={appSettings.launchAtLogin}
                onChange={(value) => {
                  if (window.desktopApi)
                    void window.desktopApi.shell
                      .setLaunchAtLogin(value)
                      .then((next) => {
                        setAppSettings(next);
                        notify(
                          value ? "已启用开机启动" : "已关闭开机启动",
                          "success",
                        );
                      });
                  else update({ launchAtLogin: value });
                }}
                label="开机启动"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>快速录入快捷键</strong>
                <p>冲突时会提示重新设置</p>
              </div>
              <input
                className="settings-input"
                value={appSettings.quickCaptureShortcut}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    quickCaptureShortcut: event.target.value,
                  }))
                }
                onBlur={() => void persist(appSettings, "快捷键已更新")}
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>关闭主窗口后驻留</strong>
                <p>提醒、同步和 Todo Pet 继续工作</p>
              </div>
              <Switch
                checked={appSettings.closeToTray}
                onChange={(value) =>
                  update({ closeToTray: value }, "窗口行为已更新")
                }
                label="关闭后驻留"
              />
            </div>
            <div className="settings-subheading">
              <span>任务规划</span>
              <p>调整 Todo Pet 选择“下一步”时看重什么；只影响本地建议，不改任务事实或飞书。</p>
            </div>
            {urgencyWeightLabels.map(({ key, label, description }) => (
              <div className="settings-row" key={key}>
                <div>
                  <strong>{label}</strong>
                  <p>{description}</p>
                </div>
                <div className="settings-number-control">
                  <input
                    className="settings-input"
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    aria-label={`${label}权重`}
                    value={appSettings.planning.urgencyWeights[key]}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next)) return;
                      setAppSettings((current) => ({
                        ...current,
                        planning: {
                          ...current.planning,
                          urgencyWeights: {
                            ...current.planning.urgencyWeights,
                            [key]: Math.min(100, Math.max(0, Math.round(next))),
                          },
                        },
                      }));
                    }}
                    onBlur={() => void persist(appSettings, "任务规划偏好已更新")}
                  />
                  <span>/ 100</span>
                </div>
              </div>
            ))}
            <div className="settings-row">
              <div>
                <strong>恢复默认权重</strong>
                <p>截止 70 · 今天 90 · 优先级 40 · 短任务 10</p>
              </div>
              <button
                type="button"
                className="soft-button"
                disabled={saving}
                onClick={() =>
                  void persist(
                    {
                      ...appSettings,
                      planning: structuredClone(defaultSettings.planning),
                    },
                    "已恢复默认规划偏好",
                  )
                }
              >
                恢复默认
              </button>
            </div>
          </section>
        )}
        {section === "floating" && (
          <section className="settings-section">
            <h1>Todo Pet 与桌面</h1>
            <p>桌面宠物、随身面板和主应用保持同一任务语境。</p>
            <div className="settings-subheading">
              <span>身份与外观</span>
              <p>同一个名字会用于桌面陪伴、提醒和对话。</p>
            </div>
            <div className="settings-row">
              <div>
                <strong>宠物名字</strong>
                <p>默认叫“小序”，可以随时更改</p>
              </div>
              <input
                className="settings-input"
                aria-label="宠物名字"
                maxLength={80}
                value={appSettings.persona.name}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    persona: { ...current.persona, name: event.target.value },
                  }))
                }
                onBlur={() => void persist(appSettings, "宠物名字已更新")}
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>显示 Todo Pet</strong>
                <p>让小序留在桌面陪伴；也可从菜单栏或托盘重新打开</p>
              </div>
              <Switch
                checked={appSettings.floating.enabled}
                onChange={(value) => {
                  if (window.desktopApi)
                    void window.desktopApi.shell
                      .setFloatingVisible(value)
                      .then(setAppSettings);
                  else
                    void persist({
                      ...appSettings,
                      floating: { ...appSettings.floating, enabled: value },
                    });
                }}
                label="显示 Todo Pet"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>宠物大小</strong>
                <p>只调整收起后的宠物与任务气泡，不影响展开面板</p>
              </div>
              <div className="settings-number-control pet-scale-control">
                <input
                  className="settings-input"
                  type="range"
                  aria-label="Todo Pet 大小"
                  min={75}
                  max={125}
                  step={5}
                  value={appSettings.floating.scalePercent}
                  onChange={(event) =>
                    setAppSettings((current) => ({
                      ...current,
                      floating: {
                        ...current.floating,
                        scalePercent: Number(event.target.value),
                      },
                    }))
                  }
                  onPointerUp={() =>
                    void persist(appSettings, "Todo Pet 大小已更新")
                  }
                  onKeyUp={() =>
                    void persist(appSettings, "Todo Pet 大小已更新")
                  }
                />
                <span>{appSettings.floating.scalePercent}%</span>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <strong>悬停自动展开</strong>
                <p>鼠标连续停留达到这个时间后展开；提前移开不会触发</p>
              </div>
              <div className="settings-number-control">
                <input
                  className="settings-input"
                  type="number"
                  aria-label="悬停自动展开延迟"
                  min={0.2}
                  max={5}
                  step={0.1}
                  value={appSettings.floating.hoverExpandDelayMs / 1000}
                  onChange={(event) => {
                    const nextDelayMs = Math.round(
                      Number(event.target.value) * 1000,
                    );
                    if (nextDelayMs < 200 || nextDelayMs > 5000) return;
                    setAppSettings((current) => ({
                      ...current,
                      floating: {
                        ...current.floating,
                        hoverExpandDelayMs: nextDelayMs,
                      },
                    }));
                  }}
                  onBlur={() =>
                    void persist(appSettings, "悬停展开延迟已更新")
                  }
                />
                <span>秒</span>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <strong>始终置顶</strong>
                <p>Todo Pet 会持续显示在普通窗口上方</p>
              </div>
              <span className="status-pill success">
                <Check size={15} aria-hidden="true" />
                已开启
              </span>
            </div>
            <div className="settings-row">
              <div>
                <strong>锁定位置</strong>
                <p>避免拖动 Todo Pet 时误触</p>
              </div>
              <Switch
                checked={appSettings.floating.locked}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    floating: { ...appSettings.floating, locked: value },
                  })
                }
                label="锁定 Todo Pet 位置"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>全屏时隐藏</strong>
                <p>演示、视频或游戏进入全屏后自动隐藏</p>
              </div>
              <Switch
                checked={appSettings.floating.hideInFullscreen}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    floating: {
                      ...appSettings.floating,
                      hideInFullscreen: value,
                    },
                  })
                }
                label="全屏时隐藏 Todo Pet"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>演示隐私模式</strong>
                <p>隐藏 Todo Pet、Today、对话建议和动态中的任务信息</p>
              </div>
              <Switch
                checked={appSettings.floating.privacyMode}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    floating: { ...appSettings.floating, privacyMode: value },
                  })
                }
                label="演示隐私模式"
              />
            </div>
            <div className="settings-subheading">
              <span>陪伴行为</span>
              <p>互动默认克制，不使用惩罚、连续签到压力或负面措辞。</p>
            </div>
            <div className="settings-row">
              <div>
                <strong>陪伴策略模板</strong>
                <p>一键组合主动程度、提醒语气、动作性格和专注自动衔接；也可以逐项改成自定义。</p>
              </div>
              <select
                className="settings-input"
                aria-label="陪伴策略模板"
                value={detectCompanionStrategy(appSettings)}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "custom") return;
                  void persist(
                    applyCompanionStrategy(appSettings, value as CompanionStrategy),
                    `${companionStrategyLabels[value as CompanionStrategy]}已启用`,
                  );
                }}
              >
                <option value="custom">自定义</option>
                {(Object.keys(companionStrategyLabels) as CompanionStrategy[]).map((strategy) => (
                  <option value={strategy} key={strategy}>{companionStrategyLabels[strategy]}</option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>点击互动</strong>
                <p>每天首次主动互动会留下少量亲密度记录</p>
              </div>
              <Switch
                checked={appSettings.pet.interactionsEnabled}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    pet: { ...appSettings.pet, interactionsEnabled: value },
                  })
                }
                label="点击互动"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>主动陪伴</strong>
                <p>允许低频的计划、休息、天气与同步提示</p>
              </div>
              <Switch
                checked={appSettings.pet.proactiveMessages}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    pet: { ...appSettings.pet, proactiveMessages: value },
                  })
                }
                label="主动陪伴"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>动作性格</strong>
                <p>决定 20 种待机动作出现的组合与节奏</p>
              </div>
              <select
                className="settings-input"
                value={appSettings.pet.actionPack}
                onChange={(event) =>
                  void persist({
                    ...appSettings,
                    pet: {
                      ...appSettings.pet,
                      actionPack: event.target.value as AppSettings["pet"]["actionPack"],
                    },
                  }, "动作性格已更新")
                }
              >
                <option value="balanced">自然平衡</option>
                <option value="calm">安静陪伴</option>
                <option value="playful">活泼好奇</option>
                <option value="focused">专注搭档</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>动作幅度</strong>
                <p>“舒缓”会保留呼吸和眨眼，但降低跳动与位移</p>
              </div>
              <select
                className="settings-input"
                value={appSettings.pet.animationIntensity}
                onChange={(event) =>
                  void persist({
                    ...appSettings,
                    pet: {
                      ...appSettings.pet,
                      animationIntensity: event.target.value as AppSettings["pet"]["animationIntensity"],
                    },
                  }, "动作幅度已更新")
                }
              >
                <option value="lively">鲜明</option>
                <option value="gentle">舒缓</option>
              </select>
            </div>
            <div className="settings-subheading">
              <span>可安装动作包</span>
              <p>动作包只是一组已有待机动作，不允许脚本、网络请求、文件读取或外部代码。</p>
            </div>
            <div className="settings-row">
              <div>
                <strong>当前动作包</strong>
                <p>{actionPacks.activePack?.description ?? "未选择自定义包，使用上面的内置动作性格"}</p>
              </div>
              <select
                className="settings-input"
                aria-label="当前自定义动作包"
                value={actionPacks.activeId ?? ""}
                onChange={(event) => actionPacks.activate(event.target.value || undefined)}
              >
                <option value="">使用内置动作性格</option>
                {actionPacks.packs.map((pack) => (
                  <option value={pack.id} key={pack.id}>{pack.name}</option>
                ))}
              </select>
            </div>
            <div className="action-pack-installer">
              <textarea
                className="settings-input action-pack-json"
                aria-label="动作包 JSON"
                value={actionPackJson}
                onChange={(event) => {
                  setActionPackJson(event.target.value);
                  setActionPackError("");
                }}
                placeholder={'粘贴动作包 JSON，例如：{\n  "id": "cozy-reading",\n  "name": "安静阅读",\n  "description": "更多阅读和休息动作",\n  "idleActions": ["read", "drink", "stretch", "nap"]\n}'}
                rows={5}
              />
              <div className="settings-actions">
                <button type="button" className="soft-button" disabled={!actionPackJson.trim()} onClick={installActionPack}>
                  <Upload size={15} /> 安装 / 更新动作包
                </button>
                {actionPacks.activePack && (
                  <button type="button" className="danger-button" onClick={() => {
                    const removed = actionPacks.activePack;
                    if (!removed) return;
                    actionPacks.remove(removed.id);
                    notify(`已移除动作包「${removed.name}」`, "success");
                  }}>
                    <Trash2 size={15} /> 移除当前包
                  </button>
                )}
              </div>
              {actionPackError && <p className="form-error">{actionPackError}</p>}
            </div>
            <div className="settings-subheading">
              <span>工作流模板</span>
              <p>把会议、研究或发布流程保存成几步任务；使用时仍会先预览，再由你确认创建。</p>
            </div>
            <div className="settings-row">
              <div>
                <strong>内置模板</strong>
                <p>{taskTemplates.templates.length} 个模板可在快速录入中使用，模板只保存在本机。</p>
              </div>
              <span className="settings-inline-note">本地优先</span>
            </div>
            <div className="action-pack-installer task-template-installer">
              <textarea
                className="settings-input action-pack-json"
                aria-label="工作流模板 JSON"
                value={taskTemplateJson}
                onChange={(event) => {
                  setTaskTemplateJson(event.target.value);
                  setTaskTemplateError("");
                }}
                placeholder={'粘贴模板 JSON，例如：{\n  "id": "launch-checklist",\n  "name": "发布检查",\n  "description": "发布前逐项确认",\n  "defaultSource": "local",\n  "steps": [{ "id": "check", "titleTemplate": "检查：{{title}}", "estimatedMinutes": 30 }]\n}'}
                rows={5}
              />
              <div className="settings-actions">
                <button type="button" className="soft-button" disabled={!taskTemplateJson.trim()} onClick={installTaskTemplate}>
                  <Upload size={15} /> 安装 / 更新模板
                </button>
              </div>
              {taskTemplateError && <p className="form-error">{taskTemplateError}</p>}
              {taskTemplates.templates.filter((template) => !["meeting-follow-up", "research-brief", "publish-article"].includes(template.id)).map((template) => (
                <div className="task-template-installed" key={template.id}>
                  <span><strong>{template.name}</strong><small>{template.steps.length} 步 · {template.description}</small></span>
                  <button type="button" className="icon-button" aria-label={`移除模板${template.name}`} onClick={() => {
                    taskTemplates.remove(template.id);
                    notify(`已移除模板「${template.name}」`, "success");
                  }}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <div className="settings-row">
              <div>
                <strong>主动交流间隔</strong>
                <p>专注、会议、静音、夜间和全屏状态始终优先免打扰</p>
              </div>
              <div className="settings-number-control">
                <input
                  className="settings-input"
                  type="number"
                  aria-label="主动交流间隔"
                  min={15}
                  max={240}
                  step={15}
                  value={appSettings.pet.proactiveIntervalMinutes}
                  onChange={(event) =>
                    setAppSettings((current) => ({
                      ...current,
                      pet: {
                        ...current.pet,
                        proactiveIntervalMinutes: Number(event.target.value),
                      },
                    }))
                  }
                  onBlur={() => void persist(appSettings, "主动交流间隔已更新")}
                />
                <span>分钟</span>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <strong>每日主动陪伴预算</strong>
                <p>宠物每天主动开口的次数；设为 0 表示不限次数</p>
              </div>
              <div className="settings-number-control">
                <input
                  className="settings-input"
                  type="number"
                  aria-label="每日主动陪伴预算"
                  min={0}
                  max={20}
                  step={1}
                  value={appSettings.pet.proactiveDailyLimit}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    setAppSettings((current) => ({
                      ...current,
                      pet: {
                        ...current.pet,
                        proactiveDailyLimit: Math.min(20, Math.max(0, Math.round(value))),
                      },
                    }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  onBlur={() => void persist(appSettings, "每日主动陪伴预算已更新")}
                />
                <span>次</span>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <strong>会议模式</strong>
                <p>宠物保持呼吸与眨眼，但不主动说话或弹出提醒</p>
              </div>
              <Switch
                checked={appSettings.pet.meetingMode}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    pet: { ...appSettings.pet, meetingMode: value },
                  })
                }
                label="会议模式"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>季节小事件</strong>
                <p>只改变小装饰和偶发动作，不影响任务与成长数值</p>
              </div>
              <Switch
                checked={appSettings.pet.seasonalEvents}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    pet: { ...appSettings.pet, seasonalEvents: value },
                  })
                }
                label="季节小事件"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>身心休息提醒</strong>
                <p>长时间专注时提醒喝水、远眺和活动</p>
              </div>
              <Switch
                checked={appSettings.pet.wellbeingReminders}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    pet: { ...appSettings.pet, wellbeingReminders: value },
                  })
                }
                label="身心休息提醒"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>关系记忆</strong>
                <p>关闭时不会从对话自动形成长期记忆；手工记忆仍由你管理</p>
              </div>
              <Switch
                checked={appSettings.pet.relationshipMemory}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    pet: { ...appSettings.pet, relationshipMemory: value },
                  })
                }
                label="关系记忆"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>共同日记</strong>
                <p>每天首次启动时用本地任务与专注事实生成，可随时编辑或删除</p>
              </div>
              <Switch
                checked={appSettings.pet.autoDiary}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    pet: { ...appSettings.pet, autoDiary: value },
                  })
                }
                label="自动生成共同日记"
              />
            </div>
            <div className="settings-subheading">
              <span>专注节奏</span>
              <p>桌面宠物会陪伴计时；休息与下一轮是否自动开始由你决定。</p>
            </div>
            {([
              ["focusMinutes", "专注", 1, 240],
              ["shortBreakMinutes", "短休息", 1, 60],
              ["longBreakMinutes", "长休息", 1, 120],
              ["cycles", "每组轮数", 1, 12],
            ] as const).map(([key, label, min, max]) => (
              <div className="settings-row" key={key}>
                <div>
                  <strong>{label}</strong>
                  <p>{key === "cycles" ? "完成后进入长休息" : "默认预设，可在专注页快速改选"}</p>
                </div>
                <div className="settings-number-control">
                  <input
                    className="settings-input"
                    type="number"
                    aria-label={label}
                    min={min}
                    max={max}
                    value={appSettings.focus[key]}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value)) return;
                      setAppSettings((current) => ({
                        ...current,
                        focus: { ...current.focus, [key]: value },
                      }));
                    }}
                    onBlur={() => void persist(appSettings)}
                  />
                  <span>{key === "cycles" ? "轮" : "分钟"}</span>
                </div>
              </div>
            ))}
            <div className="settings-row">
              <div>
                <strong>自动开始休息</strong>
                <p>专注结束后不等待手动确认</p>
              </div>
              <Switch
                checked={appSettings.focus.autoStartBreak}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    focus: { ...appSettings.focus, autoStartBreak: value },
                  })
                }
                label="自动开始休息"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>自动开始下一轮</strong>
                <p>休息结束后继续下一轮专注</p>
              </div>
              <Switch
                checked={appSettings.focus.autoStartNextRound}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    focus: { ...appSettings.focus, autoStartNextRound: value },
                  })
                }
                label="自动开始下一轮"
              />
            </div>
            <div className="settings-row settings-row-select">
              <div>
                <strong>专注环境音</strong>
                <p>只在专注阶段播放本地生成的轻环境音，暂停或休息时自动停止</p>
              </div>
              <select
                className="settings-input settings-select"
                aria-label="专注环境音"
                value={appSettings.focus.environmentSound}
                onChange={(event) => {
                  const value = event.target.value as AppSettings["focus"]["environmentSound"];
                  const next = {
                    ...appSettings,
                    focus: { ...appSettings.focus, environmentSound: value },
                  };
                  setAppSettings(next);
                  void persist(next);
                }}
              >
                {environmentSoundOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-subheading">
              <span>天气卡片</span>
              <p>只需城市名，不申请精确位置权限；结果会在本机缓存。</p>
            </div>
            <div className="settings-row">
              <div>
                <strong>显示天气</strong>
                <p>在小窝和随身面板展示当前天气与降水概率</p>
              </div>
              <Switch
                checked={appSettings.weather.enabled}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    weather: { ...appSettings.weather, enabled: value },
                  })
                }
                label="显示天气"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>城市</strong>
                <p>例如：上海、杭州或 San Francisco</p>
              </div>
              <input
                className="settings-input"
                aria-label="天气城市"
                placeholder="填写城市"
                value={appSettings.weather.city}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    weather: {
                      ...current.weather,
                      city: event.target.value,
                      latitude: undefined,
                      longitude: undefined,
                      resolvedName: undefined,
                    },
                  }))
                }
                onBlur={() => void persist(appSettings, "天气城市已更新")}
              />
            </div>
          </section>
        )}
        {section === "notifications" && (
          <section className="settings-section">
            <h1>提醒</h1>
            <p>陪伴提醒使用预算，不制造愧疚或通知疲劳。</p>
            <div className="settings-row">
              <div>
                <strong>系统通知</strong>
                <p>任务到期、晨报和 Agent 待确认</p>
              </div>
              <Switch
                checked={appSettings.notifications.enabled}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    notifications: {
                      ...appSettings.notifications,
                      enabled: value,
                    },
                  })
                }
                label="系统通知"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>晨间简报</strong>
                <p>每天最多一次；关闭后仍可在 Today 查看摘要</p>
              </div>
              <Switch
                checked={appSettings.notifications.morningBrief}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    notifications: {
                      ...appSettings.notifications,
                      morningBrief: value,
                    },
                  })
                }
                label="晨间简报"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>简报时间</strong>
                <p>按当前设备的本地时区</p>
              </div>
              <input
                type="time"
                className="settings-input"
                value={appSettings.notifications.morningBriefTime}
                disabled={!appSettings.notifications.morningBrief}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    notifications: {
                      ...current.notifications,
                      morningBriefTime: event.target.value,
                    },
                  }))
                }
                onBlur={() => void persist(appSettings)}
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>提示音</strong>
                <p>系统允许时随横幅播放声音</p>
              </div>
              <Switch
                checked={appSettings.notifications.sound}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    notifications: {
                      ...appSettings.notifications,
                      sound: value,
                    },
                  })
                }
                label="通知提示音"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>横幅与角标</strong>
                <p>可分别关闭弹出横幅和应用图标角标</p>
              </div>
              <div className="inline-switches">
                <label>
                  横幅
                  <Switch
                    checked={appSettings.notifications.banners}
                    onChange={(value) =>
                      void persist({
                        ...appSettings,
                        notifications: {
                          ...appSettings.notifications,
                          banners: value,
                        },
                      })
                    }
                    label="通知横幅"
                  />
                </label>
                <label>
                  角标
                  <Switch
                    checked={appSettings.notifications.badge}
                    onChange={(value) =>
                      void persist({
                        ...appSettings,
                        notifications: {
                          ...appSettings.notifications,
                          badge: value,
                        },
                      })
                    }
                    label="应用角标"
                  />
                </label>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <strong>安静时段</strong>
                <p>期间暂停普通提醒</p>
              </div>
              <Switch
                checked={appSettings.notifications.quietHoursEnabled}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    notifications: {
                      ...appSettings.notifications,
                      quietHoursEnabled: value,
                    },
                  })
                }
                label="安静时段"
              />
            </div>
            {appSettings.notifications.quietHoursEnabled && (
              <div className="settings-row">
                <div>
                  <strong>起止时间</strong>
                  <p>跨午夜时会自动按夜间时段处理</p>
                </div>
                <div className="time-range">
                  <input
                    type="time"
                    className="settings-input"
                    value={appSettings.notifications.quietHoursStart}
                    onChange={(event) =>
                      setAppSettings((current) => ({
                        ...current,
                        notifications: {
                          ...current.notifications,
                          quietHoursStart: event.target.value,
                        },
                      }))
                    }
                    onBlur={() => void persist(appSettings)}
                  />
                  <span>至</span>
                  <input
                    type="time"
                    className="settings-input"
                    value={appSettings.notifications.quietHoursEnd}
                    onChange={(event) =>
                      setAppSettings((current) => ({
                        ...current,
                        notifications: {
                          ...current.notifications,
                          quietHoursEnd: event.target.value,
                        },
                      }))
                    }
                    onBlur={() => void persist(appSettings)}
                  />
                </div>
              </div>
            )}
            <div className="settings-row">
              <div>
                <strong>每日任务提醒预算</strong>
                <p>普通任务每天最多弹出多少次；同步风险、审批和晨报不占用这个预算</p>
              </div>
              <input
                type="number"
                min={0}
                max={50}
                step={1}
                className="settings-input"
                aria-label="每日任务提醒预算"
                value={appSettings.notifications.dailyTaskReminderLimit}
                onChange={(event) =>
                  (() => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    void persist({
                      ...appSettings,
                      notifications: {
                        ...appSettings.notifications,
                        dailyTaskReminderLimit: Math.min(50, Math.max(0, Math.round(value))),
                      },
                    });
                  })()
                }
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>连续忽略后降频</strong>
                <p>同一任务连续关闭两次提醒后不再重复打扰，任务仍保留在列表中</p>
              </div>
              <Switch
                checked={appSettings.notifications.taskIgnoreBackoffEnabled}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    notifications: {
                      ...appSettings.notifications,
                      taskIgnoreBackoffEnabled: value,
                    },
                  })
                }
                label="连续忽略后降频"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>同类任务提醒间隔</strong>
                <p>两次不同任务提醒之间至少间隔多久；设为 0 表示不额外等待</p>
              </div>
              <div className="settings-number-control">
                <input
                  type="number"
                  min={0}
                  max={1440}
                  step={15}
                  className="settings-input"
                  aria-label="同类任务提醒间隔"
                  value={appSettings.notifications.taskReminderMinIntervalMinutes}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    setAppSettings((current) => ({
                      ...current,
                      notifications: {
                        ...current.notifications,
                        taskReminderMinIntervalMinutes: Math.min(1440, Math.max(0, Math.round(value))),
                      },
                    }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  onBlur={() => void persist(appSettings, "任务提醒间隔已更新")}
                />
                <span>分钟</span>
              </div>
            </div>
            {(["local", "feishu"] as const).map((source) => (
              <div className="settings-row" key={source}>
                <div>
                  <strong>{source === "local" ? "本地任务提醒" : "飞书任务提醒"}</strong>
                  <p>可只提醒高优先级任务，或暂时关闭这一来源</p>
                </div>
                <select
                  className="settings-input"
                  aria-label={`${source === "local" ? "本地" : "飞书"}任务提醒策略`}
                  value={appSettings.notifications.taskReminderSourceMode[source]}
                  onChange={(event) =>
                    void persist({
                      ...appSettings,
                      notifications: {
                        ...appSettings.notifications,
                        taskReminderSourceMode: {
                          ...appSettings.notifications.taskReminderSourceMode,
                          [source]: event.target.value as "normal" | "important-only" | "off",
                        },
                      },
                    }, "任务提醒策略已更新")
                  }
                >
                  <option value="normal">全部提醒</option>
                  <option value="important-only">仅高优先级</option>
                  <option value="off">关闭来源</option>
                </select>
              </div>
            ))}
            {projectReminderOptions.length > 0 && (
              <div className="settings-subsection">
                <div className="settings-subsection-heading">
                  <strong>项目例外</strong>
                  <span>项目策略优先于来源策略；选择“跟随来源”即可恢复全局规则</span>
                </div>
                {projectReminderOptions.map((projectId) => {
                  const override = appSettings.notifications.taskReminderProjectMode[projectId];
                  return (
                    <div className="settings-row" key={projectId}>
                      <div>
                        <strong>{projectId}</strong>
                        <p>只影响这个项目的普通任务提醒</p>
                      </div>
                      <select
                        className="settings-input"
                        aria-label={`${projectId}项目提醒策略`}
                        value={override ?? "inherit"}
                        onChange={(event) => {
                          const nextModes = { ...appSettings.notifications.taskReminderProjectMode };
                          if (event.target.value === "inherit") delete nextModes[projectId];
                          else nextModes[projectId] = event.target.value as "normal" | "important-only" | "off";
                          void persist({
                            ...appSettings,
                            notifications: {
                              ...appSettings.notifications,
                              taskReminderProjectMode: nextModes,
                            },
                          }, "项目提醒策略已更新");
                        }}
                      >
                        <option value="inherit">跟随来源</option>
                        <option value="normal">全部提醒</option>
                        <option value="important-only">仅高优先级</option>
                        <option value="off">关闭项目</option>
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
            {appSettings.notifications.mutedUntil &&
              new Date(appSettings.notifications.mutedUntil) > new Date() && (
                <div className="settings-row">
                  <div>
                    <strong>临时静音中</strong>
                    <p>
                      恢复时间：
                      {formatDateTime(appSettings.notifications.mutedUntil)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="soft-button"
                    onClick={() =>
                      void persist(
                        {
                          ...appSettings,
                          notifications: {
                            ...appSettings.notifications,
                            mutedUntil: undefined,
                          },
                        },
                        "提醒已恢复",
                      )
                    }
                  >
                    立即恢复
                  </button>
                </div>
              )}
          </section>
        )}
        {section === "integrations" && (
          <section className="settings-section">
            <h1>飞书</h1>
            <p>
              零服务器本地直连；每个用户拥有独立的飞书连接应用与凭据。
            </p>
            <div className="settings-row">
              <div>
                <strong>连接状态</strong>
                <p>
                  {feishuStatus?.lastError?.message ??
                    (feishuStatus?.connected
                      ? `账号 ${feishuStatus.accountId ?? appSettings.feishu.accountId} · ${feishuStatus.polling ? "自动同步中" : "已暂停自动同步"}`
                      : feishuStatus?.state === "authorizing"
                        ? feishuStatus.authorizationStep === "app-registration"
                          ? "请在浏览器确认创建 Todo Agent 专属连接应用"
                          : "请在浏览器完成飞书账号授权"
                        : "未连接；本地 TODO 不受影响")}
                </p>
              </div>
              <span
                className={`status-pill ${feishuStatus?.connected ? "success" : feishuStatus?.lastError ? "warning" : ""}`}
              >
                {feishuStatus?.connected ? (
                  <CloudCheck size={15} />
                ) : (
                  <Cloud size={15} />
                )}
                {feishuStatus?.connected
                  ? "已连接"
                  : feishuStatus?.state === "authorizing"
                    ? "授权中"
                    : "未连接"}
              </span>
            </div>
            <div className="settings-row">
              <div>
                <strong>连接方式</strong>
                <p>可一键创建专属应用，也可复用已审核的已有应用</p>
              </div>
              <select
                className="settings-input"
                value={appSettings.feishu.mode}
                onChange={(event) =>
                  void persist({
                    ...appSettings,
                    feishu: {
                      ...appSettings.feishu,
                      mode: event.target.value as AppSettings["feishu"]["mode"],
                      configured: false,
                    },
                  })
                }
              >
                <option value="personal-direct">一键连接（推荐 · 零服务器）</option>
                <option value="existing-direct">使用已有飞书应用（零服务器）</option>
                <option value="local-development">本机回调开发模式（兼容）</option>
                {appSettings.feishu.mode === "relay" && (
                  <option value="relay">已有 OAuth Relay（兼容）</option>
                )}
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>本地账号标识</strong>
                <p>只用于区分这台设备上的同步空间</p>
              </div>
              <input
                className="settings-input"
                value={appSettings.feishu.accountId}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    feishu: {
                      ...current.feishu,
                      accountId: event.target.value,
                    },
                  }))
                }
                onBlur={() => void persist(appSettings)}
              />
            </div>
            {appSettings.feishu.mode === "personal-direct" ? (
              <>
                <div className="settings-row">
                  <div>
                    <strong>一键连接流程</strong>
                    <p>先确认创建专属应用，再授权当前飞书账号的任务权限</p>
                  </div>
                  <span className="status-pill success">零服务器</span>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>本地安全存储</strong>
                    <p>
                      App Secret 与 Token 只保存在系统凭据库；任务直接连接飞书
                    </p>
                  </div>
                  <ShieldCheck size={18} aria-hidden="true" />
                </div>
                {appSettings.feishu.clientId && (
                  <div className="settings-row">
                    <div>
                      <strong>专属应用已创建</strong>
                      <p>重新授权会复用现有应用，不会重复创建</p>
                    </div>
                    <span className="status-pill success">已就绪</span>
                  </div>
                )}
              </>
            ) : appSettings.feishu.mode === "relay" ? (
              <>
                <div className="settings-row">
                  <div>
                    <strong>Relay 地址</strong>
                    <p>
                      必须是你信任的 HTTPS 服务，例如 https://relay.example.com
                    </p>
                  </div>
                  <input
                    className="settings-input"
                    value={appSettings.feishu.relayBaseUrl}
                    onChange={(event) =>
                      setAppSettings((current) => ({
                        ...current,
                        feishu: {
                          ...current.feishu,
                          relayBaseUrl: event.target.value,
                        },
                      }))
                    }
                    onBlur={() => void persist(appSettings)}
                    placeholder="https://…"
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <strong>App ID（可选）</strong>
                    <p>若 Relay 已绑定应用，可以留空</p>
                  </div>
                  <input
                    className="settings-input"
                    value={appSettings.feishu.clientId}
                    onChange={(event) =>
                      setAppSettings((current) => ({
                        ...current,
                        feishu: {
                          ...current.feishu,
                          clientId: event.target.value,
                        },
                      }))
                    }
                    onBlur={() => void persist(appSettings)}
                  />
                </div>
              </>
            ) : appSettings.feishu.mode === "existing-direct" ? (
              <>
                <div className="settings-row">
                  <div>
                    <strong>飞书 App ID</strong>
                    <p>填写已审核或已发布应用的 App ID</p>
                  </div>
                  <input
                    className="settings-input"
                    value={appSettings.feishu.clientId}
                    onChange={(event) =>
                      setAppSettings((current) => ({
                        ...current,
                        feishu: {
                          ...current.feishu,
                          clientId: event.target.value,
                          configured: false,
                        },
                      }))
                    }
                    onBlur={() => void persist(appSettings)}
                    placeholder="cli_…"
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <strong>App Secret</strong>
                    <p>
                      {appSettings.feishu.configured &&
                      appSettings.feishu.appSecretCredentialId
                        ? "已使用系统安全存储；输入新值可替换"
                        : "首次连接必须填写；不会写入普通设置、日志或导出"}
                    </p>
                  </div>
                  <input
                    className="settings-input"
                    type="password"
                    value={feishuSecret}
                    onChange={(event) => setFeishuSecret(event.target.value)}
                    placeholder={
                      appSettings.feishu.configured &&
                      appSettings.feishu.appSecretCredentialId
                        ? "••••••••"
                        : "连接时加密保存"
                    }
                    autoComplete="off"
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <strong>账号授权方式</strong>
                    <p>跳过应用创建，使用 Device OAuth 在浏览器授权任务权限</p>
                  </div>
                  <span className="status-pill success">零服务器</span>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>所需应用权限</strong>
                    <p>任务读取、任务写入与离线访问；权限不足时连接会失败</p>
                  </div>
                  <ShieldCheck size={18} aria-hidden="true" />
                </div>
              </>
            ) : (
              <>
                <div className="settings-row">
                  <div>
                    <strong>飞书 App ID</strong>
                    <p>仅用于你自己的开发环境</p>
                  </div>
                  <input
                    className="settings-input"
                    value={appSettings.feishu.clientId}
                    onChange={(event) =>
                      setAppSettings((current) => ({
                        ...current,
                        feishu: {
                          ...current.feishu,
                          clientId: event.target.value,
                        },
                      }))
                    }
                    onBlur={() => void persist(appSettings)}
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <strong>App Secret</strong>
                    <p>
                      {appSettings.feishu.appSecretCredentialId
                        ? "已使用系统安全存储；输入新值可替换"
                        : "不会写入普通设置、日志或导出"}
                    </p>
                  </div>
                  <input
                    className="settings-input"
                    type="password"
                    value={feishuSecret}
                    onChange={(event) => setFeishuSecret(event.target.value)}
                    placeholder={
                      appSettings.feishu.appSecretCredentialId
                        ? "••••••••"
                        : "连接时加密保存"
                    }
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <strong>确认开发者模式风险</strong>
                    <p>分发版不应使用本机 App Secret</p>
                  </div>
                  <Switch
                    checked={
                      appSettings.feishu.acknowledgeInsecureLocalCredentials
                    }
                    onChange={(value) =>
                      void persist({
                        ...appSettings,
                        feishu: {
                          ...appSettings.feishu,
                          acknowledgeInsecureLocalCredentials: value,
                        },
                      })
                    }
                    label="确认开发者模式风险"
                  />
                </div>
              </>
            )}
            <div className="settings-row">
              <div>
                <strong>自动同步</strong>
                <p>离线时只排队，不会丢失本地修改</p>
              </div>
              <Switch
                checked={appSettings.feishu.autoSync}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    feishu: { ...appSettings.feishu, autoSync: value },
                  })
                }
                label="自动同步飞书"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>同步间隔</strong>
                <p>连接后也可从“同步问题”手动刷新</p>
              </div>
              <select
                className="settings-input"
                value={appSettings.feishu.pollingMinutes}
                onChange={(event) =>
                  void persist({
                    ...appSettings,
                    feishu: {
                      ...appSettings.feishu,
                      pollingMinutes: Number(event.target.value),
                    },
                  })
                }
              >
                <option value={1}>每 1 分钟</option>
                <option value={5}>每 5 分钟</option>
                <option value={15}>每 15 分钟</option>
                <option value={30}>每 30 分钟</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>同步字段</strong>
                <p>标题、描述、开始、截止、完成状态</p>
              </div>
              <span className="status-pill">Task v2</span>
            </div>
            <div className="settings-row">
              <div>
                <strong>私人字段</strong>
                <p>Today、排序、时间块与专注永不回写</p>
              </div>
              <span className="status-pill success">仅本地</span>
            </div>
            <div className="settings-actions">
              <button
                type="button"
                className="primary-button"
                disabled={saving || feishuStatus?.state === "authorizing"}
                onClick={() => void connectFeishu()}
              >
                {feishuStatus?.state === "authorizing"
                  ? feishuStatus.authorizationStep === "app-registration"
                    ? "等待创建专属应用…"
                    : "等待账号授权…"
                  : feishuStatus?.connected
                    ? "重新授权"
                    : appSettings.feishu.mode === "personal-direct"
                      ? "一键连接飞书"
                      : appSettings.feishu.mode === "existing-direct"
                        ? "连接已有应用"
                        : "配置并连接"}
              </button>
              {feishuStatus?.state === "authorizing" && (
                <button
                  type="button"
                  className="soft-button"
                  onClick={() =>
                    void window.desktopApi?.feishu
                      .cancelOAuth()
                      .then(setFeishuStatus)
                  }
                >
                  取消授权
                </button>
              )}
              {feishuStatus?.connected && (
                <button
                  type="button"
                  className="soft-button"
                  disabled={saving}
                  onClick={() =>
                    void window.desktopApi?.feishu
                      .syncNow(true)
                      .then((report) => {
                        if (report.issue) {
                          notify(
                            feishuSyncIssueCopy(report.issue),
                            report.issue.retryable ? "info" : "error",
                          );
                          return;
                        }
                        notify(
                          `已重新核对全部飞书任务：上传 ${report.pushed}，拉取 ${report.pulled}`,
                          "success",
                        );
                      })
                      .catch((reason: unknown) =>
                        notify(
                          reason instanceof Error ? reason.message : "同步失败",
                          "error",
                        ),
                      )
                  }
                >
                  <RefreshCw size={15} />
                  立即同步
                </button>
              )}
              {feishuStatus?.configured && (
                <button
                  type="button"
                  className="danger-button"
                  disabled={saving}
                  onClick={() => setDisconnectSheet(true)}
                >
                  断开连接
                </button>
              )}
            </div>
          </section>
        )}
        {section === "ai" && (
          <section className="settings-section">
            <h1>模型与 Agent</h1>
            <p>
              兼容 OpenAI-style Chat Completions；使用 API Key 时会通过系统安全存储保护。
            </p>
            <div className="settings-row">
              <div>
                <strong>启用 AI</strong>
                <p>关闭后本地晨报、任务和同步继续工作</p>
              </div>
              <Switch
                checked={appSettings.ai.enabled}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    ai: { ...appSettings.ai, enabled: value },
                  })
                }
                label="启用 AI"
              />
            </div>
            <div className="settings-subheading">模型连接</div>
            <div className="settings-row">
              <div>
                <strong>Endpoint</strong>
                <p>
                  {appSettings.ai.authMode === "none"
                    ? "当前不发送 Authorization；只应连接可信的自托管服务"
                    : "API Key 只发送到这个精确 Origin"}
                </p>
              </div>
              <input
                className="settings-input"
                value={appSettings.ai.endpoint}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    ai: { ...current.ai, endpoint: event.target.value },
                  }))
                }
                onBlur={() => void persist(appSettings)}
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>模型</strong>
                <p>需要支持原生 tool_calls 才能执行写操作</p>
              </div>
              <input
                className="settings-input"
                value={appSettings.ai.model}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    ai: { ...current.ai, model: event.target.value },
                  }))
                }
                onBlur={() => void persist(appSettings)}
                placeholder="例如 gpt-5"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>认证方式</strong>
                <p>无 API Key 是针对可信自托管服务的显式设置</p>
              </div>
              <select
                className="settings-input"
                aria-label="模型认证方式"
                value={appSettings.ai.authMode}
                onChange={(event) =>
                  void persist(
                    {
                      ...appSettings,
                      ai: {
                        ...appSettings.ai,
                        authMode: event.target.value as AiAuthenticationMode,
                      },
                    },
                    event.target.value === "none"
                      ? "已设为无 API Key；请求不会携带 Authorization"
                      : "已设为 Bearer API Key 认证",
                  )
                }
              >
                <option value="bearer">Bearer API Key</option>
                <option value="none">无需 API Key（可信自托管）</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>模型路由</strong>
                <p>可在主模型暂时不可用时切到本地模型；不会把写操作重复发送给已返回内容的模型</p>
              </div>
              <select
                className="settings-input"
                aria-label="模型路由"
                value={appSettings.ai.routing}
                onChange={(event) =>
                  void persist({
                    ...appSettings,
                    ai: {
                      ...appSettings.ai,
                      routing: event.target.value as AppSettings["ai"]["routing"],
                    },
                  })
                }
              >
                <option value="primary-only">只用主模型</option>
                <option value="fallback-on-error">主模型失败时切本地备用</option>
                <option value="local-only">只用本地模型</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>API Key</strong>
                <p>
                  {appSettings.ai.authMode === "none"
                    ? "当前不会读取、发送或要求 API Key"
                    : appSettings.ai.credentialId
                    ? "已安全保存；输入新值可替换"
                    : "不会进入提示词、日志或导出"}
                </p>
              </div>
              <input
                className="settings-input"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                disabled={appSettings.ai.authMode === "none"}
                placeholder={
                  appSettings.ai.authMode === "none"
                    ? "此连接无需 API Key"
                    : appSettings.ai.credentialId
                      ? "••••••••"
                      : "输入后加密保存"
                }
              />
            </div>
            <div className="settings-actions">
              <button
                type="button"
                className="soft-button"
                disabled={
                  appSettings.ai.authMode === "none" || !apiKey.trim() || saving
                }
                onClick={() => void saveApiKey()}
              >
                {appSettings.ai.credentialId
                  ? "更新 API Key"
                  : "安全保存 API Key"}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={
                  saving ||
                  !appSettings.ai.enabled ||
                  !activeAiAuthConfigured ||
                  !activeAiModelConfigured
                }
                onClick={() => void testModelConnection()}
              >
                <RefreshCw size={15} />
                测试连接
              </button>
            </div>
            <div className="settings-subheading">本地备用模型</div>
            <div className="settings-row">
              <div>
                <strong>启用本地备用</strong>
                <p>支持 Ollama、LM Studio 或任意 OpenAI-compatible 本地服务；默认不联网、不上传任务</p>
              </div>
              <Switch
                checked={appSettings.ai.fallback.enabled}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    ai: {
                      ...appSettings.ai,
                      fallback: { ...appSettings.ai.fallback, enabled: value },
                    },
                  })
                }
                label="启用本地备用模型"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>本地 Endpoint</strong>
                <p>例如 http://127.0.0.1:11434/v1</p>
              </div>
              <input
                className="settings-input"
                value={appSettings.ai.fallback.endpoint}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    ai: {
                      ...current.ai,
                      fallback: {
                        ...current.ai.fallback,
                        endpoint: event.target.value,
                      },
                    },
                  }))
                }
                onBlur={() => void persist(appSettings)}
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>本地模型</strong>
                <p>需要支持 tool_calls；只用本地模式也可以留空主模型</p>
              </div>
              <input
                className="settings-input"
                value={appSettings.ai.fallback.model}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    ai: {
                      ...current.ai,
                      fallback: {
                        ...current.ai.fallback,
                        model: event.target.value,
                      },
                    },
                  }))
                }
                onBlur={() => void persist(appSettings)}
                placeholder="例如 llama3.2"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>本地认证</strong>
                <p>{appSettings.ai.fallback.authMode === "none" ? "不发送 Authorization" : "使用单独的 API Key"}</p>
              </div>
              <select
                className="settings-input"
                aria-label="本地模型认证方式"
                value={appSettings.ai.fallback.authMode}
                onChange={(event) =>
                  void persist({
                    ...appSettings,
                    ai: {
                      ...appSettings.ai,
                      fallback: {
                        ...appSettings.ai.fallback,
                        authMode: event.target.value as AiAuthenticationMode,
                      },
                    },
                  })
                }
              >
                <option value="none">无需 API Key</option>
                <option value="bearer">Bearer API Key</option>
              </select>
            </div>
            {appSettings.ai.fallback.authMode === "bearer" && (
              <div className="settings-row">
                <div>
                  <strong>本地 API Key</strong>
                  <p>{appSettings.ai.fallback.credentialId ? "已安全保存；输入新值可替换" : "不会进入提示词、日志或导出"}</p>
                </div>
                <input
                  className="settings-input"
                  type="password"
                  value={fallbackApiKey}
                  onChange={(event) => setFallbackApiKey(event.target.value)}
                  placeholder={appSettings.ai.fallback.credentialId ? "••••••••" : "输入后加密保存"}
                />
              </div>
            )}
            <div className="settings-actions">
              {appSettings.ai.fallback.authMode === "bearer" && (
                <button
                  type="button"
                  className="soft-button"
                  disabled={!fallbackApiKey.trim() || saving}
                  onClick={() => void saveFallbackApiKey()}
                >
                  {appSettings.ai.fallback.credentialId ? "更新本地 API Key" : "安全保存本地 API Key"}
                </button>
              )}
              <span className="settings-hint">
                {appSettings.ai.routing === "local-only"
                  ? "当前对话只会使用本地模型"
                  : appSettings.ai.routing === "fallback-on-error" && fallbackAiReady
                    ? "主模型出现网络或 5xx 错误时自动切换"
                    : "备用模型尚未参与对话"}
              </span>
            </div>
            {connectionTest && (
              <div
                className={`connection-result ${connectionTest.ok ? "success" : "error"}`}
              >
                <span>
                  {connectionTest.ok ? (
                    <CheckCircle2 size={17} />
                  ) : (
                    <AlertTriangle size={17} />
                  )}
                </span>
                <div>
                  <strong>
                    {connectionTest.ok
                      ? `连接成功 · ${connectionTest.latencyMs} ms`
                      : connectionTest.message}
                  </strong>
                  <p>
                    {connectionTest.endpointOrigin ?? "端点未返回可验证来源"} ·{" "}
                    {connectionTest.reportedTotalTokens !== undefined
                      ? `本次 ${connectionTest.reportedTotalTokens} tokens`
                      : connectionTest.code}
                  </p>
                </div>
              </div>
            )}
            {modelUsage && (
              <div className="usage-card">
                <div>
                  <strong>今日 Token</strong>
                  <span>
                    {modelUsage.usedTokens.toLocaleString()} /{" "}
                    {modelUsage.dailyTokenLimit?.toLocaleString() ?? "不限"}
                  </span>
                </div>
                <div className="usage-track">
                  <span
                    style={{
                      width: `${modelUsage.dailyTokenLimit ? Math.min(100, (modelUsage.usedTokens / modelUsage.dailyTokenLimit) * 100) : 0}%`,
                    }}
                  />
                </div>
                <small>
                  {modelUsage.blocked
                    ? `已暂停新运行 · ${modelUsage.blockedReason}`
                    : modelUsage.accounting === "provider-reported"
                      ? `提供方精确回报 · 剩余 ${modelUsage.remainingTokens?.toLocaleString() ?? "不限"}`
                      : `统计状态：${modelUsage.accounting}`}
                </small>
              </div>
            )}
            <div className="settings-subheading">身份与陪伴方式</div>
            <div className="settings-row">
              <div>
                <strong>助手名字</strong>
                <p>会用于 Agent 对话中的身份设定</p>
              </div>
              <input
                className="settings-input"
                value={appSettings.persona.name}
                maxLength={40}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    persona: { ...current.persona, name: event.target.value },
                  }))
                }
                onBlur={() => void persist(appSettings)}
                placeholder="例如：小序"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>称呼你</strong>
                <p>可留空，助手会使用中性称呼</p>
              </div>
              <input
                className="settings-input"
                value={appSettings.persona.userName}
                maxLength={40}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    persona: {
                      ...current.persona,
                      userName: event.target.value,
                    },
                  }))
                }
                onBlur={() => void persist(appSettings)}
                placeholder="你的名字或昵称"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>交流风格</strong>
                <p>只影响表达方式，不改变权限边界</p>
              </div>
              <select
                className="settings-input"
                value={appSettings.persona.preset}
                onChange={(event) =>
                  void persist({
                    ...appSettings,
                    persona: {
                      ...appSettings.persona,
                      preset: event.target
                        .value as AppSettings["persona"]["preset"],
                    },
                  })
                }
              >
                <option value="minimal">极简直接</option>
                <option value="warm">温暖陪伴</option>
                <option value="calm">平静理性</option>
                <option value="strict">严格督促</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>回答长度</strong>
                <p>任务操作仍会完整展示影响范围</p>
              </div>
              <select
                className="settings-input"
                value={appSettings.persona.responseLength}
                onChange={(event) =>
                  void persist({
                    ...appSettings,
                    persona: {
                      ...appSettings.persona,
                      responseLength: event.target
                        .value as AppSettings["persona"]["responseLength"],
                    },
                  })
                }
              >
                <option value="short">简短</option>
                <option value="balanced">平衡</option>
                <option value="detailed">详细</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>主动程度</strong>
                <p>决定 Agent 是否主动总结和建议下一步</p>
              </div>
              <select
                className="settings-input"
                value={appSettings.persona.proactiveLevel}
                onChange={(event) =>
                  void persist({
                    ...appSettings,
                    persona: {
                      ...appSettings.persona,
                      proactiveLevel: event.target
                        .value as AppSettings["persona"]["proactiveLevel"],
                    },
                  })
                }
              >
                <option value="quiet">安静</option>
                <option value="balanced">适度</option>
                <option value="active">积极</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>提醒力度</strong>
                <p>不会绕过安静时段或临时静音</p>
              </div>
              <select
                className="settings-input"
                value={appSettings.persona.reminderStrength}
                onChange={(event) =>
                  void persist({
                    ...appSettings,
                    persona: {
                      ...appSettings.persona,
                      reminderStrength: event.target
                        .value as AppSettings["persona"]["reminderStrength"],
                    },
                  })
                }
              >
                <option value="gentle">温和</option>
                <option value="normal">普通</option>
                <option value="firm">坚定</option>
              </select>
            </div>
            <div className="settings-subheading">使用预算</div>
            <div className="settings-row">
              <div>
                <strong>每日 Token 预算</strong>
                <p>达到上限后会阻止新的模型运行；0 表示不设本地上限</p>
              </div>
              <input
                className="settings-input"
                type="number"
                min={0}
                step={1000}
                value={appSettings.ai.dailyTokenLimit}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    ai: {
                      ...current.ai,
                      dailyTokenLimit: Number(event.target.value),
                    },
                  }))
                }
                onBlur={() => void persist(appSettings)}
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>每日费用预算</strong>
                <p>仅作本地偏好，以美元计；不会替代提供方账单限额</p>
              </div>
              <input
                className="settings-input"
                type="number"
                min={0}
                step={0.5}
                value={appSettings.ai.dailyCostLimit}
                onChange={(event) =>
                  setAppSettings((current) => ({
                    ...current,
                    ai: {
                      ...current.ai,
                      dailyCostLimit: Number(event.target.value),
                    },
                  }))
                }
                onBlur={() => void persist(appSettings)}
              />
            </div>
          </section>
        )}
        {section === "permissions" && (
          <section className="settings-section">
            <h1>权限中心</h1>
            <p>全权限不是跳过安全检查，而是对精确范围的临时预授权。</p>
            <div className="settings-row">
              <div>
                <strong>当前模式</strong>
                <p>R0 自动；R1 可撤销；R2/R3 按规则确认</p>
              </div>
              <select
                className="settings-input"
                value={appSettings.permissionMode}
                onChange={(event) =>
                  update(
                    {
                      permissionMode: event.target
                        .value as AppSettings["permissionMode"],
                    },
                    "权限模式已更新",
                  )
                }
              >
                <option value="read-only">只读模式</option>
                <option value="standard">标准模式</option>
                <option value="full-access" disabled>
                  临时全权限（审批时开启）
                </option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <strong>交互式全权限</strong>
                <p>
                  Agent 提出高风险操作时，可对所列工具、目录、域名和预算授权 1
                  小时；需本机验证
                </p>
              </div>
              <span className="status-pill">
                <ShieldCheck size={15} />
                按需出现
              </span>
            </div>
            <div className="settings-row">
              <div>
                <strong>全局停止</strong>
                <p>停止模型与 Agent 工具并撤销临时全权限；核心提醒和同步继续</p>
              </div>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  void Promise.all([
                    window.desktopApi?.agent.stop(),
                    window.desktopApi?.agent.revokeFullAccess(),
                  ])
                    .then(() => window.desktopApi?.settings.get())
                    .then(
                      (settings) =>
                        settings &&
                        window.desktopApi?.settings.replace({
                          ...settings,
                          permissionMode: "standard",
                        }),
                    )
                    .then(() =>
                      notify("Agent 已停止，临时全权限已撤销", "success"),
                    )
                    .catch((reason: unknown) =>
                      notify(
                        reason instanceof Error
                          ? reason.message
                          : "停止 Agent 失败",
                        "error",
                      ),
                    );
                }}
              >
                <Square size={14} />
                停止并撤销
              </button>
            </div>
          </section>
        )}
        {section === "privacy" && (
          <section className="settings-section">
            <h1>隐私与数据</h1>
            <p>模型数据范围、备份与恢复都由你控制。</p>
            <div className="settings-row">
              <div>
                <strong>任务标题和时间</strong>
                <p>Agent 执行任务管理所需的最小范围</p>
              </div>
              <Switch
                checked={appSettings.modelDataScope.taskTitlesAndTimes}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    modelDataScope: {
                      ...appSettings.modelDataScope,
                      taskTitlesAndTimes: value,
                    },
                  })
                }
                label="允许模型读取任务标题和时间"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>任务备注</strong>
                <p>可能包含更敏感的工作上下文，默认关闭</p>
              </div>
              <Switch
                checked={appSettings.modelDataScope.notes}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    modelDataScope: {
                      ...appSettings.modelDataScope,
                      notes: value,
                    },
                  })
                }
                label="允许模型读取任务备注"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>飞书任务内容</strong>
                <p>只影响发送给模型的内容，不改变飞书同步</p>
              </div>
              <Switch
                checked={appSettings.modelDataScope.feishuContent}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    modelDataScope: {
                      ...appSettings.modelDataScope,
                      feishuContent: value,
                    },
                  })
                }
                label="允许模型读取飞书任务内容"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>附件文本</strong>
                <p>Agent 需要明确工具权限才能读取文件</p>
              </div>
              <Switch
                checked={appSettings.modelDataScope.attachmentText}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    modelDataScope: {
                      ...appSettings.modelDataScope,
                      attachmentText: value,
                    },
                  })
                }
                label="允许模型读取附件文本"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>对话历史</strong>
                <p>关闭时，每次运行只使用当前会话传入的上下文</p>
              </div>
              <Switch
                checked={appSettings.modelDataScope.chatHistory}
                onChange={(value) =>
                  void persist({
                    ...appSettings,
                    modelDataScope: {
                      ...appSettings.modelDataScope,
                      chatHistory: value,
                    },
                  })
                }
                label="允许模型读取对话历史"
              />
            </div>
            <div className="settings-row">
              <div>
                <strong>导出备份</strong>
                <p>JSON 备份默认隐去私人备注、草稿、位置与所有凭据引用；Markdown 可选附带任务事件摘要</p>
              </div>
              <div className="settings-row-actions">
                <div className="markdown-export-history-option">
                  <Switch
                    checked={markdownIncludesHistory}
                    onChange={setMarkdownIncludesHistory}
                    label="Markdown 包含任务事件摘要"
                  />
                  <span>包含事件摘要</span>
                </div>
                <button
                  type="button"
                  className="soft-button"
                  disabled={saving}
                  onClick={() => void exportData()}
                >
                  <Download size={15} />
                  安全 JSON
                </button>
                <button
                  type="button"
                  className="soft-button"
                  disabled={saving}
                  onClick={() => void exportMarkdownData()}
                >
                  <FileText size={15} />
                  可读 Markdown
                </button>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <strong>导入备份</strong>
                <p>先显示新增、覆盖、跳过与复制数量，再允许提交</p>
              </div>
              <button
                type="button"
                className="soft-button"
                disabled={saving}
                onClick={() => void previewImport()}
              >
                <Upload size={15} />
                选择文件并预览
              </button>
            </div>
            <div className="settings-row">
              <div>
                <strong>清除本地数据</strong>
                <p>不会删除飞书远端任务或系统安全存储中的凭据</p>
              </div>
              <button
                type="button"
                className="danger-button"
                disabled={saving}
                onClick={() => setClearDataSheet(true)}
              >
                选择清除范围
              </button>
            </div>
            <div className="warning-note">
              <LockKeyhole size={15} />
              API Key、飞书 Token 和 App Secret
              永远不会进入导出文件；权限审计保持追加只读。
            </div>
          </section>
        )}
      </main>
      {disconnectSheet && (
        <div className="modal-backdrop">
          <div
            className="modal-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="disconnect-feishu-title"
          >
            <div className="modal-header">
              <span className="feature-icon">
                <CloudOff size={20} />
              </span>
              <div>
                <h2 id="disconnect-feishu-title">
                  断开飞书后如何处理本机任务？
                </h2>
                <p>三种选择都不会直接删除飞书远端任务。</p>
              </div>
            </div>
            <div className="modal-body disconnect-options">
              <button
                type="button"
                className="disconnect-option recommended"
                disabled={saving}
                onClick={() => void disconnectFeishu("keep")}
              >
                <strong>保留本机缓存</strong>
                <span>之后重新授权可继续同步队列、映射和冲突记录</span>
                <span className="status-pill success">推荐</span>
              </button>
              <button
                type="button"
                className="disconnect-option"
                disabled={saving}
                onClick={() => void disconnectFeishu("convert-local")}
              >
                <strong>全部转为本地任务</strong>
                <span>解除同步关系，保留内容与私人计划</span>
              </button>
              <button
                type="button"
                className="disconnect-option danger"
                disabled={saving}
                onClick={() => void disconnectFeishu("remove-cache")}
              >
                <strong>移除本机缓存</strong>
                <span>只清除当前设备中的飞书任务副本，不影响飞书远端</span>
              </button>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="soft-button"
                disabled={saving}
                onClick={() => setDisconnectSheet(false)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
      {dataPreview && (
        <div className="modal-backdrop">
          <div
            className="modal-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-preview-title"
          >
            <div className="modal-header">
              <span className="feature-icon">
                <Upload size={20} />
              </span>
              <div>
                <h2 id="import-preview-title">确认导入数据</h2>
                <p>
                  预览令牌将在 {formatDateTime(dataPreview.expiresAt)}{" "}
                  失效，文件不会被再次读取。
                </p>
              </div>
            </div>
            <div className="modal-body">
              <div className="settings-row">
                <div>
                  <strong>冲突策略</strong>
                  <p>推荐先跳过已有项目，最容易撤销</p>
                </div>
                <select
                  className="settings-input"
                  value={importStrategy}
                  onChange={(event) =>
                    setImportStrategy(
                      event.target.value as DataImportStrategyView,
                    )
                  }
                >
                  <option value="skip">跳过已有（推荐）</option>
                  <option value="copy">冲突项另存副本</option>
                  <option value="overwrite">用备份覆盖本地</option>
                </select>
              </div>
              {(() => {
                const plan = dataPreview.strategies[importStrategy];
                return (
                  <>
                    <div className="permission-row">
                      <span>任务</span>
                      <strong>
                        新增 {plan.tasks.create} · 覆盖 {plan.tasks.overwrite} ·
                        跳过 {plan.tasks.skip} · 复制 {plan.tasks.copy}
                      </strong>
                    </div>
                    <div className="permission-row">
                      <span>草稿</span>
                      <strong>
                        新增 {plan.drafts.create} · 冲突{" "}
                        {plan.drafts.conflicts.length}
                      </strong>
                    </div>
                    <div className="permission-row">
                      <span>设置</span>
                      <strong>
                        {plan.settings.action === "overwrite"
                          ? "将覆盖（本机凭据仍保留）"
                          : plan.settings.action === "skip"
                            ? "保留本机设置"
                            : "文件未包含"}
                      </strong>
                    </div>
                    <div className="permission-row">
                      <span>权限审计</span>
                      <strong>
                        {plan.permissionAudit.action === "replace"
                          ? "追加只读，不能由导入替换"
                          : "保留本机审计链"}
                      </strong>
                    </div>
                    {plan.warnings.map((warning) => (
                      <div className="warning-note" key={warning}>
                        <AlertTriangle size={15} />
                        {warning}
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="soft-button"
                onClick={cancelImport}
              >
                取消
              </button>
              <span className="action-spacer" />
              <button
                type="button"
                className="primary-button"
                disabled={
                  saving ||
                  dataPreview.strategies[importStrategy].permissionAudit
                    .action === "replace"
                }
                onClick={() => void commitImport()}
              >
                确认导入
              </button>
            </div>
          </div>
        </div>
      )}
      {clearDataSheet && (
        <div className="modal-backdrop">
          <div
            className="modal-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-data-title"
          >
            <div className="modal-header">
              <span className="feature-icon">
                <Trash2 size={20} />
              </span>
              <div>
                <h2 id="clear-data-title">选择要清除的本地数据</h2>
                <p>下一步仍会显示一次系统确认；飞书远端与安全凭据不会删除。</p>
              </div>
            </div>
            <div className="modal-body">
              <div className="settings-row">
                <div>
                  <strong>任务</strong>
                  <p>包含本地和飞书任务的本机副本；自动同步会暂停</p>
                </div>
                <Switch
                  checked={clearSelection.tasks}
                  onChange={(value) =>
                    setClearSelection((current) => ({
                      ...current,
                      tasks: value,
                    }))
                  }
                  label="清除任务"
                />
              </div>
              <div className="settings-row">
                <div>
                  <strong>草稿</strong>
                  <p>快速录入和编辑器中尚未提交的内容</p>
                </div>
                <Switch
                  checked={clearSelection.drafts}
                  onChange={(value) =>
                    setClearSelection((current) => ({
                      ...current,
                      drafts: value,
                    }))
                  }
                  label="清除草稿"
                />
              </div>
              <div className="settings-row">
                <div>
                  <strong>撤销历史</strong>
                  <p>清除后不能再撤销之前的任务操作</p>
                </div>
                <Switch
                  checked={clearSelection.operations}
                  onChange={(value) =>
                    setClearSelection((current) => ({
                      ...current,
                      operations: value,
                    }))
                  }
                  label="清除撤销历史"
                />
              </div>
              <div className="settings-row">
                <div>
                  <strong>重置应用设置</strong>
                  <p>系统安全存储中的 API Key 和飞书凭据引用保留</p>
                </div>
                <Switch
                  checked={clearSelection.resetSettings}
                  onChange={(value) =>
                    setClearSelection((current) => ({
                      ...current,
                      resetSettings: value,
                    }))
                  }
                  label="重置应用设置"
                />
              </div>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="soft-button"
                onClick={() => setClearDataSheet(false)}
              >
                取消
              </button>
              <span className="action-spacer" />
              <button
                type="button"
                className="danger-button"
                disabled={
                  saving || !Object.values(clearSelection).some(Boolean)
                }
                onClick={() => void clearLocalData()}
              >
                继续并系统确认
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const steps = [
    {
      icon: <Check size={23} />,
      title: "先从可靠的本地任务开始",
      body: "无需注册、飞书或 AI。你的任务默认只保存在这台电脑。",
    },
    {
      icon: <Cloud size={23} />,
      title: "按需连接飞书",
      body: "团队截止保持在飞书；私人计划、排序和专注只保存在 Todo Agent。",
    },
    {
      icon: <Sparkles size={23} />,
      title: "AI 是可选增强",
      body: "你可以稍后接入自己的模型 API。批量、外部和高风险操作始终经过权限规则。",
    },
  ];
  const current = steps[step];
  return (
    <div className="modal-backdrop">
      <div
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
      >
        <div className="modal-header">
          <span className="feature-icon">{current.icon}</span>
          <div>
            <h2 id="onboarding-title">{current.title}</h2>
            <p>{current.body}</p>
          </div>
        </div>
        <div className="modal-body">
          <div className="chip-row">
            <span className="chip">
              {step + 1} / {steps.length}
            </span>
            <span className="chip">本地优先</span>
            <span className="chip">随时可关闭 AI</span>
          </div>
          <div className="morning-brief" style={{ marginTop: 16 }}>
            <div className="brief-title">
              <ShieldCheck size={17} />
              数据承诺
            </div>
            <p className="brief-copy">
              连接飞书不会上传本地任务；模型密钥不会进入提示词、普通日志或导出。
            </p>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onDone}>
            跳过并使用本地任务
          </button>
          <span className="action-spacer" />
          {step > 0 && (
            <button
              type="button"
              className="soft-button"
              onClick={() => setStep((value) => value - 1)}
            >
              上一步
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            onClick={() =>
              step === steps.length - 1
                ? onDone()
                : setStep((value) => value + 1)
            }
          >
            {step === steps.length - 1 ? "进入 Today" : "继续"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReminderActionSheet({
  delivery,
  onClose,
  onHandled,
  notify,
}: {
  delivery: ReminderDelivery;
  onClose: () => void;
  onHandled: () => void;
  notify: (message: string, kind?: ToastKind) => void;
}) {
  const initial = new Date(Date.now() + 60 * 60_000);
  initial.setSeconds(0, 0);
  const [customTime, setCustomTime] = useState(
    `${initial.getFullYear()}-${String(initial.getMonth() + 1).padStart(2, "0")}-${String(initial.getDate()).padStart(2, "0")}T${String(initial.getHours()).padStart(2, "0")}:${String(initial.getMinutes()).padStart(2, "0")}`,
  );
  const [busy, setBusy] = useState(false);
  const available = new Set(delivery.actions.map((action) => action.id));
  const act = async (action: ReminderPresetAction) => {
    if (!window.desktopApi || busy) return;
    setBusy(true);
    try {
      await window.desktopApi.notifications.handleAction({
        reminderId: delivery.id,
        action,
      });
      notify(
        action === "complete"
          ? "任务已完成"
          : action === "open"
            ? "已打开任务"
            : "提醒时间已更新",
        "success",
      );
      onHandled();
      onClose();
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "提醒操作失败",
        "error",
      );
    } finally {
      setBusy(false);
    }
  };
  const snoozeCustom = async () => {
    if (!window.desktopApi || busy || !customTime) return;
    setBusy(true);
    try {
      await window.desktopApi.notifications.snoozeUntil(
        delivery.id,
        new Date(customTime).toISOString(),
      );
      notify(
        `已推迟到 ${formatDateTime(new Date(customTime).toISOString())}`,
        "success",
      );
      onClose();
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "自定义稍后时间无效",
        "error",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <div
        className="modal-sheet compact-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reminder-action-title"
      >
        <div className="modal-header">
          <span className="feature-icon">
            <Bell size={20} />
          </span>
          <div>
            <h2 id="reminder-action-title">{delivery.title}</h2>
            <p>{delivery.body}</p>
          </div>
        </div>
        <div className="modal-body">
          <div className="settings-subheading">快速稍后</div>
          <div className="reminder-presets">
            {available.has("snooze-10m") && (
              <button
                type="button"
                className="soft-button"
                disabled={busy}
                onClick={() => void act("snooze-10m")}
              >
                10 分钟
              </button>
            )}
            {available.has("snooze-1h") && (
              <button
                type="button"
                className="soft-button"
                disabled={busy}
                onClick={() => void act("snooze-1h")}
              >
                1 小时
              </button>
            )}
            {available.has("tomorrow") && (
              <button
                type="button"
                className="soft-button"
                disabled={busy}
                onClick={() => void act("tomorrow")}
              >
                明天
              </button>
            )}
          </div>
          <div className="settings-row reminder-custom-row">
            <div>
              <strong>自定义时间</strong>
              <p>至少 1 分钟后，最多 365 天</p>
            </div>
            <div className="custom-snooze-control">
              <input
                type="datetime-local"
                className="settings-input"
                value={customTime}
                onChange={(event) => setCustomTime(event.target.value)}
              />
              <button
                type="button"
                className="soft-button"
                disabled={busy || !customTime}
                onClick={() => void snoozeCustom()}
              >
                设为稍后
              </button>
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={onClose}
          >
            关闭
          </button>
          <span className="action-spacer" />
          {available.has("open") && (
            <button
              type="button"
              className="soft-button"
              disabled={busy}
              onClick={() => void act("open")}
            >
              打开任务
            </button>
          )}
          {available.has("complete") && (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void act("complete")}
            >
              <Check size={15} />
              完成任务
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MainWindow() {
  const initialNavigation = useRef<MainNavigationState>(
    readMainNavigationState(window.history.state) ?? {
      route: "today",
      index: 0,
    },
  );
  const navigation = useRef<MainNavigationState>(initialNavigation.current);
  const [route, setRoute] = useState<MainRoute>(
    initialNavigation.current.route,
  );
  const [search, setSearch] = useState("");
  const [agentDraft, setAgentDraft] = useState("");
  const [pendingTaskId, setPendingTaskId] = useState<string>();
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatusView>();
  const [taskCollectionEpoch, setTaskCollectionEpoch] = useState(0);
  const [sourceFilter, setSourceFilter] = useState<TaskSourceType | undefined>(
    initialNavigation.current.sourceFilter,
  );
  const applyNavigationState = useCallback((next: MainNavigationState) => {
    navigation.current = next;
    setRoute(next.route);
    setSourceFilter(next.sourceFilter);
  }, []);
  const navigate = useCallback(
    (
      nextRoute: MainRoute,
      nextSourceFilter?: TaskSourceType,
      options: { replace?: boolean } = {},
    ) => {
      const current = navigation.current;
      if (
        !options.replace &&
        current.route === nextRoute &&
        current.sourceFilter === nextSourceFilter
      ) {
        return;
      }
      const next: MainNavigationState = {
        route: nextRoute,
        sourceFilter: nextSourceFilter,
        index: options.replace ? current.index : current.index + 1,
      };
      if (options.replace) {
        window.history.replaceState(withMainNavigationState(next), "");
      } else {
        window.history.pushState(withMainNavigationState(next), "");
      }
      applyNavigationState(next);
    },
    [applyNavigationState],
  );
  const navigateTaskCollection = useCallback(
    (
      nextRoute: TaskView,
      nextSourceFilter?: TaskSourceType,
      options: { replace?: boolean } = {},
    ) => {
      // Sidebar views are collections, not saved search tabs. Clear the
      // temporary header query even when the user clicks the active view, so
      // a stale query can never hide a non-zero sidebar count.
      setSearch("");
      setTaskCollectionEpoch((value) => value + 1);
      navigate(nextRoute, nextSourceFilter, options);
    },
    [navigate],
  );
  const navigateFromSidebar = useCallback(
    (nextRoute: MainRoute) => {
      if (isTaskMainRoute(nextRoute)) {
        navigateTaskCollection(nextRoute);
        return;
      }
      navigate(nextRoute);
    },
    [navigate, navigateTaskCollection],
  );
  const goBack = useCallback(() => {
    if (navigation.current.index > 0 && window.history.length > 1) {
      window.history.back();
      return;
    }
    navigateTaskCollection("today", undefined, { replace: true });
  }, [navigateTaskCollection]);
  const taskView: TaskView = [
    "inbox",
    "today",
    "upcoming",
    "all",
    "completed",
    "trash",
  ].includes(route)
    ? (route as TaskView)
    : "today";
  const controller = useTaskController(taskView, search, sourceFilter);
  // The timeline is a planning surface over all open tasks, independent of
  // whichever collection is currently selected in the main list.
  const timelineController = useTaskController("all", "", sourceFilter);
  // Completed tasks are a separate view in the local service. Keep them in
  // the timeline snapshot so the week overview can show a truthful review
  // rather than silently reporting zero completions.
  const timelineCompletedController = useTaskController("completed", "", sourceFilter);
  const sidebarCounts = useSidebarCounts();
  const projectState = useProjects();
  const listState = useLists();
  const [newTask, setNewTask] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [dailyPlanOpen, setDailyPlanOpen] = useState(false);
  const [dailyPlanDate, setDailyPlanDate] = useState(() => dateKey());
  const [dailyPlanTasks, setDailyPlanTasks] = useState<Task[]>([]);
  const [dailyPlanLoading, setDailyPlanLoading] = useState(false);
  const [dailyPlanError, setDailyPlanError] = useState<string>();
  const [activeReminder, setActiveReminder] = useState<ReminderDelivery>();
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const toastRouteRef = useRef(route);
  const [onboarding, setOnboarding] = useState(
    () => localStorage.getItem("todo-agent:onboarding-complete") !== "true",
  );
  const loadDailyPlan = useCallback(async () => {
    setDailyPlanLoading(true);
    setDailyPlanError(undefined);
    try {
      const tasks = window.desktopApi
        ? await Promise.all([
            window.desktopApi.tasks.list({ view: "all" }),
            // Completed dependencies are not candidates, but the planner
            // needs them to avoid labelling an already-unblocked task as
            // blocked merely because its dependency is absent from All.
            window.desktopApi.tasks.list({ view: "completed" }),
          ]).then(([open, completed]) => [...open, ...completed])
        : controller.tasks;
      setDailyPlanTasks(tasks);
    } catch (reason) {
      setDailyPlanError(
        reason instanceof Error ? reason.message : "暂时无法读取全部任务",
      );
    } finally {
      setDailyPlanLoading(false);
    }
  }, [controller.tasks]);
  const openDailyPlan = useCallback((targetDate = dateKey()) => {
    setDailyPlanDate(targetDate);
    setDailyPlanOpen(true);
    void loadDailyPlan();
  }, [loadDailyPlan]);
  useEffect(() => {
    const stored = readMainNavigationState(window.history.state);
    if (stored) {
      applyNavigationState(stored);
    } else {
      window.history.replaceState(
        withMainNavigationState(navigation.current),
        "",
      );
    }
    const onPopState = (event: PopStateEvent) => {
      const next = readMainNavigationState(event.state);
      applyNavigationState(next ?? { route: "today", index: 0 });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyNavigationState]);
  useEffect(() => {
    const previousRoute = toastRouteRef.current;
    if (isTaskMainRoute(previousRoute) && !isTaskMainRoute(route)) {
      // Field-save confirmations belong to the task context that produced
      // them. Do not carry a stack of old success messages over a new page
      // where it could obscure a live setting or Agent control. Errors and
      // actionable notices remain available until their normal timeout.
      setToasts((current) =>
        current.filter((toast) => toast.kind !== "success" || Boolean(toast.action)),
      );
    }
    toastRouteRef.current = route;
  }, [route]);
  useEffect(() => {
    if (!window.desktopApi) return;
    void window.desktopApi.settings
      .get()
      .then((settings) => setOnboarding(!settings.onboardingComplete));
  }, []);
  const notify = useCallback(
    (
      message: string,
      kind: ToastKind = "info",
      action?: ToastState["action"],
    ) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current, { id, message, kind, action }]);
      window.setTimeout(
        () =>
          setToasts((current) => current.filter((toast) => toast.id !== id)),
        4200,
      );
    },
    [],
  );
  const openCommandPalette = useCallback(() => {
    setCommandPaletteOpen(true);
  }, []);
  const closeCommandPalette = useCallback(() => {
    setCommandPaletteOpen(false);
  }, []);
  const commandPaletteActions = useMemo<readonly CommandPaletteAction[]>(
    () => [
      {
        id: "new-task",
        label: "新建任务",
        description: "打开完整编辑器，补充日期、提醒、标签或来源",
        keywords: ["create", "new", "任务", "新增"],
        shortcut: "⌘ N",
        icon: <Plus size={16} />,
        run: () => setNewTask(true),
      },
      {
        id: "quick-capture",
        label: "快速捕获",
        description: "用一句话、语音或上下文快速记下新任务",
        keywords: ["quick", "capture", "inbox", "快捷", "语音"],
        shortcut: "⌘ ⇧ Space",
        icon: <Clipboard size={16} />,
        run: () => void window.desktopApi?.shell.showQuickCapture(),
      },
      {
        id: "search-tasks",
        label: "搜索任务",
        description: "进入全部任务并聚焦搜索框",
        keywords: ["search", "find", "搜索", "查找"],
        shortcut: "⌘ F",
        icon: <Search size={16} />,
        run: () => {
          navigateTaskCollection("all");
          window.setTimeout(
            () =>
              document
                .querySelector<HTMLInputElement>("[data-search-input]")
                ?.focus(),
            0,
          );
        },
      },
      {
        id: "today",
        label: "打开今天",
        description: "回到 Today 工作台，查看当前计划",
        keywords: ["today", "my day", "今天", "计划"],
        icon: <Sun size={16} />,
        run: () => navigateTaskCollection("today"),
      },
      {
        id: "inbox",
        label: "整理暂存",
        description: "逐项处理尚未安排日期、项目或清单的任务",
        keywords: ["inbox", "暂存", "整理"],
        icon: <Inbox size={16} />,
        run: () => navigateTaskCollection("inbox"),
      },
      {
        id: "all",
        label: "打开全部任务",
        description: "查看完整任务事实，不受 Today 过滤影响",
        keywords: ["all", "全部", "任务"],
        icon: <LayoutList size={16} />,
        run: () => navigateTaskCollection("all"),
      },
      {
        id: "plan-today",
        label: "一起规划今天",
        description: "预览容量、依赖和预计时长后安排 Today",
        keywords: ["plan", "planner", "规划", "排程", "容量"],
        icon: <CalendarDays size={16} />,
        run: () => {
          navigateTaskCollection("today");
          openDailyPlan();
        },
      },
      {
        id: "pet",
        label: "打开 Todo Pet 小窝",
        description: "查看成长、日记、回顾和陪伴设置",
        keywords: ["pet", "home", "小窝", "宠物"],
        icon: <UserRound size={16} />,
        run: () => navigate("pet"),
      },
      {
        id: "agent",
        label: "和 Agent 聊聊",
        description: "进入流式 Markdown 对话，先查询再确认任务操作",
        keywords: ["agent", "chat", "AI", "对话"],
        icon: <Sparkles size={16} />,
        run: () => navigate("agent"),
      },
      {
        id: "sync",
        label: "同步飞书",
        description: "打开同步页并手动刷新当前连接",
        keywords: ["sync", "feishu", "飞书", "刷新"],
        icon: <RefreshCw size={16} />,
        run: () => {
          navigate("sync");
          void window.desktopApi?.feishu
            .syncNow()
            .then((report) =>
              notify(
                report.issue
                  ? feishuSyncIssueCopy(report.issue)
                  : `同步完成：拉取 ${report.pulled}，上传 ${report.pushed}`,
                report.issue ? "error" : "success",
              ),
            )
            .catch((reason) =>
              notify(
                reason instanceof Error ? reason.message : "同步失败，请稍后重试",
                "error",
              ),
            );
        },
      },
      {
        id: "show-pet",
        label: "显示桌面宠物",
        description: "重新显示并唤起置顶的 Todo Pet",
        keywords: ["floating", "pet", "show", "悬浮", "显示"],
        icon: <PanelTop size={16} />,
        run: () => void window.desktopApi?.shell.setFloatingVisible(true),
      },
      {
        id: "settings",
        label: "打开设置",
        description: "配置快捷键、同步、模型、提醒和宠物行为",
        keywords: ["settings", "preferences", "设置", "偏好"],
        icon: <Settings size={16} />,
        run: () => navigate("settings"),
      },
    ],
    [navigate, navigateTaskCollection, notify, openDailyPlan],
  );
  useEffect(
    () =>
      window.desktopApi?.events.onNotification((event) => {
        if (event.type !== "delivery") return;
        notify(`${event.delivery.title}：${event.delivery.body}`, "info", {
          label: "处理",
          run: () => setActiveReminder(event.delivery),
        });
      }),
    [notify],
  );
  useEffect(
    () =>
      window.desktopApi?.events.onShortcutError((shortcut) => {
        notify(`快捷键 ${shortcut} 已被其他应用占用，请在设置中更换`, "error", {
          label: "打开设置",
          run: () => navigate("settings"),
        });
      }),
    [navigate, notify],
  );
  useEffect(() => {
    const applyNavigation = (value: string) => {
      if (value === "plan-today") {
        navigateTaskCollection("today");
        openDailyPlan();
        return;
      }
      if (value.startsWith("task:")) {
        const id = value.slice("task:".length);
        if (id) {
          setPendingTaskId(id);
          navigateTaskCollection("all");
        }
        return;
      }
      if (!(value in routeTitles)) return;
      navigateFromSidebar(value as MainRoute);
      if (value === "agent") {
        void window.desktopApi?.tasks
          .getDraft(floatingAgentDraftId)
          .then((draft) => {
            if (!draft?.text) return;
            setAgentDraft(draft.text);
            return window.desktopApi?.tasks.deleteDraft(floatingAgentDraftId);
          });
      }
    };
    if (window.desktopApi) {
      return window.desktopApi.events.onNavigation(applyNavigation);
    }
    const onRoute = (event: Event) => {
      const value = (event as CustomEvent<string>).detail;
      applyNavigation(value);
    };
    window.addEventListener("todo-agent:navigation", onRoute);
    return () => window.removeEventListener("todo-agent:navigation", onRoute);
  }, [navigateFromSidebar, navigateTaskCollection, openDailyPlan]);
  useEffect(() => {
    const api = window.desktopApi;
    if (!api) return undefined;
    void api.feishu.status().then(setFeishuStatus).catch(() => undefined);
    return api.events.onFeishuStatus(setFeishuStatus);
  }, []);
  useEffect(() => {
    if (
      !pendingTaskId ||
      !controller.tasks.some((task) => task.id === pendingTaskId)
    )
      return;
    controller.select(pendingTaskId);
    setPendingTaskId(undefined);
  }, [controller, pendingTaskId]);
  const isTaskRoute = [
    "inbox",
    "today",
    "upcoming",
    "all",
    "completed",
    "trash",
  ].includes(route);
  const modalOpen = Boolean(
    newTask || commandPaletteOpen || dailyPlanOpen || activeReminder || onboarding,
  );
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const isBackShortcut = isMacPlatform()
        ? event.metaKey && event.key === "["
        : event.altKey && event.key === "ArrowLeft";
      const shortcutKey =
        (event.metaKey || event.ctrlKey) &&
        ["k", "n"].includes(event.key.toLocaleLowerCase());
      if (modalOpen && !commandPaletteOpen) {
        if (isBackShortcut || shortcutKey) event.preventDefault();
        return;
      }
      if (commandPaletteOpen) {
        if (isBackShortcut || shortcutKey) event.preventDefault();
        return;
      }
      if (isBackShortcut) {
        event.preventDefault();
        goBack();
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === "k"
      ) {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === "n"
      ) {
        event.preventDefault();
        setNewTask(true);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [commandPaletteOpen, goBack, modalOpen]);
  const feishuState = feishuSyncVisualState(feishuStatus);
  const syncState: TaskSyncVisualState = controller.tasks.some(
    (task) => taskSyncVisualState(task.sync.status) === "error",
  ) || feishuState === "error"
    ? "error"
    : controller.tasks.some(
          (task) => taskSyncVisualState(task.sync.status) === "conflict",
        )
      ? "conflict"
      : controller.tasks.some(
            (task) => taskSyncVisualState(task.sync.status) === "pending",
          ) || feishuState === "pending"
        ? "pending"
        : "synced";
  const finishOnboarding = () => {
    localStorage.setItem("todo-agent:onboarding-complete", "true");
    setOnboarding(false);
    if (window.desktopApi) {
      void window.desktopApi.settings.get().then((settings) =>
        window.desktopApi!.settings.replace({
          ...settings,
          onboardingComplete: true,
        }),
      );
    }
  };
  const showSource = useCallback(
    (source: TaskSourceType) => navigateTaskCollection("all", source),
    [navigateTaskCollection],
  );
  const askAgent = useCallback(
    (prompt: string) => {
      setAgentDraft(prompt);
      navigate("agent");
    },
    [navigate],
  );
  const consumeAgentDraft = useCallback(() => setAgentDraft(""), []);
  return (
    <div
      className="app-background"
      data-inspector-open={
        isTaskRoute && controller.selected ? "true" : undefined
      }
      data-modal-open={
        modalOpen ? "true" : undefined
      }
    >
      <div className="app-window">
        <Titlebar
          search={isTaskRoute ? search : undefined}
          onSearch={isTaskRoute ? setSearch : undefined}
          onNew={() => setNewTask(true)}
          onOpenCommands={openCommandPalette}
          onHome={() => navigateTaskCollection("today")}
          onBack={route === "today" ? undefined : goBack}
          syncState={syncState}
        />
        <div className="shell-grid" data-route={route}>
          <Sidebar
            route={route}
            sourceFilter={sourceFilter}
            counts={{
              ...sidebarCounts,
              syncIssues:
                (sidebarCounts.syncIssues ?? 0) + (feishuState === "error" ? 1 : 0),
            }}
            onRoute={navigateFromSidebar}
            onSource={showSource}
          />
          {isTaskRoute && (
            <>
              <TaskListPage
                route={taskView}
                controller={controller}
                planningTasks={timelineController.tasks}
                search={search}
                navigationKey={`${taskView}:${taskCollectionEpoch}`}
                sourceFilter={sourceFilter}
                notify={notify}
                onNew={() => setNewTask(true)}
                onClearSearch={() => setSearch("")}
                onAskAgent={askAgent}
                onPlanToday={openDailyPlan}
                onSourceChange={(source) => navigate(taskView, source, { replace: true })}
              />
              <TaskInspector
                task={controller.selected}
                controller={controller}
                projects={projectState.projects}
                lists={listState.lists}
                notify={notify}
                onAskAgent={askAgent}
                onClose={() => controller.select(undefined)}
              />
            </>
          )}
          <div className="route-workspace" hidden={route !== "agent"}>
            <AgentPage
              controller={controller}
              notify={notify}
              initialPrompt={agentDraft}
              onPromptConsumed={consumeAgentDraft}
            />
          </div>
          <div className="route-workspace" hidden={route !== "settings"}>
            <SettingsPage notify={notify} />
          </div>
          {route === "timeline" && (
            <div className="route-workspace">
              <TimelinePage
                tasks={[...timelineController.tasks, ...timelineCompletedController.tasks]}
                loading={timelineController.loading || timelineCompletedController.loading}
                error={timelineController.error ?? timelineCompletedController.error}
                onRetry={() => {
                  void timelineController.refresh();
                  void timelineCompletedController.refresh();
                }}
                onSelect={(taskId) => {
                  setPendingTaskId(taskId);
                  navigateTaskCollection("all", sourceFilter);
                }}
                onMove={(taskId, patch) => timelineController.update(taskId, patch)}
                onUndo={(operationId) => {
                  void timelineController.undo(operationId);
                }}
                notify={notify}
              />
            </div>
          )}
          {route === "projects" && (
            <div className="route-workspace">
              <ProjectPage
                tasks={[...timelineController.tasks, ...timelineCompletedController.tasks]}
                projects={projectState.projects}
                loading={timelineController.loading || timelineCompletedController.loading || projectState.loading}
                error={timelineController.error ?? timelineCompletedController.error ?? projectState.error}
                onRetry={() => {
                  void timelineController.refresh();
                  void timelineCompletedController.refresh();
                  void projectState.refresh();
                }}
                onSelect={(task) => {
                  setPendingTaskId(task.id);
                  navigateTaskCollection(task.status === "completed" ? "completed" : "all", sourceFilter);
                }}
                onCreateProject={async (input) => {
                  if (!window.desktopApi) return;
                  await window.desktopApi.tasks.createProject(input);
                  await projectState.refresh();
                  notify(`项目“${input.name}”已创建`, "success");
                }}
                onUpdateProject={async (id, patch) => {
                  if (!window.desktopApi) return;
                  await window.desktopApi.tasks.updateProject({ id, patch });
                  await projectState.refresh();
                  notify("项目已更新", "success");
                }}
                onDeleteProject={async (id) => {
                  if (!window.desktopApi) return;
                  const result = await window.desktopApi.tasks.deleteProject(id);
                  await projectState.refresh();
                  notify(result.clearedTaskIds.length > 0 ? `项目已删除，并解除 ${result.clearedTaskIds.length} 项任务关联` : "项目已删除", "success");
                }}
              />
            </div>
          )}
          {route === "lists" && (
            <div className="route-workspace">
              <ListPage
                tasks={[...timelineController.tasks, ...timelineCompletedController.tasks]}
                lists={listState.lists}
                loading={timelineController.loading || timelineCompletedController.loading || listState.loading}
                error={timelineController.error ?? timelineCompletedController.error ?? listState.error}
                onRetry={() => {
                  void timelineController.refresh();
                  void timelineCompletedController.refresh();
                  void listState.refresh();
                }}
                onSelect={(task) => {
                  setPendingTaskId(task.id);
                  navigateTaskCollection(task.status === "completed" ? "completed" : "all", sourceFilter);
                }}
                onCreateList={async (input) => {
                  if (!window.desktopApi) return;
                  await window.desktopApi.tasks.createList(input);
                  await listState.refresh();
                  notify(`清单“${input.name}”已创建`, "success");
                }}
                onUpdateList={async (id, patch) => {
                  if (!window.desktopApi) return;
                  await window.desktopApi.tasks.updateList({ id, patch });
                  await listState.refresh();
                  notify("清单已更新", "success");
                }}
                onDeleteList={async (id) => {
                  if (!window.desktopApi) return;
                  const result = await window.desktopApi.tasks.deleteList(id);
                  await listState.refresh();
                  notify(result.clearedTaskIds.length > 0 ? `清单已删除，并解除 ${result.clearedTaskIds.length} 项任务关联` : "清单已删除", "success");
                }}
              />
            </div>
          )}
          {route === "pet" && (
            <div className="route-workspace">
              <PetHomePage
                notify={notify}
                tasks={[...timelineController.tasks, ...timelineCompletedController.tasks]}
                onNavigate={navigateFromSidebar}
                onPlanTomorrow={() => {
                  const tomorrow = new Date();
                  tomorrow.setDate(tomorrow.getDate() + 1);
                  openDailyPlan(dateKey(tomorrow));
                }}
                onNavigateTask={(task) => {
                  setPendingTaskId(task.id);
                  navigateTaskCollection(
                    task.status === "completed" ? "completed" : "all",
                  );
                }}
              />
            </div>
          )}
          {route === "activity" && (
            <div className="route-workspace">
              <ActivityPage controller={controller} notify={notify} />
            </div>
          )}
          {route === "sync" && (
            <div className="route-workspace">
              <SyncPage notify={notify} />
            </div>
          )}
        </div>
        {newTask && (
          <NewTaskSheet
            onClose={() => setNewTask(false)}
            controller={controller}
            projects={projectState.projects}
            lists={listState.lists}
            notify={notify}
          />
        )}
        {commandPaletteOpen && (
          <CommandPalette
            actions={commandPaletteActions}
            onClose={closeCommandPalette}
          />
        )}
        {dailyPlanOpen && (
          <DailyPlanSheet
            tasks={dailyPlanTasks}
            loading={dailyPlanLoading}
            error={dailyPlanError}
            date={dailyPlanDate}
            targetLabel={relativePlanLabel(dailyPlanDate)}
            onRetry={loadDailyPlan}
            onClose={() => setDailyPlanOpen(false)}
            onApply={async (request) => {
              const operationId = await controller.applyTodayPlan(request);
              await loadDailyPlan();
              return operationId;
            }}
            onUndo={async (operationId) => {
              await controller.undo(operationId);
              await loadDailyPlan();
            }}
            onStartFirst={async (task) => {
              await controller.startFocus(task.id);
              notify(`已开始“${task.title}”`, "success");
              setDailyPlanOpen(false);
            }}
            onAskAgent={(prompt) => {
              setDailyPlanOpen(false);
              askAgent(prompt);
            }}
          />
        )}
        {activeReminder && (
          <ReminderActionSheet
            delivery={activeReminder}
            onClose={() => setActiveReminder(undefined)}
            onHandled={() => void controller.refresh()}
            notify={notify}
          />
        )}
        {onboarding && <Onboarding onDone={finishOnboarding} />}
      </div>
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <span>
              {toast.kind === "success" ? (
                <CheckCircle2 size={18} />
              ) : toast.kind === "error" ? (
                <AlertTriangle size={18} />
              ) : (
                <Info size={18} />
              )}
            </span>
            <span>{toast.message}</span>
            {toast.action && (
              <button type="button" onClick={toast.action.run}>
                {toast.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function captureFields(text: string) {
  const source: TaskSourceType = text.includes("飞书") ? "feishu" : "local";
  const durationPattern = /(?:预计|大约|约|用时|耗时|时长|需要)[:：]?\s*(\d+(?:\.\d+)?)\s*(分钟|分|小时|时|m|h)/iu;
  const shorthandDurationPattern = /(\d+(?:\.\d+)?)\s*(m|h)\b/iu;
  const durationMatch = text.match(durationPattern) ?? text.match(shorthandDurationPattern);
  const durationAmount = durationMatch ? Number(durationMatch[1]) : NaN;
  const durationUnit = durationMatch?.[2]?.toLocaleLowerCase();
  const durationMinutes = Number.isFinite(durationAmount) && durationAmount > 0
    ? Math.round(durationUnit === "小时" || durationUnit === "时" || durationUnit === "h" ? durationAmount * 60 : durationAmount)
    : undefined;
  const estimatedMinutes = durationMinutes !== undefined && durationMinutes >= 5 && durationMinutes <= 720
    ? durationMinutes
    : undefined;
  const weekdayMap: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const recurrenceMonthly = text.match(/每(?:隔\s*)?(\d+)?\s*个?月(?:\s*(\d{1,2})\s*(?:日|号))?/u);
  const recurrenceWeekly = text.match(/每(?:隔\s*)?(\d+)?\s*周([一二三四五六日天周、，,和\s]*)?/u);
  const recurrenceDaily = text.match(/每(?:隔\s*)?(\d+)?\s*天/u);
  const recurrenceWorkday = text.match(/工作日/u);
  const recurrenceMatch = recurrenceMonthly ?? recurrenceWeekly ?? recurrenceDaily ?? recurrenceWorkday;
  const recurrence: RecurrenceRule | undefined = recurrenceMonthly
    ? {
        frequency: "monthly",
        interval: Number(recurrenceMonthly[1] ?? 1),
        ...(recurrenceMonthly[2] ? { dayOfMonth: Number(recurrenceMonthly[2]) } : {}),
      }
    : recurrenceWeekly
      ? {
          frequency: "weekly",
          interval: Number(recurrenceWeekly[1] ?? 1),
          ...(() => {
            const weekdays = [...(recurrenceWeekly[2] ?? "")]
              .map((character) => weekdayMap[character])
              .filter((day): day is number => day !== undefined)
              .filter((day, index, values) => values.indexOf(day) === index)
              .sort((left, right) => left - right);
            return weekdays.length ? { weekdays } : {};
          })(),
        }
      : recurrenceDaily
        ? { frequency: "daily", interval: Number(recurrenceDaily[1] ?? 1) }
        : recurrenceWorkday
          ? { frequency: "weekly", interval: 1, weekdays: [1, 2, 3, 4, 5] }
          : undefined;
  const contexts = [
    ...(text.match(/(?:情境|场景|地点)[:：]\s*([^，,。；;\s]+)/u)?.[1]
      ? [text.match(/(?:情境|场景|地点)[:：]\s*([^，,。；;\s]+)/u)![1]]
      : []),
    ...[...text.matchAll(/@([\p{L}\p{N}_-]{1,40})/gu)].map((match) => match[1]),
  ].filter((context, index, values) => {
    const key = context.trim().toLocaleLowerCase();
    return values.findIndex((candidate) => candidate.trim().toLocaleLowerCase() === key) === index;
  });
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = text.includes("明天")
    ? dateKey(tomorrow)
    : text.includes("今天")
      ? dateKey()
      : undefined;
  const title =
    text
      .replace(
        /(?:明天|今天)(?:上午|下午|晚上)?(?:[一二三四五六七八九十\d]+点(?:半)?(?:前)?|)/gu,
        "",
      )
      .replace(/(?:存|创建|同步|放|添加)到飞书(?:任务)?/gu, "")
      .replace(/(?:存|创建|放|添加)到本地(?:任务)?/gu, "")
      .replace(/(?:情境|场景|地点)[:：]\s*([^，,。；;\s]+)/gu, "")
      .replace(/@([\p{L}\p{N}_-]{1,40})/gu, "")
      .replace(durationPattern, "")
      .replace(shorthandDurationPattern, "")
      .replace(recurrenceMatch?.[0] ?? "", "")
      .replace(/并?提前.*?提醒/gu, "")
      .replace(/[，,。]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim() || text.trim();
  return { source, date, title, contexts, estimatedMinutes, recurrence };
}

type QuickCaptureDestination = "task" | "inbox" | "diary";

function QuickCaptureWindow() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [captureError, setCaptureError] = useState("");
  const [captureDestination, setCaptureDestination] =
    useState<QuickCaptureDestination>("task");
  const captureIdRef = useRef(`quick-capture-${crypto.randomUUID()}`);
  const [clipboardContext, setClipboardContext] = useState<{
    text: string;
    characters: number;
    truncated: boolean;
    capturedAt: string;
  }>();
  const [clipboardLoading, setClipboardLoading] = useState(false);
  const [windowContext, setWindowContext] = useState<{
    status: "captured" | "unavailable";
    appName?: string;
    title?: string;
    reason?: "unsupported" | "permission-denied" | "empty" | "error";
    capturedAt: string;
  }>();
  const [windowContextLoading, setWindowContextLoading] = useState(false);
  const [selectedTextContext, setSelectedTextContext] = useState<{
    status: "captured" | "unavailable";
    text?: string;
    characters?: number;
    truncated?: boolean;
    capturedAt: string;
    reason?: "unsupported" | "permission-denied" | "empty" | "error";
  }>();
  const [selectedTextLoading, setSelectedTextLoading] = useState(false);
  const [dropPreview, setDropPreview] = useState<DropContextPreview>();
  const [dropActive, setDropActive] = useState(false);
  const fallbackFields = useMemo(() => captureFields(text), [text]);
  const [parsed, setParsed] = useState<QuickCaptureResult>();
  const fields =
    parsed?.originalText === text.trim()
      ? {
          source: parsed.source,
          date: (parsed.privatePlanAt ?? parsed.dueAt)?.slice(0, 10),
          title: parsed.title,
          dueAt: parsed.dueAt,
          privatePlanAt: parsed.privatePlanAt,
          reminderAt: parsed.reminderAt,
          project: parsed.project,
          tags: parsed.tags,
          contexts: parsed.contexts,
          estimatedMinutes: parsed.estimatedMinutes,
          recurrence: parsed.recurrence,
          priority: parsed.priority,
          chips: parsed.chips,
          needsReview: parsed.needsReview,
        }
      : {
          ...fallbackFields,
          project: undefined,
          tags: [],
          contexts: fallbackFields.contexts,
          priority: 1 as const,
          chips: [],
          needsReview: false,
        };
  const controller = useTaskController("inbox", "");
  const taskTemplates = useTaskTemplates();
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const voice = useVoiceCapture({
    onFinal: (spoken) =>
      setText((current) =>
        current.trim() ? `${current.trim()} ${spoken}` : spoken,
      ),
  });
  const selectedTemplate = taskTemplates.templates.find(
    (template) => template.id === selectedTemplateId,
  );
  const templatePreview = selectedTemplate && fields.title
    ? previewTaskTemplate(selectedTemplate, fields.title, {
        date: fields.privatePlanAt?.slice(0, 10) ?? fields.date ?? new Date().toISOString().slice(0, 10),
        dueAt: fields.dueAt,
      })
    : undefined;
  useEffect(() => {
    void window.desktopApi?.tasks.getDraft("quick-capture").then((draft) => {
      if (draft?.text) setText(draft.text);
    });
    const unsubscribe = window.desktopApi?.events.onQuickCaptureFocus(() =>
      inputRef.current?.focus(),
    );
    inputRef.current?.focus();
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!text.trim() || !window.desktopApi) {
      setParsed(undefined);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void window.desktopApi?.capture
        .parse(text)
        .then(setParsed)
        .catch(() => setParsed(undefined));
    }, 90);
    return () => window.clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (text)
        void window.desktopApi?.tasks.saveDraft({
          id: "quick-capture",
          kind: "quick-capture",
          text,
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [text]);
  const save = async (source = fields.source, openAfterSave = false) => {
    if (!fields.title || saving) return;
    setSaving(true);
    setCaptureError("");
    try {
      if (captureDestination === "diary") {
        const createDiaryFromCapture = window.desktopApi?.pet.createDiaryFromCapture;
        if (!createDiaryFromCapture) throw new Error("当前版本暂不支持写入日记，请先更新应用");
        await createDiaryFromCapture({
          title: fields.title,
          content: text.trim(),
          localDate: fields.date ?? new Date().toISOString().slice(0, 10),
          captureId: captureIdRef.current,
        });
        await window.desktopApi?.tasks.deleteDraft("quick-capture");
        setText("");
        setSelectedTemplateId("");
        captureIdRef.current = `quick-capture-${crypto.randomUUID()}`;
        if (openAfterSave) await window.desktopApi?.shell.showMain("home");
        window.setTimeout(() => {
          void window.desktopApi?.shell.hideCurrentWindow();
        }, 260);
        return;
      }
      const feishu =
        captureDestination === "task" && source === "feishu"
          ? await window.desktopApi?.feishu.status()
          : undefined;
      const effectiveSource = captureDestination === "inbox" ? "local" : source;
      const blockedFeishuMessage = feishuCreationBlockedMessage(effectiveSource, feishu);
      if (blockedFeishuMessage) throw new Error(blockedFeishuMessage);
      const priorities: TaskPriority[] = ["low", "medium", "high", "urgent"];
      const baseDate =
        captureDestination === "inbox"
          ? undefined
          : fields.privatePlanAt?.slice(0, 10) ??
            (!fields.dueAt ? fields.date : undefined) ??
            new Date().toISOString().slice(0, 10);
      const baseInput = {
        source:
          effectiveSource === "feishu"
            ? { type: "feishu" as const, accountId: feishu?.accountId }
            : { type: "local" as const },
        projectId: captureDestination === "inbox" ? undefined : fields.project,
        contexts: fields.contexts,
        sync: effectiveSource === "feishu" ? { status: "pending" as const } : { status: "local" as const },
      };
      const templateInputs = selectedTemplate
        ? buildTaskTemplateInputs(selectedTemplate, fields.title, {
            date: baseDate ?? new Date().toISOString().slice(0, 10),
            dueAt: fields.dueAt,
            tags: fields.tags,
            priority: priorities[fields.priority] ?? "medium",
            reminderAt: fields.reminderAt,
          })
        : [
            {
              title: fields.title,
              plannedDate: baseDate,
              dueAt: fields.dueAt,
              tags: fields.tags,
              estimatedMinutes: fields.estimatedMinutes,
              recurrence: fields.source === "local" ? fields.recurrence : undefined,
              priority: priorities[fields.priority] ?? "medium",
              reminders: fields.reminderAt
                ? [
                    {
                      id: crypto.randomUUID(),
                      at: fields.reminderAt,
                      enabled: true,
                      source: "local" as const,
                    },
                  ]
                : [],
            },
          ];
      const destinationInputs = templateInputs.map((input) =>
        captureDestination === "inbox"
          ? {
              ...input,
              plannedDate: undefined,
              dueAt: undefined,
              reminders: [],
              recurrence: undefined,
            }
          : input,
      );
      let firstResult: Awaited<ReturnType<typeof controller.create>>;
      let createdCount = 0;
      for (const input of destinationInputs) {
        try {
          const result = await controller.create({
            ...baseInput,
            ...input,
            source: effectiveSource === "feishu"
              ? { type: "feishu" as const, accountId: feishu?.accountId }
              : { type: "local" as const },
            sync: effectiveSource === "feishu"
              ? { status: "pending" as const }
              : { status: "local" as const },
          });
          firstResult ??= result;
          createdCount += 1;
        } catch (reason) {
          const detail = reason instanceof Error ? reason.message : "未知错误";
          if (selectedTemplate && createdCount > 0) {
            throw new Error(`模板已创建 ${createdCount}/${destinationInputs.length} 项，剩余步骤未创建：${detail}`);
          }
          throw reason;
        }
      }
      await window.desktopApi?.tasks.deleteDraft("quick-capture");
      setText("");
      setSelectedTemplateId("");
      captureIdRef.current = `quick-capture-${crypto.randomUUID()}`;
      if (openAfterSave) {
        await window.desktopApi?.shell.showMain(
          firstResult?.task.id ? `task:${firstResult.task.id}` : "today",
        );
      }
      window.setTimeout(() => {
        void window.desktopApi?.shell.hideCurrentWindow();
      }, 260);
    } catch (reason) {
      setCaptureError(
        reason instanceof Error ? reason.message : "保存任务失败",
      );
    } finally {
      setSaving(false);
    }
  };
  const readClipboardContext = async () => {
    if (!window.desktopApi?.shell.readClipboard || clipboardLoading) return;
    setClipboardLoading(true);
    setCaptureError("");
    try {
      const preview = await window.desktopApi.shell.readClipboard();
      if (!preview.text.trim()) {
        setCaptureError("剪贴板里没有可预览的文字");
        setClipboardContext(undefined);
      } else {
        setClipboardContext(preview);
      }
    } catch (reason) {
      setCaptureError(reason instanceof Error ? reason.message : "读取剪贴板失败");
    } finally {
      setClipboardLoading(false);
    }
  };
  const readActiveWindowContext = async () => {
    if (!window.desktopApi?.shell.readActiveWindow || windowContextLoading) return;
    setWindowContextLoading(true);
    setCaptureError("");
    try {
      setWindowContext(await window.desktopApi.shell.readActiveWindow());
    } catch (reason) {
      setWindowContext({
        status: "unavailable",
        reason: "error",
        capturedAt: new Date().toISOString(),
      });
      setCaptureError(reason instanceof Error ? reason.message : "读取当前窗口失败");
    } finally {
      setWindowContextLoading(false);
    }
  };
  const readSelectedTextContext = async () => {
    if (!window.desktopApi?.shell.readSelectedText || selectedTextLoading) return;
    setSelectedTextLoading(true);
    setCaptureError("");
    try {
      setSelectedTextContext(await window.desktopApi.shell.readSelectedText());
    } catch (reason) {
      setSelectedTextContext({
        status: "unavailable",
        reason: "error",
        capturedAt: new Date().toISOString(),
      });
      setCaptureError(reason instanceof Error ? reason.message : "读取选中文本失败");
    } finally {
      setSelectedTextLoading(false);
    }
  };
  const captureDropPreview = (dataTransfer: DataTransfer) =>
    buildDropContextPreview({
      plainText: dataTransfer.getData("text/plain"),
      uriList: dataTransfer.getData("text/uri-list"),
      files: Array.from(dataTransfer.files).map((file) => ({
        name: file.name,
        type: file.type,
        size: file.size,
      })),
    });
  const applyDropToText = () => {
    if (!dropPreview) return;
    const value = dropPreview.kind === "url" ? dropPreview.url : dropPreview.text;
    if (!value) return;
    setText((current) => (current.trim() ? `${current}\n${value}` : value));
    setDropPreview(undefined);
  };
  return (
    <div className="quick-shell">
      <div
        className={`quick-panel ${dropActive ? "is-drop-active" : ""}`}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.some((type) => ["text/plain", "text/uri-list", "Files"].includes(type))) {
            event.preventDefault();
            setDropActive(true);
          }
        }}
        onDragOver={(event) => {
          if (!dropActive) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDropActive(false);
          setDropPreview(captureDropPreview(event.dataTransfer));
        }}
      >
        <div className="quick-input-row drag-region">
          <span className="brand-mark">
            <Command size={18} />
          </span>
          <input
            ref={inputRef}
            className="no-drag"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setCaptureError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape")
                void window.desktopApi?.shell.hideCurrentWindow();
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void save(fields.source, event.metaKey || event.ctrlKey);
              }
            }}
            placeholder="用自然语言新增任务…"
            aria-label="快速录入"
          />
          <div className="quick-context-actions no-drag">
            <button
              type="button"
              className="quick-context-button"
              onClick={() => void readClipboardContext()}
              disabled={clipboardLoading}
              title="只预览剪贴板文字，不会自动创建任务"
            >
              <Clipboard size={15} />
              {clipboardLoading ? "读取中" : "剪贴板"}
            </button>
            <button
              type="button"
              className="quick-context-button"
              onClick={() => void readActiveWindowContext()}
              disabled={windowContextLoading}
              title="只读取当前窗口的应用名和标题，不会后台持续监控"
            >
              <PanelTop size={15} />
              {windowContextLoading ? "读取中" : "当前窗口"}
            </button>
            <button
              type="button"
              className="quick-context-button"
              onClick={() => void readSelectedTextContext()}
              disabled={selectedTextLoading}
              title="全局快捷键打开快速录入时会尝试带入外部选中文本；这里只预览，不会自动创建任务"
            >
              <ClipboardCheck size={15} />
              {selectedTextLoading ? "读取中" : "选中文本"}
            </button>
            <button
              type="button"
              className={`quick-context-button ${voice.listening ? "is-listening" : ""}`}
              onClick={voice.toggle}
              disabled={!voice.supported || saving}
              title={
                voice.supported
                  ? "按住或点击开始语音输入；识别结果仍需你检查后保存"
                  : "当前环境不支持语音输入"
              }
              aria-label={
                voice.listening ? "停止语音输入" : "开始语音输入"
              }
            >
              <Mic size={15} />
              {voice.listening ? "停止录音" : "语音"}
            </button>
          </div>
          <kbd>↵ 保存 · ⌘/Ctrl ↵ 打开</kbd>
        </div>
        <div className="quick-body">
          <p className="nav-section-label">
            {text
              ? fields.needsReview
                ? "有一处需要你确认"
                : "已理解为一个新任务"
              : "输入自然语言即可开始"}
          </p>
          {(voice.interimTranscript || voice.error) && (
            <div
              className={`voice-capture-status ${voice.error ? "has-error" : ""}`}
              aria-live="polite"
            >
              <Mic size={14} />
              <span>
                {voice.error ?? `正在听：${voice.interimTranscript}`}
              </span>
            </div>
          )}
          <div className="chip-row">
            {fields.chips.length ? (
              fields.chips.map((chip) => (
                <span
                  className={`chip ${chip.id === "source" && chip.value === "feishu" ? "feishu" : ""}`}
                  key={`${chip.id}-${chip.value}`}
                >
                  {chip.id === "date" ? (
                    <CalendarDays size={14} />
                  ) : chip.id === "reminder" ? (
                    <Bell size={14} />
                  ) : chip.id === "source" && chip.value === "feishu" ? (
                    <Cloud size={14} />
                  ) : chip.id === "source" ? (
                    <Laptop size={14} />
                  ) : chip.id === "duration" ? (
                    <Clock3 size={14} />
                  ) : chip.id === "recurrence" ? (
                    <RotateCcw size={14} />
                  ) : (
                    <Tag size={14} />
                  )}
                  {chip.label}
                </span>
              ))
            ) : (
              <>
                <span
                  className={`chip ${fields.source === "feishu" ? "feishu" : ""}`}
                >
                  {fields.source === "feishu" ? (
                    <Cloud size={14} />
                  ) : (
                    <Laptop size={14} />
                  )}
                  {fields.source === "feishu" ? "飞书" : "本地"}
                </span>
              </>
            )}
          </div>
          <div className="quick-template-bar">
            <label>
              <WandSparkles size={14} />
              <span>工作流模板</span>
              <select
                aria-label="工作流模板选择"
                value={selectedTemplateId}
                disabled={captureDestination === "diary"}
                onChange={(event) => setSelectedTemplateId(event.target.value)}
              >
                <option value="">不使用模板</option>
                {taskTemplates.templates.map((template) => (
                  <option value={template.id} key={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
            {selectedTemplate && (
              <small>{selectedTemplate.description} · 保存后创建 {selectedTemplate.steps.length} 项</small>
            )}
          </div>
          {templatePreview && (
            <section className="quick-template-preview" aria-label="工作流模板预览">
              <div className="context-capture-heading">
                <div>
                  <strong><WandSparkles size={14} /> {templatePreview.templateName}</strong>
                  <small>确认后会创建 {templatePreview.steps.length} 项任务；飞书模板也会逐项显示同步状态</small>
                </div>
                <button type="button" className="icon-button" aria-label="关闭模板预览" onClick={() => setSelectedTemplateId("")}><X size={14} /></button>
              </div>
              <ol>
                {templatePreview.steps.map((step) => (
                  <li key={step.id}>
                    <span>{step.title}</span>
                    <small>{step.plannedDate ?? "未安排日期"}{step.estimatedMinutes ? ` · ${step.estimatedMinutes} 分钟` : ""}</small>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {text && (
            <div className="capture-preview">
              <span className="brand-mark">
                <Check size={17} />
              </span>
              <div>
                <strong>{fields.title}</strong>
                <small>
                  {fields.date ?? "未安排日期"} ·{" "}
                  {fields.reminderAt ? "包含提醒" : "无提醒"}
                  {fields.estimatedMinutes ? ` · 预计 ${fields.estimatedMinutes} 分钟` : ""}
                  {fields.recurrence ? (fields.source === "feishu" ? " · 循环仅本地" : " · 循环") : ""}
                </small>
              </div>
              <SourcePill
                source={captureDestination === "task" ? fields.source : "local"}
              />
            </div>
          )}
          {text && (
            <section className="quick-destination" aria-label="快速捕获保存去向">
              <div className="quick-destination-heading">
                <strong>保存到哪里？</strong>
                <small>
                  {captureDestination === "task"
                    ? "按上面的解析创建任务"
                    : captureDestination === "inbox"
                      ? "暂存为本地任务，不安排日期"
                      : "写入 Todo Pet 日记，不创建任务"}
                </small>
              </div>
              <div className="quick-destination-options" role="group" aria-label="保存去向">
                <button
                  type="button"
                  className={captureDestination === "task" ? "is-selected" : ""}
                  aria-pressed={captureDestination === "task"}
                  onClick={() => setCaptureDestination("task")}
                >
                  <Check size={14} /> 任务
                </button>
                <button
                  type="button"
                  className={captureDestination === "inbox" ? "is-selected" : ""}
                  aria-pressed={captureDestination === "inbox"}
                  onClick={() => setCaptureDestination("inbox")}
                >
                  <Inbox size={14} /> 暂存
                </button>
                <button
                  type="button"
                  className={captureDestination === "diary" ? "is-selected" : ""}
                  aria-pressed={captureDestination === "diary"}
                  onClick={() => {
                    setCaptureDestination("diary");
                    setSelectedTemplateId("");
                  }}
                >
                  <FileText size={14} /> 日记
                </button>
              </div>
            </section>
          )}
          {clipboardContext && (
            <section className="context-capture-card" aria-label="剪贴板上下文预览">
              <div className="context-capture-heading">
                <div>
                  <strong><Clipboard size={14} /> 剪贴板上下文</strong>
                  <small>{clipboardContext.characters.toLocaleString()} 个字符 · 仅预览，尚未写入任务</small>
                </div>
                <button type="button" className="icon-button" aria-label="关闭剪贴板预览" onClick={() => setClipboardContext(undefined)}><X size={14} /></button>
              </div>
              <pre>{clipboardContext.text}</pre>
              {clipboardContext.truncated && <small className="context-capture-truncated">内容较长，预览已截取前 {clipboardContext.text.length.toLocaleString()} 个字符。</small>}
              <button type="button" className="soft-button" onClick={() => setText((current) => current.trim() ? `${current}\n${clipboardContext.text}` : clipboardContext.text)}>
                带入输入框
              </button>
            </section>
          )}
          {windowContext && (
            <section className="context-capture-card window-context-card" aria-label="当前窗口上下文预览">
              <div className="context-capture-heading">
                <div>
                  <strong><PanelTop size={14} /> 当前窗口上下文</strong>
                  <small>仅在你点击时读取，不会持续监控</small>
                </div>
                <button type="button" className="icon-button" aria-label="关闭当前窗口预览" onClick={() => setWindowContext(undefined)}><X size={14} /></button>
              </div>
              {windowContext.status === "captured" ? (
                <div className="window-context-values">
                  <span><b>应用</b>{windowContext.appName ?? "未知应用"}</span>
                  <span><b>标题</b>{windowContext.title ?? "无窗口标题"}</span>
                </div>
              ) : (
                <p className="context-capture-truncated">暂时无法读取（{windowContext.reason === "permission-denied" ? "需要系统辅助功能权限" : "平台不支持或窗口没有标题"}）。</p>
              )}
              {windowContext.status === "captured" && (windowContext.appName || windowContext.title) && (
                <button type="button" className="soft-button" onClick={() => setText((current) => {
                  const contextLine = `处理${windowContext.appName ? `「${windowContext.appName}」` : "当前窗口"}${windowContext.title ? `中的「${windowContext.title}」` : ""}`;
                  return current.trim() ? `${current}\n${contextLine}` : contextLine;
                })}>
                  带入输入框
                </button>
              )}
            </section>
          )}
          {selectedTextContext && (
            <section className="context-capture-card selected-text-context-card" aria-label="选中文本上下文预览">
              <div className="context-capture-heading">
                <div>
                  <strong><ClipboardCheck size={14} /> 选中文本上下文</strong>
                  <small>只在你触发时读取；不会自动创建、发送或上传</small>
                </div>
                <button type="button" className="icon-button" aria-label="关闭选中文本预览" onClick={() => setSelectedTextContext(undefined)}><X size={14} /></button>
              </div>
              {selectedTextContext.status === "captured" && selectedTextContext.text ? (
                <>
                  <pre>{selectedTextContext.text}</pre>
                  <small>{selectedTextContext.characters?.toLocaleString() ?? selectedTextContext.text.length.toLocaleString()} 个字符{selectedTextContext.truncated ? " · 预览已截取" : ""}</small>
                  <button type="button" className="soft-button" onClick={() => setText((current) => current.trim() ? `${current}\n${selectedTextContext.text}` : selectedTextContext.text ?? "")}>带入输入框</button>
                </>
              ) : (
                <p className="context-capture-truncated">
                  暂时没有读到选中文本（{selectedTextContext.reason === "permission-denied" ? "需要系统辅助功能权限" : selectedTextContext.reason === "unsupported" ? "当前平台不支持" : "没有选中内容"}）。建议在其他应用选中文本后使用全局快捷键打开快速录入。
                </p>
              )}
            </section>
          )}
          {dropPreview && (
            <section className="context-capture-card drop-context-card" aria-label="拖入内容预览">
              <div className="context-capture-heading">
                <div>
                  <strong><GripVertical size={14} /> 拖入内容预览 · {dropPreview.label}</strong>
                  <small>只展示来源，不会自动读取文件、上传或执行操作</small>
                </div>
                <button type="button" className="icon-button" aria-label="关闭拖入内容预览" onClick={() => setDropPreview(undefined)}><X size={14} /></button>
              </div>
              {dropPreview.kind === "file" || dropPreview.kind === "image" ? (
                <ul className="drop-context-files">
                  {dropPreview.files?.map((file, index) => <li key={`${file.name}-${index}`}><FileText size={14} /> <span>{file.name}</span></li>)}
                </ul>
              ) : (
                <pre>{dropPreview.kind === "url" ? dropPreview.url : dropPreview.text}</pre>
              )}
              {dropPreview.truncated && <small className="context-capture-truncated">文本较长，预览已截取。</small>}
              {(dropPreview.kind === "text" || dropPreview.kind === "url") && (
                <button type="button" className="soft-button" onClick={applyDropToText}>带入输入框</button>
              )}
            </section>
          )}
          {captureError && (
            <div className="warning-note">
              <AlertTriangle size={15} />
              {captureError}
            </div>
          )}
        </div>
        <div className="quick-footer">
          <span>
            {captureDestination === "diary"
              ? "只保存在当前设备，不会创建任务或同步飞书"
              : captureDestination === "inbox"
                ? "只保存在当前设备，稍后再安排日期"
                : fields.source === "feishu"
                  ? "将创建到飞书；私人计划仍只保存在本地"
                  : "只保存在当前设备"}
          </span>
          <span className="footer-spacer" />
          {captureDestination === "diary" ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => void save("local")}
              disabled={!text || saving}
            >
              <FileText size={15} /> 写入日记
            </button>
          ) : captureDestination === "inbox" ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => void save("local")}
              disabled={!text || saving}
            >
              <Inbox size={15} /> 保存到暂存
            </button>
          ) : (
            <>
              <button
                type="button"
                className="soft-button"
                onClick={() => void save("local")}
                disabled={!text || saving}
              >
                保存到本地
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void save("feishu")}
                disabled={!text || saving}
              >
                创建到飞书
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FloatingPetCoopGame({
  game,
  petName,
  palette,
  outfit,
  season,
  positionLocked,
  onDragStart,
  onDragMove,
  onDragEnd,
  onAction,
  onComplete,
  onClose,
}: {
  game: FloatingPetGame;
  petName: string;
  palette: PetPalette;
  outfit: PetOutfit;
  season?: PetSeason;
  positionLocked: boolean;
  onDragStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onDragMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onDragEnd: (event?: ReactPointerEvent<HTMLButtonElement>) => void;
  onAction: (action: PetAction, message?: string, durationMs?: number) => void;
  onComplete: (
    game: FloatingPetGame,
    score: number,
    durationSeconds: number,
  ) => void;
  onClose: () => void;
}) {
  const startedAtRef = useRef(Date.now());
  const elapsedBeforePauseRef = useRef(0);
  const completedRef = useRef(false);
  const jumpScoreRef = useRef<JumpRopeScore>(emptyJumpRopeScore());
  const motionTimerRef = useRef<number | undefined>(undefined);
  const onCompleteRef = useRef(onComplete);
  const onActionRef = useRef(onAction);
  const [remaining, setRemaining] = useState(20);
  const [ropeWindowOpen, setRopeWindowOpen] = useState(false);
  const [jumpStats, setJumpStats] = useState<JumpRopeScore>(() =>
    emptyJumpRopeScore(),
  );
  const [isJumpPaused, setIsJumpPaused] = useState(false);
  const [jumpFinished, setJumpFinished] = useState(false);
  const [stretchStep, setStretchStep] = useState(0);
  const [stageAction, setStageAction] = useState<PetAction>(
    game === "jump-rope" ? "jump-rope-ready" : "stretch",
  );
  const [motionBeat, setMotionBeat] = useState(0);
  const [stageFeedback, setStageFeedback] = useState("看准绳子");
  onCompleteRef.current = onComplete;
  onActionRef.current = onAction;

  const stretchSteps: Array<{
    title: string;
    hint: string;
    action: PetAction;
  }> = [
    { title: "抬起肩膀", hint: "吸气，和我一起把肩膀抬高", action: "stretch" },
    { title: "向左舒展", hint: "慢慢拉长身体左侧", action: "look-left" },
    { title: "向右舒展", hint: "换边，动作不用追求标准", action: "look-right" },
    { title: "喝口水", hint: "放松肩膀，喝一口水就完成", action: "drink" },
  ];
  useEffect(() => {
    if (game !== "jump-rope" || isJumpPaused || jumpFinished) return undefined;
    const updateFrame = () => {
      const frame = jumpRopeFrame(
        elapsedBeforePauseRef.current + Date.now() - startedAtRef.current,
      );
      setRemaining((current) =>
        current === frame.remainingSeconds ? current : frame.remainingSeconds,
      );
      setRopeWindowOpen((current) =>
        current === frame.windowOpen ? current : frame.windowOpen,
      );
      if (!frame.finished) return;
      elapsedBeforePauseRef.current = frame.elapsedMs;
      setRopeWindowOpen(false);
      setJumpFinished(true);
      setStageAction("celebrate");
      setStageFeedback("配合完成！");
    };
    updateFrame();
    const timer = window.setInterval(() => {
      updateFrame();
    }, 60);
    return () => window.clearInterval(timer);
  }, [game, isJumpPaused, jumpFinished]);

  useEffect(
    () => () => {
      if (motionTimerRef.current !== undefined) {
        window.clearTimeout(motionTimerRef.current);
      }
    },
    [],
  );

  const playStageAction = (action: PetAction, durationMs: number, feedback: string) => {
    if (motionTimerRef.current !== undefined) {
      window.clearTimeout(motionTimerRef.current);
    }
    setStageAction(action);
    setStageFeedback(feedback);
    setMotionBeat((value) => value + 1);
    motionTimerRef.current = window.setTimeout(() => {
      setStageAction(game === "jump-rope" ? "jump-rope-ready" : "stretch");
      setStageFeedback(game === "jump-rope" ? "看准绳子" : "慢慢跟上就好");
      motionTimerRef.current = undefined;
    }, durationMs);
  };
  const readJumpElapsed = () =>
    elapsedBeforePauseRef.current +
    (isJumpPaused || jumpFinished ? 0 : Date.now() - startedAtRef.current);
  const jump = () => {
    if (isJumpPaused || jumpFinished) return;
    const liveFrame = jumpRopeFrame(readJumpElapsed());
    // The visible green window is the source of truth. Recalculating the
    // phase here can turn a click that landed on a green button into a miss
    // during the few milliseconds between paint and the event handler.
    const result = scoreJumpRopeAttempt(jumpScoreRef.current, {
      ...liveFrame,
      windowOpen: ropeWindowOpen && !liveFrame.finished,
    });
    jumpScoreRef.current = result.score;
    setJumpStats(result.score);
    if (result.outcome === "success") {
      playStageAction("jump-rope", 820, "跳得漂亮！");
      return;
    }
    if (result.outcome === "miss") {
      playStageAction("head-tilt", 800, "差一点，再看准脚边");
    }
  };
  const toggleJumpPause = () => {
    if (jumpFinished) return;
    if (motionTimerRef.current !== undefined) {
      window.clearTimeout(motionTimerRef.current);
      motionTimerRef.current = undefined;
    }
    if (isJumpPaused) {
      startedAtRef.current = Date.now();
      setStageAction("jump-rope-ready");
      setStageFeedback("看准绳子");
      setIsJumpPaused(false);
      return;
    }
    elapsedBeforePauseRef.current += Date.now() - startedAtRef.current;
    setRopeWindowOpen(false);
    setStageAction("sit");
    setStageFeedback("暂停中，准备好再继续");
    setIsJumpPaused(true);
  };
  const resetJumpRope = () => {
    if (motionTimerRef.current !== undefined) {
      window.clearTimeout(motionTimerRef.current);
      motionTimerRef.current = undefined;
    }
    completedRef.current = false;
    startedAtRef.current = Date.now();
    elapsedBeforePauseRef.current = 0;
    jumpScoreRef.current = emptyJumpRopeScore();
    setJumpStats(jumpScoreRef.current);
    setRemaining(20);
    setRopeWindowOpen(false);
    setJumpFinished(false);
    setIsJumpPaused(false);
    setStageAction("jump-rope-ready");
    setStageFeedback("看准绳子");
    setMotionBeat((value) => value + 1);
  };
  const gameControls = (
    <div className="pet-game-header-actions">
      {game === "jump-rope" && !jumpFinished && (
        <button
          type="button"
          className="icon-button"
          aria-label={isJumpPaused ? "继续跳绳" : "暂停跳绳"}
          onClick={toggleJumpPause}
        >
          {isJumpPaused ? <Play size={16} /> : <Pause size={16} />}
        </button>
      )}
      <button
        type="button"
        className="floating-drag-handle pet-game-drag-handle no-drag"
        title={positionLocked ? "位置已锁定" : "拖动移动"}
        aria-label={positionLocked ? "宠物位置已锁定" : "拖动 Todo Pet"}
        disabled={positionLocked}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <GripVertical size={16} />
      </button>
      <button type="button" className="icon-button" aria-label="退出小游戏" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );

  if (game === "stretch-mirror") {
    const step = stretchSteps[stretchStep];
    return (
      <section className="pet-coop-game no-drag" aria-label="镜像伸展小游戏">
        <header>
          <div>
            <span className="pet-game-kicker">和 {petName} 一起动一动</span>
            <h2>镜像伸展</h2>
          </div>
          {gameControls}
        </header>
        <div className="pet-stretch-progress" aria-label={`第 ${stretchStep + 1} 步，共 ${stretchSteps.length} 步`}>
          {stretchSteps.map((item, index) => (
            <span key={item.title} className={index <= stretchStep ? "active" : ""} />
          ))}
        </div>
        <div className="pet-stretch-mirror">
          <div className="pet-game-character" key={`${motionBeat}-${stageAction}`}>
            <PetCharacter
              mood="idle"
              action={stageAction}
              name={petName}
              palette={palette}
              outfit={outfit}
              season={season}
            />
          </div>
          <div className="pet-stretch-instruction">
            <Activity size={24} />
            <strong>{step.title}</strong>
            <p>{step.hint}</p>
          </div>
        </div>
        <button
          type="button"
          className="primary-button pet-coop-primary"
          onClick={() => {
            playStageAction(step.action, 1_400, step.hint);
            onActionRef.current(step.action, step.hint, 1_500);
            if (stretchStep < stretchSteps.length - 1) {
              setStretchStep((value) => value + 1);
              return;
            }
            if (completedRef.current) return;
            completedRef.current = true;
            onCompleteRef.current("stretch-mirror", stretchSteps.length, 24);
          }}
        >
          <Check size={16} />
          {stretchStep === stretchSteps.length - 1 ? "一起完成" : "我跟上了"}
        </button>
        <small>没有摄像头和动作评分，只需要舒服地跟着做。</small>
      </section>
    );
  }

  if (jumpFinished) {
    const summary =
      jumpStats.score >= 14
        ? "节奏特别合拍"
        : jumpStats.score >= 8
          ? "已经找到共同节奏"
          : "第一次配合也很棒";
    return (
      <section
        className="pet-coop-game pet-jump-rope-game no-drag"
        aria-label="协作跳绳完成总结"
      >
        <header>
          <div>
            <span className="pet-game-kicker">20 秒协作完成</span>
            <h2>{summary}</h2>
          </div>
          {gameControls}
        </header>
        <div className="pet-game-summary" role="status" aria-live="polite">
          <PetCharacter
            mood="happy"
            action="celebrate"
            name={petName}
            palette={palette}
            outfit={outfit}
            season={season}
          />
          <strong>我们一起跳过了 {jumpStats.score} 下</strong>
          <p>
            最长连续 {jumpStats.bestCombo} 下，差一点 {jumpStats.misses} 次。
            这里不追求满分，只记录我们越来越默契。
          </p>
        </div>
        <div className="pet-game-summary-actions">
          <button type="button" className="soft-button" onClick={resetJumpRope}>
            <RotateCcw size={15} /> 再来一次
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              if (completedRef.current) return;
              completedRef.current = true;
              onCompleteRef.current("jump-rope", jumpStats.score, 20);
            }}
          >
            <Check size={15} /> 收下默契奖励
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="pet-coop-game pet-jump-rope-game no-drag" aria-label="协作跳绳小游戏">
      <header>
        <div>
          <span className="pet-game-kicker">20 秒协作挑战</span>
          <h2>和 {petName} 一起跳绳</h2>
        </div>
        {gameControls}
      </header>
      <div className={`pet-rope-stage ${ropeWindowOpen ? "is-jump-window" : ""}`}>
        <div className="pet-game-character" key={`${motionBeat}-${stageAction}`}>
          <PetCharacter
            mood="idle"
            action={stageAction}
            name={petName}
            palette={palette}
            outfit={outfit}
            season={season}
          />
        </div>
        <div className="pet-rope-cue">
          <strong>{stageAction === "jump-rope" ? stageFeedback : ropeWindowOpen ? "现在跳！" : stageFeedback}</strong>
          <small>绳子到脚边时点击，宠物才会越过绳子</small>
        </div>
      </div>
      <button
        type="button"
        className={`pet-jump-button ${ropeWindowOpen ? "is-ready" : ""}`}
        aria-label="让宠物跳起来"
        aria-keyshortcuts="Space Enter"
        disabled={isJumpPaused}
        autoFocus
        onClick={jump}
      >
        <Sparkles size={18} /> {isJumpPaused ? "暂停中" : "点击或按空格起跳"}
      </button>
      <div className="pet-game-score" aria-live="polite">
        <span><strong>{remaining}</strong> 秒</span>
        <span><strong>{jumpStats.score}</strong> 次成功</span>
        <span><strong>{jumpStats.combo}</strong> 连跳</span>
        <span><strong>{jumpStats.misses}</strong> 次差一点</span>
      </div>
    </section>
  );
}

function FloatingWindow() {
  // Keep both task collections live. The floating panel can switch between
  // the open all-task overview and the complete Today list without waiting
  // for a fresh renderer load, and each controller refreshes on task changes.
  const todayController = useTaskController("today", "");
  const allController = useTaskController("all", "");
  const [expanded, setExpanded] = useState(false);
  const hoverExpandTimerRef = useRef<number | undefined>(undefined);
  const hoverLeaveTimerRef = useRef<number | undefined>(undefined);
  const compactActivateTimerRef = useRef<number | undefined>(undefined);
  const contextMenuReturnExpandedRef = useRef(false);
  const contextMenuReturnPetOnlyRef = useRef(false);
  const interactionReturnExpandedRef = useRef(false);
  const interactionReturnPetOnlyRef = useRef(false);
  const hoverExpandDelayMsRef = useRef(
    defaultSettings.floating.hoverExpandDelayMs,
  );
  const floatingSettingsLoadedRef = useRef(false);
  const hoveringFloatingRef = useRef(false);
  const lastFloatingPointerRef = useRef({ x: -1, y: -1 });
  const expandTriggerRef = useRef<"hover" | "click" | undefined>(undefined);
  const [hoverExpandDelayMs, setHoverExpandDelayMs] = useState(
    defaultSettings.floating.hoverExpandDelayMs,
  );
  const [scalePercent, setScalePercent] = useState(
    defaultSettings.floating.scalePercent,
  );
  const [petName, setPetName] = useState(defaultSettings.persona.name);
  const [privacyMode, setPrivacyMode] = useState(false);
  const [floatingLocked, setFloatingLocked] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [interactionWheelOpen, setInteractionWheelOpen] = useState(false);
  const petInteractionTriggerRef = useRef<HTMLButtonElement>(null);
  const [floatingGame, setFloatingGame] = useState<FloatingPetGame>();
  const [isFloatingHovered, setIsFloatingHovered] = useState(false);
  const [petOnly, setPetOnly] = useState(readFloatingPetOnly);
  const [reactionBubbleCollapsed, setReactionBubbleCollapsed] = useState(false);
  const [taskBubbleCollapsed, setTaskBubbleCollapsed] = useState(false);
  const [focusBubbleCollapsed, setFocusBubbleCollapsed] = useState(false);
  const [heldTaskBubbleCollapsed, setHeldTaskBubbleCollapsed] = useState(false);
  const [heldTaskId, setHeldTaskId] = useState<string>();
  const [taskDropActive, setTaskDropActive] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string>();
  const [activeTaskDropTarget, setActiveTaskDropTarget] =
    useState<PetTaskDropTargetId>();
  const [petDropActive, setPetDropActive] = useState(false);
  const [petDropPreview, setPetDropPreview] = useState<DropContextPreview>();
  const [selectedTextPreview, setSelectedTextPreview] = useState<{
    status: "captured" | "unavailable";
    text?: string;
    characters?: number;
    truncated?: boolean;
    capturedAt: string;
    reason?: "unsupported" | "permission-denied" | "empty" | "error";
  }>();
  const [selectedTextLoading, setSelectedTextLoading] = useState(false);
  const [petWindowDragging, setPetWindowDragging] = useState(false);
  const floatingDragPointerRef = useRef<number | undefined>(undefined);
  const petAvatarPointerRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startScreenX: number;
    startScreenY: number;
    lastScreenX: number;
    lastScreenY: number;
    dragging: boolean;
  } | undefined>(undefined);
  const suppressPetAvatarClickRef = useRef(false);
  const suppressPetAvatarClickTimerRef = useRef<number | undefined>(undefined);
  const [tab, setTab] = useState<PetTab>(readFloatingTab);
  const [input, setInput] = useState("");
  const [creatingFloatingTask, setCreatingFloatingTask] = useState(false);
  const floatingCreateRef = useRef(false);
  const [activity, setActivity] = useState<AuditRecord[]>([]);
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatusView>();
  const [now, setNow] = useState(Date.now());
  const [petSettings, setPetSettings] = useState(defaultSettings);
  const [proactiveTask, setProactiveTask] = useState<PetNextTask>();
  const proactiveMessageRef = useRef<string | undefined>(undefined);
  const installedActionPacks = useInstalledPetActionPacks();
  const [focusBusy, setFocusBusy] = useState(false);
  const [focusError, setFocusError] = useState("");
  const focusEnvironmentSoundRef = useRef<FocusEnvironmentSound | undefined>(
    undefined,
  );
  const prefersReducedMotion = usePrefersReducedMotion();
  const petData = usePetData();
  const miniContentRef = useRef<HTMLDivElement>(null);
  const chatFollowsOutputRef = useRef(true);
  const petFocus = petData.snapshot?.focus;
  const focusEnvironmentSound =
    petFocus?.status === "running" && petFocus.phase === "focus"
      ? petSettings.focus.environmentSound
      : "off";
  const focusedTask = todayController.tasks.find(
    (task) => task.id === petFocus?.taskId || task.focusStartedAt,
  );
  const carousel = useFloatingTodayCarousel(
    todayController.tasks,
    focusedTask,
    isFloatingHovered || expanded || contextMenuOpen || interactionWheelOpen || Boolean(floatingGame) || privacyMode,
  );
  // The compact completion action follows the visible title. A rotating task
  // bubble must never complete a different, hidden task.
  const current = carousel.task;
  const currentTaskTheme: TaskThemeActionPack | undefined = current
    ? inferTaskTheme(current)
    : undefined;
  const heldTask = heldTaskId
    ? [...allController.tasks, ...todayController.tasks].find(
        (task) => task.id === heldTaskId,
      )
    : undefined;
  const petAppearance = petData.snapshot?.appearance ?? {
    palette: "lavender" as const,
    outfit: "none" as const,
    roomTheme: "cloud-room" as const,
    decorations: ["cloud-lamp"],
  };
  const petSeasonEvent = petSettings.pet.seasonalEvents
    ? petSeasonalEventForDate()
    : undefined;
  const petSeason = petSeasonEvent?.season;
  const floatingChat = useAgentChat({
    initialMessage:
      "我可以直接在这里查询、创建和整理任务；需要确认的操作也会留在这个小窗口里。",
    onFallback: async (text) => {
      if (/新增|创建|记下|完成|修改|删除/u.test(text))
        return /飞书/u.test(text)
          ? "飞书任务不会在模型未启用时静默改成本地任务。请先连接飞书并启用模型。"
          : "模型未启用，我不会依据模糊自然语言直接创建、修改或完成任务。可以切到 Today 用下方输入框明确新增本地任务，或在设置中启用模型。";
      const openTasks = todayController.tasks.filter(
        (task) => task.status === "open",
      );
      return openTasks.length
        ? `模型未启用。今天有 ${openTasks.length} 项未完成任务；启用模型后可在此对话查询和整理。`
        : "模型未启用，今天没有未完成任务。启用模型后可在这里进行自然语言对话和任务管理。";
    },
    onApproval: () => {
      setTab("chat");
      setPanelExpanded(true, "click");
    },
  });
  const voice = useVoiceCapture({
    onFinal: (spoken) => {
      if (tab === "chat") {
        floatingChat.setInput((current) =>
          current.trim() ? `${current.trim()} ${spoken}` : spoken,
        );
      } else {
        setInput((current) =>
          current.trim() ? `${current.trim()} ${spoken}` : spoken,
        );
      }
    },
  });
  const readSelectedTextPreview = async () => {
    if (!window.desktopApi?.shell.readSelectedText || selectedTextLoading) return;
    setSelectedTextLoading(true);
    try {
      setSelectedTextPreview(await window.desktopApi.shell.readSelectedText());
    } finally {
      setSelectedTextLoading(false);
    }
  };
  const openTodayTaskCount = todayController.tasks.filter(
    (task) => task.status === "open" && !task.deletedAt,
  ).length;
  const overdueCount = todayController.tasks.filter(
    (task) => isOpenTaskOverdue(task),
  ).length;
  const petBehavior = usePetBehavior(
    {
      reducedMotion: prefersReducedMotion,
      focus: petFocus
        ? { phase: petFocus.phase, status: petFocus.status }
        : undefined,
      syncing: feishuStatus?.state === "syncing",
      syncError: feishuStatus?.state === "error",
      agentSending: floatingChat.isSending,
      agentRunState: floatingChat.runState,
      approvalPending: Boolean(floatingChat.approval),
      overdueCount,
      openTaskCount: openTodayTaskCount,
      taskDropActive,
      taskTheme: currentTaskTheme?.id,
    },
    petName,
    petSettings.pet.interactionsEnabled,
    petSettings.pet.actionPack,
    installedActionPacks.activePack?.idleActions,
  );
  useEffect(() => {
    if (petBehavior.message) setReactionBubbleCollapsed(false);
    if (
      proactiveTask &&
      proactiveMessageRef.current !== petBehavior.message
    ) {
      proactiveMessageRef.current = undefined;
      setProactiveTask(undefined);
    }
  }, [petBehavior.message, proactiveTask]);
  useEffect(() => {
    if (!privacyMode) return;
    proactiveMessageRef.current = undefined;
    setProactiveTask(undefined);
    petBehavior.dismiss();
  }, [privacyMode]);
  useEffect(() => {
    const engine = new FocusEnvironmentSound();
    focusEnvironmentSoundRef.current = engine;
    return () => {
      engine.dispose();
      if (focusEnvironmentSoundRef.current === engine) {
        focusEnvironmentSoundRef.current = undefined;
      }
    };
  }, []);
  useEffect(() => {
    focusEnvironmentSoundRef.current?.setKind(focusEnvironmentSound);
  }, [focusEnvironmentSound]);
  useEffect(() => {
    if (heldTaskId) setHeldTaskBubbleCollapsed(false);
  }, [heldTaskId]);
  useEffect(() => {
    void window.desktopApi?.shell.setFloatingPetOnly(petOnly);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const previousSyncStateRef = useRef<FeishuStatusView["state"] | undefined>(
    undefined,
  );
  useEffect(() => {
    const previous = previousSyncStateRef.current;
    previousSyncStateRef.current = feishuStatus?.state;
    if (previous === "syncing" && feishuStatus?.state === "connected") {
      petBehavior.act("sync-success", "同步完成，任务已经搬好啦。", 3_000);
    }
  }, [feishuStatus?.state]);
  const lastProactiveAtRef = useRef(0);
  useEffect(() => {
    if (!floatingSettingsLoadedRef.current) return undefined;
    if (
      shouldSuppressPetProactive({
        settings: petSettings,
        now: new Date(),
        focusActive: Boolean(petFocus),
        fullscreen: Boolean(document.fullscreenElement),
      })
    ) {
      return undefined;
    }
    const hour = new Date().getHours();
    const delay = hour >= 6 && hour < 11 ? 8_000 : 45_000;
    const showSuggestion = () => {
      if (
        shouldSuppressPetProactive({
          settings: petSettings,
          now: new Date(),
          focusActive: Boolean(petFocus),
          fullscreen: Boolean(document.fullscreenElement),
        })
      ) return;
      if (!proactiveBudgetAvailable(
        petData.snapshot?.proactiveMessages ?? [],
        petSettings.pet.proactiveDailyLimit,
        new Date(),
      )) return;
      const intervalMs = petSettings.pet.proactiveIntervalMinutes * 60_000;
      if (
        lastProactiveAtRef.current > 0 &&
        Date.now() - lastProactiveAtRef.current < intervalMs - 1_000
      ) return;
      const suggestion = buildPetProactiveSuggestion({
        now: new Date(),
        tasks: allController.tasks,
        weather: petData.weather,
        petName,
        syncProblem: feishuStatus?.state === "error",
        privacyMode,
        urgencyWeights: petSettings.planning.urgencyWeights,
      });
      lastProactiveAtRef.current = Date.now();
      proactiveMessageRef.current = suggestion.message;
      setProactiveTask(suggestion.nextTask);
      petBehavior.act(suggestion.action, suggestion.message, 8_000);
      void window.desktopApi?.pet.recordProactiveMessage({
        kind: suggestion.kind,
        reason: suggestion.message,
      });
    };
    const timer = window.setTimeout(showSuggestion, delay);
    const interval = window.setInterval(
      showSuggestion,
      petSettings.pet.proactiveIntervalMinutes * 60_000,
    );
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [
    allController.tasks,
    feishuStatus?.state,
    petData.weather,
    petData.snapshot?.proactiveMessages,
    petFocus,
    petName,
    petSettings,
  ]);
  useEffect(() => {
    try {
      localStorage.setItem(floatingTabStorageKey, tab);
    } catch {
      // Persisting the focus is a convenience; the active in-memory tab still
      // works if a platform policy blocks local storage.
    }
    if (window.desktopApi && floatingSettingsLoadedRef.current) {
      void window.desktopApi.settings.get().then((settings) => {
        if (settings.floating.selectedTab === tab) return;
        return window.desktopApi?.settings.replace({
          ...settings,
          floating: { ...settings.floating, selectedTab: tab },
        });
      });
    }
  }, [tab]);
  useEffect(
    () => () => {
      hoveringFloatingRef.current = false;
      if (hoverExpandTimerRef.current !== undefined) {
        window.clearTimeout(hoverExpandTimerRef.current);
      }
      if (hoverLeaveTimerRef.current !== undefined) {
        window.clearTimeout(hoverLeaveTimerRef.current);
      }
      if (compactActivateTimerRef.current !== undefined) {
        window.clearTimeout(compactActivateTimerRef.current);
      }
      if (suppressPetAvatarClickTimerRef.current !== undefined) {
        window.clearTimeout(suppressPetAvatarClickTimerRef.current);
      }
      contextMenuReturnExpandedRef.current = false;
      contextMenuReturnPetOnlyRef.current = false;
      interactionReturnExpandedRef.current = false;
      interactionReturnPetOnlyRef.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!window.desktopApi) return undefined;
    const apply = (settings: AppSettings) => {
      const nextHoverExpandDelayMs = settings.floating.hoverExpandDelayMs;
      const delayChanged =
        hoverExpandDelayMsRef.current !== nextHoverExpandDelayMs;
      hoverExpandDelayMsRef.current = nextHoverExpandDelayMs;
      setHoverExpandDelayMs(nextHoverExpandDelayMs);
      setScalePercent(settings.floating.scalePercent);
      setPetName(settings.persona.name || defaultSettings.persona.name);
      setPetSettings(settings);
      floatingSettingsLoadedRef.current = true;
      setTab(settings.floating.selectedTab);
      setPrivacyMode(settings.floating.privacyMode);
      setFloatingLocked(settings.floating.locked);
      // Settings load asynchronously on every floating renderer. If the
      // pointer entered before that read completed (or the delay is edited
      // while the pointer is still there), the old timer must not win.
      if (delayChanged) {
        if (hoverExpandTimerRef.current !== undefined) {
          window.clearTimeout(hoverExpandTimerRef.current);
          hoverExpandTimerRef.current = undefined;
        }
        // A native transparent window can emit a transient mouseleave while
        // its settings are broadcast (the window manager reapplies bounds).
        // `:hover` is the authoritative DOM signal in that case, so re-arm
        // the new delay even when the React-side flag briefly went stale.
        const stackIsHovered = document
          .querySelector<HTMLElement>(".floating-stack")
          ?.matches(":hover");
        if (hoveringFloatingRef.current || stackIsHovered) scheduleHoverExpand();
      }
    };
    void window.desktopApi.settings.get().then(apply);
    return window.desktopApi.events.onSettingsChanged(apply);
  }, []);
  const refreshContext = useCallback(async () => {
    if (!window.desktopApi) return;
    const [records, status] = await Promise.all([
      window.desktopApi.agent.audit(8).catch(() => []),
      window.desktopApi.feishu.status().catch(() => undefined),
    ]);
    setActivity(records.slice(-2).toReversed());
    setFeishuStatus(status);
  }, []);
  useEffect(() => {
    void refreshContext();
    const offAgent = window.desktopApi?.events.onAgentEvent((event) => {
      if (event.type !== "model-delta") void refreshContext();
    });
    const offFeishu = window.desktopApi?.events.onFeishuStatus(setFeishuStatus);
    return () => {
      offAgent?.();
      offFeishu?.();
    };
  }, [refreshContext]);
  useEffect(() => {
    if (!expanded || tab !== "chat" || !chatFollowsOutputRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const content = miniContentRef.current;
      if (content) content.scrollTop = content.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, floatingChat.messages, tab]);
  const isTaskTab = tab === "all" || tab === "today";
  const displayedTaskController =
    tab === "all" ? allController : todayController;
  const elapsed = current
    ? current.focusElapsedSeconds +
      (current.focusStartedAt
        ? Math.max(
            0,
            Math.floor(
              (now - new Date(current.focusStartedAt).getTime()) / 1000,
            ),
          )
        : 0)
    : 0;
  const petFocusElapsed = focusElapsedNow(petFocus, now);
  const petFocusRemaining = focusRemainingNow(petFocus, now);
  const petFocusClock =
    petFocus?.mode === "pomodoro" && petFocusRemaining !== undefined
      ? petFocusRemaining
      : petFocusElapsed;
  const focusPhaseLabel =
    petFocus?.phase === "short-break"
      ? "短休息"
      : petFocus?.phase === "long-break"
        ? "长休息"
        : "专注";
  const focusEnvironmentSoundLabel =
    environmentSoundOptions.find(
      (option) => option.value === petSettings.focus.environmentSound,
    )?.label ?? "关闭";
  const titleFor = (task?: Task) =>
    task ? (privacyMode ? "私人任务" : task.title) : "今天已清空";
  const submit = async (suggestion?: string) => {
    if (privacyMode && tab === "chat") return;
    const text = (
      suggestion ?? (tab === "chat" ? floatingChat.input : input)
    ).trim();
    if (!text) return;
    if (isTaskTab) {
      if (floatingCreateRef.current) return;
      floatingCreateRef.current = true;
      setCreatingFloatingTask(true);
      try {
        let parsed: QuickCaptureResult | undefined;
        try {
          parsed = await window.desktopApi?.capture.parse(text);
        } catch {
          // A parser failure should never block a plain title capture.
        }
        const priorities: TaskPriority[] = [
          "low",
          "medium",
          "high",
          "urgent",
        ];
        const title = parsed?.title?.trim() || text;
        const plannedDate =
          temporalDateKey(parsed?.privatePlanAt) ?? dateKey();
        const createController = tab === "all" ? allController : todayController;
        await createController.create({
          title,
          plannedDate,
          dueAt: parsed?.dueAt,
          tags: parsed?.tags,
          contexts: parsed?.contexts,
          estimatedMinutes: parsed?.estimatedMinutes,
          recurrence: parsed?.recurrence,
          priority: priorities[parsed?.priority ?? 1] ?? "medium",
          reminders: parsed?.reminderAt
            ? [
                {
                  id: crypto.randomUUID(),
                  at: parsed.reminderAt,
                  enabled: true,
                  source: "local" as const,
                },
              ]
            : [],
          // The pet panel is deliberately local-only. A phrase such as
          // “存到飞书” can still be parsed for its title, but must not turn a
          // compact gesture into an implicit remote write.
          source: { type: "local" },
        });
        setInput("");
        petBehavior.act("celebrate", `记下啦：${title}`, 2_400);
      } catch (reason) {
        petBehavior.act(
          "sync-error",
          reason instanceof Error ? reason.message : "新增任务失败，请再试一次。",
          4_000,
        );
      } finally {
        floatingCreateRef.current = false;
        setCreatingFloatingTask(false);
      }
      return;
    }
    if (tab === "chat") {
      chatFollowsOutputRef.current = true;
      setPanelExpanded(true, "click");
      await floatingChat.send(text);
    }
  };
  function setPanelExpanded(
    value: boolean,
    trigger: "hover" | "click" = "click",
  ) {
    if (value && petOnly) {
      setPetOnly(false);
      try {
        localStorage.setItem(floatingPetOnlyStorageKey, "false");
      } catch {
        // The in-memory mode still works if persistence is unavailable.
      }
      void window.desktopApi?.shell.setFloatingPetOnly(false);
    }
    if (hoverExpandTimerRef.current !== undefined) {
      window.clearTimeout(hoverExpandTimerRef.current);
      hoverExpandTimerRef.current = undefined;
    }
    if (compactActivateTimerRef.current !== undefined) {
      window.clearTimeout(compactActivateTimerRef.current);
      compactActivateTimerRef.current = undefined;
    }
    if (hoverLeaveTimerRef.current !== undefined) {
      window.clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = undefined;
    }
    if (!value) {
      setContextMenuOpen(false);
      setInteractionWheelOpen(false);
      setFloatingGame(undefined);
      contextMenuReturnExpandedRef.current = false;
      interactionReturnExpandedRef.current = false;
    }
    expandTriggerRef.current = value ? trigger : undefined;
    setExpanded(value);
    void window.desktopApi?.shell.setFloatingExpanded(value);
  }
  function collapsePetTaskRail(): void {
    if (hoverExpandTimerRef.current !== undefined) {
      window.clearTimeout(hoverExpandTimerRef.current);
      hoverExpandTimerRef.current = undefined;
    }
    if (hoverLeaveTimerRef.current !== undefined) {
      window.clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = undefined;
    }
    if (compactActivateTimerRef.current !== undefined) {
      window.clearTimeout(compactActivateTimerRef.current);
      compactActivateTimerRef.current = undefined;
    }
    setContextMenuOpen(false);
    setInteractionWheelOpen(false);
    setFloatingGame(undefined);
    setExpanded(false);
    expandTriggerRef.current = undefined;
    setPetOnly(true);
    try {
      localStorage.setItem(floatingPetOnlyStorageKey, "true");
    } catch {
      // The in-memory mode still works if persistence is unavailable.
    }
    void window.desktopApi?.shell.setFloatingPetOnly(true);
  }
  function expandPetTaskRail(): void {
    setPetOnly(false);
    try {
      localStorage.setItem(floatingPetOnlyStorageKey, "false");
    } catch {
      // The in-memory mode still works if persistence is unavailable.
    }
    void window.desktopApi?.shell.setFloatingPetOnly(false);
  }
  function closeFloatingContextMenu(): void {
    const returnToExpandedPanel = contextMenuReturnExpandedRef.current;
    const returnToPetOnly = contextMenuReturnPetOnlyRef.current;
    contextMenuReturnExpandedRef.current = false;
    contextMenuReturnPetOnlyRef.current = false;
    setContextMenuOpen(false);
    if (returnToPetOnly) {
      collapsePetTaskRail();
      return;
    }
    if (!returnToExpandedPanel) setPanelExpanded(false);
  }
  function openPetInteractionWheel(): void {
    interactionReturnExpandedRef.current = expanded;
    interactionReturnPetOnlyRef.current = petOnly;
    setContextMenuOpen(false);
    setFloatingGame(undefined);
    setInteractionWheelOpen(true);
    if (!expanded) setPanelExpanded(true, "click");
  }
  function closePetInteractionSurface(): void {
    const returnToExpandedPanel = interactionReturnExpandedRef.current;
    const returnToPetOnly = interactionReturnPetOnlyRef.current;
    interactionReturnExpandedRef.current = false;
    interactionReturnPetOnlyRef.current = false;
    setInteractionWheelOpen(false);
    setFloatingGame(undefined);
    const restoreTriggerFocus = () => {
      window.requestAnimationFrame(() => petInteractionTriggerRef.current?.focus());
    };
    if (returnToPetOnly) {
      collapsePetTaskRail();
      restoreTriggerFocus();
      return;
    }
    if (!returnToExpandedPanel) setPanelExpanded(false);
    restoreTriggerFocus();
  }
  function performWheelInteraction(kind: PetInteractionKind): void {
    petBehavior.interact(kind);
    void window.desktopApi?.pet.interact(kind).then(() => petData.refresh());
    closePetInteractionSurface();
  }
  function startFloatingPetGame(game: FloatingPetGame): void {
    setInteractionWheelOpen(false);
    setFloatingGame(game);
    petBehavior.act(
      game === "jump-rope" ? "wave" : "stretch",
      game === "jump-rope" ? "准备好了吗？看准绳子一起跳！" : "我做一拍，你跟一拍。",
      2_400,
    );
  }
  function completeFloatingPetGame(
    game: FloatingPetGame,
    score: number,
    durationSeconds: number,
  ): void {
    void window.desktopApi?.pet
      .recordMiniGame({ game, score, durationSeconds })
      .then(() => petData.refresh());
    petBehavior.celebrate(
      game === "jump-rope"
        ? `我们一起跳了 ${score} 下！配合越来越好啦。`
        : "伸展完成，肩膀和眼睛都松一松。",
    );
    closePetInteractionSurface();
  }
  function openFloatingContextMenu(
    event: ReactMouseEvent<HTMLElement>,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    contextMenuReturnExpandedRef.current = expanded;
    contextMenuReturnPetOnlyRef.current = petOnly;
    setContextMenuOpen(true);
    if (!expanded) setPanelExpanded(true, "click");
  }
  function showMainFromFloatingMenu(route: MainRoute | "plan-today"): void {
    const returnToPetOnly = contextMenuReturnPetOnlyRef.current;
    contextMenuReturnExpandedRef.current = false;
    contextMenuReturnPetOnlyRef.current = false;
    setContextMenuOpen(false);
    if (returnToPetOnly) collapsePetTaskRail();
    else setPanelExpanded(false);
    void window.desktopApi?.shell.showMain(route);
  }
  function showQuickCaptureFromFloatingMenu(): void {
    const returnToPetOnly = contextMenuReturnPetOnlyRef.current;
    contextMenuReturnExpandedRef.current = false;
    contextMenuReturnPetOnlyRef.current = false;
    setContextMenuOpen(false);
    if (returnToPetOnly) collapsePetTaskRail();
    else setPanelExpanded(false);
    void window.desktopApi?.shell.showQuickCapture();
  }
  function openFloatingChatFromMenu(): void {
    contextMenuReturnExpandedRef.current = false;
    setContextMenuOpen(false);
    chatFollowsOutputRef.current = true;
    setTab("chat");
    setPanelExpanded(true, "click");
  }
  function toggleFloatingPreference(
    preference: "privacyMode" | "locked",
  ): void {
    if (!window.desktopApi) return;
    void window.desktopApi.settings
      .get()
      .then((settings) =>
        window.desktopApi!.settings.replace({
          ...settings,
          floating: {
            ...settings.floating,
            [preference]: !settings.floating[preference],
          },
        }),
      )
      .finally(closeFloatingContextMenu);
  }
  function mutePetUntil(until: Date): void {
    if (!window.desktopApi) return;
    void window.desktopApi.settings
      .get()
      .then((settings) =>
        window.desktopApi!.settings.replace({
          ...settings,
          notifications: {
            ...settings.notifications,
            mutedUntil: until.toISOString(),
          },
        }),
      )
      .then(() => window.desktopApi?.notifications.refresh())
      .finally(closeFloatingContextMenu);
  }
  function mutePetForOneHour(): void {
    mutePetUntil(new Date(Date.now() + 60 * 60 * 1_000));
  }
  function mutePetForToday(): void {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    mutePetUntil(tomorrow);
  }
  function performPetInteraction(kind: PetInteractionKind): void {
    petBehavior.interact(kind);
    void window.desktopApi?.pet.interact(kind).then(() => petData.refresh());
    closeFloatingContextMenu();
  }
  function beginFloatingHandleDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void {
    if (floatingLocked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    floatingDragPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setPetWindowDragging(true);
    petBehavior.startDragging();
    void window.desktopApi?.shell.beginFloatingDrag(
      event.screenX,
      event.screenY,
    );
  }
  function updateFloatingHandleDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void {
    if (floatingDragPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    void window.desktopApi?.shell.updateFloatingDrag(
      event.screenX,
      event.screenY,
    );
  }
  function finishFloatingHandleDrag(
    event?: ReactPointerEvent<HTMLButtonElement>,
  ): void {
    if (
      event &&
      floatingDragPointerRef.current !== undefined &&
      floatingDragPointerRef.current !== event.pointerId
    ) return;
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    floatingDragPointerRef.current = undefined;
    setPetWindowDragging(false);
    petBehavior.stopDragging();
    void window.desktopApi?.shell.endFloatingDrag();
  }
  function beginPetAvatarPointer(
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void {
    if (floatingLocked || event.button !== 0) return;
    // A click on the compact pet is an explicit reopen gesture. Cancel a
    // delayed hover-leave collapse before the pointer session starts so the
    // pending timer cannot close the panel between pointerdown and the
    // deferred single-click expansion.
    if (hoverLeaveTimerRef.current !== undefined) {
      window.clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = undefined;
    }
    petAvatarPointerRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      lastScreenX: event.screenX,
      lastScreenY: event.screenY,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function updatePetAvatarPointer(
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void {
    const session = petAvatarPointerRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.lastScreenX = event.screenX;
    session.lastScreenY = event.screenY;
    if (!session.dragging) {
      const distance = Math.hypot(
        event.clientX - session.startClientX,
        event.clientY - session.startClientY,
      );
      if (distance < 6) return;
      session.dragging = true;
      suppressPetAvatarClickRef.current = true;
      floatingDragPointerRef.current = event.pointerId;
      setPetWindowDragging(true);
      petBehavior.startDragging();
      void window.desktopApi?.shell
        .beginFloatingDrag(session.startScreenX, session.startScreenY)
        .then((started) => {
          const current = petAvatarPointerRef.current;
          if (!started) {
            if (current?.pointerId === event.pointerId) {
              current.dragging = false;
              floatingDragPointerRef.current = undefined;
              suppressPetAvatarClickRef.current = false;
              setPetWindowDragging(false);
              petBehavior.stopDragging();
            }
            return;
          }
          if (!current || current.pointerId !== event.pointerId || !current.dragging) {
            void window.desktopApi?.shell.endFloatingDrag();
            return;
          }
          void window.desktopApi?.shell.updateFloatingDrag(
            current.lastScreenX,
            current.lastScreenY,
          );
        });
    } else {
      void window.desktopApi?.shell.updateFloatingDrag(event.screenX, event.screenY);
    }
    event.preventDefault();
    event.stopPropagation();
  }
  function finishPetAvatarPointer(
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void {
    const session = petAvatarPointerRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    petAvatarPointerRef.current = undefined;
    if (session.dragging) {
      event.preventDefault();
      event.stopPropagation();
      finishFloatingHandleDrag(event);
      if (suppressPetAvatarClickTimerRef.current !== undefined) {
        window.clearTimeout(suppressPetAvatarClickTimerRef.current);
      }
      suppressPetAvatarClickTimerRef.current = window.setTimeout(() => {
        suppressPetAvatarClickRef.current = false;
        suppressPetAvatarClickTimerRef.current = undefined;
      }, 0);
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }
  async function toggleTaskFromPet(
    controller: TaskController,
    task: Task,
  ): Promise<void> {
    const completing = task.status === "open";
    await controller.toggleComplete(task);
    if (completing) petBehavior.celebrate("完成一件，真不错。");
  }
  async function runFocusAction(operation: () => Promise<unknown>) {
    setFocusBusy(true);
    setFocusError("");
    try {
      await operation();
      await petData.refresh();
    } catch (reason) {
      setFocusError(
        reason instanceof Error ? reason.message : "专注操作暂时失败",
      );
    } finally {
      setFocusBusy(false);
    }
  }
  function startPetFocus(
    mode: "pomodoro" | "count-up",
    focusMinutes = petSettings.focus.focusMinutes,
    taskOverride?: Task,
  ): void {
    const task = taskOverride ?? current;
    const requestedEnvironmentSound = petSettings.focus.environmentSound;
    // Prime Web Audio inside the user gesture. This keeps ambience reliable
    // even when the persistent floating renderer is not the focused window.
    if (requestedEnvironmentSound !== "off") {
      focusEnvironmentSoundRef.current?.setKind(requestedEnvironmentSound);
    }
    void runFocusAction(async () => {
      try {
        await window.desktopApi?.pet.startFocus({
          mode,
          taskId: task?.id,
          taskTitle: task?.title,
          preset: {
            focusMinutes,
            shortBreakMinutes: petSettings.focus.shortBreakMinutes,
            longBreakMinutes: petSettings.focus.longBreakMinutes,
            cycles: petSettings.focus.cycles,
          },
          autoStartBreak: petSettings.focus.autoStartBreak,
          autoStartNextRound: petSettings.focus.autoStartNextRound,
        });
      } catch (error) {
        focusEnvironmentSoundRef.current?.setKind("off");
        throw error;
      }
    });
  }
  function controllerForPetTask(task: Task): TaskController {
    return todayController.tasks.some((candidate) => candidate.id === task.id)
      ? todayController
      : allController;
  }
  async function handlePetTaskDrop(
    targetId: PetTaskDropTargetId,
    taskId: string,
  ): Promise<void> {
    const target = getPetTaskDropTarget(targetId);
    const task = [...allController.tasks, ...todayController.tasks].find(
      (candidate) => candidate.id === taskId,
    );
    setTaskDropActive(false);
    setActiveTaskDropTarget(undefined);
    setDraggedTaskId(undefined);
    if (!target || !task) {
      petBehavior.act("task-plan", "这张任务卡跑得太快啦，再试一次。", 3_000);
      return;
    }
    try {
      if (target.id === "focus") {
        startPetFocus("pomodoro", petSettings.focus.focusMinutes, task);
        petBehavior.act("focus", "收到，搬到专注里一起做。", 3_000);
        setHeldTaskId(undefined);
        return;
      }
      if (target.id === "complete") {
        await toggleTaskFromPet(controllerForPetTask(task), task);
        setHeldTaskId(undefined);
        return;
      }
      setHeldTaskId(task.id);
      petBehavior.act("task-plan", "先放在手边，等你准备好再继续。", 3_000);
    } catch (reason) {
      setHeldTaskId(task.id);
      petBehavior.act(
        "sync-error",
        reason instanceof Error ? reason.message : "这张任务卡暂时搬不动。",
        4_000,
      );
    }
  }
  function dismissPetReaction(): void {
    proactiveMessageRef.current = undefined;
    setProactiveTask(undefined);
    petBehavior.dismiss();
  }
  function taskForProactiveSuggestion(): Task | undefined {
    if (!proactiveTask) return undefined;
    return [...allController.tasks, ...todayController.tasks].find(
      (task) => task.id === proactiveTask.taskId,
    );
  }
  function openProactiveTask(): void {
    const task = taskForProactiveSuggestion();
    dismissPetReaction();
    if (!task) return;
    setTab("all");
    allController.select(task.id);
    setPanelExpanded(true, "click");
  }
  function startProactiveTaskFocus(): void {
    const task = taskForProactiveSuggestion();
    dismissPetReaction();
    if (task) startPetFocus("pomodoro", petSettings.focus.focusMinutes, task);
  }
  useEffect(() => {
    if (!contextMenuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeFloatingContextMenu();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenuOpen]);
  useEffect(() => {
    if (!interactionWheelOpen && !floatingGame) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePetInteractionSurface();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [interactionWheelOpen, floatingGame, expanded]);
  useEffect(() => {
    if (!petWindowDragging) return undefined;
    const finish = () => {
      if (floatingDragPointerRef.current === undefined) return;
      floatingDragPointerRef.current = undefined;
      petAvatarPointerRef.current = undefined;
      if (suppressPetAvatarClickTimerRef.current !== undefined) {
        window.clearTimeout(suppressPetAvatarClickTimerRef.current);
      }
      suppressPetAvatarClickTimerRef.current = window.setTimeout(() => {
        suppressPetAvatarClickRef.current = false;
        suppressPetAvatarClickTimerRef.current = undefined;
      }, 0);
      setPetWindowDragging(false);
      petBehavior.stopDragging();
      void window.desktopApi?.shell.endFloatingDrag();
    };
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("blur", finish, { once: true });
    const safetyTimer = window.setTimeout(finish, 8_500);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("blur", finish);
      window.clearTimeout(safetyTimer);
    };
  }, [petWindowDragging]);
  function openMainFromCompact(): void {
    if (compactActivateTimerRef.current !== undefined) {
      window.clearTimeout(compactActivateTimerRef.current);
      compactActivateTimerRef.current = undefined;
    }
    // A double click is an explicit escalation from the lightweight surface
    // to the full app. Keep the floating entry compact while the main window
    // is restored so it does not leave an unexpectedly expanded panel behind.
    setPanelExpanded(false);
    const route: MainRoute =
      tab === "today"
        ? "today"
        : tab === "chat"
          ? "agent"
          : tab === "home"
            ? "pet"
            : "all";
    const showMain = () => {
      void window.desktopApi?.shell.showMain(route);
    };
    showMain();
    // A hidden main BrowserWindow can be between renderer commits when the
    // compact pet is double-clicked. The preload already deduplicates route
    // commands, so a short idempotent retry makes the direct-entry gesture
    // reliable without creating a second window or changing the destination.
    window.setTimeout(showMain, 120);
  }
  function handleCompactActivate(
    event: ReactMouseEvent<HTMLButtonElement>,
  ): void {
    if (event.detail > 1) {
      event.preventDefault();
      openMainFromCompact();
      return;
    }
    if (compactActivateTimerRef.current !== undefined) {
      window.clearTimeout(compactActivateTimerRef.current);
    }
    // Defer the single-click expansion just long enough to distinguish a
    // normal double click. This preserves the existing one-click expansion
    // while allowing a double-click on the compact icon to open the main app.
    compactActivateTimerRef.current = window.setTimeout(() => {
      compactActivateTimerRef.current = undefined;
      setPanelExpanded(true, "click");
    }, 240);
  }
  function scheduleHoverExpand() {
    if (petOnly || expanded || hoverExpandTimerRef.current !== undefined) return;
    hoverExpandTimerRef.current = window.setTimeout(() => {
      hoverExpandTimerRef.current = undefined;
      if (!hoveringFloatingRef.current) return;
      setPanelExpanded(true, "hover");
    }, hoverExpandDelayMsRef.current);
  }
  const beginHoverExpand = () => {
    if (hoverLeaveTimerRef.current !== undefined) {
      window.clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = undefined;
    }
    hoveringFloatingRef.current = true;
    setIsFloatingHovered(true);
    scheduleHoverExpand();
  };
  const cancelHoverExpand = () => {
    if (hoverExpandTimerRef.current === undefined) return;
    window.clearTimeout(hoverExpandTimerRef.current);
    hoverExpandTimerRef.current = undefined;
  };
  const endHoverInteraction = (clientX: number, clientY: number) => {
    lastFloatingPointerRef.current = { x: clientX, y: clientY };
    hoveringFloatingRef.current = false;
    setIsFloatingHovered(false);
    cancelHoverExpand();
    if (hoverLeaveTimerRef.current !== undefined) {
      window.clearTimeout(hoverLeaveTimerRef.current);
    }
    // Resizing the native transparent window from compact to expanded can
    // briefly dispatch mouseleave even though the pointer is still over the
    // newly revealed panel. Give the window geometry time to settle, then
    // verify the pointer is really outside the entire floating surface.
    hoverLeaveTimerRef.current = window.setTimeout(() => {
      hoverLeaveTimerRef.current = undefined;
      const { x, y } = lastFloatingPointerRef.current;
      const withinViewport =
        x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
      const pointedElement = withinViewport
        ? document.elementFromPoint(x, y)
        : null;
      if (pointedElement?.closest(".floating-stack")) {
        hoveringFloatingRef.current = true;
        setIsFloatingHovered(true);
        return;
      }
      if (expandTriggerRef.current === "hover") setPanelExpanded(false);
    }, 180);
  };
  const syncLabel = feishuStatus?.connected
    ? feishuStatus.state === "syncing"
      ? "飞书正在同步"
      : `飞书已连接${feishuStatus.lastSyncAt ? ` · ${formatDateTime(feishuStatus.lastSyncAt)}` : ""}`
    : feishuStatus?.configured
      ? "飞书等待重新连接"
      : "飞书未连接 · 本地任务正常";
  const petMood: PetMood = petFocus?.status === "running"
    ? "focus"
    : feishuStatus?.state === "syncing"
      ? "syncing"
      : overdueCount > 0
        ? "alert"
        : todayController.tasks.length === 0
          ? "happy"
          : "idle";
  return (
    <div
      className={`floating-shell pet-shell ${expanded ? "is-expanded" : "is-compact"} ${petOnly ? "is-pet-only" : ""} ${privacyMode ? "privacy-mode" : ""} ${floatingLocked ? "position-locked" : ""} ${petFocus ? "has-focus-session" : ""} ${petFocus?.status === "running" ? "focus-mode" : ""} ${petBehavior.message ? "has-pet-reaction" : ""} ${petBehavior.message && reactionBubbleCollapsed ? "pet-reaction-collapsed" : ""} ${petWindowDragging ? "is-pet-dragging" : ""} ${interactionWheelOpen ? "has-interaction-wheel" : ""} ${floatingGame ? "has-coop-game" : ""} ${petDropActive ? "is-pet-drop-active" : ""} pet-motion-${petSettings.pet.animationIntensity}`}
      data-pet-action={petBehavior.action}
      style={
        {
          "--pet-scale": Math.max(75, Math.min(125, scalePercent)) / 100,
        } as CSSProperties
      }
    >
      <div
        className="floating-stack"
        data-expand-trigger={expandTriggerRef.current ?? "closed"}
        onMouseEnter={beginHoverExpand}
        onMouseMove={(event) => {
          lastFloatingPointerRef.current = {
            x: event.clientX,
            y: event.clientY,
          };
          // Recover a hover session after a transparent-window resize or a
          // compositor-level pointer transition. Moving inside the surface
          // is proof that the pointer is still over Todo Pet, so the latest
          // configured delay should be scheduled again.
          if (!hoveringFloatingRef.current) {
            hoveringFloatingRef.current = true;
            setIsFloatingHovered(true);
            scheduleHoverExpand();
          }
        }}
        onMouseLeave={(event) =>
          endHoverInteraction(event.clientX, event.clientY)
        }
      >
        <div
          // The native window remains transparent. Only the pet and its two
          // speech bubbles are painted; controls opt out of the drag surface.
          className="pet-compact"
          onContextMenu={openFloatingContextMenu}
        >
          {petBehavior.message && (
            <div
              className={`pet-reaction-bubble no-drag ${reactionBubbleCollapsed ? "is-collapsed" : ""}`}
              role="status"
              aria-live="polite"
            >
              <button
                type="button"
                className="pet-reaction-bubble-toggle"
                aria-expanded={!reactionBubbleCollapsed}
                aria-label={reactionBubbleCollapsed ? "展开宠物消息气泡" : "折叠宠物消息气泡"}
                onClick={() => setReactionBubbleCollapsed((value) => !value)}
              >
                <span><Sparkles size={12} /> {petName}有话说</span>
                <ChevronDown size={14} />
              </button>
              {!reactionBubbleCollapsed && (
                <div className="pet-reaction-bubble-body">
                  <span>{petBehavior.message}</span>
                  {proactiveTask && !privacyMode && (
                    <div className="pet-proactive-task-card" role="group" aria-label="宠物推荐的下一项任务">
                      <small>{proactiveTask.reason}</small>
                      <strong>{proactiveTask.taskTitle}</strong>
                      <div className="pet-proactive-task-actions">
                        <button type="button" onClick={startProactiveTaskFocus}>
                          <Focus size={13} /> 开始专注
                        </button>
                        <button type="button" onClick={openProactiveTask}>
                          <ExternalLink size={13} /> 查看任务
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="pet-quick-replies">
                    <button
                      type="button"
                      onClick={() => {
                        dismissPetReaction();
                        setTab(openTodayTaskCount ? "today" : "all");
                        setPanelExpanded(true, "click");
                      }}
                    >
                      好，一起看看
                    </button>
                    <button type="button" onClick={dismissPetReaction}>
                      稍后
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {petSeasonEvent && (
            <span
              className="pet-season-chip no-drag"
              role="status"
              title={petSeasonEvent.message}
              aria-label={`${petSeasonEvent.label}：${petSeasonEvent.message}`}
            >
              {petSeasonEvent.icon} {petSeasonEvent.label}
            </span>
          )}
          {!floatingGame && (
            <button
              type="button"
              className="floating-drag-handle no-drag"
              title={floatingLocked ? "位置已锁定" : "拖动移动"}
              aria-label={floatingLocked ? "宠物位置已锁定" : "拖动 Todo Pet"}
              disabled={floatingLocked}
              onPointerDown={beginFloatingHandleDrag}
              onPointerMove={updateFloatingHandleDrag}
              onPointerUp={finishFloatingHandleDrag}
              onPointerCancel={finishFloatingHandleDrag}
            >
              <GripVertical size={15} />
            </button>
          )}
          {!floatingGame && !interactionWheelOpen && (
            <button
              type="button"
              className={`pet-task-rail-toggle no-drag ${petOnly ? "is-expand" : "is-collapse"}`}
              aria-label={petOnly ? "展开宠物任务栏" : "收起宠物任务栏"}
              title={petOnly ? "展开任务栏" : "只保留宠物"}
              onClick={(event) => {
                event.stopPropagation();
                if (petOnly) expandPetTaskRail();
                else collapsePetTaskRail();
              }}
            >
              {petOnly ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
            </button>
          )}
          <button
            ref={petInteractionTriggerRef}
            type="button"
            className={`pet-interaction-trigger no-drag ${interactionWheelOpen ? "is-open" : ""}`}
            aria-label={interactionWheelOpen ? "关闭宠物互动轮盘" : `和${petName}互动`}
            aria-expanded={interactionWheelOpen}
            title="互动与小游戏"
            onClick={(event) => {
              event.stopPropagation();
              if (interactionWheelOpen) closePetInteractionSurface();
              else openPetInteractionWheel();
            }}
          >
            {interactionWheelOpen ? <X size={15} /> : <Heart size={15} />}
          </button>
          <button
            type="button"
            className="pet-avatar-button floating-expand-trigger no-drag"
            aria-label={`${petOnly ? `互动 ${petName}` : expanded ? `收起 ${petName}` : `展开 ${petName}`}，按住拖动可移动位置`}
            aria-expanded={expanded}
            title={
              petOnly
                ? "点击互动，拖动移动，双击打开主窗口"
                : expanded
                ? "点击收起，拖动可移动"
                : `停留 ${hoverExpandDelayMs / 1000} 秒或单击展开，拖动可移动，双击打开主窗口`
            }
            onPointerDown={beginPetAvatarPointer}
            onPointerMove={updatePetAvatarPointer}
            onPointerUp={finishPetAvatarPointer}
            onPointerCancel={finishPetAvatarPointer}
            onDragEnter={(event) => {
              const isTask = event.dataTransfer.types.includes("application/x-todo-agent-task");
              const isExternal = event.dataTransfer.types.some((type) => ["text/plain", "text/uri-list", "Files"].includes(type));
              if (!isTask && !isExternal) return;
              event.preventDefault();
              if (isTask) setTaskDropActive(true);
              else setPetDropActive(true);
            }}
            onDragOver={(event) => {
              const isTask = event.dataTransfer.types.includes("application/x-todo-agent-task");
              const isExternal = event.dataTransfer.types.some((type) => ["text/plain", "text/uri-list", "Files"].includes(type));
              if (!isTask && !isExternal) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = isTask ? "move" : "copy";
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setTaskDropActive(false);
                setPetDropActive(false);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const taskId = event.dataTransfer.getData("application/x-todo-agent-task");
              setTaskDropActive(false);
              setPetDropActive(false);
              if (taskId) {
                setHeldTaskId(taskId);
                petBehavior.taskDrop();
                if (petOnly) expandPetTaskRail();
                return;
              }
              const preview = buildDropContextPreview({
                plainText: event.dataTransfer.getData("text/plain"),
                uriList: event.dataTransfer.getData("text/uri-list"),
                files: Array.from(event.dataTransfer.files).map((file) => ({
                  name: file.name,
                  type: file.type,
                  size: file.size,
                })),
              });
              if (preview) {
                setPetDropPreview(preview);
                setPanelExpanded(true, "click");
                petBehavior.act("inspect", "我先把这份内容放在这里看看。", 4_000);
              }
            }}
            onClick={(event) => {
              if (suppressPetAvatarClickRef.current) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              if (petSettings.pet.interactionsEnabled) {
                const character = event.currentTarget.querySelector<HTMLElement>(
                  ".pet-character",
                );
                const kind = petInteractionFromPoint(
                  event.clientX,
                  event.clientY,
                  (character ?? event.currentTarget).getBoundingClientRect(),
                );
                petBehavior.interact(kind);
                void window.desktopApi?.pet.interact(kind).then(() => petData.refresh());
              }
              if (petOnly) {
                if (event.detail > 1) openMainFromCompact();
                return;
              }
              if (expanded) {
                setPanelExpanded(false, "click");
                return;
              }
              handleCompactActivate(event);
            }}
          >
            <PetCharacter
              mood={petMood}
              emotion={petBehavior.emotion}
              action={petBehavior.action}
              name={petName}
              scalePercent={expanded ? 100 : scalePercent}
              compact
              interactive
              palette={petAppearance.palette}
              outfit={petAppearance.outfit}
              season={petSeason}
            />
          </button>
          {taskDropActive && draggedTaskId && (
            <div
              className="pet-task-drop-zones no-drag"
              role="group"
              aria-label="把任务交给宠物"
            >
              <span className="pet-task-drop-zones-hint">把任务交给我</span>
              {petTaskDropTargets.map((target) => (
                <button
                  type="button"
                  key={target.id}
                  className={`pet-task-drop-zone ${activeTaskDropTarget === target.id ? "is-active" : ""} is-${target.id}`}
                  data-drop-target={target.id}
                  aria-label={`${target.label}：${target.hint}`}
                  title={target.hint}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setActiveTaskDropTarget(target.id);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setActiveTaskDropTarget(target.id);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setActiveTaskDropTarget(undefined);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const taskId =
                      event.dataTransfer.getData("application/x-todo-agent-task") ||
                      draggedTaskId;
                    if (taskId) void handlePetTaskDrop(target.id, taskId);
                  }}
                >
                  <span>{target.label}</span>
                  <small>{target.hint}</small>
                </button>
              ))}
            </div>
          )}
          {interactionWheelOpen && (
            <PetInteractionWheel
              petName={petName}
              onInteract={performWheelInteraction}
              onStartGame={startFloatingPetGame}
              onClose={closePetInteractionSurface}
            />
          )}
          <div className="pet-bubble-stack no-drag">
            {petDropPreview && (
              <section className="pet-speech-bubble pet-drop-preview-bubble" aria-label="宠物收到的拖入内容">
                <div className="pet-drop-preview-header">
                  <span><Sparkles size={13} /> 我收到了一份{petDropPreview.label}</span>
                  <button type="button" className="icon-button" aria-label="关闭宠物拖入预览" onClick={() => setPetDropPreview(undefined)}><X size={14} /></button>
                </div>
                {petDropPreview.kind === "file" || petDropPreview.kind === "image" ? (
                  <div className="pet-drop-file-list">
                    {petDropPreview.files?.map((file, index) => <span key={`${file.name}-${index}`}><FileText size={13} /> {file.name}</span>)}
                  </div>
                ) : (
                  <p>{petDropPreview.kind === "url" ? petDropPreview.url : petDropPreview.text}</p>
                )}
                <small>只做预览，不会自动上传或创建任务。</small>
                {(petDropPreview.kind === "text" || petDropPreview.kind === "url") && (
                  <button type="button" className="soft-button" onClick={() => {
                    const value = petDropPreview.kind === "url" ? petDropPreview.url : petDropPreview.text;
                    if (value) {
                      setInput((current) => current.trim() ? `${current}\n${value}` : value);
                      setTab("chat");
                    }
                    setPetDropPreview(undefined);
                  }}>带入聊聊</button>
                )}
              </section>
            )}
            {selectedTextPreview && (
              <section className="pet-speech-bubble selected-text-preview-bubble" aria-label="宠物收到的选中文本预览">
                <div className="pet-drop-preview-header">
                  <span><ClipboardCheck size={13} /> 选中文本上下文</span>
                  <button type="button" className="icon-button" aria-label="关闭选中文本预览" onClick={() => setSelectedTextPreview(undefined)}><X size={14} /></button>
                </div>
                {selectedTextPreview.status === "captured" && selectedTextPreview.text ? (
                  <>
                    <p>{selectedTextPreview.text}</p>
                    <small>仅预览 · {selectedTextPreview.characters?.toLocaleString() ?? selectedTextPreview.text.length.toLocaleString()} 个字符{selectedTextPreview.truncated ? " · 已截取" : ""}</small>
                    <button type="button" className="soft-button" onClick={() => {
                      const value = selectedTextPreview.text ?? "";
                      if (value) {
                        if (tab === "chat") floatingChat.setInput((current) => current.trim() ? `${current}\n${value}` : value);
                        else setInput((current) => current.trim() ? `${current}\n${value}` : value);
                        setTab("chat");
                      }
                      setSelectedTextPreview(undefined);
                    }}>带入聊聊</button>
                  </>
                ) : (
                  <small>暂时没有读到选中文本；请在其他应用选中文本后使用全局快捷键打开小窗。</small>
                )}
              </section>
            )}
            {heldTask && (
              <section
                className={`pet-speech-bubble pet-held-task ${heldTaskBubbleCollapsed ? "is-collapsed" : ""}`}
                aria-label="交给宠物的任务"
              >
                <button
                  type="button"
                  className="pet-bubble-toggle"
                  aria-expanded={!heldTaskBubbleCollapsed}
                  aria-label={heldTaskBubbleCollapsed ? "展开交给宠物的任务气泡" : "折叠交给宠物的任务气泡"}
                  onClick={() => setHeldTaskBubbleCollapsed((value) => !value)}
                >
                  <span className="pet-bubble-label">
                    <Sparkles size={13} />
                    我接住了
                  </span>
                  <ChevronDown size={15} />
                </button>
                {!heldTaskBubbleCollapsed && (
                  <div className="pet-held-task-body">
                    <strong>{privacyMode ? "私人任务" : heldTask.title}</strong>
                    <div className="pet-held-task-actions">
                  <button
                    type="button"
                    disabled={!canToggleTaskCompletion(heldTask)}
                    onClick={() => {
                      const controller = tab === "today" ? todayController : allController;
                      void toggleTaskFromPet(controller, heldTask).then(() => {
                        petBehavior.taskComplete();
                        setHeldTaskId(undefined);
                      });
                    }}
                  >
                    <Check size={13} /> 完成
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void allController.moveToToday(heldTask.id).then(() => {
                        petBehavior.act("task-plan", "已经放进今天。", 3_000);
                        setHeldTaskId(undefined);
                      });
                    }}
                  >
                    <Sun size={13} /> 今天
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      startPetFocus("pomodoro", petSettings.focus.focusMinutes, heldTask);
                      setHeldTaskId(undefined);
                    }}
                  >
                    <Focus size={13} /> 专注
                  </button>
                  <button type="button" aria-label="放下任务" onClick={() => setHeldTaskId(undefined)}>
                    <X size={13} />
                  </button>
                    </div>
                  </div>
                )}
              </section>
            )}
            <section
              className={`pet-speech-bubble pet-task-bubble ${taskBubbleCollapsed ? "is-collapsed" : ""}`}
              aria-label="当前任务气泡"
            >
              <button
                type="button"
                className="pet-bubble-toggle"
                aria-expanded={!taskBubbleCollapsed}
                aria-label={taskBubbleCollapsed ? "展开任务气泡" : "折叠任务气泡"}
                onClick={() => setTaskBubbleCollapsed((value) => !value)}
              >
                <span className="pet-bubble-label">
                  <ListChecks size={13} />
                  当前任务
                  <small>{carousel.count ? `${carousel.index + 1}/${carousel.count}` : "已清空"}</small>
                </span>
                <ChevronDown size={15} />
              </button>
              {!taskBubbleCollapsed && (
                <div className="pet-task-bubble-body">
                  <button
                    type="button"
                    className="floating-summary"
                    aria-label="打开当前任务列表"
                    title={expanded ? "切换到任务列表" : "单击展开任务列表 · 双击打开主窗口"}
                    onClick={(event) => {
                      if (expanded) {
                        setTab("today");
                        return;
                      }
                      handleCompactActivate(event);
                    }}
                  >
                    <div className="floating-copy">
                      <FloatingTodayCarousel
                        task={current}
                        index={carousel.index}
                        count={carousel.count}
                        paused={carousel.paused}
                        static={carousel.static}
                        privacyMode={privacyMode}
                      />
                      <small>
                        {current
                          ? `${petName}提醒你 ${current.source.type === "feishu" ? "飞书任务" : "本地任务"}${privacyMode ? "（隐私模式）" : ""}`
                          : `${petName}说：今天可以轻松一点`}
                        {current && currentTaskTheme && currentTaskTheme.id !== "general" && (
                          <span className="pet-task-theme"> · {currentTaskTheme.label}</span>
                        )}
                      </small>
                    </div>
                    <span className="focus-time">
                      {current ? humanDuration(elapsed) : "✓"}
                    </span>
                  </button>
                  {current && (
                    <button
                      type="button"
                      className="icon-button pet-complete-button"
                      disabled={!canToggleTaskCompletion(current)}
                      aria-label={
                        privacyMode ? "完成当前私人任务" : `完成${current.title}`
                      }
                      onClick={() => void toggleTaskFromPet(todayController, current)}
                    >
                      <Check size={17} />
                    </button>
                  )}
                </div>
              )}
            </section>
            {petFocus && (
              <section
                className={`pet-speech-bubble pet-focus-bubble ${focusBubbleCollapsed ? "is-collapsed" : ""}`}
                aria-label="专注计时气泡"
              >
                <button
                  type="button"
                  className="pet-bubble-toggle pet-focus-bubble-toggle"
                  aria-expanded={!focusBubbleCollapsed}
                  aria-label={focusBubbleCollapsed ? "展开专注气泡" : "折叠专注气泡"}
                  onClick={() => setFocusBubbleCollapsed((value) => !value)}
                >
                  <span className="pet-bubble-label">
                    <Focus size={14} />
                    {focusPhaseLabel}
                    <small>
                      第 {petFocus.cycle}/{petFocus.preset.cycles} 轮
                      {focusEnvironmentSound !== "off"
                        ? ` · ${focusEnvironmentSoundLabel}`
                        : ""}
                    </small>
                  </span>
                  <strong>{clockDuration(petFocusClock)}</strong>
                  <ChevronDown size={15} />
                </button>
                {!focusBubbleCollapsed && (
                  <div className="pet-focus-bubble-body">
                    <p>
                      {petFocus.taskTitle
                        ? privacyMode
                          ? "私人任务"
                          : petFocus.taskTitle
                        : petFocus.phase === "focus"
                          ? "我陪你把这一段时间守住"
                          : "站起来走走，喝口水吧"}
                    </p>
                    <div className="pet-focus-bubble-actions">
                      {petFocus.status === "awaiting-completion" ? (
                        <button
                          type="button"
                          className="primary-button"
                          disabled={focusBusy}
                          aria-label={petFocus.phase === "focus" ? "开始专注休息" : "开始下一轮专注"}
                          onClick={() =>
                            void runFocusAction(() =>
                              window.desktopApi!.pet.advanceFocus(),
                            )
                          }
                        >
                          <Play size={14} />
                          {petFocus.phase === "focus" ? "休息" : "下一轮"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="primary-button"
                          disabled={focusBusy}
                          aria-label={petFocus.status === "running" ? "暂停专注计时" : "继续专注计时"}
                          onClick={() =>
                            void runFocusAction(() =>
                              petFocus.status === "running"
                                ? window.desktopApi!.pet.pauseFocus()
                                : window.desktopApi!.pet.resumeFocus(),
                            )
                          }
                        >
                          {petFocus.status === "running" ? <Pause size={14} /> : <Play size={14} />}
                          {petFocus.status === "running" ? "暂停" : "继续"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="soft-button"
                        disabled={focusBusy}
                        aria-label="结束专注计时"
                        onClick={() =>
                          void runFocusAction(() =>
                            window.desktopApi!.pet.finishFocus("abandoned"),
                          )
                        }
                      >
                        <Square size={13} />
                        结束
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
        {floatingGame && (
          <FloatingPetCoopGame
            key={floatingGame}
            game={floatingGame}
            petName={petName}
            palette={petAppearance.palette}
            outfit={petAppearance.outfit}
            season={petSeason}
            positionLocked={floatingLocked}
            onDragStart={beginFloatingHandleDrag}
            onDragMove={updateFloatingHandleDrag}
            onDragEnd={finishFloatingHandleDrag}
            onAction={petBehavior.act}
            onComplete={completeFloatingPetGame}
            onClose={closePetInteractionSurface}
          />
        )}
        {contextMenuOpen && (
          <>
            <button
              type="button"
              className="floating-context-backdrop no-drag"
              aria-label="关闭 Todo Pet 快捷菜单"
              onClick={closeFloatingContextMenu}
              onContextMenu={(event) => {
                event.preventDefault();
                closeFloatingContextMenu();
              }}
            />
            <div
              className="floating-context-menu no-drag"
              role="menu"
              aria-label="Todo Pet 快捷菜单"
              onContextMenu={(event) => event.preventDefault()}
            >
              <div className="floating-context-heading">
                <span>快捷操作</span>
                <kbd>Esc</kbd>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => showMainFromFloatingMenu("today")}
              >
                <Sun size={16} />
                <span>打开 Today</span>
                <small>主页面</small>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={showQuickCaptureFromFloatingMenu}
              >
                <Plus size={16} />
                <span>快速录入</span>
                <small>新增待办</small>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={openFloatingChatFromMenu}
              >
                <MessageCircle size={16} />
                <span>在此处对话</span>
                <small>打开 Agent</small>
              </button>
              <div className="floating-context-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                onClick={() => performPetInteraction("pet")}
              >
                <Heart size={16} />
                <span>摸摸{petName}</span>
                <small>增加默契</small>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => performPetInteraction("play")}
              >
                <CircleDot size={16} />
                <span>玩一会儿</span>
                <small>毛线球</small>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => performPetInteraction("high-five")}
              >
                <Sparkles size={16} />
                <span>击个掌</span>
                <small>庆祝一下</small>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => performPetInteraction("rest")}
              >
                <Activity size={16} />
                <span>一起休息</span>
                <small>喝水伸展</small>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => performPetInteraction("morning")}
              >
                <Sun size={16} />
                <span>早间问候</span>
                <small>看看今天</small>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => performPetInteraction("evening")}
              >
                <Clock3 size={16} />
                <span>晚间收尾</span>
                <small>温柔复盘</small>
              </button>
              <div className="floating-context-divider" role="separator" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={privacyMode}
                onClick={() => toggleFloatingPreference("privacyMode")}
              >
                <EyeOff size={16} />
                <span>{privacyMode ? "关闭隐私模式" : "开启隐私模式"}</span>
                <small>{privacyMode ? "已开启" : "隐藏任务内容"}</small>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={floatingLocked}
                onClick={() => toggleFloatingPreference("locked")}
              >
                <LockKeyhole size={16} />
                <span>{floatingLocked ? "解锁位置" : "锁定位置"}</span>
                <small>{floatingLocked ? "不可拖动" : "防止误拖"}</small>
              </button>
              <button type="button" role="menuitem" onClick={mutePetForOneHour}>
                <Bell size={16} />
                <span>安静一小时</span>
                <small>暂停主动提醒</small>
              </button>
              <button type="button" role="menuitem" onClick={mutePetForToday}>
                <Clock3 size={16} />
                <span>今天安静</span>
                <small>明天自动恢复</small>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => showMainFromFloatingMenu("settings")}
              >
                <Settings size={16} />
                <span>Todo Pet 设置</span>
                <small>外观与提醒</small>
              </button>
            </div>
          </>
        )}
        {expanded && !contextMenuOpen && !interactionWheelOpen && !floatingGame && (
          <div className="mini-panel">
            <div className="mini-tabs">
              <button
                type="button"
                className={tab === "all" ? "active" : ""}
                onClick={() => setTab("all")}
              >
                全部
              </button>
              <button
                type="button"
                className={tab === "today" ? "active" : ""}
                onClick={() => setTab("today")}
              >
                今天
              </button>
              <button
                type="button"
                className={tab === "focus" ? "active" : ""}
                onClick={() => setTab("focus")}
              >
                专注
              </button>
              <button
                type="button"
                className={tab === "chat" ? "active" : ""}
                onClick={() => {
                  chatFollowsOutputRef.current = true;
                  setTab("chat");
                }}
              >
                聊聊
              </button>
              <button
                type="button"
                className={tab === "home" ? "active" : ""}
                onClick={() => setTab("home")}
              >
                小窝
              </button>
              <button
                type="button"
                className="icon-button mini-open-main no-drag"
                aria-label="打开主窗口"
                title="打开主窗口"
                onClick={openMainFromCompact}
              >
                <ExternalLink size={15} />
              </button>
            </div>
            <div
              ref={miniContentRef}
              className={`mini-content ${tab === "chat" ? "mini-chat-content" : ""}`}
              onScroll={(event) => {
                if (tab !== "chat") return;
                const content = event.currentTarget;
                chatFollowsOutputRef.current =
                  content.scrollHeight - content.scrollTop - content.clientHeight <
                  40;
              }}
              role={tab === "chat" ? "log" : undefined}
              aria-label={tab === "chat" ? "Agent 对话记录" : undefined}
              aria-live={tab === "chat" ? "polite" : undefined}
              aria-relevant={tab === "chat" ? "additions text" : undefined}
              aria-busy={tab === "chat" && floatingChat.isSending}
            >
              {tab === "today" && (
                <div className="mini-daily-plan-entry">
                  <span className="mini-daily-plan-icon" aria-hidden="true">
                    <CalendarDays size={16} />
                  </span>
                  <div>
                    <strong>今天先做什么？</strong>
                    <small>
                      {openTodayTaskCount
                        ? `${openTodayTaskCount} 项待办，按时间重新挑选`
                        : "从全部任务里挑出今天的重点"}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="soft-button"
                    onClick={() => showMainFromFloatingMenu("plan-today")}
                  >
                    安排
                  </button>
                </div>
              )}
              {isTaskTab &&
                displayedTaskController.tasks.map((task) => (
                  <div
                    className="mini-task"
                    key={task.id}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/x-todo-agent-task", task.id);
                      event.dataTransfer.effectAllowed = "move";
                      setDraggedTaskId(task.id);
                      setTaskDropActive(true);
                      setActiveTaskDropTarget(undefined);
                      petBehavior.act("task-carry", "把任务拖到我身上，我来接住。", 8_000);
                    }}
                    onDragEnd={() => {
                      setTaskDropActive(false);
                      setDraggedTaskId(undefined);
                      setActiveTaskDropTarget(undefined);
                    }}
                  >
                    <input
                      className="task-checkbox"
                      type="checkbox"
                      checked={task.status === "completed"}
                      disabled={!canToggleTaskCompletion(task)}
                      onChange={() =>
                        void toggleTaskFromPet(displayedTaskController, task)
                      }
                      aria-label={
                        privacyMode ? "完成私人任务" : `完成${task.title}`
                      }
                    />
                    <span>{titleFor(task)}</span>
                    <small>
                      {privacyMode
                        ? "私人任务"
                        : `${task.source.type === "feishu" ? "飞书" : "本地"}${task.dueAt ? ` · ${formatDateTime(task.dueAt)}` : ""}`}
                    </small>
                  </div>
                ))}
              {isTaskTab && !displayedTaskController.tasks.length && (
                <div className="empty-state">
                  <p>{tab === "all" ? "还没有未完成任务" : "今天没有待办"}</p>
                </div>
              )}
              {tab === "chat" &&
                (privacyMode ? (
                  <div className="mini-private-content" role="status">
                    <EyeOff size={18} />
                    <strong>对话内容已隐藏</strong>
                    <p>隐私模式下不会显示或发送任务相关对话。退出隐私模式后可继续使用 Agent。</p>
                  </div>
                ) : (
                <div className="mini-chat-thread">
                  <div className="mini-agent-status" role="status">
                    <span>
                      {floatingChat.agentStatus?.enabled &&
                      floatingChat.agentStatus.configured
                        ? `Agent · ${floatingChat.runState}`
                        : "本地任务助理 · 模型未启用"}
                    </span>
                  </div>
                  {floatingChat.messages.map((message, index) => (
                    <div
                      key={message.id ?? `${message.role}-${index}`}
                      className={`message mini-message ${message.role === "user" ? "user" : ""} ${message.streaming ? "streaming" : ""}`}
                    >
                      {message.role === "assistant" ? (
                        message.text ? (
                          <AgentMarkdown text={message.text} />
                        ) : (
                          <span className="streaming-indicator" role="status">
                            <i />
                            <i />
                            <i />
                            <span className="sr-only">正在生成回答</span>
                          </span>
                        )
                      ) : (
                        message.text
                      )}
                    </div>
                  ))}
                  {floatingChat.approval && (
                    <div
                      className="mini-approval"
                      role="group"
                      aria-label={`确认 Agent 执行 ${floatingChat.approval.toolName}`}
                    >
                      <div className="mini-approval-title">
                        <ShieldAlert size={16} />
                        <strong>
                          允许执行 {floatingChat.approval.toolName}？
                        </strong>
                      </div>
                      <p>
                        {floatingChat.approval.effects.risk} ·
                        {floatingChat.approval.effects.reversible === false
                          ? " 不可自动撤销"
                          : " 可撤销或无持久变更"}
                      </p>
                      <small>
                        {privacyMode
                          ? "将影响你刚刚指定的目标"
                          : floatingChat.approval.effects.targets
                              .slice(0, 3)
                              .map((target) =>
                                `${target.kind}:${target.value}`,
                              )
                              .join("、") || "请检查这次操作的影响"}
                      </small>
                      <div className="mini-approval-actions">
                        <button
                          type="button"
                          className="soft-button"
                          onClick={() =>
                            void floatingChat.respondToApproval("deny")
                          }
                        >
                          拒绝
                        </button>
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() =>
                            void floatingChat.respondToApproval("once")
                          }
                        >
                          仅本次允许
                        </button>
                      </div>
                    </div>
                  )}
                  {floatingChat.messages.length === 1 &&
                    !floatingChat.isSending && (
                      <div className="chip-row mini-chat-suggestions">
                        <button
                          type="button"
                          className="chip"
                          disabled={!current}
                          onClick={() =>
                            void submit(
                              current
                                ? `请帮我拆解任务“${current.title}”，先给建议，不要直接修改。`
                                : "",
                            )
                          }
                        >
                          拆解当前任务
                        </button>
                        <button
                          type="button"
                          className="chip"
                          onClick={() =>
                            void submit(
                              "请根据今天剩余的任务和时间重新规划接下来的安排，先展示方案，不要直接修改。",
                            )
                          }
                        >
                          重新规划下午
                        </button>
                      </div>
                  )}
                </div>
                ))}
              {tab === "focus" && (
                <div className="pet-focus-view">
                  <PetCharacter
                    mood={petFocus?.status === "running" ? "focus" : "idle"}
                    emotion={petBehavior.emotion}
                    action={petBehavior.action}
                    name={petName}
                    interactive
                    palette={petAppearance.palette}
                    outfit={petAppearance.outfit}
                    season={petSeason}
                  />
                  <p className="pet-focus-kicker">
                    {petFocus
                      ? `${focusPhaseLabel} · 第 ${petFocus.cycle}/${petFocus.preset.cycles} 轮`
                      : "选择一个节奏，和我一起开始"}
                  </p>
                  <strong className="pet-focus-timer">
                    {petFocus ? clockDuration(petFocusClock) : "25:00"}
                  </strong>
                  <p className="pet-focus-task">
                    {petFocus?.taskTitle
                      ? privacyMode
                        ? "私人任务"
                        : petFocus.taskTitle
                      : petFocus?.phase && petFocus.phase !== "focus"
                        ? "站起来走走，喝口水吧"
                        : current
                          ? `将关联：${titleFor(current)}`
                          : "无任务专注也可以，时间仍会被记录"}
                  </p>
                  {!petFocus ? (
                    <div className="pet-focus-presets" aria-label="专注预设">
                      <button
                        type="button"
                        disabled={focusBusy}
                        onClick={() => startPetFocus("pomodoro", 25)}
                      >
                        <strong>25</strong><span>轻专注</span>
                      </button>
                      <button
                        type="button"
                        disabled={focusBusy}
                        onClick={() => startPetFocus("pomodoro", 50)}
                      >
                        <strong>50</strong><span>深专注</span>
                      </button>
                      <button
                        type="button"
                        disabled={focusBusy}
                        onClick={() => startPetFocus("pomodoro", 90)}
                      >
                        <strong>90</strong><span>沉浸</span>
                      </button>
                      <button
                        type="button"
                        disabled={focusBusy}
                        onClick={() => startPetFocus("count-up")}
                      >
                        <strong>∞</strong><span>正计时</span>
                      </button>
                    </div>
                  ) : (
                    <div className="pet-focus-actions">
                      <button
                        type="button"
                        className="soft-button"
                        disabled={focusBusy}
                        onClick={() =>
                          void runFocusAction(() =>
                            window.desktopApi!.pet.finishFocus("abandoned"),
                          )
                        }
                      >
                        <Square size={15} />
                        结束
                      </button>
                      {petFocus.status === "awaiting-completion" ? (
                        <button
                          type="button"
                          className="primary-button"
                          disabled={focusBusy}
                          onClick={() =>
                            void runFocusAction(() =>
                              window.desktopApi!.pet.advanceFocus(),
                            )
                          }
                        >
                          <Play size={16} />
                          {petFocus.phase === "focus" ? "开始休息" : "下一轮"}
                        </button>
                      ) : (
                      <button
                        type="button"
                        className="primary-button"
                        disabled={focusBusy}
                        onClick={() =>
                          void runFocusAction(() =>
                            petFocus.status === "running"
                              ? window.desktopApi!.pet.pauseFocus()
                              : window.desktopApi!.pet.resumeFocus(),
                          )
                        }
                      >
                        {petFocus.status === "running" ? (
                          <Pause size={16} />
                        ) : (
                          <Play size={16} />
                        )}
                        {petFocus.status === "running" ? "暂停" : "继续"}
                      </button>
                      )}
                    </div>
                  )}
                  {focusError && <p className="pet-focus-error">{focusError}</p>}
                </div>
              )}
              {tab === "home" && (
                <div className="pet-home-view">
                  <div className="pet-home-hero">
                    <PetCharacter
                      mood={petMood}
                      emotion={petBehavior.emotion}
                      action={petBehavior.action}
                      name={petName}
                      interactive
                      palette={petAppearance.palette}
                      outfit={petAppearance.outfit}
                      season={petSeason}
                    />
                    <div>
                      <span>Todo Pet</span>
                      <h3>{petName}的小窝</h3>
                      <p>
                        Lv.{petData.snapshot?.profile.level ?? 1} · 亲密度 {petData.snapshot?.profile.intimacy ?? 0}
                      </p>
                    </div>
                  </div>
                  <div className="pet-home-card pet-weather-mini">
                    <Sun size={17} />
                    <div>
                      <strong>
                        {petData.weather
                          ? `${Math.round(petData.weather.temperatureC)}℃ · ${petData.weather.conditionLabel}`
                          : "天气卡片"}
                      </strong>
                      <p>
                        {petData.weather
                          ? `${petData.weather.city}${petData.weather.precipitationProbability !== undefined ? ` · 降水 ${petData.weather.precipitationProbability}%` : ""}`
                          : petSettings.weather.enabled
                            ? "天气暂时不可用"
                            : "可在设置中填写城市开启"}
                      </p>
                    </div>
                  </div>
                  <div className="pet-home-card">
                    <CloudCheck size={17} />
                    <div>
                      <strong>任务同步</strong>
                      <p>{syncLabel}</p>
                    </div>
                  </div>
                  <div className="pet-home-card">
                    <ShieldCheck size={17} />
                    <div>
                      <strong>最近活动</strong>
                      <p>
                        {activity[0]
                          ? privacyMode
                            ? `${activity[0].toolName ?? "Agent"} · 已记录`
                            : activity[0].toolName
                              ? `${activity[0].toolName} · ${activity[0].outcome ?? activity[0].event}`
                              : activity[0].event
                          : "暂无 Agent 工具活动"}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="soft-button pet-home-settings"
                    onClick={() => showMainFromFloatingMenu("pet")}
                  >
                    <UserRound size={16} />
                    进入完整小窝
                  </button>
                </div>
              )}
            </div>
            {(isTaskTab || tab === "chat") && !privacyMode && (
              <div className="mini-composer">
                {(voice.interimTranscript || voice.error) && (
                  <div
                    className={`voice-capture-status mini-voice-status ${voice.error ? "has-error" : ""}`}
                    aria-live="polite"
                  >
                    <Mic size={13} />
                    <span>
                      {voice.error ?? `正在听：${voice.interimTranscript}`}
                    </span>
                  </div>
                )}
                {isTaskTab ? (
                  <input
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                    placeholder="新增任务，例如：明天整理周报 p1 #工作 45m"
                    aria-label="新增本地任务"
                  />
                ) : (
                  <textarea
                    rows={1}
                    value={floatingChat.input}
                    onChange={(event) =>
                      floatingChat.setInput(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                    placeholder="在这里问 Agent…"
                    aria-label="给 Agent 发消息"
                  />
                )}
                <button
                  type="button"
                  className="icon-button"
                  disabled={
                    isTaskTab
                      ? !input.trim() || creatingFloatingTask
                      : !floatingChat.isSending && !floatingChat.input.trim()
                  }
                  onClick={() => {
                    if (tab === "chat" && floatingChat.isSending) {
                      void floatingChat.stop();
                      return;
                    }
                    void submit();
                  }}
                    aria-label={
                      isTaskTab
                      ? creatingFloatingTask
                        ? "正在新增任务"
                        : "新增任务"
                      : floatingChat.isSending
                        ? "停止 Agent"
                        : "发送给 Agent"
                  }
                >
                  {tab === "chat" && floatingChat.isSending ? (
                    <Square size={15} />
                  ) : (
                    <ArrowUp size={16} />
                  )}
                </button>
                <button
                  type="button"
                  className={`icon-button voice-capture-button ${voice.listening ? "is-listening" : ""}`}
                  disabled={!voice.supported || creatingFloatingTask || floatingChat.isSending}
                  onClick={voice.toggle}
                  aria-label={voice.listening ? "停止语音输入" : "开始语音输入"}
                  title={
                    voice.supported
                      ? "识别结果会先放入输入框，不会自动发送"
                      : "当前环境不支持语音输入"
                  }
                >
                  <Mic size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button context-capture-button"
                  onClick={() => void readSelectedTextPreview()}
                  disabled={selectedTextLoading || creatingFloatingTask || floatingChat.isSending}
                  aria-label="读取选中文本"
                  title="全局快捷键打开小窗时会尝试带入外部选中文本；这里只预览"
                >
                  <ClipboardCheck size={15} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function App() {
  const kind =
    new URLSearchParams(window.location.search).get("window") ?? "main";
  if (kind === "quick") return <QuickCaptureWindow />;
  if (kind === "floating") return <FloatingWindow />;
  return <MainWindow />;
}
