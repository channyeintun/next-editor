import { describe, expect, it } from "vitest";
import { makeFile, makeStore, makeCtx } from "./testUtils";
import { makeLsTool } from "./ls";

describe("ls tool", () => {
  it("lists immediate children with folders trailing-slashed", async () => {
    const store = makeStore([
      makeFile("index.html", ""),
      makeFile("src/App.tsx", ""),
      makeFile("src/util/x.ts", ""),
    ]);
    const result = await makeLsTool(makeCtx(store)).function.execute({});
    expect(result).toContain("index.html");
    expect(result).toContain("src/");
    expect(result).not.toContain("App.tsx");
  });

  it("lists children of a subfolder", async () => {
    const store = makeStore([makeFile("src/App.tsx", ""), makeFile("src/util/x.ts", "")]);
    const result = await makeLsTool(makeCtx(store)).function.execute({ path: "src" });
    expect(result).toContain("App.tsx");
    expect(result).toContain("util/");
  });

  it("reports an empty directory", async () => {
    const store = makeStore([makeFile("index.html", "")]);
    const result = await makeLsTool(makeCtx(store)).function.execute({ path: "empty" });
    expect(result).toBe("(empty)");
  });
});
