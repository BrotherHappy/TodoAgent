import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Loader2,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import type { AgentToolActivity, AgentToolActivityStatus } from "./use-agent-chat";

const statusLabels: Record<AgentToolActivityStatus, string> = {
  proposed: "已拟定",
  "awaiting-approval": "等待确认",
  running: "执行中",
  succeeded: "已完成",
  failed: "未完成",
  denied: "已拒绝",
  cancelled: "已停止",
  replayed: "已复用结果",
};

const toolFamilyLabel = (toolName: string): string => {
  if (toolName.startsWith("task_")) return "任务工具";
  if (["web_search", "http_fetch", "url_open"].includes(toolName)) {
    return "网页研究";
  }
  if (toolName.startsWith("file_") || toolName === "terminal_run") {
    return "文件与终端";
  }
  if (toolName.startsWith("clipboard_") || toolName.startsWith("screen_")) {
    return "剪贴板与屏幕";
  }
  return "Agent 工具";
};

const previewText = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
};

const iconFor = (status: AgentToolActivityStatus) => {
  if (status === "running") return <Loader2 size={15} className="spin" aria-hidden="true" />;
  if (status === "succeeded" || status === "replayed") {
    return <CheckCircle2 size={15} aria-hidden="true" />;
  }
  if (status === "failed" || status === "denied" || status === "cancelled") {
    return <CircleAlert size={15} aria-hidden="true" />;
  }
  if (status === "awaiting-approval") {
    return <ShieldAlert size={15} aria-hidden="true" />;
  }
  return <Clock3 size={15} aria-hidden="true" />;
};

export function AgentRunActivity({
  activities,
  active,
}: {
  activities: readonly AgentToolActivity[];
  active: boolean;
}) {
  if (activities.length === 0) return null;
  return (
    <section className="agent-run-activity" aria-label="Agent 执行过程">
      <div className="agent-run-activity-heading">
        <div>
          <Wrench size={15} aria-hidden="true" />
          <strong>执行过程</strong>
        </div>
        <span>{active ? "进行中" : "已结束"}</span>
      </div>
      <ol className="agent-run-activity-list" aria-live="polite">
        {activities.map((activity, index) => {
          const detail = previewText(activity.preview);
          return (
            <li
              key={`${activity.invocationId ?? activity.providerCallId ?? activity.toolName}-${index}`}
              className={`agent-run-activity-item is-${activity.status}`}
            >
              <span className="agent-run-activity-icon">
                {iconFor(activity.status)}
              </span>
              <div className="agent-run-activity-copy">
                <div className="agent-run-activity-title">
                  <strong>{toolFamilyLabel(activity.toolName)}</strong>
                  {activity.risk && <span>{activity.risk}</span>}
                </div>
                <small>
                  {statusLabels[activity.status]} · <code>{activity.toolName}</code>
                  {activity.errorCode ? ` · ${activity.errorCode}` : ""}
                </small>
                {detail && (
                  <details className="agent-run-activity-preview">
                    <summary>查看影响预览</summary>
                    <pre>{detail}</pre>
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
