// @vitest-environment node

import { describe, expect, it } from "vitest";

import { remoteTaskToCreateInput } from "../electron/feishu/feishu-task-adapter";

const NOW = 1_800_000_000_000;

describe("FeishuTaskAdapter role mapping", () => {
  it("prioritizes assignee when the current user is also a follower", () => {
    const input = remoteTaskToCreateInput(
      {
        guid: "dual-role-task",
        summary: "Dual-role completion",
        mode: 2,
        members: [
          { id: "ou_current", type: "user", role: "follower" },
          { id: "ou_current", type: "user", role: "assignee" },
          { id: "ou_other", type: "user", role: "assignee" },
        ],
        assignee_related: [
          { id: "ou_current", completed_at: String(NOW - 1_000) },
        ],
      },
      "primary",
      () => NOW,
      "ou_current",
    );

    expect(input).toMatchObject({
      completionMode: "any-assignee",
      currentUserRole: "assignee",
      currentUserCompleted: true,
      assigneeIds: ["ou_current", "ou_other"],
      followerIds: ["ou_current"],
    });
  });

  it("keeps a Feishu tasklist binding in source metadata instead of local list fields", () => {
    const input = remoteTaskToCreateInput(
      {
        guid: "tasklist-guid",
        summary: "Tasklist association",
        status: "open",
        tasklists: [
          { tasklist_guid: "tasklist-1", section_guid: "section-1" },
        ],
      },
      "primary",
      () => NOW,
    );

    expect(input.source).toMatchObject({
      tasklist: { tasklistGuid: "tasklist-1", sectionGuid: "section-1" },
    });
    expect(input.listId).toBeUndefined();
    expect(input.sectionId).toBeUndefined();
  });
});
