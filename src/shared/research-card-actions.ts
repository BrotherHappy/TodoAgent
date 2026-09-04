import type { CreateTaskInput, Task, TaskResearchCard } from "./models";

/**
 * Turn one explicitly selected research-card action into a local task draft.
 * The draft keeps enough provenance in its notes for a human to understand
 * where it came from, while its local source guarantees it cannot be written
 * back to Feishu by accident.
 */
export function buildResearchActionTaskInput(
  task: Pick<Task, "title" | "plannedDate" | "projectId">,
  card: Pick<TaskResearchCard, "title" | "url">,
  actionItem: string,
): CreateTaskInput {
  const title = actionItem.trim();
  const provenance = [
    `来源研究卡：${card.title}`,
    card.url ? `来源链接：${card.url}` : undefined,
    `原任务：${task.title}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    title,
    notes: provenance,
    source: { type: "local" },
    sync: { status: "local" },
    ...(task.projectId ? { projectId: task.projectId } : {}),
    ...(task.plannedDate ? { plannedDate: task.plannedDate } : {}),
  };
}
