/** Provider data can predate our input validation. A display fallback is
 * never persisted or sent to Feishu as a replacement title. */
export function hasTaskTitle(value: unknown): value is string {
  return typeof value === 'string' && value.replace(/[\p{White_Space}\p{Cf}\p{Cc}]/gu, '').length > 0;
}

export function taskTitleForDisplay(task: { title?: unknown; source?: { type: string } }): string {
  if (hasTaskTitle(task.title)) return task.title.trim();
  return task.source?.type === 'feishu' ? '待补全标题的飞书任务' : '待补全标题的任务';
}
