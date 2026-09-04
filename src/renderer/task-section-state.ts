/**
 * Local-only collapse state for task section headings.
 *
 * The state is deliberately kept outside the task model: collapsing a heading
 * is a view preference, not task data, and must never enter Feishu payloads,
 * exports, or Agent context.
 */
export const TASK_SECTION_COLLAPSE_STORAGE_KEY = "todoAgentTaskSectionCollapsed";
export const TASK_SECTION_COLLAPSE_SCOPE_LIMIT = 24;
export const TASK_SECTION_COLLAPSE_GROUP_LIMIT = 80;

export type TaskSectionCollapseState = Record<string, string[]>;

const cleanKey = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
};

const cleanIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = cleanKey(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (seen.size >= TASK_SECTION_COLLAPSE_GROUP_LIMIT) break;
  }
  return [...seen];
};

const resolveStorage = (storage?: Storage): Storage | undefined => {
  if (storage) return storage;
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export function readTaskSectionCollapseState(
  storage?: Storage,
): TaskSectionCollapseState {
  const target = resolveStorage(storage);
  if (!target) return {};
  try {
    const raw = target.getItem(TASK_SECTION_COLLAPSE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const next: TaskSectionCollapseState = {};
    for (const [rawScope, rawIds] of Object.entries(parsed)) {
      const scope = cleanKey(rawScope);
      if (!scope) continue;
      const ids = cleanIds(rawIds);
      if (ids.length === 0) continue;
      next[scope] = ids;
      if (Object.keys(next).length >= TASK_SECTION_COLLAPSE_SCOPE_LIMIT) break;
    }
    return next;
  } catch {
    return {};
  }
}

export function writeTaskSectionCollapseState(
  state: TaskSectionCollapseState,
  storage?: Storage,
): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    const entries = Object.entries(state)
      .map(([scope, ids]) => [cleanKey(scope), cleanIds(ids)] as const)
      .filter((entry): entry is readonly [string, string[]] =>
        Boolean(entry[0]) && entry[1].length > 0,
      )
      .slice(0, TASK_SECTION_COLLAPSE_SCOPE_LIMIT);
    target.setItem(
      TASK_SECTION_COLLAPSE_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // A locked-down storage area should not make the list unusable. The
    // in-memory state remains active for this renderer lifetime.
  }
}

export function toggleTaskSectionCollapse(
  state: TaskSectionCollapseState,
  scope: string,
  groupKey: string,
  collapsed: boolean,
): TaskSectionCollapseState {
  const safeScope = cleanKey(scope);
  const safeGroup = cleanKey(groupKey);
  if (!safeScope || !safeGroup) return state;
  const current = new Set(cleanIds(state[safeScope]));
  if (collapsed) current.add(safeGroup);
  else current.delete(safeGroup);
  const next = { ...state };
  if (current.size === 0) delete next[safeScope];
  else next[safeScope] = [...current].slice(0, TASK_SECTION_COLLAPSE_GROUP_LIMIT);
  return next;
}

export const taskSectionGroupKey = (sectionId: string, groupId: string): string =>
  `${sectionId}:${groupId}`;

