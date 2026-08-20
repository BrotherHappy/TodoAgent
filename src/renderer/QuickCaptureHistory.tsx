import { History, Trash2 } from "lucide-react";
import type {
  QuickCaptureHistoryDestination,
  QuickCaptureHistoryItem,
} from "./quick-capture-history";

const destinationLabels: Record<QuickCaptureHistoryDestination, string> = {
  task: "任务",
  inbox: "暂存",
  diary: "日记",
};

function historyDateLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function QuickCaptureHistory({
  items,
  onSelect,
  onClear,
}: {
  items: readonly QuickCaptureHistoryItem[];
  onSelect: (item: QuickCaptureHistoryItem) => void;
  onClear: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="quick-history-card" aria-label="最近捕获">
      <div className="context-capture-heading">
        <div>
          <strong><History size={14} /> 最近捕获</strong>
          <small>只保存你确认过的内容，全部保存在本机</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="清空最近捕获"
          onClick={onClear}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="quick-history-list">
        {items.slice(0, 6).map((item) => (
          <button
            type="button"
            className="quick-history-item"
            key={item.id}
            onClick={() => onSelect(item)}
          >
            <strong>{item.title}</strong>
            <small>
              {destinationLabels[item.destination]} · {historyDateLabel(item.createdAt)}
            </small>
          </button>
        ))}
      </div>
    </section>
  );
}
