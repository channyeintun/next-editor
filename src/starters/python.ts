import type { WorkspaceProject } from "../types/workspace";
import { collectWorkspaceFolders } from "../types/workspacePaths";
import { createWorkspaceFile } from "./shared";

/**
 * Python lesson starter: a script, a module it imports and a text file it
 * reads, run by CPython in the page (runtime/pythonPlayground) on an explicit
 * Run action. No package.json, dev server, or Node.js runtime boot — and no
 * service either: the workspace never leaves the browser.
 *
 * `starters/pythonPrograms.test.ts` runs it and holds the README to what it
 * prints.
 */
export function createStarterPythonWorkspace(): WorkspaceProject {
  const files = {
    "main.py": createWorkspaceFile(
      "main.py",
      `"""Python lesson workspace.

Press Run to execute this file with CPython 3.14. The interpreter runs in
this page, so nothing is sent to a server, and every run starts a new one.
"""

from helpers import average, greet


def read_scores(path: str) -> dict[str, int]:
    """Read "name,score" lines into a dictionary."""
    scores = {}
    with open(path, encoding="utf-8") as lines:
        for line in lines:
            name, score = line.strip().split(",")
            scores[name] = int(score)
    return scores


def main() -> None:
    print(greet("Python"))

    # The workspace's other files sit beside this script.
    scores = read_scores("scores.csv")
    for name, score in scores.items():
        print(f"{name:<6}{score:>4}")

    print(f"Average: {average(scores.values()):.1f}")
    best = max(scores, key=scores.get)
    print(f"Best: {best}")


if __name__ == "__main__":
    main()
`,
    ),
    "helpers.py": createWorkspaceFile(
      "helpers.py",
      `"""Helpers imported by main.py — another .py file is a module, as usual."""

from statistics import mean


def greet(name: str) -> str:
    return f"Hello, {name} lessons!"


def average(values) -> float:
    return mean(values)
`,
    ),
    "scores.csv": createWorkspaceFile(
      "scores.csv",
      `Ada,92
Grace,88
Linus,75
`,
    ),
    "README.md": createWorkspaceFile(
      "README.md",
      `# Python Lesson

1. Open \`main.py\` and press **Run** — the program runs on CPython 3.14, in
   this page, and its output appears in the Python Runner:

   \`\`\`
   Hello, Python lessons!
   Ada     92
   Grace   88
   Linus   75
   Average: 85.0
   Best: Ada
   \`\`\`

2. A run is \`python main.py\`. Every other \`.py\` file is a module the script
   can import, and every other text file is one it can open by its path, as
   \`scores.csv\` is here.
3. Every run starts a new interpreter, so nothing is left over from the run
   before. Files a program writes are gone when it exits; they do not appear
   in the workspace.
4. The whole standard library is here, and nothing else: there is no \`pip\`,
   so packages such as \`numpy\` or \`requests\` cannot be imported.
5. \`input()\` waits for you. When a program asks for a line, a field opens
   under the console: type the line, press Enter, and the program goes on.
   Ctrl+D on an empty line ends the input, as in a terminal. Press **Run**
   again to start the program over.
6. There are no threads, no sockets and no network. A program talks through
   what it prints. One that prints more than 256 KiB, or runs for more than
   10 seconds, is stopped — so a loop that never ends does end. The time a
   program waits for you to type is not counted.
7. There is no **Format** button.

## An error is output too

An uncaught exception prints its traceback to standard error, and the runner
shows standard output and standard error together, in the order the program
wrote them — the same thing a terminal shows.
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
