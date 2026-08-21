import type { AgentCapabilitySettings } from "./settings";

export type AgentCapabilityKey = keyof AgentCapabilitySettings;

export interface AgentCapabilityDescriptor {
  key: AgentCapabilityKey;
  label: string;
  description: string;
  tools: string[];
}

/** The visible order is also the order used in the permissions center. */
export const AGENT_CAPABILITY_DESCRIPTORS: readonly AgentCapabilityDescriptor[] = [
  {
    key: "taskManagement",
    label: "任务读写",
    description: "查询、创建、编辑、完成和规划本地任务",
    tools: ["task_", "move_to_today", "set_reminder", "undo_task_operation"],
  },
  {
    key: "feishuSync",
    label: "飞书同步",
    description: "读取或写回飞书任务；关闭后远端任务会被隔离",
    tools: [],
  },
  {
    key: "webResearch",
    label: "网页研究",
    description: "搜索、抓取公开网页并打开链接",
    tools: ["web_search", "http_fetch", "url_open"],
  },
  {
    key: "filesAndTerminal",
    label: "文件与终端",
    description: "在允许目录中读取文件或运行受限命令",
    tools: ["file_", "terminal_run"],
  },
  {
    key: "clipboardAndScreen",
    label: "剪贴板与屏幕",
    description: "读取/写入剪贴板或捕获屏幕",
    tools: ["clipboard_", "screen_capture"],
  },
] as const;

const descriptorForTool = (toolName: string): AgentCapabilityDescriptor | undefined =>
  AGENT_CAPABILITY_DESCRIPTORS.find((descriptor) =>
    descriptor.tools.some((prefix) => toolName.startsWith(prefix)),
  );

/**
 * Filter the trusted registry before it is exposed to a model.  Unknown tools
 * are kept out by default; adding a new tool therefore requires an explicit
 * capability assignment instead of silently inheriting broad access.
 */
export const isAgentToolEnabled = (
  toolName: string,
  capabilities: AgentCapabilitySettings,
): boolean => {
  const descriptor = descriptorForTool(toolName);
  return descriptor ? capabilities[descriptor.key] : false;
};

export const enabledAgentCapabilityKeys = (
  capabilities: AgentCapabilitySettings,
): AgentCapabilityKey[] =>
  AGENT_CAPABILITY_DESCRIPTORS
    .filter((descriptor) => capabilities[descriptor.key])
    .map((descriptor) => descriptor.key);

