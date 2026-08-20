import type { Task } from "../src/shared/models";

export interface TrayTaskPreview {
  id: string;
  title: string;
}

export interface TrayTodaySummary {
  tasks: TrayTaskPreview[];
  totalOpen: number;
}

function trayTitle(title: string, privacyMode: boolean): string {
  if (privacyMode) return "私人任务";
  const normalized = title.trim() || "未命名任务";
  return normalized.length > 72 ? `${normalized.slice(0, 71)}…` : normalized;
}

/**
 * Projects the same Today task snapshot into a small tray menu preview.
 * The tray is a navigation surface, never a second task store.
 */
export function buildTrayTodaySummary(
  tasks: readonly Task[],
  options: { privacyMode?: boolean; limit?: number } = {},
): TrayTodaySummary {
  const openTasks = tasks.filter((task) => task.status === "open" && !task.deletedAt);
  const limit = Math.max(0, Math.min(5, Math.floor(options.limit ?? 3)));
  return {
    totalOpen: openTasks.length,
    tasks: openTasks.slice(0, limit).map((task) => ({
      id: task.id,
      title: trayTitle(task.title, options.privacyMode === true),
    })),
  };
}
