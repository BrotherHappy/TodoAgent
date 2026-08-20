import { useCallback, useEffect, useMemo, useState } from "react";
import type { CreateTaskInput, TaskPriority } from "../shared/models";

export const TASK_TEMPLATES_STORAGE_KEY = "todo-agent.task-templates.v1";
export const TASK_TEMPLATES_CHANGED_EVENT = "todo-agent-task-templates-changed";

export type TaskTemplateSource = "local" | "feishu";

export interface TaskTemplateStep {
  id: string;
  titleTemplate: string;
  notesTemplate?: string;
  tags?: string[];
  priority?: TaskPriority;
  estimatedMinutes?: number;
  plannedDayOffset?: number;
  dueOffsetMinutes?: number;
}

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  defaultSource: TaskTemplateSource;
  steps: TaskTemplateStep[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskTemplatePreviewStep {
  id: string;
  title: string;
  notes: string;
  tags: string[];
  priority?: TaskPriority;
  estimatedMinutes?: number;
  plannedDate?: string;
  dueAt?: string;
}

export interface TaskTemplatePreview {
  templateId: string;
  templateName: string;
  steps: TaskTemplatePreviewStep[];
}

export type TaskTemplateImportResult =
  | { ok: true; template: TaskTemplate }
  | { ok: false; message: string };

const BUILT_IN_TEMPLATE_IDS = new Set([
  "meeting-follow-up",
  "research-brief",
  "publish-article",
]);
const VALID_PRIORITIES = new Set<TaskPriority>([
  "none",
  "low",
  "medium",
  "high",
  "urgent",
]);
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/gu;
const ALLOWED_PLACEHOLDERS = new Set(["title", "date", "now"]);

const builtInTemplate = (
  value: Omit<TaskTemplate, "createdAt" | "updatedAt">,
): TaskTemplate => ({
  ...value,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

export const builtInTaskTemplates: readonly TaskTemplate[] = [
  builtInTemplate({
    id: "meeting-follow-up",
    name: "会议跟进",
    description: "把会议后的记录、沟通和检查拆成三步。",
    defaultSource: "local",
    steps: [
      {
        id: "notes",
        titleTemplate: "整理会议记录：{{title}}",
        tags: ["会议"],
        priority: "medium",
        estimatedMinutes: 30,
      },
      {
        id: "follow-up",
        titleTemplate: "发送跟进消息：{{title}}",
        tags: ["沟通"],
        estimatedMinutes: 15,
      },
      {
        id: "check",
        titleTemplate: "检查行动项：{{title}}",
        tags: ["会议"],
        priority: "high",
        estimatedMinutes: 15,
        plannedDayOffset: 2,
      },
    ],
  }),
  builtInTemplate({
    id: "research-brief",
    name: "研究简报",
    description: "从定义问题到整理结论，适合一次小型调研。",
    defaultSource: "local",
    steps: [
      {
        id: "question",
        titleTemplate: "定义研究问题：{{title}}",
        tags: ["研究"],
        priority: "high",
        estimatedMinutes: 20,
      },
      {
        id: "sources",
        titleTemplate: "收集资料：{{title}}",
        tags: ["研究"],
        estimatedMinutes: 45,
      },
      {
        id: "brief",
        titleTemplate: "整理研究结论：{{title}}",
        tags: ["研究", "写作"],
        estimatedMinutes: 30,
        plannedDayOffset: 1,
      },
    ],
  }),
  builtInTemplate({
    id: "publish-article",
    name: "发布文章",
    description: "提纲、初稿、校对发布三段式写作流程。",
    defaultSource: "local",
    steps: [
      {
        id: "outline",
        titleTemplate: "列出提纲：{{title}}",
        tags: ["写作"],
        estimatedMinutes: 30,
      },
      {
        id: "draft",
        titleTemplate: "完成初稿：{{title}}",
        tags: ["写作"],
        priority: "high",
        estimatedMinutes: 90,
        plannedDayOffset: 1,
      },
      {
        id: "publish",
        titleTemplate: "校对并发布：{{title}}",
        tags: ["写作"],
        priority: "high",
        estimatedMinutes: 45,
        plannedDayOffset: 2,
      },
    ],
  }),
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const storageOf = (): Storage | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

const cloneTemplate = (template: TaskTemplate): TaskTemplate => ({
  ...template,
  steps: template.steps.map((step) => ({
    ...step,
    tags: step.tags ? [...step.tags] : undefined,
  })),
});

const emitChanged = (): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(TASK_TEMPLATES_CHANGED_EVENT));
  }
};

const validOffset = (value: unknown, min: number, max: number): boolean =>
  value === undefined ||
  (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max);

const validatePlaceholders = (value: string): boolean => {
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    if (!ALLOWED_PLACEHOLDERS.has(match[1]!)) return false;
  }
  return true;
};

export const validateTaskTemplate = (value: unknown): TaskTemplateImportResult => {
  if (!isRecord(value)) return { ok: false, message: "模板必须是一个 JSON 对象。" };
  const allowedKeys = new Set([
    "id",
    "name",
    "description",
    "defaultSource",
    "steps",
    "createdAt",
    "updatedAt",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return { ok: false, message: "模板只允许包含名称、说明、来源和步骤，不接受脚本或外部代码。" };
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const defaultSource = value.defaultSource === "feishu" ? "feishu" : value.defaultSource === "local" ? "local" : undefined;
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/u.test(id) || BUILT_IN_TEMPLATE_IDS.has(id)) {
    return { ok: false, message: "模板 ID 只能使用 2–40 位小写字母、数字和短横线，且不能占用内置 ID。" };
  }
  if (name.length < 1 || name.length > 40) {
    return { ok: false, message: "模板名称需要在 1–40 个字符之间。" };
  }
  if (description.length > 200) {
    return { ok: false, message: "模板说明不能超过 200 个字符。" };
  }
  if (!defaultSource) return { ok: false, message: "模板来源只能是 local 或 feishu。" };
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 12) {
    return { ok: false, message: "模板需要包含 1–12 个步骤。" };
  }
  const stepIds = new Set<string>();
  const steps: TaskTemplateStep[] = [];
  for (const rawStep of value.steps) {
    if (!isRecord(rawStep)) return { ok: false, message: "模板步骤格式不正确。" };
    const allowedStepKeys = new Set([
      "id",
      "titleTemplate",
      "notesTemplate",
      "tags",
      "priority",
      "estimatedMinutes",
      "plannedDayOffset",
      "dueOffsetMinutes",
    ]);
    if (Object.keys(rawStep).some((key) => !allowedStepKeys.has(key))) {
      return { ok: false, message: "模板步骤不允许脚本、网络或任意扩展字段。" };
    }
    const stepId = typeof rawStep.id === "string" ? rawStep.id.trim() : "";
    const titleTemplate = typeof rawStep.titleTemplate === "string" ? rawStep.titleTemplate.trim() : "";
    const notesTemplate = typeof rawStep.notesTemplate === "string" ? rawStep.notesTemplate.trim() : undefined;
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/u.test(stepId) || stepIds.has(stepId)) {
      return { ok: false, message: "每个模板步骤都需要唯一的合法 ID。" };
    }
    if (!titleTemplate || titleTemplate.length > 160 || !validatePlaceholders(titleTemplate)) {
      return { ok: false, message: "步骤标题不能为空、不能超过 160 个字符，且只能使用 {{title}}、{{date}}、{{now}}。" };
    }
    if (notesTemplate !== undefined && (notesTemplate.length > 4_000 || !validatePlaceholders(notesTemplate))) {
      return { ok: false, message: "步骤备注不能超过 4,000 个字符，且只能使用受支持的变量。" };
    }
    const tags = rawStep.tags === undefined ? undefined : rawStep.tags;
    if (tags !== undefined && (!Array.isArray(tags) || tags.length > 12 || tags.some((tag) => typeof tag !== "string" || tag.trim().length < 1 || tag.trim().length > 40))) {
      return { ok: false, message: "步骤标签最多 12 个，每个标签 1–40 个字符。" };
    }
    const priority = rawStep.priority === undefined ? undefined : rawStep.priority;
    if (priority !== undefined && (typeof priority !== "string" || !VALID_PRIORITIES.has(priority as TaskPriority))) {
      return { ok: false, message: "步骤优先级不正确。" };
    }
    const estimatedMinutes = rawStep.estimatedMinutes;
    if (estimatedMinutes !== undefined && (typeof estimatedMinutes !== "number" || !Number.isInteger(estimatedMinutes) || estimatedMinutes < 5 || estimatedMinutes > 720)) {
      return { ok: false, message: "步骤预计时长必须是 5–720 分钟的整数。" };
    }
    if (!validOffset(rawStep.plannedDayOffset, -365, 365) || !validOffset(rawStep.dueOffsetMinutes, -10_080, 525_600)) {
      return { ok: false, message: "步骤日期偏移超出允许范围。" };
    }
    stepIds.add(stepId);
    steps.push({
      id: stepId,
      titleTemplate,
      notesTemplate,
      tags: tags?.map((tag) => tag.trim()),
      priority: priority as TaskPriority | undefined,
      estimatedMinutes,
      plannedDayOffset: rawStep.plannedDayOffset as number | undefined,
      dueOffsetMinutes: rawStep.dueOffsetMinutes as number | undefined,
    });
  }
  const now = new Date().toISOString();
  return {
    ok: true,
    template: {
      id,
      name,
      description,
      defaultSource,
      steps,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
      updatedAt: now,
    },
  };
};

export const parseTaskTemplateJson = (raw: string): TaskTemplateImportResult => {
  try {
    return validateTaskTemplate(JSON.parse(raw));
  } catch {
    return { ok: false, message: "模板不是有效的 JSON。" };
  }
};

export const loadCustomTaskTemplates = (
  storage: Pick<Storage, "getItem"> | undefined = storageOf(),
): TaskTemplate[] => {
  if (!storage) return [];
  try {
    const raw = storage.getItem(TASK_TEMPLATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => validateTaskTemplate(item))
      .filter((result): result is { ok: true; template: TaskTemplate } => result.ok)
      .map((result) => cloneTemplate(result.template));
  } catch {
    return [];
  }
};

const writeCustomTaskTemplates = (
  templates: readonly TaskTemplate[],
  storage: Pick<Storage, "setItem"> | undefined = storageOf(),
): void => {
  if (!storage) return;
  storage.setItem(TASK_TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
  emitChanged();
};

export const installTaskTemplate = (
  template: TaskTemplate,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = storageOf(),
): TaskTemplate[] => {
  const current = loadCustomTaskTemplates(storage);
  const next = [...current.filter((item) => item.id !== template.id), cloneTemplate(template)];
  writeCustomTaskTemplates(next, storage);
  return next;
};

export const removeTaskTemplate = (
  id: string,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = storageOf(),
): TaskTemplate[] => {
  const next = loadCustomTaskTemplates(storage).filter((item) => item.id !== id);
  writeCustomTaskTemplates(next, storage);
  return next;
};

export const allTaskTemplates = (
  custom: readonly TaskTemplate[] = loadCustomTaskTemplates(),
): TaskTemplate[] => [
  ...builtInTaskTemplates.map(cloneTemplate),
  ...custom.map(cloneTemplate),
];

export const replaceTemplateVariables = (
  value: string,
  variables: { title: string; date: string; now: string },
): string =>
  value.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (key === "title") return variables.title;
    if (key === "date") return variables.date;
    if (key === "now") return variables.now;
    return "";
  });

const addLocalDays = (date: string, offset: number): string => {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.toISOString().slice(0, 10);
};

export const previewTaskTemplate = (
  template: TaskTemplate,
  title: string,
  options: { date: string; dueAt?: string; now?: Date },
): TaskTemplatePreview => {
  const now = options.now ?? new Date();
  const variables = { title: title.trim(), date: options.date, now: now.toISOString() };
  // A malformed due date should never make the preview crash. The quick-capture
  // form normally supplies an ISO value, but imported drafts and older persisted
  // data can contain an invalid string. Treat it as unset and let the user choose
  // a valid date instead of producing an Invalid time value exception.
  const parsedDueAt = options.dueAt ? new Date(options.dueAt) : undefined;
  const validDueAt = parsedDueAt && !Number.isNaN(parsedDueAt.getTime()) ? parsedDueAt : undefined;
  return {
    templateId: template.id,
    templateName: template.name,
    steps: template.steps.map((step) => {
      const plannedDate = step.plannedDayOffset === undefined
        ? options.date
        : addLocalDays(options.date, step.plannedDayOffset);
      const dueAt = validDueAt && step.dueOffsetMinutes !== undefined
        ? new Date(validDueAt.getTime() + step.dueOffsetMinutes * 60_000).toISOString()
        : step.id === template.steps[0]?.id
          ? validDueAt?.toISOString()
          : undefined;
      return {
        id: step.id,
        title: replaceTemplateVariables(step.titleTemplate, variables),
        notes: step.notesTemplate ? replaceTemplateVariables(step.notesTemplate, variables) : "",
        tags: [...(step.tags ?? [])],
        priority: step.priority,
        estimatedMinutes: step.estimatedMinutes,
        plannedDate,
        dueAt,
      };
    }),
  };
};

export const buildTaskTemplateInputs = (
  template: TaskTemplate,
  title: string,
  options: {
    date: string;
    dueAt?: string;
    notes?: string;
    tags?: string[];
    priority?: TaskPriority;
    reminderAt?: string;
    now?: Date;
  },
): CreateTaskInput[] => {
  const preview = previewTaskTemplate(template, title, options);
  return preview.steps.map((step, index) => ({
    title: step.title,
    notes: [index === 0 ? options.notes?.trim() : "", step.notes].filter(Boolean).join("\n\n") || undefined,
    plannedDate: step.plannedDate,
    dueAt: step.dueAt,
    tags: [...new Set([...(options.tags ?? []), ...step.tags])],
    priority: step.priority ?? options.priority,
    estimatedMinutes: step.estimatedMinutes,
    reminders: index === 0 && options.reminderAt
      ? [{ id: crypto.randomUUID(), at: options.reminderAt, enabled: true, source: "local" }]
      : [],
    customFields: { templateId: template.id, templateStepId: step.id },
  }));
};

export function useTaskTemplates(): {
  templates: TaskTemplate[];
  install: (template: TaskTemplate) => void;
  remove: (id: string) => void;
} {
  const [custom, setCustom] = useState<TaskTemplate[]>(() => loadCustomTaskTemplates());
  useEffect(() => {
    const refresh = () => setCustom(loadCustomTaskTemplates());
    window.addEventListener(TASK_TEMPLATES_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(TASK_TEMPLATES_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  const install = useCallback((template: TaskTemplate) => {
    installTaskTemplate(template);
    setCustom(loadCustomTaskTemplates());
  }, []);
  const remove = useCallback((id: string) => {
    removeTaskTemplate(id);
    setCustom(loadCustomTaskTemplates());
  }, []);
  const templates = useMemo(() => allTaskTemplates(custom), [custom]);
  return { templates, install, remove };
}
