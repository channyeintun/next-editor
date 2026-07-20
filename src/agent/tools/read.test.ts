import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceStore, type StoredWorkspaceSnapshot } from "../../stores/workspaceStore";
import {
  collectWorkspaceFolders,
  type WorkspaceAssetDescriptor,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../../types/workspace";
import {
  registerWorkspaceAsset,
  resetWorkspaceAssetStoreForTests,
} from "../../storage/workspaceAssetStore";
import type { ToolContext } from "../types";
import { makeReadTool } from "./read";

function makeFile(path: string, content: string, encoding?: "base64"): WorkspaceFile {
  const file = {
    path,
    name: path.split("/").pop() ?? path,
    language: "plaintext",
    content,
  };
  return encoding ? { ...file, encoding } : file;
}

function makeAssetFile(path: string, content: WorkspaceAssetDescriptor): WorkspaceFile {
  return {
    path,
    name: path.split("/").pop() ?? path,
    language: "binary",
    content,
    encoding: "asset",
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

function makeCtx(files: WorkspaceFile[]): ToolContext {
  const store = createWorkspaceStore({
    activeFilePath: files[0]?.path ?? "index.html",
    project: makeProject(files),
  } as StoredWorkspaceSnapshot);
  return {
    workspace: store,
    signal: new AbortController().signal,
    requestConfirmation: async () => true,
  };
}

const read = (files: WorkspaceFile[]) => makeReadTool(makeCtx(files)).function.execute;

describe("read tool", () => {
  afterEach(() => resetWorkspaceAssetStoreForTests());

  it("returns text with 1-based line numbers", async () => {
    const result = await read([makeFile("test.txt", "hello world")])({ path: "test.txt" });
    expect(result).toContain("1\thello world");
  });

  it("reports a missing file", async () => {
    const result = await read([makeFile("index.html", "")])({ path: "nope.txt" });
    expect(result).toContain("File not found");
  });

  it("returns embeddable images as an input_image content block", async () => {
    const asset = await registerWorkspaceAsset(new TextEncoder().encode("hello"), {
      mimeType: "image/png",
    });
    const readTool = makeReadTool(makeCtx([makeAssetFile("image.png", asset)]));
    const input = { path: "image.png" };
    const result = await readTool.function.execute(input);
    expect(result).toEqual([
      {
        type: "input_image",
        imageUrl: "data:image/png;base64,aGVsbG8=",
        detail: "auto",
      },
    ]);

    expect(await readTool.function.toModelOutput?.({ input, output: result })).toEqual({
      type: "content",
      value: result,
    });
  });

  it("returns a note for non-image binary files", async () => {
    const asset = await registerWorkspaceAsset(new TextEncoder().encode("hello"), {
      mimeType: "application/pdf",
    });
    const result = await read([makeAssetFile("data.pdf", asset)])({ path: "data.pdf" });
    expect(result).toContain("binary file");
  });
});
