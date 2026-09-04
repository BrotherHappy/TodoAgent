import type { Task } from "../shared/models";
import type { PetAction } from "./pet-behavior";

export type TaskThemeId =
  | "general"
  | "reading"
  | "writing"
  | "development"
  | "research"
  | "communication"
  | "exercise"
  | "chores";

export interface TaskThemeActionPack {
  id: TaskThemeId;
  label: string;
  description: string;
  action: PetAction;
  keywords: readonly string[];
}
export const taskThemeActionPacks: readonly TaskThemeActionPack[] = [
  {
    id: "reading",
    label: "阅读",
    description: "翻开资料，陪你吸收一点新内容",
    action: "read",
    keywords: ["阅读", "读书", "论文", "文献", "看完", "read", "book"],
  },
  {
    id: "writing",
    label: "写作",
    description: "把想法整理成文字",
    action: "work",
    keywords: [
      "写",
      "撰写",
      "文档",
      "报告",
      "周报",
      "总结",
      "文章",
      "write",
      "document",
    ],
  },
  {
    id: "development",
    label: "开发",
    description: "和你一起把代码推进一小步",
    action: "work",
    keywords: [
      "代码",
      "开发",
      "编程",
      "接口",
      "bug",
      "测试",
      "发布",
      "部署",
      "deploy",
      "fix",
      "feature",
      "coding",
    ],
  },
  {
    id: "research",
    label: "调研",
    description: "拿起放大镜，把线索查清楚",
    action: "search",
    keywords: ["调研", "研究", "资料", "搜索", "查找", "分析", "research", "investigate"],
  },
  {
    id: "communication",
    label: "沟通",
    description: "先想清楚，再发出一条合适的消息",
    action: "think",
    keywords: ["会议", "沟通", "联系", "回复", "邮件", "消息", "电话", "meeting", "email", "call"],
  },
  {
    id: "exercise",
    label: "运动",
    description: "站起来动一动，再回来继续",
    action: "stretch",
    keywords: ["运动", "跑步", "健身", "拉伸", "散步", "锻炼", "exercise", "workout", "walk"],
  },
  {
    id: "chores",
    label: "整理",
    description: "把混乱的小事收拢成下一步",
    action: "tidy",
    keywords: ["整理", "清理", "收拾", "家务", "采购", "洗", "tidy", "clean", "errand"],
  },
  {
    id: "general",
    label: "任务",
    description: "陪你从一个清晰的下一步开始",
    action: "tidy",
    keywords: [],
  },
];

const packById = new Map(taskThemeActionPacks.map((pack) => [pack.id, pack]));

function normalizedText(task: Pick<Task, "title" | "notes" | "privateNotes" | "tags">): string {
  return [task.title, task.notes, task.privateNotes, ...task.tags]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

/**
 * Infers a gentle visual theme from task text. It never changes task data or
 * priority; the result only chooses a companion posture and a small label.
 */
export function inferTaskTheme(
  task: Pick<Task, "title" | "notes" | "privateNotes" | "tags"> | undefined,
): TaskThemeActionPack {
  if (!task) return packById.get("general")!;
  const text = normalizedText(task);
  let best: TaskThemeActionPack = packById.get("general")!;
  let bestScore = 0;
  for (const pack of taskThemeActionPacks) {
    if (pack.id === "general") continue;
    const score = pack.keywords.reduce((total, keyword) => {
      const normalized = keyword.toLocaleLowerCase();
      if (!normalized || !text.includes(normalized)) return total;
      // Chinese keywords tend to be more specific than a short English token.
      return total + (normalized.length > 1 ? 2 : 1);
    }, 0);
    if (score > bestScore) {
      best = pack;
      bestScore = score;
    }
  }
  return best;
}

export function taskThemeAction(theme: TaskThemeId | undefined): PetAction | undefined {
  if (!theme) return undefined;
  return packById.get(theme)?.action;
}
