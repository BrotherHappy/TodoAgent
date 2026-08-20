import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PetWeatherForecast } from "../src/renderer/PetWeatherForecast";

describe("PetWeatherForecast", () => {
  it("shows a compact forecast strip and marks cached data", () => {
    render(
      <PetWeatherForecast
        stale
        today="2026-08-21"
        forecast={[
          {
            date: "2026-08-21",
            conditionCode: 0,
            conditionLabel: "晴",
            lowC: 22,
            highC: 33,
            precipitationProbability: 10,
            severe: false,
          },
        ]}
      />,
    );
    expect(screen.getByRole("region", { name: "未来天气预览" })).toBeInTheDocument();
    expect(screen.getByText("缓存中的预报")).toBeInTheDocument();
    expect(screen.getByLabelText(/今天，晴/u)).toBeInTheDocument();
    expect(screen.getByText("22℃ / 33℃")).toBeInTheDocument();
  });

  it("does not reserve a card when there is no forecast", () => {
    const { container } = render(<PetWeatherForecast />);
    expect(container).toBeEmptyDOMElement();
  });
});
