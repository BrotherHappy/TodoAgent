import {
  CalendarDays,
  Check,
  ChevronRight,
  ExternalLink,
  Inbox,
  SkipForward,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Task, UpdateTaskInput } from "../shared/models";

export interface InboxTriageSheetProps {
  tasks: readonly Task[];
  onUpdate: (id: string, patch: UpdateTaskInput) => Promise<string | undefined>;
  onComplete: (task: Task) => Promise<string | undefined>;
  onOpenTask: (id: string) => void;
  onClose: () => void;
}

const localDateKey = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const tomorrowKey = (): string => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return localDateKey(tomorrow);
};

/**
 * A deliberately small Inbox ritual inspired by Akiflow's Universal Inbox
 * and Things' Inbox. It never creates a second task list: actions only update
 * the current task through the normal controller, and "稍后" is a local view
 * decision that leaves the task untouched.
 */
export function InboxTriageSheet({
  tasks,
  onUpdate,
  onComplete,
  onOpenTask,
  onClose,
}: InboxTriageSheetProps) {
  const [initialTotal] = useState(
    () =>
      tasks.filter(
        (candidate) =>
          candidate.status === "open" &&
          !candidate.deletedAt &&
          !candidate.plannedDate &&
          !candidate.projectId &&
          !candidate.listId,
      ).length,
  );
  const [processedIds, setProcessedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [index, setIndex] = useState(0);
  const queue = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.status === "open" &&
          !task.deletedAt &&
          !task.plannedDate &&
          !task.projectId &&
          !task.listId &&
          !processedIds.has(task.id),
      ),
    [processedIds, tasks],
  );
  const task = queue[index];
  const processedCount = Math.min(
    initialTotal,
    Math.max(0, initialTotal - queue.length),
  );

  useEffect(() => {
    if (index >= queue.length && queue.length > 0) {
      setIndex(queue.length - 1);
    }
  }, [index, queue.length]);

  const markProcessed = (id: string) => {
    setProcessedIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    setError(undefined);
  };

  const run = async (action: () => Promise<void>) => {
    if (!task || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂存整理失败");
    } finally {
      setBusy(false);
    }
  };

  const planFor = (date: string) => {
    void run(async () => {
      await onUpdate(task!.id, { plannedDate: date });
      markProcessed(task!.id);
      setError(undefined);
    });
  };

  const complete = () => {
    void run(async () => {
      await onComplete(task!);
      markProcessed(task!.id);
    });
  };

  const skip = () => {
    if (!task || busy) return;
    markProcessed(task.id);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) onClose();
        return;
      }
      if (!task || busy || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const key = event.key.toLocaleLowerCase();
      if (key === "1") {
        event.preventDefault();
        planFor(localDateKey());
      } else if (key === "2") {
        event.preventDefault();
        planFor(tomorrowKey());
      } else if (key === "s") {
        event.preventDefault();
        skip();
      } else if (key === "c") {
        event.preventDefault();
        complete();
      } else if (key === "o") {
        event.preventDefault();
        onOpenTask(task.id);
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, onOpenTask, task]);

  return (
    <div className="modal-backdrop inbox-triage-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section
        className="modal-sheet inbox-triage-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inbox-triage-title"
        aria-busy={busy}
      >
        <header className="inbox-triage-header">
          <div className="inbox-triage-mark" aria-hidden="true"><Inbox size={20} /></div>
          <div>
            <span>暂存整理</span>
            <h2 id="inbox-triage-title">把想法放到合适的位置</h2>
            <p>{queue.length ? `还剩 ${queue.length} 件，每次只处理一件。` : "这一轮已经整理完了。"}</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭暂存整理" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        {task ? (
          <>
            <div className="inbox-triage-progress" aria-label={`已处理 ${processedCount} 项，剩余 ${queue.length} 项`}>
              <span style={{ width: `${initialTotal ? Math.round((processedCount / initialTotal) * 100) : 100}%` }} />
            </div>
            <article className="inbox-triage-card">
              <small>{task.source.type === "feishu" ? "飞书任务" : "本地任务"} · 还没有安排日期</small>
              <h3>{task.title}</h3>
              {task.notes.trim() && <p>{task.notes.trim().slice(0, 240)}</p>}
              <div className="inbox-triage-actions" aria-label="暂存整理动作">
                <button type="button" className="primary-button" disabled={busy} onClick={() => planFor(localDateKey())}>
                  <CalendarDays size={16} /> 今天 <kbd>1</kbd>
                </button>
                <button type="button" className="soft-button" disabled={busy} onClick={() => planFor(tomorrowKey())}>
                  <ChevronRight size={16} /> 明天 <kbd>2</kbd>
                </button>
                <button type="button" className="ghost-button" disabled={busy} onClick={skip}>
                  <SkipForward size={16} /> 稍后 <kbd>S</kbd>
                </button>
                <button type="button" className="ghost-button" disabled={busy} onClick={complete}>
                  <Check size={16} /> 完成 <kbd>C</kbd>
                </button>
              </div>
              <button type="button" className="inbox-triage-open" disabled={busy} onClick={() => { onOpenTask(task.id); onClose(); }}>
                <ExternalLink size={14} /> 打开详情 <kbd>O</kbd>
              </button>
            </article>
          </>
        ) : (
          <div className="inbox-triage-empty" role="status">
            <Check size={30} />
            <strong>暂存清爽了</strong>
            <p>刚才跳过的任务仍然保留在暂存，不会被删除。</p>
            <button type="button" className="primary-button" onClick={onClose}>回到任务列表</button>
          </div>
        )}
        {error && <p className="inbox-triage-error" role="alert">{error}</p>}
        <footer className="inbox-triage-footer">
          <span>快捷键：1 今天 · 2 明天 · S 稍后 · C 完成 · O 打开</span>
          <button type="button" className="ghost-button" disabled={busy} onClick={onClose}>稍后整理</button>
        </footer>
      </section>
    </div>
  );
}
