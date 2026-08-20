import { CalendarClock, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3, GripVertical, Inbox, Sparkles, Upload } from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import type { Task, UpdateTaskInput } from "../shared/models";
import {
  calendarBusyBlocksForDate,
  calendarEventsForDate,
  mergeCalendarEvents,
  parseIcsCalendar,
  type CalendarEvent,
} from "../shared/calendar-events";
import {
  addLocalDays,
  formatTimelineDate,
  localDateKey,
  localIsoAt,
  scheduledTimelineTasks,
  tasksForWeekDay,
  timelineSlots,
  unscheduledTimelineTasks,
  weekDateKeys,
  weeklyReviewSummary,
} from "./timeline-utils";
import { buildProjectHealthSummaries } from "./project-health";
import {
  buildProjectBoardColumns,
  projectIdsForBoard,
  type ProjectBoardColumnKey,
} from "./project-board";
import {
  buildWorkCycleMetrics,
  formatCycleMinutes,
  workCycleFor,
  type WorkCycleWeeks,
} from "./work-cycles";
import { buildFocusInsights } from "./focus-insights";

type ToastKind = "success" | "error" | "info";

export interface TimelinePageProps {
  tasks: Task[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onSelect: (taskId: string) => void;
  onMove: (taskId: string, patch: UpdateTaskInput) => Promise<string | undefined>;
  onUndo: (operationId: string) => void;
  notify: (message: string, kind?: ToastKind, action?: { label: string; run: () => void }) => void;
  calendarEvents?: readonly CalendarEvent[];
  onCalendarEventsChange?: (events: CalendarEvent[]) => void;
}

const priorityClass = (task: Task): string =>
  task.priority === "urgent" || task.priority === "high"
    ? "is-high"
    : task.priority === "medium"
      ? "is-medium"
      : "is-low";

const taskDuration = (task: Task): number => {
  if (task.timeBlock) {
    const start = new Date(task.timeBlock.startAt).getTime();
    const end = new Date(task.timeBlock.endAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return Math.max(5, Math.round((end - start) / 60_000));
    }
  }
  return task.estimatedMinutes && task.estimatedMinutes > 0
    ? Math.round(task.estimatedMinutes)
    : 30;
};

export function TimelinePage({
  tasks,
  loading,
  error,
  onRetry,
  onSelect,
  onMove,
  onUndo,
  notify,
  calendarEvents = [],
  onCalendarEventsChange,
}: TimelinePageProps) {
  const [date, setDate] = useState(() => localDateKey());
  const [viewMode, setViewMode] = useState<"day" | "week" | "board">("day");
  const [boardProjectId, setBoardProjectId] = useState("all");
  const [draggingId, setDraggingId] = useState<string>();
  const [movingId, setMovingId] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const calendarInputRef = useRef<HTMLInputElement>(null);
  const [weeklyCapacityHours, setWeeklyCapacityHours] = useState(() => {
    try {
      const stored = Number(localStorage.getItem("todo-agent:weekly-capacity-hours"));
      return Number.isFinite(stored) && stored >= 1 && stored <= 80 ? Math.round(stored) : 40;
    } catch {
      return 40;
    }
  });
  const [cycleWeeks, setCycleWeeks] = useState<WorkCycleWeeks>(() => {
    try {
      return localStorage.getItem("todo-agent:work-cycle-weeks") === "2" ? 2 : 1;
    } catch {
      return 1;
    }
  });
  const slots = useMemo(() => timelineSlots(date), [date]);
  const scheduled = useMemo(() => scheduledTimelineTasks(tasks, date), [date, tasks]);
  const unscheduled = useMemo(() => unscheduledTimelineTasks(tasks, date), [date, tasks]);
  const weekDates = useMemo(() => weekDateKeys(date), [date]);
  const weeklySummary = useMemo(() => weeklyReviewSummary(tasks, date), [date, tasks]);
  const focusInsights = useMemo(() => buildFocusInsights(tasks, date), [date, tasks]);
  const workCycle = useMemo(
    () => workCycleFor(date, cycleWeeks, weeklyCapacityHours * 60),
    [date, cycleWeeks, weeklyCapacityHours],
  );
  const workCycleMetrics = useMemo(
    () => buildWorkCycleMetrics(tasks, workCycle),
    [tasks, workCycle],
  );
  const projectHealth = useMemo(
    () => buildProjectHealthSummaries(tasks, {
      anchor: date,
      capacityMinutes: weeklyCapacityHours * 60,
    }),
    [date, tasks, weeklyCapacityHours],
  );
  const projectIds = useMemo(() => projectIdsForBoard(tasks), [tasks]);
  const boardColumns = useMemo(
    () =>
      buildProjectBoardColumns(
        tasks,
        boardProjectId === "all" ? undefined : boardProjectId,
      ),
    [boardProjectId, tasks],
  );
  const bySlot = useMemo(() => {
    const map = new Map<number, typeof scheduled>();
    scheduled.forEach((placement) => {
      const current = map.get(placement.slotMinute) ?? [];
      current.push(placement);
      map.set(placement.slotMinute, current);
    });
    return map;
  }, [scheduled]);
  const dayCalendarEvents = useMemo(
    () => calendarEventsForDate(calendarEvents, date),
    [calendarEvents, date],
  );
  const dayCalendarBlocks = useMemo(
    () => calendarBusyBlocksForDate(calendarEvents, date),
    [calendarEvents, date],
  );

  const moveToSlot = async (taskId: string, minute: number) => {
    if (movingId) return;
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    setMovingId(taskId);
    setAnnouncement("");
    try {
      const startAt = localIsoAt(date, minute);
      const endAt = localIsoAt(date, minute + taskDuration(task));
      const operationId = await onMove(taskId, {
        plannedDate: date,
        timeBlock: { startAt, endAt },
      });
      const message = `已将“${task.title}”安排在 ${new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(startAt))}`;
      setAnnouncement(message);
      notify(message, "success", operationId
        ? { label: "撤销", run: () => { onUndo(operationId); } }
        : undefined);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "暂时无法安排时间块";
      setAnnouncement(message);
      notify(message, "error");
    } finally {
      setMovingId(undefined);
      setDraggingId(undefined);
    }
  };

  const onDragStart = (event: DragEvent<HTMLElement>, taskId: string) => {
    setDraggingId(taskId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", taskId);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>, minute: number) => {
    event.preventDefault();
    const taskId = event.dataTransfer.getData("text/plain") || draggingId;
    if (taskId) void moveToSlot(taskId, minute);
  };

  const moveBoardTask = async (
    taskId: string,
    target: ProjectBoardColumnKey,
  ): Promise<void> => {
    if (movingId) return;
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    if (target !== "done" && task.status === "open") {
      setAnnouncement("看板的阻塞列由前置依赖自动决定");
      notify("阻塞列由前置依赖自动决定，请在任务详情中调整依赖", "info");
      return;
    }
    const nextStatus = target === "done" ? "completed" : "open";
    if (task.status === nextStatus) return;
    setMovingId(taskId);
    try {
      const operationId = await onMove(taskId, { status: nextStatus });
      const message = nextStatus === "completed" ? `已完成“${task.title}”` : `已重新打开“${task.title}”`;
      setAnnouncement(message);
      notify(
        message,
        "success",
        operationId ? { label: "撤销", run: () => onUndo(operationId) } : undefined,
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "暂时无法更新任务状态";
      setAnnouncement(message);
      notify(message, "error");
    } finally {
      setMovingId(undefined);
      setDraggingId(undefined);
    }
  };

  const shiftDate = (amount: number) => {
    setDate((value) => addLocalDays(value, viewMode === "week" ? amount * 7 : amount));
  };

  const changeWeeklyCapacity = (value: string) => {
    const next = Math.min(80, Math.max(1, Math.round(Number(value) || 1)));
    setWeeklyCapacityHours(next);
    try {
      localStorage.setItem("todo-agent:weekly-capacity-hours", String(next));
    } catch {
      // A read-only storage area should not make the timeline unusable.
    }
  };

  const changeCycleWeeks = (value: string) => {
    const next: WorkCycleWeeks = value === "2" ? 2 : 1;
    setCycleWeeks(next);
    try {
      localStorage.setItem("todo-agent:work-cycle-weeks", String(next));
    } catch {
      // A read-only storage area should not make the timeline unusable.
    }
  };

  const importCalendar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !onCalendarEventsChange) return;
    try {
      const text = await file.text();
      const imported = parseIcsCalendar(text, file.name.replace(/\.ics$/iu, "") || "本地日历");
      if (!imported.length) {
        notify("没有从这个 .ics 文件中读到有效的日历事件", "error");
        return;
      }
      onCalendarEventsChange(mergeCalendarEvents(calendarEvents, imported));
      notify(`已导入 ${imported.length} 个日历事件，规划会自动避开忙碌时段`, "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "暂时无法读取日历文件", "error");
    }
  };

  const shiftCycle = (amount: number) => {
    setDate(addLocalDays(workCycle.startDate, amount * workCycle.weeks * 7));
    setViewMode("week");
  };

  const weekLabel = weeklySummary.weekStart === weeklySummary.weekEnd
    ? weeklySummary.weekStart
    : `${weeklySummary.weekStart} — ${weeklySummary.weekEnd}`;

  return (
    <main className="content-column timeline-page">
      <div className="page-heading timeline-heading">
        <div>
          <h1>时间线</h1>
          <p>把任务放进真实可用的时间，而不是只写一个截止日期</p>
        </div>
        <div className="timeline-date-actions" aria-label="切换日期">
          <button type="button" className="icon-button" disabled={viewMode === "board"} aria-label={viewMode === "week" ? "上一周" : "前一天"} onClick={() => shiftDate(-1)}>
            <ChevronLeft size={17} />
          </button>
          <button type="button" className="soft-button" onClick={() => setDate(localDateKey())}>
            <CalendarDays size={15} /> 今天
          </button>
          <div className="timeline-view-toggle" role="group" aria-label="时间线视图">
            <button type="button" className={viewMode === "day" ? "active" : ""} onClick={() => setViewMode("day")}>日</button>
            <button type="button" className={viewMode === "week" ? "active" : ""} onClick={() => setViewMode("week")}>周</button>
            <button type="button" className={viewMode === "board" ? "active" : ""} onClick={() => setViewMode("board")}>项目</button>
          </div>
          <button type="button" className="icon-button" disabled={viewMode === "board"} aria-label={viewMode === "week" ? "下一周" : "后一天"} onClick={() => shiftDate(1)}>
            <ChevronRight size={17} />
          </button>
        </div>
      </div>

      <section className="timeline-summary" aria-label="时间线摘要">
        <div className="timeline-summary-date">
            <strong>{viewMode === "week" ? "本周概览" : viewMode === "board" ? "项目看板" : formatTimelineDate(date)}</strong>
            <span>{viewMode === "week" ? weekLabel : viewMode === "board" ? "同一任务，不同项目状态视图" : date}</span>
        </div>
        <div className="timeline-summary-metrics">
          {viewMode === "week" ? (
            <>
              <span><CheckCircle2 size={14} /> 完成 {weeklySummary.completedCount} 项</span>
              <span><Clock3 size={14} /> 排程 {weeklySummary.scheduledCount} 项</span>
            </>
          ) : viewMode === "board" ? (
            <>
              <span><Inbox size={14} /> 项目 {projectIds.length} 个</span>
              <span><Clock3 size={14} /> 卡片 {boardColumns.reduce((total, column) => total + column.tasks.length, 0)} 张</span>
            </>
          ) : (
            <>
              <span><Clock3 size={14} /> 已安排 {scheduled.length} 项</span>
              <span><Inbox size={14} /> 待安排 {unscheduled.length} 项</span>
            </>
          )}
        </div>
      </section>

      {loading ? (
        <div className="empty-state timeline-empty"><div><Clock3 size={28} /><p>正在读取时间线…</p></div></div>
      ) : error ? (
        <div className="empty-state timeline-empty"><div><Sparkles size={28} /><h2>时间线暂时不可用</h2><p>{error}</p><button type="button" className="soft-button" onClick={onRetry}>重试</button></div></div>
      ) : viewMode === "board" ? (
        <section className="project-board" aria-label="项目看板">
          <div className="timeline-board-hint">拖动任务到“已完成”可完成；从已完成拖回可重新打开。阻塞列由前置依赖自动计算，不复制任务。</div>
          <label className="project-board-selector">
            <span>当前项目</span>
            <select
              className="field-select"
              aria-label="看板项目"
              value={boardProjectId}
              onChange={(event) => setBoardProjectId(event.target.value)}
            >
              <option value="all">全部有项目任务</option>
              {projectIds.map((projectId) => <option key={projectId} value={projectId}>{projectId}</option>)}
            </select>
          </label>
          {projectIds.length === 0 ? (
            <div className="timeline-project-health-empty">
              <Sparkles size={16} aria-hidden="true" />
              给任务填写项目后，这里会出现可拖动的项目看板。
            </div>
          ) : (
            <div className="project-board-grid">
              {boardColumns.map((column) => (
                <section
                  className={`project-board-column is-${column.key}`}
                  key={column.key}
                  aria-labelledby={`project-board-${column.key}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const taskId = event.dataTransfer.getData("text/plain") || draggingId;
                    if (taskId) void moveBoardTask(taskId, column.key);
                  }}
                >
                  <div className="project-board-column-heading">
                    <div><h2 id={`project-board-${column.key}`}>{column.title}</h2><span>{column.hint}</span></div>
                    <strong>{column.tasks.length}</strong>
                  </div>
                  <div className="project-board-card-list">
                    {column.tasks.length ? column.tasks.map((task) => (
                      <article
                        className={`project-board-card ${priorityClass(task)} ${movingId === task.id ? "is-moving" : ""}`}
                        key={task.id}
                        draggable={!movingId}
                        onDragStart={(event) => onDragStart(event, task.id)}
                        onDragEnd={() => setDraggingId(undefined)}
                      >
                        <button type="button" className="project-board-card-body" onClick={() => onSelect(task.id)}>
                          <strong>{task.title}</strong>
                          <small>{task.dueAt ? `截止 ${formatTimelineDate(task.dueAt.slice(0, 10))}` : "无截止时间"}{task.dependencyIds.length ? ` · 前置 ${task.dependencyIds.length} 项` : ""}</small>
                        </button>
                        <button
                          type="button"
                          className="project-board-card-action"
                          onClick={() => void moveBoardTask(task.id, column.key === "done" ? "backlog" : "done")}
                          aria-label={column.key === "done" ? `重新打开${task.title}` : `完成${task.title}`}
                        >
                          {column.key === "done" ? "重开" : "完成"}
                        </button>
                      </article>
                    )) : <div className="project-board-empty">拖动任务卡到这里</div>}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      ) : viewMode === "week" ? (
        <>
          <section className={`timeline-work-cycle ${workCycleMetrics.overloadMinutes ? "is-overloaded" : ""}`} aria-labelledby="timeline-work-cycle-title">
            <div className="timeline-section-heading timeline-work-cycle-heading">
              <div>
                <h2 id="timeline-work-cycle-title">工作周期</h2>
                <p>
                  {workCycle.startDate.slice(5).replace("-", "/")} — {workCycle.endDate.slice(5).replace("-", "/")}
                  · {workCycle.weeks} 周 · 只读容量预测
                </p>
              </div>
              <div className="timeline-work-cycle-actions" aria-label="工作周期设置">
                <button type="button" className="icon-button" aria-label="上一个工作周期" onClick={() => shiftCycle(-1)}>
                  <ChevronLeft size={15} />
                </button>
                <label className="timeline-cycle-length">
                  <span className="sr-only">周期长度</span>
                  <select aria-label="周期长度" value={cycleWeeks} onChange={(event) => changeCycleWeeks(event.target.value)}>
                    <option value="1">1 周</option>
                    <option value="2">2 周</option>
                  </select>
                </label>
                <button type="button" className="icon-button" aria-label="下一个工作周期" onClick={() => shiftCycle(1)}>
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
            <div className="timeline-work-cycle-overview">
              <div className="timeline-work-cycle-load" aria-label={`周期负载 ${Math.round(workCycleMetrics.loadRatio * 100)}%`}>
                <div className="timeline-work-cycle-load-label">
                  <span>已安排容量</span>
                  <strong>{formatCycleMinutes(workCycleMetrics.plannedMinutes)} / {formatCycleMinutes(workCycleMetrics.capacityMinutes)}</strong>
                </div>
                <div className="timeline-work-cycle-track"><i style={{ width: `${Math.min(100, Math.max(2, Math.round(workCycleMetrics.loadRatio * 100)))}%` }} /></div>
                <small>
                  {workCycleMetrics.overloadMinutes
                    ? `超出 ${formatCycleMinutes(workCycleMetrics.overloadMinutes)}，建议拆分或移到下个周期`
                    : `还剩 ${formatCycleMinutes(workCycleMetrics.remainingMinutes)} 可用容量`}
                </small>
              </div>
              <div className="timeline-work-cycle-stats">
                <span><strong>{workCycleMetrics.openTasks.length}</strong>周期内待办</span>
                <span><strong>{workCycleMetrics.scheduledTasks.length}</strong>有时间</span>
                <span><strong>{workCycleMetrics.unscheduledTasks.length}</strong>待排时间</span>
                <span><strong>{workCycleMetrics.completedTasks.length}</strong>周期内完成</span>
              </div>
            </div>
            <div className="timeline-work-cycle-candidates">
              <div className="timeline-work-cycle-candidate-heading">
                <div><strong>下一批候选</strong><span>只提供建议，不会自动改期或写回飞书</span></div>
                <span>{workCycleMetrics.candidateTasks.length}</span>
              </div>
              {workCycleMetrics.candidateTasks.length ? (
                <div className="timeline-work-cycle-candidate-list">
                  {workCycleMetrics.candidateTasks.map((task) => {
                    const reason = task.plannedDate
                      ? "已计划，等待安排具体时间"
                      : task.dueAt
                        ? `截止 ${task.dueAt.slice(0, 10)}`
                        : "没有日期，适合放进下个周期";
                    return (
                      <button type="button" key={task.id} className={`timeline-work-cycle-candidate ${priorityClass(task)}`} onClick={() => onSelect(task.id)}>
                        <span><strong>{task.title}</strong><small>{reason}</small></span>
                        <em>{formatCycleMinutes(task.estimatedMinutes && task.estimatedMinutes > 0 ? task.estimatedMinutes : 30)}</em>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="timeline-work-cycle-empty">这个周期没有需要补排的候选任务。</div>
              )}
            </div>
          </section>

          <section className="timeline-week-board" aria-label="本周任务概览">
            <div className="timeline-board-hint">一眼看见这一周的节奏；点击某天进入半小时日时间线。</div>
            <div className="timeline-week-grid">
              {weekDates.map((day) => {
                const dayTasks = tasksForWeekDay(tasks, day);
                const today = day === localDateKey();
                return (
                  <article className={`timeline-week-day ${today ? "is-today" : ""}`} key={day}>
                    <button type="button" className="timeline-week-day-heading" onClick={() => { setDate(day); setViewMode("day"); }}>
                      <strong>{new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(new Date(`${day}T12:00:00`))}</strong>
                      <span>{day.slice(5).replace("-", "/")}</span>
                      <small>{dayTasks.length} 项</small>
                    </button>
                    <div className="timeline-week-day-tasks">
                      {dayTasks.slice(0, 5).map((task) => (
                        <button type="button" className={`timeline-week-task ${priorityClass(task)} ${task.status === "completed" ? "is-completed" : ""}`} key={task.id} onClick={() => onSelect(task.id)}>
                          <span>{task.title}</span>
                          {task.status === "completed" && <CheckCircle2 size={12} aria-label="已完成" />}
                        </button>
                      ))}
                      {dayTasks.length > 5 && <small className="timeline-week-more">还有 {dayTasks.length - 5} 项</small>}
                      {!dayTasks.length && <span className="timeline-week-empty">暂无安排</span>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="timeline-week-review" aria-labelledby="timeline-week-review-title">
            <div className="timeline-section-heading">
              <div><h2 id="timeline-week-review-title">本周回顾</h2><p>把完成、排程和下一步放在一起看</p></div>
              <Sparkles size={17} />
            </div>
            <div className="timeline-review-metrics">
              <div><strong>{weeklySummary.completedCount}</strong><span>完成任务</span></div>
              <div><strong>{weeklySummary.focusMinutes}</strong><span>专注分钟</span></div>
              <div><strong>{weeklySummary.overdueCount}</strong><span>仍逾期</span></div>
              <div><strong>{weeklySummary.unscheduledCount}</strong><span>待安排</span></div>
            </div>
            {weeklySummary.nextWeekCandidates.length > 0 && (
              <div className="timeline-review-next">
                <strong>下周可以先看</strong>
                <div>
                  {weeklySummary.nextWeekCandidates.map((task) => (
                    <button type="button" key={task.id} onClick={() => onSelect(task.id)}>{task.title}</button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="timeline-focus-insights" aria-labelledby="timeline-focus-insights-title">
            <div className="timeline-section-heading">
              <div>
                <h2 id="timeline-focus-insights-title">专注节奏</h2>
                <p>把真正投入的时间变成看得见的节奏，不用连续打卡。</p>
              </div>
              <Clock3 size={17} aria-hidden="true" />
            </div>
            <div className="timeline-focus-metrics">
              <div><strong>{focusInsights.totalMinutes}</strong><span>专注分钟</span></div>
              <div><strong>{focusInsights.totalSessions}</strong><span>专注段</span></div>
              <div><strong>{focusInsights.averageSessionMinutes || "—"}</strong><span>平均分钟</span></div>
            </div>
            <div className="timeline-focus-bars" role="list" aria-label="一周每日专注时长">
              {(() => {
                const maxMinutes = Math.max(1, ...focusInsights.days.map((day) => day.minutes));
                return focusInsights.days.map((day) => {
                  const height = day.minutes > 0
                    ? Math.max(10, Math.round((day.minutes / maxMinutes) * 100))
                    : 4;
                  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" })
                    .format(new Date(`${day.date}T12:00:00`));
                  return (
                    <div className="timeline-focus-day" role="listitem" key={day.date}>
                      <span className="timeline-focus-day-value">{day.minutes ? `${day.minutes}′` : "·"}</span>
                      <div className="timeline-focus-bar-track" aria-hidden="true">
                        <i style={{ height: `${height}%` }} />
                      </div>
                      <strong>{weekday}</strong>
                      <small>{day.date.slice(5).replace("-", "/")}</small>
                    </div>
                  );
                });
              })()}
            </div>
            {focusInsights.topTasks.length > 0 ? (
              <div className="timeline-focus-top-tasks">
                <span>投入最多</span>
                <div>
                  {focusInsights.topTasks.map((item) => (
                    <button type="button" key={item.taskId} onClick={() => onSelect(item.taskId)}>
                      <strong>{item.title}</strong>
                      <small>{item.minutes} 分钟 · {item.sessions} 段</small>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="timeline-focus-empty">完成一段专注后，这里会记录你的投入，而不是只看勾选数量。</p>
            )}
          </section>

          <section className="timeline-project-health" aria-labelledby="timeline-project-health-title">
            <div className="timeline-section-heading timeline-project-health-heading">
              <div>
                <h2 id="timeline-project-health-title">项目健康</h2>
                <p>只读当前任务事实，帮你发现阻塞和过载，不会自动改期。</p>
              </div>
              <label className="timeline-capacity-control">
                <span>本周可投入</span>
                <input
                  aria-label="本周可投入小时"
                  type="number"
                  min={1}
                  max={80}
                  step={1}
                  value={weeklyCapacityHours}
                  onChange={(event) => changeWeeklyCapacity(event.target.value)}
                />
                <small>小时</small>
              </label>
            </div>
            {projectHealth.length ? (
              <div className="timeline-project-health-grid">
                {projectHealth.map((summary) => {
                  const capacityPercent = Math.min(100, Math.max(0, Math.round(summary.capacityRatio * 100)));
                  return (
                    <article className={`timeline-project-health-card is-${summary.status}`} key={summary.projectId}>
                      <div className="timeline-project-health-card-heading">
                        <div>
                          <strong>{summary.projectId}</strong>
                          <span className={`timeline-health-pill is-${summary.status}`}>{summary.statusLabel}</span>
                        </div>
                        <p>{summary.signal}</p>
                      </div>
                      <div className="timeline-project-health-metrics">
                        <span><strong>{summary.openCount}</strong>进行中</span>
                        <span><strong>{summary.completedCount}</strong>本周完成</span>
                        <span><strong>{summary.overdueCount}</strong>逾期</span>
                        <span><strong>{summary.blockedCount}</strong>阻塞</span>
                      </div>
                      <div className="timeline-project-capacity" aria-label={`${summary.projectId} 本周计划负载 ${capacityPercent}%`}>
                        <div><span>本周计划负载</span><strong>{capacityPercent}%</strong></div>
                        <div className="timeline-project-capacity-track"><i style={{ width: `${capacityPercent}%` }} /></div>
                        <small>{summary.plannedOpenMinutes} 分钟 / {weeklyCapacityHours} 小时容量 · {summary.unplannedCount} 项待排时间</small>
                      </div>
                      {summary.nextTask && (
                        <button type="button" className="timeline-project-next" onClick={() => onSelect(summary.nextTask!.id)}>
                          下一步：{summary.nextTask.title}
                          <ChevronRight size={14} aria-hidden="true" />
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="timeline-project-health-empty">
                <Sparkles size={16} aria-hidden="true" />
                给任务填写项目后，这里会显示项目节奏、容量和阻塞情况。
              </div>
            )}
          </section>
        </>
      ) : (
        <>
          <section className="timeline-calendar-agenda" aria-labelledby="timeline-calendar-title">
            <div className="timeline-section-heading timeline-calendar-heading">
              <div>
                <h2 id="timeline-calendar-title"><CalendarClock size={17} /> 今日议程</h2>
                <p>只读显示日历事件；今日规划会避开这些时间，不会写回日历。</p>
              </div>
              <div className="timeline-calendar-actions">
                <span>{dayCalendarEvents.length ? `${dayCalendarEvents.length} 个事件` : "暂无事件"}</span>
                {onCalendarEventsChange && (
                  <>
                    <input
                      ref={calendarInputRef}
                      className="sr-only"
                      type="file"
                      accept=".ics,text/calendar"
                      aria-label="选择日历文件"
                      onChange={(event) => void importCalendar(event)}
                    />
                    <button type="button" className="soft-button" onClick={() => calendarInputRef.current?.click()}>
                      <Upload size={14} /> 导入 .ics
                    </button>
                    {calendarEvents.length > 0 && (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          const previous = [...calendarEvents];
                          onCalendarEventsChange([]);
                          notify("已清空本地日历事件", "info", {
                            label: "撤销",
                            run: () => onCalendarEventsChange(previous),
                          });
                        }}
                      >
                        清空
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
            {dayCalendarBlocks.length ? (
              <div className="timeline-calendar-event-list">
                {dayCalendarBlocks.map((block) => (
                  <div className="timeline-calendar-event" key={block.id}>
                    <span className="timeline-calendar-event-time">
                      {block.startMinutes === 0 && block.endMinutes >= 1_440
                        ? "全天"
                        : `${formatTimelineDate(date)} · ${String(Math.floor(block.startMinutes / 60)).padStart(2, "0")}:${String(block.startMinutes % 60).padStart(2, "0")}–${String(Math.floor(block.endMinutes / 60)).padStart(2, "0")}:${String(block.endMinutes % 60).padStart(2, "0")}`}
                    </span>
                    <strong>{block.title}</strong>
                    <small>{block.sourceName}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="timeline-calendar-empty">
                <CalendarDays size={16} aria-hidden="true" />
                <span>导入日历 .ics 后，会议会和任务一起出现在这里。</span>
              </div>
            )}
          </section>
          <section className="timeline-board" aria-label={`${date} 的时间线`}>
            <div className="timeline-board-hint">拖动任务卡到时间格即可安排；时间块只保存为本地计划，不会改写飞书截止日期。</div>
            {slots.map((slot) => {
              const placements = bySlot.get(slot.minute) ?? [];
              return (
                <div className="timeline-row" key={slot.minute}>
                  <span className="timeline-time-label">{slot.label}</span>
                  <div
                    className={`timeline-slot ${draggingId ? "is-drop-target" : ""}`}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                    onDrop={(event) => onDrop(event, slot.minute)}
                    data-slot-minute={slot.minute}
                  >
                    {placements.map((placement) => (
                      <button
                        type="button"
                        className={`timeline-task-card ${priorityClass(placement.task)} ${movingId === placement.task.id ? "is-moving" : ""}`}
                        key={placement.task.id}
                        draggable={!movingId}
                        onDragStart={(event) => onDragStart(event, placement.task.id)}
                        onDragEnd={() => setDraggingId(undefined)}
                        onClick={() => onSelect(placement.task.id)}
                        aria-label={`${placement.task.title}，${placement.durationMinutes}分钟，点击查看详情`}
                      >
                        <GripVertical size={14} aria-hidden="true" />
                        <span className="timeline-task-copy"><strong>{placement.task.title}</strong><small>{placement.durationMinutes} 分钟 · {placement.source === "time-block" ? "时间块" : "开始时间"}</small></span>
                      </button>
                    ))}
                    {!placements.length && <span className="timeline-slot-placeholder">放到这里</span>}
                  </div>
                </div>
              );
            })}
          </section>

          <section className="timeline-unscheduled" aria-labelledby="timeline-unscheduled-title">
            <div className="timeline-section-heading">
              <div><h2 id="timeline-unscheduled-title">待安排</h2><p>今天相关、但还没有具体时间的任务</p></div>
              <span>{unscheduled.length}</span>
            </div>
            {unscheduled.length ? (
              <div className="timeline-unscheduled-list">
                {unscheduled.map((task) => (
                  <button
                    type="button"
                    className={`timeline-unscheduled-card ${priorityClass(task)}`}
                    key={task.id}
                    draggable={!movingId}
                    onDragStart={(event) => onDragStart(event, task.id)}
                    onDragEnd={() => setDraggingId(undefined)}
                    onClick={() => onSelect(task.id)}
                  >
                    <GripVertical size={14} aria-hidden="true" />
                    <span><strong>{task.title}</strong><small>{task.estimatedMinutes ? `预计 ${task.estimatedMinutes} 分钟` : "尚未估时"}{task.dueAt ? " · 有截止时间" : ""}</small></span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="timeline-clear"><Sparkles size={17} /><span>今天的任务都已经有位置了。</span></div>
            )}
          </section>
        </>
      )}
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </main>
  );
}
