import { describe, expect, it } from "vitest";
import {
  inferTaskTheme,
  taskThemeAction,
} from "../src/renderer/task-theme-action-packs";
import { resolvePetAction, type PetBehaviorContext } from "../src/renderer/pet-behavior";

const task = (title: string, tags: string[] = []) => ({
  title,
  notes: "",
  privateNotes: "",
  tags,
});
describe("task theme action packs", () => {
  it("maps common task themes to companion postures without changing facts", () => {
    expect(inferTaskTheme(task("阅读论文并整理笔记")).id).toBe("reading");
    expect(inferTaskTheme(task("修复 API bug")).id).toBe("development");
    expect(inferTaskTheme(task("给客户回复邮件")).id).toBe("communication");
    expect(inferTaskTheme(task("晚饭后拉伸 10 分钟")).id).toBe("exercise");
    expect(inferTaskTheme(task("整理桌面", ["家务"])).id).toBe("chores");
    expect(taskThemeAction("research")).toBe("search");
  });

  it("lets higher-priority focus and agent states win over the theme", () => {
    const base: PetBehaviorContext = {
      reducedMotion: false,
      syncing: false,
      agentSending: false,
      agentRunState: "就绪",
      approvalPending: false,
      overdueCount: 0,
      openTaskCount: 1,
      taskTheme: "development",
    };
    expect(resolvePetAction(base)).toBe("work");
    expect(resolvePetAction({ ...base, focus: { phase: "focus", status: "running" } })).toBe("focus");
    expect(resolvePetAction({ ...base, agentSending: true, agentRunState: "搜索资料" })).toBe("search");
  });

  it("falls back to a quiet generic posture for uncategorized work", () => {
    expect(inferTaskTheme(task("买牛奶")).id).toBe("general");
    expect(taskThemeAction(undefined)).toBeUndefined();
  });
});
