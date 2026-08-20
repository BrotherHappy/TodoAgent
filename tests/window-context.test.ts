import { describe, expect, it } from "vitest";
import {
  ACTIVE_WINDOW_CONTEXT_MAX_CHARS,
  buildActiveWindowContext,
  parseActiveWindowOutput,
} from "../src/shared/window-context";

describe("active window context", () => {
  it("parses a bounded app and title pair", () => {
    const result = parseActiveWindowOutput(
      `Code\t${"标题".repeat(ACTIVE_WINDOW_CONTEXT_MAX_CHARS)}`,
      new Date("2026-08-19T08:00:00.000Z"),
    );
    expect(result.status).toBe("captured");
    expect(result.appName).toBe("Code");
    expect(result.title).toHaveLength(ACTIVE_WINDOW_CONTEXT_MAX_CHARS);
    expect(result.capturedAt).toBe("2026-08-19T08:00:00.000Z");
  });

  it("does not expose control characters and degrades to unavailable", () => {
    const captured = buildActiveWindowContext(" Safari\n", " 研究\r\n页面 ");
    expect(captured.appName).toBe("Safari");
    expect(captured.title).toBe("研究 页面");
    expect(buildActiveWindowContext("\n", "\r").reason).toBe("empty");
  });
});
