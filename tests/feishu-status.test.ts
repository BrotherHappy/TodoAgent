import { describe, expect, it } from "vitest";
import { feishuSyncVisualState } from "../src/renderer/feishu-status";

const connected = {
  state: "connected" as const,
  configured: true,
  connected: true,
  polling: true,
};

describe("feishuSyncVisualState", () => {
  it("does not show a sync warning for an unconfigured local-only app", () => {
    expect(feishuSyncVisualState(undefined)).toBeUndefined();
    expect(
      feishuSyncVisualState({
        ...connected,
        configured: false,
        connected: false,
      }),
    ).toBeUndefined();
  });

  it("keeps active sync and retryable network failures pending", () => {
    expect(
      feishuSyncVisualState({ ...connected, state: "syncing" }),
    ).toBe("pending");
    expect(
      feishuSyncVisualState({
        ...connected,
        lastError: {
          code: "NETWORK_UNAVAILABLE",
          message: "offline",
          retryable: true,
        },
      }),
    ).toBe("pending");
  });

  it("keeps permission and terminal failures red even if the account is connected", () => {
    expect(
      feishuSyncVisualState({
        ...connected,
        lastError: {
          code: "PERMISSION_DENIED",
          message: "not allowed",
          retryable: false,
        },
      }),
    ).toBe("error");
    expect(
      feishuSyncVisualState({
        ...connected,
        state: "error",
        lastError: {
          code: "SYNC_FAILED",
          message: "failed",
          retryable: false,
        },
      }),
    ).toBe("error");
  });
});
