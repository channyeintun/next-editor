import { describe, expect, it } from "vite-plus/test";
import { globToRegex, matchesWorkspaceGlob, normalizeFolderPrefix } from "./workspaceGlob";

describe("globToRegex", () => {
  it.each([
    ["**/*.tsx", "App.tsx", true],
    ["**/*.tsx", "src/components/Button.tsx", true],
    ["**/*.tsx", "src/App.ts", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/sub/a.ts", false],
    // A mid-segment ** crosses folders, as the glob tool's schema promises.
    ["src/**.tsx", "src/components/Button.tsx", true],
    ["src/**.tsx", "src/App.tsx", true],
    ["src/**.tsx", "lib/App.tsx", false],
    ["**.tsx", "src/components/Button.tsx", true],
    ["src/**", "src/a/b/c.ts", true],
    ["a**b", "a/x/b", true],
    ["a**b", "ab", true],
    ["?.ts", "a.ts", true],
    ["?.ts", "ab.ts", false],
    ["src?a.ts", "src/a.ts", false],
    ["*.json", "package.json", true],
    ["*.json", "config/app.json", false],
    // Regex metacharacters in a name are literal.
    ["a+b(1).[ts]", "a+b(1).[ts]", true],
    ["a.ts", "axts", false],
  ])("%s against %s → %s", (pattern, path, expected) => {
    expect(globToRegex(pattern).test(path)).toBe(expected);
  });
});

describe("normalizeFolderPrefix", () => {
  it.each(["src", "src/", "/src", "/src/", "//src//"])("normalizes %s to src", (path) => {
    expect(normalizeFolderPrefix(path)).toBe("src");
  });

  it("keeps nested folders intact", () => {
    expect(normalizeFolderPrefix("/src/components/")).toBe("src/components");
  });
});

describe("matchesWorkspaceGlob", () => {
  it("tests the path relative to the base folder", () => {
    const regex = globToRegex("*.ts");
    expect(matchesWorkspaceGlob(regex, "src/a.ts", "src")).toBe(true);
    expect(matchesWorkspaceGlob(regex, "src/sub/b.ts", "src")).toBe(false);
  });

  it("also tests the full workspace path", () => {
    const regex = globToRegex("src/*.ts");
    expect(matchesWorkspaceGlob(regex, "src/a.ts", "src")).toBe(true);
    expect(matchesWorkspaceGlob(regex, "src/sub/b.ts", "src")).toBe(false);
  });

  it("tests the full path when there is no base folder", () => {
    const regex = globToRegex("*.ts");
    expect(matchesWorkspaceGlob(regex, "a.ts", "")).toBe(true);
    expect(matchesWorkspaceGlob(regex, "src/a.ts", "")).toBe(false);
  });
});
