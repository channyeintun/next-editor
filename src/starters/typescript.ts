import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * TypeScript lesson starter: a small multi-file script executed with `tsx`
 * (no build step) by the WebContainer's Node runtime. The runner's `pnpm dev`
 * resolves to `tsx main.ts`, which prints to the Runner console and exits,
 * then re-runs on save. The full Node.js runtime is available — lessons can
 * `pnpm add` packages or start servers (the Preview panel appears when a
 * server begins listening).
 */
export function createStarterTypescriptWorkspace(): WorkspaceProject {
  const files = {
    "package.json": createWorkspaceFile(
      "package.json",
      JSON.stringify(
        {
          name: "typescript-lesson",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: {
            // tsx runs the TypeScript entry directly (no build step), so the
            // shared `pnpm dev` runner contract works unchanged: it runs the
            // script, streams stdout to the Runner tab, and re-runs on save.
            dev: "tsx main.ts",
            start: "tsx main.ts",
          },
          devDependencies: {
            tsx: "^4.19.2",
            typescript: "^5.7.2",
          },
        },
        null,
        2,
      ),
    ),
    "main.ts": createWorkspaceFile(
      "main.ts",
      `// TypeScript lesson workspace.
//
// The runner executes this file with tsx (TypeScript on Node.js, no build
// step) and prints its output in the Runner tab. Saving a file runs it again.

import { describeSquares, greet } from "./helpers.js";

console.log(greet("TypeScript"));

for (const line of describeSquares([1, 2, 3, 4, 5])) {
  console.log(line);
}
`,
    ),
    "helpers.ts": createWorkspaceFile(
      "helpers.ts",
      `// Helpers imported by main.ts — note the .js specifier: tsx resolves it
// to this file under ESM rules.

export function greet(name: string): string {
  return \`Hello, \${name} lessons!\`;
}

export function describeSquares(values: number[]): string[] {
  return values.map((value) => \`\${value} squared is \${value * value}\`);
}
`,
    ),
    "README.md": createWorkspaceFile(
      "README.md",
      `# TypeScript Lesson

1. The runner executes \`tsx main.ts\` inside the in-browser WebContainer
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
    id: "typescript-workspace",
    name: "TypeScript Lesson",
    lessonType: "typescript",
    entryFilePath: "main.ts",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
