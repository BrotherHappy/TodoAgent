import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentMarkdown } from "../src/renderer/AgentMarkdown";
import type { DesktopApi } from "../src/shared/desktop-api";

afterEach(() => {
  delete window.desktopApi;
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
});
