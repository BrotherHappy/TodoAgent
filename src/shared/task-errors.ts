/** Convert known task failures to recovery instructions, never raw Electron
 * method names, stack traces, Zod payloads, paths or credential-bearing URLs. */
export function taskOperationErrorMessage(reason: unknown, fallback = '操作暂时未完成，请刷新任务后重试。'): string {
  let message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  message = message.replace(/^Error:\s*/u, '')
    .replace(/^Error invoking remote method '[^']*':\s*/u, '')
    .replace(/^(?:[A-Za-z_$][\w$]*)?Error:\s*/u, '').trim();
  if (/Task title cannot be empty|title cannot be cleared/u.test(message)) return '有任务暂缺标题。请刷新任务；若仍未恢复，请在任务详情或飞书中补全标题后重试。';
  if (/Task not found|Task is not open|Task is in trash/u.test(message)) return '有任务已完成、移入回收站或不存在，请刷新任务后重新预览。';
  if (/changed afterwards/u.test(message)) return '任务已被后续修改，无法安全撤销或重做。请刷新后确认最新状态。';
  if (/There is no operation to (?:undo|redo)/u.test(message)) return '当前没有可撤销或重做的任务变更。';
  if (/Today plan estimates|estimatedMinutes must/u.test(message)) return '预计时长需为 5–720 分钟的整数，请调整后重试。';
  if (/Today plan contains duplicate|same Today plan|Today plan must include/u.test(message)) return '计划中的任务发生了变化，请刷新任务后重新预览。';
  if (/Today plan cannot change more than/u.test(message)) return '一次最多安排 500 项任务，请分批处理。';
  if (/must be a local date|must use YYYY-MM-DD|must be a valid (?:date|calendar date)/u.test(message)) return '计划日期无效，请重新选择日期。';
  if (/ENOSPC/u.test(message)) return '磁盘空间不足，暂时无法保存。请释放一些空间后重试。';
  if (/EACCES|EPERM/u.test(message)) return '暂时无法写入本地数据，请检查应用的数据目录权限后重试。';
  // Preserve short, intentional Chinese domain messages (e.g. stale plan
  // conflicts), while hiding transport/debug details and sensitive strings.
  if (/\p{Script=Han}/u.test(message) && message.length <= 280 &&
      !/[\r\n]|https?:\/\/|file:\/\/|Bearer\s|sk-[\w-]+|Error invoking|\bat\s+[\w$.]+\s*\(/iu.test(message)) return message;
  return fallback;
}
