import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * Python lesson starter: a small multi-file script executed by the
 * WebContainer's experimental WASI Python interpreter. The runner's `pnpm dev`
 * resolves to `python3 main.py`, which prints to the Runner console and exits —
 * WASI Python cannot bind sockets, so there is no dev server or preview.
 */
export function createStarterPythonWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      JSON.stringify(
        {
          name: "python-lesson",
          private: true,
          version: "0.0.0",
          scripts: {
            // The WebContainer shell ships a built-in `python3`, so the shared
            // `pnpm dev` runner contract works unchanged: it runs the script,
            // streams stdout to the Runner tab, and re-runs on save.
            dev: "python3 main.py",
            start: "python3 main.py",
          },
        },
        null,
        2,
      ),
    ),
    "main.py": createWorkspaceFile(
      "main.py",
      `"""Python lesson workspace.

The runner executes this file with the WebContainer's built-in Python
interpreter and prints its output in the Runner tab. Saving a file
runs it again.
"""

from helpers import describe_squares, greet


def main() -> None:
    print(greet("Python"))

    for line in describe_squares(range(1, 6)):
        print(line)


if __name__ == "__main__":
    main()
`,
    ),
    "helpers.py": createWorkspaceFile(
      "helpers.py",
      `"""Helpers imported by main.py — plain module imports work as usual."""


def greet(name: str) -> str:
    return f"Hello, {name} lessons!"


def describe_squares(values) -> list[str]:
    return [f"{value} squared is {value * value}" for value in values]
`,
    ),
    "README.md": createWorkspaceFile(
      "README.md",
      `# Python Lesson

1. The runner executes \`python3 main.py\` inside the in-browser WebContainer
   and streams its output to the **Runner** tab. Saving a file runs it again.
2. Python support in the WebContainer is experimental and limited to the
   standard library — there is no \`pip\`, and third-party packages cannot be
   installed.
3. Network sockets are unavailable, so servers (\`http.server\`, Flask, …)
   cannot run and there is no Preview panel; print to stdout instead.
4. The **Terminal** tab has the same \`python3\` command for running scripts
   by hand, e.g. \`python3 helpers.py\`.
`,
    ),
  };

  return {
    id: "python-workspace",
    name: "Python Lesson",
    lessonType: "python",
    entryFilePath: "main.py",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
