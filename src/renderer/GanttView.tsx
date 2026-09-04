import { AlertTriangle, CalendarDays, ChevronRight, Clock3, Layers3, Sparkles } from "lucide-react";
import type { CSSProperties } from "react";
import type { Task } from "../shared/models";
import {
  GANTT_WINDOW_OPTIONS,
  ganttWindowLabel,
  type GanttPlan,
  type GanttWindowDays,
} from "./timeline-gantt";

interface GanttViewProps {
  plan: GanttPlan;
  projectId: string;
  projectIds: readonly string[];
  windowDays: GanttWindowDays;
  onProjectChange: (projectId: string) => void;
  onWindowChange: (windowDays: GanttWindowDays) => void;
  onSelect: (taskId: string) => void;
}

const taskStatusLabel = (task: Task): string => {
  if (task.status === "completed") return "已完成";
  if (task.status === "cancelled") return "已取消";
  return "进行中";
};

const taskClass = (task: Task): string =>
  task.priority === "urgent" || task.priority === "high"
    ? "is-high"
    : task.priority === "medium"
      ? "is-medium"
      : "is-low";

const barStyle = (startOffset: number, spanDays: number, days: number): CSSProperties => ({
  "--gantt-start": String(startOffset),
  "--gantt-span": String(spanDays),
  "--gantt-days": String(days),
} as CSSProperties);

export function GanttView({
  plan,
  projectId,
  projectIds,
  windowDays,
  onProjectChange,
  onWindowChange,
  onSelect,
}: GanttViewProps) {
  const totalRows = plan.groups.reduce((total, group) => total + group.rows.length, 0);
  const projectOptions = projectIds.filter((value) => value.trim().length > 0);
  const taskById = new Map(plan.groups.flatMap((group) => group.rows.map((row) => [row.task.id, row.task] as const)));
  const dayWidth = plan.windowDays >= 84 ? 34 : plan.windowDays >= 28 ? 42 : 52;
  return (
    <section className="timeline-gantt" aria-label="甘特视图">
      <div className="timeline-gantt-heading">
        <div>
          <div className="timeline-gantt-title"><ChartGanttMark /><h2>项目路线</h2></div>
          <p>用 {ganttWindowLabel(plan.windowDays)} 时间窗看见任务跨度、依赖和完成进度；这里是只读投影，不会自动改期。</p>
        </div>
        <div className="timeline-gantt-filters">
          <label className="timeline-gantt-project-filter">
            <span>当前项目</span>
            <select aria-label="甘特项目" value={projectId} onChange={(event) => onProjectChange(event.target.value)}>
              <option value="all">全部任务</option>
              {projectOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="timeline-gantt-project-filter">
            <span>时间窗</span>
            <select
              aria-label="甘特时间窗"
              value={windowDays}
              onChange={(event) => onWindowChange(Number(event.target.value) as GanttWindowDays)}
            >
              {GANTT_WINDOW_OPTIONS.map((value) => <option key={value} value={value}>{ganttWindowLabel(value)}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div className="timeline-gantt-meta" aria-label="甘特摘要">
        <span><CalendarDays size={13} /> {plan.startDate} — {plan.endDate}</span>
        <span><Layers3 size={13} /> {totalRows} 项有日期</span>
        {plan.criticalCount > 0 && <span className="timeline-gantt-critical-meta"><Sparkles size={13} /> 关键路线 {plan.criticalCount} 项</span>}
        {plan.blockedCount > 0 && <span className="is-warning"><AlertTriangle size={13} /> {plan.blockedCount} 项被前置依赖阻塞</span>}
      </div>
      {plan.criticalChains.length > 0 && (
        <section className="timeline-gantt-critical-routes" aria-label="关键路线">
          <div className="timeline-gantt-critical-heading">
            <div><strong>关键路线</strong><span>沿着依赖最长链，先完成左侧任务</span></div>
            <small>{plan.criticalChains.length} 条</small>
          </div>
          <div className="timeline-gantt-critical-list">
            {plan.criticalChains.slice(0, 6).map((chain) => (
              <div className="timeline-gantt-critical-chain" key={`${chain.projectId}:${chain.taskIds.join("/")}`}>
                <span className="timeline-gantt-critical-project">{chain.label}</span>
                <div className="timeline-gantt-critical-nodes">
                  {chain.taskIds.map((taskId, index) => {
                    const task = taskById.get(taskId);
                    return (
                      <span className="timeline-gantt-critical-node-wrap" key={taskId}>
                        {index > 0 && <span className="timeline-gantt-critical-arrow" aria-hidden="true">→</span>}
                        <button type="button" className="timeline-gantt-critical-node" onClick={() => onSelect(taskId)} title={task?.title ?? taskId}>
                          {task?.title ?? taskId}
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {plan.criticalChains.length > 6 && <small className="timeline-gantt-critical-more">还有 {plan.criticalChains.length - 6} 条路线</small>}
        </section>
      )}
      {totalRows > 0 ? (
        <div className="timeline-gantt-scroll">
          <div
            className="timeline-gantt-grid"
            style={{ "--gantt-days": String(plan.days.length), "--gantt-day-width": `${dayWidth}px` } as CSSProperties}
          >
            <div className="timeline-gantt-corner">项目 / 任务</div>
            <div className="timeline-gantt-day-head">
              {plan.days.map((day) => (
                <div className={`timeline-gantt-day ${day.isWeekend ? "is-weekend" : ""} ${day.isToday ? "is-today" : ""}`} key={day.date}>
                  <span>{day.weekday}</span>
                  <strong>{day.label}</strong>
                </div>
              ))}
            </div>
            {plan.groups.map((group) => (
              <div className="timeline-gantt-group" key={group.projectId}>
                <div className="timeline-gantt-group-label">
                  <span>{group.label}</span>
                  <small>{group.rows.length} 项</small>
                </div>
                {group.rows.map((row) => {
                  const status = taskStatusLabel(row.task);
                  const barLabel = `${row.task.title}，${row.bar.startDate} 至 ${row.bar.endDate}，${status}${row.critical ? "，关键路线" : ""}${row.blocked ? "，被前置依赖阻塞" : ""}`;
                  return (
                    <div className="timeline-gantt-row" key={row.task.id}>
                      <button type="button" className={`timeline-gantt-task ${taskClass(row.task)} ${row.critical ? "is-critical" : ""}`} onClick={() => onSelect(row.task.id)}>
                        <span className="timeline-gantt-task-title"><strong>{row.task.title}</strong><small>{status}{row.dependencyCount ? ` · 前置 ${row.dependencyCount} 项` : ""}{row.critical ? " · 关键路线" : ""}</small></span>
                        {row.blocked && <AlertTriangle size={13} aria-label="被前置依赖阻塞" />}
                      </button>
                      <div className="timeline-gantt-track">
                        <div className="timeline-gantt-track-days" aria-hidden="true">
                          {plan.days.map((day) => <i className={`${day.isWeekend ? "is-weekend" : ""} ${day.isToday ? "is-today" : ""}`} key={day.date} />)}
                        </div>
                        <button
                          type="button"
                          className={`timeline-gantt-bar ${taskClass(row.task)} ${row.task.status === "completed" ? "is-completed" : ""} ${row.blocked ? "is-blocked" : ""} ${row.critical ? "is-critical" : ""}`}
                          style={barStyle(row.bar.startOffset, row.bar.spanDays, plan.days.length)}
                          onClick={() => onSelect(row.task.id)}
                          aria-label={barLabel}
                          title={barLabel}
                        >
                          {row.bar.progressPercent !== undefined && <span className="timeline-gantt-bar-progress" style={{ width: `${row.bar.progressPercent}%` }} />}
                          <span className="timeline-gantt-bar-label">{row.task.title}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="timeline-gantt-empty">
          <Sparkles size={20} aria-hidden="true" />
          <div><strong>这个时间窗还没有带日期的任务</strong><span>给任务安排开始、截止或 Today 日期后，它会出现在路线中。</span></div>
        </div>
      )}
      {plan.unscheduledTasks.length > 0 && (
        <div className="timeline-gantt-unplanned" role="region" aria-label="尚未安排时间的任务">
          <div className="timeline-gantt-unplanned-heading"><div><strong>尚未安排时间</strong><span>这些任务不会因为切换到甘特视图而消失</span></div><small>{plan.unscheduledTasks.length}</small></div>
          <div className="timeline-gantt-unplanned-list">
            {plan.unscheduledTasks.slice(0, 8).map((task) => (
              <button type="button" key={task.id} onClick={() => onSelect(task.id)}>
                <Clock3 size={13} aria-hidden="true" /><span>{task.title}</span><ChevronRight size={13} aria-hidden="true" />
              </button>
            ))}
          </div>
          {plan.unscheduledTasks.length > 8 && <small className="timeline-gantt-unplanned-more">还有 {plan.unscheduledTasks.length - 8} 项，打开任务详情安排日期。</small>}
        </div>
      )}
    </section>
  );
}

function ChartGanttMark() {
  return (
    <span className="timeline-gantt-mark" aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}
