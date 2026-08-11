// @vitest-environment node
import { describe, expect, it } from "vitest";
import { rendererUrlIsTrusted } from "../electron/trusted-renderer";

describe("rendererUrlIsTrusted", () => {
  it("accepts the exact packaged macOS renderer", () => {
    expect(
      rendererUrlIsTrusted({
        url: "file:///Applications/Todo%20Agent.app/Contents/Resources/app.asar/dist/index.html?window=main",
        rendererPath:
          "/Applications/Todo Agent.app/Contents/Resources/app.asar/dist/index.html",
        platform: "darwin",
      }),
    ).toBe(true);
  });

  it("accepts the exact packaged Windows renderer across URL and native path formats", () => {
    expect(
      rendererUrlIsTrusted({
        url: "file:///C:/Users/hx/Downloads/TodoAgent-QA/portable/resources/app.asar/dist/index.html?window=main",
        rendererPath:
          "C:\\Users\\hx\\Downloads\\TodoAgent-QA\\portable\\resources\\app.asar\\dist\\index.html",
        platform: "win32",
      }),
    ).toBe(true);
  });

  it("uses Windows case-insensitive path comparison", () => {
    expect(
      rendererUrlIsTrusted({
        url: "file:///c:/PROGRAM%20FILES/Todo%20Agent/resources/app.asar/dist/index.html",
        rendererPath:
          "C:\\Program Files\\Todo Agent\\resources\\app.asar\\dist\\index.html",
        platform: "win32",
      }),
    ).toBe(true);
  });

  it("rejects a different local document instead of trusting a path prefix", () => {
    expect(
      rendererUrlIsTrusted({
        url: "file:///C:/Program%20Files/Todo%20Agent/resources/app.asar/dist/index.html.evil",
        rendererPath:
          "C:\\Program Files\\Todo Agent\\resources\\app.asar\\dist\\index.html",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("accepts only the configured development origin", () => {
    expect(
      rendererUrlIsTrusted({
        url: "http://127.0.0.1:5173/?window=main",
        rendererPath: "/unused/index.html",
        devServerUrl: "http://127.0.0.1:5173",
      }),
    ).toBe(true);
    expect(
      rendererUrlIsTrusted({
        url: "http://localhost:5173/?window=main",
        rendererPath: "/unused/index.html",
        devServerUrl: "http://127.0.0.1:5173",
      }),
    ).toBe(false);
  });
});
