// @vitest-environment node

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PetDataPortabilityService,
  PetDataPreviewMismatchError,
  PetDataValidationError,
  type PetDataRepository,
} from "../electron/services/pet-data-portability-service";
import {
  PetService,
  type PetService as PetServiceType,
} from "../electron/services/pet-service";
import type { PetPortableState } from "../src/shared/pet-types";

const clone = <T>(value: T): T => structuredClone(value);

class MemoryRepository implements PetDataRepository {
  state: PetPortableState;
  replacements = 0;

  constructor(state: PetPortableState) {
    this.state = clone(state);
  }

  async readPetSnapshot(): Promise<PetPortableState> {
    return clone(this.state);
  }

  async replacePetSnapshot(state: PetPortableState): Promise<void> {
    this.state = clone(state);
    this.replacements += 1;
  }
}

async function seededPet(): Promise<{ service: PetServiceType; state: PetPortableState }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-portable-"));
  const service = new PetService({ userDataPath: root, initialName: "团团" });
  await service.initialize();
  await service.customize({ palette: "mint", outfit: "scarf" });
  await service.addMemory({ kind: "preference", content: "上午适合深度工作" });
  await service.createDiaryFromCapture({
    localDate: "2026-08-20",
    title: "共同记录",
    content: "今天完成了一件重要的小事。",
  });
  return { service, state: service.portableSnapshot() };
}

describe("PetDataPortabilityService", () => {
  it("exports a readable backup without an active focus session", async () => {
    const { service, state } = await seededPet();
    await service.startFocus({ mode: "count-up" });
    const repository = new MemoryRepository(state);
    const portability = new PetDataPortabilityService({ repository });
    const json = await portability.exportJson();
    const bundle = JSON.parse(json) as { format: string; data: { pet: PetPortableState } };
    expect(bundle.format).toBe("todo-agent-pet-portable-data");
    expect(bundle.data.pet.profile.name).toBe("团团");
    expect("focus" in bundle.data.pet).toBe(false);
    expect(json).toContain("共同记录");
  });

  it("previews overwrite and preserves the running focus when applying", async () => {
    const source = await seededPet();
    const target = await seededPet();
    await target.service.rename("本机宠物");
    await target.service.startFocus({ mode: "count-up" });
    const sourceRepository = new MemoryRepository(source.state);
    const targetRepository = new MemoryRepository(target.service.portableSnapshot());
    const sourcePortability = new PetDataPortabilityService({ repository: sourceRepository });
    const targetPortability = new PetDataPortabilityService({ repository: targetRepository });
    const json = await sourcePortability.exportJson();
    const preview = await targetPortability.previewImport(json, "overwrite");
    expect(preview.willReplace).toBe(true);
    expect(preview.activeFocusPreserved).toBe(true);
    const result = await targetPortability.importJson(json, {
      strategy: "overwrite",
      expectedDigest: preview.digest,
    });
    expect(result.replaced).toBe(true);
    expect(targetRepository.replacements).toBe(1);
    expect(targetRepository.state.profile.name).toBe("团团");
  });

  it("keeps an active focus session when the PetService restores a profile", async () => {
    const source = await seededPet();
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "todo-agent-pet-portable-target-"));
    const target = new PetService({ userDataPath: targetRoot, initialName: "本机宠物" });
    await target.initialize();
    await target.startFocus({ mode: "count-up", taskTitle: "当前工作" });
    const beforeRevision = target.snapshot().revision;
    await target.replacePortableSnapshot(source.state);
    expect(target.snapshot().profile.name).toBe("团团");
    expect(target.snapshot().focus?.taskTitle).toBe("当前工作");
    expect(target.snapshot().revision).toBe(beforeRevision + 1);
  });

  it("keeps the local profile for skip and rejects a stale preview", async () => {
    const source = await seededPet();
    const target = await seededPet();
    await target.service.rename("本机宠物");
    const sourceRepository = new MemoryRepository(source.state);
    const targetRepository = new MemoryRepository(target.service.portableSnapshot());
    const sourcePortability = new PetDataPortabilityService({ repository: sourceRepository });
    const targetPortability = new PetDataPortabilityService({ repository: targetRepository });
    const json = await sourcePortability.exportJson();
    const skipPreview = await targetPortability.previewImport(json, "skip");
    const skipped = await targetPortability.importJson(json, {
      strategy: "skip",
      expectedDigest: skipPreview.digest,
    });
    expect(skipped.replaced).toBe(false);
    expect(targetRepository.replacements).toBe(0);
    expect(targetRepository.state.profile.name).toBe("本机宠物");
    await expect(
      targetPortability.importJson(json, {
        strategy: "overwrite",
        expectedDigest: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(PetDataPreviewMismatchError);
  });

  it("rejects credential-like fields and unknown pet fields", async () => {
    const { state } = await seededPet();
    const repository = new MemoryRepository(state);
    const portability = new PetDataPortabilityService({ repository });
    const base = JSON.parse(await portability.exportJson()) as Record<string, unknown>;
    const data = base.data as { pet: Record<string, unknown> };
    data.pet.apiKey = "secret";
    await expect(portability.previewImport(JSON.stringify(base), "overwrite"))
      .rejects.toBeInstanceOf(PetDataValidationError);
  });
});
