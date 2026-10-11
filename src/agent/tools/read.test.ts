import { afterEach, describe, expect, it } from "vite-plus/test";
import { createWorkspaceStore, type StoredWorkspaceSnapshot } from "../../stores/workspaceStore";
import type {
  WorkspaceAssetDescriptor,
  WorkspaceFile,
  WorkspaceProject,
} from "../../types/workspace";
import { collectWorkspaceFolders } from "../../types/workspacePaths";
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

  // A minified bundle, a source map or an inline data URI sits on one line.
  // read returned it whole, so one call could overflow the model's context.
  it("clips a very long line and says how much was left out", async () => {
    const result = await read([makeFile("bundle.js", "x".repeat(100_000))])({ path: "bundle.js" });
    expect(result).toBe(`1\t${"x".repeat(2_000)}… [98000 chars omitted]`);
  });

  it("does not split an emoji where it clips a line", async () => {
    const line = `${"x".repeat(1_999)}😀${"x".repeat(10)}`;
    const result = await read([makeFile("a.txt", line)])({ path: "a.txt" });
    expect(result).toBe(`1\t${"x".repeat(1_999)}… [12 chars omitted]`);
  });

  it("still notes the lines left after the default line limit", async () => {
    const content = Array.from({ length: 2_500 }, (_, i) => `line ${i}`).join("\n");
    const result = String(await read([makeFile("long.txt", content)])({ path: "long.txt" }));
    expect(result).toContain("\n2000\tline 1999\n… truncated (500 more lines)");
    expect(result.endsWith("… truncated (500 more lines)")).toBe(true);
  });

  it("stops at the character budget and says where to continue", async () => {
    const content = Array.from({ length: 100 }, () => "y".repeat(5_000)).join("\n");
    const result = String(await read([makeFile("wide.txt", content)])({ path: "wide.txt" }));
    const match =
      /\n… truncated at 100000 characters \((\d+) more lines\); continue with offset=(\d+)$/.exec(
        result,
      );
    expect(match).not.toBeNull();
    const [, moreLines, offset] = match ?? [];
    const body = result.slice(0, match?.index);
    expect(body.length).toBeLessThanOrEqual(100_000);
    // The last line shown (1-based) is the 0-based offset of the next one.
    expect(body.split("\n").at(-1)?.split("\t")[0]).toBe(offset);
    expect(Number(moreLines)).toBe(100 - Number(offset));
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
