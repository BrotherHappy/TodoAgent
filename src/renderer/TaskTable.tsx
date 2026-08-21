import {
  AlertTriangle,
  CircleDot,
  Cloud,
  Laptop,
  MessageCircle,
  ShieldAlert,
  Star,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type {
  Task,
  TaskList,
  TaskPriority,
  TaskProject,
  TaskSourceType,
  TaskSyncStatus,
} from "../shared/models";
import { buildTaskAgentPrompt } from "./task-agent-context";
import type { TaskController } from "./task-controller";
import {
  subtaskProgressLabel,
  type SubtaskProgress,
} from "./subtask-progress";

export type TaskTableViewMode = "list" | "table";

export const taskTablePriorityLabels: Record<TaskPriority, string> = {
  none: "无",
  low: "低",
  medium: "中",
  high: "高",
  urgent: "紧急",
};

export function taskTableDateLabel(
  task: Pick<Task, "plannedDate" | "deferUntil" | "dueAt" | "dueAtIsAllDay">,
  today = new Date(),
): string {
  const formatDate = (value: string): string => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      ...(task.dueAtIsAllDay ? {} : { hour: "2-digit", minute: "2-digit", hour12: false }),
    }).format(parsed);
  };
  const dateKey = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const todayKey = dateKey(today);
  if (task.dueAt) {
    const dueKey = task.dueAt.slice(0, 10);
    const dueLabel = dueKey === todayKey ? "今天" : formatDate(task.dueAt);
    return `截止 ${dueLabel}`;
  }
  if (task.plannedDate) {
    return `计划 ${task.plannedDate === todayKey ? "今天" : task.plannedDate}`;
  }
  if (task.deferUntil) return `稍后 ${task.deferUntil}`;
  return "未安排";
}

export function taskTableSyncLabel(status: TaskSyncStatus): string {
  switch (status) {
    case "synced":
      return "已同步";
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
      return "只读";
    case "remote-deleted":
      return "远端已删除";
    default:
      return "本地";
  }
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
  return !(task.status === "open" && task.completionMode === "all-assignees");
}

function needsFeishuForCosignCompletion(task: Task): boolean {
  return (
    task.source.type === "feishu" &&
    task.status === "open" &&
    task.completionMode === "all-assignees"
  );
}

function sourceLabel(source: TaskSourceType): string {
  return source === "feishu" ? "飞书" : "本地";
}

function syncTone(status: TaskSyncStatus): "normal" | "pending" | "warning" | "error" {
  if (status === "conflict") return "warning";
  if (["failed", "permission-denied", "read-only", "remote-deleted"].includes(status)) {
    return "error";
  }
  if (["pending", "offline", "syncing"].includes(status)) return "pending";
  return "normal";
}

export interface TaskTableProps {
  tasks: readonly Task[];
  selectedId?: string;
  controller: TaskController;
  notify: (
    message: string,
    kind?: "success" | "error" | "info",
    action?: { label: string; run: () => void },
  ) => void;
  projects?: readonly TaskProject[];
  lists?: readonly TaskList[];
  selectionMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleBulk?: (taskId: string) => void;
  interactionDisabled?: boolean;
  subtaskProgress?: ReadonlyMap<string, SubtaskProgress>;
  onAskAgent: (prompt: string) => void;
}

export function TaskTable({
  tasks,
  selectedId,
  controller,
  notify,
  projects = [],
  lists = [],
  selectionMode = false,
  selectedIds = new Set<string>(),
  onToggleBulk,
  interactionDisabled = false,
  subtaskProgress,
  onAskAgent,
}: TaskTableProps) {
  const projectName = (id?: string): string =>
    id ? projects.find((project) => project.id === id)?.name ?? id : "—";
  const listName = (id?: string): string =>
    id ? lists.find((list) => list.id === id)?.name ?? id : "—";

  const toggleComplete = async (task: Task) => {
    if (!canToggleTaskCompletion(task) || interactionDisabled) return;
    try {
      const operationId = await controller.toggleComplete(task);
      notify(
        task.status === "completed"
          ? "任务已恢复"
          : needsFeishuForCosignCompletion(task)
            ? "请在飞书完成"
            : task.source.type === "feishu"
              ? "完成 · 正在同步飞书"
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

  const toggleFlag = async (
    task: Task,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (interactionDisabled) return;
    try {
      const operationId = await controller.update(task.id, {
        flagged: task.flagged !== true,
      });
      notify(
        task.flagged === true ? "已取消重点标记" : "已标记为重点任务",
        "success",
        operationId
          ? { label: "撤销", run: () => void controller.undo(operationId) }
          : undefined,
      );
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "暂时无法更新重点标记",
        "error",
      );
    }
  };

  return (
    <div className="task-table-wrap">
      <table className="task-table">
        <caption className="sr-only">表格任务视图</caption>
        <thead>
          <tr>
            <th scope="col" className="task-table-status-column">状态</th>
            <th scope="col">任务</th>
            <th scope="col">日期</th>
            <th scope="col">优先级</th>
            <th scope="col">项目 / 清单</th>
            <th scope="col">来源</th>
            <th scope="col" className="task-table-actions-column">操作</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const selected = selectedId === task.id;
            const selectedForBulk = selectedIds.has(task.id);
            const canComplete = canToggleTaskCompletion(task);
            const tone = syncTone(task.sync.status);
            const progress = subtaskProgress?.get(task.id);
            const progressLabel = subtaskProgressLabel(progress);
            return (
              <tr
                key={task.id}
                data-task-id={task.id}
                className={`task-table-row ${selected ? "selected" : ""} ${selectedForBulk ? "bulk-selected" : ""} ${task.status === "completed" ? "completed" : ""} sync-${tone}`}
              >
                <td className="task-table-status-cell">
                  {selectionMode && onToggleBulk && (
                    <input
                      className="bulk-select-checkbox"
                      type="checkbox"
                      checked={selectedForBulk}
                      disabled={interactionDisabled}
                      onChange={() => onToggleBulk(task.id)}
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
                    onChange={() => void toggleComplete(task)}
                    aria-label={`${task.status === "completed" ? "恢复" : "完成"}${task.title}`}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="task-table-title"
                    disabled={interactionDisabled}
                    onClick={() =>
                      selectionMode && onToggleBulk
                        ? onToggleBulk(task.id)
                        : controller.select(task.id)
                    }
                  >
                    <strong>{task.title}</strong>
                    <span>
                      {progressLabel && <span>{progressLabel}</span>}
                      {task.sectionId && <span>{task.sectionId}</span>}
                      {task.sync.status !== "local" && (
                        <span className={`task-table-sync-label ${tone}`}>
                          {tone === "error" ? <ShieldAlert size={12} /> : tone === "warning" ? <AlertTriangle size={12} /> : <CircleDot size={12} />}
                          {taskTableSyncLabel(task.sync.status)}
                        </span>
                      )}
                    </span>
                  </button>
                </td>
                <td className="task-table-date-cell">
                  {taskTableDateLabel(task)}
                </td>
                <td>
                  <span className={`task-table-priority priority-${task.priority}`}>
                    {taskTablePriorityLabels[task.priority]}
                  </span>
                </td>
                <td className="task-table-context-cell">
                  <span>{projectName(task.projectId)}</span>
                  <small>{listName(task.listId)}</small>
                </td>
                <td>
                  <span className={`task-table-source ${task.source.type}`}>
                    {task.source.type === "feishu" ? <Cloud size={13} /> : <Laptop size={13} />}
                    {sourceLabel(task.source.type)}
                  </span>
                </td>
                <td className="task-table-actions-cell">
                  {!selectionMode && (
                    <>
                      <button
                        type="button"
                        className={`row-icon-button task-flag-button ${task.flagged === true ? "is-active" : ""}`}
                        disabled={interactionDisabled}
                        onClick={(event) => void toggleFlag(task, event)}
                        aria-label={`${task.flagged === true ? "取消" : "添加"}重点标记${task.title}`}
                        aria-pressed={task.flagged === true}
                        title={task.flagged === true ? "取消重点标记" : "标记为重点任务"}
                      >
                        <Star size={14} fill={task.flagged === true ? "currentColor" : "none"} />
                      </button>
                      <button
                        type="button"
                        className="row-icon-button task-agent-button"
                        disabled={interactionDisabled}
                        onClick={() => onAskAgent(buildTaskAgentPrompt(task))}
                        aria-label={`让 Agent 处理${task.title}`}
                        title="让 Agent 处理此任务"
                      >
                        <MessageCircle size={14} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
