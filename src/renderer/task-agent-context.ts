import type { Task } from "../shared/models";

/**
 * Builds the draft placed in Agent when a user asks for help from a task row.
 * The task remains read-only until the user explicitly sends the draft and
 * approves any proposed write. Keeping this in a pure helper makes the
 * low-friction entry deterministic and easy to audit without invoking Agent.
 */
export function buildTaskAgentPrompt(
  task: Pick<Task, "id" | "title" | "status" | "source" | "sectionId">,
): string {
  const status = taskStatusLabel(task.status);
  const source = taskSourceLabel(task.source.type);

  return [
    "我从任务列表中选中了下面这项任务，请围绕它帮助我推进下一步。",
    `- 标题：${task.title}`,
    `- 任务 ID：${task.id}`,
    `- 当前状态：${status}`,
    `- 来源：${source}`,
    ...(task.sectionId ? [`- 分组标题：${task.sectionId}`] : []),
    "请先查询这项任务的详情、截止时间和依赖，给出简短、可执行的建议；默认只读，未经我明确确认不要修改任务。",
  ].join("\n");
}

const MAX_BULK_AGENT_CONTEXT = 20;

function taskStatusLabel(status: Task["status"]): string {
  return status === "completed"
    ? "已完成"
    : status === "cancelled"
      ? "已取消"
      : "待办";
}

function taskSourceLabel(source: Task["source"]["type"]): string {
  return source === "feishu" ? "飞书" : "本地";
}

/**
 * Builds a review-first draft for the bulk-selection Agent entry. The list
 * is intentionally capped so selecting a large collection never turns the
 * draft into an unbounded data export; the Agent can query the omitted items
 * only after the user describes the intended operation.
 */
export function buildBulkTaskAgentPrompt(
  tasks: readonly Pick<Task, "id" | "title" | "status" | "source">[],
): string {
  const visibleTasks = tasks.slice(0, MAX_BULK_AGENT_CONTEXT);
  const omittedCount = Math.max(0, tasks.length - visibleTasks.length);
  const lines = visibleTasks.map(
    (task) =>
      `- ${task.title} · ID ${task.id} · ${taskStatusLabel(task.status)} · ${taskSourceLabel(task.source.type)}`,
  );

  return [
    `我在任务列表中选中了 ${tasks.length} 项任务，想让你作为批量整理助手。`,
    "请先逐项查询这些任务的详情、截止时间和依赖，给出只读的处理方案；先说明目标、影响范围和每项变更，未经我明确确认不要修改。",
    "已选任务：",
    ...lines,
    omittedCount > 0
      ? `- 其余 ${omittedCount} 项只保留在列表选择中，请先让我确认处理范围后再查询。`
      : "",
    "如果批量目标不明确，请先提问，不要猜测完成、删除或改期操作。",
  ]
    .filter(Boolean)
    .join("\n");
}
