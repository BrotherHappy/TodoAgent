import { describe, expect, it } from "vitest";
import {
  QUICK_CAPTURE_HISTORY_LIMIT,
  QUICK_CAPTURE_HISTORY_TEXT_LIMIT,
  parseQuickCaptureHistory,
  serializeQuickCaptureHistory,
} from "../src/renderer/quick-capture-history";

const item = (id: string, createdAt: string, text = `内容 ${id}`) => ({
  id,
  text,
  title: `标题 ${id}`,
  destination: "task" as const,
  createdAt,
});

describe("quick capture history", () => {
  it("rejects malformed records and keeps the newest unique entries bounded", () => {
    const parsed = parseQuickCaptureHistory(JSON.stringify([
      item("old", "2026-08-15T09:00:00.000Z"),
      item("new", "2026-08-15T10:00:00.000Z"),
      item("new", "2026-08-15T11:00:00.000Z"),
      { id: "bad", destination: "task" },
      item("invalid-date", "not-a-date"),
    ]));
    expect(parsed.map((entry) => entry.id)).toEqual(["new", "old"]);
  });

  it("trims long text without losing the destination contract", () => {
    const parsed = parseQuickCaptureHistory(JSON.stringify([
      {
        ...item("diary", "2026-08-15T10:00:00.000Z", "x".repeat(QUICK_CAPTURE_HISTORY_TEXT_LIMIT + 100)),
        destination: "diary",
      },
    ]));
    expect(parsed[0]).toMatchObject({ id: "diary", destination: "diary" });
    expect(parsed[0]?.text).toHaveLength(QUICK_CAPTURE_HISTORY_TEXT_LIMIT);
  });

  it("serializes only the bounded readable history payload", () => {
    const entries = Array.from({ length: QUICK_CAPTURE_HISTORY_LIMIT + 3 }, (_, index) =>
      item(`item-${index}`, `2026-08-15T${String(index).padStart(2, "0")}:00:00.000Z`),
    );
    const serialized = serializeQuickCaptureHistory(entries);
    expect(JSON.parse(serialized)).toHaveLength(QUICK_CAPTURE_HISTORY_LIMIT);
    expect(JSON.parse(serialized)[0].id).toBe("item-14");
  });

  it("fails closed on invalid storage payloads", () => {
    expect(parseQuickCaptureHistory("not-json")).toEqual([]);
    expect(parseQuickCaptureHistory(JSON.stringify({ entries: [] }))).toEqual([]);
    expect(parseQuickCaptureHistory(null)).toEqual([]);
  });
});
