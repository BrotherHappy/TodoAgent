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
  ChevronDown,
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
  FileText,
  Filter,
  Focus,
  GripVertical,
  Inbox,
  Info,
  Laptop,
  LayoutList,
  ListChecks,
  LockKeyhole,
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
  type ReactNode,
} from "react";
import type {
  RecurrenceEditScope,
  Task,
  TaskPriority,
  TaskSourceType,
  TaskView,
  TaskViewSectionId,
} from "../shared/models";
import type { AuditRecord } from "../shared/agent-types";
import type { QuickCaptureResult } from "../shared/quick-capture";
import type {
  ReminderDelivery,
  ReminderPresetAction,
} from "../shared/reminders";
import {
  defaultSettings,
  type AiAuthenticationMode,
  type AppSettings,
  type PetTab,
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
import { AgentMarkdown } from "./AgentMarkdown";
import {
  localDateTimeInputToIso,
  toLocalDateTimeInput,
} from "./local-datetime";
import { feishuCreationBlockedMessage } from "./feishu-create-guard";
import { PetCharacter, type PetMood } from "./PetCharacter";
import { useTaskController, type TaskController } from "./task-controller";
import { useAgentChat } from "./use-agent-chat";

type MainRoute = TaskView | "agent" | "activity" | "sync" | "settings";
type ToastKind = "success" | "error" | "info";
type TaskEditorDirtyField =
  | "title"
  | "notes"
  | "projectId"
  | "tags"
  | "plannedDate"
  | "startAt"
  | "startAtAllDay"
  | "dueAt"
  | "dueAtAllDay"
  | "localReminder";

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

const routeTitles: Record<MainRoute, string> = {
  inbox: "暂存",
  today: "今天",
  upcoming: "即将到来",
  all: "全部任务",
  completed: "已完成",
  trash: "回收站",
  agent: "Agent",
  activity: "动态",
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

const dateKey = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  onHome,
  onBack,
  syncState = "synced",
  children,
}: {
  search?: string;
  onSearch?: (value: string) => void;
  onNew?: () => void;
  onHome?: () => void;
  onBack?: () => void;
  syncState?: "synced" | "pending" | "conflict";
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
            <kbd>{isMacPlatform() ? "⌘ K" : "Ctrl K"}</kbd>
          )}
        </label>
      )}
      {children}
      <span
        className={`status-pill ${syncState === "synced" ? "success" : syncState === "conflict" ? "warning" : "syncing"}`}
      >
        {syncState === "synced" ? (
          <CloudCheck size={15} />
        ) : syncState === "conflict" ? (
          <AlertTriangle size={15} />
        ) : (
          <RefreshCw size={15} />
        )}
        {syncState === "synced"
          ? "已保存"
          : syncState === "conflict"
            ? "有冲突"
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
      {item("sync", <AlertTriangle size={17} />, counts.conflicts, "warning")}
      <div className="nav-section-label">工作台</div>
      {item("agent", <Sparkles size={17} />)}
      {item("activity", <Activity size={17} />)}
      <div className="sidebar-footer">
        {item("settings", <Settings size={17} />)}
      </div>
    </nav>
  );
}

function MorningBrief({
  controller,
  notify,
}: {
  controller: TaskController;
  notify: (message: string, kind?: ToastKind) => void;
}) {
  const [aiSummary, setAiSummary] = useState<string>();
  const [aiRefreshing, setAiRefreshing] = useState(false);
  const overdue = controller.tasks.filter(
    (task) =>
      task.dueAt &&
      task.dueAt.slice(0, 10) < dateKey() &&
      task.status === "open",
  ).length;
  const feishu = controller.tasks.filter(
    (task) => task.source.type === "feishu",
  ).length;
  const first = controller.tasks.find((task) => task.status === "open");
  const localSummary =
    controller.tasks.length === 0
      ? "今天还没有安排。可以先写下一件最重要的小事。"
      : `${overdue ? `有 ${overdue} 项逾期；` : ""}今天共 ${controller.tasks.length} 项，其中 ${feishu} 项来自飞书。${first ? `建议先从“${first.title}”开始。` : ""}`;

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
  const overdue =
    task.dueAt && task.dueAt.slice(0, 10) < dateKey() && task.status === "open";
  const classes = [
    "task-row",
    selected ? "selected" : "",
    task.status === "completed" ? "completed" : "",
    task.sync.status === "pending" ? "pending" : "",
    task.sync.status === "conflict" ? "conflict" : "",
  ].join(" ");
  return (
    <div className={classes} data-task-id={task.id}>
      <input
        className="task-checkbox"
        type="checkbox"
        checked={task.status === "completed"}
        disabled={!canComplete}
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
        onClick={() => controller.select(task.id)}
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
          {task.sync.status === "pending" && <span>待同步</span>}
          {task.sync.status === "conflict" && (
            <span className="overdue">同步冲突</span>
          )}
        </span>
      </button>
      <div className="task-actions">
        {moveUp && (
          <button
            type="button"
            className="row-icon-button"
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
            onClick={moveDown}
            aria-label={`下移${task.title}`}
          >
            <ChevronDown size={15} />
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
  search,
  navigationKey,
  notify,
  onNew,
  onClearSearch,
  onAskAgent,
}: {
  route: TaskView;
  controller: TaskController;
  search: string;
  navigationKey: string;
  notify: (
    message: string,
    kind?: ToastKind,
    action?: ToastState["action"],
  ) => void;
  onNew: () => void;
  onClearSearch: () => void;
  onAskAgent: (prompt: string) => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "all">(
    "all",
  );
  const [projectFilter, setProjectFilter] = useState("all");
  const [projectOptions, setProjectOptions] = useState<string[]>([]);
  // A sidebar destination represents a different collection, not a compound
  // search. Secondary filters belong to the current collection so they cannot
  // make the next page look empty while its sidebar count is non-zero.
  useEffect(() => {
    setFilterOpen(false);
    setPriorityFilter("all");
    setProjectFilter("all");
  }, [navigationKey]);
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
          tasks: section.tasks.filter(
            (task) =>
              (priorityFilter === "all" || task.priority === priorityFilter) &&
              (projectFilter === "all" || task.projectId === projectFilter),
          ),
        }))
        .filter((section) => section.tasks.length > 0),
    [controller.sections, priorityFilter, projectFilter],
  );
  useEffect(() => {
    if (!window.desktopApi) {
      setProjectOptions(
        [
          ...new Set(
            controller.tasks
              .map((task) => task.projectId)
              .filter((value): value is string => Boolean(value)),
          ),
        ].sort((a, b) => a.localeCompare(b, "zh-CN")),
      );
      return;
    }
    void window.desktopApi.tasks
      .list({ includeDeleted: false })
      .then((tasks) =>
        setProjectOptions(
          [
            ...new Set(
              tasks
                .map((task) => task.projectId)
                .filter((value): value is string => Boolean(value)),
            ),
          ].sort((a, b) => a.localeCompare(b, "zh-CN")),
        ),
      );
  }, [controller.tasks]);
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
          <button type="button" className="soft-button" onClick={askToReplan}>
            <WandSparkles size={16} />
            重新规划
          </button>
          <div className="filter-anchor">
            <button
              type="button"
              className={`icon-button ${priorityFilter !== "all" || projectFilter !== "all" ? "active" : ""}`}
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
                <div className="filter-options">
                  {(
                    ["all", "urgent", "high", "medium", "low", "none"] as const
                  ).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={priorityFilter === value ? "active" : ""}
                      onClick={() => setPriorityFilter(value)}
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
                    onChange={(event) => setProjectFilter(event.target.value)}
                  >
                    <option value="all">全部项目</option>
                    {projectOptions.map((project) => (
                      <option key={project} value={project}>
                        {project}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="filter-footer">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setPriorityFilter("all");
                      setProjectFilter("all");
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
      {route === "today" && (
        <MorningBrief controller={controller} notify={notify} />
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
                : priorityFilter !== "all" || projectFilter !== "all"
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
                : priorityFilter !== "all" || projectFilter !== "all"
                  ? "调整或清除当前筛选后再看看。"
                  : route === "trash"
                    ? "删除的任务会先保留在这里。"
                    : route === "inbox"
                      ? "这里放尚未安排日期、项目或清单的任务；稍后再决定怎么处理。"
                      : "记录一件下一步要做的小事。"}
            </p>
            {search || priorityFilter !== "all" || projectFilter !== "all" ? (
              <button
                type="button"
                className="soft-button"
                onClick={() => {
                  onClearSearch();
                  setPriorityFilter("all");
                  setProjectFilter("all");
                }}
              >
                {search && (priorityFilter !== "all" || projectFilter !== "all")
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
                  projectFilter === "all";
                return (
                  <TaskRow
                    key={task.id}
                    task={task}
                    selected={controller.selectedId === task.id}
                    controller={controller}
                    notify={notify}
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
    </main>
  );
}

function TaskInspector({
  task,
  controller,
  notify,
  onAskAgent,
  onClose,
}: {
  task?: Task;
  controller: TaskController;
  notify: (message: string, kind?: ToastKind) => void;
  onAskAgent: (prompt: string) => void;
  onClose?: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [projectId, setProjectId] = useState(task?.projectId ?? "");
  const [tagsText, setTagsText] = useState(task?.tags.join(", ") ?? "");
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
        setProjectId(task.projectId ?? "");
      if (!dirtyFieldsRef.current.has("tags"))
        setTagsText(task.tags.join(", "));
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
    setProjectId(task.projectId ?? "");
    setTagsText(task.tags.join(", "));
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
    task?.reminders,
    task?.startAt,
    task?.startAtIsAllDay,
    task?.tags,
    task?.title,
    task?.updatedAt,
    task?.dueAtIsAllDay,
  ]);
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
      plannedDate: task.plannedDate,
      startAt: task.startAt,
      dueAt: task.dueAt,
      estimatedMinutes: task.estimatedMinutes,
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
    await controller.create({
      title: nextTitle,
      source: { type: "local" },
      parentId: task.id,
      projectId: task.projectId,
      plannedDate: task.plannedDate,
      priority: task.priority,
    });
    setSubtaskTitle("");
    const items = await window.desktopApi?.tasks.list({
      includeDeleted: false,
    });
    if (items) setRelatedTasks(items);
    notify("本地子任务已创建", "success");
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
            className={`status-pill ${task.sync.status === "conflict" ? "warning" : task.sync.status === "synced" ? "success" : ""}`}
          >
            <CircleDot size={14} />
            {task.status === "completed"
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
              value={projectId}
              onChange={(event) => {
                markDirty("projectId");
                setProjectId(event.target.value);
              }}
              onBlur={() => {
                if (!dirtyFieldsRef.current.has("projectId")) return;
                const revision = currentDirtyRevision("projectId");
                const next = projectId.trim();
                void save({ projectId: next || null }).then((saved) => {
                  if (saved) clearDirtyIfCurrent("projectId", revision);
                });
              }}
              placeholder="未归类"
            />
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
            子任务 <span className="section-count">{subtasks.length}</span>
          </h3>
          <div className="subtask-list">
            {subtasks.map((subtask) => (
              <div className="subtask-row" key={subtask.id}>
                <input
                  className="task-checkbox"
                  type="checkbox"
                  checked={subtask.status === "completed"}
                  onChange={() => void controller.toggleComplete(subtask)}
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
    </>
  );
}

function NewTaskSheet({
  onClose,
  controller,
  notify,
}: {
  onClose: () => void;
  controller: TaskController;
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
  const [tags, setTags] = useState("");
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
        projectId: projectId.trim() || undefined,
        tags: [
          ...new Set(
            tags
              .split(/[,，]/u)
              .map((tag) => tag.trim())
              .filter(Boolean),
          ),
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
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              placeholder="未归类"
            />
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
  const statusLabel =
    status?.state === "connected"
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
            className={`status-pill ${status?.connected ? "success" : status?.lastError ? "warning" : ""}`}
          >
            {status?.connected ? <CloudCheck size={15} /> : <Cloud size={15} />}
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

function SettingsPage({
  notify,
}: {
  notify: (message: string, kind?: ToastKind) => void;
}) {
  const [section, setSection] = useState<SettingsSection>("general");
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultSettings);
  const [apiKey, setApiKey] = useState("");
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
  const [saving, setSaving] = useState(false);
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
          </section>
        )}
        {section === "floating" && (
          <section className="settings-section">
            <h1>Todo Pet 与桌面</h1>
            <p>桌面宠物、随身面板和主应用保持同一任务语境。</p>
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
                  (appSettings.ai.authMode !== "none" &&
                    !appSettings.ai.credentialId) ||
                  !appSettings.ai.model.trim()
                }
                onClick={() => void testModelConnection()}
              >
                <RefreshCw size={15} />
                测试连接
              </button>
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
                <p>默认隐去私人备注、草稿、位置与所有凭据引用</p>
              </div>
              <button
                type="button"
                className="soft-button"
                disabled={saving}
                onClick={() => void exportData()}
              >
                <Download size={15} />
                安全导出
              </button>
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
  const sidebarCounts = useSidebarCounts();
  const [newTask, setNewTask] = useState(false);
  const [activeReminder, setActiveReminder] = useState<ReminderDelivery>();
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const toastRouteRef = useRef(route);
  const [onboarding, setOnboarding] = useState(
    () => localStorage.getItem("todo-agent:onboarding-complete") !== "true",
  );
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
  }, [navigateFromSidebar, navigateTaskCollection]);
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
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const isBackShortcut = isMacPlatform()
        ? event.metaKey && event.key === "["
        : event.altKey && event.key === "ArrowLeft";
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
        if (!isTaskRoute) {
          navigateTaskCollection("all");
        }
        window.setTimeout(
          () =>
            document
              .querySelector<HTMLInputElement>("[data-search-input]")
              ?.focus(),
          0,
        );
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
  }, [goBack, isTaskRoute, navigateTaskCollection]);
  const syncState = controller.tasks.some(
    (task) => task.sync.status === "conflict",
  )
    ? "conflict"
    : controller.tasks.some((task) =>
          ["pending", "offline", "syncing"].includes(task.sync.status),
        )
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
    >
      <div className="app-window">
        <Titlebar
          search={isTaskRoute ? search : undefined}
          onSearch={isTaskRoute ? setSearch : undefined}
          onNew={() => setNewTask(true)}
          onHome={() => navigateTaskCollection("today")}
          onBack={route === "today" ? undefined : goBack}
          syncState={syncState}
        />
        <div className="shell-grid" data-route={route}>
          <Sidebar
            route={route}
            sourceFilter={sourceFilter}
            counts={sidebarCounts}
            onRoute={navigateFromSidebar}
            onSource={showSource}
          />
          {isTaskRoute && (
            <>
              <TaskListPage
                route={taskView}
                controller={controller}
                search={search}
                navigationKey={`${taskView}:${sourceFilter ?? "all"}:${taskCollectionEpoch}`}
                notify={notify}
                onNew={() => setNewTask(true)}
                onClearSearch={() => setSearch("")}
                onAskAgent={askAgent}
              />
              <TaskInspector
                task={controller.selected}
                controller={controller}
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
            notify={notify}
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
      .replace(/并?提前.*?提醒/gu, "")
      .replace(/[，,。]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim() || text.trim();
  return { source, date, title };
}

function QuickCaptureWindow() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [captureError, setCaptureError] = useState("");
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
          priority: parsed.priority,
          chips: parsed.chips,
          needsReview: parsed.needsReview,
        }
      : {
          ...fallbackFields,
          project: undefined,
          tags: [],
          priority: 1 as const,
          chips: [],
          needsReview: false,
        };
  const controller = useTaskController("inbox", "");
  const inputRef = useRef<HTMLInputElement>(null);
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
      const feishu =
        source === "feishu"
          ? await window.desktopApi?.feishu.status()
          : undefined;
      const blockedFeishuMessage = feishuCreationBlockedMessage(source, feishu);
      if (blockedFeishuMessage) throw new Error(blockedFeishuMessage);
      const priorities: TaskPriority[] = ["low", "medium", "high", "urgent"];
      const result = await controller.create({
        title: fields.title,
        source:
          source === "feishu"
            ? { type: "feishu", accountId: feishu?.accountId }
            : { type: "local" },
        plannedDate:
          fields.privatePlanAt?.slice(0, 10) ??
          (!fields.dueAt ? fields.date : undefined),
        dueAt: fields.dueAt,
        projectId: fields.project,
        tags: fields.tags,
        priority: priorities[fields.priority] ?? "medium",
        reminders: fields.reminderAt
          ? [
              {
                id: crypto.randomUUID(),
                at: fields.reminderAt,
                enabled: true,
                source: "local",
              },
            ]
          : [],
        sync: source === "feishu" ? { status: "pending" } : { status: "local" },
      });
      await window.desktopApi?.tasks.deleteDraft("quick-capture");
      setText("");
      if (openAfterSave) {
        await window.desktopApi?.shell.showMain(
          result?.task.id ? `task:${result.task.id}` : "today",
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
  return (
    <div className="quick-shell">
      <div className="quick-panel">
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
                </small>
              </div>
              <SourcePill source={fields.source} />
            </div>
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
            {fields.source === "feishu"
              ? "将创建到飞书；私人计划仍只保存在本地"
              : "只保存在当前设备"}
          </span>
          <span className="footer-spacer" />
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
        </div>
      </div>
    </div>
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
  const compactActivateTimerRef = useRef<number | undefined>(undefined);
  const contextMenuReturnExpandedRef = useRef(false);
  const hoverExpandDelayMsRef = useRef(
    defaultSettings.floating.hoverExpandDelayMs,
  );
  const floatingSettingsLoadedRef = useRef(false);
  const hoveringFloatingRef = useRef(false);
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
  const [isFloatingHovered, setIsFloatingHovered] = useState(false);
  const [tab, setTab] = useState<PetTab>(readFloatingTab);
  const [input, setInput] = useState("");
  const [creatingFloatingTask, setCreatingFloatingTask] = useState(false);
  const floatingCreateRef = useRef(false);
  const [activity, setActivity] = useState<AuditRecord[]>([]);
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatusView>();
  const [now, setNow] = useState(Date.now());
  const miniContentRef = useRef<HTMLDivElement>(null);
  const chatFollowsOutputRef = useRef(true);
  const focusedTask = todayController.tasks.find(
    (task) => task.focusStartedAt,
  );
  const carousel = useFloatingTodayCarousel(
    todayController.tasks,
    focusedTask,
    isFloatingHovered || expanded || contextMenuOpen || privacyMode,
  );
  // The compact completion action follows the visible title. A rotating task
  // bubble must never complete a different, hidden task.
  const current = carousel.task;
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
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
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
      if (compactActivateTimerRef.current !== undefined) {
        window.clearTimeout(compactActivateTimerRef.current);
      }
      contextMenuReturnExpandedRef.current = false;
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
      floatingSettingsLoadedRef.current = true;
      setTab(settings.floating.selectedTab);
      setPrivacyMode(settings.floating.privacyMode);
      setFloatingLocked(settings.floating.locked);
      // Settings load asynchronously on every floating renderer. If the
      // pointer entered before that read completed (or the delay is edited
      // while the pointer is still there), the old timer must not win.
      if (
        delayChanged &&
        hoverExpandTimerRef.current !== undefined
      ) {
        window.clearTimeout(hoverExpandTimerRef.current);
        hoverExpandTimerRef.current = undefined;
        if (hoveringFloatingRef.current) scheduleHoverExpand();
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
        await todayController.create({
          title: text,
          plannedDate: dateKey(),
          source: { type: "local" },
        });
        setInput("");
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
    if (hoverExpandTimerRef.current !== undefined) {
      window.clearTimeout(hoverExpandTimerRef.current);
      hoverExpandTimerRef.current = undefined;
    }
    if (compactActivateTimerRef.current !== undefined) {
      window.clearTimeout(compactActivateTimerRef.current);
      compactActivateTimerRef.current = undefined;
    }
    if (!value) {
      setContextMenuOpen(false);
      contextMenuReturnExpandedRef.current = false;
    }
    expandTriggerRef.current = value ? trigger : undefined;
    setExpanded(value);
    void window.desktopApi?.shell.setFloatingExpanded(value);
  }
  function closeFloatingContextMenu(): void {
    const returnToExpandedPanel = contextMenuReturnExpandedRef.current;
    contextMenuReturnExpandedRef.current = false;
    setContextMenuOpen(false);
    if (!returnToExpandedPanel) setPanelExpanded(false);
  }
  function openFloatingContextMenu(
    event: ReactMouseEvent<HTMLElement>,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    contextMenuReturnExpandedRef.current = expanded;
    setContextMenuOpen(true);
    if (!expanded) setPanelExpanded(true, "click");
  }
  function showMainFromFloatingMenu(route: MainRoute): void {
    contextMenuReturnExpandedRef.current = false;
    setContextMenuOpen(false);
    setPanelExpanded(false);
    void window.desktopApi?.shell.showMain(route);
  }
  function showQuickCaptureFromFloatingMenu(): void {
    contextMenuReturnExpandedRef.current = false;
    setContextMenuOpen(false);
    setPanelExpanded(false);
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
            ? "settings"
            : "all";
    void window.desktopApi?.shell.showMain(route);
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
    if (expanded || hoverExpandTimerRef.current !== undefined) return;
    hoverExpandTimerRef.current = window.setTimeout(() => {
      hoverExpandTimerRef.current = undefined;
      if (!hoveringFloatingRef.current) return;
      setPanelExpanded(true, "hover");
    }, hoverExpandDelayMsRef.current);
  }
  const beginHoverExpand = () => {
    hoveringFloatingRef.current = true;
    setIsFloatingHovered(true);
    scheduleHoverExpand();
  };
  const cancelHoverExpand = () => {
    if (hoverExpandTimerRef.current === undefined) return;
    window.clearTimeout(hoverExpandTimerRef.current);
    hoverExpandTimerRef.current = undefined;
  };
  const endHoverInteraction = () => {
    hoveringFloatingRef.current = false;
    setIsFloatingHovered(false);
    cancelHoverExpand();
    if (expandTriggerRef.current === "hover") {
      setPanelExpanded(false);
    }
  };
  const syncLabel = feishuStatus?.connected
    ? feishuStatus.state === "syncing"
      ? "飞书正在同步"
      : `飞书已连接${feishuStatus.lastSyncAt ? ` · ${formatDateTime(feishuStatus.lastSyncAt)}` : ""}`
    : feishuStatus?.configured
      ? "飞书等待重新连接"
      : "飞书未连接 · 本地任务正常";
  const overdueCount = todayController.tasks.filter(
    (task) =>
      task.status === "open" &&
      Boolean(task.dueAt && task.dueAt.slice(0, 10) < dateKey()),
  ).length;
  const petMood: PetMood = current?.focusStartedAt
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
      className={`floating-shell pet-shell ${expanded ? "is-expanded" : "is-compact"} ${privacyMode ? "privacy-mode" : ""} ${floatingLocked ? "position-locked" : ""} ${current?.focusStartedAt ? "focus-mode" : ""}`}
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
        onMouseOut={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
            endHoverInteraction();
          }
        }}
      >
        <div
          // The pet and its task bubble form one native drag surface. Buttons
          // opt out so task controls and panel expansion remain clickable.
          className="pet-compact drag-region"
          onContextMenu={openFloatingContextMenu}
        >
          <span
            className="floating-drag-handle drag-region"
            title={floatingLocked ? "位置已锁定" : "拖动移动"}
            aria-hidden="true"
          >
            <GripVertical size={15} />
          </span>
          <button
            type="button"
            className="pet-avatar-button floating-expand-trigger no-drag"
            aria-label={`与${petName}互动`}
            aria-expanded={expanded}
            title={
              expanded
                ? "点击收起"
                : `停留 ${hoverExpandDelayMs / 1000} 秒或单击展开 · 双击打开主窗口`
            }
            onClick={(event) => {
              if (expanded) {
                setPanelExpanded(false, "click");
                return;
              }
              handleCompactActivate(event);
            }}
          >
            <PetCharacter
              mood={petMood}
              name={petName}
              scalePercent={expanded ? 100 : scalePercent}
              compact
            />
          </button>
          <button
            type="button"
            className="pet-task-bubble floating-summary no-drag"
            aria-label={expanded ? `收起 ${petName}` : `展开 ${petName}`}
            aria-expanded={expanded}
            title={
              expanded
                ? "点击收起"
                : `停留 ${hoverExpandDelayMs / 1000} 秒或单击展开 · 双击打开主窗口`
            }
            onClick={(event) => {
              if (expanded) {
                setPanelExpanded(false, "click");
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
                  ? `${current.focusStartedAt ? `${petName}陪你专注` : `${petName}提醒你`} · ${current.source.type === "feishu" ? "飞书" : "本地"}${privacyMode ? " · 隐私模式" : ""}`
                  : `${petName}说：今天可以轻松一点`}
              </small>
            </div>
            <span className="focus-time">
              {current ? humanDuration(elapsed) : "✓"}
            </span>
          </button>
          {current && (
            <button
              type="button"
              className="icon-button pet-complete-button no-drag"
              disabled={!canToggleTaskCompletion(current)}
              aria-label={
                privacyMode ? "完成当前私人任务" : `完成${current.title}`
              }
              onClick={() => void todayController.toggleComplete(current)}
            >
              <Check size={17} />
            </button>
          )}
        </div>
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
        {expanded && !contextMenuOpen && (
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
              {isTaskTab &&
                displayedTaskController.tasks.map((task) => (
                  <div className="mini-task" key={task.id}>
                    <input
                      className="task-checkbox"
                      type="checkbox"
                      checked={task.status === "completed"}
                      disabled={!canToggleTaskCompletion(task)}
                      onChange={() =>
                        void displayedTaskController.toggleComplete(task)
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
                    mood={current?.focusStartedAt ? "focus" : "idle"}
                    name={petName}
                  />
                  <p className="pet-focus-kicker">
                    {current?.focusStartedAt ? `${petName}正在陪你` : "选择下一件要专心的事"}
                  </p>
                  <strong className="pet-focus-timer">
                    {current ? humanDuration(elapsed) : "00:00"}
                  </strong>
                  <p className="pet-focus-task">
                    {current ? titleFor(current) : "今天没有待办，可以安心休息"}
                  </p>
                  {current && (
                    <div className="pet-focus-actions">
                      <button
                        type="button"
                        className="soft-button"
                        onClick={() => void todayController.resetFocus(current.id)}
                      >
                        <RotateCcw size={15} />
                        重置
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() =>
                          void (current.focusStartedAt
                            ? todayController.pauseFocus(current.id)
                            : todayController.startFocus(current.id))
                        }
                      >
                        {current.focusStartedAt ? (
                          <Pause size={16} />
                        ) : (
                          <Play size={16} />
                        )}
                        {current.focusStartedAt ? "暂停" : "开始专注"}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {tab === "home" && (
                <div className="pet-home-view">
                  <div className="pet-home-hero">
                    <PetCharacter mood={petMood} name={petName} />
                    <div>
                      <span>Todo Pet</span>
                      <h3>{petName}的小窝</h3>
                      <p>
                        今天还有 {todayController.tasks.length} 项，逾期 {overdueCount} 项。
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
                    onClick={() => showMainFromFloatingMenu("settings")}
                  >
                    <Settings size={16} />
                    打开 Todo Pet 设置
                  </button>
                </div>
              )}
            </div>
            {(isTaskTab || tab === "chat") && !privacyMode && (
              <div className="mini-composer">
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
                    placeholder="新增一个本地任务…"
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
