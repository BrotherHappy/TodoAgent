import type { TaskReminderSourceMode } from "../shared/settings";

export type ProjectReminderSelection = TaskReminderSourceMode | "inherit";

/** Apply one reminder policy to a bounded set of project IDs. */
export function updateProjectReminderModes(
  current: Readonly<Record<string, TaskReminderSourceMode>>,
  projectIds: readonly string[],
  mode: ProjectReminderSelection,
): Record<string, TaskReminderSourceMode> {
  const next = { ...current };
  for (const rawId of projectIds.slice(0, 100)) {
    const id = rawId.trim();
    if (!id) continue;
    if (mode === "inherit") delete next[id];
    else next[id] = mode;
  }
  return next;
}

