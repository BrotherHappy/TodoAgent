import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandPalette, type CommandPaletteAction } from "../src/renderer/CommandPalette";

afterEach(cleanup);

const actions = (run = vi.fn()): CommandPaletteAction[] => [
  {
    id: "today",
    label: "打开今天",
    description: "回到 Today 工作台",
    keywords: ["today", "计划"],
    run,
  },
  {
    id: "capture",
    label: "快速捕获",
    description: "用一句话记下任务",
    keywords: ["quick", "capture", "新增"],
    run,
  },
];

describe("CommandPalette", () => {
  it("focuses the search input and filters commands by label or keyword", async () => {
    const user = userEvent.setup();
    render(<CommandPalette actions={actions()} onClose={vi.fn()} />);

    const input = screen.getByRole("combobox", { name: "搜索快速命令" });
    expect(input).toHaveFocus();
    await user.type(input, "capture");
    expect(screen.getByRole("option", { name: /快速捕获/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /打开今天/ })).toBeNull();
  });

  it("supports arrow navigation and Enter without making the dialog own the action", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette actions={actions(run)} onClose={onClose} />);

    const input = screen.getByRole("combobox", { name: "搜索快速命令" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /快速捕获/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape and with a backdrop click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CommandPalette actions={actions()} onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole("combobox", { name: "搜索快速命令" }), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
