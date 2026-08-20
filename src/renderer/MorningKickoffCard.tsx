import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Focus,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Task } from "../shared/models";

export interface MorningKickoffPreset {
  capacityMinutes: number;
  taskIds: string[];
  focusFirst: boolean;
}

interface MorningKickoffCardProps {
  tasks: readonly Task[];
  onOpenPlan: (preset: MorningKickoffPreset) => void;
  onStartFocus: (task: Task) => void | Promise<void>;
}

const CAPACITY_OPTIONS = [
  { value: 60, label: "1 小时", hint: "只守住一件小事" },
  { value: 120, label: "2 小时", hint: "轻量推进" },
  { value: 240, label: "4 小时", hint: "完整半天" },
  { value: 360, label: "6 小时", hint: "今天空间充足" },
] as const;

const openTaskCandidates = (tasks: readonly Task[]): Task[] =>
  tasks
    .filter((task) => task.status === "open" && !task.deletedAt)
    .toSorted(
      (left, right) =>
        left.privateOrder - right.privateOrder ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 6);

export function MorningKickoffCard({
  tasks,
  onOpenPlan,
  onStartFocus,
}: MorningKickoffCardProps) {
  const candidates = useMemo(() => openTaskCandidates(tasks), [tasks]);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [capacityMinutes, setCapacityMinutes] = useState(240);
  const [focusFirst, setFocusFirst] = useState(true);

  useEffect(() => {
    setSelectedIds((current) => {
      const stillVisible = current.filter((id) => candidates.some((task) => task.id === id));
      if (stillVisible.length > 0 || candidates.length === 0) return stillVisible;
      return candidates.slice(0, 3).map((task) => task.id);
    });
  }, [candidates]);

  const selectedTasks = candidates.filter((task) => selectedIds.includes(task.id));
  const firstTask = selectedTasks[0] ?? candidates[0];
  const toggleTask = (taskId: string) => {
    setSelectedIds((current) =>
      current.includes(taskId)
        ? current.filter((id) => id !== taskId)
        : current.length >= 3
          ? current
          : [...current, taskId],
    );
  };
  const next = () => setStep((current) => (current === 1 ? 2 : 3));
  const back = () => setStep((current) => (current === 3 ? 2 : 1));

  return (
    <section className="morning-kickoff" aria-label="晨间三步启动">
      <div className="morning-kickoff-heading">
        <div className="morning-kickoff-mark" aria-hidden="true">
          <Sparkles size={16} />
        </div>
        <div>
          <strong>和宠物一起开启今天</strong>
          <small>三步确定节奏，可随时跳过，不会自动修改任务。</small>
        </div>
        <span className="morning-kickoff-progress">{step}/3</span>
      </div>

      {step === 1 && (
        <div className="morning-kickoff-step">
          <div className="morning-kickoff-question">
            <strong>今天最想守住哪几件事？</strong>
            <small>最多选择 3 项，稍后会预先带入规划。</small>
          </div>
          {candidates.length > 0 ? (
            <div className="morning-kickoff-task-list" role="group" aria-label="今天优先任务">
              {candidates.map((task) => {
                const selected = selectedIds.includes(task.id);
                return (
                  <button
                    type="button"
                    key={task.id}
                    className={`morning-kickoff-task ${selected ? "is-selected" : ""}`}
                    aria-pressed={selected}
                    onClick={() => toggleTask(task.id)}
                  >
                    <span className="morning-kickoff-check" aria-hidden="true">
                      {selected && <Check size={13} />}
                    </span>
                    <span>{task.title}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="morning-kickoff-empty">还没有开放任务，可以先用快速捕获记下一件小事。</p>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="morning-kickoff-step">
          <div className="morning-kickoff-question">
            <strong>今天大约有多少可用时间？</strong>
            <small>这只是规划容量，不会创建日历事件。</small>
          </div>
          <div className="morning-kickoff-capacity" role="group" aria-label="今天可用时间">
            {CAPACITY_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                className={capacityMinutes === option.value ? "is-selected" : ""}
                aria-pressed={capacityMinutes === option.value}
                onClick={() => setCapacityMinutes(option.value)}
              >
                <Clock3 size={15} aria-hidden="true" />
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="morning-kickoff-step">
          <div className="morning-kickoff-question">
            <strong>要不要先进入一段专注？</strong>
            <small>可以先打开规划，也可以直接从第一项开始。</small>
          </div>
          <div className="morning-kickoff-focus" role="group" aria-label="开始方式">
            <button
              type="button"
              className={focusFirst ? "is-selected" : ""}
              aria-pressed={focusFirst}
              onClick={() => setFocusFirst(true)}
            >
              <Focus size={16} aria-hidden="true" />
              <span><strong>先专注</strong><small>{firstTask ? `从「${firstTask.title}」开始` : "等有任务后开始"}</small></span>
            </button>
            <button
              type="button"
              className={!focusFirst ? "is-selected" : ""}
              aria-pressed={!focusFirst}
              onClick={() => setFocusFirst(false)}
            >
              <CalendarClock size={16} aria-hidden="true" />
              <span><strong>先看计划</strong><small>先确认容量和顺序</small></span>
            </button>
          </div>
          <div className="morning-kickoff-summary">
            <span>{selectedTasks.length || "未选"} 项优先任务</span>
            <span>{CAPACITY_OPTIONS.find((option) => option.value === capacityMinutes)?.label ?? `${capacityMinutes} 分钟`}</span>
            <span>{focusFirst ? "准备专注" : "先看规划"}</span>
          </div>
        </div>
      )}

      <footer className="morning-kickoff-footer">
        {step > 1 ? (
          <button type="button" className="ghost-button" onClick={back}>
            <ChevronLeft size={15} /> 返回
          </button>
        ) : (
          <span className="morning-kickoff-hint">可跳过，晚些时候再安排</span>
        )}
        <div>
          {step < 3 ? (
            <button type="button" className="primary-button" onClick={next}>
              下一步 <ChevronRight size={15} />
            </button>
          ) : (
            <>
              {focusFirst && firstTask && (
                <button
                  type="button"
                  className="soft-button"
                  onClick={() => onStartFocus(firstTask)}
                >
                  <Focus size={15} /> 开始第一项
                </button>
              )}
              <button
                type="button"
                className="primary-button"
                onClick={() => onOpenPlan({ capacityMinutes, taskIds: selectedIds, focusFirst })}
              >
                <CalendarClock size={15} /> 打开今日规划
              </button>
            </>
          )}
        </div>
      </footer>
    </section>
  );
}
