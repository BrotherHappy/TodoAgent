import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PetRoomLayoutControls } from "../src/renderer/PetRoomLayoutControls";
import { projectPetRoomPlacements } from "../src/shared/pet-room-layout";

afterEach(cleanup);

describe("PetRoomLayoutControls", () => {
  it("nudges and resizes an active decoration", () => {
    const onChange = vi.fn();
    render(
      <PetRoomLayoutControls
        decorations={["plant"]}
        positions={projectPetRoomPlacements()}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "小植物右移" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      plant: expect.objectContaining({ x: 82, y: 72, scale: 1 }),
    }));

    fireEvent.change(screen.getByRole("slider", { name: "小植物大小" }), { target: { value: "125" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      plant: expect.objectContaining({ scale: 1.25 }),
    }));
  });

  it("resets active decorations and explains an empty room", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PetRoomLayoutControls
        decorations={[]}
        positions={projectPetRoomPlacements({ plant: { x: 40, y: 50, scale: 1.2 } })}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("先在上面的摆件里放好一件，再来调整它的位置。")).toBeVisible();

    rerender(
      <PetRoomLayoutControls
        decorations={["plant"]}
        positions={projectPetRoomPlacements({ plant: { x: 40, y: 50, scale: 1.2 } })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "恢复默认布局" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      plant: { x: 76, y: 72, scale: 1 },
    }));
  });
});

