import { describe, expect, it, vi } from "vite-plus/test";
import type { WebContainer } from "@webcontainer/api";
import type { WorkspaceProject } from "../../types/workspace";
import { createWorkspaceTree, stripRuntimeSnapshotScript, syncWorkspaceProject } from "./files";

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

function getIndexHtml(tree: Awaited<ReturnType<typeof createWorkspaceTree>>): string {
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

describe("createWorkspaceTree", () => {
  it("mounts html files verbatim (the recorder is injected at the preview layer)", async () => {
    const original = "<html><head></head><body>Hi</body></html>";
    const html = getIndexHtml(await createWorkspaceTree(nodeProject(original)));

    expect(html).toBe(original);
    expect(html).not.toContain("data-next-editor-rrweb-record");
    expect(html).not.toContain("data-next-editor-runtime-snapshot");
  });

  it("nests files under their folders and keeps empty folders", async () => {
    const project = nodeProject("root");
    project.folders = ["src/components", "empty"];
    for (const path of ["src/main.ts", "src/components/Button.tsx"]) {
      project.files[path] = {
        path,
        name: path.split("/").pop()!,
        language: "typescript",
        content: path,
      };
    }

    const tree = await createWorkspaceTree(project);

    expect(JSON.parse(JSON.stringify(tree))).toEqual({
      "index.html": { file: { contents: "root" } },
      empty: { directory: {} },
      src: {
        directory: {
          "main.ts": { file: { contents: "src/main.ts" } },
          components: {
            directory: { "Button.tsx": { file: { contents: "src/components/Button.tsx" } } },
          },
        },
      },
    });
  });

  it("rejects unsafe and structurally conflicting paths", async () => {
    const conflict = nodeProject("root");
    conflict.files.src = {
      path: "src",
      name: "src",
      language: "plaintext",
      content: "file",
    };
    conflict.files["src/App.tsx"] = {
      path: "src/App.tsx",
      name: "App.tsx",
      language: "typescript",
      content: "nested",
    };

    await expect(createWorkspaceTree(conflict)).rejects.toThrow(/conflict/i);

    const reserved = nodeProject("root");
    reserved.files["__proto__/secret.txt"] = {
      path: "__proto__/secret.txt",
      name: "secret.txt",
      language: "plaintext",
      content: "secret",
    };
    await expect(createWorkspaceTree(reserved)).rejects.toThrow(/reserved/i);

    const mismatched = nodeProject("root");
    mismatched.files["alias.txt"] = {
      path: "actual.txt",
      name: "actual.txt",
      language: "plaintext",
      content: "mismatch",
    };
    await expect(createWorkspaceTree(mismatched)).rejects.toThrow(/does not match/i);
  });
});

describe("syncWorkspaceProject", () => {
  it("creates a new file's folders with one recursive mkdir and reports every level", async () => {
    const mkdir = vi.fn<(path: string, options?: { recursive?: boolean }) => Promise<void>>(
      async () => {},
    );
    const writeFile = vi.fn<(path: string, content: string | Uint8Array) => Promise<void>>(
      async () => {},
    );
    const instance = {
      fs: { mkdir, writeFile, rm: vi.fn<(path: string) => Promise<void>>() },
    } as unknown as WebContainer;
    const previous = nodeProject("root");
    const next = nodeProject("root");
    next.files["src/components/Button.tsx"] = {
      path: "src/components/Button.tsx",
      name: "Button.tsx",
      language: "typescript",
      content: "button",
    };
    const written: string[] = [];

    await syncWorkspaceProject(instance, previous, next, (path) => written.push(path));

    expect(mkdir.mock.calls).toEqual([["src/components", { recursive: true }]]);
    expect(writeFile).toHaveBeenCalledWith("src/components/Button.tsx", "button");
    // Each level is reported so its fs.watch event is recognized as our own write.
    expect(written).toEqual(["src", "src/components", "src/components/Button.tsx"]);
  });
});

describe("stripRuntimeSnapshotScript", () => {
  const RECORD = "<script data-next-editor-rrweb-record>";
  const SNAPSHOT = "<script data-next-editor-runtime-snapshot>";
  const PROXY = "<script data-next-editor-api-client-proxy>";
  const CLOSE = "</script>";

  // The implementation this replaced, kept as the oracle: the linear scan must
  // answer exactly what these three regexes did, for every input.
  function legacyStrip(content: string): string {
    return content
      .replace(/\s*<script data-next-editor-rrweb-record>[\s\S]*?<\/script>\s*/g, "\n")
      .replace(/\s*<script data-next-editor-runtime-snapshot>[\s\S]*?<\/script>\s*/g, "\n")
      .replace(/\s*<script data-next-editor-api-client-proxy>[\s\S]*?<\/script>\s*/g, "\n");
  }

  it("removes an injected script and the whitespace around it", () => {
    const html = `<head>\n  ${RECORD}window.rec()${CLOSE}\n  <title>x</title>\n</head>`;
    expect(stripRuntimeSnapshotScript(html)).toBe("<head>\n<title>x</title>\n</head>");
  });

  it("returns a file without the marker untouched", () => {
    const html = "<head>\n  <script>window.app()</script>\n</head>";
    expect(stripRuntimeSnapshotScript(html)).toBe(html);
  });

  it("matches the legacy regexes on adjacent, unclosed and mixed tags", () => {
    const cases = [
      `a ${RECORD}x${CLOSE}  ${RECORD}y${CLOSE} b`,
      `a ${RECORD}x${CLOSE}\n${SNAPSHOT}y${CLOSE}\n${PROXY}z${CLOSE} b`,
      `${RECORD}${RECORD}x${CLOSE}${CLOSE}`,
      `a ${RECORD} never closed`,
      `a ${SNAPSHOT}x${CLOSE} ${RECORD} unclosed ${PROXY}y${CLOSE}`,
      `\u00a0\t${PROXY}${CLOSE}\u00a0`,
      `<script data-next-editor-other>${CLOSE}`,
    ];
    expect(
      cases.filter((input) => stripRuntimeSnapshotScript(input) !== legacyStrip(input)),
    ).toEqual([]);
  });

  it("matches the legacy regexes on generated inputs", () => {
    const tokens = [RECORD, SNAPSHOT, PROXY, CLOSE, " ", "\n", "\t", "\u00a0", "a", "<", "x"];
    // mulberry32: a fixed seed keeps every run on the same 2,000 inputs.
    let seed = 0x5eed;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const mismatches: string[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      const length = Math.floor(next() * 13);
      let input = "";
      for (let j = 0; j < length; j += 1) input += tokens[Math.floor(next() * tokens.length)];
      if (stripRuntimeSnapshotScript(input) !== legacyStrip(input)) mismatches.push(input);
    }
    expect(mismatches).toEqual([]);
  });

  // Read-back runs this on every text file of every reverse sync, including
  // files from a shared recording, and the regexes were quadratic on both of
  // these. The bound is loose for a busy machine; the regexes took seconds.
  it("stays linear on long whitespace runs and many unclosed openers", () => {
    const inputs = [
      `${" ".repeat(200_000)}x`,
      `${RECORD}${CLOSE}x${" ".repeat(200_000)}x`,
      `${" ".repeat(200_000)}${RECORD}x`,
      RECORD.repeat(20_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      stripRuntimeSnapshotScript(input);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});
