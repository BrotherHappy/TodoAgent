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
    expect(pet).toHaveClass("pet-visual-pixel");
    expect(pet).toHaveAttribute("data-pet-visual-style", "pixel");
    expect(pet).toHaveAttribute("data-pet-personality", "calm");
    expect(pet).toHaveAttribute("aria-label", expect.stringContaining("正在陪伴你"));
  });

  it("exposes a static weather cue from structured weather state", () => {
    render(<PetCharacter name="小序" weatherEffect="rain" />);
    const pet = screen.getByRole("img", { name: /小序/u });
    expect(pet).toHaveClass("pet-weather-rain");
    expect(pet).toHaveAttribute("data-pet-weather-effect", "rain");
  });

  it("uses the generated interaction sheet for animated atlas states", () => {
    render(
      <PetCharacter
        name="小序"
        action="pet"
        visualStyle="atlas"
      />,
    );
    const pet = screen.getByRole("img", { name: /小序/u });
    expect(pet).toHaveAttribute("data-pet-atlas-sheet", "interaction");
    expect(pet).toHaveAttribute("data-pet-atlas-animation", "head-pat");
    expect(pet).toHaveAttribute("data-pet-atlas-step", "0");
    expect(pet).toHaveAttribute("data-pet-atlas-ready", "false");
    expect(pet.querySelectorAll(".pet-atlas-buffer-stack > canvas")).toHaveLength(1);
    expect(pet.querySelector(".pet-atlas-buffer-stack"))
      .toHaveAttribute("data-render-path", "single-canvas");
  });
});
