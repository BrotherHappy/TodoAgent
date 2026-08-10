import { describe, expect, it } from "vitest";

import { mergeAgentDelta } from "../src/renderer/agent-stream-state";

describe("mergeAgentDelta", () => {
  it("appends same-turn deltas once and replaces planning text after a tool turn", () => {
    let text = "";
    let turn = -1;
    for (const event of [
      { turn: 0, delta: "我先查询" },
      { turn: 0, delta: "任务。" },
      { turn: 1, delta: "## 查询结果" },
      { turn: 1, delta: "\n\n- 共 3 项" },
    ]) {
      const next = mergeAgentDelta(text, turn, event.turn, event.delta);
      expect(next).toBeDefined();
      text = next!.text;
      turn = next!.turn;
    }

    expect(text).toBe("## 查询结果\n\n- 共 3 项");
    expect(turn).toBe(1);
  });

  it("ignores stale prior-turn events and empty chunks", () => {
    expect(mergeAgentDelta("最终回答", 2, 1, "旧内容")).toBeUndefined();
    expect(mergeAgentDelta("最终回答", 2, 2, "")).toBeUndefined();
  });
});
