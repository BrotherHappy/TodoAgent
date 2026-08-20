import type { Task } from "../shared/models";

/**
 * Builds the draft placed in Agent when a user asks for help from a task row.
 * The task remains read-only until the user explicitly sends the draft and
 * approves any proposed write. Keeping this in a pure helper makes the
 * low-friction entry deterministic and easy to audit without invoking Agent.
 */
export function buildTaskAgentPrompt(
  task: Pick<Task, "id" | "title" | "status" | "source">,
): string {
  const status =
    task.status === "completed"
      ? "已完成"
      : task.status === "cancelled"
        ? "已取消"
        : "待办";
  const source = task.source.type === "feishu" ? "飞书" : "本地";

  return [
    "我从任务列表中选中了下面这项任务，请围绕它帮助我推进下一步。",
    `- 标题：${task.title}`,
    `- 任务 ID：${task.id}`,
    `- 当前状态：${status}`,
    `- 来源：${source}`,
    "请先查询这项任务的详情、截止时间和依赖，给出简短、可执行的建议；默认只读，未经我明确确认不要修改任务。",
  ].join("\n");
}
