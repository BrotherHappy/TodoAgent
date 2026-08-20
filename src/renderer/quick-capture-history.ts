export type QuickCaptureHistoryDestination = "task" | "inbox" | "diary";

export interface QuickCaptureHistoryItem {
  id: string;
  text: string;
  title: string;
  destination: QuickCaptureHistoryDestination;
  createdAt: string;
}

export const QUICK_CAPTURE_HISTORY_STORAGE_KEY =
  "todo-agent:quick-capture-history:v1";
export const QUICK_CAPTURE_HISTORY_LIMIT = 12;
export const QUICK_CAPTURE_HISTORY_TEXT_LIMIT = 2_000;
export const QUICK_CAPTURE_HISTORY_TITLE_LIMIT = 160;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const destinations = new Set<QuickCaptureHistoryDestination>([
  "task",
  "inbox",
  "diary",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeItem(value: unknown): QuickCaptureHistoryItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim().slice(0, 120) : "";
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const destination = value.destination;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  if (
    !id ||
    !text ||
    !title ||
    !destinations.has(destination as QuickCaptureHistoryDestination) ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    return undefined;
  }
  return {
    id,
    text: text.slice(0, QUICK_CAPTURE_HISTORY_TEXT_LIMIT),
    title: title.slice(0, QUICK_CAPTURE_HISTORY_TITLE_LIMIT),
    destination: destination as QuickCaptureHistoryDestination,
    createdAt,
  };
}

function boundedHistory(items: readonly unknown[]): QuickCaptureHistoryItem[] {
  const seen = new Set<string>();
  return items
    .map(normalizeItem)
    .filter((item): item is QuickCaptureHistoryItem => Boolean(item))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, QUICK_CAPTURE_HISTORY_LIMIT);
}

export function parseQuickCaptureHistory(raw: string | null): QuickCaptureHistoryItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? boundedHistory(parsed) : [];
  } catch {
    return [];
  }
}

export function serializeQuickCaptureHistory(
  items: readonly QuickCaptureHistoryItem[],
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

export function readQuickCaptureHistory(
  storage: StorageLike | undefined = browserStorage(),
): QuickCaptureHistoryItem[] {
  if (!storage) return [];
  try {
    return parseQuickCaptureHistory(storage.getItem(QUICK_CAPTURE_HISTORY_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function rememberQuickCapture(
  item: QuickCaptureHistoryItem,
  storage: StorageLike | undefined = browserStorage(),
): QuickCaptureHistoryItem[] {
  const next = boundedHistory([item, ...readQuickCaptureHistory(storage)]);
  if (storage) {
    try {
      storage.setItem(
        QUICK_CAPTURE_HISTORY_STORAGE_KEY,
        serializeQuickCaptureHistory(next),
      );
    } catch {
      // A storage quota or privacy policy must not block task creation.
    }
  }
  return next;
}

export function clearQuickCaptureHistory(
  storage: StorageLike | undefined = browserStorage(),
): void {
  try {
    storage?.removeItem(QUICK_CAPTURE_HISTORY_STORAGE_KEY);
  } catch {
    // Clearing is best effort and never affects the task store.
  }
}
