import { describe, expect, it } from "vite-plus/test";
import { createWorkspaceStore } from "./workspaceStore";
import { describeWorkspacePathConflict } from "./workspaceProjectSupport";
import { createWorkspaceFile } from "../types/workspaceFiles";
import type { WorkspaceProject } from "../types/workspace";

function project(): WorkspaceProject {
  return {
    id: "path-conflict",
    name: "Path conflict",
    lessonType: "html-css",
    entryFilePath: "index.html",
    folders: ["src", "src/lib"],
    files: Object.fromEntries(
      ["index.html", "src/app.ts", "src/lib/util.ts"].map((path) => [
        path,
        createWorkspaceFile(path, ""),
      ]),
    ),
  };
}

function projectOf(store: ReturnType<typeof createWorkspaceStore>): WorkspaceProject {
  const context = store.getSnapshot().context;
  if (!context.isInitialized) throw new Error("Expected initialized workspace");
  return context.project;
}

type Refusal = ReturnType<typeof describeWorkspacePathConflict>;

// Each case: what is asked, and the refusal kind (or null) the rule answers.
const CASES: Array<{
  kind: "file" | "folder";
  nextPath: string;
  currentPath?: string;
  expected: NonNullable<Refusal>["kind"] | null;
}> = [
  // New files.
  { kind: "file", nextPath: "src/main.ts", expected: null },
  { kind: "file", nextPath: "src/lib/new.ts", expected: null },
  { kind: "file", nextPath: "src/app.ts", expected: "exists" },
  { kind: "file", nextPath: "src", expected: "exists" },
  { kind: "file", nextPath: "src/lib", expected: "exists" },
  { kind: "file", nextPath: "index.html/page.html", expected: "inside-file" },
  // Renamed files.
  { kind: "file", currentPath: "src/app.ts", nextPath: "src/main.ts", expected: null },
  { kind: "file", currentPath: "src/app.ts", nextPath: "src/app.ts/main.ts", expected: null },
  { kind: "file", currentPath: "src/app.ts", nextPath: "index.html", expected: "exists" },
  { kind: "file", currentPath: "src/app.ts", nextPath: "src/lib", expected: "exists" },
  { kind: "file", currentPath: "src/app.ts", nextPath: "src/lib/util.ts", expected: "exists" },
  { kind: "file", currentPath: "src/app.ts", nextPath: "index.html/a.ts", expected: "inside-file" },
  // New folders.
  { kind: "folder", nextPath: "docs", expected: null },
  { kind: "folder", nextPath: "src/new", expected: null },
  { kind: "folder", nextPath: "src", expected: "exists" },
  { kind: "folder", nextPath: "src/lib", expected: "exists" },
  { kind: "folder", nextPath: "index.html", expected: "exists" },
  { kind: "folder", nextPath: "index.html/sub", expected: "inside-file" },
  // Renamed folders.
  { kind: "folder", currentPath: "src/lib", nextPath: "src/shared", expected: null },
  { kind: "folder", currentPath: "src/lib", nextPath: "lib", expected: null },
  { kind: "folder", currentPath: "src/lib", nextPath: "src", expected: "exists" },
  { kind: "folder", currentPath: "src/lib", nextPath: "index.html", expected: "exists" },
  { kind: "folder", currentPath: "src/lib", nextPath: "index.html/x", expected: "inside-file" },
  { kind: "folder", currentPath: "src/lib", nextPath: "src/lib/inner", expected: "inside-itself" },
  { kind: "folder", currentPath: "src", nextPath: "src/lib", expected: "exists" },
  { kind: "folder", currentPath: "src", nextPath: "src/app.ts", expected: "inside-itself" },
  { kind: "folder", currentPath: "src", nextPath: "src/app.ts/x", expected: "inside-itself" },
];

/** Asks the store to make the change; true when it refused (left the project as it was). */
function storeRefuses({ kind, nextPath, currentPath }: (typeof CASES)[number]): boolean {
  const store = createWorkspaceStore({ activeFilePath: "index.html", project: project() });
  const before = projectOf(store);

  if (currentPath === undefined) {
    if (kind === "file") store.trigger.createFile({ path: nextPath, content: "" });
    else store.trigger.createFolder({ path: nextPath });
  } else if (kind === "file") {
    store.trigger.renameFile({ currentPath, nextPath });
  } else {
    store.trigger.renameFolder({ currentPath, nextPath });
  }

  return projectOf(store) === before;
}

describe("describeWorkspacePathConflict", () => {
  it.each(CASES)(
    "answers $expected for a $kind at $nextPath (renaming $currentPath)",
    ({ kind, nextPath, currentPath, expected }) => {
      expect(
        describeWorkspacePathConflict(project(), nextPath, { kind, currentPath })?.kind ?? null,
      ).toBe(expected);
    },
  );

  // The store and the sidebar's name field ask the same rule: the store must
  // refuse exactly the names the field would explain, and take every other one.
  it.each(CASES)(
    "has the store refuse a $kind at $nextPath (renaming $currentPath) only when it answers",
    (testCase) => {
      expect(storeRefuses(testCase)).toBe(testCase.expected !== null);
    },
  );

  it("names the file a refused path would reach through", () => {
    expect(
      describeWorkspacePathConflict(project(), "index.html/page.html", { kind: "file" }),
    ).toEqual({ kind: "inside-file", filePath: "index.html" });
  });

  it("never refuses an entry its own path", () => {
    expect(
      describeWorkspacePathConflict(project(), "src/lib", {
        kind: "folder",
        currentPath: "src/lib",
      }),
    ).toBeNull();
    expect(
      describeWorkspacePathConflict(project(), "src/app.ts", {
        kind: "file",
        currentPath: "src/app.ts",
      }),
    ).toBeNull();
  });
});
