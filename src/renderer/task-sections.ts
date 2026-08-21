import type { Task } from "../shared/models";

export interface TaskSectionGroup {
  id: string;
  label?: string;
  tasks: Task[];
}

/**
 * Group a task snapshot by its local heading while preserving the first-seen
 * order of headings and the existing order of tasks inside each heading.
 * `sectionId` is intentionally treated as display text: it is a private
 * organization hint, not a second provider-owned section entity.
 */
export function groupTasksBySection(
  tasks: readonly Task[],
): TaskSectionGroup[] {
  const groups = new Map<string, TaskSectionGroup>();
  for (const task of tasks) {
    const id = task.sectionId?.trim() || "__ungrouped__";
    const group = groups.get(id) ?? {
      id,
      ...(id === "__ungrouped__" ? {} : { label: id }),
      tasks: [],
    };
    group.tasks.push(task);
    groups.set(id, group);
  }
  return [...groups.values()];
}
