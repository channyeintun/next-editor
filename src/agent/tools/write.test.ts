import { describe, expect, it } from "vitest";
import { makeFile, makeStore, makeCtx } from "./testUtils";
import { getProject } from "./workspaceFs";
import { makeWriteTool } from "./write";

describe("write tool", () => {
  it("creates a new file and reports the byte count", async () => {
    const store = makeStore([makeFile("index.html", "")]);
    const result = await makeWriteTool(makeCtx(store)).function.execute({
      path: "src/App.tsx",
      content: "hello",
    });
    expect(result).toContain("Created src/App.tsx");
    expect(result).toContain("5 bytes");
    expect(getProject(store)?.files["src/App.tsx"]?.content).toBe("hello");
  });

  it("overwrites an existing file", async () => {
    const store = makeStore([makeFile("a.txt", "old")]);
    const result = await makeWriteTool(makeCtx(store)).function.execute({
      path: "a.txt",
      content: "new",
    });
    expect(result).toContain("Updated a.txt");
    expect(getProject(store)?.files["a.txt"]?.content).toBe("new");
  });
});
