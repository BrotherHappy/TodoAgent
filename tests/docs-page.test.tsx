import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DocsPage } from "../src/renderer/DocsPage";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("DocsPage", () => {
  it("opens with the project map and remembers the selected document", () => {
    const { unmount } = render(<DocsPage />);

    expect(screen.getByRole("main", { name: "项目文档中心" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "文档目录" })).toBeVisible();
    expect(screen.getByRole("button", { name: /统一产品需求文档/u })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "本文目录" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /统一产品需求文档/u }));
    expect(screen.getByRole("heading", { name: /统一产品需求文档.*PRD v2.0/u })).toBeVisible();
    expect(localStorage.getItem("todoAgentDocsDocument")).toBe("prd");

    unmount();
    render(<DocsPage />);
    expect(screen.getByRole("heading", { name: /统一产品需求文档.*PRD v2.0/u })).toBeVisible();
  });

  it("filters the catalogue and follows relative Markdown links", () => {
    render(<DocsPage />);
    const search = screen.getByRole("textbox", { name: "搜索文档" });
    fireEvent.change(search, { target: { value: "飞书" } });

    expect(screen.getByRole("button", { name: /飞书零服务器连接方案/u })).toBeVisible();
    expect(screen.queryByRole("button", { name: /竞品研究/u })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("link", { name: /统一产品需求文档/u }));
    expect(within(screen.getByRole("article")).getByRole("heading", { name: /Todo Agent.*统一产品需求文档/u })).toBeVisible();
  });
});
