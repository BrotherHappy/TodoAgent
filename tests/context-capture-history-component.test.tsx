import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ContextCaptureHistory } from "../src/renderer/ContextCaptureHistory";
import type { ContextCaptureHistoryItem } from "../src/renderer/context-capture-history";

const item: ContextCaptureHistoryItem = {
  id: "context-1",
  kind: "selected-text",
  label: "研究摘要",
  text: "一段可回用的内容",
  createdAt: new Date().toISOString(),
};

describe("ContextCaptureHistory", () => {
  it("lets the user reuse and clear explicitly saved context", () => {
    const onSelect = vi.fn();
    const onClear = vi.fn();
    render(<ContextCaptureHistory items={[item]} onSelect={onSelect} onClear={onClear} />);

    fireEvent.click(screen.getByRole("button", { name: /研究摘要/ }));
    fireEvent.click(screen.getByRole("button", { name: "清空最近上下文" }));
    expect(onSelect).toHaveBeenCalledWith(item);
    expect(onClear).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "最近上下文" })).toBeVisible();
  });

  it("renders no panel when history is empty", () => {
    const { container } = render(
      <ContextCaptureHistory items={[]} onSelect={vi.fn()} onClear={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
