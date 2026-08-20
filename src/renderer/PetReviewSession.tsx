import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  Focus,
  SkipForward,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { Task } from "../shared/models";
import {
  buildPetReviewSessionItems,
  type PetReviewAction,
  type PetReviewSessionItem,
} from "./pet-review-session";

export interface PetReviewSessionProps {
  tasks: readonly Task[];
  onAction: (task: Task, action: PetReviewAction) => Promise<void>;
  onOpenTask: (task: Task) => void;
  onClose: () => void;
}

export function PetReviewSession({
  tasks,
  onAction,
  onOpenTask,
  onClose,
}: PetReviewSessionProps) {
  const items = useMemo(() => buildPetReviewSessionItems(tasks), [tasks]);
  const [index, setIndex] = useState(0);
  const [handled, setHandled] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const current: PetReviewSessionItem | undefined = items[index];
  const finished = !current;

  const advance = () => setIndex((value) => value + 1);
  const runAction = async (action: PetReviewAction) => {
    if (!current || processing) return;
    setProcessing(true);
    setError("");
    try {
      await onAction(current.task, action);
      setHandled((value) => value + 1);
      advance();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "这项任务暂时处理不了");
    } finally {
      setProcessing(false);
    }
  };
  const skip = () => {
    if (!current || processing) return;
    setError("");
    setSkipped((value) => value + 1);
    advance();
  };

  if (finished) {
    return (
      <section className="pet-review-session is-finished" aria-label="宠物回顾完成">
        <div className="pet-review-session-heading">
          <div>
            <span className="pet-review-session-kicker">回顾完成</span>
            <h2>这一轮先到这里</h2>
            <p>处理 {handled} 项，稍后再看 {skipped} 项。没有清空也没关系。</p>
          </div>
          <CheckCircle2 size={25} aria-hidden="true" />
        </div>
        <button type="button" className="primary-button" onClick={onClose}>
          <Check size={15} /> 回到小窝
        </button>
      </section>
    );
  }

  const progress = `${index + 1}/${items.length}`;
  return (
    <section className="pet-review-session" aria-label="宠物回顾会话">
      <div className="pet-review-session-heading">
        <div>
          <span className="pet-review-session-kicker">宠物回顾 · {progress}</span>
          <h2>我们一项一项看</h2>
          <p>只做一个决定：现在处理、安排今天，还是稍后再看。</p>
        </div>
        <button type="button" className="icon-button" aria-label="结束回顾" onClick={onClose} disabled={processing}>
          <X size={17} />
        </button>
      </div>
      <div className="pet-review-session-task" aria-live="polite">
        <div className="pet-review-session-task-top">
          <div className="pet-review-session-reasons">
            {current.reasons.map((reason) => <span key={reason}>{reason}</span>)}
          </div>
          <small>{current.task.priority === "urgent" ? "紧急" : current.task.priority === "high" ? "高优先级" : "开放任务"}</small>
        </div>
        <strong>{current.task.title}</strong>
        {current.task.notes && <p>{current.task.notes.slice(0, 140)}</p>}
      </div>
      {error && <div className="pet-review-session-error" role="alert">{error}</div>}
      <div className="pet-review-session-actions">
        <button type="button" className="primary-button" disabled={processing} onClick={() => void runAction("complete")}>
          <Check size={14} /> 完成
        </button>
        <button type="button" className="soft-button" disabled={processing} onClick={() => void runAction("today")}>
          <CalendarDays size={14} /> 安排今天
        </button>
        <button type="button" className="soft-button" disabled={processing} onClick={() => void runAction("focus")}>
          <Focus size={14} /> 开始专注
        </button>
        <button type="button" className="ghost-button" disabled={processing} onClick={skip}>
          <SkipForward size={14} /> 稍后
        </button>
      </div>
      <div className="pet-review-session-footer">
        <button type="button" className="ghost-button" disabled={processing} onClick={() => onOpenTask(current.task)}>
          打开任务 <ArrowRight size={13} />
        </button>
        <span>稍后仍会留在原任务列表</span>
      </div>
      {processing && <div className="pet-review-session-status" role="status">正在处理这项任务…</div>}
    </section>
  );
}
