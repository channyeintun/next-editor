import { describe, expect, it } from "vitest";
import { createWorkspaceStore, type StoredWorkspaceSnapshot } from "../../stores/workspaceStore";
import {
  collectWorkspaceFolders,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../../types/workspace";
import { writeTool } from "./write";

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

describe("writeTool", () => {
  it("creates a new file and returns success message with byte count", async () => {
    const store = makeStore([makeFile("index.html", "")]);
    const ctx = makeCtx(store);

    const result = await writeTool.execute({ path: "new.txt", content: "hello" }, ctx);

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("Created");
    expect(result.content).toContain("new.txt");
    expect(result.content).toContain("5 bytes");

    const snapshot = store.getSnapshot().context;
    if (!snapshot.isInitialized) throw new Error("Expected initialized");
    expect(snapshot.project.files["new.txt"]).toBeDefined();
    expect(snapshot.project.files["new.txt"].content).toBe("hello");
  });

  it("overwrites an existing file and returns success message with byte count", async () => {
    const store = makeStore([makeFile("test.txt", "old content")]);
    const ctx = makeCtx(store);

    const result = await writeTool.execute({ path: "test.txt", content: "new content" }, ctx);

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("Updated");
    expect(result.content).toContain("test.txt");
    expect(result.content).toContain("11 bytes");

    const snapshot = store.getSnapshot().context;
    if (!snapshot.isInitialized) throw new Error("Expected initialized");
    expect(snapshot.project.files["test.txt"].content).toBe("new content");
  });

  it("counts bytes correctly for unicode content", async () => {
    const store = makeStore([makeFile("index.html", "")]);
    const ctx = makeCtx(store);

    const result = await writeTool.execute({ path: "unicode.txt", content: "hello🌍" }, ctx);

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("9 bytes");
  });

  it("counts bytes correctly for empty content", async () => {
    const store = makeStore([makeFile("index.html", "")]);
    const ctx = makeCtx(store);

    const result = await writeTool.execute({ path: "empty.txt", content: "" }, ctx);

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("0 bytes");
  });

  it("creates nested folders automatically", async () => {
    const store = makeStore([makeFile("index.html", "")]);
    const ctx = makeCtx(store);

    const result = await writeTool.execute(
      { path: "deep/nested/folder/file.txt", content: "test" },
      ctx,
    );

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("Created");

    const snapshot = store.getSnapshot().context;
    if (!snapshot.isInitialized) throw new Error("Expected initialized");
    expect(snapshot.project.files["deep/nested/folder/file.txt"]).toBeDefined();
    expect(snapshot.project.files["deep/nested/folder/file.txt"].content).toBe("test");
  });

  it("supports base64 encoding parameter", async () => {
    const store = makeStore([makeFile("index.html", "")]);
    const ctx = makeCtx(store);

    const result = await writeTool.execute(
      { path: "image.png", content: "aGVsbG8=", encoding: "base64" },
      ctx,
    );

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("Created");

    const snapshot = store.getSnapshot().context;
    if (!snapshot.isInitialized) throw new Error("Expected initialized");
    expect(snapshot.project.files["image.png"].encoding).toBe("base64");
    expect(snapshot.project.files["image.png"].content).toBe("aGVsbG8=");
  });

  it("updates byte count when file is overwritten with different length content", async () => {
    const store = makeStore([makeFile("test.txt", "short")]);
    const ctx = makeCtx(store);

    const result = await writeTool.execute(
      { path: "test.txt", content: "much longer content" },
      ctx,
    );

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("Updated");
    expect(result.content).toContain("19 bytes");
  });

  it("normalizes path separators", async () => {
    const store = makeStore([makeFile("index.html", "")]);
    const ctx = makeCtx(store);

    const result = await writeTool.execute({ path: "folder/file.txt", content: "test" }, ctx);

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("Created");

    const snapshot = store.getSnapshot().context;
    if (!snapshot.isInitialized) throw new Error("Expected initialized");
    expect(snapshot.project.files["folder/file.txt"]).toBeDefined();
  });

  it("returns content as string without error flag on success", async () => {
    const store = makeStore([makeFile("index.html", "")]);
    const ctx = makeCtx(store);

    const result = await writeTool.execute({ path: "new.txt", content: "hello" }, ctx);

    expect(result.is_error).toBeUndefined();
    expect(typeof result.content).toBe("string");
  });
});
