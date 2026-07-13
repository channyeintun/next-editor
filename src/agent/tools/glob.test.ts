import { describe, expect, it } from "vitest";
import { makeFile, makeStore, makeCtx } from "./testUtils";
import { makeGlobTool } from "./glob";

describe("glob tool", () => {
  it("matches ** across directories", async () => {
    const store = makeStore([
      makeFile("src/App.tsx", ""),
      makeFile("src/util/x.tsx", ""),
      makeFile("index.html", ""),
    ]);
    const result = await makeGlobTool(makeCtx(store)).function.execute({ pattern: "**/*.tsx" });
    expect(result).toContain("src/App.tsx");
    expect(result).toContain("src/util/x.tsx");
    expect(result).not.toContain("index.html");
  });

  it("scopes matching to a folder prefix", async () => {
    const store = makeStore([makeFile("src/a.ts", ""), makeFile("lib/b.ts", "")]);
    const result = await makeGlobTool(makeCtx(store)).function.execute({
      pattern: "*.ts",
      path: "src",
    });
    expect(result).toContain("src/a.ts");
    expect(result).not.toContain("lib/b.ts");
  });

  it("reports no matches", async () => {
    const store = makeStore([makeFile("a.ts", "")]);
    const result = await makeGlobTool(makeCtx(store)).function.execute({ pattern: "*.py" });
    expect(result).toBe("No files matched.");
  });
});
