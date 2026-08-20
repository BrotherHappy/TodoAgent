import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, realpath, stat, unlink, chmod, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import type { TaskAttachment, TaskAttachmentPreview } from "../../src/shared/models";

/**
 * Local task attachments are deliberately kept outside the app bundle and
 * outside the exported task JSON. The renderer only receives metadata; every
 * open/delete request is checked against this directory again in the main
 * process.
 */
export const TASK_ATTACHMENT_LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxBatchBytes: 100 * 1024 * 1024,
  maxBatchFiles: 20,
} as const;

export const TASK_ATTACHMENT_PREVIEW_LIMITS = {
  maxTextBytes: 512 * 1024,
  maxImageBytes: 4 * 1024 * 1024,
} as const;

const safeFileName = (value: string): string => {
  const normalized = value.normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").trim();
  return (normalized || "附件").slice(0, 120);
};

const extensionMimeTypes: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

const textPreviewMimeTypes: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".log": "text/plain",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
};

const imagePreviewMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const isPathLikeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;

export class TaskAttachmentService {
  readonly directory: string;

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, "attachments");
  }

  private async ensureDirectory(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Keep the directory private even when it already existed with a broad
    // mode from an older build or a manual migration.
    await chmod(this.directory, 0o700).catch(() => undefined);
    return realpath(this.directory);
  }

  private async resolveStoredPath(attachment: Pick<TaskAttachment, "id" | "localPath">): Promise<string> {
    if (!attachment.localPath || !attachment.id.trim()) throw new Error("INVALID_TASK_ATTACHMENT");
    const root = await this.ensureDirectory();
    const requested = path.resolve(attachment.localPath);
    if (!isWithin(root, requested) || !path.basename(requested).startsWith(`${attachment.id}-`)) {
      throw new Error("UNSAFE_TASK_ATTACHMENT_PATH");
    }
    const target = await realpath(requested);
    if (!isWithin(root, target)) throw new Error("UNSAFE_TASK_ATTACHMENT_PATH");
    const info = await stat(target);
    if (!info.isFile()) throw new Error("TASK_ATTACHMENT_NOT_FILE");
    return target;
  }

  async copySelectedFiles(selectedPaths: readonly string[]): Promise<TaskAttachment[]> {
    if (selectedPaths.length > TASK_ATTACHMENT_LIMITS.maxBatchFiles) {
      throw new Error("TASK_ATTACHMENT_TOO_MANY_FILES");
    }
    const root = await this.ensureDirectory();
    const created: string[] = [];
    let totalBytes = 0;
    try {
      const attachments: TaskAttachment[] = [];
      for (const selectedPath of selectedPaths) {
        if (!selectedPath || !path.isAbsolute(selectedPath)) throw new Error("INVALID_TASK_ATTACHMENT_SOURCE");
        const source = await realpath(selectedPath);
        const info = await lstat(source);
        if (!info.isFile()) throw new Error("TASK_ATTACHMENT_NOT_FILE");
        if (info.size > TASK_ATTACHMENT_LIMITS.maxFileBytes) throw new Error("TASK_ATTACHMENT_FILE_TOO_LARGE");
        totalBytes += info.size;
        if (totalBytes > TASK_ATTACHMENT_LIMITS.maxBatchBytes) throw new Error("TASK_ATTACHMENT_BATCH_TOO_LARGE");

        const id = randomUUID();
        const name = safeFileName(path.basename(source));
        const destination = path.join(root, `${id}-${name}`);
        await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
        created.push(destination);
        await chmod(destination, 0o600).catch(() => undefined);
        const extension = path.extname(name).toLowerCase();
        attachments.push({
          id,
          name,
          size: info.size,
          localPath: destination,
          ...(extensionMimeTypes[extension] ? { mimeType: extensionMimeTypes[extension] } : {}),
        });
      }
      return attachments;
    } catch (error) {
      await Promise.all(created.map((filePath) => unlink(filePath).catch(() => undefined)));
      throw error;
    }
  }

  async open(attachment: Pick<TaskAttachment, "id" | "localPath">): Promise<string> {
    return this.resolveStoredPath(attachment);
  }

  async preview(
    attachment: Pick<TaskAttachment, "id" | "localPath">,
  ): Promise<TaskAttachmentPreview> {
    const filePath = await this.resolveStoredPath(attachment);
    const info = await stat(filePath);
    const basename = path.basename(filePath);
    const prefix = `${attachment.id}-`;
    const name = basename.startsWith(prefix) ? basename.slice(prefix.length) : "附件";
    const extension = path.extname(name).toLowerCase();
    const textMimeType = textPreviewMimeTypes[extension];
    if (textMimeType !== undefined) {
      if (info.size > TASK_ATTACHMENT_PREVIEW_LIMITS.maxTextBytes) {
        return { kind: "unsupported", name, mimeType: textMimeType, reason: "too-large", bytes: info.size };
      }
      return {
        kind: "text",
        name,
        mimeType: textMimeType,
        content: await readFile(filePath, "utf8"),
        bytes: info.size,
      };
    }
    const mimeType = extensionMimeTypes[extension];
    if (mimeType !== undefined && imagePreviewMimeTypes.has(mimeType)) {
      if (info.size > TASK_ATTACHMENT_PREVIEW_LIMITS.maxImageBytes) {
        return { kind: "unsupported", name, mimeType, reason: "too-large", bytes: info.size };
      }
      const data = await readFile(filePath);
      return {
        kind: "image",
        name,
        mimeType: mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
        dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
        bytes: info.size,
      };
    }
    return {
      kind: "unsupported",
      name,
      ...(mimeType ? { mimeType } : {}),
      reason: mimeType ? "binary" : "unsupported",
      bytes: info.size,
    };
  }

  async remove(attachment: Pick<TaskAttachment, "id" | "localPath">): Promise<void> {
    const filePath = await this.resolveStoredPath(attachment);
    await unlink(filePath).catch((error: unknown) => {
      if (!isPathLikeError(error) || error.code !== "ENOENT") throw error;
    });
  }

  async removeUnreferenced(referencedPaths: ReadonlySet<string>): Promise<number> {
    const root = await this.ensureDirectory();
    const entries = await readdir(root, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const candidate = path.join(root, entry.name);
      const resolved = entry.isSymbolicLink()
        ? candidate
        : await realpath(candidate).catch(() => candidate);
      if (referencedPaths.has(candidate) || referencedPaths.has(resolved)) continue;
      await unlink(candidate).catch((error: unknown) => {
        if (!isPathLikeError(error) || error.code !== "ENOENT") throw error;
      });
      removed += 1;
    }
    return removed;
  }

  async clearAll(): Promise<number> {
    const root = await this.ensureDirectory();
    const entries = await readdir(root, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      await unlink(path.join(root, entry.name)).catch((error: unknown) => {
        if (!isPathLikeError(error) || error.code !== "ENOENT") throw error;
      });
      removed += 1;
    }
    return removed;
  }
}
