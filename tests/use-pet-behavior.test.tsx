import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PetBehaviorContext } from "../src/renderer/pet-behavior";
import { usePetBehavior } from "../src/renderer/use-pet-behavior";

const baseContext: PetBehaviorContext = {
  reducedMotion: false,
  syncing: false,
  agentSending: false,
  agentRunState: "就绪",
  approvalPending: false,
  overdueCount: 0,
  openTaskCount: 2,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("usePetBehavior direct-action priority", () => {
  it("settles rapid lifecycle updates before changing the visible pose", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ context }: { context: PetBehaviorContext }) =>
        usePetBehavior(context, "小序", true),
      {
        initialProps: {
          context: { ...baseContext, agentSending: true, agentRunState: "思考中" },
        },
      },
    );

    expect(result.current.action).toBe("think");
    rerender({
      context: { ...baseContext, agentSending: true, agentRunState: "执行工具" },
    });
    expect(result.current.action).toBe("think");
    act(() => vi.advanceTimersByTime(559));
    expect(result.current.action).toBe("think");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.action).toBe("work");

    rerender({ context: baseContext });
    expect(result.current.action).toBe("work");
    act(() => vi.advanceTimersByTime(559));
    expect(result.current.action).toBe("work");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.action).toBe("idle");
  });

  it("lets an explicit drag lift the focused pet, then returns to focus", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePetBehavior(
        {
          ...baseContext,
          focus: { phase: "focus", status: "running" },
        },
        "小序",
        true,
      ),
    );

    expect(result.current.action).toBe("focus");
    act(() => result.current.startDragging());
    expect(result.current.action).toBe("drag");
    act(() => result.current.stopDragging());
    expect(result.current.action).toBe("focus");
  });

  it("does not let direct interactions cover an approval state", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePetBehavior(
        { ...baseContext, approvalPending: true },
        "小序",
        true,
      ),
    );

    act(() => result.current.startDragging());
    expect(result.current.action).toBe("approve");
  });
});
