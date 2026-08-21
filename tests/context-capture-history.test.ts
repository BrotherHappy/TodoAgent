import { describe, expect, it, vi } from "vitest";

import {
  CONTEXT_CAPTURE_HISTORY_LIMIT,
  CONTEXT_CAPTURE_HISTORY_TEXT_LIMIT,
  CONTEXT_CAPTURE_HISTORY_CHANGED_EVENT,
  clearContextCaptureHistory,
  parseContextCaptureHistory,
  rememberContextCapture,
  serializeContextCaptureHistory,
} from "../src/renderer/context-capture-history";

describe("context capture history", () => {
  it("accepts only bounded, known and timestamped explicit captures", () => {
    const now = new Date().toISOString();
    const parsed = parseContextCaptureHistory(
      JSON.stringify([
        {
          id: "selected-1",
          kind: "selected-text",
          label: "选中文本",
          text: "  研究摘要  ",
          createdAt: now,
        },
        { id: "bad", kind: "script", label: "不应出现", text: "x", createdAt: now },
        { id: "missing", kind: "clipboard", label: "", text: "x", createdAt: now },
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ kind: "selected-text", text: "研究摘要" });
  });

  it("keeps the newest twelve items and caps serialized text", () => {
    const now = Date.now();
    const items = Array.from({ length: CONTEXT_CAPTURE_HISTORY_LIMIT + 3 }, (_, index) => ({
      id: `context-${index}`,
      kind: "clipboard" as const,
      label: `剪贴板 ${index}`,
      text: "x".repeat(CONTEXT_CAPTURE_HISTORY_TEXT_LIMIT + 100),
      createdAt: new Date(now + index * 1_000).toISOString(),
    }));
    const serialized = serializeContextCaptureHistory(items);
    const parsed = JSON.parse(serialized) as Array<{ text: string }>;
    expect(parsed).toHaveLength(CONTEXT_CAPTURE_HISTORY_LIMIT);
    expect(parsed[0].text).toHaveLength(CONTEXT_CAPTURE_HISTORY_TEXT_LIMIT);
    expect(parsed[0]).toMatchObject({ text: expect.stringMatching(/^x+$/) });
  });

  it("persists explicit pet-window captures and clears them without affecting other keys", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const item = {
      id: "pet-context-1",
      kind: "drop-text" as const,
      label: "拖入文本",
      text: "来自宠物小窗的内容",
      createdAt: new Date().toISOString(),
    };
    expect(rememberContextCapture(item, storage)).toEqual([item]);
    values.set("unrelated", "keep");
    clearContextCaptureHistory(storage);
    expect(values.get("unrelated")).toBe("keep");
    expect(values.size).toBe(1);
  });

  it("notifies mounted Agent surfaces when history changes", () => {
    const onChanged = vi.fn();
    window.addEventListener(CONTEXT_CAPTURE_HISTORY_CHANGED_EVENT, onChanged);
    const item = {
      id: "agent-reply-1",
      kind: "agent-reply" as const,
      label: "Agent 回复",
      text: "可回用的研究结论",
      createdAt: new Date().toISOString(),
    };
    try {
      rememberContextCapture(item, window.localStorage);
      clearContextCaptureHistory(window.localStorage);
      expect(onChanged).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(CONTEXT_CAPTURE_HISTORY_CHANGED_EVENT, onChanged);
      window.localStorage.clear();
    }
  });
});
