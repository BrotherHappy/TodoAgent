import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResearchCardMarkdown } from "../src/renderer/ResearchCardMarkdown";
import type { DesktopApi } from "../src/shared/desktop-api";

afterEach(() => {
  cleanup();
  delete window.desktopApi;
});

describe("ResearchCardMarkdown", () => {
  it("renders saved research with headings, lists, tables and code", () => {
    const { container } = render(
      <ResearchCardMarkdown
        text={[
          "## 结论",
          "",
          "- **保留来源**",
          "",
          "| 方案 | 状态 |",
          "| --- | --- |",
          "| 本地 | 可用 |",
          "",
          "```ts",
          "const ready = true;",
          "```",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("heading", { name: "结论" })).toBeVisible();
    expect(screen.getByText("保留来源").closest("strong")).not.toBeNull();
    expect(screen.getByRole("table")).toBeVisible();
    expect(container.querySelector(".research-card-markdown-table-scroll > table")).not.toBeNull();
    expect(screen.getByText("const ready = true;")).toBeVisible();
  });

  it("does not execute raw HTML, unsafe links or remote images", () => {
    const { container } = render(
      <ResearchCardMarkdown
        text={'<script>window.evil = true</script>\n\n[危险](javascript:alert(1))\n\n![图片](https://example.com/pixel.png)'}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: "危险" })).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("图片：图片")).toBeVisible();
  });

  it("opens only a safe source through the desktop shell", () => {
    const openExternal = vi.fn(async () => undefined);
    window.desktopApi = {
      shell: { openExternal },
    } as unknown as DesktopApi;
    render(<ResearchCardMarkdown text="[查看来源](https://example.com/research)" />);

    fireEvent.click(screen.getByRole("link", { name: "查看来源" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/research");
  });
});
