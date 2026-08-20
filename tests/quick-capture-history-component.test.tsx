import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickCaptureHistory } from "../src/renderer/QuickCaptureHistory";
import type { QuickCaptureHistoryItem } from "../src/renderer/quick-capture-history";

afterEach(cleanup);

const makeItem = (id: string, destination: QuickCaptureHistoryItem["destination"] = "task") => ({
  id,
  text: `原文 ${id}`,
  title: `捕获 ${id}`,
  destination,
  createdAt: "2026-08-21T10:30:00.000Z",
});

describe("QuickCaptureHistory", () => {
  it("renders nothing when there is no confirmed history", () => {
    const { container } = render(
      <QuickCaptureHistory items={[]} onSelect={vi.fn()} onClear={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the destination and lets the user reuse a captured item", () => {
    const onSelect = vi.fn();
    const item = makeItem("one", "diary");
    render(<QuickCaptureHistory items={[item]} onSelect={onSelect} onClear={vi.fn()} />);
    expect(screen.getByRole("region", { name: "最近捕获" })).toBeVisible();
    expect(screen.getByRole("button", { name: /捕获 one.*日记/u })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /捕获 one/u }));
    expect(onSelect).toHaveBeenCalledWith(item);
  });

  it("limits the visible list to six and exposes a clear action", () => {
    const onClear = vi.fn();
    const items = Array.from({ length: 8 }, (_, index) => makeItem(String(index)));
    render(<QuickCaptureHistory items={items} onSelect={vi.fn()} onClear={onClear} />);
    expect(screen.getAllByRole("button", { name: /^捕获/u })).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "清空最近捕获" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
