import { useMemo } from "react";
import type { Task } from "../shared/models";
import type { PetReward } from "../shared/pet-types";
import { projectPetCompletionStamps } from "./pet-completion-stamps";

const formatStampTime = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

export function PetCompletionStampsCard({
  tasks,
  rewards,
  onOpenTask,
}: {
  tasks: readonly Task[];
  rewards: readonly PetReward[];
  onOpenTask: (task: Task) => void;
}) {
  const projection = useMemo(
    () => projectPetCompletionStamps(tasks, rewards),
    [rewards, tasks],
  );
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );

  return (
    <section className="pet-completion-stamps-card" aria-label="共同完成印章">
      <div className="pet-section-heading">
        <div>
          <h2>共同完成印章</h2>
          <p>
            今天盖下 {projection.todayCount} 枚 · 最近保留 {projection.stamps.length} 枚
          </p>
        </div>
        <span className="pet-stamp-count" aria-label={`共完成 ${projection.totalCount} 项`}>
          {projection.totalCount} 项
        </span>
      </div>
      {projection.stamps.length ? (
        <div className="pet-stamp-grid">
          {projection.stamps.map((stamp) => {
            const task = taskById.get(stamp.taskId);
            if (!task) return null;
            return (
              <button
                type="button"
                className={`pet-stamp ${stamp.isToday ? "is-today" : ""}`}
                key={stamp.taskId}
                onClick={() => onOpenTask(task)}
                aria-label={`${stamp.label}：${stamp.title}`}
                title="打开原任务"
              >
                <span className="pet-stamp-mark" aria-hidden="true">{stamp.icon}</span>
                <span className="pet-stamp-copy">
                  <strong>{stamp.title}</strong>
                  <small>
                    {stamp.label} · {formatStampTime(stamp.completedAt)}
                    {!stamp.rewardRecorded && " · 成长记录同步中"}
                  </small>
                </span>
                <span className="pet-stamp-arrow" aria-hidden="true">↗</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="pet-completion-stamps-empty">
          完成第一件任务后，宠物会为你盖下一枚小印章。
        </div>
      )}
    </section>
  );
}

