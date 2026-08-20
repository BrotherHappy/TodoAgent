export const DROP_CONTEXT_MAX_CHARS = 12_000;

export type DropContextKind = "text" | "url" | "file" | "image";

export interface DropContextPreview {
  kind: DropContextKind;
  label: string;
  text?: string;
  url?: string;
  files?: Array<{ name: string; mimeType?: string; size?: number }>;
  truncated?: boolean;
}

export interface DropContextInput {
  plainText?: string;
  uriList?: string;
  files?: readonly { name?: string; type?: string; size?: number }[];
}

const safeUrl = (value: string): string | undefined => {
  try {
    const parsed = new URL(value.trim());
    return ["http:", "https:", "mailto:"].includes(parsed.protocol)
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

export const buildDropContextPreview = (
  input: DropContextInput,
): DropContextPreview | undefined => {
  const files = (input.files ?? [])
    .map((file) => ({
      name: file.name?.trim().slice(0, 240) ?? "未命名文件",
      mimeType: file.type?.trim() || undefined,
      size: Number.isFinite(file.size) && (file.size ?? 0) >= 0 ? file.size : undefined,
    }))
    .filter((file) => file.name);
  if (files.length) {
    const image = files.every((file) => file.mimeType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/iu.test(file.name));
    return { kind: image ? "image" : "file", label: image ? "图片" : "文件", files };
  }
  const uri = (input.uriList ?? "")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  const url = safeUrl(uri ?? input.plainText ?? "");
  if (url) return { kind: "url", label: "链接", url };
  const text = (input.plainText ?? "").trim();
  if (!text) return undefined;
  const bounded = text.slice(0, DROP_CONTEXT_MAX_CHARS);
  return {
    kind: "text",
    label: "文本",
    text: bounded,
    truncated: bounded.length < text.length,
  };
};
