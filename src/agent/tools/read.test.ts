import { describe, expect, it } from "vitest";
import { createWorkspaceStore, type StoredWorkspaceSnapshot } from "../../stores/workspaceStore";
import {
  collectWorkspaceFolders,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../../types/workspace";
import { readTool } from "./read";

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

describe("readTool", () => {
  it("reads an existing text file and returns its content with line numbers", async () => {
    const store = makeStore([makeFile("test.txt", "hello world")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "test.txt" }, ctx);

    expect(result.is_error).toBeUndefined();
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("hello world");
    expect(result.content).toContain("1\t");
  });

  it("returns error when file does not exist", async () => {
    const store = makeStore([makeFile("index.html", "")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "nonexistent.txt" }, ctx);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("File not found");
    expect(result.content).toContain("nonexistent.txt");
  });

  it("reads a binary file with base64 encoding that is not an image and returns a text note", async () => {
    const store = makeStore([makeFile("data.pdf", "aGVsbG8=", "base64")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "data.pdf" }, ctx);

    expect(result.is_error).toBeUndefined();
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("binary file");
    expect(result.content).toContain("data.pdf");
  });

  it("reads a PNG image file and returns inline image block", async () => {
    const store = makeStore([makeFile("image.png", "aGVsbG8=", "base64")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "image.png" }, ctx);

    expect(result.is_error).toBeUndefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBe(1);
    const imageBlock = result.content[0] as any;
    expect(imageBlock.type).toBe("image");
    expect(imageBlock.source.media_type).toBe("image/png");
    expect(imageBlock.source.data).toBe("aGVsbG8=");
  });

  it("reads a JPEG image file and returns inline image block", async () => {
    const store = makeStore([makeFile("photo.jpg", "Zm9v", "base64")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "photo.jpg" }, ctx);

    expect(Array.isArray(result.content)).toBe(true);
    const imageBlock = result.content[0] as any;
    expect(imageBlock.type).toBe("image");
    expect(imageBlock.source.media_type).toBe("image/jpeg");
  });

  it("reads a GIF image file and returns inline image block", async () => {
    const store = makeStore([makeFile("animation.gif", "YmFy", "base64")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "animation.gif" }, ctx);

    expect(Array.isArray(result.content)).toBe(true);
    const imageBlock = result.content[0] as any;
    expect(imageBlock.source.media_type).toBe("image/gif");
  });

  it("reads a WebP image file and returns inline image block", async () => {
    const store = makeStore([makeFile("modern.webp", "YmF6", "base64")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "modern.webp" }, ctx);

    expect(Array.isArray(result.content)).toBe(true);
    const imageBlock = result.content[0] as any;
    expect(imageBlock.source.media_type).toBe("image/webp");
  });

  it("supports offset parameter to skip lines", async () => {
    const store = makeStore([makeFile("multiline.txt", "line1\nline2\nline3\nline4\nline5")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "multiline.txt", offset: 1 }, ctx);

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("line2");
    expect(result.content).toContain("line3");
    expect(result.content).not.toContain("line1");
  });

  it("supports limit parameter to restrict line count", async () => {
    const store = makeStore([makeFile("multiline.txt", "line1\nline2\nline3\nline4\nline5")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "multiline.txt", offset: 1, limit: 2 }, ctx);

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("line2");
    expect(result.content).toContain("line3");
    expect(result.content).not.toContain("line1");
    expect(result.content).not.toContain("line4");
    expect(result.content).not.toContain("line5");
  });

  it("includes truncation note when limit is applied", async () => {
    const store = makeStore([makeFile("multiline.txt", "line1\nline2\nline3\nline4\nline5")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "multiline.txt", offset: 0, limit: 2 }, ctx);

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("truncated");
    expect(result.content).toContain("3 more lines");
  });

  it("reads a binary file extension that is not embeddable", async () => {
    const store = makeStore([makeFile("archive.zip", "test", "base64")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "archive.zip" }, ctx);

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("binary file");
  });

  it("preserves line numbers in multi-line output", async () => {
    const store = makeStore([makeFile("test.txt", "first\nsecond\nthird")]);
    const ctx = makeCtx(store);

    const result = await readTool.execute({ path: "test.txt" }, ctx);

    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("1\tfirst");
    expect(result.content).toContain("2\tsecond");
    expect(result.content).toContain("3\tthird");
  });
});
