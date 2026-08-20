import { describe, expect, it } from "vitest";
import {
  getActivePetRoomThemePackId,
  installPetRoomThemePack,
  loadInstalledPetRoomThemePacks,
  parsePetRoomThemePackJson,
  removePetRoomThemePack,
  serializePetRoomThemePack,
  setActivePetRoomThemePackId,
  validatePetRoomThemePack,
} from "../src/renderer/pet-room-theme-packs";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

describe("pet room theme packs", () => {
  it("accepts only four normalized hex colors", () => {
    expect(validatePetRoomThemePack({
      id: "misty-morning",
      name: "晨雾",
      description: "轻一点的早晨",
      colors: { top: " #E9E7FF ", ground: "#D8D2F0", window: "#C8DDFF", accent: "#746EE2" },
    })).toMatchObject({
      ok: true,
      pack: { colors: { top: "#e9e7ff", accent: "#746ee2" } },
    });
  });

  it("rejects unknown keys, URLs, CSS and malformed colors", () => {
    expect(parsePetRoomThemePackJson('{"id":"bad-pack","name":"坏包","colors":{"top":"#fff"}}')).toMatchObject({ ok: false });
    expect(validatePetRoomThemePack({
      id: "url-pack",
      name: "外链",
      colors: { top: "url(https://example.com)", ground: "#000000", window: "#000000", accent: "#000000" },
    })).toMatchObject({ ok: false, message: expect.stringContaining("六位") });
    expect(validatePetRoomThemePack({
      id: "script-pack",
      name: "脚本",
      colors: { top: "#000000", ground: "#000000", window: "#000000", accent: "#000000" },
      script: "alert(1)",
    })).toMatchObject({ ok: false, message: expect.stringContaining("脚本") });
  });

  it("installs, updates, activates and removes packs locally", () => {
    const storage = new MemoryStorage();
    const result = validatePetRoomThemePack({
      id: "misty-morning",
      name: "晨雾",
      description: "轻一点的早晨",
      colors: { top: "#e9e7ff", ground: "#d8d2f0", window: "#c8ddff", accent: "#746ee2" },
    });
    if (!result.ok) throw new Error(result.message);
    expect(installPetRoomThemePack(result.pack, storage)).toHaveLength(1);
    setActivePetRoomThemePackId(result.pack.id, storage);
    expect(getActivePetRoomThemePackId(storage)).toBe("misty-morning");

    expect(installPetRoomThemePack({ ...result.pack, name: "晨雾 2" }, storage)).toMatchObject([{ name: "晨雾 2" }]);
    expect(loadInstalledPetRoomThemePacks(storage)[0]?.colors.window).toBe("#c8ddff");
    expect(removePetRoomThemePack(result.pack.id, storage)).toEqual([]);
    expect(getActivePetRoomThemePackId(storage)).toBeUndefined();
  });

  it("serializes a safe, readable JSON package", () => {
    const result = validatePetRoomThemePack({
      id: "misty-morning",
      name: "晨雾",
      description: "轻一点的早晨",
      colors: { top: "#e9e7ff", ground: "#d8d2f0", window: "#c8ddff", accent: "#746ee2" },
    });
    if (!result.ok) throw new Error(result.message);
    const serialized = serializePetRoomThemePack(result.pack);
    expect(serialized).toContain('"colors"');
    expect(parsePetRoomThemePackJson(serialized)).toMatchObject({ ok: true, pack: { id: "misty-morning" } });
  });

  it("keeps the catalog bounded to twelve packs", () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < 14; index += 1) {
      const result = validatePetRoomThemePack({
        id: `theme-${index}`,
        name: `主题 ${index}`,
        colors: { top: "#e9e7ff", ground: "#d8d2f0", window: "#c8ddff", accent: "#746ee2" },
      });
      if (!result.ok) throw new Error(result.message);
      installPetRoomThemePack(result.pack, storage);
    }
    const packs = loadInstalledPetRoomThemePacks(storage);
    expect(packs).toHaveLength(12);
    expect(packs[0]?.id).toBe("theme-2");
    expect(packs.at(-1)?.id).toBe("theme-13");
  });
});
