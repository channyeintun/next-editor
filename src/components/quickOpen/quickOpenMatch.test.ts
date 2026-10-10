import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceTreeFile } from "../../types/workspace";
import {
  highlightRuns,
  prepareQuickOpenCandidates,
  QUICK_OPEN_RESULT_LIMIT,
  rankQuickOpenFiles,
} from "./quickOpenMatch";

function treeFiles(...paths: string[]): WorkspaceTreeFile[] {
  return [...paths]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => ({ path, name: path.split("/").at(-1) ?? path, language: "typescript" }));
}

function rank(query: string, ...paths: string[]): string[] {
  return rankQuickOpenFiles(prepareQuickOpenCandidates(treeFiles(...paths)), query).results.map(
    (result) => result.file.path,
  );
}

describe("rankQuickOpenFiles", () => {
  it("puts a file whose name starts with the query first", () => {
    expect(rank("app", "src/apps-list/index.ts", "src/App.tsx", "src/mapper.ts")).toEqual([
      "src/App.tsx",
      "src/mapper.ts",
      "src/apps-list/index.ts",
    ]);
  });

  it("prefers the name the query covers more of", () => {
    expect(rank("window", "windowActions.ts", "window.ts")).toEqual([
      "window.ts",
      "windowActions.ts",
    ]);
  });

  it("ranks word starts above letters inside a word", () => {
    expect(rank("fs", "offsets.ts", "src/components/FileSidebar.tsx")[0]).toBe(
      "src/components/FileSidebar.tsx",
    );
  });

  it("ranks a name holding the query as one run above the same letters scattered", () => {
    expect(
      rank(
        "icons",
        "src/components/icon/IconCursor.tsx",
        "src/utils/iframeConsoleBridge.ts",
        "src/components/fileSidebar/fileIcons.tsx",
      )[0],
    ).toBe("src/components/fileSidebar/fileIcons.tsx");
    expect(
      rank(
        "test",
        "src/collaboration/teachingStoreSync.ts",
        "src/components/FileSidebar.test.ts",
      )[0],
    ).toBe("src/components/FileSidebar.test.ts");
    expect(rank("store", "scripts/studio-render.ts", "src/agent/agentStore.ts")[0]).toBe(
      "src/agent/agentStore.ts",
    );
  });

  it("highlights the run that ranked a name, preferring Monaco's own", () => {
    const nameMatches = (query: string, path: string) =>
      rankQuickOpenFiles(prepareQuickOpenCandidates(treeFiles(path)), query).results[0].nameMatches;
    expect(nameMatches("icons", "src/fileIcons.tsx")).toEqual([4, 5, 6, 7, 8]);
    // Monaco spreads "test" over te·aching·St·ore; the run is the ".test".
    expect(nameMatches("test", "src/teachingStoreSync.test.ts")).toEqual([18, 19, 20, 21]);
    // Monaco's run is the hump, not the earlier "test" inside "contest".
    expect(nameMatches("test", "contestTest.ts")).toEqual([7, 8, 9, 10]);
  });

  it("ranks a match in the name above one only in the folders", () => {
    expect(rank("side", "side/index.ts", "src/FileSidebar.tsx")).toEqual([
      "src/FileSidebar.tsx",
      "side/index.ts",
    ]);
  });

  it("matches folders when the query has a slash", () => {
    expect(rank("comp/side", "src/components/FileSidebar.tsx", "src/side.ts")).toEqual([
      "src/components/FileSidebar.tsx",
    ]);
  });

  it("puts the exact path first", () => {
    expect(rank("src/a.ts", "src/a.ts.bak", "src/a.ts")[0]).toBe("src/a.ts");
  });

  it("matches an exact name with spaces in it, ahead of a multi-word match", () => {
    expect(rank("my photo.png", "myphoto.png", "my photo.png")[0]).toBe("my photo.png");
    expect(rank("my photo.png", "my photo.png", "myphoto.png")[0]).toBe("my photo.png");
    expect(rank("a a.ts", "a.ts", "a a.ts")[0]).toBe("a a.ts");
  });

  it("needs every space-separated piece to match", () => {
    expect(rank("side test", "src/FileSidebar.tsx", "src/FileSidebar.test.tsx")).toEqual([
      "src/FileSidebar.test.tsx",
    ]);
  });

  it("ignores case, a leading ./ or /, backslashes, and quotes", () => {
    const paths = ["src/app.ts", "lib/other.ts"];
    expect(rank("APP", ...paths)).toEqual(["src/app.ts"]);
    expect(rank("./src/app", ...paths)).toEqual(["src/app.ts"]);
    expect(rank("/src/app", ...paths)).toEqual(["src/app.ts"]);
    expect(rank(".\\src\\app", ...paths)).toEqual(["src/app.ts"]);
    expect(rank('"app"', ...paths)).toEqual(["src/app.ts"]);
  });

  it("finds the end of a path longer than Monaco reads", () => {
    const deep = `${"nested/".repeat(20)}target.ts`;
    expect(rank("nested/target", deep, "other.ts")).toEqual([deep]);
  });

  it("finds the start of a path longer than Monaco reads", () => {
    const deep = `src/main/${"kotlin/".repeat(20)}AuthViewModelTest.kt`;
    expect(deep.length).toBeGreaterThan(128);
    expect(rank("src/main", deep, "lib/other.kt")).toEqual([deep]);
    expect(rank("src auth", deep, "lib/other.kt")).toEqual([deep]);
  });

  it("breaks ties by the shorter name, then the shorter path, then path order", () => {
    expect(rank("index", "b/index.ts", "a/index.ts", "index.ts")).toEqual([
      "index.ts",
      "a/index.ts",
      "b/index.ts",
    ]);
  });

  it("lists every file in path order for an empty query", () => {
    const { results, total } = rankQuickOpenFiles(
      prepareQuickOpenCandidates(treeFiles("b.ts", "a.ts", "src/c.ts")),
      "   ",
    );
    expect(results.map((result) => result.file.path)).toEqual(["a.ts", "b.ts", "src/c.ts"]);
    expect(total).toBe(3);
  });

  it("returns at most the limit and counts every match", () => {
    const paths = Array.from({ length: 250 }, (_, index) => `file${index}.ts`);
    const candidates = prepareQuickOpenCandidates(treeFiles(...paths));
    const ranked = rankQuickOpenFiles(candidates, "file");
    expect(ranked.results).toHaveLength(QUICK_OPEN_RESULT_LIMIT);
    expect(ranked.total).toBe(250);
    expect(rankQuickOpenFiles(candidates, "").total).toBe(250);
  });

  it("splits the matched letters between the name and its folders", () => {
    const [result] = rankQuickOpenFiles(
      prepareQuickOpenCandidates(treeFiles("src/components/FileSidebar.tsx")),
      "comp/side",
    ).results;
    expect(result.name).toBe("FileSidebar.tsx");
    expect(result.directory).toBe("src/components");
    expect(result.directoryMatches).toEqual([4, 5, 6, 7]);
    expect(result.nameMatches).toEqual([4, 5, 6, 7]);
  });

  it("returns name positions relative to the name, and none for a root file's folder", () => {
    const [result] = rankQuickOpenFiles(
      prepareQuickOpenCandidates(treeFiles("README.md")),
      "read",
    ).results;
    expect(result.directory).toBe("");
    expect(result.nameMatches).toEqual([0, 1, 2, 3]);
    expect(result.directoryMatches).toEqual([]);
  });
});

describe("highlightRuns", () => {
  it("groups neighbouring matched and unmatched letters", () => {
    expect(highlightRuns("FileSidebar", [0, 4, 5])).toEqual([
      { text: "F", matched: true },
      { text: "ile", matched: false },
      { text: "Si", matched: true },
      { text: "debar", matched: false },
    ]);
  });

  it("never splits a character outside the BMP, and counts it matched by either half", () => {
    // Unit 0 is the first half of 😀; unit 3 is the second half of 😁.
    expect(highlightRuns("😀😁.md", [0, 3])).toEqual([
      { text: "😀😁", matched: true },
      { text: ".md", matched: false },
    ]);
  });

  it("highlights the whole of an emoji name typed exactly", () => {
    const [result] = rankQuickOpenFiles(
      prepareQuickOpenCandidates(treeFiles("😀.ts")),
      "😀.ts",
    ).results;
    expect(highlightRuns(result.name, result.nameMatches)).toEqual([
      { text: "😀.ts", matched: true },
    ]);
  });

  it("returns the whole text unmatched when nothing matched", () => {
    expect(highlightRuns("index.ts", [])).toEqual([{ text: "index.ts", matched: false }]);
  });
});
