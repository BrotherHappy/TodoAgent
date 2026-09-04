import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "../src/renderer/dialog-focus";

afterEach(() => cleanup());

function DialogHarness({ onEscape }: { onEscape?: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(dialogRef, firstRef, onEscape);
  return (
    <div ref={dialogRef} role="dialog" tabIndex={-1}>
      <button ref={firstRef} type="button">
        First
      </button>
      <button type="button">Last</button>
    </div>
  );
}

describe("useDialogFocus", () => {
  it("focuses the preferred control, wraps Tab, and delegates Escape", () => {
    const onEscape = vi.fn();
    render(<DialogHarness onEscape={onEscape} />);

    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("ignores inert and aria-hidden controls when finding focus targets", () => {
    const onEscape = vi.fn();
    function HiddenDialogHarness() {
      const dialogRef = useRef<HTMLDivElement>(null);
      useDialogFocus(dialogRef);
      return (
        <div ref={dialogRef} role="dialog" tabIndex={-1}>
          <div inert>
            <button type="button">Inert</button>
          </div>
          <div aria-hidden="true">
            <button type="button">Hidden</button>
          </div>
          <button type="button">Visible</button>
        </div>
      );
    }

    render(<HiddenDialogHarness />);
    expect(screen.getByRole("button", { name: "Visible" })).toHaveFocus();
    expect(onEscape).not.toHaveBeenCalled();
  });
});
