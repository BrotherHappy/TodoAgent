import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PetCollectionCard } from "../src/renderer/PetCollectionCard";

afterEach(cleanup);

describe("PetCollectionCard", () => {
  it("shows progress and unlocked collection entries", () => {
    render(
      <PetCollectionCard
        inventory={[
          { id: "outfit-scarf", quantity: 1, unlockedAt: "2026-08-21T00:00:00.000Z" },
          { id: "toy-ball", quantity: 2, unlockedAt: "2026-08-21T00:00:00.000Z" },
        ]}
      />,
    );

    expect(screen.getByRole("region", { name: "共同收藏图鉴" })).toBeVisible();
    expect(screen.getByText("2/11")).toBeVisible();
    expect(screen.getByText("暖暖围巾")).toBeVisible();
    expect(screen.getByText("毛线球")).toBeVisible();
    expect(screen.getByLabelText("毛线球：已解锁")).toHaveTextContent("×2");
  });

  it("keeps locked entries visible without revealing them as owned", () => {
    render(<PetCollectionCard inventory={[]} />);

    expect(screen.getByText("0/11")).toBeVisible();
    expect(screen.getAllByText("神秘收藏")).toHaveLength(11);
    expect(screen.getByLabelText("探索帽：待解锁，完成一次今日冒险")).toBeVisible();
  });
});
