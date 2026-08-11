import path from "node:path";

export interface TrustedRendererUrlOptions {
  url: string | undefined;
  rendererPath: string;
  devServerUrl?: string;
  platform?: NodeJS.Platform;
}

function normalizedWindowsPathFromFileUrl(parsed: URL): string | undefined {
  const decodedPath = decodeURIComponent(parsed.pathname);
  const windowsPath =
    parsed.hostname && parsed.hostname !== "localhost"
      ? `\\\\${parsed.hostname}${decodedPath.replaceAll("/", "\\")}`
      : decodedPath
          .replace(/^\/(?=[A-Za-z]:\/)/u, "")
          .replaceAll("/", "\\");

  if (!path.win32.isAbsolute(windowsPath)) return undefined;
  return path.win32.normalize(windowsPath).toLocaleLowerCase("en-US");
}

/**
 * Confirms that an IPC call comes from the renderer document we loaded.
 *
 * WHATWG file URL pathnames use forward slashes and retain a leading slash
 * before a Windows drive letter (`/C:/...`). Comparing that pathname directly
 * with Electron's native `C:\\...` renderer path rejects every packaged
 * Windows renderer. Normalize both sides with the target platform's path
 * rules while keeping the comparison exact.
 */
export function rendererUrlIsTrusted({
  url,
  rendererPath,
  devServerUrl,
  platform = process.platform,
}: TrustedRendererUrlOptions): boolean {
  if (!url) return false;

  if (devServerUrl) {
    try {
      return new URL(url).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return false;

    if (platform === "win32") {
      const actual = normalizedWindowsPathFromFileUrl(parsed);
      if (!actual || !path.win32.isAbsolute(rendererPath)) return false;
      const expected = path.win32
        .normalize(rendererPath)
        .toLocaleLowerCase("en-US");
      return actual === expected;
    }

    if (parsed.hostname && parsed.hostname !== "localhost") return false;
    const actual = path.posix.normalize(decodeURIComponent(parsed.pathname));
    const expected = path.posix.normalize(rendererPath);
    return path.posix.isAbsolute(actual) && actual === expected;
  } catch {
    return false;
  }
}
