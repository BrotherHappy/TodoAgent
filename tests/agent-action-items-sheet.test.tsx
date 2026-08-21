import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentActionItemsSheet } from "../src/renderer/AgentActionItemsSheet";
import type { CalendarActionItemDraft } from "../src/shared/calendar-action-items";

const drafts: CalendarActionItemDraft[] = [
  {
    id: "agent-action-1",
    title: "验证来源",
    notes: "来源：Agent 研究回复\n行动项：验证来源",
    plannedDate: "2026-08-21",
  },
  {
    id: "agent-action-2",
    title: "整理对比表",
    notes: "来源：Agent 研究回复\n行动项：整理对比表",
    plannedDate: "2026-08-21",
  },
];

describe("AgentActionItemsSheet", () => {
  afterEach(() => cleanup());

  it("lets the user edit and deselect before confirming local tasks", async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(
      <AgentActionItemsSheet
        sourceLabel="Agent 研究回复"
        sourceText="## 行动项 - 验证来源"
        drafts={drafts}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(screen.getByLabelText("行动项 1"), {
      target: { value: "验证官方来源" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Agent 行动项 2" }));
    fireEvent.click(screen.getByRole("button", { name: "创建 1 项本地任务" }));

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(onConfirm).toHaveBeenCalledWith([
      expect.objectContaining({ title: "验证官方来源" }),
    ]);
  });

  it("keeps the confirmation action disabled when every item is removed", () => {
    render(
      <AgentActionItemsSheet
        sourceLabel="Agent 研究回复"
        sourceText="行动项"
        drafts={drafts}
        onClose={vi.fn()}
        onConfirm={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Agent 行动项 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Agent 行动项 2" }));
    expect(screen.getByRole("button", { name: "创建 0 项本地任务" })).toBeDisabled();
  });
});
