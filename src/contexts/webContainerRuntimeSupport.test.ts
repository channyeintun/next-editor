import { describe, expect, it } from "vitest";
import type { WorkspaceProject } from "../types/workspace";
import { createWorkspaceTree } from "./webContainerRuntimeSupport";

function nodeProject(htmlContent: string): WorkspaceProject {
  return {
    id: "project-1",
    name: "Project",
    lessonType: "node.js",
    entryFilePath: "index.html",
    folders: [],
    files: {
      "index.html": {
        path: "index.html",
        name: "index.html",
        language: "html",
        content: htmlContent,
      },
    },
  };
}

function getIndexHtml(tree: ReturnType<typeof createWorkspaceTree>): string {
  const entry = tree["index.html"];
  if (!entry || !("file" in entry)) {
    throw new Error("index.html not found in workspace tree");
  }
  return entry.file.contents as string;
}

describe("createWorkspaceTree rrweb injection", () => {
  it("injects the rrweb recorder + snapshot scripts into the runtime bootstrap html", () => {
    const tree = createWorkspaceTree(nodeProject("<html><head></head><body>Hi</body></html>"));
    const html = getIndexHtml(tree);

    expect(html).toContain("data-next-editor-rrweb-record");
    expect(html).toContain("window.rrweb.record");
    expect(html).toContain("data-next-editor-runtime-snapshot");
    // The vendored UMD bundle is inlined (its IIFE header is present).
    expect(html).toContain("function (g, f)");
  });

  it("emits exactly two closing tags (no premature </script> from the bundle or regex)", () => {
    const tree = createWorkspaceTree(nodeProject("<html><head></head><body>Hi</body></html>"));
    const html = getIndexHtml(tree);

    // Only the two injected <script> elements (rrweb-record + runtime-snapshot)
    // may close. A literal </script> inside the inlined bundle/wiring would close a
    // tag early and break the page; this guards against that.
    const closings = html.match(/<\/script>/gi)?.length ?? 0;
    expect(closings).toBe(2);
  });

  it("does not inject into non-runtime projects", () => {
    const project = nodeProject("<html><head></head><body>Hi</body></html>");
    project.lessonType = "html-css";

    const html = getIndexHtml(createWorkspaceTree(project));

    expect(html).not.toContain("data-next-editor-rrweb-record");
    expect(html).not.toContain("data-next-editor-runtime-snapshot");
  });
});
