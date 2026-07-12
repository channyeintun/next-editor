import { describe, expect, it } from "vitest";
import { lsTool } from "./ls";
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

describe("lsTool", () => {
  describe("root listing", () => {
    it("lists root files and folders with trailing slash for folders", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("package.json", "{}"),
        makeFile("src/App.tsx", "export default function App() {}"),
        makeFile("src/utils/math.ts", "export const add = (a: number, b: number) => a + b;"),
        makeFile("src/utils/string.ts", "export const upper = (s: string) => s.toUpperCase();"),
        makeFile("public/logo.png", "ZmFrZQ==", "base64"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await lsTool.execute({}, ctx);

      expect(result.content).toContain("index.html");
      expect(result.content).toContain("package.json");
      expect(result.content).toContain("public/");
      expect(result.content).toContain("src/");
      expect(result.content).not.toContain("App.tsx");
      expect(result.content).not.toContain("math.ts");
    });

    it("lists root with undefined path", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("src/App.tsx", "export default function App() {}"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await lsTool.execute({ path: undefined }, ctx);

      expect(result.content).toContain("index.html");
      expect(result.content).toContain("src/");
      expect(result.content).not.toContain("App.tsx");
    });

    it("sorts entries alphabetically", async () => {
      const files = [
        makeFile("zebra.txt", "z"),
        makeFile("apple.txt", "a"),
        makeFile("src/file.ts", "x"),
        makeFile("public/asset.png", "p", "base64"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await lsTool.execute({}, ctx);

      const lines = (result.content as string).split("\n");
      expect(lines[0]).toBe("apple.txt");
      expect(lines[1]).toBe("public/");
      expect(lines[2]).toBe("src/");
      expect(lines[3]).toBe("zebra.txt");
    });
  });

  describe("nested folder listing", () => {
    it("lists immediate children of a nested folder", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("src/App.tsx", "export default function App() {}"),
        makeFile("src/utils/math.ts", "export const add = (a: number, b: number) => a + b;"),
        makeFile("src/utils/string.ts", "export const upper = (s: string) => s.toUpperCase();"),
        makeFile("public/logo.png", "ZmFrZQ==", "base64"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await lsTool.execute({ path: "src" }, ctx);

      expect(result.content).toContain("App.tsx");
      expect(result.content).toContain("utils/");
      expect(result.content).not.toContain("index.html");
      expect(result.content).not.toContain("public/");
      expect(result.content).not.toContain("math.ts");
    });

    it("lists deeply nested folder contents", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("src/utils/math.ts", "export const add = (a: number, b: number) => a + b;"),
        makeFile("src/utils/string.ts", "export const upper = (s: string) => s.toUpperCase();"),
        makeFile("src/utils/nested/deep.ts", "export const x = 1;"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await lsTool.execute({ path: "src/utils" }, ctx);

      expect(result.content).toContain("math.ts");
      expect(result.content).toContain("string.ts");
      expect(result.content).toContain("nested/");
      expect(result.content).not.toContain("deep.ts");
      expect(result.content).not.toContain("index.html");
    });

    it("handles path with leading or trailing slashes", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("src/App.tsx", "export default function App() {}"),
        makeFile("src/utils/math.ts", "export const add = (a: number, b: number) => a + b;"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result1 = await lsTool.execute({ path: "/src/" }, ctx);
      const result2 = await lsTool.execute({ path: "src" }, ctx);

      expect(result1.content).toContain("App.tsx");
      expect(result2.content).toContain("App.tsx");
    });
  });

  describe("empty directory", () => {
    it("returns (empty) for a path with no files or folders", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("src/App.tsx", "export default function App() {}"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await lsTool.execute({ path: "nonexistent" }, ctx);

      expect(result.content).toBe("(empty)");
    });
  });

  describe("limit parameter", () => {
    it("truncates output and shows remaining count when limit is exceeded", async () => {
      const files = [
        makeFile("a.txt", "a"),
        makeFile("b.txt", "b"),
        makeFile("c.txt", "c"),
        makeFile("d.txt", "d"),
        makeFile("e.txt", "e"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await lsTool.execute({ limit: 2 }, ctx);

      expect(result.content).toContain("… ");
      expect(result.content).toContain("more");
      expect(result.content).toContain("3 more entries");
    });

    it("shows 'entry' singular when only one entry is truncated", async () => {
      const files = [makeFile("a.txt", "a"), makeFile("b.txt", "b")];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await lsTool.execute({ limit: 1 }, ctx);

      expect(result.content).toContain("1 more entry");
    });

    it("does not show truncation when entries fit within limit", async () => {
      const files = [makeFile("a.txt", "a"), makeFile("b.txt", "b")];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await lsTool.execute({ limit: 10 }, ctx);

      expect(result.content).not.toContain("…");
      expect(result.content).not.toContain("more");
    });

    it("uses default limit of 200 when not specified", async () => {
      const files = Array.from({ length: 50 }, (_, i) => makeFile(`file${i}.txt`, `content${i}`));
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await lsTool.execute({}, ctx);

      expect(result.content).not.toContain("…");
      expect(result.content).not.toContain("more");
    });
  });

  describe("mixed content", () => {
    it("handles project with files, folders, and binary assets", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("package.json", "{}"),
        makeFile("src/App.tsx", "export default function App() {}"),
        makeFile("src/utils/math.ts", "export const add = (a: number, b: number) => a + b;"),
        makeFile("src/utils/string.ts", "export const upper = (s: string) => s.toUpperCase();"),
        makeFile("public/logo.png", "ZmFrZQ==", "base64"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await lsTool.execute({}, ctx);

      const lines = (result.content as string).split("\n");
      expect(lines).toContain("index.html");
      expect(lines).toContain("package.json");
      expect(lines).toContain("public/");
      expect(lines).toContain("src/");
    });
  });
});
