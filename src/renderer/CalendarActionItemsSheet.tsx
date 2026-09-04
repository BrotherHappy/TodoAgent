import { CalendarClock, Check, ListChecks, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent } from "../shared/calendar-events";
import type { CalendarActionItemDraft } from "../shared/calendar-action-items";
import { useDialogFocus } from "./dialog-focus";

interface ActionItemRow extends CalendarActionItemDraft {
  selected: boolean;
}

export interface CalendarActionItemsSheetProps {
  event: CalendarEvent;
  drafts: readonly CalendarActionItemDraft[];
  onClose: () => void;
  onConfirm: (items: CalendarActionItemDraft[]) => Promise<void>;
}

const eventTimeLabel = (event: CalendarEvent): string => {
  if (event.allDay) return "全天";
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "时间未知";
  const format = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `${format.format(start)}–${format.format(end)}`;
};

export function CalendarActionItemsSheet({
  event,
  drafts,
  onClose,
  onConfirm,
}: CalendarActionItemsSheetProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ActionItemRow[]>(() =>
    drafts.map((draft) => ({ ...draft, selected: true })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const selectedCount = useMemo(
    () => rows.filter((row) => row.selected && row.title.trim()).length,
    [rows],
  );

  useDialogFocus(dialogRef, firstInputRef, () => {
    if (!saving) onClose();
  });

  useEffect(() => {
    setRows(drafts.map((draft) => ({ ...draft, selected: true })));
    setError(undefined);
  }, [drafts]);

  const confirm = async () => {
    const items = rows
      .filter((row) => row.selected && row.title.trim())
      .map(({ selected: _selected, ...draft }) => ({
        ...draft,
        title: draft.title.trim(),
      }));
    if (!items.length || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onConfirm(items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建行动任务失败");
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
        className="modal-sheet calendar-action-items-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="会议行动项预览"
        aria-busy={saving}
        tabIndex={-1}
      >
        <div className="modal-header">
          <span className="feature-icon">
            <ListChecks size={20} />
          </span>
          <div>
            <h2>会议行动项</h2>
            <p>从备注中识别出的待办，确认后只创建本地任务。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭会议行动项预览"
            title="关闭"
            disabled={saving}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="calendar-action-items-context">
            <strong>{event.summary}</strong>
            <span><CalendarClock size={14} /> {eventTimeLabel(event)} · {event.sourceName || "本地日历"}</span>
          </div>
          {rows.length ? (
            <div className="calendar-action-item-list">
              {rows.map((row, index) => (
                <div className={`calendar-action-item-row ${row.selected ? "is-selected" : ""}`} key={row.id}>
                  <label className="calendar-action-item-check">
                    <input
                      type="checkbox"
                      checked={row.selected}
                      disabled={saving}
                      aria-label={`选择行动项 ${index + 1}`}
                      onChange={(event) => {
                        const selected = event.target.checked;
                        setRows((current) => current.map((candidate) =>
                          candidate.id === row.id ? { ...candidate, selected } : candidate,
                        ));
                      }}
                    />
                    <span aria-hidden="true"><Check size={13} /></span>
                  </label>
                  <div className="calendar-action-item-content">
                    <label htmlFor={`calendar-action-item-${row.id}`}>行动项 {index + 1}</label>
                    <input
                      ref={index === 0 ? firstInputRef : undefined}
                      id={`calendar-action-item-${row.id}`}
                      className="field-input"
                      value={row.title}
                      disabled={saving}
                      onChange={(event) => {
                        const title = event.target.value;
                        setRows((current) => current.map((candidate) =>
                          candidate.id === row.id ? { ...candidate, title } : candidate,
                        ));
                      }}
                    />
                    <small>{row.plannedDate ? `计划日期：${row.plannedDate}` : "未指定计划日期"}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="calendar-action-items-empty">备注中没有识别到明确行动项。</div>
          )}
          <div className="calendar-action-items-note">
            <span>不会写回日历，也不会创建飞书任务。</span>
            {error && <strong role="alert">{error}</strong>}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="soft-button" disabled={saving} onClick={onClose}>取消</button>
          <span className="action-spacer" />
          <button
            type="button"
            className="primary-button"
            disabled={saving || selectedCount === 0}
            onClick={() => void confirm()}
          >
            {saving ? "正在创建…" : `创建 ${selectedCount} 项本地任务`}
          </button>
        </div>
      </section>
    </div>
  );
}
