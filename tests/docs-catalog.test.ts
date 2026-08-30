import { describe, expect, it } from "vitest";

import {
  docsById,
  docsCategoryMeta,
  extractDocHeadings,
  findProjectDocByHref,
  projectDocs,
} from "../src/renderer/docs-catalog";

describe("project documentation catalogue", () => {
  it("bundles every Markdown document with unique stable metadata", () => {
    expect(projectDocs.length).toBeGreaterThanOrEqual(17);
    expect(new Set(projectDocs.map((doc) => doc.id)).size).toBe(projectDocs.length);
    expect(new Set(projectDocs.map((doc) => doc.file)).size).toBe(projectDocs.length);
    expect(projectDocs.every((doc) => doc.content.trim().length > 0)).toBe(true);
    expect(projectDocs.every((doc) => docsCategoryMeta[doc.category])).toBe(true);
    expect(docsById.get("prd")?.file).toBe("PRD.md");
  });

  it("resolves relative Markdown links back into the app catalogue", () => {
    expect(findProjectDocByHref("./PRD.md")?.id).toBe("prd");
    expect(findProjectDocByHref("docs/FEISHU_CONNECTION.md#oauth")?.id).toBe(
      "feishu-connection",
    );
    expect(findProjectDocByHref("https://example.com/docs")).toBeUndefined();
  });

  it("extracts stable heading ids for the in-page table of contents", () => {
    const headings = extractDocHeadings("# 总览\n\n## 同名\n\n## 同名\n\n普通段落");
    expect(headings.map((heading) => heading.text)).toEqual(["总览", "同名", "同名"]);
    expect(new Set(headings.map((heading) => heading.id)).size).toBe(3);
    expect(headings[0].id).toBe("doc-总览-1");
    expect(headings[2].id).toBe("doc-同名-2");
  });
});
