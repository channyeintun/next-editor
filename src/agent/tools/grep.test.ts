import { describe, expect, it } from "vitest";
import { createWorkspaceStore, type StoredWorkspaceSnapshot } from "../../stores/workspaceStore";
import {
  collectWorkspaceFolders,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../../types/workspace";
import { grepTool } from "./grep";

function makeFile(path: string, content: string, encoding?: "base64"): WorkspaceFile {
  return {
    path,
    name: path.split("/").pop() ?? path,
    language: "plaintext",
    content,
    ...(encoding ? { encoding } : {}),
  };
}

function makeProject(files: WorkspaceFile[]): WorkspaceProject {
  const fileMap = Object.fromEntries(files.map((file) => [file.path, file]));
  return {
    id: "test",
    name: "Test",
    lessonType: "html-css",
    entryFilePath: "index.html",
    folders: collectWorkspaceFolders(Object.keys(fileMap)),
    files: fileMap,
  };
}

function makeStore(files: WorkspaceFile[]) {
  return createWorkspaceStore({
    activeFilePath: files[0]?.path ?? "index.html",
    project: makeProject(files),
  } as StoredWorkspaceSnapshot);
}

function makeCtx(store: ReturnType<typeof makeStore>) {
  return {
    workspace: store,
    signal: new AbortController().signal,
    requestConfirmation: async () => true,
  };
}

describe("grepTool", () => {
  it("literal mode: finds plain string matches across multiple files", async () => {
    const files = [
      makeFile("src/App.tsx", "export function App() {\n  return <div>Hello</div>;\n}\n"),
      makeFile("src/utils.ts", "export function helper() {\n  return 42;\n}\n"),
      makeFile("README.md", "# Project\nThis project has a Hello section.\n"),
      makeFile("assets/logo.png", "ZmFrZWJhc2U2NA==", "base64"),
    ];
    const store = makeStore(files);
    const ctx = makeCtx(store);

    const result = await grepTool.execute({ pattern: "Hello", literal: true }, ctx);

    expect(result.is_error).toBeFalsy();
    expect(typeof result.content).toBe("string");
    const content = result.content as string;
    expect(content).toContain("src/App.tsx:2:");
    expect(content).toContain("README.md:2:");
    expect(content).toContain("Hello");
  });

  it("regex mode: matches pattern in matching files only", async () => {
    const files = [
      makeFile("src/App.tsx", "export function App() {\n  return <div>Hello</div>;\n}\n"),
      makeFile("src/utils.ts", "export function helper() {\n  return 42;\n}\n"),
      makeFile("README.md", "# Project\nThis project has a Hello section.\n"),
    ];
    const store = makeStore(files);
    const ctx = makeCtx(store);

    const result = await grepTool.execute({ pattern: "function \\w+\\(" }, ctx);

    expect(result.is_error).toBeFalsy();
    const content = result.content as string;
    expect(content).toContain("src/App.tsx:");
    expect(content).toContain("function App()");
    expect(content).toContain("src/utils.ts:");
    expect(content).toContain("function helper()");
    expect(content).not.toContain("README.md");
  });

  it("ignoreCase: matches regardless of case", async () => {
    const files = [
      makeFile("src/App.tsx", "export function App() {\n  return <div>Hello</div>;\n}\n"),
      makeFile("README.md", "# Project\nThis project has a Hello section.\n"),
    ];
    const store = makeStore(files);
    const ctx = makeCtx(store);

    const result = await grepTool.execute(
      { pattern: "hello", ignoreCase: true, literal: true },
      ctx,
    );

    expect(result.is_error).toBeFalsy();
    const content = result.content as string;
    expect(content).toContain("src/App.tsx:");
    expect(content).toContain("Hello");
    expect(content).toContain("README.md:");
  });

  it("skips binary files with base64 encoding", async () => {
    const files = [
      makeFile("src/App.tsx", "export function App() {\n  return <div>match</div>;\n}\n"),
      makeFile("assets/logo.png", "ZmFrZWJhc2U2NA==", "base64"),
    ];
    const store = makeStore(files);
    const ctx = makeCtx(store);

    const result = await grepTool.execute({ pattern: "ZmFr", literal: true }, ctx);

    expect(result.is_error).toBeFalsy();
    const content = result.content as string;
    expect(content).toBe("No matches found.");
    expect(content).not.toContain("assets/logo.png");
  });

  it("path scoping: limits search to specified folder prefix", async () => {
    const files = [
      makeFile("src/App.tsx", "export function App() {}\n"),
      makeFile("src/utils.ts", "export function helper() {}\n"),
      makeFile("other/export-note.txt", "export this\n"),
    ];
    const store = makeStore(files);
    const ctx = makeCtx(store);

    const result = await grepTool.execute({ pattern: "export", path: "src" }, ctx);

    expect(result.is_error).toBeFalsy();
    const content = result.content as string;
    expect(content).toContain("src/App.tsx:");
    expect(content).toContain("src/utils.ts:");
    expect(content).not.toContain("other/export-note.txt");
  });

  it("glob filtering: matches files by glob pattern", async () => {
    const files = [
      makeFile("src/App.tsx", "function App() {}\n"),
      makeFile("src/utils.ts", "function helper() {}\n"),
      makeFile("src/types.ts", "function typeUtils() {}\n"),
    ];
    const store = makeStore(files);
    const ctx = makeCtx(store);

    const result = await grepTool.execute({ pattern: "function", glob: "**/*.ts" }, ctx);

    expect(result.is_error).toBeFalsy();
    const content = result.content as string;
    expect(content).toContain("src/utils.ts:");
    expect(content).toContain("src/types.ts:");
    expect(content).not.toContain("src/App.tsx");
  });

  it("limit parameter: truncates results and shows truncation message", async () => {
    const files = [
      makeFile(
        "src/test.ts",
        "context 1\nmatch line 1\ncontext 2\ncontext 3\nmatch line 2\ncontext 4\n",
      ),
    ];
    const store = makeStore(files);
    const ctx = makeCtx(store);

    const result = await grepTool.execute({ pattern: "match", limit: 4, context: 1 }, ctx);

    expect(result.is_error).toBeFalsy();
    const content = result.content as string;
    expect(content).toContain("(Results truncated; showing first 4 lines)");
  });

  it("invalid regex: returns error with Invalid pattern message", async () => {
    const files = [makeFile("src/test.ts", "const x = 1;\n")];
    const store = makeStore(files);
    const ctx = makeCtx(store);

    const result = await grepTool.execute({ pattern: "(" }, ctx);

    expect(result.is_error).toBe(true);
    const content = result.content as string;
    expect(content).toContain("Invalid pattern");
  });

  it("no matches: returns no matches message", async () => {
    const files = [
      makeFile("src/App.tsx", "export function App() {}\n"),
      makeFile("src/utils.ts", "export function helper() {}\n"),
    ];
    const store = makeStore(files);
    const ctx = makeCtx(store);

    const result = await grepTool.execute(
      { pattern: "nonexistent_pattern_xyz", literal: true },
      ctx,
    );

    expect(result.is_error).toBeFalsy();
    expect(result.content).toBe("No matches found.");
  });

  it("context lines: includes surrounding lines before and after match", async () => {
    const files = [makeFile("src/test.ts", "line 1\nline 2\nmatch line\nline 4\nline 5\n")];
    const store = makeStore(files);
    const ctx = makeCtx(store);

    const result = await grepTool.execute({ pattern: "match", context: 1, literal: true }, ctx);

    expect(result.is_error).toBeFalsy();
    const content = result.content as string;
    expect(content).toContain("src/test.ts:2:");
    expect(content).toContain("line 2");
    expect(content).toContain("src/test.ts:3:");
    expect(content).toContain("match line");
    expect(content).toContain("src/test.ts:4:");
    expect(content).toContain("line 4");
  });
});
