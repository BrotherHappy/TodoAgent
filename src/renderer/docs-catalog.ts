import readme from "../../docs/README.md?raw";
import documentationGuide from "../../docs/DOCUMENTATION_GUIDE.md?raw";
import prd from "../../docs/PRD.md?raw";
import competitiveResearch from "../../docs/COMPETITIVE_PRODUCT_RESEARCH.md?raw";
import uxInformationArchitecture from "../../docs/UX_INFORMATION_ARCHITECTURE.md?raw";
import visualDirection from "../../docs/UI_VISUAL_DIRECTION.md?raw";
import todoPetProduct from "../../docs/TODO_PET_PRODUCT_DESIGN.md?raw";
import todoPetActions from "../../docs/TODO_PET_ACTION_INTERACTION_SPEC.md?raw";
import todoPetImplementation from "../../docs/TODO_PET_IMPLEMENTATION_SPEC.md?raw";
import todoPetAiHandoff from "../../docs/TODO_PET_AI_HANDOFF.md?raw";
import todoPetAtlas from "../../docs/TODO_PET_ATLAS_DESIGN.md?raw";
import technicalArchitecture from "../../docs/TECHNICAL_ARCHITECTURE.md?raw";
import feishuConnection from "../../docs/FEISHU_CONNECTION.md?raw";
import clawdIntegration from "../../docs/CLAWD_INTEGRATION.md?raw";
import implementationStatus from "../../docs/IMPLEMENTATION_STATUS.md?raw";
import qaAudit from "../../docs/QA_REAL_USER_AUDIT.md?raw";
import acceptanceMatrix from "../../docs/GOAL_ACCEPTANCE_MATRIX.md?raw";

export type DocsCategory =
  | "overview"
  | "product"
  | "experience"
  | "pet"
  | "engineering"
  | "quality";

export interface ProjectDoc {
  id: string;
  file: string;
  title: string;
  category: DocsCategory;
  summary: string;
  status: string;
  updatedAt: string;
  keywords: readonly string[];
  content: string;
}

export interface DocHeading {
  level: number;
  text: string;
  id: string;
}

export const docsCategoryMeta: Record<
  DocsCategory,
  { label: string; description: string }
> = {
  overview: {
    label: "开始与约定",
    description: "先了解文档地图、维护方式和交接规则",
  },
  product: {
    label: "产品与研究",
    description: "产品范围、竞品洞察和优先级依据",
  },
  experience: {
    label: "体验与视觉",
    description: "页面结构、核心流程、交互和视觉语言",
  },
  pet: {
    label: "Todo Pet",
    description: "宠物能力、动作、图集与 AI 实现合同",
  },
  engineering: {
    label: "工程与集成",
    description: "架构、飞书连接和外部 Agent 能力边界",
  },
  quality: {
    label: "状态与验收",
    description: "实现进度、真实用户走查和验收证据",
  },
};

const projectDoc = (
  input: Omit<ProjectDoc, "content"> & { content: string },
): ProjectDoc => input;

export const projectDocs: readonly ProjectDoc[] = [
  projectDoc({
    id: "readme",
    file: "README.md",
    title: "文档目录",
    category: "overview",
    summary: "Todo Agent 项目文档的入口、阅读顺序和文档分层。",
    status: "入口",
    updatedAt: "2026-08-30",
    keywords: ["readme", "index", "目录", "入口"],
    content: readme,
  }),
  projectDoc({
    id: "documentation-guide",
    file: "DOCUMENTATION_GUIDE.md",
    title: "文档维护与代码映射指南",
    category: "overview",
    summary: "说明哪些文档驱动哪些代码、如何修改、验证和交接给下一位 AI。",
    status: "约定",
    updatedAt: "2026-08-30",
    keywords: ["guide", "source of truth", "维护", "代码映射", "交接"],
    content: documentationGuide,
  }),
  projectDoc({
    id: "prd",
    file: "PRD.md",
    title: "统一产品需求文档（PRD）",
    category: "product",
    summary: "任务管理、飞书同步、Todo Pet、专注、Agent、提醒和跨平台规划的唯一产品范围。",
    status: "核心基线",
    updatedAt: "2026-08-20",
    keywords: ["prd", "需求", "范围", "优先级", "产品"],
    content: prd,
  }),
  projectDoc({
    id: "competitive-research",
    file: "COMPETITIVE_PRODUCT_RESEARCH.md",
    title: "竞品研究与可借鉴设计",
    category: "product",
    summary: "覆盖任务、日程、AI、开源、本地优先、桌面宠物和专注产品的功能研究。",
    status: "研究",
    updatedAt: "2026-08-20",
    keywords: ["research", "竞品", "Todoist", "TickTick", "QQ 宠物", "开源"],
    content: competitiveResearch,
  }),
  projectDoc({
    id: "ux-information-architecture",
    file: "UX_INFORMATION_ARCHITECTURE.md",
    title: "页面信息架构与核心流程",
    category: "experience",
    summary: "页面层级、主导航、任务与 Agent 流程，以及低保真线框图。",
    status: "交互基线",
    updatedAt: "2026-08-20",
    keywords: ["ux", "ia", "流程", "线框", "导航", "交互"],
    content: uxInformationArchitecture,
  }),
  projectDoc({
    id: "visual-direction",
    file: "UI_VISUAL_DIRECTION.md",
    title: "视觉设计规范",
    category: "experience",
    summary: "轻盈、原生、悬浮的视觉语言，以及桌面常驻场景下的可读性规则。",
    status: "视觉基线",
    updatedAt: "2026-08-20",
    keywords: ["ui", "视觉", "FloGravity", "颜色", "动效", "桌面"],
    content: visualDirection,
  }),
  projectDoc({
    id: "todo-pet-product",
    file: "TODO_PET_PRODUCT_DESIGN.md",
    title: "Todo Pet 产品与体验设计",
    category: "pet",
    summary: "宠物模式的定位、陪伴、提醒、成长、游戏化和桌面交互。",
    status: "体验基线",
    updatedAt: "2026-08-14",
    keywords: ["pet", "宠物", "陪伴", "成长", "游戏化"],
    content: todoPetProduct,
  }),
  projectDoc({
    id: "todo-pet-actions",
    file: "TODO_PET_ACTION_INTERACTION_SPEC.md",
    title: "Todo Pet 动作与互动设计规范",
    category: "pet",
    summary: "待机、任务、专注、同步、Agent 动作和打断规则的实现清单。",
    status: "动作基线",
    updatedAt: "2026-08-15",
    keywords: ["动作", "动画", "互动", "状态机", "跳绳", "游戏"],
    content: todoPetActions,
  }),
  projectDoc({
    id: "todo-pet-implementation",
    file: "TODO_PET_IMPLEMENTATION_SPEC.md",
    title: "Todo Pet 实现规范与验收标准",
    category: "pet",
    summary: "把宠物产品定义转成状态机、数据模型、IPC、权限和测试合同。",
    status: "工程合同",
    updatedAt: "2026-08-14",
    keywords: ["实现", "ipc", "状态机", "验收", "测试", "工程"],
    content: todoPetImplementation,
  }),
  projectDoc({
    id: "todo-pet-ai-handoff",
    file: "TODO_PET_AI_HANDOFF.md",
    title: "Todo Pet AI 实现交接说明",
    category: "pet",
    summary: "让后续 AI 或工程师快速理解阅读顺序、代码边界和首次实现步骤。",
    status: "交接",
    updatedAt: "2026-08-14",
    keywords: ["ai", "handoff", "交接", "开发指令"],
    content: todoPetAiHandoff,
  }),
  projectDoc({
    id: "todo-pet-atlas",
    file: "TODO_PET_ATLAS_DESIGN.md",
    title: "Todo Pet 动作图集与 Clawd 风格实现",
    category: "pet",
    summary: "透明动作图集、帧播放、状态映射和 clawd-on-desk 能力借鉴的视觉工程说明。",
    status: "视觉实现",
    updatedAt: "2026-08-29",
    keywords: ["atlas", "sprite", "帧", "clawd", "图集", "动画"],
    content: todoPetAtlas,
  }),
  projectDoc({
    id: "technical-architecture",
    file: "TECHNICAL_ARCHITECTURE.md",
    title: "技术架构与测试门禁",
    category: "engineering",
    summary: "Electron、React、TypeScript、本地优先数据层、IPC 和跨平台适配边界。",
    status: "架构基线",
    updatedAt: "2026-08-20",
    keywords: ["architecture", "electron", "react", "typescript", "ipc", "架构"],
    content: technicalArchitecture,
  }),
  projectDoc({
    id: "feishu-connection",
    file: "FEISHU_CONNECTION.md",
    title: "飞书零服务器连接方案",
    category: "engineering",
    summary: "飞书 OAuth、凭据缓存、Task v2 同步、冲突处理和真实账号验收门禁。",
    status: "集成基线",
    updatedAt: "2026-08-09",
    keywords: ["feishu", "lark", "oauth", "同步", "任务", "凭据"],
    content: feishuConnection,
  }),
  projectDoc({
    id: "clawd-integration",
    file: "CLAWD_INTEGRATION.md",
    title: "Todo Pet × clawd-on-desk 能力融合",
    category: "engineering",
    summary: "外部 Agent 状态桥接、权限气泡、桌面宠物窗口和安全边界。",
    status: "能力融合",
    updatedAt: "2026-08-29",
    keywords: ["clawd", "agent", "bridge", "权限", "桌面宠物"],
    content: clawdIntegration,
  }),
  projectDoc({
    id: "implementation-status",
    file: "IMPLEMENTATION_STATUS.md",
    title: "实施状态与验收说明",
    category: "quality",
    summary: "当前版本已经实现的能力、仍需外部验证的事项和后续版本范围。",
    status: "状态快照",
    updatedAt: "2026-08-29",
    keywords: ["status", "实现状态", "版本", "快照", "发布"],
    content: implementationStatus,
  }),
  projectDoc({
    id: "qa-audit",
    file: "QA_REAL_USER_AUDIT.md",
    title: "真实用户验收记录",
    category: "quality",
    summary: "以真实用户路径走查启动、任务、宠物、Agent、飞书同步和重启体验。",
    status: "验收记录",
    updatedAt: "2026-08-29",
    keywords: ["qa", "真实用户", "走查", "回归", "验收"],
    content: qaAudit,
  }),
  projectDoc({
    id: "acceptance-matrix",
    file: "GOAL_ACCEPTANCE_MATRIX.md",
    title: "全量验收矩阵",
    category: "quality",
    summary: "按可复现证据记录任务、同步、Agent、宠物和桌面发布的验收结果。",
    status: "验收基线",
    updatedAt: "2026-08-15",
    keywords: ["acceptance", "matrix", "验收", "证据", "测试任务"],
    content: acceptanceMatrix,
  }),
];

export const docsById = new Map(projectDocs.map((doc) => [doc.id, doc]));

export const normalizeDocFile = (value: string): string => {
  const decoded = value.replace(/^\.\//, "").split("#", 1)[0];
  return decoded.replace(/^docs\//, "").replace(/^\//, "");
};

export const findProjectDocByHref = (href: string): ProjectDoc | undefined => {
  const file = normalizeDocFile(decodeURIComponent(href));
  return projectDocs.find((doc) => doc.file === file);
};

const headingSlug = (text: string): string => {
  const normalized = text
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "section";
};

export const slugifyHeading = (text: string, index = 0): string =>
  `doc-${headingSlug(text)}-${index + 1}`;

export const extractDocHeadings = (markdown: string): DocHeading[] => {
  const used = new Map<string, number>();
  return markdown.split(/\r?\n/).flatMap((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const level = match[1].length;
    const text = match[2].replace(/[*_`~]/g, "").trim();
    const base = headingSlug(text);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const id = `doc-${base}-${count + 1}`;
    return [{ level, text, id }];
  });
};

export const docsLastUpdated = "2026-08-30";
