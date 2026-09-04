import { describe, expect, it } from "vitest";
import {
  DROP_CONTEXT_MAX_CHARS,
  buildDropContextPreview,
} from "../src/shared/drop-context";

describe("dragged context preview", () => {
  it("recognizes safe URLs before plain text", () => {
    expect(buildDropContextPreview({ plainText: "https://example.com/docs" })).toEqual({
      kind: "url",
      label: "链接",
      url: "https://example.com/docs",
    });
  });

  it("shows file names without reading file contents", () => {
    const result = buildDropContextPreview({
      files: [{ name: "研究截图.png", type: "image/png", size: 42 }],
    });
    expect(result?.kind).toBe("image");
    expect(result?.files).toEqual([{ name: "研究截图.png", mimeType: "image/png", size: 42 }]);
  });

  it("bounds long text and ignores unsafe URL schemes", () => {
    const result = buildDropContextPreview({
      plainText: `javascript:alert(1)\n${"正文".repeat(DROP_CONTEXT_MAX_CHARS)}`,
    });
    expect(result?.kind).toBe("text");
    expect(result?.text?.length).toBeLessThanOrEqual(DROP_CONTEXT_MAX_CHARS);
  });
});
