import type { FeishuTasklistBinding, Task } from '../../src/shared/models';
import type {
  FeishuTaskV2,
  FeishuTasklistMembership,
} from '../../src/shared/feishu-types';

const clone = <Value>(value: Value): Value => structuredClone(value);

function normalizedId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Normalizes a deliberately selected Task v2 tasklist binding. The empty
 * object remains meaningful: it is an explicit request to clear a binding.
 */
export function normalizeFeishuTasklistBinding(
  binding: FeishuTasklistBinding | undefined,
): FeishuTasklistBinding | undefined {
  if (binding === undefined) return undefined;
  const tasklistGuid = normalizedId(binding.tasklistGuid);
  const sectionGuid = normalizedId(binding.sectionGuid);
  if (!tasklistGuid) return {};
  return {
    tasklistGuid,
    ...(sectionGuid ? { sectionGuid } : {}),
  };
}

export function feishuTasklistBindingsEqual(
  left: FeishuTasklistBinding | undefined,
  right: FeishuTasklistBinding | undefined,
): boolean {
  const normalizedLeft = normalizeFeishuTasklistBinding(left);
  const normalizedRight = normalizeFeishuTasklistBinding(right);
  return (
    normalizedLeft?.tasklistGuid === normalizedRight?.tasklistGuid &&
    normalizedLeft?.sectionGuid === normalizedRight?.sectionGuid
  );
}

/**
 * Returns the local binding only when it was deliberately recorded in
 * TaskSource. `listId`, `sectionId`, and project names are intentionally not
 * consulted: all three can be free-form product metadata.
 */
export function explicitFeishuTasklistBinding(
  task: Task,
): FeishuTasklistBinding | undefined {
  if (task.source.type !== 'feishu') return undefined;
  return normalizeFeishuTasklistBinding(task.source.tasklist);
}

function normalizeMembership(
  membership: FeishuTasklistMembership,
): FeishuTasklistMembership | undefined {
  const tasklistGuid = normalizedId(membership.tasklist_guid);
  if (!tasklistGuid) return undefined;
  const sectionGuid = normalizedId(membership.section_guid);
  return {
    tasklist_guid: tasklistGuid,
    ...(sectionGuid ? { section_guid: sectionGuid } : {}),
  };
}

export function normalizeFeishuTasklistMemberships(
  memberships: readonly FeishuTasklistMembership[],
): FeishuTasklistMembership[] {
  const unique = new Map<string, FeishuTasklistMembership>();
  for (const raw of memberships) {
    const normalized = normalizeMembership(raw);
    if (!normalized) continue;
    // One task cannot occupy two sections in the same tasklist. Keep the
    // first provider record deterministically rather than guessing a move.
    if (!unique.has(normalized.tasklist_guid)) {
      unique.set(normalized.tasklist_guid, normalized);
    }
  }
  return [...unique.values()].sort((left, right) =>
    left.tasklist_guid.localeCompare(right.tasklist_guid),
  );
}

/**
 * Local Task can represent exactly one provider tasklist. Map remote state
 * only when it is unambiguous: zero accessible tasklists means an explicit
 * clear, one maps directly, and multiple is intentionally left unknown.
 */
export function unambiguousFeishuTasklistBinding(
  memberships: readonly FeishuTasklistMembership[] | undefined,
): FeishuTasklistBinding | undefined {
  if (memberships === undefined) return undefined;
  const normalized = normalizeFeishuTasklistMemberships(memberships);
  if (normalized.length === 0) return {};
  if (normalized.length !== 1) return undefined;
  const [membership] = normalized;
  return {
    tasklistGuid: membership!.tasklist_guid,
    ...(membership!.section_guid
      ? { sectionGuid: membership!.section_guid }
      : {}),
  };
}

export function tasklistBindingFromRemoteTask(
  task: FeishuTaskV2,
): FeishuTasklistBinding | undefined {
  return unambiguousFeishuTasklistBinding(task.tasklists);
}

export function tasklistMembershipFromBinding(
  binding: FeishuTasklistBinding | undefined,
): FeishuTasklistMembership | undefined {
  const normalized = normalizeFeishuTasklistBinding(binding);
  if (!normalized?.tasklistGuid) return undefined;
  return {
    tasklist_guid: normalized.tasklistGuid,
    ...(normalized.sectionGuid
      ? { section_guid: normalized.sectionGuid }
      : {}),
  };
}

export function tasklistMembershipsAfterBindingChange(
  memberships: readonly FeishuTasklistMembership[],
  previous: FeishuTasklistBinding | undefined,
  next: FeishuTasklistBinding | undefined,
): FeishuTasklistMembership[] {
  const nextMembership = tasklistMembershipFromBinding(next);
  const previousGuid = normalizeFeishuTasklistBinding(previous)?.tasklistGuid;
  const retained = normalizeFeishuTasklistMemberships(memberships).filter(
    (membership) => membership.tasklist_guid !== previousGuid,
  );
  if (nextMembership) retained.push(nextMembership);
  return normalizeFeishuTasklistMemberships(retained);
}

export function cloneFeishuTasklistBinding(
  binding: FeishuTasklistBinding | undefined,
): FeishuTasklistBinding | undefined {
  const normalized = normalizeFeishuTasklistBinding(binding);
  return normalized === undefined ? undefined : clone(normalized);
}
