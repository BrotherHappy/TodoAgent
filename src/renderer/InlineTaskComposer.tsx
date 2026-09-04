import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TaskMutationResult, TaskView } from "../shared/models";
import type { TaskController } from "./task-controller";

export type InlineTaskComposerRoute = Extract<TaskView, "today" | "inbox" | "all">;
type InlineTaskComposerCreatedHandler = (
  result: TaskMutationResult,
) => boolean | void | Promise<boolean | void>;

type InlineTaskComposerToastKind = "success" | "error" | "info";

const dateKey = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const routeCopy: Record<
  InlineTaskComposerRoute,
  { placeholder: string; destination: string; success: string }
> = {
  today: {
    placeholder: "添加一件今天要做的事…",
    destination: "今天",
    success: "已添加到今天",
  },
  inbox: {
    placeholder: "先记下来，稍后再整理…",
    destination: "暂存",
    success: "已保存到暂存",
  },
  all: {
    placeholder: "快速记录一件事…",
    destination: "本地任务",
    success: "已创建本地任务",
  },
};

export function InlineTaskComposer({
  route,
  controller,
  notify,
  placement = "top",
  afterTaskTitle,
  autoFocus = false,
  onCancel,
  onCreated,
}: {
  route: InlineTaskComposerRoute;
  controller: TaskController;
  notify: (message: string, kind?: InlineTaskComposerToastKind) => void;
  placement?: "top" | "after";
  afterTaskTitle?: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  onCreated?: InlineTaskComposerCreatedHandler;
}) {
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const refocusAfterSubmitRef = useRef(false);
  const copy = routeCopy[route];
  const isAfterComposer = placement === "after" && Boolean(afterTaskTitle);
  const hintId = isAfterComposer
    ? "inline-task-composer-hint-after"
    : "inline-task-composer-hint";

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!refocusAfterSubmitRef.current || submitting || title !== "") return;
    refocusAfterSubmitRef.current = false;
    inputRef.current?.focus();
  }, [submitting, title]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || submitting) return;

    setSubmitting(true);
    try {
      const result = await controller.create(
        {
          title: nextTitle,
          source: { type: "local" },
          ...(route === "today" ? { plannedDate: dateKey() } : {}),
          sync: { status: "local" },
        },
        { selectCreated: false },
      );
      let handledByParent = false;
      if (result?.task && onCreated) {
        handledByParent = (await onCreated(result)) === true;
      }
      setTitle("");
      refocusAfterSubmitRef.current = true;
      if (!handledByParent) notify(copy.success, "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "快速添加失败", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className={`inline-task-composer ${isAfterComposer ? "inline-task-composer-after" : ""}`}
      onSubmit={(event) => void submit(event)}
      aria-label={
        isAfterComposer
          ? `在“${afterTaskTitle}”后快速添加到${copy.destination}`
          : `快速添加到${copy.destination}`
      }
      aria-busy={submitting}
    >
      <span className="inline-task-composer-icon" aria-hidden="true">
        <Plus size={16} />
      </span>
      <div className="inline-task-composer-field">
        <input
          ref={inputRef}
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing && onCancel) {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
              return;
            }
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          placeholder={
            isAfterComposer ? "在当前任务后添加一件事…" : copy.placeholder
          }
          aria-label="快速添加任务"
          aria-describedby={hintId}
          autoFocus={autoFocus}
          disabled={submitting}
        />
        <span id={hintId} className="inline-task-composer-hint">
          {isAfterComposer ? "回车插入 · Esc 取消 · 仅本地" : "回车保存 · 仅本地"}
        </span>
      </div>
      {isAfterComposer && onCancel && (
        <button
          type="button"
          className="icon-button inline-task-composer-cancel"
          onClick={onCancel}
          aria-label="取消当前任务后新增"
          title="取消（Esc）"
          disabled={submitting}
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
      <button
        type="submit"
        className="primary-button inline-task-composer-submit"
        disabled={!title.trim() || submitting}
      >
        <Plus size={15} aria-hidden="true" />
        {submitting ? "保存中…" : "添加"}
      </button>
    </form>
  );
}
