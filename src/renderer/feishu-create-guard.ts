import type { TaskSourceType } from "../shared/models";
import type { FeishuStatusView } from "../shared/desktop-api";

/**
 * A task explicitly destined for Feishu must never quietly become a local
 * task, nor be queued without a verified account connection. Keep this guard
 * shared by every task-creation surface so their behaviour cannot drift.
 */
export function feishuCreationBlockedMessage(
  source: TaskSourceType,
  status?: Pick<FeishuStatusView, "configured" | "connected">,
): string | undefined {
  if (source !== "feishu" || status?.connected) return undefined;
  return status?.configured
    ? "飞书尚未连接，请先在设置中完成授权；不会创建成本地任务"
    : "请先在设置中配置飞书，现有本地任务不会被上传";
}
