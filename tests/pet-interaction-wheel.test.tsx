import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PetInteractionWheel } from "../src/renderer/PetInteractionWheel";

afterEach(cleanup);

describe("PetInteractionWheel", () => {
  it("focuses the first action and supports circular arrow-key navigation", () => {
    render(
      <PetInteractionWheel
        petName="小序"
        onInteract={vi.fn()}
        onStartGame={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const first = screen.getByRole("menuitem", { name: "摸摸头" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(screen.getByRole("menuitem", { name: "开始镜像伸展" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "开始镜像伸展" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(first).toHaveFocus();
  });

  it("runs direct interactions and cooperative games from native buttons", async () => {
    const user = userEvent.setup();
    const onInteract = vi.fn();
    const onStartGame = vi.fn();
    render(
      <PetInteractionWheel
        petName="小序"
        onInteract={onInteract}
        onStartGame={onStartGame}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("menuitem", { name: "喂零食" }));
    expect(onInteract).toHaveBeenCalledWith("treat");
    await user.click(screen.getByRole("menuitem", { name: "开始协作跳绳" }));
    expect(onStartGame).toHaveBeenCalledWith("jump-rope");
  });

  it("closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <PetInteractionWheel
        petName="小序"
        onInteract={vi.fn()}
        onStartGame={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
