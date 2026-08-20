import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PetCompanionAvatar } from "../src/renderer/PetCompanionAvatar";

afterEach(cleanup);

describe("PetCompanionAvatar", () => {
  it("renders a room-only companion with an accessible identity", () => {
    render(
      <PetCompanionAvatar
        kind="moon-moth"
        name="月蛾"
        personality="quiet"
      />,
    );

    const companion = screen.getByRole("img", { name: /月蛾.*月蛾.*安静陪伴/u });
    expect(companion).toHaveClass("pet-companion-avatar", "pet-companion-moon-moth");
    expect(companion).toHaveAttribute("title", "月蛾 · 月蛾 · 安静陪伴");
  });
});
