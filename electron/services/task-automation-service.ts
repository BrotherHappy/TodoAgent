import type { Task, TaskId, UpdateTaskInput } from "../../src/shared/models";
import {
  matchesTaskAutomation,
  taskAutomationDeadlineDue,
  taskAutomationPatch,
  taskAutomationScheduleDue,
  taskAutomationTaskIds,
  taskAutomationTrigger,
  type TaskAutomationRule,
} from "../../src/shared/task-automations";

export interface TaskAutomationWriter {
  updateTask(
    id: TaskId,
    patch: UpdateTaskInput,
  ): Promise<{ task?: Task } | unknown>;
}

export interface TaskAutomationFailure {
  taskId: TaskId;
  ruleId: string;
  error: string;
}

export interface TaskAutomationRunResult {
  applied: number;
  taskIds: TaskId[];
  ruleIds: string[];
  failures: TaskAutomationFailure[];
  /** Scheduled rules whose current period was consumed, even when no task matched. */
  scheduledRuleIds: string[];
  /** Deadline rules that changed at least one task during this timer pass. */
  deadlineRuleIds: string[];
}

/**
 * Applies the small local automation language after a task snapshot changes.
 * The caller owns serialization and supplies the previous settled snapshot;
 * this service itself performs no timers, network requests or recursive event
 * dispatch. That keeps a Feishu pull deterministic and prevents a rule from
 * becoming an unattended Agent workflow.
 */
export class TaskAutomationService {
  readonly #writer: TaskAutomationWriter;
  readonly #rules: () => readonly TaskAutomationRule[];

  constructor(
    writer: TaskAutomationWriter,
    rules: () => readonly TaskAutomationRule[],
  ) {
    this.#writer = writer;
    this.#rules = rules;
  }

  async applyTransition(
    previous: readonly Task[],
    current: readonly Task[],
  ): Promise<TaskAutomationRunResult> {
    const previousById = new Map(previous.map((task) => [task.id, task]));
    const currentById = new Map(current.map((task) => [task.id, task]));
    const result: TaskAutomationRunResult = {
      applied: 0,
      taskIds: [],
      ruleIds: [],
      failures: [],
      scheduledRuleIds: [],
      deadlineRuleIds: [],
    };
    const appliedTaskIds = new Set<TaskId>();
    const appliedRuleIds = new Set<string>();
    const rules = [...this.#rules()];

    for (const id of taskAutomationTaskIds(previous, current)) {
      const original = currentById.get(id);
      const trigger = taskAutomationTrigger(previousById.get(id), original);
      if (!original || !trigger) continue;
      let working = original;
      for (const rule of rules) {
        if (!rule.enabled || rule.trigger !== trigger || !matchesTaskAutomation(rule, original)) {
          continue;
        }
        const patch = taskAutomationPatch(rule, working);
        if (!patch) continue;
        try {
          const mutation = await this.#writer.updateTask(id, patch);
          const nextTask =
            mutation !== null && typeof mutation === "object" &&
            "task" in mutation &&
            mutation.task !== undefined &&
            typeof mutation.task === "object"
              ? mutation.task as Task
              : undefined;
          working = nextTask ?? applyLocalPatch(working, patch);
          result.applied += 1;
          appliedTaskIds.add(id);
          appliedRuleIds.add(rule.id);
        } catch (error) {
          result.failures.push({
            taskId: id,
            ruleId: rule.id,
            error: error instanceof Error ? error.message : String(error),
          });
          // A later action could depend on the failed write. Stop this task's
          // chain but allow independent tasks/rules to continue.
          break;
        }
      }
    }
    result.taskIds = [...appliedTaskIds];
    result.ruleIds = [...appliedRuleIds];
    return result;
  }

  /** Apply due local schedules to open tasks. This is deliberately a separate
   * entry point from transition handling so a timer can never reinterpret a
   * task update as a creation/completion edge. */
  async applyScheduled(
    current: readonly Task[],
    now = new Date(),
  ): Promise<TaskAutomationRunResult> {
    const result: TaskAutomationRunResult = {
      applied: 0,
      taskIds: [],
      ruleIds: [],
      failures: [],
      scheduledRuleIds: [],
      deadlineRuleIds: [],
    };
    const appliedTaskIds = new Set<TaskId>();
    const appliedRuleIds = new Set<string>();
    const workingById = new Map(
      current
        .filter((task) => task.deletedAt === undefined && task.status !== "completed")
        .map((task) => [task.id, task]),
    );
    for (const rule of this.#rules()) {
      if (!rule.enabled || rule.trigger !== "scheduled" || !taskAutomationScheduleDue(rule, now)) {
        continue;
      }
      result.scheduledRuleIds.push(rule.id);
      for (const [id, original] of workingById) {
        if (!matchesTaskAutomation(rule, original)) continue;
        const patch = taskAutomationPatch(rule, original);
        if (!patch) continue;
        try {
          const mutation = await this.#writer.updateTask(id, patch);
          const nextTask =
            mutation !== null && typeof mutation === "object" &&
            "task" in mutation &&
            mutation.task !== undefined &&
            typeof mutation.task === "object"
              ? mutation.task as Task
              : undefined;
          workingById.set(id, nextTask ?? applyLocalPatch(original, patch));
          result.applied += 1;
          appliedTaskIds.add(id);
          appliedRuleIds.add(rule.id);
        } catch (error) {
          result.failures.push({
            taskId: id,
            ruleId: rule.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    result.taskIds = [...appliedTaskIds];
    result.ruleIds = [...appliedRuleIds];
    return result;
  }

  /** Apply local rules when an open task enters a configured lead window.
   * The timer may evaluate the same task more than once, but patches are
   * deterministic and no-op once the requested private state is already set;
   * this avoids persisting a second per-task checkpoint or growing settings
   * with task IDs. */
  async applyDeadlineApproaching(
    current: readonly Task[],
    now = new Date(),
  ): Promise<TaskAutomationRunResult> {
    const result: TaskAutomationRunResult = {
      applied: 0,
      taskIds: [],
      ruleIds: [],
      failures: [],
      scheduledRuleIds: [],
      deadlineRuleIds: [],
    };
    const appliedTaskIds = new Set<TaskId>();
    const appliedRuleIds = new Set<string>();
    const deadlineRuleIds = new Set<string>();
    const workingById = new Map(
      current
        .filter((task) => task.deletedAt === undefined && task.status !== "completed")
        .map((task) => [task.id, task]),
    );
    for (const rule of this.#rules()) {
      if (!rule.enabled || rule.trigger !== "deadline-approaching") continue;
      for (const [id, original] of workingById) {
        if (!taskAutomationDeadlineDue(rule, original, now) || !matchesTaskAutomation(rule, original)) {
          continue;
        }
        const patch = taskAutomationPatch(rule, original);
        if (!patch) continue;
        try {
          const mutation = await this.#writer.updateTask(id, patch);
          const nextTask =
            mutation !== null && typeof mutation === "object" &&
            "task" in mutation &&
            mutation.task !== undefined &&
            typeof mutation.task === "object"
              ? mutation.task as Task
              : undefined;
          workingById.set(id, nextTask ?? applyLocalPatch(original, patch));
          result.applied += 1;
          appliedTaskIds.add(id);
          appliedRuleIds.add(rule.id);
          deadlineRuleIds.add(rule.id);
        } catch (error) {
          result.failures.push({
            taskId: id,
            ruleId: rule.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    result.taskIds = [...appliedTaskIds];
    result.ruleIds = [...appliedRuleIds];
    result.deadlineRuleIds = [...deadlineRuleIds];
    return result;
  }
}

/** Only used to evaluate a second rule in the same run; the real persisted
 * task always comes from TaskService.updateTask. */
function applyLocalPatch(task: Task, patch: UpdateTaskInput): Task {
  const next = structuredClone(task);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete (next as unknown as Record<string, unknown>)[key];
    } else {
      (next as unknown as Record<string, unknown>)[key] = structuredClone(value);
    }
  }
  return next;
}
