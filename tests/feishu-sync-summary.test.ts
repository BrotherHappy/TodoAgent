import { describe, expect, it } from "vitest";
import type { FeishuSyncReportView } from "../src/shared/desktop-api";
import { summarizeFeishuSyncReport } from "../src/renderer/feishu-sync-summary";

const report = (overrides: Partial<FeishuSyncReportView> = {}): FeishuSyncReportView => ({
  pushed: 0,
  pulled: 0,
  deleted: 0,
  conflicts: [],
  offline: false,
  usedFullSync: false,
  ...overrides,
});

describe("Feishu sync summary", () => {
  it("explains a no-op incremental run without implying a full task count", () => {
    expect(summarizeFeishuSyncReport(report())).toEqual({
      modeLabel: "增量同步",
      statusLabel: "同步完成，没有新变化",
      detail: "统计的是本次同步发生的变化；Today、排序、专注等私人字段不会写回飞书。",
      tone: "success",
    });
  });

  it("distinguishes changed full-sync counts from the total remote catalogue", () => {
    expect(summarizeFeishuSyncReport(report({ usedFullSync: true, pushed: 1, pulled: 4, deleted: 2 }))).toMatchObject({
      modeLabel: "全量同步",
      statusLabel: "同步完成，有变化",
      tone: "success",
    });
  });

  it("keeps conflicts visible even when the connection is otherwise healthy", () => {
    expect(summarizeFeishuSyncReport(report({ conflicts: [{ localId: "1" } as never] }))).toMatchObject({
      statusLabel: "发现 1 个冲突",
      tone: "warning",
    });
  });

  it("does not turn a terminal permission failure into a green success", () => {
    expect(summarizeFeishuSyncReport(report({
      issue: { code: "PERMISSION_DENIED", retryable: false },
    }))).toMatchObject({
      modeLabel: "增量同步",
      statusLabel: "需要补充飞书权限",
      tone: "error",
    });
  });
});
