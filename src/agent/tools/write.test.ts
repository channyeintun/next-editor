import { describe, expect, it } from "vite-plus/test";
import { makeAssetFile, makeFile, makeStore, makeCtx } from "./testUtils";
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

  // "toString" resolved to Object.prototype.toString in project.files, so the
  // write took the update path, reported "Updated toString" and stored a file
  // record with no path, name or language.
  it("rejects a path named after an Object.prototype member", () => {
    const store = makeStore([makeFile("index.html", "")]);

    expect(() =>
      makeWriteTool(makeCtx(store)).function.execute({ path: "toString", content: "x" }),
    ).toThrow(/reserved name/);
    expect(Object.hasOwn(getProject(store)?.files ?? {}, "toString")).toBe(false);
  });

  it("does not overwrite a binary asset with text", () => {
    const store = makeStore([makeAssetFile("asset.bin")]);

    expect(() =>
      makeWriteTool(makeCtx(store)).function.execute({
        path: "asset.bin",
        content: "new",
      }),
    ).toThrow(/binary file/i);
  });
});
