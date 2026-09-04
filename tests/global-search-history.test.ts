import { afterEach, describe, expect, it } from "vitest";
import {
  clearGlobalSearchHistory,
  readGlobalSearchHistory,
  rememberGlobalSearch,
} from "../src/renderer/global-search-history";

const key = "test:global-search-history";

afterEach(() => {
  clearGlobalSearchHistory(key);
});

describe("global search history", () => {
  it("keeps the newest eight normalized queries and moves repeats to the front", () => {
    for (let index = 0; index < 10; index += 1) {
      rememberGlobalSearch(`  query-${index}  `, key);
    }
    expect(readGlobalSearchHistory(key)).toEqual([
      "query-9",
      "query-8",
      "query-7",
      "query-6",
      "query-5",
      "query-4",
      "query-3",
      "query-2",
    ]);
    expect(rememberGlobalSearch(" QUERY-5 ", key)[0]).toBe("QUERY-5");
    expect(readGlobalSearchHistory(key)).toHaveLength(8);
    expect(readGlobalSearchHistory(key)[0]).toBe("QUERY-5");
  });

  it("rejects empty values and clears without affecting search behavior", () => {
    expect(rememberGlobalSearch(" \0  ", key)).toEqual([]);
    rememberGlobalSearch("今天", key);
    clearGlobalSearchHistory(key);
    expect(readGlobalSearchHistory(key)).toEqual([]);
  });

  it("fails closed on malformed storage", () => {
    localStorage.setItem(key, JSON.stringify({ not: "an array" }));
    expect(readGlobalSearchHistory(key)).toEqual([]);
    localStorage.setItem(key, "not-json");
    expect(readGlobalSearchHistory(key)).toEqual([]);
  });
});
