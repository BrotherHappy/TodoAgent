import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KeyboardShortcutsSheet } from "../src/renderer/KeyboardShortcutsSheet";

afterEach(cleanup);

describe("KeyboardShortcutsSheet", () => {
  it("keeps Tab navigation inside the help dialog", () => {
    render(<KeyboardShortcutsSheet onClose={vi.fn()} />);

    const close = screen.getByRole("button", { name: "关闭快捷键说明" });
    const input = screen.getByRole("textbox", { name: "搜索快捷键" });
    input.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(input).toHaveFocus();
  });
});
