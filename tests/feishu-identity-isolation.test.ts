// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  CreateTaskInput,
  LocalAppState,
  Task,
  TaskFilter,
  TaskMutationResult,
} from "../src/shared/models";
import { createEmptyLocalAppState } from "../src/shared/models";
import type { FeishuTokenSet } from "../src/shared/feishu-types";
import {
  deriveFeishuAppIdentityId,
  deriveFeishuAuthorizedTokenCredentialId,
  deriveFeishuSyncIdentityId,
} from "../electron/feishu/feishu-credential-ids";
import {
  createFeishuRuntime,
  serializeStoredFeishuToken,
} from "../electron/feishu/feishu-runtime-factory";
import { FeishuStateStore } from "../electron/feishu/feishu-state-store";
import type {
  FeishuLocalStorePort,
  FeishuTaskServicePort,
} from "../electron/feishu/feishu-task-adapter";
import {
  SettingsService,
  type EncryptionAdapter,
} from "../electron/services/settings-service";

const NOW = Date.parse("2026-08-19T06:00:00.000Z");
const encryption: EncryptionAdapter = {
  isAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").slice("encrypted:".length),
};

const clone = <Value>(value: Value): Value => structuredClone(value);

function task(id: string): Task {
  const timestamp = new Date(NOW).toISOString();
  return {
    id,
    source: { type: "feishu", accountId: "primary" },
    title: id,
    notes: "",
    privateNotes: "",
    status: "open",
    priority: "none",
    tags: [],
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
    sync: { status: "pending" },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

class MemoryPorts implements FeishuLocalStorePort, FeishuTaskServicePort {
  state: LocalAppState = createEmptyLocalAppState();

  async transact<Result>(
    mutator: (draft: LocalAppState) => Result | Promise<Result>,
  ): Promise<Result> {
    const draft = clone(this.state);
    const result = await mutator(draft);
    this.state = draft;
    return result;
  }

  async getTask(id: string): Promise<Task | undefined> {
    const value = this.state.tasks[id];
    return value && clone(value);
  }

  async listTasks(filter: TaskFilter = {}): Promise<Task[]> {
    return Object.values(this.state.tasks)
      .filter(
        (value) =>
          (!filter.sourceTypes || filter.sourceTypes.includes(value.source.type)) &&
          (!filter.accountIds ||
            (value.source.accountId !== undefined &&
              filter.accountIds.includes(value.source.accountId))) &&
          (filter.includeDeleted || value.deletedAt === undefined),
      )
      .map(clone);
  }

  async createTask(input: CreateTaskInput): Promise<TaskMutationResult> {
    const value = task(`created-${Object.keys(this.state.tasks).length + 1}`);
    value.source = clone(input.source ?? { type: "local" });
    value.title = input.title;
    value.sync = clone(input.sync ?? { status: "pending" });
    this.state.tasks[value.id] = value;
    return { task: clone(value), operationId: `operation-${value.id}` };
  }
}

function token(openId: string, appIdentityId?: string): FeishuTokenSet {
  return {
    accessToken: `access-${openId}`,
    refreshToken: `refresh-${openId}`,
    openId,
    appIdentityId,
    tokenType: "Bearer",
    scope: ["task:task:read", "task:task:write", "offline_access"],
    expiresAt: NOW + 3_600_000,
  };
}

async function setup() {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "feishu-identity-"));
  const settings = new SettingsService(userDataPath, encryption);
  await settings.load();
  await settings.setCredential("feishu-app-secret", "secret", "secret-ref");
  const ports = new MemoryPorts();
  const runtime = (
    clientId: string,
    tokenCredentialId = "token-slot",
    accountId = "primary",
  ) =>
    createFeishuRuntime({
      accountId,
      userDataPath,
      tokenCredentialId,
      mode: {
        mode: "existing-direct",
        clientId,
        appSecretCredentialId: "secret-ref",
      },
      settings,
      taskService: ports,
      localStore: ports,
      now: () => NOW,
      connectivity: { isOnline: () => false },
    });
  return { userDataPath, settings, ports, runtime };
}

describe("Feishu authorized identity isolation", () => {
  it("keeps queues separate when the same local label logs in as another open_id and survives restart", async () => {
    const context = await setup();
    context.ports.state.tasks.alice = task("alice");
    await context.settings.setCredential(
      "feishu-token",
      serializeStoredFeishuToken(token("ou_alice")),
      "token-slot",
    );

    const alice = await context.runtime("cli_shared");
    await alice.initialize();
    await alice.notifyLocalUpsert("alice");
    await alice.close();

    const aliceOwner = context.ports.state.tasks.alice.source.syncIdentityId;
    expect(aliceOwner).toMatch(/^feishu-sync-/u);

    const restartedAlice = await context.runtime("cli_shared");
    await restartedAlice.initialize();
    await expect(restartedAlice.notifyLocalUpsert("alice")).resolves.toBeUndefined();
    await restartedAlice.close();

    const renamedAlice = await context.runtime(
      "cli_shared",
      "token-slot",
      "renamed-label",
    );
    await renamedAlice.initialize();
    expect(context.ports.state.tasks.alice.source.accountId).toBe(
      "renamed-label",
    );
    await renamedAlice.close();

    // Restore the display label only; ownership remains the same opaque id.
    context.ports.state.tasks.alice.source.accountId = "primary";

    await context.settings.setCredential(
      "feishu-token",
      serializeStoredFeishuToken(token("ou_bob")),
      "token-slot",
    );
    const bob = await context.runtime("cli_shared");
    await bob.initialize();
    await expect(bob.notifyLocalUpsert("alice")).rejects.toThrow(
      /another authorized identity/u,
    );
    context.ports.state.tasks.bob = task("bob");
    await expect(bob.notifyLocalUpsert("bob")).resolves.toBeUndefined();
    expect(context.ports.state.tasks.bob.source.syncIdentityId).not.toBe(
      aliceOwner,
    );
    await bob.close();
  });

  it("claims legacy state once and will not migrate it to a later open_id", async () => {
    const context = await setup();
    const legacyTask = task("legacy-local");
    legacyTask.source.externalId = "remote-legacy";
    context.ports.state.tasks[legacyTask.id] = legacyTask;
    const legacyDirectory = createHash("sha256")
      .update("primary", "utf8")
      .digest("hex")
      .slice(0, 24);
    const legacyStore = new FeishuStateStore({
      directory: path.join(context.userDataPath, "feishu", legacyDirectory),
    });
    await legacyStore.save({
      schemaVersion: 1,
      accountId: "primary",
      mappingsByLocalId: {
        [legacyTask.id]: {
          localId: legacyTask.id,
          guid: "remote-legacy",
          base: { title: legacyTask.title, notes: "", status: "open" },
        },
      },
      localIdByGuid: { "remote-legacy": legacyTask.id },
      queue: [],
      conflicts: {},
    });
    await context.settings.setCredential(
      "feishu-token",
      serializeStoredFeishuToken(token("ou_first")),
      "token-slot",
    );

    const first = await context.runtime("cli_legacy");
    await first.initialize();
    const firstOwner = context.ports.state.tasks[legacyTask.id].source.syncIdentityId;
    expect(firstOwner).toMatch(/^feishu-sync-/u);
    expect((await legacyStore.load())?.syncIdentityId).toBe(firstOwner);
    await first.close();

    await context.settings.setCredential(
      "feishu-token",
      serializeStoredFeishuToken(token("ou_second")),
      "token-slot",
    );
    const second = await context.runtime("cli_legacy");
    await second.initialize();
    await expect(second.notifyLocalUpsert(legacyTask.id)).rejects.toThrow(
      /another authorized identity/u,
    );
    expect(context.ports.state.tasks[legacyTask.id].source.syncIdentityId).toBe(
      firstOwner,
    );
    await second.close();
  });

  it("rejects a persisted token bound to another client id", async () => {
    const context = await setup();
    const appA = deriveFeishuAppIdentityId({
      mode: "existing-direct",
      clientId: "cli_a",
    });
    await context.settings.setCredential(
      "feishu-token",
      serializeStoredFeishuToken(token("ou_user", appA)),
      "token-slot",
    );
    await expect(context.runtime("cli_b")).rejects.toThrow(
      /another OAuth application/u,
    );
  });

  it("derives different credential and state namespaces for users and apps without exposing raw ids", () => {
    const appA = deriveFeishuAppIdentityId({
      mode: "existing-direct",
      clientId: "cli_a",
    });
    const appB = deriveFeishuAppIdentityId({
      mode: "existing-direct",
      clientId: "cli_b",
    });
    const alice = { appIdentityId: appA, openId: "ou_alice" };
    const bob = { appIdentityId: appA, openId: "ou_bob" };
    const otherApp = { appIdentityId: appB, openId: "ou_alice" };
    const values = [
      deriveFeishuAuthorizedTokenCredentialId(alice),
      deriveFeishuAuthorizedTokenCredentialId(bob),
      deriveFeishuAuthorizedTokenCredentialId(otherApp),
      deriveFeishuSyncIdentityId(alice),
      deriveFeishuSyncIdentityId(bob),
      deriveFeishuSyncIdentityId(otherApp),
    ];
    expect(new Set(values)).toHaveLength(values.length);
    expect(values.join(" ")).not.toContain("ou_alice");
    expect(values.join(" ")).not.toContain("ou_bob");
    expect(values.join(" ")).not.toContain("cli_a");
  });
});
