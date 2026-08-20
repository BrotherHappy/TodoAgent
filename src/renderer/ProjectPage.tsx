import {
  Archive,
  ArchiveRestore,
  AlertTriangle,
  Check,
  CheckCircle2,
  FolderKanban,
  Inbox,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { Task, TaskProject, TaskProjectColor } from "../shared/models";

interface ProjectPageProps {
  tasks: Task[];
  projects?: TaskProject[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onSelect: (task: Task) => void;
  onCreateProject?: (input: { name: string; color: TaskProjectColor }) => Promise<void> | void;
  onUpdateProject?: (id: string, patch: Partial<Pick<TaskProject, "name" | "color" | "archived">>) => Promise<void> | void;
  onDeleteProject?: (id: string) => Promise<void> | void;
}

interface ProjectGroup {
  id: string;
  name: string;
  tasks: Task[];
  open: number;
  completed: number;
  overdue: number;
  blocked: number;
  project?: TaskProject;
}

const isOverdue = (task: Task): boolean => {
  if (task.status !== "open" || !task.dueAt) return false;
  return new Date(task.dueAt).getTime() < Date.now();
};

const buildGroups = (tasks: readonly Task[], projects: readonly TaskProject[] = []): ProjectGroup[] => {
  const grouped = new Map<string, Task[]>();
  projects.forEach((project) => grouped.set(project.id, []));
  const taskById = new Map(
    tasks.filter((task) => !task.deletedAt).map((task) => [task.id, task]),
  );
  for (const task of tasks) {
    if (task.deletedAt) continue;
    const id = task.projectId?.trim() || "__unassigned__";
    const current = grouped.get(id) ?? [];
    current.push(task);
    grouped.set(id, current);
  }
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  return [...grouped.entries()]
    .map(([id, groupTasks]) => {
      const project = projectsById.get(id);
      const openTasks = groupTasks.filter((task) => task.status === "open");
      const completed = groupTasks.length - openTasks.length;
      const blocked = openTasks.filter((task) => task.dependencyIds.length > 0 &&
        task.dependencyIds.some((dependencyId) => taskById.get(dependencyId)?.status !== "completed"),
      ).length;
      return {
        id,
        name: project?.name ?? (id === "__unassigned__" ? "未归类" : id),
        project,
        tasks: [...groupTasks].sort((left, right) => {
          if (left.status !== right.status) return left.status === "open" ? -1 : 1;
          return left.title.localeCompare(right.title, "zh-CN");
        }),
        open: openTasks.length,
        completed,
        overdue: openTasks.filter(isOverdue).length,
        blocked,
      };
    })
    .sort((left, right) => {
      if (left.id === "__unassigned__") return 1;
      if (right.id === "__unassigned__") return -1;
      if (left.project?.archived !== right.project?.archived) return left.project?.archived ? 1 : -1;
      return left.name.localeCompare(right.name, "zh-CN");
    });
};

const colorLabels: Record<TaskProjectColor, string> = {
  violet: "紫罗兰",
  blue: "海蓝",
  green: "薄荷",
  amber: "琥珀",
  rose: "玫瑰",
  slate: "石墨",
};

export function ProjectPage({
  tasks,
  projects = [],
  loading,
  error,
  onRetry,
  onSelect,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
}: ProjectPageProps) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<TaskProjectColor>("violet");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [editingName, setEditingName] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [deletePending, setDeletePending] = useState<string>();
  const groups = useMemo(() => buildGroups(tasks, projects), [projects, tasks]);
  const projectGroups = groups.filter((group) => group.id !== "__unassigned__");
  const totalOpen = groups.reduce((sum, group) => sum + group.open, 0);
  const totalCompleted = groups.reduce((sum, group) => sum + group.completed, 0);

  const createProject = async () => {
    if (!onCreateProject || !newName.trim() || creating) return;
    setCreating(true);
    try {
      await onCreateProject({ name: newName.trim(), color: newColor });
      setNewName("");
    } finally {
      setCreating(false);
    }
  };

  const saveName = async (id: string) => {
    if (!onUpdateProject || !editingName.trim()) return;
    setBusyId(id);
    try {
      await onUpdateProject(id, { name: editingName.trim() });
      setEditingId(undefined);
    } finally {
      setBusyId(undefined);
    }
  };

  const toggleArchive = async (project: TaskProject) => {
    if (!onUpdateProject) return;
    setBusyId(project.id);
    try {
      await onUpdateProject(project.id, { archived: !project.archived });
    } finally {
      setBusyId(undefined);
    }
  };

  const deleteProject = async (id: string) => {
    if (!onDeleteProject) return;
    if (deletePending !== id) {
      setDeletePending(id);
      return;
    }
    setBusyId(id);
    try {
      await onDeleteProject(id);
      setDeletePending(undefined);
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <main className="project-page" aria-label="项目总览">
      <div className="page-heading project-page-heading">
        <div>
          <p className="eyebrow">工作台 · 统一任务视图</p>
          <h1>项目</h1>
          <p className="page-subtitle">把任务聚拢到清晰的工作上下文里，完成与同步仍沿用原任务。</p>
        </div>
        <div className="project-rollup" aria-label="项目汇总">
          <span><strong>{projectGroups.length}</strong> 个项目</span>
          <span><strong>{totalOpen}</strong> 项待办</span>
          <span><strong>{totalCompleted}</strong> 项已完成</span>
        </div>
      </div>
      {onCreateProject && (
        <form className="project-create-bar" onSubmit={(event) => { event.preventDefault(); void createProject(); }}>
          <FolderKanban size={18} aria-hidden="true" />
          <input aria-label="新项目名称" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="新建一个项目…" maxLength={80} />
          <select aria-label="项目颜色" value={newColor} onChange={(event) => setNewColor(event.target.value as TaskProjectColor)}>
            {Object.entries(colorLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button type="submit" className="primary-button" disabled={creating || !newName.trim()}><Plus size={15} /> 新建项目</button>
        </form>
      )}
      {loading ? (
        <div className="project-page-state" role="status">正在读取项目…</div>
      ) : error ? (
        <div className="project-page-state project-page-error" role="alert">
          <AlertTriangle size={20} aria-hidden="true" /><span>{error}</span>
          <button type="button" className="soft-button" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" /> 重试</button>
        </div>
      ) : groups.length === 0 ? (
        <div className="project-page-state">
          <FolderKanban size={28} aria-hidden="true" /><strong>还没有项目上下文</strong>
          <span>新建一个项目，或在任务详情中选择项目。</span>
        </div>
      ) : (
        <div className="project-grid">
          {groups.map((group) => {
            const total = group.open + group.completed;
            const completion = total === 0 ? 0 : Math.round((group.completed / total) * 100);
            const project = group.project;
            return (
              <section className={`project-card ${project?.archived ? "is-archived" : ""}`} key={group.id} aria-labelledby={`project-${group.id}`}>
                <div className="project-card-header">
                  {group.id === "__unassigned__" ? <Inbox size={18} aria-hidden="true" /> : <FolderKanban size={18} aria-hidden="true" />}
                  <div className="project-card-title">
                    {editingId === group.id ? (
                      <form onSubmit={(event) => { event.preventDefault(); void saveName(group.id); }} className="project-rename-form">
                        <input aria-label="重命名项目" autoFocus value={editingName} onChange={(event) => setEditingName(event.target.value)} maxLength={80} />
                        <button type="submit" aria-label="保存项目名称" disabled={busyId === group.id}><Check size={14} /></button>
                        <button type="button" aria-label="取消重命名" onClick={() => setEditingId(undefined)}><X size={14} /></button>
                      </form>
                    ) : <h2 id={`project-${group.id}`}>{group.name}</h2>}
                    <span>{group.open} 项待办 · 完成 {completion}%{project?.archived ? " · 已归档" : ""}</span>
                  </div>
                  {project && (
                    <div className="project-card-actions">
                      {onUpdateProject && <button type="button" className="icon-button" aria-label={`重命名${project.name}`} title="重命名" onClick={() => { setEditingId(project.id); setEditingName(project.name); }}><Pencil size={14} /></button>}
                      {onUpdateProject && <button type="button" className="icon-button" aria-label={project.archived ? `恢复${project.name}` : `归档${project.name}`} title={project.archived ? "恢复项目" : "归档项目"} disabled={busyId === project.id} onClick={() => void toggleArchive(project)}>{project.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button>}
                      {onDeleteProject && <button type="button" className={`icon-button danger ${deletePending === project.id ? "is-confirming" : ""}`} aria-label={deletePending === project.id ? `确认删除${project.name}` : `删除${project.name}`} title={deletePending === project.id ? "再次点击确认删除" : "删除项目"} disabled={busyId === project.id} onClick={() => void deleteProject(project.id)}><Trash2 size={14} /></button>}
                    </div>
                  )}
                  {!project && group.completed > 0 && <CheckCircle2 className="project-card-complete" size={18} aria-label="包含已完成任务" />}
                </div>
                <div className="project-progress" aria-label={`${group.name}完成率 ${completion}%`}><span style={{ width: `${completion}%` }} /></div>
                {(group.overdue > 0 || group.blocked > 0) && <div className="project-signals">{group.overdue > 0 && <span className="project-signal danger">逾期 {group.overdue}</span>}{group.blocked > 0 && <span className="project-signal warning">阻塞 {group.blocked}</span>}</div>}
                <div className="project-task-list">
                  {group.tasks.slice(0, 6).map((task) => <button type="button" className="project-task-row" key={task.id} onClick={() => onSelect(task)}><span className={`project-task-check ${task.status === "completed" ? "done" : ""}`} aria-hidden="true">{task.status === "completed" ? "✓" : ""}</span><span className="project-task-title">{task.title}</span>{isOverdue(task) && <span className="project-task-meta danger">逾期</span>}</button>)}
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

export default ProjectPage;
