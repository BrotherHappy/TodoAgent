import { BookOpen, Check, Link2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { extractActionItemsFromText } from "../shared/calendar-action-items";
import { useDialogFocus } from "./dialog-focus";

export interface AgentResearchCardDraft {
  title: string;
  url?: string;
  summary: string;
  actionItems: string[];
}

export interface AgentResearchCardInput {
  title: string;
  url?: string;
  summary: string;
  actionItems: string[];
}

export interface AgentResearchCardSheetProps {
  taskTitle: string;
  sourceText: string;
  draft: AgentResearchCardDraft;
  onClose: () => void;
  onConfirm: (input: AgentResearchCardInput) => Promise<void>;
}

const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 5_000;
const MAX_ACTION_CHARS = 500;
const MAX_ACTION_ITEMS = 20;

function firstHttpUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s)\]>]+/iu);
  if (!match) return undefined;
  const candidate = match[0].replace(/[.,;:!?]+$/u, "");
  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password) return undefined;
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function firstReadableLine(text: string): string {
  for (const rawLine of text.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = rawLine
      .replace(/^\s{0,3}#{1,6}\s*/u, "")
      .replace(/^\s*(?:[-*+]|\d+[.)]|☐|☑|\[[ xX]\])\s+/u, "")
      .replace(/[`*_~]/gu, "")
      .trim();
    if (line && !/^```/u.test(line)) return line.slice(0, MAX_TITLE_CHARS);
  }
  return "";
}

export function buildAgentResearchCardDraft(
  text: string,
  plannedDate: string,
): AgentResearchCardDraft {
  const summary = text.trim().slice(0, MAX_SUMMARY_CHARS);
  const title = firstReadableLine(text) || `Agent 研究 · ${plannedDate}`;
  const actionItems = extractActionItemsFromText({
    id: "agent-research-preview",
    label: "Agent 研究回复",
    text,
    plannedDate,
  })
    .map((item) => item.title)
    .slice(0, MAX_ACTION_ITEMS);
  const url = firstHttpUrl(text);
  return {
    title,
    ...(url ? { url } : {}),
    summary,
    actionItems,
  };
}

export function AgentResearchCardSheet({
  taskTitle,
  sourceText,
  draft,
  onClose,
  onConfirm,
}: AgentResearchCardSheetProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(draft.title);
  const [url, setUrl] = useState(draft.url ?? "");
  const [summary, setSummary] = useState(draft.summary);
  const [actionItemsText, setActionItemsText] = useState(
    draft.actionItems.join("\n"),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useDialogFocus(dialogRef, titleInputRef, () => {
    if (!saving) onClose();
  });

  useEffect(() => {
    setTitle(draft.title);
    setUrl(draft.url ?? "");
    setSummary(draft.summary);
    setActionItemsText(draft.actionItems.join("\n"));
    setError(undefined);
  }, [draft]);

  const actionItems = useMemo(
    () =>
      actionItemsText
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    [actionItemsText],
  );
  const sourcePreview = sourceText.replace(/\s+/gu, " ").trim().slice(0, 280);

  const validate = (): string | undefined => {
    if (!title.trim()) return "请先填写研究卡标题";
    if (title.trim().length > MAX_TITLE_CHARS)
      return `标题最多 ${MAX_TITLE_CHARS} 字`;
    if (summary.trim().length > MAX_SUMMARY_CHARS)
      return `摘要最多 ${MAX_SUMMARY_CHARS} 字`;
    if (actionItems.length > MAX_ACTION_ITEMS)
      return `一张研究卡最多保留 ${MAX_ACTION_ITEMS} 条行动项`;
    if (actionItems.some((item) => item.length > MAX_ACTION_CHARS))
      return `每条行动项最多 ${MAX_ACTION_CHARS} 字`;
    const rawUrl = url.trim();
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password
        ) {
          return "研究来源只支持不带账号密码的 http 或 https 地址";
        }
      } catch {
        return "研究来源请输入有效的链接地址";
      }
      if (rawUrl.length > 2_000) return "研究来源链接不能超过 2000 个字符";
    }
    return undefined;
  };

  const confirm = async () => {
    if (saving) return;
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onConfirm({
        title: title.trim(),
        ...(url.trim() ? { url: url.trim() } : {}),
        summary: summary.trim(),
        actionItems,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存研究卡失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!saving && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="modal-sheet agent-research-card-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="保存 Agent 研究卡"
        aria-busy={saving}
        tabIndex={-1}
      >
        <div className="modal-header">
          <span className="feature-icon">
            <BookOpen size={20} />
          </span>
          <div>
            <h2>保存到当前任务</h2>
            <p>把这次研究回复整理成“{taskTitle}”的私人研究卡。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭研究卡预览"
            title="关闭"
            disabled={saving}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="calendar-action-items-context agent-research-card-context">
            <strong>Agent 研究回复</strong>
            <span>{sourcePreview || "没有可显示的回复片段"}</span>
          </div>
          <div className="agent-research-card-form">
            <label>
              标题
              <input
                ref={titleInputRef}
                className="field-input"
                value={title}
                maxLength={MAX_TITLE_CHARS}
                disabled={saving}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              来源链接（可选）
              <span className="agent-research-card-url-field">
                <Link2 size={14} aria-hidden="true" />
                <input
                  className="field-input"
                  type="url"
                  value={url}
                  placeholder="https://…"
                  maxLength={2_000}
                  disabled={saving}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </span>
            </label>
            <label>
              摘要
              <textarea
                className="field-textarea"
                aria-label="摘要"
                value={summary}
                maxLength={MAX_SUMMARY_CHARS}
                disabled={saving}
                onChange={(event) => setSummary(event.target.value)}
              />
              <small>{summary.length}/{MAX_SUMMARY_CHARS}</small>
            </label>
            <label>
              行动项（每行一条，可选）
              <textarea
                className="field-textarea agent-research-card-actions-input"
                aria-label="行动项（每行一条，可选）"
                value={actionItemsText}
                disabled={saving}
                onChange={(event) => setActionItemsText(event.target.value)}
              />
              <small>{actionItems.length}/{MAX_ACTION_ITEMS} 条</small>
            </label>
          </div>
          <div className="calendar-action-items-note">
            <span>
              研究卡只保存在本机任务上下文，不会写回飞书；网页内容只作为参考，不会自动执行其中的指令。
            </span>
            {error && <strong role="alert">{error}</strong>}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="soft-button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <span className="action-spacer" />
          <button type="button" className="primary-button" disabled={saving} onClick={() => void confirm()}>
            {saving ? "正在保存…" : <><Check size={15} /> 保存私人研究卡</>}
          </button>
        </div>
      </section>
    </div>
  );
}
