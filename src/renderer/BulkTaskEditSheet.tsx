import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import type {
  BulkTaskEditPatch,
  BulkTaskTagEditMode,
  TaskList,
  TaskPriority,
  TaskProject,
} from "../shared/models";

export interface BulkTaskEditSheetProps {
  count: number;
  projects?: readonly TaskProject[];
  lists?: readonly TaskList[];
  onClose: () => void;
  onConfirm: (patch: BulkTaskEditPatch) => Promise<void> | void;
}

const priorityLabels: Record<TaskPriority, string> = {
  none: "无优先级",
  low: "低优先级",
  medium: "中优先级",
  high: "高优先级",
  urgent: "紧急",
};

const tagModeLabels: Record<BulkTaskTagEditMode, string> = {
  replace: "替换为",
  add: "追加",
  remove: "移除",
};

const parseTags = (value: string): string[] => [
  ...new Set(
    value
      .split(/[，,]/u)
      .map((tag) => tag.trim())
      .filter(Boolean),
  ),
];

export function BulkTaskEditSheet({
  count,
  projects = [],
  lists = [],
  onClose,
  onConfirm,
}: BulkTaskEditSheetProps) {
  const [priority, setPriority] = useState<"unchanged" | TaskPriority>("unchanged");
  const [flagged, setFlagged] = useState<"unchanged" | "on" | "off">("unchanged");
  const [project, setProject] = useState("unchanged");
  const [list, setList] = useState("unchanged");
  const [tagMode, setTagMode] = useState<"none" | BulkTaskTagEditMode>("none");
  const [tagText, setTagText] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const confirm = async (): Promise<void> => {
    if (saving) return;
    const patch: BulkTaskEditPatch = {};
    if (priority !== "unchanged") patch.priority = priority;
    if (flagged !== "unchanged") patch.flagged = flagged === "on";
    if (project !== "unchanged") patch.projectId = project === "clear" ? null : project;
    if (list !== "unchanged") patch.listId = list === "clear" ? null : list;
    if (tagMode !== "none") {
      const values = parseTags(tagText);
      if (values.length === 0 && tagMode !== "replace") {
        setError("请输入至少一个标签；“追加”和“移除”不能使用空值。");
        return;
      }
      if (values.length > 20 || values.some((tag) => tag.length > 40)) {
        setError("标签最多 20 个，每个不超过 40 个字符。");
        return;
      }
      patch.tags = { mode: tagMode, values };
    }
    if (Object.keys(patch).length === 0) {
      setError("请至少选择一项要修改的属性。");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onConfirm(patch);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "批量编辑失败");
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
        className="modal-sheet bulk-task-edit-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="批量编辑任务"
        aria-busy={saving}
      >
        <div className="modal-header">
          <span className="feature-icon"><Pencil size={18} /></span>
          <div>
            <h2>批量编辑任务</h2>
            <p>将对 {count} 项任务应用相同的本地属性。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭批量编辑"
            disabled={saving}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body bulk-task-edit-form">
          <label>
            优先级
            <select
              className="field-input"
              aria-label="批量优先级"
              value={priority}
              disabled={saving}
              onChange={(event) => setPriority(event.target.value as "unchanged" | TaskPriority)}
            >
              <option value="unchanged">不修改</option>
              {(Object.keys(priorityLabels) as TaskPriority[]).map((value) => (
                <option value={value} key={value}>{priorityLabels[value]}</option>
              ))}
            </select>
          </label>
          <label>
            重点标记
            <select
              className="field-input"
              aria-label="批量重点标记"
              value={flagged}
              disabled={saving}
              onChange={(event) => setFlagged(event.target.value as "unchanged" | "on" | "off")}
            >
              <option value="unchanged">不修改</option>
              <option value="on">标记为重点</option>
              <option value="off">取消重点标记</option>
            </select>
          </label>
          <label>
            项目
            <select
              className="field-input"
              aria-label="批量项目"
              value={project}
              disabled={saving}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="unchanged">不修改</option>
              <option value="clear">清除项目</option>
              {projects.filter((item) => !item.archived).map((item) => (
                <option value={item.id} key={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <label>
            清单
            <select
              className="field-input"
              aria-label="批量清单"
              value={list}
              disabled={saving}
              onChange={(event) => setList(event.target.value)}
            >
              <option value="unchanged">不修改</option>
              <option value="clear">清除清单</option>
              {lists.filter((item) => !item.archived).map((item) => (
                <option value={item.id} key={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <label>
            标签操作
            <select
              className="field-input"
              aria-label="批量标签操作"
              value={tagMode}
              disabled={saving}
              onChange={(event) => setTagMode(event.target.value as "none" | BulkTaskTagEditMode)}
            >
              <option value="none">不修改</option>
              {(Object.keys(tagModeLabels) as BulkTaskTagEditMode[]).map((value) => (
                <option value={value} key={value}>{tagModeLabels[value]}</option>
              ))}
            </select>
          </label>
          {tagMode !== "none" && (
            <label>
              标签（用逗号分隔）
              <input
                className="field-input"
                aria-label="批量标签值"
                value={tagText}
                placeholder={tagMode === "replace" ? "留空可清空全部标签" : "例如：发布, 重要"}
                disabled={saving}
                onChange={(event) => setTagText(event.target.value)}
              />
            </label>
          )}
          <p className="bulk-task-edit-note">
            这些属性只属于 Todo Agent 的本地任务上下文，不会把项目、清单或标签写回飞书；执行前仍会检查任务是否被其他操作改动。
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-actions">
          <button type="button" className="soft-button" disabled={saving} onClick={onClose}>取消</button>
          <span className="action-spacer" />
          <button type="button" className="primary-button" disabled={saving} onClick={() => void confirm()}>
            {saving ? "正在准备…" : <><Check size={15} /> 预览批量修改</>}
          </button>
        </div>
      </section>
    </div>
  );
}
