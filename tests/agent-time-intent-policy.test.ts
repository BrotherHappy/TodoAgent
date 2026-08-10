import { describe, expect, it } from "vitest";

import {
  agentTimeIntentPolicyInstruction,
  resolveAgentTimeIntentPolicy,
} from "../electron/agent/agent-time-intent-policy";

describe("Agent time-intent policy", () => {
  it.each([
    [
      "创建一个任务，标题是日期验收，截止日期是 2026-02-30。",
      "AGENT_INVALID_DATE",
      "2026-02-30",
    ],
    ["把任务安排到 2月30日。", "AGENT_INVALID_DATE", "2月30日"],
    ["创建一个任务，周末处理。", "AGENT_AMBIGUOUS_TIME", "周末"],
    ["过几天提醒我提交报告。", "AGENT_AMBIGUOUS_TIME", "过几天"],
    ["明天提醒我提交报告。", "AGENT_REMINDER_TIME_REQUIRED", "具体时刻"],
  ] as const)(
    "requires clarification for unsafe write intent: %s",
    (message, code, detail) => {
      const policy = resolveAgentTimeIntentPolicy(message);
      expect(policy).toMatchObject({
        kind: "clarification-required",
        code,
      });
      if (policy.kind === "clarification-required") {
        expect(policy.clarification).toContain(detail);
      }
    },
  );

  it("allows unambiguous task dates, explicit reminder times, and read-only questions", () => {
    expect(
      resolveAgentTimeIntentPolicy(
        "创建一个任务，下周一上午九点开始，下午六点截止。",
      ),
    ).toEqual({ kind: "allow" });
    expect(
      resolveAgentTimeIntentPolicy("明天下午六点提醒我提交报告。"),
    ).toEqual({ kind: "allow" });
    expect(
      resolveAgentTimeIntentPolicy("周末有哪些未完成任务？"),
    ).toEqual({ kind: "allow" });
    expect(
      resolveAgentTimeIntentPolicy(
        "请创建一个本地任务，标题是验收；不设置日期、备注、标签或提醒，优先级为普通。",
      ),
    ).toEqual({ kind: "allow" });
    expect(
      resolveAgentTimeIntentPolicy("创建任务，不要设置提醒。"),
    ).toEqual({ kind: "allow" });
  });

  it("instructs the model not to invent dates or reminder times outside the preflight coverage", () => {
    const instruction = agentTimeIntentPolicyInstruction();
    expect(instruction).toContain("周末");
    expect(instruction).toContain("过几天");
    expect(instruction).toContain("不得调用任何写工具");
  });
});
