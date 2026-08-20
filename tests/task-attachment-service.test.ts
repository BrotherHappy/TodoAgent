import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TASK_ATTACHMENT_LIMITS,
  TaskAttachmentService,
} from "../electron/services/task-attachment-service";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("TaskAttachmentService", () => {
  it("copies selected files into a private app directory and returns safe metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "todo-agent-attachments-"));
    directories.push(root);
    const source = path.join(root, "会议 记录.pdf");
    await writeFile(source, "private attachment", "utf8");
    const service = new TaskAttachmentService(path.join(root, "profile"));

    const [attachment] = await service.copySelectedFiles([source]);

    expect(attachment).toMatchObject({
      name: "会议 记录.pdf",
      mimeType: "application/pdf",
      size: 18,
    });
    expect(attachment.localPath).toContain(path.join("profile", "attachments"));
    expect(await readFile(attachment.localPath!, "utf8")).toBe("private attachment");
    expect(await service.open(attachment)).toBe(attachment.localPath);
  });

  it("rejects oversized files and rolls back already-copied files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "todo-agent-attachments-"));
    directories.push(root);
    const okay = path.join(root, "okay.txt");
    const tooLarge = path.join(root, "too-large.bin");
    await writeFile(okay, "first", "utf8");
    await writeFile(tooLarge, Buffer.alloc(TASK_ATTACHMENT_LIMITS.maxFileBytes + 1));
    const service = new TaskAttachmentService(path.join(root, "profile"));

    await expect(service.copySelectedFiles([okay, tooLarge])).rejects.toThrow(
      "TASK_ATTACHMENT_FILE_TOO_LARGE",
    );
    await expect(service.copySelectedFiles([])).resolves.toEqual([]);
    await expect(readFile(path.join(root, "profile", "attachments"))).rejects.toThrow();
  });

  it("fails closed for renderer-supplied paths outside the attachment directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "todo-agent-attachments-"));
    directories.push(root);
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "do not open", "utf8");
    const service = new TaskAttachmentService(path.join(root, "profile"));

    await expect(
      service.open({ id: "attachment-1", localPath: outside }),
    ).rejects.toThrow("UNSAFE_TASK_ATTACHMENT_PATH");
    await expect(
      service.remove({ id: "attachment-1", localPath: outside }),
    ).rejects.toThrow("UNSAFE_TASK_ATTACHMENT_PATH");
  });

  it("does not follow a symlink that escapes the private directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "todo-agent-attachments-"));
    directories.push(root);
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "do not open", "utf8");
    const service = new TaskAttachmentService(path.join(root, "profile"));
    const [attachment] = await service.copySelectedFiles([outside]);
    const linkPath = path.join(root, "profile", "attachments", `${attachment.id}-link.txt`);
    await symlink(outside, linkPath);

    await expect(
      service.open({ id: attachment.id, localPath: linkPath }),
    ).rejects.toThrow("UNSAFE_TASK_ATTACHMENT_PATH");
  });

  it("returns bounded text and raster image previews without exposing paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "todo-agent-attachments-"));
    directories.push(root);
    const textSource = path.join(root, "notes.md");
    const imageSource = path.join(root, "pixel.png");
    await writeFile(textSource, "# 今日\n\n完成一件小事。", "utf8");
    // A 1x1 transparent PNG; the service only needs to preserve its bytes.
    await writeFile(imageSource, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const service = new TaskAttachmentService(path.join(root, "profile"));
    const [textAttachment, imageAttachment] = await service.copySelectedFiles([textSource, imageSource]);

    const text = await service.preview(textAttachment);
    expect(text).toMatchObject({ kind: "text", name: "notes.md", mimeType: "text/markdown", content: "# 今日\n\n完成一件小事。" });
    expect(JSON.stringify(text)).not.toContain(textAttachment.localPath!);
    const image = await service.preview(imageAttachment);
    expect(image).toMatchObject({ kind: "image", name: "pixel.png", mimeType: "image/png" });
    expect((image as { dataUrl: string }).dataUrl).toMatch(/^data:image\/png;base64,/u);
  });

  it("fails closed for binary and oversized preview requests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "todo-agent-attachments-"));
    directories.push(root);
    const binarySource = path.join(root, "archive.zip");
    const textSource = path.join(root, "large.txt");
    await writeFile(binarySource, Buffer.from([0, 1, 2, 3]));
    await writeFile(textSource, Buffer.alloc(512 * 1024 + 1, "x"));
    const service = new TaskAttachmentService(path.join(root, "profile"));
    const [binary, large] = await service.copySelectedFiles([binarySource, textSource]);

    await expect(service.preview(binary)).resolves.toMatchObject({ kind: "unsupported", reason: "binary", mimeType: "application/zip" });
    await expect(service.preview(large)).resolves.toMatchObject({ kind: "unsupported", reason: "too-large", mimeType: "text/plain" });
  });

  it("cleans files no longer referenced by any task and can clear the directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "todo-agent-attachments-"));
    directories.push(root);
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    await writeFile(first, "one", "utf8");
    await writeFile(second, "two", "utf8");
    const service = new TaskAttachmentService(path.join(root, "profile"));
    const copied = await service.copySelectedFiles([first, second]);

    expect(await service.removeUnreferenced(new Set([copied[0].localPath!]))).toBe(1);
    await expect(readFile(copied[1].localPath!)).rejects.toThrow();
    expect(await service.clearAll()).toBe(1);
    await expect(readFile(copied[0].localPath!)).rejects.toThrow();
  });
});
