import { describe, expect, it } from "vitest";
import { editTool, type EditToolInput } from "./edit";
import { applyEdits, EditApplyError, type EditOperation } from "./editDiff";
import { createWorkspaceStore, type StoredWorkspaceSnapshot } from "../../stores/workspaceStore";
import {
  collectWorkspaceFolders,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../../types/workspace";

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

describe("editTool", () => {
  it("applies a single unique-match edit and updates the store", async () => {
    const file = makeFile("test.js", "const x = 1;\nconst y = 2;\n");
    const store = makeStore([file]);
    const ctx = makeCtx(store);

    const result = await editTool.execute(
      {
        path: "test.js",
        edits: [{ oldText: "const x = 1;", newText: "const x = 100;" }],
      } as EditToolInput,
      ctx,
    );

    expect(result.is_error).toBeFalsy();
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("test.js");

    const snapshot = store.getSnapshot().context;
    if (!snapshot.isInitialized) throw new Error("Expected initialized");
    const updatedFile = snapshot.project.files["test.js"];
    expect(updatedFile.content).toContain("const x = 100;");
    expect(updatedFile.content).not.toContain("const x = 1;\n");
  });

  it("applies multiple edits in order", async () => {
    const file = makeFile("test.js", "line1\nline2\nline3\n");
    const store = makeStore([file]);
    const ctx = makeCtx(store);

    const result = await editTool.execute(
      {
        path: "test.js",
        edits: [
          { oldText: "line1", newText: "FIRST" },
          { oldText: "line3", newText: "THIRD" },
        ],
      } as EditToolInput,
      ctx,
    );

    expect(result.is_error).toBeFalsy();
    const snapshot = store.getSnapshot().context;
    if (!snapshot.isInitialized) throw new Error("Expected initialized");
    const content = snapshot.project.files["test.js"].content;
    expect(content).toContain("FIRST");
    expect(content).toContain("THIRD");
    expect(content).not.toContain("line1");
    expect(content).not.toContain("line3");
  });

  it("returns error when oldText does not exist and leaves file unchanged", async () => {
    const file = makeFile("test.js", "const x = 1;\n");
    const store = makeStore([file]);
    const ctx = makeCtx(store);

    const result = await editTool.execute(
      {
        path: "test.js",
        edits: [{ oldText: "nonexistent", newText: "replacement" }],
      } as EditToolInput,
      ctx,
    );

    expect(result.is_error).toBe(true);
    const snapshot = store.getSnapshot().context;
    if (!snapshot.isInitialized) throw new Error("Expected initialized");
    expect(snapshot.project.files["test.js"].content).toBe("const x = 1;\n");
  });

  it("returns error when oldText matches multiple times and leaves file unchanged", async () => {
    const file = makeFile("test.js", "foo\nfoo\n");
    const store = makeStore([file]);
    const ctx = makeCtx(store);

    const result = await editTool.execute(
      {
        path: "test.js",
        edits: [{ oldText: "foo", newText: "bar" }],
      } as EditToolInput,
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("must be unique");
    const snapshot = store.getSnapshot().context;
    if (!snapshot.isInitialized) throw new Error("Expected initialized");
    expect(snapshot.project.files["test.js"].content).toBe("foo\nfoo\n");
  });

  it("returns error when file path does not exist", async () => {
    const file = makeFile("existing.js", "content");
    const store = makeStore([file]);
    const ctx = makeCtx(store);

    const result = await editTool.execute(
      {
        path: "nonexistent.js",
        edits: [{ oldText: "old", newText: "new" }],
      } as EditToolInput,
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("File not found");
  });

  it("returns error when attempting to edit a binary file", async () => {
    const file = makeFile("image.png", "iVBORw0KGgo=", "base64");
    const store = makeStore([file]);
    const ctx = makeCtx(store);

    const result = await editTool.execute(
      {
        path: "image.png",
        edits: [{ oldText: "old", newText: "new" }],
      } as EditToolInput,
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("binary file");
  });

  it("returns error when edits array is empty", async () => {
    const file = makeFile("test.js", "const x = 1;\n");
    const store = makeStore([file]);
    const ctx = makeCtx(store);

    const result = await editTool.execute(
      {
        path: "test.js",
        edits: [],
      } as EditToolInput,
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("No edits provided");
  });
});

describe("applyEdits", () => {
  it("applies a unique edit and returns content and diff", () => {
    const content = "line1\nline2\nline3\n";
    const edits: EditOperation[] = [{ oldText: "line2", newText: "CHANGED" }];

    const result = applyEdits(content, edits);

    expect(result.content).toContain("CHANGED");
    expect(result.content).not.toContain("line2");
    expect(result.diff).toBeTruthy();
    expect(result.diff).toContain("-");
    expect(result.diff).toContain("+");
  });

  it("applies multiple edits in order where later edits depend on earlier ones", () => {
    const content = "a\na\n";
    const edits: EditOperation[] = [
      { oldText: "a\na\n", newText: "a\nb\n" },
      { oldText: "a\n", newText: "x\n" },
    ];

    const result = applyEdits(content, edits);

    expect(result.content).toBe("x\nb\n");
  });

  it("throws EditApplyError when oldText is not found", () => {
    const content = "line1\nline2\n";
    const edits: EditOperation[] = [{ oldText: "nonexistent", newText: "replacement" }];

    expect(() => applyEdits(content, edits)).toThrow(EditApplyError);
  });

  it("throws EditApplyError when oldText matches multiple times", () => {
    const content = "foo\nfoo\nfoo\n";
    const edits: EditOperation[] = [{ oldText: "foo", newText: "bar" }];

    expect(() => applyEdits(content, edits)).toThrow(EditApplyError);
  });

  it("normalizes CRLF line endings", () => {
    const content = "line1\r\nline2\r\n";
    const edits: EditOperation[] = [{ oldText: "line1", newText: "FIRST" }];

    const result = applyEdits(content, edits);

    expect(result.content).toContain("FIRST");
    expect(result.content).not.toContain("line1");
  });
});
