import {
  Clipboard,
  ClipboardCheck,
  History,
  Link,
  PanelTop,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { ContextCaptureHistoryItem } from "./context-capture-history";

const kindLabels: Record<ContextCaptureHistoryItem["kind"], string> = {
  clipboard: "剪贴板",
  window: "当前窗口",
  "selected-text": "选中文本",
  "drop-text": "拖入文本",
  url: "拖入链接",
  "agent-reply": "Agent 回复",
};

const kindIcons: Record<ContextCaptureHistoryItem["kind"], typeof Clipboard> = {
  clipboard: Clipboard,
  window: PanelTop,
  "selected-text": ClipboardCheck,
  "drop-text": ClipboardCheck,
  url: Link,
  "agent-reply": Sparkles,
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

export function ContextCaptureHistory({
  items,
  onSelect,
  onClear,
}: {
  items: readonly ContextCaptureHistoryItem[];
  onSelect: (item: ContextCaptureHistoryItem) => void;
  onClear: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="context-history-card" aria-label="最近上下文">
      <div className="context-capture-heading">
        <div>
          <strong><History size={14} /> 最近上下文</strong>
          <small>只保存你明确点击保存的内容，全部保存在本机</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="清空最近上下文"
          onClick={onClear}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="context-history-list">
        {items.slice(0, 6).map((item) => {
          const Icon = kindIcons[item.kind];
          return (
            <button
              type="button"
              className="context-history-item"
              key={item.id}
              onClick={() => onSelect(item)}
              title="带入输入框"
            >
              <Icon size={14} aria-hidden="true" />
              <span>
                <strong>{item.label}</strong>
                <small>{kindLabels[item.kind]} · {historyDateLabel(item.createdAt)}</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
