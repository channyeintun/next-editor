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

  // With the default context every match pushes one line, so the scan used to
  // stop at exactly `limit` lines and the overshoot check never fired: a
  // capped list came back with no note and read as the complete set.
  it("notes truncation when more matches exist than the default limit", async () => {
    const content = Array.from({ length: 250 }, (_, i) => `needle ${i}`).join("\n");
    const store = makeStore([makeFile("a.ts", content)]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({ pattern: "needle" });
    const [body, note] = String(result).split("\n\n");
    expect(body.split("\n")).toHaveLength(200);
    expect(note).toBe("(Results truncated; showing first 200 lines)");
  });

  it("does not note truncation when the matches fill the limit exactly", async () => {
    const content = Array.from({ length: 200 }, (_, i) => `needle ${i}`).join("\n");
    const store = makeStore([makeFile("a.ts", content)]);
    const result = String(
      await makeGrepTool(makeCtx(store)).function.execute({ pattern: "needle" }),
    );
    expect(result.split("\n")).toHaveLength(200);
    expect(result).not.toContain("Results truncated");
  });

  it("notes truncation when the first match past the limit is in a later file", async () => {
    const store = makeStore([
      makeFile("a.ts", "needle\nneedle"),
      makeFile("b.ts", "nothing\nneedle"),
    ]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({
      pattern: "needle",
      limit: 2,
    });
    expect(result).toBe(
      "a.ts:1:needle\na.ts:2:needle\n\n(Results truncated; showing first 2 lines)",
    );
  });

  it("notes truncation when context lines overshoot the limit", async () => {
    const store = makeStore([makeFile("a.ts", "a\nb\nneedle\nc\nd")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({
      pattern: "needle",
      context: 2,
      limit: 3,
    });
    expect(result).toBe(
      "a.ts:1:a\na.ts:2:b\na.ts:3:needle\n\n(Results truncated; showing first 3 lines)",
    );
  });

  // A match already printed in full as an earlier match's context adds no
  // lines, so the output is not cut by it.
  it("does not note truncation for a match already shown as context", async () => {
    const store = makeStore([makeFile("a.ts", "x\nneedle\nneedle")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({
      pattern: "needle",
      context: 1,
      limit: 3,
    });
    expect(result).toBe("a.ts:1:x\na.ts:2:needle\na.ts:3:needle");
  });

  // A minified line came back whole for every match, up to 200 times, which
  // could overflow the model's context.
  it("clips a very long matching line", async () => {
    const store = makeStore([makeFile("a.min.js", `needle${"x".repeat(49_994)}`)]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({ pattern: "needle" });
    expect(result).toBe(`a.min.js:1:needle${"x".repeat(1_994)}… [48000 chars omitted]`);
  });

  it("stops at the character budget and says how many lines it shows", async () => {
    const content = Array.from({ length: 200 }, () => `needle${"x".repeat(1_994)}`).join("\n");
    const store = makeStore([makeFile("a.ts", content)]);
    const result = String(
      await makeGrepTool(makeCtx(store)).function.execute({ pattern: "needle" }),
    );
    const [body, note] = result.split("\n\n");
    expect(body.length).toBeLessThanOrEqual(100_000);
    expect(body.split("\n").length).toBeLessThan(200);
    expect(note).toBe(
      `(Results truncated at 100000 characters; showing first ${body.split("\n").length} lines)`,
    );
  });

  it("reports no matches", async () => {
    const store = makeStore([makeFile("a.ts", "hello")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({ pattern: "zzz" });
    expect(result).toBe("No matches found.");
  });
});
