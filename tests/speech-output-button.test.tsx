import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpeechOutputButton } from "../src/renderer/SpeechOutputButton";

class FakeUtterance {
  text: string;
  lang = "";
  rate = 0;
  pitch = 0;
  onend?: () => void;
  onerror?: () => void;

  constructor(text: string) {
    this.text = text;
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
  Reflect.deleteProperty(window, "speechSynthesis");
});

describe("SpeechOutputButton", () => {
  it("does not speak until clicked and toggles the local utterance", () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: FakeUtterance,
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak, cancel },
    });

    render(<SpeechOutputButton text="今天先完成同步。" ariaLabel="朗读简报" />);
    const button = screen.getByRole("button", { name: "朗读简报" });
    expect(speak).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(speak).toHaveBeenCalledOnce();
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "停止朗读" }));
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "朗读简报" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("stops stale speech when its text changes", () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: FakeUtterance,
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak, cancel },
    });

    const view = render(<SpeechOutputButton text="第一项任务" />);
    fireEvent.click(screen.getByRole("button", { name: "朗读" }));
    view.rerender(<SpeechOutputButton text="第二项任务" />);

    expect(cancel).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "朗读" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
