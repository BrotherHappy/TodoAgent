import {
  AlertTriangle,
  CalendarClock,
  CalendarCheck2,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  DEFAULT_DAILY_PLAN_CONSTRAINTS,
  suggestDailyPlan,
  type DailyPlanItem,
} from "../shared/daily-planner";
import { buildDailySchedule } from "../shared/daily-schedule";
import {
  buildMultiDaySchedule,
  type MultiDayScheduleUnscheduledReason,
} from "../shared/multi-day-schedule";
import type {
  ApplyTodayPlanRequest,
  Task,
  TaskId,
} from "../shared/models";

const CAPACITY_OPTIONS = [60, 120, 240, 360] as const;
const STANDARD_ESTIMATES = [15, 30, 45, 60, 90, 120] as const;

type DailyPlanMode = "conservative" | "balanced" | "sprint";

const PLAN_MODES: ReadonlyArray<{
  id: DailyPlanMode;
  label: string;
  description: string;
  capacityRatio: number;
}> = [
  { id: "conservative", label: "保守计划", description: "留出约 25% 缓冲", capacityRatio: 0.75 },
  { id: "balanced", label: "平衡计划", description: "按可用时间安排", capacityRatio: 1 },
  { id: "sprint", label: "冲刺计划", description: "允许多安排约 10%", capacityRatio: 1.1 },
];

interface AppliedPlan {
  operationId?: string;
  tasks: Task[];
  totalMinutes: number;
  approximate: boolean;
}

export interface DailyPlanSheetProps {
  tasks: Task[];
  date: string;
  loading: boolean;
  error?: string;
  onRetry: () => void | Promise<void>;
  onClose: () => void;
  onApply: (request: ApplyTodayPlanRequest) => Promise<string | undefined>;
  onUndo: (operationId: string) => Promise<void>;
  onStartFirst: (task: Task) => Promise<void>;
  onAskAgent: (prompt: string) => void;
  /** Defaults to 今天; callers can open the same review for 明天 or a date. */
  targetLabel?: string;
  /** Optional values collected by the morning kickoff flow. */
  initialCapacityMinutes?: number;
  initialTaskIds?: TaskId[];
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} 分钟`;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function dateLabel(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

function estimateOptions(value: number): number[] {
  return [...new Set([value, ...STANDARD_ESTIMATES])].sort((a, b) => a - b);
}

function sourceLabel(task: Task): string {
  return task.source.type === "feishu" ? "飞书" : "本地";
}

function clockMinutes(value: string, fallback: number): number {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const result = hours * 60 + minutes;
  return hours <= 23 && minutes <= 59 ? result : fallback;
}

function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function multiDayReasonLabel(reason: MultiDayScheduleUnscheduledReason): string {
  if (reason === "past-deadline") return "截止日期限制";
  if (reason === "horizon") return "超出预览范围";
  return "工作日无空档";
}

export function DailyPlanSheet({
  tasks,
  date,
  loading,
  error,
  onRetry,
  onClose,
  onApply,
  onUndo,
  onStartFirst,
  onAskAgent,
  targetLabel,
  initialCapacityMinutes,
  initialTaskIds,
}: DailyPlanSheetProps) {
  const targetName = targetLabel?.trim() || "今天";
  // Keep the established Chinese noun in accessible labels and action copy
  // while allowing the sheet to be reused for 明天/other dates.
  const targetNoun = targetName === "今天" ? "今日" : targetName;
  const [capacityMinutes, setCapacityMinutes] = useState(
    initialCapacityMinutes ?? 240,
  );
  const [planMode, setPlanMode] = useState<DailyPlanMode>("balanced");
  const [availableStart, setAvailableStart] = useState(
    formatClock(DEFAULT_DAILY_PLAN_CONSTRAINTS.availableStartMinutes),
  );
  const [availableEnd, setAvailableEnd] = useState(
    formatClock(DEFAULT_DAILY_PLAN_CONSTRAINTS.availableEndMinutes),
  );
  const [bufferMinutes, setBufferMinutes] = useState(
    DEFAULT_DAILY_PLAN_CONSTRAINTS.bufferMinutes,
  );
  const [minimumBlockMinutes, setMinimumBlockMinutes] = useState(
    DEFAULT_DAILY_PLAN_CONSTRAINTS.minimumBlockMinutes,
  );
  const [selectedIds, setSelectedIds] = useState<TaskId[]>(
    () => initialTaskIds ?? [],
  );
  const [durationOverrides, setDurationOverrides] = useState<
    Record<TaskId, number>
  >({});
  const [query, setQuery] = useState("");
  const [showAllCandidates, setShowAllCandidates] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    "apply" | "undo" | "start"
  >();
  const saving = pendingAction !== undefined;
  const [saveError, setSaveError] = useState<string>();
  const [applied, setApplied] = useState<AppliedPlan>();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const successActionRef = useRef<HTMLButtonElement>(null);
  const savingRef = useRef(saving);
  const onCloseRef = useRef(onClose);
  const wasAppliedRef = useRef(false);
  const initialSelectionRef = useRef<TaskId[] | undefined>(initialTaskIds);

  const activePlanMode =
    PLAN_MODES.find((mode) => mode.id === planMode) ?? PLAN_MODES[1];
  const planningCapacityMinutes = Math.max(
    0,
    Math.round((capacityMinutes * activePlanMode.capacityRatio) / 5) * 5,
  );
  const plannerConstraints = useMemo(
    () => {
      const start = clockMinutes(
        availableStart,
        DEFAULT_DAILY_PLAN_CONSTRAINTS.availableStartMinutes,
      );
      const rawEnd = clockMinutes(
        availableEnd,
        DEFAULT_DAILY_PLAN_CONSTRAINTS.availableEndMinutes,
      );
      return {
        availableStartMinutes:
          rawEnd > start ? start : DEFAULT_DAILY_PLAN_CONSTRAINTS.availableStartMinutes,
        availableEndMinutes:
          rawEnd > start ? rawEnd : DEFAULT_DAILY_PLAN_CONSTRAINTS.availableEndMinutes,
        bufferMinutes,
        minimumBlockMinutes,
      };
    },
    [availableEnd, availableStart, bufferMinutes, minimumBlockMinutes],
  );

  const suggestion = useMemo(
    () =>
      suggestDailyPlan(tasks, {
        date,
        capacityMinutes: planningCapacityMinutes,
        defaultEstimateMinutes: 30,
        maxSuggestedItems: 7,
        constraints: plannerConstraints,
      }),
    [date, plannerConstraints, planningCapacityMinutes, tasks],
  );
  const itemById = useMemo(
    () => new Map(suggestion.items.map((item) => [item.task.id, item])),
    [suggestion.items],
  );

  const resetToSuggestion = useCallback(() => {
    setSelectedIds(suggestion.selectedItems.map((item) => item.task.id));
    setDurationOverrides({});
    setSaveError(undefined);
  }, [suggestion.selectedItems]);

  useEffect(() => {
    if (applied) return;
    // A morning kickoff can intentionally seed an empty selection as well as
    // a few priorities. Preserve that one-time choice on mount; later
    // planner changes can still use the normal reset-to-suggestion action.
    if (initialSelectionRef.current !== undefined) {
      const requiredIds = suggestion.selectedItems
        .filter((item) => item.isFixed || item.isRetained)
        .map((item) => item.task.id);
      const seededIds = [
        ...requiredIds,
        ...initialSelectionRef.current,
      ].filter((id, index, ids) => ids.indexOf(id) === index && itemById.has(id));
      setSelectedIds(seededIds);
      initialSelectionRef.current = undefined;
      setDurationOverrides({});
      setSaveError(undefined);
      return;
    }
    resetToSuggestion();
  }, [applied, itemById, resetToSuggestion, suggestion.selectedItems]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          !element.hidden &&
          !element.closest("[inert]") &&
          element.getAttribute("aria-hidden") !== "true",
      );
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !dialog.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    if (applied) {
      wasAppliedRef.current = true;
      if (!saving) successActionRef.current?.focus();
      return;
    }
    if (wasAppliedRef.current && !saving) {
      wasAppliedRef.current = false;
      closeButtonRef.current?.focus();
    }
  }, [applied, saving]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const active = document.activeElement;
    if (dialog.contains(active) && active !== dialog) return;
    if (saving) {
      dialog.focus();
    } else if (applied) {
      successActionRef.current?.focus();
    } else {
      closeButtonRef.current?.focus();
    }
  }, [applied, error, loading, saving]);

  const selectedItems = selectedIds
    .map((id) => itemById.get(id))
    .filter((item): item is DailyPlanItem => Boolean(item));
  const selectedSet = new Set(selectedIds);
  const clearTaskIds = suggestion.items
    .filter((item) => item.isRetained && !selectedSet.has(item.task.id))
    .map((item) => item.task.id);
  const selectedPlanChanged = selectedItems.some(
    (item, index) =>
      item.task.plannedDate !== date ||
      item.task.privateOrder !== index ||
      (durationOverrides[item.task.id] !== undefined &&
        durationOverrides[item.task.id] !== item.task.estimatedMinutes),
  );
  const canApply = clearTaskIds.length > 0 || selectedPlanChanged;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const allCandidates = suggestion.items.filter((item) => {
    if (selectedSet.has(item.task.id)) return false;
    if (!normalizedQuery) return true;
    return `${item.task.title} ${item.task.projectId ?? ""} ${item.task.tags.join(" ")}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
  const visibleCandidates =
    showAllCandidates || normalizedQuery
      ? allCandidates
      : allCandidates.slice(0, 8);

  const durationFor = (item: DailyPlanItem): number =>
    durationOverrides[item.task.id] ?? item.estimatedMinutes;
  const totalMinutes = selectedItems.reduce(
    (total, item) => total + durationFor(item),
    0,
  );
  const assumedCount = selectedItems.filter(
    (item) =>
      item.isEstimateDefault && durationOverrides[item.task.id] === undefined,
  ).length;
  const overloadMinutes = Math.max(
    0,
    totalMinutes - suggestion.effectiveCapacityMinutes,
  );
  const schedulePreview = useMemo(
    () =>
      buildDailySchedule(
        selectedItems.map((item) => ({
          task: item.task,
          estimatedMinutes: durationFor(item),
        })),
        {
          date,
          availableStartMinutes: plannerConstraints.availableStartMinutes,
          availableEndMinutes: plannerConstraints.availableEndMinutes,
          bufferMinutes: plannerConstraints.bufferMinutes,
        },
      ),
    [date, durationOverrides, plannerConstraints, selectedItems],
  );
  const multiDayPreview = useMemo(
    () =>
      buildMultiDaySchedule(
        selectedItems.map((item) => ({
          task: item.task,
          estimatedMinutes: durationFor(item),
        })),
        {
          startDate: date,
          availableStartMinutes: plannerConstraints.availableStartMinutes,
          availableEndMinutes: plannerConstraints.availableEndMinutes,
          bufferMinutes: plannerConstraints.bufferMinutes,
          maxWorkdays: 5,
          workdaysOnly: true,
        },
      ),
    [date, durationOverrides, plannerConstraints, selectedItems],
  );

  const removeItem = (item: DailyPlanItem) => {
    if (item.isFixed) return;
    setSelectedIds((current) => current.filter((id) => id !== item.task.id));
  };
  const addItem = (item: DailyPlanItem) => {
    setSelectedIds((current) =>
      current.includes(item.task.id) ? current : [...current, item.task.id],
    );
  };
  const moveItem = (id: TaskId, direction: -1 | 1) => {
    setSelectedIds((current) => {
      const index = current.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const applyPlan = async () => {
    if (!canApply || saving) return;
    setPendingAction("apply");
    setSaveError(undefined);
    const request: ApplyTodayPlanRequest = {
      date,
      items: selectedItems.map((item) => ({
        id: item.task.id,
        estimatedMinutes:
          durationOverrides[item.task.id] ??
          (typeof item.task.estimatedMinutes === "number" &&
          Number.isInteger(item.task.estimatedMinutes) &&
          item.task.estimatedMinutes >= 5 &&
          item.task.estimatedMinutes <= 720
            ? item.task.estimatedMinutes
            : undefined),
      })),
      clearTaskIds,
      baselines: [...new Set([...selectedIds, ...clearTaskIds])].map((id) => {
        const task = itemById.get(id)!.task;
        return {
          id,
          plannedDate: task.plannedDate,
          privateOrder: task.privateOrder,
          estimatedMinutes: task.estimatedMinutes,
        };
      }),
    };
    try {
      const operationId = await onApply(request);
      setApplied({
        operationId,
        tasks: selectedItems.map((item) => item.task),
        totalMinutes,
        approximate: assumedCount > 0,
      });
    } catch (reason) {
      setSaveError(
        reason instanceof Error ? reason.message : `暂时无法应用${targetNoun}计划`,
      );
    } finally {
      setPendingAction(undefined);
    }
  };

  const undoAppliedPlan = async () => {
    if (!applied?.operationId || saving) return;
    setPendingAction("undo");
    setSaveError(undefined);
    try {
      await onUndo(applied.operationId);
      setApplied(undefined);
    } catch (reason) {
      setSaveError(
        reason instanceof Error ? reason.message : `暂时无法撤销${targetNoun}计划`,
      );
    } finally {
      setPendingAction(undefined);
    }
  };

  const startFirstTask = async (task: Task) => {
    if (saving) return;
    setPendingAction("start");
    setSaveError(undefined);
    try {
      await onStartFirst(task);
    } catch (reason) {
      setSaveError(
        reason instanceof Error ? reason.message : "暂时无法开始这项任务",
      );
    } finally {
      setPendingAction(undefined);
    }
  };

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !saving) onClose();
  };

  if (applied) {
    const first = applied.tasks[0];
    const taskNames = applied.tasks
      .slice(0, 8)
      .map((task, index) => `${index + 1}. ${task.title}`)
      .join("\n");
    return (
      <div className="modal-backdrop daily-plan-backdrop" onMouseDown={closeFromBackdrop}>
        <section
          ref={dialogRef}
          className="modal-sheet daily-plan-sheet is-complete"
          role="dialog"
          aria-modal="true"
          aria-labelledby="daily-plan-complete-title"
          aria-busy={saving}
          tabIndex={-1}
        >
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button daily-plan-close"
            aria-label={`关闭${targetNoun}规划`}
            disabled={saving}
            onClick={onClose}
          >
            <X size={18} />
          </button>
          <div className="daily-plan-complete-mark">
            <CalendarCheck2 size={30} />
          </div>
          <div className="daily-plan-complete-copy">
            <span>计划已经放稳</span>
            <h2 id="daily-plan-complete-title">
              {applied.tasks.length
                ? `${targetName}先守住这 ${applied.tasks.length} 件事`
                : `${targetName}已经留白`}
            </h2>
            {applied.tasks.length ? (
              <p>
                {applied.approximate ? "约 " : ""}
                {formatMinutes(applied.totalMinutes)}。先开始第一项，变化出现时再调整。
              </p>
            ) : (
              <p>已移出原有安排。留出空间也是一种明确的计划。</p>
            )}
          </div>
          {first && (
            <div className="daily-plan-first-task">
              <span>下一步</span>
              <strong>{first.title}</strong>
              <small>{sourceLabel(first)}</small>
            </div>
          )}
          {saveError && (
            <p className="daily-plan-inline-error" role="alert">
              {saveError}
            </p>
          )}
          <div className="daily-plan-complete-actions">
            {first && (
              <button
                ref={successActionRef}
                type="button"
                className="primary-button"
                disabled={saving}
                onClick={() => void startFirstTask(first)}
              >
                {pendingAction === "start" ? (
                  <RefreshCw size={16} className="is-spinning" />
                ) : (
                  <Clock3 size={16} />
                )}
                {pendingAction === "start" ? "正在开始…" : "开始第一项"}
              </button>
            )}
            {first && (
              <button
                type="button"
                className="soft-button"
                disabled={saving}
                onClick={() =>
                  onAskAgent(
                    `请把我已经确认的${targetName}任务安排成可执行的时间块。按${activePlanMode.label}，可用时间约 ${formatMinutes(planningCapacityMinutes)}。先展示方案，不要直接修改任务或日历。\n${taskNames}`,
                  )
                }
              >
                <Sparkles size={16} />
                让 Agent 排时间
              </button>
            )}
            {applied.operationId && (
              <button
                type="button"
                className="ghost-button"
                disabled={saving}
                onClick={() => void undoAppliedPlan()}
              >
                {pendingAction === "undo" ? (
                  <RefreshCw size={15} className="is-spinning" />
                ) : (
                  <RotateCcw size={15} />
                )}
                {pendingAction === "undo" ? "正在撤销…" : "撤销计划"}
              </button>
            )}
            <button
              ref={first ? undefined : successActionRef}
              type="button"
              className={first ? "ghost-button" : "primary-button"}
              disabled={saving}
              onClick={onClose}
            >
              {first ? "稍后开始" : "完成"}
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="modal-backdrop daily-plan-backdrop" onMouseDown={closeFromBackdrop}>
      <section
        ref={dialogRef}
        className="modal-sheet daily-plan-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="daily-plan-title"
        aria-busy={saving}
        tabIndex={-1}
      >
        <header className="daily-plan-header">
          <div className="daily-plan-heading-mark" aria-hidden="true">
            <CalendarCheck2 size={22} />
          </div>
          <div>
            <span>{dateLabel(date)}</span>
            <h2 id="daily-plan-title">
              {targetName === "今天" ? "一起排今天" : `安排${targetName}`}
            </h2>
            <p>先保留必须面对的事，再按优先级和可用时间补齐。</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button daily-plan-close"
            aria-label={`关闭${targetNoun}规划`}
            disabled={saving}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        {loading ? (
          <div className="daily-plan-state" aria-live="polite">
            <RefreshCw size={24} className="is-spinning" />
            <strong>正在整理全部任务</strong>
            <p>我会先检查截止时间、优先级和未完成依赖。</p>
          </div>
        ) : error ? (
          <div className="daily-plan-state is-error" role="alert">
            <AlertTriangle size={26} />
            <strong>暂时无法生成建议</strong>
            <p>{error}</p>
            <button type="button" className="soft-button" onClick={() => void onRetry()}>
              <RefreshCw size={15} />
              重试
            </button>
          </div>
        ) : suggestion.items.length === 0 ? (
          <div className="daily-plan-state">
            <CalendarCheck2 size={28} />
            <strong>{targetName}没有待安排任务</strong>
            <p>全部清空很好。也可以先休息，等下一件事出现。</p>
            <button type="button" className="primary-button" onClick={onClose}>
              好的
            </button>
          </div>
        ) : (
          <>
            <div
              className="daily-plan-editor"
              inert={saving ? true : undefined}
              aria-disabled={saving}
            >
              <div className="daily-plan-capacity">
              <div>
                <span>{targetName}还能投入多少时间？</span>
                <strong>
                  {assumedCount ? "约 " : ""}
                  {formatMinutes(totalMinutes)} 已安排
                </strong>
              </div>
              <div className="daily-plan-capacity-options" aria-label={`${targetNoun}可用时间`}>
                {CAPACITY_OPTIONS.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className={capacityMinutes === minutes ? "active" : ""}
                    aria-pressed={capacityMinutes === minutes}
                    onClick={() => setCapacityMinutes(minutes)}
                  >
                    {minutes < 60 ? `${minutes} 分` : `${minutes / 60} 小时`}
                  </button>
                ))}
              </div>
              <div className="daily-plan-mode-options" aria-label="今日计划策略">
                {PLAN_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    className={planMode === mode.id ? "active" : ""}
                    aria-pressed={planMode === mode.id}
                    title={mode.description}
                    onClick={() => setPlanMode(mode.id)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <div className="daily-plan-constraint-controls" aria-label="排程约束">
                <label>
                  <span>可用时段</span>
                  <input
                    type="time"
                    aria-label="可用时段开始"
                    value={availableStart}
                    onChange={(event) => setAvailableStart(event.target.value)}
                  />
                  <span aria-hidden="true">—</span>
                  <input
                    type="time"
                    aria-label="可用时段结束"
                    value={availableEnd}
                    onChange={(event) => setAvailableEnd(event.target.value)}
                  />
                </label>
                <label>
                  <span>缓冲</span>
                  <select
                    aria-label="排程缓冲时间"
                    value={bufferMinutes}
                    onChange={(event) => setBufferMinutes(Number(event.target.value))}
                  >
                    {[0, 15, 30, 45, 60].map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {minutes === 0 ? "不留缓冲" : `${minutes} 分钟`}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>最小连续块</span>
                  <select
                    aria-label="最小连续时间块"
                    value={minimumBlockMinutes}
                    onChange={(event) => setMinimumBlockMinutes(Number(event.target.value))}
                  >
                    {[5, 15, 30, 45, 60].map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {minutes} 分钟
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div
                className={`daily-plan-capacity-note ${overloadMinutes ? "is-over" : ""}`}
                role={overloadMinutes ? "alert" : "status"}
              >
                {overloadMinutes
                  ? `已超过${activePlanMode.label}容量约 ${formatMinutes(overloadMinutes)}。必须事项不会被隐藏。`
                  : `${activePlanMode.description}，可用时段 ${availableStart}–${availableEnd}，扣除 ${bufferMinutes} 分钟缓冲后可安排 ${formatMinutes(suggestion.effectiveCapacityMinutes)}，还剩约 ${formatMinutes(suggestion.effectiveCapacityMinutes - totalMinutes)}。${assumedCount ? `其中 ${assumedCount} 项使用暂估时长。` : "所有事项都已填写预计时长。"}`}
              </div>
              </div>

              {selectedItems.length > 0 && (
                <section className="daily-plan-schedule-preview" aria-labelledby="daily-plan-schedule-title">
                  <div className="daily-plan-section-heading">
                    <div>
                      <h3 id="daily-plan-schedule-title">
                        <CalendarClock size={16} /> 建议时间块
                      </h3>
                      <p>只读预览：确认后仍只写入 {targetName} 私人计划，时间块可在时间线继续调整。</p>
                    </div>
                    <span className="daily-plan-preview-badge">可解释</span>
                  </div>
                  <div className="daily-plan-schedule-list">
                    {schedulePreview.slots.map((slot) => (
                      <div className={`daily-plan-schedule-row ${slot.conflict ? "is-conflict" : ""}`} key={slot.taskId}>
                        <span className="daily-plan-schedule-time">
                          {formatClock(slot.startMinutes)}–{formatClock(slot.endMinutes)}
                        </span>
                        <strong>{slot.taskTitle}</strong>
                        <small>
                          {slot.source === "existing-block" ? "已有时间块" : "建议安排"}
                          {slot.conflict === "outside-window" ? " · 超出可用时段" : ""}
                          {slot.conflict === "overlap" ? " · 与已有时间块冲突" : ""}
                        </small>
                      </div>
                    ))}
                  </div>
                  {schedulePreview.unscheduled.length > 0 && (
                    <p className="daily-plan-schedule-warning" role="status">
                      还有 {schedulePreview.unscheduled.length} 项放不进当前时段，仍会保留在{targetName}的顺序中，可手动调整时段或时长。
                    </p>
                  )}
                </section>
              )}

              {selectedItems.length > 0 && schedulePreview.unscheduled.length > 0 && (
                <section className="daily-plan-multi-day-preview" aria-labelledby="daily-plan-multi-day-title">
                  <div className="daily-plan-section-heading">
                    <div>
                      <h3 id="daily-plan-multi-day-title">后续工作日预览</h3>
                      <p>只读建议：{targetName}放不下的任务会顺延到未来 5 个工作日，不会自动改日期或写入飞书。</p>
                    </div>
                    <span className="daily-plan-preview-badge">不自动改期</span>
                  </div>
                  <div className="daily-plan-multi-day-list">
                    {multiDayPreview.days
                      .filter((day) => day.date !== date && day.slots.length > 0)
                      .map((day) => (
                        <div className="daily-plan-multi-day-row" key={day.date}>
                          <div className="daily-plan-multi-day-date">
                            <strong>{dateLabel(day.date)}</strong>
                            <small>
                              已排 {formatMinutes(day.scheduledMinutes)} · 剩余 {formatMinutes(day.remainingMinutes)}
                            </small>
                          </div>
                          <div className="daily-plan-multi-day-tasks">
                            {day.slots.map((slot) => (
                              <span key={slot.taskId} className="daily-plan-multi-day-task">
                                <b>{formatClock(slot.startMinutes)}–{formatClock(slot.endMinutes)}</b>
                                {slot.taskTitle}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
                  {multiDayPreview.unscheduled.length > 0 && (
                    <p className="daily-plan-schedule-warning" role="status">
                      {multiDayPreview.unscheduled.length} 项仍没有可行时段：{multiDayPreview.unscheduled
                        .slice(0, 3)
                        .map((item) => `${item.taskTitle}（${multiDayReasonLabel(item.reason)}）`)
                        .join("、")}
                      {multiDayPreview.unscheduled.length > 3 ? "等" : ""}。它们仍会保留在{targetName}的顺序中，请手动调整时长、时段或优先级。
                    </p>
                  )}
                </section>
              )}

              <div className="daily-plan-body">
              <section className="daily-plan-section" aria-labelledby="selected-plan-title">
                <div className="daily-plan-section-heading">
                  <div>
                    <h3 id="selected-plan-title">{targetName}的顺序</h3>
                    <p>固定事项不会因容量不足而消失，其余任务可以自由增减。</p>
                  </div>
                  <button type="button" className="ghost-button" onClick={resetToSuggestion}>
                    <RefreshCw size={14} />
                    恢复建议
                  </button>
                </div>
                {selectedItems.length ? (
                  <ol className="daily-plan-list">
                    {selectedItems.map((item, index) => {
                    const estimate = durationFor(item);
                    const assumed =
                      item.isEstimateDefault &&
                      durationOverrides[item.task.id] === undefined;
                    return (
                      <li
                        key={item.task.id}
                        className={`daily-plan-row is-selected ${item.isFixed ? "is-fixed" : ""}`}
                      >
                        <span className="daily-plan-order">{index + 1}</span>
                        <div className="daily-plan-task-copy">
                          <strong>{item.task.title}</strong>
                          <span>
                            {item.primaryReason}
                            {item.blocked ? "，仍有前置任务未完成" : ""}
                            {item.belowMinimumBlock ? "，低于最小连续块，建议留给碎片时间" : ""}
                          </span>
                          <small>{sourceLabel(item.task)}</small>
                        </div>
                        <label className="daily-plan-estimate">
                          <span>{assumed ? "暂估" : "预计"}</span>
                          <select
                            value={estimate}
                            aria-label={`${item.task.title}的预计时长`}
                            onChange={(event) =>
                              setDurationOverrides((current) => ({
                                ...current,
                                [item.task.id]: Number(event.target.value),
                              }))
                            }
                          >
                            {estimateOptions(estimate).map((minutes) => (
                              <option key={minutes} value={minutes}>
                                {formatMinutes(minutes)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="daily-plan-row-actions">
                          <button
                            type="button"
                            aria-label={`上移${item.task.title}`}
                            disabled={index === 0}
                            onClick={() => moveItem(item.task.id, -1)}
                          >
                            <ChevronUp size={15} />
                          </button>
                          <button
                            type="button"
                            aria-label={`下移${item.task.title}`}
                            disabled={index === selectedItems.length - 1}
                            onClick={() => moveItem(item.task.id, 1)}
                          >
                            <ChevronDown size={15} />
                          </button>
                          {item.isFixed ? (
                            <span title={`到期或${targetName}开始的事项会固定保留`}>
                              <LockKeyhole size={14} />
                            </span>
                          ) : (
                            <button
                              type="button"
                              aria-label={`移出${item.task.title}`}
                              onClick={() => removeItem(item)}
                            >
                              <X size={15} />
                            </button>
                          )}
                        </div>
                      </li>
                    );
                    })}
                  </ol>
                ) : (
                  <div className="daily-plan-selected-empty">
                    <CalendarCheck2 size={20} aria-hidden="true" />
                    <div>
                      <strong>{targetName}先留白</strong>
                      <span>
                        应用后会移出原有的私人{targetName}安排，不影响飞书截止时间。
                      </span>
                    </div>
                  </div>
                )}
              </section>

              {allCandidates.length > 0 || query ? (
                <section className="daily-plan-section" aria-labelledby="candidate-plan-title">
                  <div className="daily-plan-section-heading has-search">
                    <div>
                      <h3 id="candidate-plan-title">还可以加入</h3>
                      <p>按截止风险、优先级和依赖关系排序。</p>
                    </div>
                    <label className="daily-plan-search">
                      <Search size={14} aria-hidden="true" />
                      <span className="sr-only">搜索候选任务</span>
                      <input
                        value={query}
                        placeholder="找一项任务"
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                  </div>
                  <ul className="daily-plan-list is-candidates">
                    {visibleCandidates.map((item) => (
                      <li key={item.task.id} className="daily-plan-row">
                        <button
                          type="button"
                          className="daily-plan-add"
                          aria-label={`加入${item.task.title}`}
                          onClick={() => addItem(item)}
                        >
                          <Plus size={16} />
                        </button>
                        <div className="daily-plan-task-copy">
                          <strong>{item.task.title}</strong>
                          <span>
                            {item.primaryReason}
                            {item.blocked ? "，仍有前置任务未完成" : ""}
                            {item.belowMinimumBlock ? "，低于最小连续块，建议手动加入" : ""}
                          </span>
                          <small>{sourceLabel(item.task)}</small>
                        </div>
                        <span className="daily-plan-candidate-time">
                          {item.isEstimateDefault ? "暂估 " : ""}
                          {formatMinutes(item.estimatedMinutes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {!visibleCandidates.length && (
                    <p className="daily-plan-no-match">没有匹配的候选任务。</p>
                  )}
                  {!normalizedQuery && allCandidates.length > 8 && (
                    <button
                      type="button"
                      className="ghost-button daily-plan-show-more"
                      onClick={() => setShowAllCandidates((value) => !value)}
                    >
                      {showAllCandidates
                        ? "收起候选"
                        : `再看 ${allCandidates.length - 8} 项`}
                    </button>
                  )}
                </section>
              ) : null}
              </div>
            </div>

            {saveError && (
              <p className="daily-plan-inline-error" role="alert">
                <AlertTriangle size={15} />
                {saveError}
              </p>
            )}
            <footer className="daily-plan-actions">
              <span>
                <Check size={15} />
                只修改私人计划、顺序和你确认过的预计时长
              </span>
              <button type="button" className="ghost-button" disabled={saving} onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!canApply || saving}
                onClick={() => void applyPlan()}
              >
                <CalendarCheck2 size={16} />
                {saving
                  ? "正在安排"
                  : !canApply
                    ? "计划已是最新"
                    : selectedItems.length
                      ? `安排 ${selectedItems.length} 项到${targetName}`
                      : `清空${targetNoun}计划`}
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
