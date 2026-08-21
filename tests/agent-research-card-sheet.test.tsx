import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentResearchCardSheet,
  buildAgentResearchCardDraft,
  type AgentResearchCardInput,
} from "../src/renderer/AgentResearchCardSheet";

const draft = buildAgentResearchCardDraft(
  "## 竞品结论\n\n来源：https://example.com/research\n\n行动项：验证官方来源\n- 整理对比表",
  "2026-08-21",
);

describe("AgentResearchCardSheet", () => {
  afterEach(() => cleanup());

  it("builds a readable draft with a safe source and explicit action items", () => {
    expect(draft).toMatchObject({
      title: "竞品结论",
      url: "https://example.com/research",
      summary: expect.stringContaining("竞品结论"),
      actionItems: ["验证官方来源", "整理对比表"],
    });
  });

  it("lets the user edit the private card before confirming", async () => {
    const onConfirm = vi.fn(async (_input: AgentResearchCardInput) => undefined);
    render(
      <AgentResearchCardSheet
        taskTitle="整理竞品"
        sourceText="## 竞品结论\n\n验证官方来源"
        draft={draft}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "竞品结论（已确认）" },
    });
    fireEvent.change(screen.getByLabelText("行动项（每行一条，可选）"), {
      target: { value: "验证官方来源\n联系产品负责人" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存私人研究卡" }));

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(onConfirm).toHaveBeenCalledWith({
      title: "竞品结论（已确认）",
      url: "https://example.com/research",
      summary: expect.stringContaining("竞品结论"),
      actionItems: ["验证官方来源", "联系产品负责人"],
    });
  });

  it("fails closed for an invalid source and keeps the card local", () => {
    const onConfirm = vi.fn(async () => undefined);
    render(
      <AgentResearchCardSheet
        taskTitle="整理竞品"
        sourceText="研究回复"
        draft={{ ...draft, url: "" }}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(screen.getByLabelText("来源链接（可选）"), {
      target: { value: "javascript:alert(1)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存私人研究卡" }));

    expect(screen.getByRole("alert")).toHaveTextContent("只支持不带账号密码");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
