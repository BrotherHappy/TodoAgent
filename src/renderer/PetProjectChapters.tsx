import { useMemo } from "react";
import type { Task, TaskProject } from "../shared/models";
import { projectPetChapters } from "./pet-project-chapters";

export function PetProjectChapters({
  tasks,
  projects,
  onOpenTask,
  onOpenProjects,
}: {
  tasks: readonly Task[];
  projects: readonly TaskProject[];
  onOpenTask: (taskId: string) => void;
  onOpenProjects: () => void;
}) {
  const chapters = useMemo(() => projectPetChapters(tasks, projects), [tasks, projects]);
  return (
    <section className="pet-project-chapters-card" aria-label="共同旅程章节">
      <div className="pet-section-heading">
        <div>
          <h2>共同旅程</h2>
          <p>把正在推进的项目走成一章，宠物只帮你记住下一步。</p>
        </div>
        <button type="button" className="soft-button" onClick={onOpenProjects}>查看项目</button>
      </div>
      {chapters.length ? (
        <div className="pet-project-chapters-grid">
          {chapters.map((chapter) => (
            <article className={`pet-project-chapter is-${chapter.color}`} key={chapter.projectId}>
              <div className="pet-project-chapter-heading">
                <span className="pet-project-chapter-dot" aria-hidden="true" />
                <strong>{chapter.name}</strong>
                <small>{chapter.completedCount}/{chapter.totalCount}</small>
              </div>
              <div
                className="pet-project-chapter-progress"
                role="progressbar"
                aria-label={`${chapter.name}完成进度`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={chapter.progress}
              >
                <i style={{ width: `${chapter.progress}%` }} />
              </div>
              <p>
                {chapter.nextTaskTitle
                  ? `下一步：${chapter.nextTaskTitle}`
                  : "这一章已经完成，给自己留一颗星。"}
              </p>
              {chapter.nextTaskId && (
                <button type="button" className="ghost-button" onClick={() => onOpenTask(chapter.nextTaskId!)}>
                  打开下一步
                </button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="pet-project-chapters-empty">给任务选一个项目，这里就会出现你们的下一章。</div>
      )}
    </section>
  );
}
