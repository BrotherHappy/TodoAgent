import { describe, expect, it } from "vitest";
import {
  getActivePetActionPackId,
  installPetActionPack,
  loadInstalledPetActionPacks,
  parsePetActionPackJson,
  removePetActionPack,
  setActivePetActionPackId,
  validatePetActionPack,
} from "../src/renderer/pet-action-packs";
import type { PetIdleAction } from "../src/renderer/pet-behavior";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

describe("pet action packs", () => {
  it("accepts declarative existing actions and rejects code or unknown actions", () => {
    expect(validatePetActionPack({
      id: "cozy-reading",
      name: "安静阅读",
      description: "在工作间隙更多阅读和休息",
      idleActions: ["read", "drink", "stretch", "nap"],
    })).toMatchObject({ ok: true });
    expect(parsePetActionPackJson('{"id":"bad-pack","name":"坏包","idleActions":["work"]}')).toMatchObject({
      ok: false,
      message: expect.stringContaining("待机动作"),
    });
    expect(parsePetActionPackJson('{"id":"script-pack","name":"脚本","idleActions":["read"],"script":"fetch(\\"https://example.com\\")"}')).toMatchObject({
      ok: false,
      message: expect.stringContaining("脚本"),
    });
  });

  it("validates local pacing and frequency preferences", () => {
    expect(validatePetActionPack({
      id: "paced-reading",
      name: "慢慢阅读",
      idleActions: ["read", "drink"],
      cooldownMs: 30_000,
      actionWeights: { read: 5, drink: 1 },
    })).toMatchObject({
      ok: true,
      pack: { cooldownMs: 30_000, actionWeights: { read: 5, drink: 1 } },
    });
    expect(validatePetActionPack({
      id: "too-fast",
      name: "太快",
      idleActions: ["read"],
      cooldownMs: 1_000,
    })).toMatchObject({ ok: false, message: expect.stringContaining("冷却") });
    expect(validatePetActionPack({
      id: "unknown-weight",
      name: "越界",
      idleActions: ["read"],
      actionWeights: { dance: 5 },
    })).toMatchObject({ ok: false, message: expect.stringContaining("当前动作包") });
  });

  it("installs, updates, activates and removes packs without executing content", () => {
    const storage = new MemoryStorage();
    const first = validatePetActionPack({
      id: "cozy-reading",
      name: "安静阅读",
      description: "先读一会儿",
      idleActions: ["read", "drink"],
    });
    if (!first.ok) throw new Error(first.message);
    expect(installPetActionPack(first.pack, storage)).toHaveLength(1);
    setActivePetActionPackId(first.pack.id, storage);
    expect(getActivePetActionPackId(storage)).toBe("cozy-reading");

    const updated = {
      ...first.pack,
      name: "安静阅读 2",
      idleActions: ["read", "stretch"] as PetIdleAction[],
      cooldownMs: 24_000,
      actionWeights: { read: 5, stretch: 2 },
    };
    expect(installPetActionPack(updated, storage)).toMatchObject([{ name: "安静阅读 2" }]);
    expect(loadInstalledPetActionPacks(storage)[0].idleActions).toEqual(["read", "stretch"]);
    expect(loadInstalledPetActionPacks(storage)[0]).toMatchObject({
      cooldownMs: 24_000,
      actionWeights: { read: 5, stretch: 2 },
    });
    expect(removePetActionPack("cozy-reading", storage)).toEqual([]);
    expect(getActivePetActionPackId(storage)).toBeUndefined();
  });
});
