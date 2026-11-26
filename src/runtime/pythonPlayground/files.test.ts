import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceProject } from "../../types/workspace";
import { collectPythonPlaygroundFiles, findPythonRunEntry } from "./files";

const text = (path: string, language: string, content: string) => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  language,
  content,
});

describe("collectPythonPlaygroundFiles", () => {
  it("collects every text file, main.py first, and leaves binary assets out", () => {
    const files: WorkspaceProject["files"] = {
      "scores.csv": text("scores.csv", "plaintext", "Ada,92\n"),
      "helpers.py": text("helpers.py", "python", "def greet(): ...\n"),
      "main.py": text("main.py", "python", "print('hi')\n"),
      "data/notes.txt": text("data/notes.txt", "plaintext", "remember"),
      "logo.png": {
        path: "logo.png",
        name: "logo.png",
        language: "plaintext",
        encoding: "asset",
        content: { kind: "asset", assetId: "asset-1", mimeType: "image/png", size: 1 },
      },
    };

    expect(collectPythonPlaygroundFiles({ files })).toEqual([
      { path: "main.py", content: "print('hi')\n" },
      { path: "data/notes.txt", content: "remember" },
      { path: "helpers.py", content: "def greet(): ...\n" },
      { path: "scores.csv", content: "Ada,92\n" },
    ]);
  });
});

describe("findPythonRunEntry", () => {
  const main = { path: "main.py" };
  const helper = { path: "helpers.py" };
  const data = { path: "scores.csv" };

  it("starts from main.py, at the root or in a folder", () => {
    expect(findPythonRunEntry([helper, data, main])).toBe(main);
    const nested = { path: "app/main.py" };
    expect(findPythonRunEntry([helper, nested])).toBe(nested);
  });

  it("takes a single script as the program whatever it is called, data files aside", () => {
    expect(findPythonRunEntry([data, helper, { path: "README.md" }])).toBe(helper);
  });

  it("cannot tell with several scripts and none named main.py", () => {
    expect(findPythonRunEntry([helper, { path: "other.py" }])).toBe("ambiguous");
  });

  it("has nothing to run in a workspace with no script", () => {
    expect(findPythonRunEntry([data])).toBe("empty");
    expect(findPythonRunEntry([])).toBe("empty");
  });
});
