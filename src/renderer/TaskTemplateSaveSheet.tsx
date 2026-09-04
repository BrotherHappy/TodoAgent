import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Task } from "../shared/models";
import {
  buildTaskTemplateFromTask,
  taskTemplateTextSupportsVariables,
  type TaskTemplate,
} from "./task-templates";
import { useDialogFocus } from "./dialog-focus";

export interface TaskTemplateSaveSheetProps {
  task: Task;
  subtasks?: readonly Task[];
  onClose: () => void;
  onConfirm: (template: TaskTemplate) => Promise<void>;
}

const MAX_NAME_CHARS = 40;
const MAX_DESCRIPTION_CHARS = 200;

const templateIdFor = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 24);
  const suffix = Date.now().toString(36).slice(-8);
  const base = slug || "task-template";
  return `${base}-${suffix}`.slice(0, 40);
};

export function TaskTemplateSaveSheet({
  task,
  subtasks = [],
  onClose,
  onConfirm,
}: TaskTemplateSaveSheetProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(task.title.slice(0, MAX_NAME_CHARS));
  const [description, setDescription] = useState(
    "从现有任务保存的本地模板，可在快速录入中继续复用。",
  );
  const [includeSubtasks, setIncludeSubtasks] = useState(subtasks.length > 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const notesCanBeCopied = !task.notes.trim() || taskTemplateTextSupportsVariables(task.notes);

  useDialogFocus(dialogRef, nameInputRef, () => {
    if (!saving) onClose();
  });

  useEffect(() => {
    setName(task.title.slice(0, MAX_NAME_CHARS));
    setDescription("从现有任务保存的本地模板，可在快速录入中继续复用。");
    setSaving(false);
    setError(undefined);
    setIncludeSubtasks(subtasks.length > 0);
  }, [subtasks.length, task.id, task.title]);

  const confirm = async (): Promise<void> => {
    if (saving) return;
    const nextName = name.trim();
    const nextDescription = description.trim();
    if (!nextName) {
      setError("请先填写模板名称");
      return;
    }
    if (nextName.length > MAX_NAME_CHARS) {
      setError(`模板名称最多 ${MAX_NAME_CHARS} 个字符`);
      return;
    }
    if (nextDescription.length > MAX_DESCRIPTION_CHARS) {
      setError(`模板说明最多 ${MAX_DESCRIPTION_CHARS} 个字符`);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onConfirm(
        buildTaskTemplateFromTask(task, {
          id: templateIdFor(nextName),
          name: nextName,
          description: nextDescription,
          subtasks,
          includeSubtasks,
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存模板失败");
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
        className="modal-sheet task-template-save-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="保存为工作流模板"
        aria-busy={saving}
        tabIndex={-1}
      >
        <div className="modal-header">
          <span className="feature-icon">
            <Copy size={20} />
          </span>
          <div>
            <h2>保存为工作流模板</h2>
            <p>下次录入相似任务时，可以一键复用这份设置。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭模板保存"
            title="关闭"
            disabled={saving}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="task-template-save-context">
            <strong>{task.title}</strong>
            <span>
              {notesCanBeCopied
                ? "会保留备注、标签、优先级和预计时长；"
                : "备注中包含模板不支持的变量，本次不会带入该备注；"}
              具体日期、完成状态、附件及同步身份不会复制。
            </span>
          </div>
          <div className="task-template-save-form">
            <label>
              模板名称
              <input
                ref={nameInputRef}
                className="field-input"
                aria-label="模板名称"
                value={name}
                maxLength={MAX_NAME_CHARS}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
              <small>{name.length}/{MAX_NAME_CHARS}</small>
            </label>
            <label>
              模板说明（可选）
              <textarea
                className="field-textarea"
                aria-label="模板说明（可选）"
                value={description}
                maxLength={MAX_DESCRIPTION_CHARS}
                disabled={saving}
                onChange={(event) => setDescription(event.target.value)}
              />
              <small>{description.length}/{MAX_DESCRIPTION_CHARS}</small>
            </label>
            {subtasks.length > 0 && (
              <label className="task-template-save-checkbox">
                <span>
                  <input
                    type="checkbox"
                    checked={includeSubtasks}
                    disabled={saving}
                    onChange={(event) => setIncludeSubtasks(event.target.checked)}
                  />
                  <strong>包含 {subtasks.length} 个子任务</strong>
                </span>
                <small>使用模板时会按同样的父子关系创建本地任务。</small>
              </label>
            )}
          </div>
          <div className="task-template-save-preview">
            <span>
              模板会创建 {includeSubtasks ? Math.min(subtasks.length, 11) + 1 : 1} 个本地步骤
            </span>
            <strong>{"{{title}}"}</strong>
            {includeSubtasks && (
              <ul>
                {subtasks.slice(0, 11).map((subtask) => (
                  <li key={subtask.id}>{subtask.title}</li>
                ))}
              </ul>
            )}
            <small>
              使用时输入新标题，任务会自动排到当天。
              {includeSubtasks && subtasks.length > 11 ? "最多带入 11 个子任务。" : ""}
            </small>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-actions">
          <button type="button" className="soft-button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <span className="action-spacer" />
          <button
            type="button"
            className="primary-button"
            disabled={saving}
            onClick={() => void confirm()}
          >
            {saving ? "正在保存…" : <><Check size={15} /> 保存本地模板</>}
          </button>
        </div>
      </section>
    </div>
  );
}
