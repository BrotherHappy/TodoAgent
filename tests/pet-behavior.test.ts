import { describe, expect, it } from "vitest";
import {
  canInterruptPetAction,
  idleActionDelayMs,
  idlePetActions,
  interactionResponse,
  petActionDefinitions,
  petInteractionFromPoint,
  pickIdlePetAction,
  resolvePetAction,
} from "../src/renderer/pet-behavior";

const base = {
  reducedMotion: false,
  syncing: false,
  agentSending: false,
  agentRunState: "就绪",
  approvalPending: false,
  overdueCount: 0,
  openTaskCount: 2,
};

describe("Todo Pet behavior state machine", () => {
  it("keeps permission and Agent work ahead of ambient behavior", () => {
    expect(resolvePetAction({ ...base, approvalPending: true, syncing: true })).toBe("approve");
    expect(resolvePetAction({ ...base, agentSending: true, agentRunState: "执行工具" })).toBe("work");
    expect(resolvePetAction({ ...base, agentSending: true, agentRunState: "思考中" })).toBe("think");
  });

  it("maps sync, focus, breaks and overdue work to distinct actions", () => {
    expect(resolvePetAction({ ...base, syncing: true })).toBe("sync");
    expect(resolvePetAction({
      ...base,
      focus: { phase: "focus", status: "running" },
    })).toBe("focus");
    expect(resolvePetAction({
      ...base,
      focus: { phase: "short-break", status: "running" },
    })).toBe("break");
    expect(resolvePetAction({ ...base, overdueCount: 2 })).toBe("alert");
  });

  it("turns reduced motion into a stable accessible pose", () => {
    expect(resolvePetAction({ ...base, reducedMotion: true, approvalPending: true })).toBe("idle");
  });

  it("uses calmer actions at night and bounded idle timing", () => {
    const night = Array.from({ length: 12 }, (_, index) => pickIdlePetAction(index, 23));
    expect(night).toContain("nap");
    expect(night).not.toContain("play");
    for (const seed of [0, 1, 99, 12_345]) {
      expect(idleActionDelayMs(seed)).toBeGreaterThanOrEqual(8_000);
      expect(idleActionDelayMs(seed)).toBeLessThanOrEqual(20_000);
    }
    expect(idleActionDelayMs(0, 30_000)).toBe(30_000);
    expect(idleActionDelayMs(12_345, 999_999)).toBeLessThanOrEqual(72_000);
  });

  it("uses custom action weights without allowing unknown actions into the picker", () => {
    const onlyRead = {
      actions: ["read"] as const,
      weights: { read: 5 },
    };
    expect(Array.from({ length: 20 }, (_, seed) => pickIdlePetAction(seed, 12, onlyRead))).toEqual(
      Array.from({ length: 20 }, () => "read"),
    );
    const weighted = {
      actions: ["read", "drink"] as const,
      weights: { read: 5, drink: 1 },
    };
    expect(pickIdlePetAction(0, 12, weighted)).toBe("read");
    expect(pickIdlePetAction(5, 12, weighted)).toBe("drink");
  });

  it("returns warm, time-boxed responses for direct interactions", () => {
    expect(interactionResponse("pet", "小序")).toMatchObject({ action: "pet" });
    expect(interactionResponse("play", "小序")).toMatchObject({ action: "play" });
    expect(interactionResponse("treat", "小序")).toMatchObject({ action: "snack" });
    expect(interactionResponse("rest", "小序").message).toContain("喝口水");
    expect(interactionResponse("greet", "团团").message).toContain("团团");
  });

  it("ships exactly twenty ambient actions and all eight designed emotions", () => {
    expect(new Set(idlePetActions).size).toBe(20);
    expect(
      new Set(Object.values(petActionDefinitions).map((definition) => definition.emotion)),
    ).toEqual(
      new Set([
        "calm",
        "curious",
        "happy",
        "excited",
        "focused",
        "sleepy",
        "concerned",
        "proud",
      ]),
    );
  });

  it("turns head, belly, hands, and feet into different clickable body zones", () => {
    const rect = { left: 0, top: 0, width: 100, height: 100 };
    expect(petInteractionFromPoint(50, 15, rect)).toBe("head-pat");
    expect(petInteractionFromPoint(50, 55, rect)).toBe("belly-poke");
    expect(petInteractionFromPoint(15, 55, rect)).toBe("high-five");
    expect(petInteractionFromPoint(50, 90, rect)).toBe("tickle");
  });

  it("protects approvals and focused Agent work from ambient interruptions", () => {
    expect(canInterruptPetAction("approve", "wave")).toBe(false);
    expect(canInterruptPetAction("work", "idle")).toBe(false);
    expect(canInterruptPetAction("idle", "pet")).toBe(true);
    expect(canInterruptPetAction("focus", "drag")).toBe(true);
    expect(canInterruptPetAction("approve", "drag")).toBe(false);
  });
});
