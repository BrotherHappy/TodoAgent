import { describe, expect, it } from "vitest";

import {
  agentTimeContextInstruction,
  createAgentTimeContext,
} from "../electron/agent/agent-time-context";

describe("Agent time context", () => {
  it("derives a positive-offset local date and time across a UTC year boundary", () => {
    const context = createAgentTimeContext(
      new Date("2025-12-31T18:30:15.000Z"),
      "Asia/Shanghai",
    );

    expect(context).toMatchObject({
      timeZone: "Asia/Shanghai",
      localDate: "2026-01-01",
      localTime: "02:30:15",
      utcOffset: "+08:00",
      weekday: "星期四",
      instant: "2025-12-31T18:30:15.000Z",
    });
    expect(agentTimeContextInstruction(context)).toContain(
      "plannedDate 是本地日历日 YYYY-MM-DD",
    );
    expect(agentTimeContextInstruction(context)).toContain(
      "startAt 和 dueAt 必须是带 offset 的 ISO 8601 时间",
    );
  });

  it("refreshes the offset at the DST transition instead of treating a timezone as a fixed offset", () => {
    const before = createAgentTimeContext(
      new Date("2026-03-08T09:59:59.000Z"),
      "America/Los_Angeles",
    );
    const after = createAgentTimeContext(
      new Date("2026-03-08T10:00:00.000Z"),
      "America/Los_Angeles",
    );

    expect(before).toMatchObject({
      localDate: "2026-03-08",
      localTime: "01:59:59",
      utcOffset: "-08:00",
      weekday: "星期日",
    });
    expect(after).toMatchObject({
      localDate: "2026-03-08",
      localTime: "03:00:00",
      utcOffset: "-07:00",
      weekday: "星期日",
    });
  });

  it("falls back to the actual device timezone for an unusable configured timezone", () => {
    const systemTimeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const context = createAgentTimeContext(
      new Date("2026-08-10T00:00:00.000Z"),
      "Not/A-Real-Timezone",
    );

    expect(context.timeZone).toBe(systemTimeZone);
    expect(context.localDate).toMatch(/^2026-\d{2}-\d{2}$/u);
    expect(context.localTime).toMatch(/^\d{2}:\d{2}:\d{2}$/u);
    expect(context.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/u);
  });
});
