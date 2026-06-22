import { describe, expect, it } from "vitest";
import type { WorkspaceProject } from "../types/workspace";
import { createRuntimePreviewScript, createWorkspaceTree } from "./webContainerRuntimeSupport";

function nodeProject(htmlContent: string): WorkspaceProject {
  return {
    id: "project-1",
    name: "Project",
    lessonType: "react",
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
  if (!entry || !("file" in entry) || !("contents" in entry.file)) {
    throw new Error("index.html not found in workspace tree");
  }
  const { contents } = entry.file;
  if (typeof contents !== "string") {
    throw new Error("Expected index.html contents to be a string");
  }
  return contents;
}

describe("createRuntimePreviewScript", () => {
  it("bundles the rrweb recorder and snapshot wiring into one injectable script", () => {
    const script = createRuntimePreviewScript();

    expect(script).toContain("window.rrweb.record");
    // The vendored UMD bundle is inlined (its IIFE header is present).
    expect(script).toContain("function (g, f)");
    // The snapshot/postMessage wiring keyed on the runtime snapshot message type.
    expect(script).toContain("NEXT_EDITOR_RUNTIME_SNAPSHOT");
  });

  it("emits no closing </script> so it survives being wrapped in a <script> tag", () => {
    // setPreviewScript supplies the surrounding <script> tag; a literal </script>
    // inside the bundle/wiring would close it early and break every preview.
    const script = createRuntimePreviewScript();
    const closings = script.match(/<\/script>/gi)?.length ?? 0;

    expect(closings).toBe(0);
  });
});

describe("createWorkspaceTree", () => {
  it("mounts html files verbatim (the recorder is injected at the preview layer)", () => {
    const original = "<html><head></head><body>Hi</body></html>";
    const html = getIndexHtml(createWorkspaceTree(nodeProject(original)));

    expect(html).toBe(original);
    expect(html).not.toContain("data-next-editor-rrweb-record");
    expect(html).not.toContain("data-next-editor-runtime-snapshot");
  });
});
