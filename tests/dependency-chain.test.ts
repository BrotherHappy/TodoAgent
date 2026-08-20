import { describe, expect, it } from "vitest";

import { buildDependencyChain } from "../src/renderer/dependency-chain";
import type { Task } from "../src/shared/models";

const task = (
  id: string,
  dependencyIds: string[] = [],
  status: Task["status"] = "open",
): Pick<Task, "id" | "title" | "status" | "dependencyIds"> => ({
  id,
  title: id,
  status,
  dependencyIds,
});

describe("dependency chain projection", () => {
  it("orders prerequisite work deepest-first and downstream work nearest-first", () => {
    const result = buildDependencyChain(task("ship", ["review"]), [
      task("draft", []),
      task("review", ["draft"]),
      task("ship", ["review"]),
      task("announce", ["ship"]),
      task("follow-up", ["announce"]),
    ]);

    expect(result.ancestors.map((item) => [item.task.id, item.depth])).toEqual([
      ["draft", 2],
      ["review", 1],
    ]);
    expect(result.downstream.map((item) => [item.task.id, item.depth])).toEqual([
      ["announce", 1],
      ["follow-up", 2],
    ]);
    expect(result.missingDependencyIds).toEqual([]);
    expect(result.cycleDetected).toBe(false);
  });

  it("keeps missing dependencies and flags imported cycles", () => {
    const result = buildDependencyChain(task("a", ["missing", "b"]), [
      task("a", ["missing", "b"]),
      task("b", ["a"]),
    ]);

    expect(result.missingDependencyIds).toEqual(["missing"]);
    expect(result.cycleDetected).toBe(true);
    expect(result.ancestors.map((item) => item.task.id)).toContain("b");
    expect(result.ancestors.map((item) => item.task.id)).not.toContain("a");
  });
});
