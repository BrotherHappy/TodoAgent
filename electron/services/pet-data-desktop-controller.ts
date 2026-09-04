import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  DataDesktopClock,
  DataDesktopDialogPort,
  DataDesktopFilePort,
} from "./data-desktop-controller";
import {
  PetDataPreviewMismatchError,
  PetDataPortabilityService,
  PetDataValidationError,
  type PetDataExportOptions,
  type PetDataImportPreview,
  type PetDataImportResult,
  type PetDataImportStrategy,
  type PetDataRepository,
} from "./pet-data-portability-service";

export type PetDataDesktopExportResult =
  | { status: "cancelled" }
  | { status: "exported"; filePath: string; bytes: number };

export type PetDataDesktopPreviewResult =
  | { status: "cancelled" }
  | {
      status: "ready";
      previewToken: string;
      expiresAt: string;
      filePath: string;
      bytes: number;
      strategies: Record<PetDataImportStrategy, PetDataImportPreview>;
    };

export interface PetDataDesktopControllerOptions {
  repository: PetDataRepository;
  files: DataDesktopFilePort;
  dialogs: DataDesktopDialogPort;
  clock?: DataDesktopClock;
  createToken?: () => string;
  allowedExtensions?: string[];
  defaultExtension?: string;
  maxImportBytes?: number;
  maxExportBytes?: number;
  previewTtlMs?: number;
}

export class PetDataDesktopControllerError extends Error {
  constructor(readonly code: string, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PetDataDesktopControllerError";
  }
}

interface PendingPreview {
  token: string;
  filePath: string;
  json: string;
  expiresAtMs: number;
  strategies: Record<PetDataImportStrategy, PetDataImportPreview>;
}

const STRATEGIES: readonly PetDataImportStrategy[] = ["skip", "overwrite"];

export class PetDataDesktopController {
  readonly #files: DataDesktopFilePort;
  readonly #dialogs: DataDesktopDialogPort;
  readonly #clock: DataDesktopClock;
  readonly #createToken: () => string;
  readonly #allowedExtensions: string[];
  readonly #defaultExtension: string;
  readonly #maxImportBytes: number;
  readonly #maxExportBytes: number;
  readonly #previewTtlMs: number;
  readonly #portability: PetDataPortabilityService;
  readonly #pending = new Map<string, PendingPreview>();

  constructor(options: PetDataDesktopControllerOptions) {
    this.#files = options.files;
    this.#dialogs = options.dialogs;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#createToken = options.createToken ?? randomUUID;
    this.#allowedExtensions = [...new Set((options.allowedExtensions ?? [".todo-pet.json", ".json"]).map((value) => {
      const normalized = value.trim().toLowerCase();
      return normalized.startsWith(".") ? normalized : `.${normalized}`;
    }))];
    this.#defaultExtension = (options.defaultExtension ?? ".todo-pet.json").toLowerCase();
    if (!this.#allowedExtensions.includes(this.#defaultExtension)) {
      throw new TypeError("defaultExtension must be included in allowedExtensions.");
    }
    this.#maxImportBytes = options.maxImportBytes ?? 10 * 1024 * 1024;
    this.#maxExportBytes = options.maxExportBytes ?? 20 * 1024 * 1024;
    this.#previewTtlMs = options.previewTtlMs ?? 5 * 60_000;
    this.#portability = new PetDataPortabilityService({
      repository: options.repository,
      now: () => this.#clock.now(),
      maxImportBytes: Math.max(this.#maxImportBytes, this.#maxExportBytes),
    });
  }

  async exportToFile(
    options: PetDataExportOptions = {},
    selectedPath?: string,
  ): Promise<PetDataDesktopExportResult> {
    let filePath = selectedPath;
    if (filePath === undefined) {
      filePath = await this.#dialogs.chooseExportPath({
        defaultFileName: `todo-pet-backup-${this.#clock.now().toISOString().slice(0, 10)}${this.#defaultExtension}`,
        allowedExtensions: [...this.#allowedExtensions],
      });
    }
    if (filePath === undefined) return { status: "cancelled" };
    const target = this.#normalizeExportPath(filePath);
    let json: string;
    try {
      json = await this.#portability.exportJson(options);
    } catch (error) {
      throw this.#mapError(error, "Unable to prepare the pet backup.");
    }
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > this.#maxExportBytes) throw new PetDataDesktopControllerError("FILE_TOO_LARGE", "The pet backup exceeds the configured size limit.");
    const temporary = `${target}.${this.#createToken()}.tmp`;
    let created = false;
    try {
      await this.#files.writeTextDurable(temporary, json);
      created = true;
      await this.#files.replaceFile(temporary, target);
    } catch (error) {
      if (created) await this.#files.removeFile(temporary).catch(() => undefined);
      throw new PetDataDesktopControllerError("EXPORT_WRITE_FAILED", "Unable to write the pet backup.", error);
    }
    return { status: "exported", filePath: target, bytes };
  }

  async previewImport(filePath?: string): Promise<PetDataDesktopPreviewResult> {
    let selectedPath = filePath;
    if (selectedPath === undefined) {
      selectedPath = await this.#dialogs.chooseImportPath({ allowedExtensions: [...this.#allowedExtensions] });
    }
    if (selectedPath === undefined) return { status: "cancelled" };
    const normalized = this.#normalizeImportPath(selectedPath);
    let info;
    try {
      info = await this.#files.stat(normalized);
      if (info.kind !== "file") throw new PetDataDesktopControllerError("FILE_NOT_REGULAR", "The selected path is not a regular file.");
      if (info.size > this.#maxImportBytes) throw new PetDataDesktopControllerError("FILE_TOO_LARGE", "The pet backup exceeds the configured size limit.");
    } catch (error) {
      if (error instanceof PetDataDesktopControllerError) throw error;
      throw new PetDataDesktopControllerError("IMPORT_READ_FAILED", "Unable to inspect the pet backup.", error);
    }
    let json: string;
    try {
      json = await this.#files.readText(normalized, this.#maxImportBytes);
    } catch (error) {
      throw new PetDataDesktopControllerError("IMPORT_READ_FAILED", "Unable to read the pet backup.", error);
    }
    const strategies = {
      skip: await this.#portability.previewImport(json, "skip"),
      overwrite: await this.#portability.previewImport(json, "overwrite"),
    } satisfies Record<PetDataImportStrategy, PetDataImportPreview>;
    const now = this.#clock.now().getTime();
    const token = this.#createToken();
    this.#pending.set(token, {
      token,
      filePath: normalized,
      json,
      expiresAtMs: now + this.#previewTtlMs,
      strategies,
    });
    return {
      status: "ready",
      previewToken: token,
      expiresAt: new Date(now + this.#previewTtlMs).toISOString(),
      filePath: normalized,
      bytes: Buffer.byteLength(json, "utf8"),
      strategies: structuredClone(strategies),
    };
  }

  async commitImport(token: string, strategy: PetDataImportStrategy): Promise<{ status: "imported"; result: PetDataImportResult }> {
    if (!STRATEGIES.includes(strategy)) throw new PetDataDesktopControllerError("INVALID_STRATEGY", "Unknown pet import strategy.");
    const pending = this.#pending.get(token);
    if (!pending) throw new PetDataDesktopControllerError("PREVIEW_NOT_FOUND", "The pet import preview was not found.");
    if (pending.expiresAtMs <= this.#clock.now().getTime()) {
      this.#pending.delete(token);
      throw new PetDataDesktopControllerError("PREVIEW_EXPIRED", "The pet import preview expired.");
    }
    this.#pending.delete(token);
    try {
      const result = await this.#portability.importJson(pending.json, {
        strategy,
        expectedDigest: pending.strategies[strategy].digest,
      });
      return { status: "imported", result };
    } catch (error) {
      throw this.#mapError(error, "Unable to commit the pet import.");
    }
  }

  cancelPreview(token: string): boolean {
    return this.#pending.delete(token);
  }

  #normalizeExportPath(input: string): string {
    const normalized = this.#normalizePath(input);
    if (this.#allowedExtensions.some((extension) => normalized.toLowerCase().endsWith(extension))) return normalized;
    if (path.extname(normalized).length === 0) return `${normalized}${this.#defaultExtension}`;
    throw new PetDataDesktopControllerError("INVALID_EXTENSION", "The pet backup extension is not allowed.");
  }

  #normalizeImportPath(input: string): string {
    const normalized = this.#normalizePath(input);
    if (!this.#allowedExtensions.some((extension) => normalized.toLowerCase().endsWith(extension))) {
      throw new PetDataDesktopControllerError("INVALID_EXTENSION", "The pet backup extension is not allowed.");
    }
    return normalized;
  }

  #normalizePath(input: string): string {
    if (typeof input !== "string" || input.trim() === "" || input.includes("\0") || !path.isAbsolute(input)) {
      throw new PetDataDesktopControllerError("INVALID_PATH", "An absolute file path is required.");
    }
    const normalized = path.normalize(input);
    if (normalized === path.parse(normalized).root) throw new PetDataDesktopControllerError("INVALID_PATH", "A file path is required.");
    return normalized;
  }

  #mapError(error: unknown, message: string): PetDataDesktopControllerError {
    if (error instanceof PetDataDesktopControllerError) return error;
    if (error instanceof PetDataPreviewMismatchError) return new PetDataDesktopControllerError("PREVIEW_STALE", "Pet data changed after preview; preview the import again.", error);
    if (error instanceof PetDataValidationError) return new PetDataDesktopControllerError("IMPORT_INVALID", "The pet backup failed schema or safety validation.", error);
    return new PetDataDesktopControllerError("IMPORT_COMMIT_FAILED", message, error);
  }
}

