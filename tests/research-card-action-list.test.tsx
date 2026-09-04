import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskResearchCard } from "../src/shared/models";

import {
  ResearchCardActionList,
  researchCardActionKey,
} from "../src/renderer/ResearchCardActionList";

const card: TaskResearchCard = {
  id: "card-1",
  title: "调研结果",
  summary: "摘要",
  actionItems: ["验证来源", "整理对比表"],
  capturedAt: "2026-08-21T08:00:00.000Z",
};

afterEach(() => cleanup());

describe("ResearchCardActionList", () => {
  it("requests an explicit local task for the selected action item", () => {
    const onCreate = vi.fn();
    render(
      <ResearchCardActionList
        card={card}
        createdKeys={new Set()}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "从研究卡创建任务：验证来源" }));
    expect(onCreate).toHaveBeenCalledWith(card, "验证来源", 0);
  });

  it("marks created items and disables them without hiding the other actions", () => {
    render(
      <ResearchCardActionList
        card={card}
        createdKeys={new Set([researchCardActionKey(card.id, 0)])}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "已创建行动任务：验证来源" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "从研究卡创建任务：整理对比表" })).toBeEnabled();
  });
});
