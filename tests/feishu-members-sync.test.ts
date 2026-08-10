// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { Task } from "../src/shared/models";
import type { FeishuTaskSyncSnapshot } from "../src/shared/feishu-types";
import {
  buildFeishuCreatePayload,
  buildFeishuTaskMemberMutations,
  localTaskToFeishuSnapshot,
  remoteTaskToFeishuSnapshot,
  threeWayMergeFeishuTask,
} from "../electron/feishu/sync-engine";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "member-task",
    source: { type: "feishu", externalId: "remote-members" },
    title: "Public task",
    notes: "Public notes",
    privateNotes: "never upload",
    status: "open",
    priority: "none",
    tags: ["private-tag"],
    dependencyIds: [],
    assigneeIds: [],
    followerIds: [],
    attachments: [],
    links: [],
    customFields: {},
    reminders: [],
    focusElapsedSeconds: 0,
    focusSessions: [],
    privateOrder: 0,
    sync: { status: "synced" },
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<FeishuTaskSyncSnapshot> = {},
): FeishuTaskSyncSnapshot {
  return {
    title: "Base title",
    notes: "Base notes",
    status: "open",
    assigneeIds: ["ou_owner"],
    followerIds: ["ou_follower"],
    ...overrides,
  };
}

describe("Feishu Task v2 membership sync", () => {
  it("creates an explicit, canonical member collection without leaking private fields", () => {
    const payload = buildFeishuCreatePayload(
      task({
        assigneeIds: ["ou_beta", " ou_alpha ", "ou_beta"],
        followerIds: ["ou_watch", "ou_observer", "ou_watch"],
      }),
      { currentUserOpenId: "ou_current" },
    );

    expect(payload.members).toEqual([
      { id: "ou_alpha", type: "user", role: "assignee" },
      { id: "ou_beta", type: "user", role: "assignee" },
      { id: "ou_observer", type: "user", role: "follower" },
      { id: "ou_watch", type: "user", role: "follower" },
    ]);
    expect(JSON.stringify(payload)).not.toContain("never upload");
    expect(JSON.stringify(payload)).not.toContain("private-tag");

    // Preserve the existing safe default for a fresh Feishu task with no
    // explicit responsible person.
    expect(
      buildFeishuCreatePayload(task(), { currentUserOpenId: "ou_current" })
        .members,
    ).toEqual([{ id: "ou_current", type: "user", role: "assignee" }]);
  });

  it("builds non-destructive member add/remove actions, including a role change", () => {
    const mutations = buildFeishuTaskMemberMutations(
      snapshot({
        assigneeIds: ["ou_owner", "ou_switch"],
        followerIds: ["ou_follower"],
      }),
      snapshot({
        assigneeIds: ["ou_new"],
        followerIds: ["ou_follower", "ou_switch"],
      }),
    );

    expect(mutations).toEqual({
      add: [
        { id: "ou_new", type: "user", role: "assignee" },
        { id: "ou_switch", type: "user", role: "follower" },
      ],
      remove: [
        { id: "ou_owner", type: "user", role: "assignee" },
        { id: "ou_switch", type: "user", role: "assignee" },
      ],
    });

    const partial = snapshot();
    delete partial.assigneeIds;
    delete partial.followerIds;
    expect(() => buildFeishuTaskMemberMutations(partial, snapshot())).toThrow(
      /partial Task v2 response/i,
    );
  });

  it("merges independent member-role edits, detects divergent edits, and safely migrates old bases", () => {
    const independent = threeWayMergeFeishuTask(
      snapshot(),
      snapshot({ assigneeIds: ["ou_local"] }),
      snapshot({ followerIds: ["ou_remote"] }),
    );
    expect(independent).toMatchObject({
      merged: snapshot({
        assigneeIds: ["ou_local"],
        followerIds: ["ou_remote"],
      }),
      localChanges: ["assigneeIds"],
      remoteChanges: ["followerIds"],
      conflicts: [],
    });

    const divergent = threeWayMergeFeishuTask(
      snapshot(),
      snapshot({ assigneeIds: ["ou_local"] }),
      snapshot({ assigneeIds: ["ou_remote"] }),
    );
    expect(divergent.conflicts).toEqual([
      {
        field: "assigneeIds",
        base: ["ou_owner"],
        local: ["ou_local"],
        remote: ["ou_remote"],
      },
    ]);

    // State files written before membership sync have no membership base.
    // On their first complete pull, remote membership wins instead of creating
    // a false conflict against a stale local copy.
    const oldBase = snapshot();
    delete oldBase.assigneeIds;
    delete oldBase.followerIds;
    const migrated = threeWayMergeFeishuTask(
      oldBase,
      snapshot({ assigneeIds: ["ou_stale"] }),
      snapshot({ assigneeIds: ["ou_authoritative"] }),
    );
    expect(migrated).toMatchObject({
      merged: expect.objectContaining({ assigneeIds: ["ou_authoritative"] }),
      remoteChanges: ["assigneeIds"],
      conflicts: [],
    });
  });

  it("maps remote members into snapshots and canonicalizes local order before comparison", () => {
    expect(
      remoteTaskToFeishuSnapshot({
        guid: "remote-members",
        summary: "Remote",
        status: "open",
        members: [
          { id: "ou_b", role: "assignee", type: "user" },
          { id: "ou_a", role: "assignee", type: "user" },
          { id: "ou_watch", role: "follower", type: "user" },
          { id: "app_automation", role: "follower", type: "app" },
        ],
      }),
    ).toMatchObject({
      assigneeIds: ["ou_a", "ou_b"],
      followerIds: ["ou_watch"],
    });
    expect(
      localTaskToFeishuSnapshot(
        task({ assigneeIds: ["ou_b", "ou_a"], followerIds: ["ou_watch"] }),
      ),
    ).toMatchObject({ assigneeIds: ["ou_a", "ou_b"] });
  });
});
