import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PetActionPackEditor } from "../src/renderer/PetActionPackEditor";

afterEach(cleanup);

describe("PetActionPackEditor", () => {
  it("builds a validated declarative pack from selected built-in actions", () => {
    const onInstall = vi.fn();
    render(<PetActionPackEditor onInstall={onInstall} />);

    fireEvent.change(screen.getByLabelText("包 ID"), { target: { value: "cozy-reading" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "安静阅读" } });
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "陪你读一会儿" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "轻轻跳舞" }));
    fireEvent.click(screen.getByRole("button", { name: "安装并启用" }));

    expect(onInstall).toHaveBeenCalledWith(expect.objectContaining({
      id: "cozy-reading",
      name: "安静阅读",
      description: "陪你读一会儿",
      idleActions: expect.arrayContaining(["read", "dance"]),
    }));
  });

  it("loads the active pack and keeps the last action selected", async () => {
    const onInstall = vi.fn();
    render(
      <PetActionPackEditor
        onInstall={onInstall}
        activePack={{
          id: "focus-pack",
          name: "专注",
          description: "安静",
          idleActions: ["idle", "read"],
          installedAt: "2026-08-21T00:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByDisplayValue("focus-pack")).toBeVisible();
    expect(screen.getByDisplayValue("专注")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "安静呼吸" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "安静看书" })).toBeChecked();
  });

  it("fails closed for an invalid pack id", () => {
    const onInstall = vi.fn();
    render(<PetActionPackEditor onInstall={onInstall} />);
    fireEvent.change(screen.getByLabelText("包 ID"), { target: { value: "Bad Pack" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "错误" } });
    fireEvent.click(screen.getByRole("button", { name: "安装并启用" }));
    expect(screen.getByRole("alert")).toHaveTextContent("ID");
    expect(onInstall).not.toHaveBeenCalled();
  });
});
