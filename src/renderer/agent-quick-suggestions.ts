import type { Task } from "../shared/models";

export interface AgentQuickSuggestion {
  label: string;
  prompt: string;
}

/**
 * Keep the first Agent action low-friction without guessing a write operation.
 * The prompts are intentionally read-only (or ask for a proposal) so a click
 * never bypasses the existing approval and permission flow.
 */
export function buildAgentQuickSuggestions(
  tasks: readonly Task[],
): AgentQuickSuggestion[] {
  const openCount = tasks.filter((task) => task.status === "open").length;
  if (openCount > 0) {
    return [
      {
        label: "看看今天",
        prompt:
          "请只读列出今天未完成的任务，按优先级和截止风险分组；不要修改任何任务。",
      },
      {
        label: "排一下今天",
        prompt:
          "请根据今天剩余时间给出一个只读执行计划，说明容量假设和取舍；先展示方案，不要修改任务。",
      },
      {
        label: "找个下一步",
        prompt:
          "请从当前未完成任务中确定性找出最适合现在开始的一项，并给出 2–5 个执行步骤；不要直接修改任务。",
      },
    ];
  }
  return [
    {
      label: "回顾完成项",
      prompt:
        "请只读总结最近完成的任务和今天的进展，并指出一个值得保持的节奏；不要修改任何任务。",
    },
    {
      label: "给我一个轻量开始",
      prompt:
        "请给我一个不修改任务的 10 分钟启动建议，帮助我轻松开始下一件小事。",
    },
    {
      label: "告诉我能做什么",
      prompt:
        "请用三句话介绍你现在能如何帮助我管理任务，并给出一个只读示例。",
    },
  ];
}
