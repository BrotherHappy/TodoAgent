// @vitest-environment node

import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PetDataDesktopController,
  type PetDataDesktopControllerOptions,
} from "../electron/services/pet-data-desktop-controller";
import type { DataDesktopFilePort, DataFileInfo } from "../electron/services/data-desktop-controller";
import type { PetDataRepository } from "../electron/services/pet-data-portability-service";
import { createDefaultPetState } from "../electron/services/pet-service";
import type { PetPortableState } from "../src/shared/pet-types";

class MemoryFiles implements DataDesktopFilePort {
  readonly files = new Map<string, string>();

  async stat(filePath: string): Promise<DataFileInfo> {
    const contents = this.files.get(filePath);
    if (contents === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { kind: "file", size: Buffer.byteLength(contents, "utf8") };
  }

  async readText(filePath: string): Promise<string> {
    const contents = this.files.get(filePath);
    if (contents === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return contents;
  }

  async writeTextDurable(filePath: string, contents: string): Promise<void> {
    if (this.files.has(filePath)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.files.set(filePath, contents);
  }

  async replaceFile(sourcePath: string, targetPath: string): Promise<void> {
    const contents = this.files.get(sourcePath);
    if (contents === undefined) throw new Error("missing source");
    this.files.delete(sourcePath);
    this.files.set(targetPath, contents);
  }

  async removeFile(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }
}

class MemoryRepository implements PetDataRepository {
  constructor(public state: PetPortableState) {}
  async readPetSnapshot(): Promise<PetPortableState> {
    return structuredClone(this.state);
  }
  async replacePetSnapshot(state: PetPortableState): Promise<void> {
    this.state = structuredClone(state);
  }
}

describe("PetDataDesktopController", () => {
  it("writes a .todo-pet.json file and previews before commit", async () => {
    const files = new MemoryFiles();
    const repository = new MemoryRepository(createDefaultPetState("小序"));
    const root = path.resolve("/tmp/todo-agent-pet-controller");
    const options: PetDataDesktopControllerOptions = {
      repository,
      files,
      dialogs: {
        chooseExportPath: async () => `${root}.todo-pet.json`,
        chooseImportPath: async () => `${root}.todo-pet.json`,
      },
      createToken: (() => {
        let index = 0;
        return () => `token-${++index}-long-enough`;
      })(),
    };
    const controller = new PetDataDesktopController(options);
    const exported = await controller.exportToFile();
    expect(exported.status).toBe("exported");
    expect(files.files.has(`${root}.todo-pet.json`)).toBe(true);
    const preview = await controller.previewImport();
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.strategies.skip.activeFocusPreserved).toBe(true);
    const committed = await controller.commitImport(preview.previewToken, "overwrite");
    expect(committed.result.replaced).toBe(false);
    expect(controller.cancelPreview(preview.previewToken)).toBe(false);
  });
});
