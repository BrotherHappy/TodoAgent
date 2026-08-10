import { describe, expect, it } from "vitest";

import { feishuCreationBlockedMessage } from "../src/renderer/feishu-create-guard";

describe("feishuCreationBlockedMessage", () => {
  it("does not block a local task regardless of Feishu state", () => {
    expect(
      feishuCreationBlockedMessage("local", {
        configured: true,
        connected: false,
      }),
    ).toBeUndefined();
  });

  it("blocks a Feishu task until the account has actually connected", () => {
    expect(feishuCreationBlockedMessage("feishu")).toBe(
      "请先在设置中配置飞书，现有本地任务不会被上传",
    );
    expect(
      feishuCreationBlockedMessage("feishu", {
        configured: true,
        connected: false,
      }),
    ).toBe("飞书尚未连接，请先在设置中完成授权；不会创建成本地任务");
    expect(
      feishuCreationBlockedMessage("feishu", {
        configured: true,
        connected: true,
      }),
    ).toBeUndefined();
  });
});
