import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentMarkdown } from "../src/renderer/AgentMarkdown";
import type { DesktopApi } from "../src/shared/desktop-api";

afterEach(() => {
  cleanup();
  delete window.desktopApi;
  delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
  window.localStorage.clear();
});

describe("AgentMarkdown", () => {
  it("renders common Markdown and GFM structures", () => {
    const { container } = render(
      <AgentMarkdown
        text={[
          "## 今日计划",
          "",
          "- [x] **完成同步**",
          "- [ ] 继续测试 `Agent`",
          "",
          "| 项目 | 状态 |",
          "| --- | --- |",
          "| 飞书 | 正常 |",
          "",
          "```ts",
          "const ready = true;",
          "```",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("heading", { name: "今日计划" })).toBeVisible();
    expect(screen.getByText("完成同步").closest("strong")).not.toBeNull();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      2,
    );
    expect(screen.getByRole("table")).toBeVisible();
    expect(
      container.querySelector(".agent-markdown-table-scroll > table"),
    ).not.toBeNull();
    expect(screen.getByText("const ready = true;")).toBeVisible();
  });

  it("does not execute raw HTML, unsafe links, or remote Markdown images", () => {
    const { container } = render(
      <AgentMarkdown
        text={[
          '<script data-secret="yes">window.evil = true</script>',
          "[危险链接](javascript:alert(1))",
          "![追踪像素](https://tracker.example/pixel.gif)",
        ].join("\n\n")}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: "危险链接" })).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("图片：追踪像素")).toBeVisible();
  });

  it("opens only safe web links through the desktop shell", () => {
    const openExternal = vi.fn(async () => undefined);
    window.desktopApi = {
      shell: { openExternal },
    } as unknown as DesktopApi;
    render(<AgentMarkdown text="[查看资料](https://example.com/docs)" />);

    fireEvent.click(screen.getByRole("link", { name: "查看资料" }));

    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("saves an explicit completed reply to local recent context", () => {
    render(<AgentMarkdown text={"## 研究结论\n\n- 先验证来源"} />);

    fireEvent.click(screen.getByRole("button", { name: "保存到最近上下文" }));

    expect(screen.getByRole("button", { name: "已保存到最近上下文" })).toBeDisabled();
    const saved = JSON.parse(
      window.localStorage.getItem("todo-agent:context-capture-history:v1") ?? "[]",
    ) as Array<{ kind: string; text: string; label: string }>;
    expect(saved[0]).toMatchObject({
      kind: "agent-reply",
      text: "## 研究结论\n\n- 先验证来源",
      label: "Agent：研究结论 先验证来源",
    });
  });

  it("copies the original Markdown only after an explicit click", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<AgentMarkdown text={"## 研究结论\n\n- 保留来源"} />);

    fireEvent.click(screen.getByRole("button", { name: "复制 Markdown 回复" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("## 研究结论\n\n- 保留来源"));
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "已复制 Markdown 回复" })).toBeDisabled(),
    );
  });

  it("only asks the parent to preview explicit action-item extraction", () => {
    const onExtractActionItems = vi.fn();
    render(
      <AgentMarkdown
        text={"## 行动项\n\n- 验证来源"}
        onExtractActionItems={onExtractActionItems}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "从 Agent 回复提取行动项" }));
    expect(onExtractActionItems).toHaveBeenCalledWith("## 行动项\n\n- 验证来源");
  });

  it("only asks the parent to open a confirmed research-card draft", () => {
    const onSaveResearchCard = vi.fn();
    render(
      <AgentMarkdown
        text={"## 研究结论\n\n- 保留来源"}
        onSaveResearchCard={onSaveResearchCard}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存到当前任务研究卡" }));
    expect(onSaveResearchCard).toHaveBeenCalledWith("## 研究结论\n\n- 保留来源");
  });

  it("does not save or speak a partial streaming reply", () => {
    render(
      <AgentMarkdown
        text="正在生成"
        streaming
        onSaveResearchCard={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "复制 Markdown 回复" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "从 Agent 回复提取行动项" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "保存到最近上下文" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "保存到当前任务研究卡" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "朗读回答" })).toBeDisabled();
    expect(window.localStorage.getItem("todo-agent:context-capture-history:v1")).toBeNull();
  });
});
