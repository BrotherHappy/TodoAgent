import { useEffect, useRef, useState } from "react";
import type { Task } from "../shared/models";
import type { PetCompanion } from "../shared/pet-types";
import { PetCompanionAvatar } from "./PetCompanionAvatar";
import {
  buildPetTeamPlan,
  pickPetTeamTask,
  type PetTeamPlan,
} from "./pet-team-huddle";

type HuddlePhase = "idle" | "preparing" | "ready";

export interface PetTeamHuddleCardProps {
  companions: readonly PetCompanion[];
  tasks: readonly Task[];
  disabled?: boolean;
  onStartFocus: (task: Task) => Promise<void>;
  onOpenTask: (task: Task) => void;
}

export function PetTeamHuddleCard({
  companions,
  tasks,
  disabled = false,
  onStartFocus,
  onOpenTask,
}: PetTeamHuddleCardProps) {
  const openTasks = tasks.filter((task) => task.status === "open" && !task.deletedAt);
  const [selectedTaskId, setSelectedTaskId] = useState(() => pickPetTeamTask(openTasks)?.id ?? "");
  const [leadId, setLeadId] = useState("");
  const [phase, setPhase] = useState<HuddlePhase>("idle");
  const [error, setError] = useState("");
  const timerRef = useRef<number | undefined>(undefined);
  const selectedTask = openTasks.find((task) => task.id === selectedTaskId) ?? openTasks[0];
  const plan: PetTeamPlan | undefined = buildPetTeamPlan(selectedTask, companions, leadId);

  useEffect(() => {
    if (!selectedTask || selectedTask.id !== selectedTaskId) {
      setSelectedTaskId(selectedTask?.id ?? "");
    }
    if (!selectedTask && phase !== "idle") setPhase("idle");
  }, [phase, selectedTask, selectedTaskId]);

  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);

  if (companions.length === 0) return null;

  const prepare = () => {
    if (!plan || disabled || phase !== "idle") return;
    setError("");
    setPhase("preparing");
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      setPhase("ready");
    }, 900);
  };

  const start = async () => {
    if (!plan || disabled || phase !== "ready") return;
    setError("");
    try {
      await onStartFocus(plan.task);
      setPhase("idle");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "小队暂时无法开始专注。");
    }
  };

  return (
    <section className="pet-team-huddle-card" aria-labelledby="pet-team-huddle-title">
      <div className="pet-section-heading">
        <div>
          <h3 id="pet-team-huddle-title">小队一起开工</h3>
          <p>伙伴只负责陪伴和节奏，任务状态仍由同一份任务记录负责。</p>
        </div>
        <span className="pet-team-huddle-count">{companions.length} 位伙伴</span>
      </div>
      {plan ? (
        <>
          <label className="pet-team-huddle-task">
            <span>今天想一起完成</span>
            <select
              value={plan.task.id}
              disabled={disabled || phase !== "idle"}
              onChange={(event) => {
                setSelectedTaskId(event.target.value);
                setError("");
              }}
            >
              {openTasks.slice(0, 30).map((task) => (
                <option value={task.id} key={task.id}>{task.title}</option>
              ))}
            </select>
          </label>
          <div className={`pet-team-huddle-members is-${phase}`} data-team-phase={phase}>
            {plan.members.map((member) => (
              <button
                type="button"
                className={`pet-team-huddle-member ${plan.lead.companion.id === member.companion.id ? "is-lead" : ""}`}
                key={member.companion.id}
                title={member.line}
                aria-label={`让${member.companion.name}担任领队，${member.roleLabel}`}
                aria-pressed={plan.lead.companion.id === member.companion.id}
                disabled={disabled || phase !== "idle"}
                onClick={() => {
                  setLeadId(member.companion.id);
                  setError("");
                }}
              >
                <PetCompanionAvatar
                  kind={member.companion.kind}
                  name={member.companion.name}
                  personality={member.companion.personality}
                  compact
                />
                <div>
                  <strong>{member.companion.name}</strong>
                  <small>{member.roleLabel}</small>
                </div>
              </button>
            ))}
          </div>
          <p className="pet-team-huddle-lead" aria-live="polite">
            <strong>领队：{plan.lead.companion.name}</strong>
            <span>{plan.lead.line}</span>
          </p>
          <p className="pet-team-huddle-summary" aria-live="polite">
            {phase === "preparing"
              ? "小队正在碰头，把第一步和专注节奏准备好…"
              : phase === "ready"
                ? `${plan.lead.companion.name}已经带队就位，准备好就开始这一段专注。`
                : plan.summary}
          </p>
          <div className="pet-team-huddle-actions">
            <button type="button" className="ghost-button" disabled={disabled || phase === "preparing"} onClick={() => onOpenTask(plan.task)}>查看任务</button>
            {phase === "ready" ? (
              <button type="button" className="primary-button" disabled={disabled} onClick={() => void start()}>开始专注</button>
            ) : (
              <button type="button" className="primary-button" disabled={disabled || phase !== "idle"} onClick={prepare}>小队准备</button>
            )}
          </div>
        </>
      ) : (
        <div className="pet-team-huddle-empty">今天没有开放任务，小队可以先在小窝里休息。</div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
