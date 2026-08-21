import type { FeishuSyncReportView } from "../shared/desktop-api";

export type FeishuSyncSummaryTone = "success" | "warning" | "error";

export interface FeishuSyncSummary {
  modeLabel: string;
  statusLabel: string;
  detail: string;
  tone: FeishuSyncSummaryTone;
}

const issueLabels: Record<NonNullable<FeishuSyncReportView["issue"]>["code"], string> = {
  NETWORK_UNAVAILABLE: "等待网络恢复",
  RATE_LIMITED: "稍后自动重试",
  AUTH_REQUIRED: "需要重新授权",
  PERMISSION_DENIED: "需要补充飞书权限",
  SYNC_FAILED: "需要检查同步问题",
};

/**
 * Turns a sanitized sync report into a small, user-readable explanation.
 * Counts are changes in this run, not the total number of remote tasks.
 */
export function summarizeFeishuSyncReport(
  report: FeishuSyncReportView,
): FeishuSyncSummary {
  const modeLabel = report.usedFullSync ? "全量同步" : "增量同步";
  if (report.issue) {
    const issueLabel = issueLabels[report.issue.code];
    return {
      modeLabel,
      statusLabel: issueLabel,
      detail: report.offline
        ? "本地改动已保留，网络恢复后会继续。"
        : report.issue.retryable
          ? "本地改动已保留，可以稍后重试。"
          : "本地任务没有被回滚，请按同步问题中的说明处理。",
      tone: report.issue.retryable ? "warning" : "error",
    };
  }

  if (report.conflicts.length > 0) {
    return {
      modeLabel,
      statusLabel: `发现 ${report.conflicts.length} 个冲突`,
      detail: "公共字段需要你选择保留本地、使用飞书或两份都保留。",
      tone: "warning",
    };
  }

  const changed = report.pushed + report.pulled + report.deleted;
  return {
    modeLabel,
    statusLabel: changed > 0 ? "同步完成，有变化" : "同步完成，没有新变化",
    detail:
      "统计的是本次同步发生的变化；Today、排序、专注等私人字段不会写回飞书。",
    tone: "success",
  };
}
