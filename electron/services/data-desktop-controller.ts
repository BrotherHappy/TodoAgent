import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  DataImportPreviewMismatchError,
  DataImportValidationError,
  DataPortabilityService,
  type DataExportOptions,
  type DataImportPreview,
  type DataImportResult,
  type DataPortabilityRepository,
  type ImportConflictStrategy,
} from './data-portability-service';

export interface DataFileInfo {
  size: number;
  kind: 'file' | 'directory' | 'other';
}

/** All filesystem effects are kept behind this main-process port. */
export interface DataDesktopFilePort {
  stat(filePath: string): Promise<DataFileInfo>;
  /** Implementations must enforce maxBytes while streaming/reading. */
  readText(filePath: string, maxBytes: number): Promise<string>;
  /**
   * Creates and fsyncs a new file. It must fail when the path already exists,
   * and a failed call must not create or alter that path.
   */
  writeTextDurable(filePath: string, contents: string): Promise<void>;
  /**
   * Atomically replaces targetPath with sourcePath from the same directory.
   * On failure, targetPath must remain unchanged and sourcePath must remain.
   */
  replaceFile(sourcePath: string, targetPath: string): Promise<void>;
  removeFile(filePath: string): Promise<void>;
}

export interface DataDesktopDialogPort {
  chooseExportPath(options: {
    defaultFileName: string;
    allowedExtensions: string[];
  }): Promise<string | undefined>;
  chooseImportPath(options: {
    allowedExtensions: string[];
  }): Promise<string | undefined>;
}

export interface DataDesktopClock {
  now(): Date;
}

export type DataDesktopErrorCode =
  | 'INVALID_PATH'
  | 'INVALID_EXTENSION'
  | 'FILE_NOT_FOUND'
  | 'FILE_NOT_REGULAR'
  | 'FILE_TOO_LARGE'
  | 'FILE_ACCESS_DENIED'
  | 'IMPORT_READ_FAILED'
  | 'IMPORT_INVALID'
  | 'EXPORT_FAILED'
  | 'EXPORT_WRITE_FAILED'
  | 'DIALOG_FAILED'
  | 'INVALID_STRATEGY'
  | 'PREVIEW_NOT_FOUND'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_CANCELLED'
  | 'PREVIEW_ALREADY_USED'
  | 'PREVIEW_STALE'
  | 'IMPORT_COMMIT_FAILED';

export class DataDesktopControllerError extends Error {
  constructor(
    readonly code: DataDesktopErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DataDesktopControllerError';
  }
}

export type ExportToFileResult =
  | { status: 'cancelled' }
  | {
      status: 'exported';
      filePath: string;
      bytes: number;
    };

export interface ImportStrategyPreviews {
  skip: DataImportPreview;
  overwrite: DataImportPreview;
  copy: DataImportPreview;
}

export type PreviewImportResult =
  | { status: 'cancelled' }
  | {
      status: 'ready';
      previewToken: string;
      expiresAt: string;
      filePath: string;
      bytes: number;
      strategies: ImportStrategyPreviews;
    };

export interface CommitImportResult {
  status: 'imported';
  result: DataImportResult;
}

export interface DataDesktopControllerOptions {
  dataRepository: DataPortabilityRepository;
  files: DataDesktopFilePort;
  dialogs: DataDesktopDialogPort;
  clock?: DataDesktopClock;
  createToken?: () => string;
  createCopyId?: (
    kind: 'task' | 'draft' | 'operation',
    originalId: string,
    attempt: number,
  ) => string;
  allowedExtensions?: string[];
  defaultExtension?: string;
  maxImportBytes?: number;
  maxExportBytes?: number;
  previewTtlMs?: number;
  maxPendingPreviews?: number;
}

interface PendingPreview {
  token: string;
  filePath: string;
  json: string;
  createdAtMs: number;
  expiresAtMs: number;
  strategies: ImportStrategyPreviews;
}

interface RetiredPreview {
  reason: 'used' | 'cancelled' | 'expired';
  retainUntilMs: number;
}

const DEFAULT_CLOCK: DataDesktopClock = { now: () => new Date() };
const STRATEGIES: readonly ImportConflictStrategy[] = ['skip', 'overwrite', 'copy'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nodeErrorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === 'string' ? error.code : undefined;

const normalizeExtension = (value: string): string => {
  const trimmed = value.trim().toLocaleLowerCase();
  if (trimmed.length === 0) throw new TypeError('Allowed extensions cannot be empty.');
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
};

export class DataDesktopController {
  readonly #files: DataDesktopFilePort;
  readonly #dialogs: DataDesktopDialogPort;
  readonly #clock: DataDesktopClock;
  readonly #createToken: () => string;
  readonly #allowedExtensions: string[];
  readonly #defaultExtension: string;
  readonly #maxImportBytes: number;
  readonly #maxExportBytes: number;
  readonly #previewTtlMs: number;
  readonly #maxPendingPreviews: number;
  readonly #portability: DataPortabilityService;

  #pending = new Map<string, PendingPreview>();
  #retired = new Map<string, RetiredPreview>();

  constructor(options: DataDesktopControllerOptions) {
    this.#files = options.files;
    this.#dialogs = options.dialogs;
    this.#clock = options.clock ?? DEFAULT_CLOCK;
    this.#createToken = options.createToken ?? randomUUID;
    this.#allowedExtensions = [
      ...new Set((options.allowedExtensions ?? ['.todo-agent.json', '.json']).map(normalizeExtension)),
    ];
    this.#defaultExtension = normalizeExtension(options.defaultExtension ?? '.todo-agent.json');
    if (!this.#allowedExtensions.includes(this.#defaultExtension)) {
      throw new TypeError('defaultExtension must be included in allowedExtensions.');
    }
    this.#maxImportBytes = this.#positiveInteger(
      options.maxImportBytes ?? 25 * 1024 * 1024,
      'maxImportBytes',
    );
    this.#maxExportBytes = this.#positiveInteger(
      options.maxExportBytes ?? 50 * 1024 * 1024,
      'maxExportBytes',
    );
    this.#previewTtlMs = this.#positiveInteger(
      options.previewTtlMs ?? 5 * 60_000,
      'previewTtlMs',
    );
    this.#maxPendingPreviews = this.#positiveInteger(
      options.maxPendingPreviews ?? 5,
      'maxPendingPreviews',
    );
    this.#portability = new DataPortabilityService({
      repository: options.dataRepository,
      now: () => this.#clock.now(),
      // The controller applies the stricter per-direction limits before import
      // and after export. The service still needs enough headroom to validate
      // either representation while keeping its own parser bound finite.
      maxImportBytes: Math.max(this.#maxImportBytes, this.#maxExportBytes),
      createCopyId: options.createCopyId,
    });
  }

  async exportToFile(
    options: DataExportOptions = {},
    selectedPath?: string,
  ): Promise<ExportToFileResult> {
    let chosenPath = selectedPath;
    if (chosenPath === undefined) {
      try {
        chosenPath = await this.#dialogs.chooseExportPath({
          defaultFileName: this.#defaultExportName(),
          allowedExtensions: [...this.#allowedExtensions],
        });
      } catch (error) {
        throw this.#error('DIALOG_FAILED', 'Unable to open the export dialog.', error);
      }
      if (chosenPath === undefined) return { status: 'cancelled' };
    }
    const targetPath = this.#normalizeExportPath(chosenPath);

    let json: string;
    try {
      json = await this.#portability.exportJson(options);
    } catch (error) {
      throw this.#mapError(error, 'export');
    }
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > this.#maxExportBytes) {
      throw this.#error('FILE_TOO_LARGE', 'The export exceeds the configured size limit.');
    }

    const temporaryPath = this.#temporaryPath(targetPath);
    let temporaryCreated = false;
    try {
      await this.#files.writeTextDurable(temporaryPath, json);
      temporaryCreated = true;
      await this.#files.replaceFile(temporaryPath, targetPath);
    } catch (error) {
      // Never delete an unrelated file if exclusive creation reported a name
      // collision. Once creation succeeds, the temporary file is ours.
      if (temporaryCreated) {
        await this.#files.removeFile(temporaryPath).catch(() => undefined);
      }
      throw this.#mapFileError(error, 'EXPORT_WRITE_FAILED', 'Unable to write the export file.');
    }
    return { status: 'exported', filePath: targetPath, bytes };
  }

  async previewImport(filePath?: string): Promise<PreviewImportResult> {
    let selectedPath = filePath;
    if (selectedPath === undefined) {
      try {
        selectedPath = await this.#dialogs.chooseImportPath({
          allowedExtensions: [...this.#allowedExtensions],
        });
      } catch (error) {
        throw this.#error('DIALOG_FAILED', 'Unable to open the import dialog.', error);
      }
      if (selectedPath === undefined) return { status: 'cancelled' };
    }
    const normalizedPath = this.#normalizeImportPath(selectedPath);
    const json = await this.#readImportFile(normalizedPath);

    let strategies: ImportStrategyPreviews;
    try {
      const [skip, overwrite, copy] = await Promise.all([
        this.#portability.previewImport(json, 'skip'),
        this.#portability.previewImport(json, 'overwrite'),
        this.#portability.previewImport(json, 'copy'),
      ]);
      strategies = { skip, overwrite, copy };
    } catch (error) {
      throw this.#mapError(error, 'preview');
    }

    const now = this.#nowMs();
    this.#prune(now);
    while (this.#pending.size >= this.#maxPendingPreviews) {
      const oldest = [...this.#pending.values()].sort(
        (left, right) => left.createdAtMs - right.createdAtMs,
      )[0];
      if (oldest === undefined) break;
      this.#pending.delete(oldest.token);
      this.#retire(oldest.token, 'expired', now);
    }
    const token = this.#newToken();
    const expiresAtMs = now + this.#previewTtlMs;
    this.#pending.set(token, {
      token,
      filePath: normalizedPath,
      json,
      createdAtMs: now,
      expiresAtMs,
      strategies,
    });
    return {
      status: 'ready',
      previewToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      filePath: normalizedPath,
      bytes: Buffer.byteLength(json, 'utf8'),
      strategies: structuredClone(strategies),
    };
  }

  async commitImport(
    previewToken: string,
    strategy: ImportConflictStrategy,
  ): Promise<CommitImportResult> {
    if (!STRATEGIES.includes(strategy)) {
      throw this.#error('INVALID_STRATEGY', 'Unknown import conflict strategy.');
    }
    const now = this.#nowMs();
    this.#prune(now);
    const preview = this.#pending.get(previewToken);
    if (preview === undefined) throw this.#missingPreviewError(previewToken);
    if (preview.expiresAtMs <= now) {
      this.#pending.delete(previewToken);
      this.#retire(previewToken, 'expired', now);
      throw this.#error('PREVIEW_EXPIRED', 'The import preview expired.');
    }

    // Consume before any write attempt. A failed/stale import requires a new
    // preview and therefore can never be replayed with an old authorization.
    this.#pending.delete(previewToken);
    this.#retire(previewToken, 'used', now);
    try {
      const result = await this.#portability.importJson(preview.json, {
        strategy,
        expectedDigest: preview.strategies[strategy].digest,
      });
      return { status: 'imported', result };
    } catch (error) {
      throw this.#mapError(error, 'commit');
    }
  }

  cancelPreview(previewToken: string): boolean {
    const now = this.#nowMs();
    this.#prune(now);
    if (!this.#pending.delete(previewToken)) return false;
    this.#retire(previewToken, 'cancelled', now);
    return true;
  }

  async #readImportFile(filePath: string): Promise<string> {
    let info: DataFileInfo;
    try {
      info = await this.#files.stat(filePath);
    } catch (error) {
      throw this.#mapFileError(error, 'IMPORT_READ_FAILED', 'Unable to inspect the import file.');
    }
    if (info.kind !== 'file') {
      throw this.#error('FILE_NOT_REGULAR', 'The selected import path is not a regular file.');
    }
    if (!Number.isSafeInteger(info.size) || info.size < 0) {
      throw this.#error('IMPORT_READ_FAILED', 'The import file reported an invalid size.');
    }
    if (info.size > this.#maxImportBytes) {
      throw this.#error('FILE_TOO_LARGE', 'The import file exceeds the configured size limit.');
    }
    try {
      const contents = await this.#files.readText(filePath, this.#maxImportBytes);
      if (Buffer.byteLength(contents, 'utf8') > this.#maxImportBytes) {
        throw this.#error('FILE_TOO_LARGE', 'The import file exceeds the configured size limit.');
      }
      return contents;
    } catch (error) {
      if (error instanceof DataDesktopControllerError) throw error;
      throw this.#mapFileError(error, 'IMPORT_READ_FAILED', 'Unable to read the import file.');
    }
  }

  #normalizeExportPath(input: string): string {
    const normalized = this.#normalizePath(input);
    if (this.#hasAllowedExtension(normalized)) return normalized;
    if (path.extname(normalized).length === 0) return `${normalized}${this.#defaultExtension}`;
    throw this.#error('INVALID_EXTENSION', 'The export file extension is not allowed.');
  }

  #normalizeImportPath(input: string): string {
    const normalized = this.#normalizePath(input);
    if (!this.#hasAllowedExtension(normalized)) {
      throw this.#error('INVALID_EXTENSION', 'The import file extension is not allowed.');
    }
    return normalized;
  }

  #normalizePath(input: string): string {
    if (
      typeof input !== 'string' ||
      input.trim().length === 0 ||
      input.includes('\0') ||
      !path.isAbsolute(input)
    ) {
      throw this.#error('INVALID_PATH', 'A valid absolute file path is required.');
    }
    const normalized = path.normalize(input);
    if (normalized === path.parse(normalized).root) {
      throw this.#error('INVALID_PATH', 'A file path is required.');
    }
    return normalized;
  }

  #hasAllowedExtension(filePath: string): boolean {
    const lower = filePath.toLocaleLowerCase();
    return this.#allowedExtensions.some((extension) => lower.endsWith(extension));
  }

  #temporaryPath(targetPath: string): string {
    const token = this.#newRawToken().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    const safeToken = token.length > 0 ? token : randomUUID();
    return path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.${safeToken}.tmp`,
    );
  }

  #defaultExportName(): string {
    const date = this.#clock.now().toISOString().slice(0, 10);
    return `todo-agent-backup-${date}${this.#defaultExtension}`;
  }

  #newToken(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const token = this.#newRawToken();
      if (
        token.length >= 16 &&
        token.length <= 512 &&
        !/[\u0000-\u001f]/.test(token) &&
        !this.#pending.has(token) &&
        !this.#retired.has(token)
      ) return token;
    }
    throw this.#error('IMPORT_INVALID', 'Unable to allocate an import preview token.');
  }

  #newRawToken(): string {
    try {
      return String(this.#createToken());
    } catch (error) {
      throw this.#error('IMPORT_INVALID', 'Unable to allocate an import preview token.', error);
    }
  }

  #prune(now: number): void {
    for (const [token, preview] of this.#pending) {
      if (preview.expiresAtMs <= now) {
        this.#pending.delete(token);
        this.#retire(token, 'expired', now);
      }
    }
    for (const [token, retired] of this.#retired) {
      if (retired.retainUntilMs <= now) this.#retired.delete(token);
    }
  }

  #retire(token: string, reason: RetiredPreview['reason'], now: number): void {
    this.#retired.set(token, {
      reason,
      retainUntilMs: now + this.#previewTtlMs,
    });
    while (this.#retired.size > 100) {
      const first = this.#retired.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.#retired.delete(first);
    }
  }

  #missingPreviewError(token: string): DataDesktopControllerError {
    const reason = this.#retired.get(token)?.reason;
    if (reason === 'used') {
      return this.#error('PREVIEW_ALREADY_USED', 'The import preview token was already used.');
    }
    if (reason === 'cancelled') {
      return this.#error('PREVIEW_CANCELLED', 'The import preview was cancelled.');
    }
    if (reason === 'expired') {
      return this.#error('PREVIEW_EXPIRED', 'The import preview expired.');
    }
    return this.#error('PREVIEW_NOT_FOUND', 'The import preview token was not found.');
  }

  #mapError(error: unknown, operation: 'export' | 'preview' | 'commit'): DataDesktopControllerError {
    if (error instanceof DataDesktopControllerError) return error;
    if (error instanceof DataImportPreviewMismatchError) {
      return this.#error('PREVIEW_STALE', 'Data changed after preview; preview the import again.', error);
    }
    if (error instanceof DataImportValidationError) {
      return this.#error('IMPORT_INVALID', 'The import file failed schema or safety validation.', error);
    }
    if (operation === 'export') {
      return this.#error('EXPORT_FAILED', 'Unable to prepare the export.', error);
    }
    if (operation === 'preview') {
      return this.#error('IMPORT_INVALID', 'Unable to preview the import file.', error);
    }
    return this.#error('IMPORT_COMMIT_FAILED', 'Unable to commit the import.', error);
  }

  #mapFileError(
    error: unknown,
    fallback: 'IMPORT_READ_FAILED' | 'EXPORT_WRITE_FAILED',
    message: string,
  ): DataDesktopControllerError {
    if (error instanceof DataDesktopControllerError) return error;
    const code = nodeErrorCode(error);
    if (code === 'ENOENT') return this.#error('FILE_NOT_FOUND', 'The selected file does not exist.', error);
    if (code === 'EACCES' || code === 'EPERM') {
      return this.#error('FILE_ACCESS_DENIED', 'Permission to access the selected file was denied.', error);
    }
    if (code === 'EFBIG') return this.#error('FILE_TOO_LARGE', 'The selected file is too large.', error);
    return this.#error(fallback, message, error);
  }

  #error(
    code: DataDesktopErrorCode,
    message: string,
    cause?: unknown,
  ): DataDesktopControllerError {
    return new DataDesktopControllerError(code, message, cause);
  }

  #positiveInteger(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${field} must be a positive safe integer.`);
    }
    return value;
  }

  #nowMs(): number {
    const now = this.#clock.now().getTime();
    if (!Number.isFinite(now)) {
      throw this.#error('IMPORT_INVALID', 'The controller clock returned an invalid time.');
    }
    return now;
  }
}
