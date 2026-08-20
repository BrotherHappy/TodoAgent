import {
  Archive,
  ArchiveRestore,
  AlertTriangle,
  Check,
  CheckCircle2,
  Inbox,
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { Task, TaskList, TaskListColor } from "../shared/models";

interface ListPageProps {
  tasks: Task[];
  lists?: TaskList[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onSelect: (task: Task) => void;
  onCreateList?: (input: { name: string; color: TaskListColor }) => Promise<void> | void;
  onUpdateList?: (id: string, patch: Partial<Pick<TaskList, "name" | "color" | "archived">>) => Promise<void> | void;
  onDeleteList?: (id: string) => Promise<void> | void;
}

interface ListGroup {
  id: string;
  name: string;
  tasks: Task[];
  open: number;
  completed: number;
  list?: TaskList;
}

const colorLabels: Record<TaskListColor, string> = {
  violet: "紫罗兰",
  blue: "海蓝",
  green: "薄荷",
  amber: "琥珀",
  rose: "玫瑰",
  slate: "石墨",
};

const buildGroups = (tasks: readonly Task[], lists: readonly TaskList[] = []): ListGroup[] => {
  const grouped = new Map<string, Task[]>();
  lists.forEach((list) => grouped.set(list.id, []));
  for (const task of tasks) {
    if (task.deletedAt) continue;
    const id = task.listId?.trim() || "__unassigned__";
    const current = grouped.get(id) ?? [];
    current.push(task);
    grouped.set(id, current);
  }
  const byId = new Map(lists.map((list) => [list.id, list]));
  return [...grouped.entries()]
    .map(([id, groupTasks]) => {
      const list = byId.get(id);
      const open = groupTasks.filter((task) => task.status === "open");
      return {
        id,
        name: list?.name ?? (id === "__unassigned__" ? "未归类" : id),
        list,
        tasks: [...groupTasks].sort((left, right) => {
          if (left.status !== right.status) return left.status === "open" ? -1 : 1;
          return left.title.localeCompare(right.title, "zh-CN");
        }),
        open: open.length,
        completed: groupTasks.length - open.length,
      };
    })
    .sort((left, right) => {
      if (left.id === "__unassigned__") return 1;
      if (right.id === "__unassigned__") return -1;
      if (left.list?.archived !== right.list?.archived) return left.list?.archived ? 1 : -1;
      return left.name.localeCompare(right.name, "zh-CN");
    });
};

export function ListPage({
  tasks,
  lists = [],
  loading,
  error,
  onRetry,
  onSelect,
  onCreateList,
  onUpdateList,
  onDeleteList,
}: ListPageProps) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<TaskListColor>("violet");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [editingName, setEditingName] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [deletePending, setDeletePending] = useState<string>();
  const groups = useMemo(() => buildGroups(tasks, lists), [lists, tasks]);
  const listGroups = groups.filter((group) => group.id !== "__unassigned__");
  const totalOpen = groups.reduce((sum, group) => sum + group.open, 0);
  const totalCompleted = groups.reduce((sum, group) => sum + group.completed, 0);

  const createList = async () => {
    if (!onCreateList || !newName.trim() || creating) return;
    setCreating(true);
    try {
      await onCreateList({ name: newName.trim(), color: newColor });
      setNewName("");
    } finally {
      setCreating(false);
    }
  };

  const saveName = async (id: string) => {
    if (!onUpdateList || !editingName.trim()) return;
    setBusyId(id);
    try {
      await onUpdateList(id, { name: editingName.trim() });
      setEditingId(undefined);
    } finally {
      setBusyId(undefined);
    }
  };

  const toggleArchive = async (list: TaskList) => {
    if (!onUpdateList) return;
    setBusyId(list.id);
    try {
      await onUpdateList(list.id, { archived: !list.archived });
    } finally {
      setBusyId(undefined);
    }
  };

  const deleteList = async (id: string) => {
    if (!onDeleteList) return;
    if (deletePending !== id) {
      setDeletePending(id);
      return;
    }
    setBusyId(id);
    try {
      await onDeleteList(id);
      setDeletePending(undefined);
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <main className="project-page list-page" aria-label="清单管理">
      <div className="page-heading project-page-heading">
        <div>
          <p className="eyebrow">工作台 · 轻量收纳</p>
          <h1>清单</h1>
          <p className="page-subtitle">用清单分隔生活、学习和工作；任务关联只属于本地，不会改写飞书。</p>
        </div>
        <div className="project-rollup" aria-label="清单汇总">
          <span><strong>{listGroups.length}</strong> 个清单</span>
          <span><strong>{totalOpen}</strong> 项待办</span>
          <span><strong>{totalCompleted}</strong> 项已完成</span>
        </div>
      </div>
      {onCreateList && (
        <form className="project-create-bar" onSubmit={(event) => { event.preventDefault(); void createList(); }}>
          <ListChecks size={18} aria-hidden="true" />
          <input aria-label="新清单名称" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="新建一个清单…" maxLength={80} />
          <select aria-label="清单颜色" value={newColor} onChange={(event) => setNewColor(event.target.value as TaskListColor)}>
            {Object.entries(colorLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button type="submit" className="primary-button" disabled={creating || !newName.trim()}><Plus size={15} /> 新建清单</button>
        </form>
      )}
      {loading ? (
        <div className="project-page-state" role="status">正在读取清单…</div>
      ) : error ? (
        <div className="project-page-state project-page-error" role="alert">
          <AlertTriangle size={20} aria-hidden="true" /><span>{error}</span>
          <button type="button" className="soft-button" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" /> 重试</button>
        </div>
      ) : groups.length === 0 ? (
        <div className="project-page-state">
          <ListChecks size={28} aria-hidden="true" /><strong>还没有清单</strong>
          <span>新建一个清单，或在任务详情中选择清单。</span>
        </div>
      ) : (
        <div className="project-grid">
          {groups.map((group) => {
            const total = group.open + group.completed;
            const completion = total === 0 ? 0 : Math.round((group.completed / total) * 100);
            const list = group.list;
            return (
              <section className={`project-card ${list?.archived ? "is-archived" : ""}`} key={group.id} aria-labelledby={`list-${group.id}`}>
                <div className="project-card-header">
                  {group.id === "__unassigned__" ? <Inbox size={18} aria-hidden="true" /> : <ListChecks size={18} aria-hidden="true" />}
                  <div className="project-card-title">
                    {editingId === group.id ? (
                      <form onSubmit={(event) => { event.preventDefault(); void saveName(group.id); }} className="project-rename-form">
                        <input aria-label="重命名清单" autoFocus value={editingName} onChange={(event) => setEditingName(event.target.value)} maxLength={80} />
                        <button type="submit" aria-label="保存清单名称" disabled={busyId === group.id}><Check size={14} /></button>
                        <button type="button" aria-label="取消重命名" onClick={() => setEditingId(undefined)}><X size={14} /></button>
                      </form>
                    ) : <h2 id={`list-${group.id}`}>{group.name}</h2>}
                    <span>{group.open} 项待办 · 完成 {completion}%{list?.archived ? " · 已归档" : ""}</span>
                  </div>
                  {list && (
                    <div className="project-card-actions">
                      {onUpdateList && <button type="button" className="icon-button" aria-label={`重命名${list.name}`} title="重命名" onClick={() => { setEditingId(list.id); setEditingName(list.name); }}><Pencil size={14} /></button>}
                      {onUpdateList && <button type="button" className="icon-button" aria-label={list.archived ? `恢复${list.name}` : `归档${list.name}`} title={list.archived ? "恢复清单" : "归档清单"} disabled={busyId === list.id} onClick={() => void toggleArchive(list)}>{list.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button>}
                      {onDeleteList && <button type="button" className={`icon-button danger ${deletePending === list.id ? "is-confirming" : ""}`} aria-label={deletePending === list.id ? `确认删除${list.name}` : `删除${list.name}`} title={deletePending === list.id ? "再次点击确认删除" : "删除清单"} disabled={busyId === list.id} onClick={() => void deleteList(list.id)}><Trash2 size={14} /></button>}
                    </div>
                  )}
                  {!list && group.completed > 0 && <CheckCircle2 className="project-card-complete" size={18} aria-label="包含已完成任务" />}
                </div>
                <div className="project-progress" aria-label={`${group.name}完成率 ${completion}%`}><span style={{ width: `${completion}%` }} /></div>
                <div className="project-task-list">
                  {group.tasks.slice(0, 6).map((task) => <button type="button" className="project-task-row" key={task.id} onClick={() => onSelect(task)}><span className={`project-task-check ${task.status === "completed" ? "done" : ""}`} aria-hidden="true">{task.status === "completed" ? "✓" : ""}</span><span className="project-task-title">{task.title}</span></button>)}
                </div>
                {group.tasks.length > 6 && <span className="project-more">还有 {group.tasks.length - 6} 项任务</span>}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}

export default ListPage;
