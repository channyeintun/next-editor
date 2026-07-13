import { describe, expect, it } from "vitest";
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

  it("reports no matches", async () => {
    const store = makeStore([makeFile("a.ts", "hello")]);
    const result = await makeGrepTool(makeCtx(store)).function.execute({ pattern: "zzz" });
    expect(result).toBe("No matches found.");
  });
});
