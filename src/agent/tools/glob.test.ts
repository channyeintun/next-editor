import { describe, expect, it } from "vitest";
import { globTool } from "./glob";
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

describe("globTool", () => {
  describe("pattern matching", () => {
    it("matches **/*.ts pattern correctly", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("src/App.tsx", "export default function App() {}"),
        makeFile("src/utils/math.ts", "export const add = (a: number, b: number) => a + b;"),
        makeFile("src/utils/string.ts", "export const upper = (s: string) => s.toUpperCase();"),
        makeFile("public/logo.png", "ZmFrZQ==", "base64"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "**/*.ts" }, ctx);

      expect(result.content).toContain("src/utils/math.ts");
      expect(result.content).toContain("src/utils/string.ts");
      expect(result.content).not.toContain("App.tsx");
      expect(result.content).not.toContain("index.html");
      expect(result.content).not.toContain("public/logo.png");
    });

    it("matches **/*.tsx pattern correctly", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("src/App.tsx", "export default function App() {}"),
        makeFile("src/utils/math.ts", "export const add = (a: number, b: number) => a + b;"),
        makeFile("src/pages/Home.tsx", "export default function Home() {}"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "**/*.tsx" }, ctx);

      expect(result.content).toContain("src/App.tsx");
      expect(result.content).toContain("src/pages/Home.tsx");
      expect(result.content).not.toContain("math.ts");
      expect(result.content).not.toContain("index.html");
    });

    it("matches *.json at root", async () => {
      const files = [
        makeFile("package.json", "{}"),
        makeFile("tsconfig.json", "{}"),
        makeFile("src/config.json", "{}"),
        makeFile("index.html", "<html></html>"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "*.json" }, ctx);

      expect(result.content).toContain("package.json");
      expect(result.content).toContain("tsconfig.json");
      expect(result.content).not.toContain("src/config.json");
      expect(result.content).not.toContain("index.html");
    });

    it("matches files at specific folder with *.ts", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("src/App.tsx", "export default function App() {}"),
        makeFile("src/utils/math.ts", "export const add = (a: number, b: number) => a + b;"),
        makeFile("src/utils/string.ts", "export const upper = (s: string) => s.toUpperCase();"),
        makeFile("src/hooks/useData.ts", "export const useData = () => {};"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "*.ts", path: "src/utils" }, ctx);

      expect(result.content).toContain("src/utils/math.ts");
      expect(result.content).toContain("src/utils/string.ts");
      expect(result.content).not.toContain("src/hooks/useData.ts");
      expect(result.content).not.toContain("src/App.tsx");
    });

    it("scopes glob pattern to a folder with path parameter", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("src/App.tsx", "export default function App() {}"),
        makeFile("src/utils/math.ts", "export const add = (a: number, b: number) => a + b;"),
        makeFile("src/utils/string.ts", "export const upper = (s: string) => s.toUpperCase();"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "**/*.ts", path: "src/utils" }, ctx);

      expect(result.content).toContain("src/utils/math.ts");
      expect(result.content).toContain("src/utils/string.ts");
      expect(result.content).not.toContain("src/App.tsx");
    });
  });

  describe("wildcard matching", () => {
    it("matches ? wildcard for single character", async () => {
      const files = [makeFile("a.ts", "a"), makeFile("ab.ts", "ab"), makeFile("abc.ts", "abc")];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "?.ts" }, ctx);

      expect(result.content).toContain("a.ts");
      expect(result.content).not.toContain("ab.ts");
      expect(result.content).not.toContain("abc.ts");
    });

    it("matches * wildcard for multiple characters in single path segment", async () => {
      const files = [
        makeFile("index.html", "index"),
        makeFile("home.html", "home"),
        makeFile("about.html", "about"),
        makeFile("src/page.html", "page"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "*.html" }, ctx);

      expect(result.content).toContain("index.html");
      expect(result.content).toContain("home.html");
      expect(result.content).toContain("about.html");
      expect(result.content).not.toContain("src/page.html");
    });

    it("matches ** wildcard recursively", async () => {
      const files = [
        makeFile("index.html", "index"),
        makeFile("src/page.html", "page"),
        makeFile("src/components/Button.tsx", "button"),
        makeFile("public/styles.css", "css"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "**/*.html" }, ctx);

      expect(result.content).toContain("index.html");
      expect(result.content).toContain("src/page.html");
      expect(result.content).not.toContain("Button.tsx");
      expect(result.content).not.toContain("public/styles.css");
    });

    it("handles ** at the end of pattern", async () => {
      const files = [
        makeFile("src/App.tsx", "app"),
        makeFile("src/utils/math.ts", "math"),
        makeFile("src/utils/string.ts", "string"),
        makeFile("public/logo.png", "logo", "base64"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "src/**" }, ctx);

      expect(result.content).toContain("src/App.tsx");
      expect(result.content).toContain("src/utils/math.ts");
      expect(result.content).toContain("src/utils/string.ts");
      expect(result.content).not.toContain("public/logo.png");
    });
  });

  describe("no matches", () => {
    it("returns 'No files matched.' when pattern matches nothing", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("src/App.tsx", "export default function App() {}"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "**/*.py" }, ctx);

      expect(result.content).toBe("No files matched.");
    });

    it("returns no matches for file outside scoped path", async () => {
      const files = [
        makeFile("index.html", "<html></html>"),
        makeFile("src/App.tsx", "export default function App() {}"),
        makeFile("public/logo.png", "logo", "base64"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "*.tsx", path: "public" }, ctx);

      expect(result.content).toBe("No files matched.");
    });
  });

  describe("limit parameter", () => {
    it("truncates results and shows remaining count when limit is exceeded", async () => {
      const files = [
        makeFile("a.ts", "a"),
        makeFile("b.ts", "b"),
        makeFile("c.ts", "c"),
        makeFile("d.ts", "d"),
        makeFile("e.ts", "e"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "**/*.ts", limit: 2 }, ctx);

      expect(result.content).toContain("...");
      expect(result.content).toContain("3 more matches");
    });

    it("does not show truncation when results fit within limit", async () => {
      const files = [makeFile("a.ts", "a"), makeFile("b.ts", "b")];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "**/*.ts", limit: 10 }, ctx);

      expect(result.content).not.toContain("...");
      expect(result.content).not.toContain("more matches");
    });

    it("uses default limit of 200 when not specified", async () => {
      const files = Array.from({ length: 50 }, (_, i) => makeFile(`file${i}.ts`, `content${i}`));
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "**/*.ts" }, ctx);

      expect(result.content).not.toContain("...");
      expect(result.content).not.toContain("more matches");
    });
  });

  describe("sorting", () => {
    it("returns matches sorted alphabetically", async () => {
      const files = [
        makeFile("zebra.ts", "z"),
        makeFile("apple.ts", "a"),
        makeFile("src/mango.ts", "m"),
        makeFile("src/banana.ts", "b"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "**/*.ts" }, ctx);

      const lines = (result.content as string).split("\n");
      expect(lines[0]).toBe("apple.ts");
      expect(lines[1]).toBe("src/banana.ts");
      expect(lines[2]).toBe("src/mango.ts");
      expect(lines[3]).toBe("zebra.ts");
    });
  });

  describe("complex patterns", () => {
    it("matches src/components/*.tsx", async () => {
      const files = [
        makeFile("src/App.tsx", "app"),
        makeFile("src/components/Button.tsx", "button"),
        makeFile("src/components/Input.tsx", "input"),
        makeFile("src/components/utils/helper.ts", "helper"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "src/components/*.tsx" }, ctx);

      expect(result.content).toContain("src/components/Button.tsx");
      expect(result.content).toContain("src/components/Input.tsx");
      expect(result.content).not.toContain("src/App.tsx");
      expect(result.content).not.toContain("src/components/utils/helper.ts");
    });

    it("matches nested folder patterns", async () => {
      const files = [
        makeFile("src/utils/hooks/useData.ts", "useData"),
        makeFile("src/utils/hooks/useForm.ts", "useForm"),
        makeFile("src/utils/helpers/string.ts", "string"),
        makeFile("src/components/Button.tsx", "button"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "src/utils/hooks/*.ts" }, ctx);

      expect(result.content).toContain("src/utils/hooks/useData.ts");
      expect(result.content).toContain("src/utils/hooks/useForm.ts");
      expect(result.content).not.toContain("src/utils/helpers/string.ts");
      expect(result.content).not.toContain("src/components/Button.tsx");
    });
  });

  describe("path normalization", () => {
    it("handles path with leading slash", async () => {
      const files = [
        makeFile("index.html", "index"),
        makeFile("src/App.tsx", "app"),
        makeFile("src/utils/math.ts", "math"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "*.ts", path: "/src/utils" }, ctx);

      expect(result.content).toContain("src/utils/math.ts");
    });

    it("handles path with trailing slash", async () => {
      const files = [
        makeFile("index.html", "index"),
        makeFile("src/App.tsx", "app"),
        makeFile("src/utils/math.ts", "math"),
      ];
      const store = makeStore(files);
      const ctx = makeCtx(store);

      const result = await globTool.execute({ pattern: "*.ts", path: "src/utils/" }, ctx);

      expect(result.content).toContain("src/utils/math.ts");
    });
  });
});
