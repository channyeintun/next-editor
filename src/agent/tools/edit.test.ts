import { describe, expect, it } from "vitest";
import { makeFile, makeStore, makeCtx } from "./testUtils";
import { getProject } from "./workspaceFs";
import { makeEditTool } from "./edit";

describe("edit tool", () => {
  it("applies a unique exact-text replacement", async () => {
    const store = makeStore([makeFile("a.ts", "const x = 1;\nconst y = 2;\n")]);
    const result = await makeEditTool(makeCtx(store)).function.execute({
      path: "a.ts",
      edits: [{ oldText: "const x = 1;", newText: "const x = 42;" }],
    });
    expect(result).toContain("Edited a.ts");
    expect(getProject(store)?.files["a.ts"]?.content).toBe("const x = 42;\nconst y = 2;\n");
  });

  it("reports when oldText is not found", async () => {
    const store = makeStore([makeFile("a.ts", "hello")]);
    const result = await makeEditTool(makeCtx(store)).function.execute({
      path: "a.ts",
      edits: [{ oldText: "missing", newText: "x" }],
    });
    expect(result).toContain("not found");
  });

  it("rejects a non-unique oldText", async () => {
    const store = makeStore([makeFile("a.ts", "dup\ndup\n")]);
    const result = await makeEditTool(makeCtx(store)).function.execute({
      path: "a.ts",
      edits: [{ oldText: "dup", newText: "x" }],
    });
    expect(result).toContain("must be unique");
  });
});
