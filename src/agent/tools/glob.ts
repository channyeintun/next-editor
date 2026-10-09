import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { ToolContext } from "../types";
import { getProject } from "./workspaceFs";
import { globToRegex, matchesWorkspaceGlob, normalizeFolderPrefix } from "./workspaceGlob";

const inputSchema = z.object({
  pattern: z
    .string()
    .describe(
      "Glob pattern to match files (e.g., '**/*.tsx', 'src/*.ts', '*.json'). " +
        "* matches any sequence except /, ** matches any sequence including /, ? matches single char except /.",
    ),
  path: z
    .string()
    .optional()
    .describe("Optional folder prefix to scope the search (workspace-relative, no slashes)"),
  limit: z.number().optional().describe("Maximum number of results to return (default 200)"),
});

export function makeGlobTool(ctx: ToolContext) {
  return tool({
    name: "glob",
    description:
      "Search for files in the workspace using a glob pattern. Supports *, **, and ? wildcards. " +
      "Returns matching file paths sorted alphabetically, optionally scoped to a folder.",
    inputSchema,
    execute: (input): string => {
      const project = getProject(ctx.workspace);

      if (!project) {
        return "No workspace loaded.";
      }

      const baseFolder = input.path ? normalizeFolderPrefix(input.path) : "";
      const baseFolderPrefix = baseFolder ? baseFolder + "/" : "";

      let filePaths = Object.keys(project.files);
      if (baseFolder) {
        filePaths = filePaths.filter((p) => p.startsWith(baseFolderPrefix));
      }

      const globRegex = globToRegex(input.pattern);
      const matches: string[] = [];

      for (const filePath of filePaths) {
        if (matchesWorkspaceGlob(globRegex, filePath, baseFolder)) {
          matches.push(filePath);
        }
      }

      matches.sort();

      const limit = input.limit ?? 200;
      const truncated = matches.length > limit;
      const displayMatches = matches.slice(0, limit);

      if (displayMatches.length === 0) {
        return "No files matched.";
      }

      let result = displayMatches.join("\n");
      if (truncated) {
        result += `\n... ${matches.length - limit} more matches`;
      }

      return result;
    },
  });
}
