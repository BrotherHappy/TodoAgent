export const ACTIVE_WINDOW_CONTEXT_MAX_CHARS = 320;

export type ActiveWindowContextStatus = "captured" | "unavailable";

export interface ActiveWindowContextView {
  status: ActiveWindowContextStatus;
  appName?: string;
  title?: string;
  reason?: "unsupported" | "permission-denied" | "empty" | "error";
  capturedAt: string;
}

const bounded = (value: string | undefined): string | undefined => {
  const trimmed = value?.replace(/[\u0000\r\n]+/gu, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, ACTIVE_WINDOW_CONTEXT_MAX_CHARS);
};

export const buildActiveWindowContext = (
  appName: string | undefined,
  title: string | undefined,
  capturedAt = new Date(),
): ActiveWindowContextView => {
  const safeAppName = bounded(appName);
  const safeTitle = bounded(title);
  if (!safeAppName && !safeTitle) {
    return {
      status: "unavailable",
      reason: "empty",
      capturedAt: capturedAt.toISOString(),
    };
  }
  return {
    status: "captured",
    appName: safeAppName,
    title: safeTitle,
    capturedAt: capturedAt.toISOString(),
  };
};

export const parseActiveWindowOutput = (
  output: string,
  capturedAt = new Date(),
): ActiveWindowContextView => {
  const [appName, ...titleParts] = output.trim().split("\t");
  return buildActiveWindowContext(appName, titleParts.join("\t"), capturedAt);
};
