import { describe, expect, it } from "vite-plus/test";
import { makeFile, makeStore, makeCtx } from "./testUtils";
import { makeGrepTool } from "./grep";

describe("grep tool", () => {
  it("returns file:line:content for regex matches", async () => {
    const store = makeStore([makeFile("a.ts", "const foo = 1;\nconst bar = 2;\n")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({ pattern: "foo" });
    expect(result).toContain("a.ts:1:const foo = 1;");
    expect(result).not.toContain("bar");
  });

  it("treats the pattern literally when literal=true", async () => {
    const store = makeStore([makeFile("a.ts", "a.b\naxb\n")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({
      pattern: "a.b",
      literal: true,
    });
    expect(result).toContain("a.ts:1:a.b");
    expect(result).not.toContain("axb");
  });

  it("reports an invalid regex", async () => {
    const store = makeStore([makeFile("a.ts", "x")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({ pattern: "(" });
    expect(result).toContain("Invalid pattern");
  });

  // Used verbatim, "src/" became the prefix "src//" and matched nothing, so a
  // scoped search answered "No matches found." exactly like a real miss. glob
  // already normalizes the same argument.
  it.each(["src", "src/", "/src", "/src/"])(
    "scopes to a folder however the path is spelled (%s)",
    async (path) => {
      const store = makeStore([
        makeFile("src/App.tsx", "needle"),
        makeFile("other/App.tsx", "needle"),
      ]);
      const result = await makeGrepTool(makeCtx(store)).function.execute({
        pattern: "needle",
        path,
      });
      expect(result).toContain("src/App.tsx");
      expect(result).not.toContain("other/App.tsx");
    },
  );

  // The glob used to be tested against the full path, so a relative glob under
  // a scoped path ("*.ts" within "src") could never match and the tool
  // answered "No matches found." like a real miss.
  it("matches a glob relative to the scoped path", async () => {
    const store = makeStore([
      makeFile("src/a.ts", "needle"),
      makeFile("src/sub/b.ts", "needle"),
      makeFile("src/c.tsx", "needle"),
    ]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({
      pattern: "needle",
      path: "src",
      glob: "*.ts",
    });
    expect(result).toBe("src/a.ts:1:needle");
  });

  it("still matches a workspace-rooted glob under a scoped path", async () => {
    const store = makeStore([makeFile("src/a.ts", "needle"), makeFile("src/sub/b.ts", "needle")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({
      pattern: "needle",
      path: "src",
      glob: "src/*.ts",
    });
    expect(result).toBe("src/a.ts:1:needle");
  });

  it("filters by glob across the whole workspace without a path", async () => {
    const store = makeStore([makeFile("src/a.ts", "needle"), makeFile("src/b.tsx", "needle")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({
      pattern: "needle",
      glob: "**/*.tsx",
    });
    expect(result).toBe("src/b.tsx:1:needle");
  });

  it("emits context lines before and after a match", async () => {
    const store = makeStore([makeFile("a.ts", "a\nb\nneedle\nc\nd")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({
      pattern: "needle",
      context: 1,
    });
    expect(result).toBe("a.ts:2:b\na.ts:3:needle\na.ts:4:c");
  });

  // Overlapping windows used to push the shared lines twice ("3:b" repeated).
  it("emits each line once when context windows overlap", async () => {
    const store = makeStore([makeFile("a.ts", "a\nneedle\nb\nneedle\nc")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({
      pattern: "needle",
      context: 1,
    });
    expect(result).toBe("a.ts:1:a\na.ts:2:needle\na.ts:3:b\na.ts:4:needle\na.ts:5:c");
  });

  it("emits adjacent matches once each when one sits in the other's context", async () => {
    const store = makeStore([makeFile("a.ts", "a\nneedle\nneedle\nb")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({
      pattern: "needle",
      context: 1,
    });
    expect(result).toBe("a.ts:1:a\na.ts:2:needle\na.ts:3:needle\na.ts:4:b");
  });

  it("keeps separate windows when context does not overlap", async () => {
    const store = makeStore([makeFile("a.ts", "needle\nx\ny\nz\nneedle")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({
      pattern: "needle",
      context: 1,
    });
    expect(result).toBe("a.ts:1:needle\na.ts:2:x\na.ts:4:z\na.ts:5:needle");
  });

  it("reports no matches", async () => {
    const store = makeStore([makeFile("a.ts", "hello")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({ pattern: "zzz" });
    expect(result).toBe("No matches found.");
  });
});
