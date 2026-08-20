import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PetCharacter } from "../src/renderer/PetCharacter";

afterEach(cleanup);

describe("PetCharacter personality", () => {
  it("exposes the selected personality to the visual and accessible surface", () => {
    render(
      <PetCharacter
        name="小序"
        mood="idle"
        action="idle"
        personality="calm"
      />,
    );

    const pet = screen.getByRole("img", { name: /冷静管家/u });
    expect(pet).toHaveClass("pet-personality-calm");
    expect(pet).toHaveAttribute("data-pet-personality", "calm");
    expect(pet).toHaveAttribute("aria-label", expect.stringContaining("正在陪伴你"));
  });

  it("exposes a static weather cue from structured weather state", () => {
    render(<PetCharacter name="小序" weatherEffect="rain" />);
    const pet = screen.getByRole("img", { name: /小序/u });
    expect(pet).toHaveClass("pet-weather-rain");
    expect(pet).toHaveAttribute("data-pet-weather-effect", "rain");
  });
});
