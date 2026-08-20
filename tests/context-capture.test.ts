import { describe, expect, it } from "vitest";
import {
  CLIPBOARD_CONTEXT_MAX_CHARS,
  buildClipboardContextPreview,
  buildSelectedTextContextPreview,
} from "../src/shared/context-capture";

describe("clipboard context preview", () => {
  it("keeps a bounded, auditable preview", () => {
    const raw = "x".repeat(CLIPBOARD_CONTEXT_MAX_CHARS + 20);
    const result = buildClipboardContextPreview(raw, new Date("2026-08-19T08:00:00.000Z"));
    expect(result.text).toHaveLength(CLIPBOARD_CONTEXT_MAX_CHARS);
    expect(result.characters).toBe(raw.length);
    expect(result.truncated).toBe(true);
    expect(result.capturedAt).toBe("2026-08-19T08:00:00.000Z");
  });

  it("does not mark short text as truncated", () => {
    expect(buildClipboardContextPreview("整理会议记录").truncated).toBe(false);
  });

  it("uses the same bounded preview contract for explicitly selected text", () => {
    const result = buildSelectedTextContextPreview("选中的段落", new Date("2026-08-19T08:00:00.000Z"));
    expect(result).toMatchObject({
      source: "selected-text",
      text: "选中的段落",
      characters: 5,
      truncated: false,
      capturedAt: "2026-08-19T08:00:00.000Z",
    });
  });
});
