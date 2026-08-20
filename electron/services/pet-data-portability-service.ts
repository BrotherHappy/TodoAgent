import { createHash } from "node:crypto";

import type { PetPortableState } from "../../src/shared/pet-types";
import {
  normalizePortablePetState,
} from "./pet-service";

export const PET_PORTABLE_DATA_FORMAT = "todo-agent-pet-portable-data" as const;
export type PetDataExportRedaction = "none" | "private" | "strict";
export type PetDataImportStrategy = "skip" | "overwrite";

export interface PetPortableBundle {
  format: typeof PET_PORTABLE_DATA_FORMAT;
  schemaVersion: 1;
  exportedAt: string;
  redaction: PetDataExportRedaction;
  data: { pet: PetPortableState };
}

export interface PetDataRepository {
  readPetSnapshot(): Promise<PetPortableState>;
  replacePetSnapshot(state: PetPortableState): Promise<void>;
}

export interface PetDataExportOptions {
  redaction?: PetDataExportRedaction;
  pretty?: boolean;
}

export interface PetDataCounts {
  rewards: number;
  inventory: number;
  adventures: number;
  miniGames: number;
  diary: number;
  memories: number;
  proactiveMessages: number;
  focusHistory: number;
}

export interface PetDataImportPreview {
  digest: string;
  strategy: PetDataImportStrategy;
  exportedAt: string;
  redaction: PetDataExportRedaction;
  incoming: PetDataCounts;
  existing: PetDataCounts;
  willReplace: boolean;
  activeFocusPreserved: boolean;
  warnings: string[];
}

export interface PetDataImportOptions {
  strategy: PetDataImportStrategy;
  expectedDigest?: string;
}

export interface PetDataImportResult {
  digest: string;
  strategy: PetDataImportStrategy;
  replaced: boolean;
  imported: PetDataCounts;
  activeFocusPreserved: boolean;
}

export class PetDataValidationError extends Error {
  constructor(message: string, readonly path = "$") {
    super(`${message} (${path})`);
    this.name = "PetDataValidationError";
  }
}

export class PetDataPreviewMismatchError extends Error {
  constructor() {
    super("Pet data changed after preview. Generate a new preview before importing.");
    this.name = "PetDataPreviewMismatchError";
  }
}

const clone = <T>(value: T): T => structuredClone(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stableStringify = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

const digest = (value: unknown): string =>
  createHash("sha256").update(stableStringify(value)).digest("hex");

const same = (left: unknown, right: unknown): boolean =>
  stableStringify(left) === stableStringify(right);

const safeTree = (value: unknown, path = "$", depth = 0): void => {
  if (depth > 40) throw new PetDataValidationError("Import is too deeply nested", path);
  if (typeof value === "string") {
    if (value.length > 2 * 1024 * 1024) {
      throw new PetDataValidationError("String is too large", path);
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new PetDataValidationError("Expected a finite number", path);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new PetDataValidationError("Array is too large", path);
    value.forEach((entry, index) => safeTree(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new PetDataValidationError("Expected JSON data", path);
  for (const [key, entry] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new PetDataValidationError("Prototype keys are forbidden", `${path}.${key}`);
    }
    // The pet schema has no credential fields. Rejecting these keys keeps a
    // pasted API key from becoming part of a portable profile by accident.
    if (/token|secret|password|authorization|cookie|credential|api.?key/i.test(key)) {
      throw new PetDataValidationError("Credential fields are forbidden", `${path}.${key}`);
    }
    safeTree(entry, `${path}.${key}`, depth + 1);
  }
};

const expectRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new PetDataValidationError("Expected an object", path);
  return value;
};

const assertOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[], path: string): void => {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new PetDataValidationError(`Unknown field: ${unknown}`, `${path}.${unknown}`);
};

const expectIso = (value: unknown, path: string): string => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PetDataValidationError("Expected an ISO date-time", path);
  }
  return value;
};

const counts = (state: PetPortableState): PetDataCounts => ({
  rewards: state.rewards.length,
  inventory: state.inventory.length,
  adventures: state.adventures.length,
  miniGames: state.miniGames.length,
  diary: state.diary.length,
  memories: state.memories.length,
  proactiveMessages: state.proactiveMessages.length,
  focusHistory: state.focusHistory.length,
});

const redactPet = (state: PetPortableState, redaction: PetDataExportRedaction): PetPortableState => {
  if (redaction === "none") return clone(state);
  const next = clone(state);
  if (redaction === "strict") {
    next.profile.name = "小序";
    next.diary = next.diary.map((entry) => ({
      ...entry,
      title: "私人日记",
      content: "[已隐藏]",
      taskIds: undefined,
    }));
    next.memories = next.memories.map((entry) => ({
      ...entry,
      content: "[已隐藏]",
    }));
  }
  return next;
};

const parseBundle = (json: string, maxBytes: number): PetPortableBundle => {
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new PetDataValidationError("Import exceeds the configured size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new PetDataValidationError("Import is not valid JSON");
  }
  safeTree(parsed);
  const bundle = expectRecord(parsed, "$");
  assertOnlyKeys(bundle, ["format", "schemaVersion", "exportedAt", "redaction", "data"], "$");
  if (bundle.format !== PET_PORTABLE_DATA_FORMAT) {
    throw new PetDataValidationError("Unknown import format", "$.format");
  }
  if (bundle.schemaVersion !== 1) throw new PetDataValidationError("Unsupported import schema", "$.schemaVersion");
  const exportedAt = expectIso(bundle.exportedAt, "$.exportedAt");
  if (!['none', 'private', 'strict'].includes(String(bundle.redaction))) {
    throw new PetDataValidationError("Unknown redaction", "$.redaction");
  }
  const data = expectRecord(bundle.data, "$.data");
  assertOnlyKeys(data, ["pet"], "$.data");
  const pet = expectRecord(data.pet, "$.data.pet");
  assertOnlyKeys(
    pet,
    ["schemaVersion", "revision", "profile", "focusHistory", "rewards", "inventory", "appearance", "adventures", "miniGames", "diary", "memories", "proactiveMessages"],
    "$.data.pet",
  );
  if (pet.focus !== undefined) throw new PetDataValidationError("Active focus cannot be imported", "$.data.pet.focus");
  if (pet.schemaVersion !== 1) throw new PetDataValidationError("Unsupported pet schema", "$.data.pet.schemaVersion");
  if (!Number.isSafeInteger(pet.revision) || Number(pet.revision) < 0) {
    throw new PetDataValidationError("Invalid pet revision", "$.data.pet.revision");
  }
  if (!isRecord(pet.profile)) throw new PetDataValidationError("Expected a pet profile object", "$.data.pet.profile");
  if (!isRecord(pet.appearance)) throw new PetDataValidationError("Expected a pet appearance object", "$.data.pet.appearance");
  const normalized = normalizePortablePetState(pet, "小序");
  const arrays: Array<keyof PetPortableState> = [
    "focusHistory", "rewards", "inventory", "adventures", "miniGames", "diary", "memories", "proactiveMessages",
  ];
  arrays.forEach((key) => {
    if (!Array.isArray(pet[key])) throw new PetDataValidationError("Expected an array", `$.data.pet.${key}`);
  });
  return {
    format: PET_PORTABLE_DATA_FORMAT,
    schemaVersion: 1,
    exportedAt,
    redaction: bundle.redaction as PetDataExportRedaction,
    data: { pet: normalized },
  };
};

const plan = (
  bundle: PetPortableBundle,
  current: PetPortableState,
  strategy: PetDataImportStrategy,
): PetDataImportPreview => ({
  digest: digest({ bundle, strategy, current }),
  strategy,
  exportedAt: bundle.exportedAt,
  redaction: bundle.redaction,
  incoming: counts(bundle.data.pet),
  existing: counts(current),
  willReplace: strategy === "overwrite" && !same(bundle.data.pet, current),
  activeFocusPreserved: true,
  warnings: [
    "当前正在运行的专注会保留，不会被备份覆盖。",
    ...(bundle.redaction === "strict" ? ["该备份已严格隐藏日记和记忆内容。"] : []),
  ],
});

export interface PetDataPortabilityServiceOptions {
  repository: PetDataRepository;
  now?: () => Date;
  maxImportBytes?: number;
}

export class PetDataPortabilityService {
  readonly #repository: PetDataRepository;
  readonly #now: () => Date;
  readonly #maxImportBytes: number;

  constructor(options: PetDataPortabilityServiceOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    this.#maxImportBytes = options.maxImportBytes ?? 10 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxImportBytes) || this.#maxImportBytes < 1) {
      throw new TypeError("maxImportBytes must be a positive safe integer.");
    }
  }

  async createExport(options: PetDataExportOptions = {}): Promise<PetPortableBundle> {
    const state = await this.#repository.readPetSnapshot();
    const redaction = options.redaction ?? "none";
    const bundle: PetPortableBundle = {
      format: PET_PORTABLE_DATA_FORMAT,
      schemaVersion: 1,
      exportedAt: this.#now().toISOString(),
      redaction,
      data: { pet: redactPet(state, redaction) },
    };
    return parseBundle(JSON.stringify(bundle), this.#maxImportBytes);
  }

  async exportJson(options: PetDataExportOptions = {}): Promise<string> {
    const bundle = await this.createExport(options);
    return `${JSON.stringify(bundle, null, options.pretty === false ? 0 : 2)}\n`;
  }

  async previewImport(json: string, strategy: PetDataImportStrategy): Promise<PetDataImportPreview> {
    if (!["skip", "overwrite"].includes(strategy)) {
      throw new PetDataValidationError("Unknown import strategy", "$.strategy");
    }
    const bundle = parseBundle(json, this.#maxImportBytes);
    return plan(bundle, await this.#repository.readPetSnapshot(), strategy);
  }

  async importJson(json: string, options: PetDataImportOptions): Promise<PetDataImportResult> {
    if (!["skip", "overwrite"].includes(options.strategy)) {
      throw new PetDataValidationError("Unknown import strategy", "$.strategy");
    }
    const bundle = parseBundle(json, this.#maxImportBytes);
    const current = await this.#repository.readPetSnapshot();
    const preview = plan(bundle, current, options.strategy);
    if (options.expectedDigest !== undefined && options.expectedDigest !== preview.digest) {
      throw new PetDataPreviewMismatchError();
    }
    const replaced = preview.willReplace;
    if (replaced) await this.#repository.replacePetSnapshot(bundle.data.pet);
    return {
      digest: preview.digest,
      strategy: options.strategy,
      replaced,
      imported: counts(bundle.data.pet),
      activeFocusPreserved: true,
    };
  }
}
