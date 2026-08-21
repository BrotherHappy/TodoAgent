export type ContextCaptureHistoryKind =
  | "clipboard"
  | "window"
  | "selected-text"
  | "drop-text"
  | "url";

export interface ContextCaptureHistoryItem {
  id: string;
  kind: ContextCaptureHistoryKind;
  label: string;
  text: string;
  createdAt: string;
}

export const CONTEXT_CAPTURE_HISTORY_STORAGE_KEY =
  "todo-agent:context-capture-history:v1";
export const CONTEXT_CAPTURE_HISTORY_LIMIT = 12;
export const CONTEXT_CAPTURE_HISTORY_TEXT_LIMIT = 2_000;
export const CONTEXT_CAPTURE_HISTORY_LABEL_LIMIT = 120;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const kinds = new Set<ContextCaptureHistoryKind>([
  "clipboard",
  "window",
  "selected-text",
  "drop-text",
  "url",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeItem(value: unknown): ContextCaptureHistoryItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim().slice(0, 120) : "";
  const kind = value.kind;
  const label = typeof value.label === "string" ? value.label.trim() : "";
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  if (
    !id ||
    !kinds.has(kind as ContextCaptureHistoryKind) ||
    !label ||
    !text ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    return undefined;
  }
  return {
    id,
    kind: kind as ContextCaptureHistoryKind,
    label: label.slice(0, CONTEXT_CAPTURE_HISTORY_LABEL_LIMIT),
    text: text.slice(0, CONTEXT_CAPTURE_HISTORY_TEXT_LIMIT),
    createdAt,
  };
}

function boundedHistory(items: readonly unknown[]): ContextCaptureHistoryItem[] {
  const seen = new Set<string>();
  return items
    .map(normalizeItem)
    .filter((item): item is ContextCaptureHistoryItem => Boolean(item))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, CONTEXT_CAPTURE_HISTORY_LIMIT);
}

export function parseContextCaptureHistory(
  raw: string | null,
): ContextCaptureHistoryItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? boundedHistory(parsed) : [];
  } catch {
    return [];
  }
}

export function serializeContextCaptureHistory(
  items: readonly ContextCaptureHistoryItem[],
): string {
  return JSON.stringify(boundedHistory(items));
}

function browserStorage(): StorageLike | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readContextCaptureHistory(
  storage: StorageLike | undefined = browserStorage(),
): ContextCaptureHistoryItem[] {
  if (!storage) return [];
  try {
    return parseContextCaptureHistory(
      storage.getItem(CONTEXT_CAPTURE_HISTORY_STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

export function rememberContextCapture(
  item: ContextCaptureHistoryItem,
  storage: StorageLike | undefined = browserStorage(),
): ContextCaptureHistoryItem[] {
  const next = boundedHistory([item, ...readContextCaptureHistory(storage)]);
  if (storage) {
    try {
      storage.setItem(
        CONTEXT_CAPTURE_HISTORY_STORAGE_KEY,
        serializeContextCaptureHistory(next),
      );
    } catch {
      // A storage quota or privacy policy must not block the current capture.
    }
  }
  return next;
}

export function clearContextCaptureHistory(
  storage: StorageLike | undefined = browserStorage(),
): void {
  try {
    storage?.removeItem(CONTEXT_CAPTURE_HISTORY_STORAGE_KEY);
  } catch {
    // Clearing is best effort and never affects task creation.
  }
}
