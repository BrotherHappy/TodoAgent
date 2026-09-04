import { afterEach, describe, expect, it } from "vitest";
import {
  clearGlobalSearchPresets,
  readGlobalSearchPresets,
  removeGlobalSearchPreset,
  saveGlobalSearchPreset,
} from "../src/renderer/global-search-presets";

const key = "test:global-search-presets";

afterEach(() => {
  clearGlobalSearchPresets(key);
});

describe("global search presets", () => {
  it("keeps twelve named searches and updates an existing query in place", () => {
    for (let index = 0; index < 14; index += 1) {
      saveGlobalSearchPreset(`  搜索 ${index}  `, `  query-${index}  `, key);
    }
    expect(readGlobalSearchPresets(key)).toHaveLength(12);
    expect(readGlobalSearchPresets(key)[0]).toMatchObject({
      name: "搜索 13",
      query: "query-13",
    });

    const updated = saveGlobalSearchPreset("新的名字", " QUERY-13 ", key);
    expect(updated).toHaveLength(12);
    expect(updated[0]).toMatchObject({ name: "新的名字", query: "QUERY-13" });
    expect(new Set(updated.map((entry) => entry.id)).size).toBe(12);
  });

  it("normalizes values, removes one item, and clears all items", () => {
    expect(saveGlobalSearchPreset(" \0 ", "今天", key)).toEqual([]);
    const saved = saveGlobalSearchPreset("  今天要做  ", "  今天  的任务 ", key);
    expect(saved[0]).toMatchObject({ name: "今天要做", query: "今天 的任务" });
    expect(removeGlobalSearchPreset(saved[0].id, key)).toEqual([]);

    saveGlobalSearchPreset("一个", "one", key);
    saveGlobalSearchPreset("两个", "two", key);
    expect(removeGlobalSearchPreset("missing", key)).toHaveLength(2);
    clearGlobalSearchPresets(key);
    expect(readGlobalSearchPresets(key)).toEqual([]);
  });

  it("fails closed on malformed or oversized storage", () => {
    localStorage.setItem(key, JSON.stringify({ not: "an array" }));
    expect(readGlobalSearchPresets(key)).toEqual([]);
    localStorage.setItem(key, "not-json");
    expect(readGlobalSearchPresets(key)).toEqual([]);
    localStorage.setItem(key, "x".repeat(40_001));
    expect(readGlobalSearchPresets(key)).toEqual([]);
  });
});
