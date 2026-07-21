import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * JavaScript / Node.js lesson starter: a small multi-file ESM script executed
 * by the WebContainer's Node runtime. The runner's `pnpm dev` resolves to
 * `node main.js`, which prints to the Runner console and exits, then re-runs
 * on save. Unlike Python, the full Node.js runtime is available — lessons can
 * `pnpm add` packages or start servers (the Preview panel appears when a
 * server begins listening).
 */
export function createStarterJavascriptWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      JSON.stringify(
        {
          name: "javascript-lesson",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: {
            // The shared `pnpm dev` runner contract runs the script with the
            // WebContainer's Node, streams stdout to the Runner tab, and
            // re-runs on save.
            dev: "node main.js",
            start: "node main.js",
          },
        },
        null,
        2,
      ),
    ),
    "main.js": createWorkspaceFile(
      "main.js",
      `// JavaScript lesson workspace.
//
// The runner executes this file with Node.js and prints its output in the
// Runner tab. Saving a file runs it again.

import { describeSquares, greet } from "./helpers.js";

console.log(greet("JavaScript"));

for (const line of describeSquares([1, 2, 3, 4, 5])) {
  console.log(line);
}
`,
    ),
    "helpers.js": createWorkspaceFile(
      "helpers.js",
      `// Helpers imported by main.js — plain ES module imports work as usual.

export function greet(name) {
  return \`Hello, \${name} lessons!\`;
}

export function describeSquares(values) {
  return values.map((value) => \`\${value} squared is \${value * value}\`);
}
`,
    ),
    "README.md": createWorkspaceFile(
      "README.md",
      `# JavaScript / Node.js Lesson

1. The runner executes \`node main.js\` inside the in-browser WebContainer
   and streams its output to the **Runner** tab. Saving a file runs it again.
2. The full Node.js runtime is available: install packages from the
   **Terminal** tab with \`pnpm add <package>\`, or change the \`dev\` script in
   \`package.json\` to run anything else.
3. Lessons that start a server (Express, \`http\`, Vite, …) get a live
   **Preview** panel as soon as the server begins listening.
`,
    ),
  };

  return {
    id: "javascript-workspace",
    name: "JavaScript Lesson",
    lessonType: "javascript",
    entryFilePath: "main.js",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
