import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PetRoomThemeEditor } from "../src/renderer/PetRoomThemeEditor";

afterEach(cleanup);

describe("PetRoomThemeEditor", () => {
  it("builds a validated local color theme", () => {
    const onInstall = vi.fn();
    render(<PetRoomThemeEditor onInstall={onInstall} />);

    fireEvent.change(screen.getByLabelText("包 ID"), { target: { value: "misty-morning" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "晨雾" } });
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "轻一点的早晨" } });
    fireEvent.change(screen.getByLabelText("顶部颜色"), { target: { value: "#112233" } });
    fireEvent.click(screen.getByRole("button", { name: "安装并应用" }));

    expect(onInstall).toHaveBeenCalledWith(expect.objectContaining({
      id: "misty-morning",
      name: "晨雾",
      colors: expect.objectContaining({ top: "#112233" }),
    }));
  });

  it("fails closed for an invalid id", () => {
    const onInstall = vi.fn();
    render(<PetRoomThemeEditor onInstall={onInstall} />);
    fireEvent.change(screen.getByLabelText("包 ID"), { target: { value: "Bad Pack" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "错误" } });
    fireEvent.click(screen.getByRole("button", { name: "安装并应用" }));
    expect(screen.getByRole("alert")).toHaveTextContent("ID");
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("can load an active pack without changing it on every render", () => {
    const onInstall = vi.fn();
    render(
      <PetRoomThemeEditor
        onInstall={onInstall}
        activePack={{
          id: "focus-pack",
          name: "专注",
          description: "安静",
          colors: { top: "#e9e7ff", ground: "#d8d2f0", window: "#c8ddff", accent: "#746ee2" },
          installedAt: "2026-08-21T00:00:00.000Z",
        }}
      />,
    );
    expect(screen.getByDisplayValue("focus-pack")).toBeVisible();
    expect(screen.getByDisplayValue("专注")).toBeVisible();
  });

  it("offers a local JSON import without installing before confirmation", async () => {
    const onInstall = vi.fn();
    render(<PetRoomThemeEditor onInstall={onInstall} />);
    const input = screen.getByLabelText("导入主题 JSON 文件");
    const file = new File([JSON.stringify({
      id: "imported-theme",
      name: "导入主题",
      colors: { top: "#112233", ground: "#223344", window: "#334455", accent: "#445566" },
    })], "theme.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByDisplayValue("imported-theme")).toBeVisible();
    expect(onInstall).not.toHaveBeenCalled();
  });
});
